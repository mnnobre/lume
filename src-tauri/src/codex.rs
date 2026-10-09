//! Versioned, public app-server operations. Never write Codex's internal database.
use crate::{
    live::{codex_request, Live},
    sessions::{project_root, remember, Session, Store},
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::PathBuf};
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
        "read" => request(
            &app,
            "thread/read",
            json!({"threadId":id,"includeTurns":false}),
        ),
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
