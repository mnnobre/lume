//! Sessões do Claude Code, Codex e Antigravity lidas dos arquivos locais de cada ferramenta.
//! O Lume não tem harness: abre no app do provider (deep link) ou conversa pela CLI dele (live.rs).
//! Formatos e rotas validados na POC (poc/gerenciador.py).
//! Todos os comandos são async: comando síncrono no Tauri roda na thread da janela e a congela.
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

const BUSY_SECS: u64 = 120;

#[derive(Clone, Serialize)]
pub struct Session {
    pub provider: &'static str,
    pub id: String,
    pub project: String,
    title: String,
    updated: i64, // ms desde epoch
    #[serde(skip)]
    pub file: Option<PathBuf>,
}

/// role: user | assistant | tool. Em "tool": `text` = nome, `title` = o que o agente disse que ia fazer
/// (ex.: description do Bash), `detail` = resumo, `input`/`output` = o que abre ao expandir.
#[derive(Clone, Serialize, PartialEq, Default)]
pub struct Message {
    role: &'static str,
    text: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    detail: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    input: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    output: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    failed: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    images: Vec<String>, // data URLs
}

#[derive(Serialize)]
pub struct Transcript {
    messages: Option<Vec<Message>>, // None = provider não deixa ler (Antigravity)
}

#[derive(Default)]
pub struct Store {
    sessions: Mutex<HashMap<(String, String), Session>>,
    transcripts: Mutex<HashMap<PathBuf, ((u64, u64), Vec<Message>)>>, // arquivo -> ((mtime, tamanho), msgs)
}

// ---------- utilidades ----------

fn home() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
}

pub fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Mesma pasta = mesmo projeto, em qualquer provider (file:///c%3A/..., \\?\C:\..., worktrees do Claude).
pub fn norm_path(p: &str) -> String {
    let mut p = percent_decode(p);
    if let Some(rest) = p.strip_prefix("file:///") {
        p = rest.to_string();
    }
    p = p.replace('/', "\\");
    if let Some(rest) = p.strip_prefix(r"\\?\") {
        p = rest.to_string();
    }
    let p = p.trim_end_matches('\\');
    let lower = p.to_lowercase();
    let p = match lower.find(r"\.claude\worktrees\") {
        Some(i) => &p[..i], // worktree conta como o projeto
        None => p,
    };
    let mut p = p.to_string();
    if p.len() == 2 && p.ends_with(':') {
        p.push('\\');
    }
    let mut c = p.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => p,
    }
}

fn mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter(|c| c["type"].as_str().is_some_and(|t| t.eq_ignore_ascii_case("text")))
            .filter_map(|c| c["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn sqlite_ro(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
}

// ---------- leitura das sessões ----------

fn claude_sessions() -> Vec<Session> {
    let mut out = vec![];
    let Ok(dirs) = fs::read_dir(home().join(".claude").join("projects")) else { return out };
    for dir in dirs.flatten() {
        let Ok(files) = fs::read_dir(dir.path()) else { continue };
        for f in files.flatten().map(|e| e.path()) {
            if f.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(file) = File::open(&f) else { continue };
            let (mut cwd, mut first_prompt, mut title) = (None::<String>, None::<String>, None::<String>);
            // cabeça: cwd + primeiro prompt
            for line in BufReader::new(&file).lines().take(300).map_while(Result::ok) {
                let Ok(o) = serde_json::from_str::<Value>(&line) else { continue };
                if cwd.is_none() {
                    cwd = o["cwd"].as_str().map(String::from);
                }
                if first_prompt.is_none() && o["type"] == "user" && o["isMeta"] != true {
                    let t = text_of(&o["message"]["content"]);
                    if !t.is_empty() && !t.starts_with('<') {
                        first_prompt = Some(t);
                    }
                }
                if cwd.is_some() && first_prompt.is_some() {
                    break;
                }
            }
            // cauda: título mais recente, sem ler arquivos de centenas de MB inteiros
            let mut fh = &file;
            let len = fh.metadata().map(|m| m.len()).unwrap_or(0);
            let mut buf = vec![];
            if fh.seek(SeekFrom::Start(len.saturating_sub(256 * 1024))).is_ok() && fh.read_to_end(&mut buf).is_ok() {
                for line in buf.split(|&b| b == b'\n') {
                    if !(contains(line, b"title") || contains(line, b"\"summary\"")) {
                        continue;
                    }
                    if let Ok(o) = serde_json::from_slice::<Value>(line) {
                        for k in ["customTitle", "aiTitle", "summary"] {
                            if let Some(t) = o[k].as_str() {
                                title = Some(t.to_string());
                                break;
                            }
                        }
                    }
                }
            }
            let Some(title) = title.or(first_prompt) else { continue };
            out.push(Session {
                provider: "claude",
                id: f.file_stem().unwrap().to_string_lossy().into_owned(),
                project: cwd.map(|c| norm_path(&c)).unwrap_or_else(|| dir.file_name().to_string_lossy().into_owned()),
                title,
                updated: mtime_ms(&f),
                file: Some(f),
            });
        }
    }
    out
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn codex_sessions() -> rusqlite::Result<Vec<Session>> {
    let db = home().join(".codex").join("state_5.sqlite");
    if !db.exists() {
        return Ok(vec![]);
    }
    let c = sqlite_ro(&db)?;
    let mut q = c.prepare(
        "select id, cwd, coalesce(nullif(name,''), nullif(title,''), first_user_message), updated_at, rollout_path \
         from threads where archived = 0",
    )?;
    let rows = q.query_map([], |r| {
        Ok(Session {
            provider: "codex",
            id: r.get(0)?,
            project: norm_path(&r.get::<_, String>(1)?),
            title: r.get::<_, Option<String>>(2)?.unwrap_or_else(|| "(sem título)".into()),
            updated: r.get::<_, i64>(3)? * 1000,
            file: r.get::<_, Option<String>>(4)?.map(|p| PathBuf::from(norm_path(&p))),
        })
    })?;
    Ok(rows.flatten().collect())
}

fn antigravity_sessions() -> rusqlite::Result<Vec<Session>> {
    let db = home().join(".gemini").join("antigravity").join("conversation_summaries.db");
    if !db.exists() {
        return Ok(vec![]);
    }
    let c = sqlite_ro(&db)?;
    let mut q = c.prepare(
        "select conversation_id, coalesce(nullif(title,''), preview), workspace_uris, last_modified_time \
         from conversation_summaries where killed = 0",
    )?;
    let rows = q.query_map([], |r| {
        let uris: Vec<String> = serde_json::from_str(&r.get::<_, Option<String>>(2)?.unwrap_or_default()).unwrap_or_default();
        let upd: String = r.get::<_, Option<String>>(3)?.unwrap_or_default();
        Ok(Session {
            provider: "antigravity",
            id: r.get(0)?,
            project: uris.first().map(|u| norm_path(u)).unwrap_or_else(|| "(sem projeto)".into()),
            title: r.get::<_, Option<String>>(1)?.unwrap_or_else(|| "(sem título)".into()),
            // "2026-08-24 21:58:20.7958313+00:00" — fração de 7 dígitos
            updated: chrono::DateTime::parse_from_str(&upd, "%Y-%m-%d %H:%M:%S%.f%:z")
                .map(|d| d.timestamp_millis())
                .unwrap_or(0),
            file: None,
        })
    })?;
    Ok(rows.flatten().collect())
}

#[tauri::command]
pub async fn list_sessions(store: State<'_, Store>) -> Result<Vec<Session>, String> {
    let mut all = claude_sessions();
    // um provider quebrado (ex.: formato mudou numa atualização) não derruba os outros
    match codex_sessions() {
        Ok(s) => all.extend(s),
        Err(e) => eprintln!("[codex] {e}"),
    }
    match antigravity_sessions() {
        Ok(s) => all.extend(s),
        Err(e) => eprintln!("[antigravity] {e}"),
    }
    let mut map = store.sessions.lock().unwrap();
    *map = all.iter().map(|s| ((s.provider.to_string(), s.id.clone()), s.clone())).collect();
    Ok(all)
}

pub fn find(store: &Store, provider: &str, id: &str) -> Result<Session, String> {
    store
        .sessions
        .lock()
        .unwrap()
        .get(&(provider.to_string(), id.to_string()))
        .cloned()
        .ok_or_else(|| "sessão desconhecida; recarregue a lista".into())
}

// ---------- conversa ----------

const CLAUDE_NEEDLES: &[&[u8]] = &[b"\"type\":\"user\"", b"\"type\":\"assistant\""];
const CODEX_NEEDLES: &[&[u8]] = &[
    b"\"UserMessage\"", b"\"AgentMessage\"", b"\"CommandExecution\"", b"\"FileChange\"", b"\"Extension\"",
    b"\"user_message\"", b"\"agent_message\"",
];
const OUTPUT_MAX: usize = 8000; // ponytail: saída de ferramenta cortada; o arquivo da sessão tem a íntegra

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "\n…"
}

fn pretty(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        _ => serde_json::to_string_pretty(v).unwrap_or_default(),
    }
}

struct Thread {
    out: Vec<Message>,
    tools: HashMap<String, usize>, // id da chamada -> posição, para ligar a saída
}

impl Thread {
    fn push(&mut self, m: Message) {
        if (!m.text.trim().is_empty() || !m.images.is_empty()) && self.out.last() != Some(&m) {
            self.out.push(m);
        }
    }
    fn msg(&mut self, role: &'static str, text: String, images: Vec<String>) {
        self.push(Message { role, text, images, ..Default::default() });
    }
    fn tool(&mut self, call_id: Option<&str>, m: Message) {
        self.out.push(Message { role: "tool", ..m });
        if let Some(id) = call_id {
            self.tools.insert(id.to_string(), self.out.len() - 1);
        }
    }
}

fn read_messages(s: &Session, path: &Path) -> std::io::Result<Vec<Message>> {
    let needles = if s.provider == "claude" { CLAUDE_NEEDLES } else { CODEX_NEEDLES };
    let mut t = Thread { out: vec![], tools: HashMap::new() };
    let mut reader = BufReader::new(File::open(path)?);
    let mut line = vec![];
    while reader.read_until(b'\n', &mut line)? > 0 {
        // só decodifica linhas que podem ser mensagem
        if needles.iter().any(|n| contains(&line, n)) {
            if let Ok(o) = serde_json::from_slice::<Value>(&line) {
                if s.provider == "claude" {
                    claude_line(&mut t, &o);
                } else {
                    codex_line(&mut t, &o);
                }
            }
        }
        line.clear();
    }
    let skip = t.out.len().saturating_sub(400); // ponytail: só as últimas 400 entradas na tela
    Ok(t.out.split_off(skip))
}

fn claude_line(t: &mut Thread, o: &Value) {
    let content = &o["message"]["content"];
    if o["type"] == "user" && o["isMeta"] != true {
        // saída de ferramenta volta numa mensagem "user" com tool_result
        for c in content.as_array().into_iter().flatten().filter(|c| c["type"] == "tool_result") {
            if let Some(&i) = c["tool_use_id"].as_str().and_then(|id| t.tools.get(id)) {
                t.out[i].output = clip(&text_of(&c["content"]), OUTPUT_MAX);
                t.out[i].failed = c["is_error"] == true;
            }
        }
        let text = text_of(content);
        if !text.starts_with('<') {
            t.msg("user", text, claude_images(content));
        }
    } else if o["type"] == "assistant" {
        for c in content.as_array().into_iter().flatten() {
            match c["type"].as_str() {
                Some("text") => t.msg("assistant", c["text"].as_str().unwrap_or_default().into(), vec![]),
                Some("tool_use") => {
                    let input = &c["input"];
                    let m = Message {
                        text: c["name"].as_str().unwrap_or("tool").into(),
                        title: input["description"].as_str().unwrap_or_default().into(),
                        detail: crate::live::tool_detail(input),
                        input: clip(&input["command"].as_str().map(String::from).unwrap_or_else(|| pretty(input)), OUTPUT_MAX),
                        ..Default::default()
                    };
                    t.tool(c["id"].as_str(), m);
                }
                _ => {}
            }
        }
    }
}

fn codex_line(t: &mut Thread, o: &Value) {
    // formato novo (item_completed) e antigo (user_message/agent_message)
    let p = &o["payload"];
    let it = &p["item"];
    let has_item = it.is_object();
    match (it["type"].as_str(), p["type"].as_str()) {
        (Some("UserMessage"), _) => t.msg("user", text_of(&it["content"]), codex_images(&it["content"])),
        (_, Some("user_message")) if !has_item => {
            t.msg("user", p["message"].as_str().unwrap_or_default().into(), codex_images(&p["images"]))
        }
        (Some("AgentMessage"), _) => t.msg("assistant", text_of(&it["content"]), vec![]),
        (_, Some("agent_message")) if !has_item => t.msg("assistant", p["message"].as_str().unwrap_or_default().into(), vec![]),
        (Some("CommandExecution"), _) => {
            // parsed_cmd tem o comando limpo; command é o argv completo (powershell.exe -Command ...)
            let cmd = it["parsed_cmd"][0]["cmd"]
                .as_str()
                .or_else(|| it["command"].as_array().and_then(|a| a.last()).and_then(|v| v.as_str()))
                .unwrap_or_default();
            let exit = it["exit_code"].as_i64().unwrap_or(0);
            t.tool(None, Message {
                text: "Comando".into(),
                detail: cmd.chars().take(240).collect(),
                input: clip(cmd, OUTPUT_MAX),
                output: clip(it["aggregated_output"].as_str().unwrap_or_default(), OUTPUT_MAX),
                failed: exit != 0 || it["status"] == "failed",
                ..Default::default()
            });
        }
        (Some("FileChange"), _) => {
            let changes = it["changes"].as_object();
            let files: Vec<&String> = changes.map(|c| c.keys().collect()).unwrap_or_default();
            let diffs = changes
                .map(|c| c.iter().map(|(f, d)| format!("{f}\n{}", d["unified_diff"].as_str().unwrap_or_default())).collect::<Vec<_>>().join("\n\n"))
                .unwrap_or_default();
            t.tool(None, Message {
                text: "Editar arquivos".into(),
                detail: files.iter().map(|f| f.rsplit(['\\', '/']).next().unwrap_or(f)).collect::<Vec<_>>().join(", "),
                output: clip(&diffs, OUTPUT_MAX),
                failed: it["status"] == "failed",
                ..Default::default()
            });
        }
        (Some("Extension"), _) if it["kind"] == "web.search" => {
            t.tool(None, Message {
                text: "Busca na web".into(),
                detail: it["query"].as_str().unwrap_or_default().into(),
                ..Default::default()
            });
        }
        _ => {}
    }
}

fn data_url(media_type: &str, b64: &str) -> String {
    format!("data:{media_type};base64,{b64}")
}

fn claude_images(content: &Value) -> Vec<String> {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["type"] == "image" && c["source"]["type"] == "base64")
        .map(|c| data_url(c["source"]["media_type"].as_str().unwrap_or("image/png"), c["source"]["data"].as_str().unwrap_or_default()))
        .collect()
}

/// Codex guarda imagem como data URL ou como caminho local.
fn codex_images(content: &Value) -> Vec<String> {
    let mut out = vec![];
    for c in content.as_array().into_iter().flatten() {
        if let Some(url) = c["url"].as_str().or(c["image_url"].as_str()).or(c.as_str()) {
            if url.starts_with("data:") {
                out.push(url.to_string());
            }
        } else if let Some(path) = c["path"].as_str() {
            if let Ok(bytes) = fs::read(path) {
                let ext = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("png").to_lowercase();
                let mt = if ext == "jpg" { "image/jpeg".to_string() } else { format!("image/{ext}") };
                out.push(data_url(&mt, &base64::engine::general_purpose::STANDARD.encode(bytes)));
            }
        }
    }
    out
}

#[tauri::command]
pub async fn transcript(store: State<'_, Store>, provider: String, id: String) -> Result<Transcript, String> {
    let s = find(&store, &provider, &id)?;
    let Some(path) = s.file.clone() else {
        return Ok(Transcript { messages: None });
    };
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let stamp = (meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0), meta.len());
    // cache: o polling de 3 s não relê arquivos de 100 MB
    if let Some((st, msgs)) = store.transcripts.lock().unwrap().get(&path) {
        if *st == stamp {
            return Ok(Transcript { messages: Some(msgs.clone()) });
        }
    }
    let msgs = read_messages(&s, &path).map_err(|e| e.to_string())?;
    store.transcripts.lock().unwrap().insert(path, (stamp, msgs.clone()));
    Ok(Transcript { messages: Some(msgs) })
}

// ---------- trava de sessão em uso ----------

/// ponytail: heurística por mtime — arquivo mexido há < 2 min = o app está usando a sessão agora.
/// O app não expõe "sessão ativa" de forma confiável (sessão nova nem leva o id na linha de comando).
pub fn busy_elsewhere(s: &Session) -> Result<(), String> {
    if let Some(f) = &s.file {
        let age = fs::metadata(f).and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok());
        if age.is_some_and(|a| a.as_secs() < BUSY_SECS) {
            return Err("essa sessão está em uso no app agora (mexeu há menos de 2 min); mande por lá ou espere".into());
        }
    }
    Ok(())
}

// ---------- abrir no app do provider ----------

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn launch(app: &AppHandle, provider: &str, cwd: &str, session_id: Option<&str>) -> Result<(), String> {
    if !Path::new(cwd).is_dir() {
        return Err(format!("pasta não existe: {cwd}"));
    }
    // deep links lidos dos bundles dos apps; o app abre já logado
    let url = match (provider, session_id) {
        ("claude", Some(id)) => format!("claude://resume?session={}", enc(id)), // importa da CLI ou só abre
        ("claude", None) => format!("claude://code/new?folder={}", enc(cwd)),
        ("codex", Some(id)) => format!("codex://threads/{}", enc(id)),
        ("codex", None) => format!("codex://threads/new?path={}", enc(cwd)),
        ("antigravity", _) => {
            // ponytail: o app só tem deep link de import do AI Studio; abre o app e a conversa fica na lista dele
            let exe = home().join("AppData").join("Local").join("Programs").join("Antigravity").join("Antigravity.exe");
            Command::new(exe).spawn().map_err(|e| format!("não achei o Antigravity: {e}"))?;
            return Ok(());
        }
        _ => return Err("provider inválido".into()),
    };
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_session(app: AppHandle, store: State<'_, Store>, provider: String, id: String) -> Result<(), String> {
    let s = find(&store, &provider, &id)?;
    launch(&app, s.provider, &s.project, Some(&s.id))
}

#[tauri::command]
pub async fn new_session(app: AppHandle, store: State<'_, Store>, provider: String, project: String) -> Result<(), String> {
    // só em projeto que já tem sessão registrada
    if !store.sessions.lock().unwrap().values().any(|s| s.project == project) {
        return Err("projeto desconhecido".into());
    }
    launch(&app, &provider, &project, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_path_unifica_formatos() {
        assert_eq!(norm_path("file:///c%3A/Projetos/Jogos/GrandchaseV2"), r"C:\Projetos\Jogos\GrandchaseV2");
        assert_eq!(norm_path(r"\\?\C:\Projetos\FigmaLocalMCP"), r"C:\Projetos\FigmaLocalMCP");
        assert_eq!(norm_path(r"C:\Projetos\Frellas\G5Rating\.claude\worktrees\spec-1"), r"C:\Projetos\Frellas\G5Rating");
        assert_eq!(norm_path(r"c:\Users\mathe\"), r"C:\Users\mathe");
        assert_eq!(norm_path("d:/"), r"D:\");
    }
}

#[cfg(test)]
mod real_files {
    use super::*;

    /// Lê uma sessão real: LUME_SESSION=<provider>:<arquivo> cargo test -- --ignored --nocapture
    #[test]
    #[ignore]
    fn ferramentas_ligadas_a_saida() {
        let spec = std::env::var("LUME_SESSION").expect("LUME_SESSION=provider:arquivo");
        let (prov, file) = spec.split_once(':').unwrap();
        let provider = if prov == "claude" { "claude" } else { "codex" };
        let s = Session { provider, id: String::new(), project: String::new(), title: String::new(), updated: 0, file: None };
        let msgs = read_messages(&s, Path::new(file)).unwrap();
        let tools: Vec<_> = msgs.iter().filter(|m| m.role == "tool").collect();
        let with_output = tools.iter().filter(|m| !m.output.is_empty()).count();
        println!("{} mensagens, {} ferramentas, {} com saída", msgs.len(), tools.len(), with_output);
        for m in tools.iter().take(3) {
            println!("  [{}] título={:?} detalhe={:?} saída={:?}", m.text, m.title, m.detail.chars().take(60).collect::<String>(), m.output.chars().take(60).collect::<String>());
        }
        assert!(with_output > 0, "nenhuma ferramenta recebeu saída");
    }
}
