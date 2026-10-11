//! Registro de trabalho para o Dashboard: quanto tempo e o quê em cada conversa, tirado dos horários que
//! cada ferramenta grava em todo evento (Claude/Codex: "timestamp", Antigravity: "created_at").
//! Eventos com até GAP_MS de distância formam um bloco de trabalho; pausa maior não conta.
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::sessions::{locate, Session, Store};

const GAP_MS: i64 = 15 * 60_000;
const SOLO_MS: i64 = 60_000; // evento isolado vale 1 min
const PROMPT_MAX: usize = 240;

#[derive(Clone, Default)]
struct Scan {
    spans: Vec<(i64, i64)>,
    prompts: Vec<(i64, String)>, // pedidos do usuário (as "atividades")
    files: Vec<(i64, String)>,   // arquivos editados/criados pelo agente (última vez)
}

#[derive(Serialize)]
pub struct WorkSession {
    provider: &'static str,
    id: String,
    project: String,
    title: String,
    spans: Vec<(i64, i64)>,
    prompts: Vec<(i64, String)>,
    files: Vec<String>,
}

// arquivo -> (tamanho, mtime, leitura): só relê o que mudou
static CACHE: Mutex<Option<HashMap<PathBuf, (u64, i64, Scan)>>> = Mutex::new(None);

fn stamp(line: &str) -> Option<i64> {
    let i = ["\"timestamp\":\"", "\"created_at\":\""]
        .iter()
        .find_map(|n| line.find(n).map(|i| i + n.len()))?;
    let end = line[i..].find('"')? + i;
    chrono::DateTime::parse_from_rfc3339(&line[i..end])
        .ok()
        .map(|d| d.timestamp_millis())
}

fn clip(s: &str) -> String {
    let s = s.trim();
    let mut out: String = s.chars().take(PROMPT_MAX).collect();
    if out.len() < s.len() {
        out.push('…');
    }
    out
}

/// Texto que o usuário digitou (sem lembretes/injeções do sistema, que vêm entre <tags>).
fn prompt_of(provider: &str, o: &Value) -> Option<String> {
    let text = match provider {
        "claude" if o["type"] == "user" && o["isMeta"] != true => {
            let c = &o["message"]["content"];
            c.as_str().map(String::from).or_else(|| {
                c.as_array()?
                    .iter()
                    .find(|x| x["type"] == "text")
                    .and_then(|x| x["text"].as_str().map(String::from))
            })?
        }
        "codex" if o["type"] == "event_msg" && o["payload"]["type"] == "user_message" => {
            o["payload"]["message"].as_str()?.to_string()
        }
        "antigravity" if o["type"] == "USER_INPUT" => {
            let c = o["content"].as_str()?;
            let start = c.find("<USER_REQUEST>").map_or(0, |i| i + 14);
            let end = c.find("</USER_REQUEST>").unwrap_or(c.len());
            c.get(start..end)?.to_string()
        }
        _ => return None,
    };
    (!text.trim().is_empty() && !text.trim_start().starts_with('<')).then(|| clip(&text))
}

fn files_of(provider: &str, t: i64, line: &str, o: Option<&Value>, out: &mut Vec<(i64, String)>) {
    let mut add = |f: &str| {
        if f.is_empty() {
            return;
        }
        match out.iter_mut().find(|x| x.1 == f) {
            Some(x) => x.0 = t,
            None => out.push((t, f.to_string())),
        }
    };
    match provider {
        "claude" => {
            for c in o.and_then(|o| o["message"]["content"].as_array()).into_iter().flatten() {
                if c["type"] == "tool_use"
                    && matches!(c["name"].as_str(), Some("Edit" | "Write" | "MultiEdit" | "NotebookEdit"))
                {
                    let i = &c["input"];
                    add(i["file_path"].as_str().or(i["notebook_path"].as_str()).unwrap_or_default());
                }
            }
        }
        // apply_patch: o caminho vem no texto do patch, com \n escapado no JSON
        "codex" => {
            for n in ["*** Update File: ", "*** Add File: "] {
                for (i, _) in line.match_indices(n) {
                    let rest = &line[i + n.len()..];
                    let end = rest.find("\\n").or(rest.find('"')).unwrap_or(rest.len());
                    add(rest[..end].trim());
                }
            }
        }
        _ => {}
    }
}

fn read(provider: &str, path: &Path) -> Option<Scan> {
    let mut stamps = vec![];
    let mut scan = Scan::default();
    for line in BufReader::new(File::open(path).ok()?).lines().map_while(Result::ok) {
        let Some(t) = stamp(&line) else { continue };
        stamps.push(t);
        // só decodifica o JSON de linhas que podem ter pedido ou edição
        let wants = match provider {
            "claude" => line.contains("\"type\":\"user\"") || line.contains("\"tool_use\""),
            "codex" => line.contains("user_message") || line.contains("*** "),
            _ => line.contains("USER_INPUT"),
        };
        if !wants {
            continue;
        }
        let o = serde_json::from_str::<Value>(&line).ok();
        if let Some(p) = o.as_ref().and_then(|o| prompt_of(provider, o)) {
            scan.prompts.push((t, p));
        }
        files_of(provider, t, &line, o.as_ref(), &mut scan.files);
    }
    scan.spans = spans(stamps);
    Some(scan)
}

fn spans(mut stamps: Vec<i64>) -> Vec<(i64, i64)> {
    stamps.sort_unstable();
    let mut out: Vec<(i64, i64)> = vec![];
    for t in stamps {
        match out.last_mut() {
            Some((_, end)) if t - *end <= GAP_MS => *end = (*end).max(t),
            _ => out.push((t, t)),
        }
    }
    for s in &mut out {
        s.1 = s.1.max(s.0 + SOLO_MS);
    }
    out
}

fn scan(provider: &str, path: &Path) -> Option<Scan> {
    let meta = path.metadata().ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    let key = (meta.len(), mtime);
    if let Some((len, m, s)) = CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(path) {
        if (*len, *m) == key {
            return Some(s.clone());
        }
    }
    let s = read(provider, path)?;
    CACHE
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(path.to_path_buf(), (key.0, key.1, s.clone()));
    Some(s)
}

/// Conversas com atividade desde `since` (ms), com os blocos de trabalho, pedidos e arquivos do período.
#[tauri::command]
pub async fn work_log(app: AppHandle, since: i64) -> Result<Vec<WorkSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        let list: Vec<Session> = store
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.updated >= since)
            .cloned()
            .collect();
        list.into_iter()
            .filter_map(|s| {
                let path = s.file.clone().filter(|f| f.exists()).or_else(|| locate(&s))?;
                let sc = scan(s.provider, &path)?;
                let spans: Vec<_> = sc.spans.into_iter().filter(|(_, e)| *e >= since).collect();
                (!spans.is_empty()).then(|| WorkSession {
                    provider: s.provider,
                    id: s.id,
                    project: s.project,
                    title: s.title,
                    spans,
                    prompts: sc.prompts.into_iter().filter(|(t, _)| *t >= since).collect(),
                    files: sc.files.into_iter().filter(|(t, _)| *t >= since).map(|(_, f)| f).collect(),
                })
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocos_quebram_em_pausa_longa() {
        let m = 60_000;
        // 0, 5 e 10 min juntos; 40 min sozinho (vale 1 min)
        assert_eq!(spans(vec![10 * m, 0, 5 * m, 40 * m]), vec![(0, 10 * m), (40 * m, 41 * m)]);
        assert_eq!(
            stamp(r#"{"timestamp":"2026-10-11T18:42:34.467Z","x":1}"#),
            Some(1791744154467)
        );
        assert_eq!(
            prompt_of("antigravity", &serde_json::json!({"type":"USER_INPUT","content":"<USER_REQUEST>\nfaz X\n</USER_REQUEST><ADDITIONAL_METADATA>"})),
            Some("faz X".into())
        );
    }
}
