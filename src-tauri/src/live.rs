//! Sessões ao vivo, falando o mesmo protocolo que os apps desktop usam:
//! - Claude: um `claude` por sessão com stream-json (stdin/stdout) e `--permission-prompt-tool stdio`
//! - Codex: um `codex app-server` (JSON-RPC via stdio) para todas as threads
//! Os eventos vão para a interface pelo evento Tauri "live". O arquivo da sessão continua sendo a fonte da
//! verdade: ao fim de cada turno a interface relê a conversa.
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::sessions::{busy_elsewhere, find, hidden, remember, Session, Store};

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Started {},
    Request {
        request_id: String,
        method: String,
        params: Value,
    },
    Resolved {
        request_id: String,
    },
    Delta {
        text: String,
        item_id: Option<String>,
    },
    Tool {
        name: String,
        title: String,
        detail: String,
    },
    Approval {
        request_id: String,
        tool: String,
        detail: String,
    },
    Done {
        error: Option<String>,
    },
}

#[derive(Clone, Serialize)]
struct Envelope {
    provider: &'static str,
    id: String,
    seq: u64,
    #[serde(flatten)]
    event: Event,
}

fn emit(app: &AppHandle, provider: &'static str, id: &str, event: Event) {
    let live = app.state::<Live>();
    let mut views = live.views.lock().unwrap();
    let seq = live.sequence.fetch_add(1, Ordering::SeqCst) + 1;
    let view = views
        .entry(format!("{provider}:{id}"))
        .or_insert_with(|| View::new(provider, id));
    view.apply(&event, seq);
    let _ = app.emit(
        "live",
        Envelope {
            provider,
            id: id.to_string(),
            seq,
            event,
        },
    );
}

#[derive(Clone, Serialize)]
pub struct View {
    provider: String,
    id: String,
    seq: u64,
    busy: bool,
    text: String,
    tools: Vec<Value>,
    requests: Vec<Value>,
    since: u64,
    error: Option<String>,
    item_id: Option<String>,
}
impl View {
    fn new(provider: &str, id: &str) -> Self {
        Self {
            provider: provider.into(),
            id: id.into(),
            seq: 0,
            busy: false,
            text: String::new(),
            tools: vec![],
            requests: vec![],
            since: 0,
            error: None,
            item_id: None,
        }
    }
    fn apply(&mut self, event: &Event, seq: u64) {
        self.seq = seq;
        if matches!(event, Event::Started {}) {
            self.text.clear();
            self.tools.clear();
            self.requests.clear();
            self.error = None;
            self.item_id = None;
            self.since = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
        }
        match event {
            Event::Started {} => self.busy = true,
            Event::Delta { text, item_id } => {
                self.busy = true;
                if item_id.is_some() && self.item_id != *item_id {
                    self.text.clear();
                }
                self.item_id = item_id.clone();
                self.text.push_str(text);
            }
            Event::Tool {
                name,
                title,
                detail,
            } => {
                self.busy = true;
                self.tools
                    .push(json!({"role":"tool","text":name,"title":title,"detail":detail}));
            }
            Event::Approval { .. } | Event::Request { .. } => {
                self.busy = true;
                self.requests.push(serde_json::to_value(event).unwrap());
            }
            Event::Resolved { request_id } => {
                self.requests.retain(|r| r["request_id"] != *request_id)
            }
            Event::Done { error } => {
                self.busy = false;
                self.error = error.clone();
                self.requests.clear();
            }
        }
    }
}

#[tauri::command]
pub fn live_snapshot(live: State<'_, Live>) -> Vec<View> {
    live.views.lock().unwrap().values().cloned().collect()
}

#[derive(Deserialize)]
pub struct ImageIn {
    media_type: String,
    data: String, // base64 sem o prefixo data:
}

#[derive(Default, Deserialize)]
pub struct TurnOptions {
    model: Option<String>,
    effort: Option<String>,
    #[serde(default)]
    skills: Vec<SkillInput>,
}
#[derive(Deserialize)]
struct SkillInput {
    name: String,
    path: String,
}

fn turn_params(
    id: &str,
    text: &str,
    images: &[ImageIn],
    options: &TurnOptions,
) -> Result<Value, String> {
    let mut input = vec![];
    if !text.trim().is_empty() {
        input.push(json!({"type":"text","text":text,"text_elements":[]}));
    }
    for (i, img) in images.iter().enumerate() {
        input.push(json!({"type":"localImage","path":save_temp_image(img,i)?}));
    }
    for skill in &options.skills {
        input.push(json!({"type":"skill","name":skill.name,"path":skill.path}));
    }
    let mut p = json!({"threadId":id,"input":input});
    if let Some(model) = &options.model {
        if !model.is_empty() {
            p["model"] = json!(model);
        }
    }
    if let Some(effort) = &options.effort {
        if !effort.is_empty() {
            p["effort"] = json!(effort);
        }
    }
    Ok(p)
}

type Stdin = Arc<Mutex<ChildStdin>>;

fn write_line(stdin: &Stdin, v: &Value) -> Result<(), String> {
    let mut w = stdin.lock().unwrap();
    writeln!(w, "{v}")
        .and_then(|_| w.flush())
        .map_err(|e| format!("o processo do agente fechou ({e})"))
}

/// Resumo curto do que a ferramenta vai fazer (comando, arquivo, padrão…).
pub fn tool_detail(input: &Value) -> String {
    for k in [
        "command",
        "file_path",
        "path",
        "pattern",
        "url",
        "query",
        "description",
        "prompt",
    ] {
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
    views: Mutex<HashMap<String, View>>,
    sequence: AtomicU64,
}

/// `resume` = None abre uma conversa nova; o id dela chega no evento `system/init` (devolvido pelo canal).
fn spawn_claude(
    app: &AppHandle,
    resume: Option<&str>,
    cwd: &str,
) -> Result<(ClaudeProc, mpsc::Receiver<String>), String> {
    let mut cmd = Command::new("cmd"); // npm instala o claude como .cmd; via cmd /c ele resolve
    cmd.args([
        "/c",
        "claude",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
    ]);
    if let Some(id) = resume {
        cmd.args(["--resume", id]);
    }
    // sem variáveis CLAUDE* herdadas (Lume aberto de dentro de uma sessão do app), senão a CLI se passa por ela
    for (k, _) in std::env::vars() {
        if k.to_uppercase().starts_with("CLAUDE") {
            cmd.env_remove(k);
        }
    }
    hidden(&mut cmd)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("não consegui iniciar o claude: {e}"))?;
    let stdin = Arc::new(Mutex::new(child.stdin.take().unwrap()));
    let stdout = child.stdout.take().unwrap();
    let pending = Arc::new(Mutex::new(HashMap::new()));
    let proc = ClaudeProc {
        stdin: stdin.clone(),
        child: Arc::new(Mutex::new(child)),
        pending: pending.clone(),
    };

    let (tx, rx) = mpsc::channel();
    let (app, mut id) = (app.clone(), resume.unwrap_or_default().to_string());
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(o) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match o["type"].as_str() {
                Some("system") if o["subtype"] == "init" => {
                    if let Some(sid) = o["session_id"].as_str() {
                        id = sid.to_string();
                        let _ = tx.send(id.clone());
                    }
                }
                Some("stream_event") => {
                    let ev = &o["event"];
                    if ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta" {
                        let text = ev["delta"]["text"].as_str().unwrap_or_default().to_string();
                        emit(
                            &app,
                            "claude",
                            &id,
                            Event::Delta {
                                text,
                                item_id: None,
                            },
                        );
                    }
                }
                Some("assistant") => {
                    for c in o["message"]["content"].as_array().into_iter().flatten() {
                        if c["type"] == "tool_use" {
                            let name = c["name"].as_str().unwrap_or("tool").to_string();
                            let title = c["input"]["description"]
                                .as_str()
                                .unwrap_or_default()
                                .to_string();
                            emit(
                                &app,
                                "claude",
                                &id,
                                Event::Tool {
                                    name,
                                    title,
                                    detail: tool_detail(&c["input"]),
                                },
                            );
                        }
                    }
                }
                Some("control_request") => {
                    let rid = o["request_id"].as_str().unwrap_or_default().to_string();
                    let r = &o["request"];
                    if r["subtype"] == "can_use_tool" {
                        let tool = r["tool_name"].as_str().unwrap_or("tool").to_string();
                        let detail = tool_detail(&r["input"]);
                        pending
                            .lock()
                            .unwrap()
                            .insert(rid.clone(), r["input"].clone());
                        emit(
                            &app,
                            "claude",
                            &id,
                            Event::Approval {
                                request_id: rid,
                                tool,
                                detail,
                            },
                        );
                    } else {
                        // pedido que o Lume ainda não sabe atender: responde erro para o turno não travar
                        let resp = json!({"type": "control_response", "response": {"subtype": "error", "request_id": rid, "error": "não suportado pelo Lume"}});
                        let _ = write_line(&stdin, &resp);
                    }
                }
                Some("result") => {
                    let error = (o["is_error"] == true)
                        .then(|| o["result"].as_str().unwrap_or("o turno falhou").to_string());
                    emit(&app, "claude", &id, Event::Done { error });
                }
                _ => {}
            }
        }
        // processo terminou (fechou, travou ou foi encerrado): some do mapa
        let live = app.state::<Live>();
        live.claude.lock().unwrap().remove(&id);
    });
    Ok((proc, rx))
}

fn claude_message(text: &str, images: &[ImageIn]) -> Value {
    let mut content: Vec<Value> = images
        .iter()
        .map(|i| json!({"type": "image", "source": {"type": "base64", "media_type": i.media_type, "data": i.data}}))
        .collect();
    if !text.trim().is_empty() {
        content.push(json!({"type": "text", "text": text}));
    }
    json!({"type": "user", "message": {"role": "user", "content": content}})
}

/// Modelo/esforço do turno pelo protocolo de controle (vale para o processo já aberto, sem reiniciar).
fn claude_options(stdin: &Stdin, options: &TurnOptions) -> Result<(), String> {
    let rid = |k: &str| format!("lume-{k}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    if let Some(m) = options.model.as_deref().filter(|m| !m.is_empty()) {
        write_line(stdin, &json!({"type": "control_request", "request_id": rid("model"), "request": {"subtype": "set_model", "model": m}}))?;
    }
    if let Some(e) = options.effort.as_deref().filter(|e| !e.is_empty()) {
        let req = json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": e}});
        write_line(stdin, &json!({"type": "control_request", "request_id": rid("effort"), "request": req}))?;
    }
    Ok(())
}

fn claude_send(
    app: &AppHandle,
    live: &Live,
    store: &Store,
    id: &str,
    text: &str,
    images: &[ImageIn],
    options: &TurnOptions,
) -> Result<(), String> {
    let s = find(store, "claude", id)?;
    let mut procs = live.claude.lock().unwrap();
    if !procs.contains_key(id) {
        busy_elsewhere(&s)?; // só checa quando o Lume ainda não é dono da sessão
        let (p, _) = spawn_claude(app, Some(id), &s.project)?;
        procs.insert(id.to_string(), p);
    }
    emit(app, "claude", id, Event::Started {});
    claude_options(&procs[id].stdin, options)?;
    write_line(&procs[id].stdin, &claude_message(text, images))
}

fn claude_new(
    app: &AppHandle,
    live: &Live,
    store: &Store,
    project: &str,
    text: &str,
    images: &[ImageIn],
    options: &TurnOptions,
) -> Result<Session, String> {
    let (p, rx) = spawn_claude(app, None, project)?;
    claude_options(&p.stdin, options)?;
    write_line(&p.stdin, &claude_message(text, images))?;
    let id = rx.recv_timeout(Duration::from_secs(90)).map_err(|_| {
        kill_tree(&p.child);
        "o Claude Code não abriu a conversa (veja se `claude auth status` está logado)".to_string()
    })?;
    live.claude.lock().unwrap().insert(id.clone(), p);
    emit(app, "claude", &id, Event::Started {}); // a conversa nova já abre com o "trabalhando"
    let s = Session::created("claude", id, project.to_string(), text);
    remember(store, s.clone());
    Ok(s)
}

fn claude_answer(live: &Live, id: &str, request_id: &str, allow: bool) -> Result<(), String> {
    let procs = live.claude.lock().unwrap();
    let p = procs.get(id).ok_or("a sessão não está mais ativa")?;
    let input = p
        .pending
        .lock()
        .unwrap()
        .remove(request_id)
        .unwrap_or(json!({}));
    let response = if allow {
        json!({"behavior": "allow", "updatedInput": input})
    } else {
        json!({"behavior": "deny", "message": "Negado pelo usuário no Lume"})
    };
    write_line(
        &p.stdin,
        &json!({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": response}}),
    )
}

// ---------- Codex ----------

struct CodexServer {
    stdin: Stdin,
    child: Mutex<Child>,
    next_id: AtomicU64,
    waiting: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    resumed: Mutex<HashSet<String>>,
    approvals: Mutex<HashMap<String, (Value, String, String, Value)>>,
    turns: Mutex<HashMap<String, String>>, // thread -> turno em andamento
}

/// O runtime que o Codex app usa (com o sandbox do Windows já configurado); senão, o do pacote.
pub fn codex_exe() -> Option<PathBuf> {
    let base = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default())
        .join("OpenAI")
        .join("Codex")
        .join("bin");
    let newest = std::fs::read_dir(base)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path().join("codex.exe"))
        .filter(|p| p.exists())
        .max_by_key(|p| p.metadata().and_then(|m| m.modified()).ok());
    newest
        .or_else(|| {
            let out = hidden(Command::new("powershell").args([
                "-NoProfile",
                "-Command",
                "(Get-AppxPackage OpenAI.Codex).InstallLocation",
            ]))
            .output()
            .ok()?;
            let p = Path::new(String::from_utf8_lossy(&out.stdout).trim())
                .join("app")
                .join("resources")
                .join("codex.exe");
            p.exists().then_some(p)
        })
        .or_else(|| {
            let out = hidden(Command::new("where.exe").arg("codex.exe"))
                .output()
                .ok()?;
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(PathBuf::from)
                .find(|p| p.is_file())
        })
}

impl CodexServer {
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.waiting.lock().unwrap().insert(id, tx);
        if let Err(e) = write_line(
            &self.stdin,
            &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
        ) {
            self.waiting.lock().unwrap().remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(result) => result,
            Err(_) => {
                self.waiting.lock().unwrap().remove(&id);
                Err(format!("o Codex não respondeu a {method}"))
            }
        }
    }
}

fn spawn_codex(app: &AppHandle) -> Result<Arc<CodexServer>, String> {
    let exe = codex_exe().ok_or("não achei o Codex instalado")?;
    let mut cmd = Command::new(exe);
    cmd.arg("app-server");
    hidden(&mut cmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("não consegui iniciar o codex app-server: {e}"))?;
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
            let Ok(o) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let p = &o["params"];
            let thread = p["threadId"].as_str().unwrap_or_default().to_string();
            match (o.get("id"), o["method"].as_str()) {
                (Some(id), None) => {
                    // resposta a um pedido nosso
                    if let Some(tx) = id
                        .as_u64()
                        .and_then(|n| srv.waiting.lock().unwrap().remove(&n))
                    {
                        let r = match o.get("error") {
                            Some(e) => {
                                Err(e["message"].as_str().unwrap_or("erro do Codex").to_string())
                            }
                            None => Ok(o["result"].clone()),
                        };
                        let _ = tx.send(r);
                    }
                }
                (Some(id), Some(method)) => match method {
                    // pedido de aprovação vindo do Codex
                    "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                        let rid = id.to_string();
                        srv.approvals.lock().unwrap().insert(
                            rid.clone(),
                            (id.clone(), thread.clone(), method.into(), p.clone()),
                        );
                        let (tool, detail) = if method.contains("command") {
                            (
                                "Comando".to_string(),
                                p["command"]
                                    .as_str()
                                    .or(p["reason"].as_str())
                                    .unwrap_or_default()
                                    .to_string(),
                            )
                        } else {
                            (
                                "Editar arquivos".to_string(),
                                p["reason"]
                                    .as_str()
                                    .or(p["grantRoot"].as_str())
                                    .unwrap_or_default()
                                    .to_string(),
                            )
                        };
                        emit(
                            &app2,
                            "codex",
                            &thread,
                            Event::Approval {
                                request_id: rid,
                                tool,
                                detail,
                            },
                        );
                    }
                    "item/tool/requestUserInput"
                    | "tool/requestUserInput"
                    | "item/permissions/requestApproval"
                    | "mcpServer/elicitation/request" => {
                        let rid = id.to_string();
                        srv.approvals.lock().unwrap().insert(
                            rid.clone(),
                            (id.clone(), thread.clone(), method.into(), p.clone()),
                        );
                        emit(
                            &app2,
                            "codex",
                            &thread,
                            Event::Request {
                                request_id: rid,
                                method: method.into(),
                                params: p.clone(),
                            },
                        );
                    }
                    _ => {
                        // pedido que o Lume ainda não sabe atender: erro, para o turno não travar
                        let _ = write_line(
                            &srv.stdin,
                            &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "não suportado pelo Lume"}}),
                        );
                    }
                },
                (None, Some(method)) => match method {
                    "serverRequest/resolved" => {
                        let rid = p["requestId"].to_string();
                        srv.approvals.lock().unwrap().remove(&rid);
                        emit(&app2, "codex", &thread, Event::Resolved { request_id: rid });
                    }
                    "item/agentMessage/delta" => {
                        let text = p["delta"].as_str().unwrap_or_default().to_string();
                        emit(
                            &app2,
                            "codex",
                            &thread,
                            Event::Delta {
                                text,
                                item_id: p["itemId"].as_str().map(String::from),
                            },
                        );
                    }
                    "item/started" => {
                        let it = &p["item"];
                        let tool = match it["type"].as_str() {
                            Some("commandExecution") => Some((
                                "Comando".to_string(),
                                it["command"].as_str().unwrap_or_default().to_string(),
                            )),
                            Some("fileChange") => {
                                Some(("Editar arquivos".to_string(), String::new()))
                            }
                            Some("mcpToolCall") => Some((
                                it["tool"].as_str().unwrap_or("tool").to_string(),
                                it["server"].as_str().unwrap_or_default().to_string(),
                            )),
                            Some("webSearch") => Some(("Busca na web".to_string(), String::new())),
                            _ => None,
                        };
                        if let Some((name, detail)) = tool {
                            emit(
                                &app2,
                                "codex",
                                &thread,
                                Event::Tool {
                                    name,
                                    title: String::new(),
                                    detail: detail.chars().take(240).collect(),
                                },
                            );
                        }
                    }
                    "turn/started" => {
                        emit(&app2, "codex", &thread, Event::Started {});
                        if let Some(turn) = p["turn"]["id"].as_str() {
                            srv.turns
                                .lock()
                                .unwrap()
                                .insert(thread.clone(), turn.to_string());
                        }
                    }
                    "turn/completed" => {
                        srv.turns.lock().unwrap().remove(&thread);
                        srv.approvals
                            .lock()
                            .unwrap()
                            .retain(|_, (_, t, _, _)| t != &thread);
                        let t = &p["turn"];
                        let error = (t["status"] == "failed").then(|| {
                            t["error"]["message"]
                                .as_str()
                                .unwrap_or("o turno falhou")
                                .to_string()
                        });
                        emit(&app2, "codex", &thread, Event::Done { error });
                    }
                    _ => {}
                },
                _ => {}
            }
        }
        for (_, tx) in srv.waiting.lock().unwrap().drain() {
            let _ = tx.send(Err("O processo Codex foi encerrado".into()));
        }
        let ids: Vec<_> = srv
            .turns
            .lock()
            .unwrap()
            .drain()
            .map(|(id, _)| id)
            .collect();
        for id in ids {
            emit(
                &app2,
                "codex",
                &id,
                Event::Done {
                    error: Some("Conexão com Codex encerrada. Você pode tentar novamente.".into()),
                },
            );
        }
        srv.approvals.lock().unwrap().clear();
        let live = app2.state::<Live>();
        let mut slot = live.codex.lock().unwrap();
        if slot.as_ref().is_some_and(|s| Arc::ptr_eq(s, &srv)) {
            *slot = None;
        }
    });

    server.request("initialize", json!({"clientInfo": {"name": "lume", "title": "Lume", "version": env!("CARGO_PKG_VERSION")}, "capabilities": null}))?;
    write_line(
        &server.stdin,
        &json!({"jsonrpc": "2.0", "method": "initialized"}),
    )?;
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
pub fn codex_request(
    app: &AppHandle,
    live: &Live,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    codex_server(app, live)?.request(method, params)
}

fn codex_send(
    app: &AppHandle,
    live: &Live,
    store: &Store,
    id: &str,
    text: &str,
    images: &[ImageIn],
    options: &TurnOptions,
) -> Result<(), String> {
    let s = find(store, "codex", id)?;
    let server = codex_server(app, live)?;
    if !server.resumed.lock().unwrap().contains(id) {
        busy_elsewhere(&s)?; // só checa quando o Lume ainda não é dono da thread
        server.request("thread/resume", json!({"threadId": id}))?; // mantém modelo/sandbox/aprovação da própria thread
        server.resumed.lock().unwrap().insert(id.to_string());
    }
    if server.turns.lock().unwrap().contains_key(id) {
        return Err("Esta conversa já está executando no Lume".into());
    }
    busy_elsewhere(&s)?;
    emit(app, "codex", id, Event::Started {});
    if let Err(error) = server.request("turn/start", turn_params(id, text, images, options)?) {
        emit(
            app,
            "codex",
            id,
            Event::Done {
                error: Some(error.clone()),
            },
        );
        return Err(error);
    }
    Ok(())
}

fn codex_new(
    app: &AppHandle,
    live: &Live,
    store: &Store,
    project: &str,
    text: &str,
    images: &[ImageIn],
    options: &TurnOptions,
) -> Result<Session, String> {
    let server = codex_server(app, live)?;
    // sem modelo/sandbox/aprovação: vale o que está no config.toml do Codex
    let r = server.request("thread/start", json!({"cwd": project}))?;
    let id = r["thread"]["id"]
        .as_str()
        .ok_or("o Codex não devolveu a conversa nova")?
        .to_string();
    server.resumed.lock().unwrap().insert(id.clone());
    let s = Session::created("codex", id.clone(), project.to_string(), text);
    remember(store, s.clone());
    emit(app, "codex", &id, Event::Started {});
    if let Err(error) = server.request("turn/start", turn_params(&id, text, images, options)?) {
        emit(
            app,
            "codex",
            &id,
            Event::Done {
                error: Some(error.clone()),
            },
        );
        return Err(error);
    }
    Ok(s)
}

fn save_temp_image(img: &ImageIn, i: usize) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&img.data)
        .map_err(|e| e.to_string())?;
    let ext = img.media_type.rsplit('/').next().unwrap_or("png");
    let dir = std::env::temp_dir().join("lume-images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let path = dir.join(format!("{stamp}-{i}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn codex_answer(live: &Live, thread_id: &str, request_id: &str, allow: bool) -> Result<(), String> {
    let server = live
        .codex
        .lock()
        .unwrap()
        .clone()
        .ok_or("o Codex não está mais ativo")?;
    let (id, thread, _, _) = server
        .approvals
        .lock()
        .unwrap()
        .get(request_id)
        .cloned()
        .ok_or("aprovação já respondida")?;
    let decision = if allow { "accept" } else { "decline" };
    if thread != thread_id {
        return Err("Aprovação pertence a outra conversa".into());
    }
    write_line(
        &server.stdin,
        &json!({"jsonrpc": "2.0", "id": id, "result": {"decision": decision}}),
    )?;
    server.approvals.lock().unwrap().remove(request_id);
    Ok(())
}

// ---------- Antigravity ----------

pub fn antigravity_bin() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default());
    let exe = home
        .join("AppData")
        .join("Local")
        .join("Programs")
        .join("Antigravity")
        .join("resources")
        .join("bin")
        .join("language_server.exe");
    if exe.exists() {
        return Some(exe);
    }
    let bat = home
        .join(".gemini")
        .join("antigravity")
        .join("bin")
        .join("agentapi.bat");
    if bat.exists() {
        return Some(bat);
    }
    None
}

fn run_agentapi(subcmd: &str, args: &[&str], cwd: Option<&str>) -> Result<Value, String> {
    let bin = antigravity_bin().ok_or_else(|| "não achei o executável do Antigravity".to_string())?;

    // Se as variáveis de ambiente já estiverem definidas no processo pai, usa-as diretamente:
    let env_addr = std::env::var("ANTIGRAVITY_LS_ADDRESS").ok();
    let env_token = std::env::var("ANTIGRAVITY_CSRF_TOKEN").ok();

    let candidate_addrs: Vec<(String, String)> = match (env_addr, env_token) {
        (Some(a), Some(t)) if !a.is_empty() && !t.is_empty() => vec![(a, t)],
        _ => {
            // Descobre o language_server ativo e as portas em que ele escuta
            let (token, ports) = crate::usage::antigravity_server()
                .map_err(|e| format!("certifique-se de que o Antigravity está aberto: {e}"))?;
            ports.into_iter().map(|p| (format!("localhost:{p}"), token.clone())).collect()
        }
    };

    if candidate_addrs.is_empty() {
        return Err("nenhuma porta do Antigravity encontrada; certifique-se de que o app Antigravity está aberto".into());
    }

    let home = PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default());
    let app_data = home.join(".gemini").join("antigravity");

    let mut last_err = String::new();

    for (addr, token) in candidate_addrs {
        let mut cmd = if bin.extension().and_then(|e| e.to_str()) == Some("bat") {
            let mut c = Command::new("cmd");
            c.args(["/c", &bin.to_string_lossy(), subcmd]);
            c
        } else {
            let mut c = Command::new(&bin);
            c.args(["agentapi", subcmd]);
            c
        };

        cmd.args(args);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cmd.env("ANTIGRAVITY_LS_ADDRESS", &addr);
        cmd.env("ANTIGRAVITY_CSRF_TOKEN", &token);
        cmd.env("ANTIGRAVITY_APP_DATA_DIR", &app_data);

        hidden(&mut cmd);
        let out = match cmd.output() {
            Ok(o) => o,
            Err(e) => {
                last_err = format!("erro ao executar agentapi: {e}");
                continue;
            }
        };

        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);

        if !out.status.success() {
            last_err = format!("Antigravity falhou: {stdout} {stderr}").trim().to_string();
            if stdout.contains("connection error") || stderr.contains("connection error") || stdout.contains("refused") {
                continue;
            }
            return Err(last_err);
        }

        if let Ok(v) = serde_json::from_str::<Value>(&stdout) {
            if v.get("error").is_some() && v["error"] != Value::Null && !v["error"].as_str().unwrap_or_default().is_empty() {
                last_err = format!("Antigravity falhou: {stdout}");
                continue;
            }
            return Ok(v);
        } else {
            return Err(format!("resposta inválida do Antigravity: {stdout}"));
        }
    }

    Err(last_err)
}

fn watch_antigravity_turn(app: AppHandle, id: String, log_file: Option<PathBuf>) {
    std::thread::spawn(move || {
        let home = PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default());
        let path = match log_file {
            Some(p) => p,
            None => {
                let p = home
                    .join(".gemini")
                    .join("antigravity")
                    .join("brain")
                    .join(&id)
                    .join(".system_generated")
                    .join("logs")
                    .join("transcript.jsonl");
                let mut found = None;
                for _ in 0..40 {
                    if p.exists() {
                        found = Some(p.clone());
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                match found {
                    Some(f) => f,
                    None => {
                        emit(&app, "antigravity", &id, Event::Done { error: None });
                        return;
                    }
                }
            }
        };

        let Ok(file) = File::open(&path) else {
            emit(&app, "antigravity", &id, Event::Done { error: None });
            return;
        };

        let mut reader = BufReader::new(file);
        let mut pos = reader.seek(SeekFrom::End(0)).unwrap_or(0);
        pos = pos.saturating_sub(4096);
        let _ = reader.seek(SeekFrom::Start(pos));

        let start_time = std::time::Instant::now();
        let mut last_activity = std::time::Instant::now();
        let mut turn_done = false;
        let mut line_buf = Vec::new();

        while start_time.elapsed() < Duration::from_secs(600) {
            std::thread::sleep(Duration::from_millis(300));
            line_buf.clear();
            while let Ok(n) = reader.read_until(b'\n', &mut line_buf) {
                if n == 0 {
                    break;
                }
                last_activity = std::time::Instant::now();
                if let Ok(v) = serde_json::from_slice::<Value>(&line_buf) {
                    let typ = v["type"].as_str().unwrap_or_default();
                    if typ == "PLANNER_RESPONSE" {
                        if let Some(tcs) = v["tool_calls"].as_array() {
                            for tc in tcs {
                                let name = tc["name"].as_str().unwrap_or("tool").to_string();
                                let title = tc["args"]["toolSummary"]
                                    .as_str()
                                    .or_else(|| tc["args"]["toolAction"].as_str())
                                    .unwrap_or(&name)
                                    .to_string();
                                let detail = tc["args"]["CommandLine"]
                                    .as_str()
                                    .or_else(|| tc["args"]["TargetFile"].as_str())
                                    .or_else(|| tc["args"]["AbsolutePath"].as_str())
                                    .unwrap_or("")
                                    .chars()
                                    .take(200)
                                    .collect();
                                emit(&app, "antigravity", &id, Event::Tool { name, title, detail });
                            }
                        }
                        if let Some(c) = v["content"].as_str() {
                            if !c.is_empty() {
                                emit(&app, "antigravity", &id, Event::Delta { text: c.to_string(), item_id: None });
                                if v["status"] == "DONE" {
                                    turn_done = true;
                                }
                            }
                        }
                    }
                }
                line_buf.clear();
            }

            if turn_done || (last_activity.elapsed() > Duration::from_secs(5) && start_time.elapsed() > Duration::from_secs(4)) {
                if let Ok(meta) = fs::metadata(&path) {
                    if let Ok(mod_time) = meta.modified() {
                        if let Ok(d) = SystemTime::now().duration_since(mod_time) {
                            if d.as_secs() >= 3 {
                                emit(&app, "antigravity", &id, Event::Done { error: None });
                                return;
                            }
                        }
                    }
                }
            }
        }
        emit(&app, "antigravity", &id, Event::Done { error: None });
    });
}

fn save_antigravity_images(id: &str, images: &[ImageIn]) -> Vec<PathBuf> {
    if images.is_empty() {
        return vec![];
    }
    let home = PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default());
    let upload_dir = home
        .join(".gemini")
        .join("antigravity")
        .join("brain")
        .join(id)
        .join(".user_uploaded");
    let _ = fs::create_dir_all(&upload_dir);

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let mut saved = vec![];
    for (i, img) in images.iter().enumerate() {
        let ext = match img.media_type.as_str() {
            "image/jpeg" | "image/jpg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => "png",
        };
        let file_name = format!("media_{now}_{i}.{ext}");
        let path = upload_dir.join(&file_name);
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&img.data) {
            if fs::write(&path, bytes).is_ok() {
                saved.push(path);
            }
        }
    }
    saved
}

fn antigravity_send(
    app: &AppHandle,
    _live: &Live,
    store: &Store,
    id: &str,
    text: &str,
    images: &[ImageIn],
) -> Result<(), String> {
    let s = find(store, "antigravity", id)?;
    busy_elsewhere(&s)?;
    emit(app, "antigravity", id, Event::Started {});

    let saved_images = save_antigravity_images(id, images);
    let mut full_text = text.to_string();
    if !saved_images.is_empty() {
        full_text.push_str("\n\n<ADDITIONAL_METADATA>\nThe user has uploaded image(s):\n");
        for img in &saved_images {
            full_text.push_str(&format!("- {}\n", img.to_string_lossy().replace('\\', "/")));
        }
        full_text.push_str("</ADDITIONAL_METADATA>");
    }

    run_agentapi("send-message", &[id, &full_text], Some(&s.project))?;
    watch_antigravity_turn(app.clone(), id.to_string(), s.file);
    Ok(())
}

fn antigravity_new(
    app: &AppHandle,
    _live: &Live,
    store: &Store,
    project: &str,
    text: &str,
    images: &[ImageIn],
    options: &TurnOptions,
) -> Result<Session, String> {
    let title: String = text.lines().next().unwrap_or("Nova conversa").chars().take(80).collect();
    let title_arg = format!("--title={title}");
    let mut args = vec![title_arg.as_str()];
    let model_arg;
    if let Some(m) = &options.model {
        if !m.is_empty() {
            model_arg = format!("--model={m}");
            args.push(model_arg.as_str());
        }
    }
    args.push(text);
    let resp = run_agentapi("new-conversation", &args, Some(project))?;
    let new_id = resp["response"]["newConversation"]["conversationId"]
        .as_str()
        .ok_or_else(|| "o Antigravity não devolveu o ID da nova conversa".to_string())?
        .to_string();

    let _saved_images = save_antigravity_images(&new_id, images);

    let home = PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default());
    let log_file = home
        .join(".gemini")
        .join("antigravity")
        .join("brain")
        .join(&new_id)
        .join(".system_generated")
        .join("logs")
        .join("transcript.jsonl");
    let mut s = Session::created("antigravity", new_id.clone(), project.to_string(), text);
    s.file = Some(log_file.clone());
    remember(store, s.clone());
    emit(app, "antigravity", &new_id, Event::Started {});
    watch_antigravity_turn(app.clone(), new_id, Some(log_file));
    Ok(s)
}

fn interrupt(live: &Live, provider: &str, id: &str) -> Result<(), String> {
    match provider {
        "claude" => {
            let procs = live.claude.lock().unwrap();
            let p = procs.get(id).ok_or("a sessão não está respondendo")?;
            let rid = format!(
                "lume-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            );
            write_line(
                &p.stdin,
                &json!({"type": "control_request", "request_id": rid, "request": {"subtype": "interrupt"}}),
            )
        }
        "codex" => {
            let server = live
                .codex
                .lock()
                .unwrap()
                .clone()
                .ok_or("o Codex não está ativo")?;
            let turn = server
                .turns
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or("nenhum turno em andamento")?;
            server
                .request("turn/interrupt", json!({"threadId": id, "turnId": turn}))
                .map(|_| ())
        }
        "antigravity" => crate::usage::antigravity_cancel(id),
        _ => Err("provider inválido".into()),
    }
}

// ---------- comandos ----------

#[tauri::command]
pub async fn live_send(
    app: AppHandle,
    provider: String,
    id: String,
    text: String,
    images: Vec<ImageIn>,
    options: Option<TurnOptions>,
) -> Result<(), String> {
    if text.trim().is_empty() && images.is_empty() {
        return Err("mensagem vazia".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let live = app.state::<Live>();
        let store = app.state::<Store>();
        let result = match provider.as_str() {
            "claude" => claude_send(&app, &live, &store, &id, &text, &images, &options.unwrap_or_default()),
            "codex" => codex_send(
                &app,
                &live,
                &store,
                &id,
                &text,
                &images,
                &options.unwrap_or_default(),
            ),
            "antigravity" => antigravity_send(&app, &live, &store, &id, &text, &images),
            _ => Err("provider inválido".into()),
        };
        if let Err(error) = &result {
            emit(
                &app,
                match provider.as_str() {
                    "claude" => "claude",
                    "codex" => "codex",
                    _ => "antigravity",
                },
                &id,
                Event::Done {
                    error: Some(error.clone()),
                },
            );
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Conversa nova direto no Lume, na pasta do projeto. Devolve a sessão criada.
#[tauri::command]
pub async fn live_new(
    app: AppHandle,
    provider: String,
    project: String,
    text: String,
    images: Vec<ImageIn>,
    options: Option<TurnOptions>,
) -> Result<Session, String> {
    if text.trim().is_empty() && images.is_empty() {
        return Err("mensagem vazia".into());
    }
    if !Path::new(&project).is_dir() {
        return Err(format!("pasta não existe: {project}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let live = app.state::<Live>();
        let store = app.state::<Store>();
        match provider.as_str() {
            "claude" => claude_new(&app, &live, &store, &project, &text, &images, &options.unwrap_or_default()),
            "codex" => codex_new(
                &app,
                &live,
                &store,
                &project,
                &text,
                &images,
                &options.unwrap_or_default(),
            ),
            "antigravity" => antigravity_new(
                &app,
                &live,
                &store,
                &project,
                &text,
                &images,
                &options.unwrap_or_default(),
            ),
            _ => Err("provider inválido".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn live_answer(
    app: AppHandle,
    live: State<'_, Live>,
    provider: String,
    id: String,
    request_id: String,
    allow: bool,
) -> Result<(), String> {
    let result = match provider.as_str() {
        "claude" => claude_answer(&live, &id, &request_id, allow),
        "codex" => codex_answer(&live, &id, &request_id, allow),
        _ => Err("provider inválido".into()),
    };
    if result.is_ok() {
        emit(
            &app,
            if provider == "codex" {
                "codex"
            } else {
                "claude"
            },
            &id,
            Event::Resolved { request_id },
        );
    }
    result
}

#[tauri::command]
pub async fn live_interrupt(app: AppHandle, provider: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || interrupt(&app.state::<Live>(), &provider, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn live_respond(
    app: AppHandle,
    id: String,
    request_id: String,
    response: Value,
) -> Result<(), String> {
    let live = app.state::<Live>();
    let server = live
        .codex
        .lock()
        .unwrap()
        .clone()
        .ok_or("Codex desconectado")?;
    let pending = server
        .approvals
        .lock()
        .unwrap()
        .get(&request_id)
        .cloned()
        .ok_or("Pedido já respondido")?;
    if pending.1 != id {
        return Err("Pedido pertence a outra conversa".into());
    }
    let result = match pending.2.as_str() {
        "item/permissions/requestApproval" => {
            json!({"permissions":if response["allow"]==true {pending.3["permissions"].clone()} else {json!({})},"scope":"turn"})
        }
        "item/tool/requestUserInput" | "tool/requestUserInput" => {
            if !response["answers"].is_object() {
                return Err("Respostas inválidas".into());
            }
            response
        }
        "mcpServer/elicitation/request" => {
            if !["accept", "decline", "cancel"]
                .contains(&response["action"].as_str().unwrap_or_default())
            {
                return Err("Resposta inválida".into());
            }
            response
        }
        _ => return Err("Tipo de pedido inválido".into()),
    };
    write_line(
        &server.stdin,
        &json!({"jsonrpc":"2.0","id":pending.0,"result":result}),
    )?;
    server.approvals.lock().unwrap().remove(&request_id);
    emit(&app, "codex", &id, Event::Resolved { request_id });
    Ok(())
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
