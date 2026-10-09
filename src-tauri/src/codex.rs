//! Versioned, public app-server operations. Never write Codex's internal database.
use crate::{
    live::{codex_compact, codex_request, codex_settings, Live},
    sessions::{project_root, remember, Session, Store},
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::{Path, PathBuf}, io::{Read, Seek, SeekFrom}};
use tauri::{AppHandle, Manager};

pub fn request(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    codex_request(app, &app.state::<Live>(), method, params)
}

pub fn list(app: &AppHandle, archived: bool) -> Result<Vec<Session>, String> {
    let mut out = Vec::new();
    let mut cursor = Value::Null;
    let mut seen = HashSet::new();
    loop {
        let r = request(
            app,
            "thread/list",
            json!({"limit":100,"cursor":cursor,"archived":archived,
            "sourceKinds":["cli","vscode","appServer"],"sortKey":"updated_at"}),
        )?;
        for t in r["data"]
            .as_array()
            .ok_or("Resposta inválida ao listar conversas")?
        {
            if !t["parentThreadId"].is_null() {
                continue;
            }
            let Some(id) = t["id"].as_str() else {
                continue;
            };
            let title = t["name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or(t["preview"].as_str())
                .unwrap_or("Sem título");
            let s = Session {
                provider: "codex",
                id: id.into(),
                project: project_root(t["cwd"].as_str().unwrap_or_default()),
                title: title.into(),
                updated: t["updatedAt"].as_i64().unwrap_or(0) * 1000,
                file: t["path"].as_str().map(PathBuf::from),
            };
            remember(&app.state::<Store>(), s.clone());
            out.push(s);
        }
        cursor = r["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
        if !seen.insert(cursor.to_string()) {
            return Err("Codex repetiu a paginação".into());
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn codex_catalog(app: AppHandle, project: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut models = Vec::new();
        let mut cursor = Value::Null;
        let mut seen = HashSet::new();
        loop {
            let r = request(&app, "model/list", json!({"cursor":cursor}))?;
            if let Some(data) = r["data"].as_array() {
                models.extend(data.iter().cloned());
            }
            cursor = r["nextCursor"].clone();
            if cursor.is_null() || !seen.insert(cursor.to_string()) {
                break;
            }
        }
        let skills = request(&app, "skills/list", json!({"cwds":[project]}))?;
        Ok(json!({"models":models,"skills":skills["data"]}))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn codex_manage(
    app: AppHandle,
    id: String,
    action: String,
    name: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "read" => {
            let mut r = request(&app, "thread/read", json!({"threadId":id,"includeTurns":false}))?;
            let settings = codex_settings(&app.state::<Live>(), &id)
                .or_else(|| r["thread"]["path"].as_str().and_then(|p| saved_settings(Path::new(p))));
            r["thread"]["mode"] = settings.as_ref().map(thread_mode).unwrap_or(Value::Null);
            Ok(r)
        }
        "compact" => codex_compact(&app, &id),
        "rename" => {
            let name = name.as_deref().unwrap_or_default().trim();
            if name.is_empty() {
                return Err("Informe um título".into());
            }
            request(&app, "thread/name/set", json!({"threadId":id,"name":name}))
        }
        "archive" | "unarchive" => {
            let s = crate::sessions::find(&app.state::<Store>(), "codex", &id)?;
            crate::sessions::busy_elsewhere(&s)?;
            request(
                &app,
                if action == "archive" {
                    "thread/archive"
                } else {
                    "thread/unarchive"
                },
                json!({"threadId":id}),
            )
        }
        _ => Err("Operação desconhecida".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}

// thread/read exposes model/effort, but permissions are only in resume or the
// persisted turn context. Read backwards without loading or resuming the thread.
fn saved_settings(path: &Path) -> Option<Value> {
    read_saved_settings(&mut std::fs::File::open(path).ok()?)
}

fn read_saved_settings(file: &mut (impl Read + Seek)) -> Option<Value> {
    let mut pos = file.seek(SeekFrom::End(0)).ok()?;
    let mut suffix = Vec::new();
    while pos > 0 {
        let size = pos.min(64 * 1024) as usize;
        pos -= size as u64;
        file.seek(SeekFrom::Start(pos)).ok()?;
        let mut chunk = vec![0; size];
        file.read_exact(&mut chunk).ok()?;
        chunk.extend_from_slice(&suffix);
        let first = if pos > 0 { chunk.iter().position(|b| *b == b'\n').map(|n| n + 1).unwrap_or(chunk.len()) } else { 0 };
        for line in chunk[first..].split(|b| *b == b'\n').rev() {
            if !line.windows(12).any(|w| w == b"turn_context") { continue; }
            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                if v["type"] == "turn_context" { return Some(v["payload"].clone()); }
            }
        }
        suffix = chunk[..first].to_vec();
    }
    None
}

#[cfg(test)]
mod composer_tests {
    use super::*;

    #[test]
    fn reads_last_turn_context_across_large_messages() {
        let mut log = b"{\"type\":\"turn_context\",\"payload\":{\"approval_policy\":\"untrusted\",\"sandbox_policy\":{\"type\":\"workspace-write\"}}}\n".to_vec();
        log.extend_from_slice(b"{\"type\":\"turn_context\",\"payload\":{\"approval_policy\":\"on-request\",\"sandbox_policy\":{\"type\":\"read-only\"},\"collaboration_mode\":{\"mode\":\"plan\"}}}\n");
        log.extend(vec![b'x'; 180_000]);
        log.extend_from_slice(b"\n");
        let settings = read_saved_settings(&mut std::io::Cursor::new(log)).unwrap();
        assert_eq!(thread_mode(&settings), "plan");
    }

    #[test]
    fn maps_resumed_and_persisted_permissions_without_widening_custom_modes() {
        for (approval, sandbox, mode) in [
            ("on-request", "workspaceWrite", "auto"),
            ("untrusted", "workspace-write", "default"),
            ("never", "dangerFullAccess", "bypassPermissions"),
            ("never", "readOnly", "custom"),
        ] {
            assert_eq!(thread_mode(&json!({"approvalPolicy":approval,"sandbox":{"type":sandbox}})), mode);
            assert_eq!(thread_mode(&json!({"approval_policy":approval,"sandbox_policy":{"type":sandbox}})), mode);
        }
    }
}

fn thread_mode(settings: &Value) -> Value {
    let collaboration = settings.get("collaborationMode").or(settings.get("collaboration_mode"));
    if collaboration.is_some_and(|c| c["mode"] == "plan") { return json!("plan"); }
    let approval = settings.get("approvalPolicy").or(settings.get("approval_policy")).and_then(Value::as_str);
    let sandbox = settings.get("sandbox").or(settings.get("sandbox_policy"));
    let sandbox = sandbox.and_then(|s| s["type"].as_str().or(s.as_str()));
    match (approval, sandbox) {
        (Some("never"), Some("dangerFullAccess" | "danger-full-access")) => json!("bypassPermissions"),
        (Some("untrusted"), Some("workspaceWrite" | "workspace-write")) => json!("default"),
        (Some("on-request"), Some("workspaceWrite" | "workspace-write")) => json!("auto"),
        (Some("on-request"), Some("readOnly" | "read-only")) => json!("plan"),
        _ => json!("custom"),
    }
}

fn paged(app: &AppHandle, method: &str, mut params: Value) -> Result<Value, String> {
    let mut data = Vec::new();
    let mut seen = HashSet::new();
    loop {
        let r = request(app, method, params.clone())?;
        data.extend(r["data"].as_array().ok_or("Catálogo inválido")?.iter().cloned());
        let cursor = r["nextCursor"].clone();
        if cursor.is_null() { break; }
        if !seen.insert(cursor.to_string()) { return Err("Paginação repetida no catálogo".into()); }
        params["cursor"] = cursor;
    }
    Ok(json!(data))
}

#[tauri::command]
pub async fn codex_integrations(app: AppHandle, project: String, id: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Only pass threadId for threads loaded by this server. Opening a menu
        // must not resume a conversation currently owned by another client.
        let thread_id = id.filter(|id| codex_settings(&app.state::<Live>(), id).is_some());
        let (apps, plugins, mcp) = std::thread::scope(|scope| {
            let apps = scope.spawn(|| paged(&app, "app/list", json!({"limit":100,"threadId":thread_id})));
            let plugins = scope.spawn(|| request(&app, "plugin/list", json!({"cwds":[project]})));
            let mcp = scope.spawn(|| paged(&app, "mcpServerStatus/list", json!({"limit":100,"threadId":thread_id})));
            (apps.join().unwrap(), plugins.join().unwrap(), mcp.join().unwrap())
        });
        let mut result = json!({"apps":[],"plugins":[],"mcp":[],"errors":{}});
        for (key, value) in [("apps", apps), ("plugins", plugins), ("mcp", mcp)] {
            match value {
                Ok(value) => result[key] = value,
                Err(error) => result["errors"][key] = json!(error),
            }
        }
        result
    }).await.map_err(|e| e.to_string())
}
