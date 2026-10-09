//! Sessões ao vivo, falando o mesmo protocolo que os apps desktop usam:
//! - Claude: um `claude` por sessão com stream-json (stdin/stdout) e `--permission-prompt-tool stdio`
//! - Codex: um `codex app-server` (JSON-RPC via stdio) para todas as threads
//! Os eventos vão para a interface pelo evento Tauri "live". O arquivo da sessão continua sendo a fonte da
//! verdade: ao fim de cada turno a interface relê a conversa.
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::sessions::{busy_elsewhere, find, hidden, Store};

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Delta { text: String },
    Tool { name: String, title: String, detail: String },
    Approval { request_id: String, tool: String, detail: String },
    Done { error: Option<String> },
}

#[derive(Clone, Serialize)]
struct Envelope {
    provider: &'static str,
    id: String,
    #[serde(flatten)]
    event: Event,
}

fn emit(app: &AppHandle, provider: &'static str, id: &str, event: Event) {
    let _ = app.emit("live", Envelope { provider, id: id.to_string(), event });
}

#[derive(Deserialize)]
pub struct ImageIn {
    media_type: String,
    data: String, // base64 sem o prefixo data:
}

type Stdin = Arc<Mutex<ChildStdin>>;

fn write_line(stdin: &Stdin, v: &Value) -> Result<(), String> {
    let mut w = stdin.lock().unwrap();
    writeln!(w, "{v}").and_then(|_| w.flush()).map_err(|e| format!("o processo do agente fechou ({e})"))
}

/// Resumo curto do que a ferramenta vai fazer (comando, arquivo, padrão…).
pub fn tool_detail(input: &Value) -> String {
    for k in ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"] {
        if let Some(s) = input[k].as_str() {
            return s.chars().take(240).collect();
        }
    }
    String::new()
}

// ---------- Claude ----------

struct ClaudeProc {
    stdin: Stdin,
    child: Arc<Mutex<Child>>,
    pending: Arc<Mutex<HashMap<String, Value>>>, // request_id -> input da ferramenta
}

#[derive(Default)]
pub struct Live {
    claude: Mutex<HashMap<String, ClaudeProc>>,
    codex: Mutex<Option<Arc<CodexServer>>>,
}

fn spawn_claude(app: &AppHandle, id: &str, cwd: &str) -> Result<ClaudeProc, String> {
    let mut cmd = Command::new("cmd"); // npm instala o claude como .cmd; via cmd /c ele resolve
    cmd.args([
        "/c", "claude", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--include-partial-messages", "--permission-prompt-tool", "stdio", "--resume", id,
    ]);
    // sem variáveis CLAUDE* herdadas (Lume aberto de dentro de uma sessão do app), senão a CLI se passa por ela
    for (k, _) in std::env::vars() {
        if k.to_uppercase().starts_with("CLAUDE") {
            cmd.env_remove(k);
        }
    }
    hidden(&mut cmd).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("não consegui iniciar o claude: {e}"))?;
    let stdin = Arc::new(Mutex::new(child.stdin.take().unwrap()));
    let stdout = child.stdout.take().unwrap();
    let pending = Arc::new(Mutex::new(HashMap::new()));
    let proc = ClaudeProc { stdin: stdin.clone(), child: Arc::new(Mutex::new(child)), pending: pending.clone() };

    let (app, id) = (app.clone(), id.to_string());
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(o) = serde_json::from_str::<Value>(&line) else { continue };
            match o["type"].as_str() {
                Some("stream_event") => {
                    let ev = &o["event"];
                    if ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta" {
                        let text = ev["delta"]["text"].as_str().unwrap_or_default().to_string();
                        emit(&app, "claude", &id, Event::Delta { text });
                    }
                }
                Some("assistant") => {
                    for c in o["message"]["content"].as_array().into_iter().flatten() {
                        if c["type"] == "tool_use" {
                            let name = c["name"].as_str().unwrap_or("tool").to_string();
                            let title = c["input"]["description"].as_str().unwrap_or_default().to_string();
                            emit(&app, "claude", &id, Event::Tool { name, title, detail: tool_detail(&c["input"]) });
                        }
                    }
                }
                Some("control_request") => {
                    let rid = o["request_id"].as_str().unwrap_or_default().to_string();
                    let r = &o["request"];
                    if r["subtype"] == "can_use_tool" {
                        let tool = r["tool_name"].as_str().unwrap_or("tool").to_string();
                        let detail = tool_detail(&r["input"]);
                        pending.lock().unwrap().insert(rid.clone(), r["input"].clone());
                        emit(&app, "claude", &id, Event::Approval { request_id: rid, tool, detail });
                    } else {
                        // pedido que o Lume ainda não sabe atender: responde erro para o turno não travar
                        let resp = json!({"type": "control_response", "response": {"subtype": "error", "request_id": rid, "error": "não suportado pelo Lume"}});
                        let _ = write_line(&stdin, &resp);
                    }
                }
                Some("result") => {
                    let error = (o["is_error"] == true).then(|| o["result"].as_str().unwrap_or("o turno falhou").to_string());
                    emit(&app, "claude", &id, Event::Done { error });
                }
                _ => {}
            }
        }
        // processo terminou (fechou, travou ou foi encerrado): some do mapa
        let live = app.state::<Live>();
        live.claude.lock().unwrap().remove(&id);
    });
    Ok(proc)
}

fn claude_send(app: &AppHandle, live: &Live, store: &Store, id: &str, text: &str, images: &[ImageIn]) -> Result<(), String> {
    let s = find(store, "claude", id)?;
    let mut procs = live.claude.lock().unwrap();
    if !procs.contains_key(id) {
        busy_elsewhere(&s)?; // só checa quando o Lume ainda não é dono da sessão
        let p = spawn_claude(app, id, &s.project)?;
        procs.insert(id.to_string(), p);
    }
    let mut content: Vec<Value> = images
        .iter()
        .map(|i| json!({"type": "image", "source": {"type": "base64", "media_type": i.media_type, "data": i.data}}))
        .collect();
    if !text.trim().is_empty() {
        content.push(json!({"type": "text", "text": text}));
    }
    write_line(&procs[id].stdin, &json!({"type": "user", "message": {"role": "user", "content": content}}))
}

fn claude_answer(live: &Live, id: &str, request_id: &str, allow: bool) -> Result<(), String> {
    let procs = live.claude.lock().unwrap();
    let p = procs.get(id).ok_or("a sessão não está mais ativa")?;
    let input = p.pending.lock().unwrap().remove(request_id).unwrap_or(json!({}));
    let response = if allow {
        json!({"behavior": "allow", "updatedInput": input})
    } else {
        json!({"behavior": "deny", "message": "Negado pelo usuário no Lume"})
    };
    write_line(&p.stdin, &json!({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": response}}))
}

// ---------- Codex ----------

struct CodexServer {
    stdin: Stdin,
    child: Mutex<Child>,
    next_id: AtomicU64,
    waiting: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    resumed: Mutex<HashSet<String>>,
    approvals: Mutex<HashMap<String, Value>>, // request_id (texto) -> id JSON-RPC original
    turns: Mutex<HashMap<String, String>>,    // thread -> turno em andamento
}

/// O runtime que o Codex app usa (com o sandbox do Windows já configurado); senão, o do pacote.
fn codex_exe() -> Option<PathBuf> {
    let base = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("OpenAI").join("Codex").join("bin");
    let newest = std::fs::read_dir(base)
        .ok()?
        .flatten()
        .map(|e| e.path().join("codex.exe"))
        .filter(|p| p.exists())
        .max_by_key(|p| p.metadata().and_then(|m| m.modified()).ok());
    newest.or_else(|| {
        let out = hidden(Command::new("powershell").args(["-NoProfile", "-Command", "(Get-AppxPackage OpenAI.Codex).InstallLocation"])).output().ok()?;
        let p = Path::new(String::from_utf8_lossy(&out.stdout).trim()).join("app").join("resources").join("codex.exe");
        p.exists().then_some(p)
    })
}

impl CodexServer {
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.waiting.lock().unwrap().insert(id, tx);
        write_line(&self.stdin, &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
        rx.recv_timeout(Duration::from_secs(60)).map_err(|_| format!("o Codex não respondeu a {method}"))?
    }
}

fn spawn_codex(app: &AppHandle) -> Result<Arc<CodexServer>, String> {
    let exe = codex_exe().ok_or("não achei o Codex instalado")?;
    let mut cmd = Command::new(exe);
    cmd.arg("app-server");
    hidden(&mut cmd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("não consegui iniciar o codex app-server: {e}"))?;
    let stdin = Arc::new(Mutex::new(child.stdin.take().unwrap()));
    let stdout = child.stdout.take().unwrap();
    let server = Arc::new(CodexServer {
        stdin,
        child: Mutex::new(child),
        next_id: AtomicU64::new(1),
        waiting: Mutex::new(HashMap::new()),
        resumed: Mutex::new(HashSet::new()),
        approvals: Mutex::new(HashMap::new()),
        turns: Mutex::new(HashMap::new()),
    });

    let (app2, srv) = (app.clone(), server.clone());
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(o) = serde_json::from_str::<Value>(&line) else { continue };
            let p = &o["params"];
            let thread = p["threadId"].as_str().unwrap_or_default().to_string();
            match (o.get("id"), o["method"].as_str()) {
                (Some(id), None) => {
                    // resposta a um pedido nosso
                    if let Some(tx) = id.as_u64().and_then(|n| srv.waiting.lock().unwrap().remove(&n)) {
                        let r = match o.get("error") {
                            Some(e) => Err(e["message"].as_str().unwrap_or("erro do Codex").to_string()),
                            None => Ok(o["result"].clone()),
                        };
                        let _ = tx.send(r);
                    }
                }
                (Some(id), Some(method)) => match method {
                    // pedido de aprovação vindo do Codex
                    "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                        let rid = id.to_string();
                        srv.approvals.lock().unwrap().insert(rid.clone(), id.clone());
                        let (tool, detail) = if method.contains("command") {
                            ("Comando".to_string(), p["command"].as_str().or(p["reason"].as_str()).unwrap_or_default().to_string())
                        } else {
                            ("Editar arquivos".to_string(), p["reason"].as_str().or(p["grantRoot"].as_str()).unwrap_or_default().to_string())
                        };
                        emit(&app2, "codex", &thread, Event::Approval { request_id: rid, tool, detail });
                    }
                    _ => {
                        // pedido que o Lume ainda não sabe atender: erro, para o turno não travar
                        let _ = write_line(&srv.stdin, &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "não suportado pelo Lume"}}));
                    }
                },
                (None, Some(method)) => match method {
                    "item/agentMessage/delta" => {
                        let text = p["delta"].as_str().unwrap_or_default().to_string();
                        emit(&app2, "codex", &thread, Event::Delta { text });
                    }
                    "item/started" => {
                        let it = &p["item"];
                        let tool = match it["type"].as_str() {
                            Some("commandExecution") => Some(("Comando".to_string(), it["command"].as_str().unwrap_or_default().to_string())),
                            Some("fileChange") => Some(("Editar arquivos".to_string(), String::new())),
                            Some("mcpToolCall") => Some((it["tool"].as_str().unwrap_or("tool").to_string(), it["server"].as_str().unwrap_or_default().to_string())),
                            Some("webSearch") => Some(("Busca na web".to_string(), String::new())),
                            _ => None,
                        };
                        if let Some((name, detail)) = tool {
                            emit(&app2, "codex", &thread, Event::Tool { name, title: String::new(), detail: detail.chars().take(240).collect() });
                        }
                    }
                    "turn/started" => {
                        if let Some(turn) = p["turn"]["id"].as_str() {
                            srv.turns.lock().unwrap().insert(thread.clone(), turn.to_string());
                        }
                    }
                    "turn/completed" => {
                        srv.turns.lock().unwrap().remove(&thread);
                        let t = &p["turn"];
                        let error = (t["status"] == "failed").then(|| t["error"]["message"].as_str().unwrap_or("o turno falhou").to_string());
                        emit(&app2, "codex", &thread, Event::Done { error });
                    }
                    _ => {}
                },
                _ => {}
            }
        }
        // servidor morreu: o próximo envio sobe outro
        let live = app2.state::<Live>();
        *live.codex.lock().unwrap() = None;
    });

    server.request("initialize", json!({"clientInfo": {"name": "lume", "title": "Lume", "version": env!("CARGO_PKG_VERSION")}, "capabilities": null}))?;
    write_line(&server.stdin, &json!({"jsonrpc": "2.0", "method": "initialized"}))?;
    Ok(server)
}

fn codex_server(app: &AppHandle, live: &Live) -> Result<Arc<CodexServer>, String> {
    let mut slot = live.codex.lock().unwrap();
    if let Some(s) = slot.as_ref() {
        return Ok(s.clone());
    }
    let s = spawn_codex(app)?;
    *slot = Some(s.clone());
    Ok(s)
}

/// Uma chamada avulsa ao app-server (ex.: account/rateLimits/read), subindo o servidor se preciso.
pub fn codex_request(app: &AppHandle, live: &Live, method: &str, params: Value) -> Result<Value, String> {
    codex_server(app, live)?.request(method, params)
}

fn codex_send(app: &AppHandle, live: &Live, store: &Store, id: &str, text: &str, images: &[ImageIn]) -> Result<(), String> {
    let s = find(store, "codex", id)?;
    let server = codex_server(app, live)?;
    if !server.resumed.lock().unwrap().contains(id) {
        busy_elsewhere(&s)?; // só checa quando o Lume ainda não é dono da thread
        server.request("thread/resume", json!({"threadId": id}))?; // mantém modelo/sandbox/aprovação da própria thread
        server.resumed.lock().unwrap().insert(id.to_string());
    }
    let mut input = vec![];
    if !text.trim().is_empty() {
        input.push(json!({"type": "text", "text": text, "text_elements": []}));
    }
    for (i, img) in images.iter().enumerate() {
        input.push(json!({"type": "localImage", "path": save_temp_image(img, i)?}));
    }
    server.request("turn/start", json!({"threadId": id, "input": input}))?;
    Ok(())
}

fn save_temp_image(img: &ImageIn, i: usize) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(&img.data).map_err(|e| e.to_string())?;
    let ext = img.media_type.rsplit('/').next().unwrap_or("png");
    let dir = std::env::temp_dir().join("lume-images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    let path = dir.join(format!("{stamp}-{i}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn codex_answer(live: &Live, request_id: &str, allow: bool) -> Result<(), String> {
    let server = live.codex.lock().unwrap().clone().ok_or("o Codex não está mais ativo")?;
    let id = server.approvals.lock().unwrap().remove(request_id).ok_or("aprovação já respondida")?;
    let decision = if allow { "accept" } else { "decline" };
    write_line(&server.stdin, &json!({"jsonrpc": "2.0", "id": id, "result": {"decision": decision}}))
}

fn interrupt(live: &Live, provider: &str, id: &str) -> Result<(), String> {
    match provider {
        "claude" => {
            let procs = live.claude.lock().unwrap();
            let p = procs.get(id).ok_or("a sessão não está respondendo")?;
            let rid = format!("lume-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
            write_line(&p.stdin, &json!({"type": "control_request", "request_id": rid, "request": {"subtype": "interrupt"}}))
        }
        "codex" => {
            let server = live.codex.lock().unwrap().clone().ok_or("o Codex não está ativo")?;
            let turn = server.turns.lock().unwrap().get(id).cloned().ok_or("nenhum turno em andamento")?;
            server.request("turn/interrupt", json!({"threadId": id, "turnId": turn})).map(|_| ())
        }
        _ => Err("provider inválido".into()),
    }
}

// ---------- comandos ----------

#[tauri::command]
pub async fn live_send(
    app: AppHandle,
    live: State<'_, Live>,
    store: State<'_, Store>,
    provider: String,
    id: String,
    text: String,
    images: Vec<ImageIn>,
) -> Result<(), String> {
    if text.trim().is_empty() && images.is_empty() {
        return Err("mensagem vazia".into());
    }
    match provider.as_str() {
        "claude" => claude_send(&app, &live, &store, &id, &text, &images),
        "codex" => codex_send(&app, &live, &store, &id, &text, &images),
        _ => Err("o Antigravity não tem CLI para continuar a conversa; use Abrir no app".into()),
    }
}

#[tauri::command]
pub async fn live_answer(live: State<'_, Live>, provider: String, id: String, request_id: String, allow: bool) -> Result<(), String> {
    match provider.as_str() {
        "claude" => claude_answer(&live, &id, &request_id, allow),
        "codex" => codex_answer(&live, &request_id, allow),
        _ => Err("provider inválido".into()),
    }
}

#[tauri::command]
pub async fn live_interrupt(live: State<'_, Live>, provider: String, id: String) -> Result<(), String> {
    interrupt(&live, &provider, &id)
}

/// Encerra a árvore inteira (o claude roda debaixo de um `cmd /c`; matar só o cmd deixaria o claude vivo).
fn kill_tree(child: &Mutex<Child>) {
    let pid = child.lock().unwrap().id().to_string();
    let _ = hidden(Command::new("taskkill").args(["/T", "/F", "/PID", &pid])).output();
}

/// Encerra os agentes que o Lume abriu (no Windows os filhos não morrem junto com o app).
pub fn shutdown(app: &AppHandle) {
    let live = app.state::<Live>();
    for (_, p) in live.claude.lock().unwrap().drain() {
        kill_tree(&p.child);
    }
    let codex = live.codex.lock().unwrap().take();
    if let Some(s) = codex {
        kill_tree(&s.child);
    }
}
