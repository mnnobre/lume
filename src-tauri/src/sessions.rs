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
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

const BUSY_SECS: u64 = 120;

#[derive(Clone, Serialize, Default)]
pub struct Session {
    pub provider: &'static str,
    pub id: String,
    pub project: String,
    pub title: String,
    pub updated: i64, // ms desde epoch
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
    #[serde(skip_serializing_if = "is_zero")]
    added: u32, // linhas adicionadas (edições)
    #[serde(skip_serializing_if = "is_zero")]
    removed: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    images: Vec<String>, // data URLs
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
}

#[derive(Serialize)]
pub struct Transcript {
    messages: Option<Vec<Message>>, // None = provider não deixa ler (Antigravity)
    updated: i64, // ms da última escrita no arquivo (mostra "em andamento no app")
    revision: String,
    active: bool,
    activity: String,
    has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>, // modelo da última resposta (Claude), para o seletor mostrar o nome real
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<(u64, u64)>, // janela de contexto: (tokens em uso, limite)
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

pub fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".codex"))
}

fn codex_db() -> Option<PathBuf> {
    fs::read_dir(codex_home())
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|n| n.starts_with("state_") && n.ends_with(".sqlite"))
        })
        .max_by_key(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.strip_prefix("state_"))
                .and_then(|n| n.parse::<u32>().ok())
                .unwrap_or(0)
        })
}

/// Resolve linked worktrees through Git metadata, keeping their actual cwd for execution.
pub fn project_root(cwd: &str) -> String {
    let path = PathBuf::from(cwd);
    if let Ok(git) = fs::read_to_string(path.join(".git")) {
        if let Some(dir) = git.trim().strip_prefix("gitdir: ") {
            let gitdir = path.join(dir);
            if let Ok(common) = fs::read_to_string(gitdir.join("commondir")) {
                if let Ok(common) = fs::canonicalize(gitdir.join(common.trim())) {
                    if let Some(root) = common.parent() {
                        return norm_path(&root.to_string_lossy());
                    }
                }
            }
        }
    }
    norm_path(cwd)
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
            .filter(|c| {
                c["type"]
                    .as_str()
                    .is_some_and(|t| t.eq_ignore_ascii_case("text"))
            })
            .filter_map(|c| c["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn sqlite_ro(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
}

// ---------- leitura das sessões ----------

fn claude_sessions() -> Vec<Session> {
    let mut out = vec![];
    let Ok(dirs) = fs::read_dir(home().join(".claude").join("projects")) else {
        return out;
    };
    for dir in dirs.flatten() {
        let Ok(files) = fs::read_dir(dir.path()) else {
            continue;
        };
        for f in files.flatten().map(|e| e.path()) {
            if f.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(file) = File::open(&f) else { continue };
            let (mut cwd, mut first_prompt, mut title) =
                (None::<String>, None::<String>, None::<String>);
            // cabeça: cwd + primeiro prompt
            for line in BufReader::new(&file)
                .lines()
                .take(300)
                .map_while(Result::ok)
            {
                let Ok(o) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
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
            if fh
                .seek(SeekFrom::Start(len.saturating_sub(256 * 1024)))
                .is_ok()
                && fh.read_to_end(&mut buf).is_ok()
            {
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
            let Some(title) = title.or(first_prompt) else {
                continue;
            };
            out.push(Session {
                provider: "claude",
                id: f.file_stem().unwrap().to_string_lossy().into_owned(),
                project: cwd
                    .map(|c| norm_path(&c))
                    .unwrap_or_else(|| dir.file_name().to_string_lossy().into_owned()),
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
    let Some(db) = codex_db() else {
        return Ok(vec![]);
    };
    let c = sqlite_ro(&db)?;
    let mut q = c.prepare(
        "select id, cwd, coalesce(nullif(name,''), nullif(title,''), first_user_message), updated_at, rollout_path \
         from threads where archived = 0 and source in ('cli', 'vscode', 'appServer')",
    )?;
    let rows = q.query_map([], |r| {
        Ok(Session {
            provider: "codex",
            id: r.get(0)?,
            project: norm_path(&r.get::<_, String>(1)?),
            title: r
                .get::<_, Option<String>>(2)?
                .unwrap_or_else(|| "(sem título)".into()),
            updated: r.get::<_, i64>(3)? * 1000,
            file: r
                .get::<_, Option<String>>(4)?
                .map(|p| PathBuf::from(norm_path(&p))),
        })
    })?;
    Ok(rows.flatten().collect())
}

fn antigravity_sessions() -> rusqlite::Result<Vec<Session>> {
    let db = home()
        .join(".gemini")
        .join("antigravity")
        .join("conversation_summaries.db");
    if !db.exists() {
        return Ok(vec![]);
    }
    let c = sqlite_ro(&db)?;
    let mut q = c.prepare(
        "select conversation_id, coalesce(nullif(title,''), preview), workspace_uris, last_modified_time \
         from conversation_summaries where killed = 0",
    )?;
    let rows = q.query_map([], |r| {
        let uris: Vec<String> =
            serde_json::from_str(&r.get::<_, Option<String>>(2)?.unwrap_or_default())
                .unwrap_or_default();
        let upd: String = r.get::<_, Option<String>>(3)?.unwrap_or_default();
        let id: String = r.get(0)?;
        let log_file = home()
            .join(".gemini")
            .join("antigravity")
            .join("brain")
            .join(&id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        let file = if log_file.exists() {
            Some(log_file)
        } else {
            None
        };
        Ok(Session {
            provider: "antigravity",
            id,
            project: uris
                .first()
                .map(|u| norm_path(u))
                .unwrap_or_else(|| "(sem projeto)".into()),
            title: r
                .get::<_, Option<String>>(1)?
                .unwrap_or_else(|| "(sem título)".into()),
            // "2026-08-24 21:58:20.7958313+00:00" — fração de 7 dígitos
            updated: chrono::DateTime::parse_from_str(&upd, "%Y-%m-%d %H:%M:%S%.f%:z")
                .map(|d| d.timestamp_millis())
                .unwrap_or(0),
            file,
        })
    })?;
    Ok(rows.flatten().collect())
}

#[tauri::command]
pub async fn list_sessions(app: AppHandle, archived: Option<bool>) -> Result<Vec<Session>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_sessions_sync(&app, archived.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn list_sessions_sync(app: &AppHandle, archived: bool) -> Result<Vec<Session>, String> {
    let store = app.state::<Store>();
    if archived {
        return crate::codex::list(app, true);
    }
    let mut all = claude_sessions();
    // um provider quebrado (ex.: formato mudou numa atualização) não derruba os outros
    match crate::codex::list(app, false).or_else(|error| {
        let _ = app.emit(
            "provider-error",
            format!("Codex: {error}. Leitura local de reserva."),
        );
        codex_sessions().map_err(|e| e.to_string())
    }) {
        Ok(s) => all.extend(s),
        Err(e) => eprintln!("[codex] {e}"),
    }
    match antigravity_sessions() {
        Ok(s) => all.extend(s),
        Err(e) => eprintln!("[antigravity] {e}"),
    }
    let mut map = store.sessions.lock().unwrap();
    // Keep a newly created thread until its first persisted rollout becomes visible.
    for s in map.values() {
        // (o Antigravity já nasce com o caminho do log, mas o arquivo só aparece depois)
        if s.file.as_ref().map_or(true, |f| !f.exists()) && !all.iter().any(|x| x.provider == s.provider && x.id == s.id) {
            all.push(s.clone());
        }
    }
    for s in &mut all {
        s.project = project_root(&s.project);
    }
    map.extend(
        all.iter()
            .map(|s| ((s.provider.to_string(), s.id.clone()), s.clone())),
    );
    Ok(all)
}

impl Session {
    /// Sessão recém-criada pelo Lume (o arquivo aparece depois do primeiro turno).
    pub fn created(
        provider: &'static str,
        id: String,
        project: String,
        first_message: &str,
    ) -> Session {
        let title: String = first_message
            .lines()
            .next()
            .unwrap_or("Nova conversa")
            .chars()
            .take(80)
            .collect();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Session {
            provider,
            id,
            project,
            title: if title.trim().is_empty() {
                "Nova conversa".into()
            } else {
                title
            },
            updated: now,
            file: None,
        }
    }
}

pub fn remember(store: &Store, s: Session) {
    store
        .sessions
        .lock()
        .unwrap()
        .insert((s.provider.to_string(), s.id.clone()), s);
}

/// Arquivo de uma sessão que ainda não estava na lista (criada agora pelo Lume).
fn locate(s: &Session) -> Option<PathBuf> {
    match s.provider {
        "claude" => fs::read_dir(home().join(".claude").join("projects"))
            .ok()?
            .flatten()
            .map(|d| d.path().join(format!("{}.jsonl", s.id)))
            .find(|p| p.exists()),
        "codex" => {
            let c = sqlite_ro(&codex_db()?).ok()?;
            let p: String = c
                .query_row(
                    "select rollout_path from threads where id = ?1",
                    [&s.id],
                    |r| r.get(0),
                )
                .ok()?;
            Some(PathBuf::from(norm_path(&p)))
        }
        "antigravity" => {
            let p = home()
                .join(".gemini")
                .join("antigravity")
                .join("brain")
                .join(&s.id)
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl");
            p.exists().then_some(p)
        }
        _ => None,
    }
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
    b"\"UserMessage\"",
    b"\"AgentMessage\"",
    b"\"CommandExecution\"",
    b"\"FileChange\"",
    b"\"Extension\"",
    b"\"user_message\"",
    b"\"agent_message\"",
    b"\"McpToolCall\"",
    b"\"ImageView\"",
    b"\"ContextCompaction\"",
    b"\"CollabAgentToolCall\"",
];
const ANTIGRAVITY_NEEDLES: &[&[u8]] = &[
    b"\"USER_INPUT\"",
    b"\"PLANNER_RESPONSE\"",
    b"\"SYSTEM_MESSAGE\"",
    b"\"GENERIC\"",
    b"\"tool_calls\"",
];
fn is_zero(n: &u32) -> bool {
    *n == 0
}

fn lines(s: Option<&str>) -> u32 {
    s.map(|s| s.lines().count() as u32).unwrap_or(0)
}

/// +/− de uma edição do Claude (Edit/MultiEdit/Write) a partir da entrada da ferramenta.
fn claude_diff(name: &str, input: &Value) -> (u32, u32) {
    match name {
        "Write" => (lines(input["content"].as_str()), 0),
        "Edit" => (
            lines(input["new_string"].as_str()),
            lines(input["old_string"].as_str()),
        ),
        "MultiEdit" => input["edits"]
            .as_array()
            .into_iter()
            .flatten()
            .fold((0, 0), |(a, r), e| {
                (
                    a + lines(e["new_string"].as_str()),
                    r + lines(e["old_string"].as_str()),
                )
            }),
        _ => (0, 0),
    }
}

/// +/− de um diff unificado (Codex), ignorando os cabeçalhos.
fn diff_counts(diff: &str) -> (u32, u32) {
    diff.lines().fold((0, 0), |(a, r), l| {
        if l.starts_with("+++") || l.starts_with("---") {
            (a, r)
        } else if l.starts_with('+') {
            (a + 1, r)
        } else if l.starts_with('-') {
            (a, r + 1)
        } else {
            (a, r)
        }
    })
}

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
        self.msg_with_time(role, text, images, None);
    }
    fn msg_with_time(&mut self, role: &'static str, text: String, images: Vec<String>, timestamp: Option<i64>) {
        self.push(Message {
            role,
            text,
            images,
            timestamp,
            ..Default::default()
        });
    }
    fn tool(&mut self, call_id: Option<&str>, m: Message) {
        self.out.push(Message { role: "tool", ..m });
        if let Some(id) = call_id {
            self.tools.insert(id.to_string(), self.out.len() - 1);
        }
    }
}

fn parse_rfc3339(s: Option<&str>) -> Option<i64> {
    s.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|dt| dt.timestamp_millis())
}

fn read_messages(s: &Session, path: &Path) -> std::io::Result<Vec<Message>> {
    let needles = match s.provider {
        "claude" => CLAUDE_NEEDLES,
        "codex" => CODEX_NEEDLES,
        _ => ANTIGRAVITY_NEEDLES,
    };
    let mut t = Thread {
        out: vec![],
        tools: HashMap::new(),
    };
    let mut reader = BufReader::new(File::open(path)?);
    let mut line = vec![];
    while reader.read_until(b'\n', &mut line)? > 0 {
        // só decodifica linhas que podem ser mensagem
        if needles.iter().any(|n| contains(&line, n)) {
            if let Ok(o) = serde_json::from_slice::<Value>(&line) {
                match s.provider {
                    "claude" => claude_line(&mut t, &o),
                    "codex" => codex_line(&mut t, &o),
                    _ => antigravity_line(&mut t, &o),
                }
            }
        }
        line.clear();
    }
    Ok(t.out)
}

fn claude_line(t: &mut Thread, o: &Value) {
    let content = &o["message"]["content"];
    let ts = parse_rfc3339(o["timestamp"].as_str().or_else(|| o["message"]["timestamp"].as_str()));
    if o["type"] == "user" && o["isMeta"] != true {
        // saída de ferramenta volta numa mensagem "user" com tool_result
        for c in content
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["type"] == "tool_result")
        {
            if let Some(&i) = c["tool_use_id"].as_str().and_then(|id| t.tools.get(id)) {
                t.out[i].output = clip(&text_of(&c["content"]), OUTPUT_MAX);
                t.out[i].failed = c["is_error"] == true;
            }
        }
        let text = text_of(content);
        if !text.starts_with('<') {
            t.msg_with_time("user", text, claude_images(content), ts);
        }
    } else if o["type"] == "assistant" {
        for c in content.as_array().into_iter().flatten() {
            match c["type"].as_str() {
                Some("text") => t.msg_with_time(
                    "assistant",
                    c["text"].as_str().unwrap_or_default().into(),
                    vec![],
                    ts,
                ),
                Some("tool_use") => {
                    let input = &c["input"];
                    let name = c["name"].as_str().unwrap_or("tool");
                    let (added, removed) = claude_diff(name, input);
                    let m = Message {
                        text: name.into(),
                        added,
                        removed,
                        title: input["description"].as_str().unwrap_or_default().into(),
                        detail: crate::live::tool_detail(input),
                        input: clip(
                            &input["command"]
                                .as_str()
                                .map(String::from)
                                .unwrap_or_else(|| pretty(input)),
                            OUTPUT_MAX,
                        ),
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
        (Some("UserMessage"), _) => t.msg(
            "user",
            text_of(&it["content"]),
            codex_images(&it["content"]),
        ),
        (_, Some("user_message")) if !has_item => t.msg(
            "user",
            p["message"].as_str().unwrap_or_default().into(),
            codex_images(&p["images"]),
        ),
        (Some("AgentMessage"), _) => t.msg("assistant", text_of(&it["content"]), vec![]),
        (_, Some("agent_message")) if !has_item => t.msg(
            "assistant",
            p["message"].as_str().unwrap_or_default().into(),
            vec![],
        ),
        (Some("CommandExecution"), _) => {
            // parsed_cmd tem o comando limpo; command é o argv completo (powershell.exe -Command ...)
            let cmd = it["parsed_cmd"][0]["cmd"]
                .as_str()
                .or_else(|| {
                    it["command"]
                        .as_array()
                        .and_then(|a| a.last())
                        .and_then(|v| v.as_str())
                })
                .unwrap_or_default();
            let exit = it["exit_code"].as_i64().unwrap_or(0);
            t.tool(
                None,
                Message {
                    text: "Comando".into(),
                    detail: cmd.chars().take(240).collect(),
                    input: clip(cmd, OUTPUT_MAX),
                    output: clip(
                        it["aggregated_output"].as_str().unwrap_or_default(),
                        OUTPUT_MAX,
                    ),
                    failed: exit != 0 || it["status"] == "failed",
                    ..Default::default()
                },
            );
        }
        (Some("FileChange"), _) => {
            let changes = it["changes"].as_object();
            let files: Vec<&String> = changes.map(|c| c.keys().collect()).unwrap_or_default();
            let diffs = changes
                .map(|c| {
                    c.iter()
                        .map(|(f, d)| {
                            format!("{f}\n{}", d["unified_diff"].as_str().unwrap_or_default())
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n")
                })
                .unwrap_or_default();
            let (added, removed) = diff_counts(&diffs);
            t.tool(
                None,
                Message {
                    text: "Editar arquivos".into(),
                    added,
                    removed,
                    detail: files
                        .iter()
                        .map(|f| f.rsplit(['\\', '/']).next().unwrap_or(f))
                        .collect::<Vec<_>>()
                        .join(", "),
                    output: clip(&diffs, OUTPUT_MAX),
                    failed: it["status"] == "failed",
                    ..Default::default()
                },
            );
        }
        (Some("Extension"), _) if it["kind"] == "web.search" => {
            t.tool(
                None,
                Message {
                    text: "Busca na web".into(),
                    detail: it["query"].as_str().unwrap_or_default().into(),
                    ..Default::default()
                },
            );
        }
        (Some("McpToolCall"), _) => t.tool(
            None,
            Message {
                text: it["tool"].as_str().unwrap_or("MCP").into(),
                detail: it["server"].as_str().unwrap_or_default().into(),
                input: clip(&pretty(&it["arguments"]), OUTPUT_MAX),
                output: clip(&pretty(&it["result"]), OUTPUT_MAX),
                failed: it["status"] == "failed",
                ..Default::default()
            },
        ),
        (Some("ImageView"), _) => t.tool(
            None,
            Message {
                text: "Visualizar imagem".into(),
                detail: it["path"].as_str().unwrap_or_default().into(),
                ..Default::default()
            },
        ),
        (Some("ContextCompaction"), _) => t.tool(
            None,
            Message {
                text: "Contexto compactado".into(),
                ..Default::default()
            },
        ),
        (Some("CollabAgentToolCall"), _) => t.tool(
            None,
            Message {
                text: "Subagente".into(),
                output: clip(&pretty(it), OUTPUT_MAX),
                ..Default::default()
            },
        ),
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
        .map(|c| {
            data_url(
                c["source"]["media_type"].as_str().unwrap_or("image/png"),
                c["source"]["data"].as_str().unwrap_or_default(),
            )
        })
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
                let ext = Path::new(path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("png")
                    .to_lowercase();
                let mt = if ext == "jpg" {
                    "image/jpeg".to_string()
                } else {
                    format!("image/{ext}")
                };
                out.push(data_url(
                    &mt,
                    &base64::engine::general_purpose::STANDARD.encode(bytes),
                ));
            }
        }
    }
    out
}

fn antigravity_images(o: &Value) -> Vec<String> {
    let mut out = vec![];
    if let Some(media) = o["media"].as_array() {
        for m in media {
            let uri = m["uri"].as_str().unwrap_or_default();
            let mime_type = m["mime_type"].as_str().unwrap_or("image/png");
            if uri.starts_with("data:") {
                out.push(uri.to_string());
            } else if !uri.is_empty() {
                let path_str = uri.strip_prefix("file:///").unwrap_or(uri);
                let path_str = path_str.strip_prefix("file://").unwrap_or(path_str);
                let path = Path::new(path_str);
                if let Ok(bytes) = fs::read(path) {
                    out.push(data_url(
                        mime_type,
                        &base64::engine::general_purpose::STANDARD.encode(bytes),
                    ));
                }
            }
        }
    }
    if out.is_empty() {
        if let Some(content) = o["content"].as_str() {
            for line in content.lines() {
                let trimmed = line.trim();
                let candidate = if let Some(stripped) = trimmed.strip_prefix("- ") {
                    stripped.trim()
                } else if let Some(stripped) = trimmed.strip_prefix("* ") {
                    stripped.trim()
                } else {
                    ""
                };
                if !candidate.is_empty()
                    && (candidate.ends_with(".png")
                        || candidate.ends_with(".jpg")
                        || candidate.ends_with(".jpeg")
                        || candidate.ends_with(".webp")
                        || candidate.ends_with(".gif"))
                {
                    let clean = candidate.strip_prefix("file:///").unwrap_or(candidate);
                    let clean = clean.strip_prefix("file://").unwrap_or(clean);
                    let path = Path::new(clean);
                    if let Ok(bytes) = fs::read(path) {
                        let ext = path
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("png")
                            .to_lowercase();
                        let mt = if ext == "jpg" {
                            "image/jpeg"
                        } else {
                            &format!("image/{ext}")
                        };
                        out.push(data_url(
                            mt,
                            &base64::engine::general_purpose::STANDARD.encode(bytes),
                        ));
                    }
                }
            }
        }
    }
    out
}

fn clean_antigravity_user_prompt(s: &str) -> String {
    let text = s.trim();
    if let Some(start) = text.find("<USER_REQUEST>") {
        let after = &text[start + "<USER_REQUEST>".len()..];
        if let Some(end) = after.find("</USER_REQUEST>") {
            return after[..end].trim().to_string();
        } else {
            return after.trim().to_string();
        }
    }
    if text.contains("<SYSTEM_MESSAGE>") || text.starts_with("The following is a <SYSTEM_MESSAGE>")
    {
        return String::new();
    }
    text.to_string()
}

fn unquote_str(s: &str) -> String {
    let t = s.trim();
    if t.starts_with('"') && t.ends_with('"') && t.len() >= 2 {
        if let Ok(v) = serde_json::from_str::<String>(t) {
            return v;
        }
        return t[1..t.len() - 1].to_string();
    }
    t.to_string()
}

fn arg_str(args: &Value, key: &str) -> String {
    match &args[key] {
        Value::String(s) => unquote_str(s),
        Value::Null => String::new(),
        other => other.as_str().map(unquote_str).unwrap_or_else(|| {
            if other.is_object() || other.is_array() {
                String::new()
            } else {
                other.to_string()
            }
        }),
    }
}

fn parse_antigravity_tool(name: &str, args: &Value) -> (String, String, String, u32, u32) {
    let summary = arg_str(args, "toolSummary");
    let action = arg_str(args, "toolAction");
    let title = if !summary.is_empty() {
        summary
    } else if !action.is_empty() {
        action
    } else {
        arg_str(args, "Description")
    };

    let mut detail = String::new();
    let input;
    let mut added = 0;
    let mut removed = 0;

    match name {
        "run_command" => {
            let cmd = arg_str(args, "CommandLine");
            detail = cmd.chars().take(240).collect();
            input = clip(&cmd, OUTPUT_MAX);
        }
        "view_file" => {
            let path = arg_str(args, "AbsolutePath");
            detail = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
            input = clip(&path, OUTPUT_MAX);
        }
        "write_to_file" => {
            let path = arg_str(args, "TargetFile");
            detail = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
            let code = arg_str(args, "CodeContent");
            added = lines(Some(&code));
            input = clip(&code, OUTPUT_MAX);
        }
        "replace_file_content" => {
            let path = arg_str(args, "TargetFile");
            detail = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
            let target = arg_str(args, "TargetContent");
            let rep = arg_str(args, "ReplacementContent");
            removed = lines(Some(&target));
            added = lines(Some(&rep));
            input = clip(&format!("// Substituto:\n{rep}"), OUTPUT_MAX);
        }
        "search_web" => {
            let q = arg_str(args, "query");
            detail = q.clone();
            input = q;
        }
        "read_url_content" => {
            let url = arg_str(args, "Url");
            detail = url.clone();
            input = url;
        }
        "invoke_subagent" => {
            detail = "Subagente".into();
            input = clip(&pretty(args), OUTPUT_MAX);
        }
        _ => {
            for k in [
                "CommandLine",
                "TargetFile",
                "AbsolutePath",
                "Url",
                "query",
                "path",
            ] {
                let v = arg_str(args, k);
                if !v.is_empty() {
                    detail = v.chars().take(240).collect();
                    break;
                }
            }
            input = clip(&pretty(args), OUTPUT_MAX);
        }
    }

    (title, detail, input, added, removed)
}

fn antigravity_line(t: &mut Thread, o: &Value) {
    let typ = o["type"].as_str().unwrap_or_default();
    let step_idx = o["step_index"].as_u64().unwrap_or(0);
    let ts = parse_rfc3339(o["created_at"].as_str());

    match typ {
        "USER_INPUT" => {
            if o["source"] == "SYSTEM" {
                return;
            }
            let images = antigravity_images(o);
            let text = o["content"]
                .as_str()
                .map(clean_antigravity_user_prompt)
                .unwrap_or_default();
            if !text.is_empty() || !images.is_empty() {
                t.msg_with_time("user", text, images, ts);
            }
        }
        "SYSTEM_MESSAGE" => {
            if let Some(c) = o["content"].as_str() {
                // Notificações de tarefas em background terminadas:
                // Ex: content=Task id "89fdb7c2-ac42-4221-b7af-ab26d87be296/task-352" finished with result:
                if let Some(pos) = c.find("Task id \"") {
                    let rest = &c[pos + "Task id \"".len()..];
                    if let Some(id_end) = rest.find('"') {
                        let full_task_id = &rest[..id_end];
                        let task_suffix = full_task_id.rsplit('/').next().unwrap_or(full_task_id);

                        let mut result_text = "";
                        if let Some(res_pos) = rest.find("finished with result:") {
                            let after_res = &rest[res_pos + "finished with result:".len()..];
                            let end = after_res
                                .find("</SYSTEM_MESSAGE>")
                                .unwrap_or(after_res.len());
                            result_text = after_res[..end].trim();
                        }

                        if let Some(tool) = t.out.iter_mut().rev().find(|m| {
                            m.role == "tool"
                                && (m.output.contains(full_task_id)
                                    || m.output.contains(task_suffix))
                        }) {
                            if !result_text.is_empty() {
                                tool.output = clip(result_text, OUTPUT_MAX);
                                if result_text.contains("The command exited with code ")
                                    && !result_text.contains("exited with code 0")
                                {
                                    tool.failed = true;
                                }
                            }
                        }
                    }
                } else if c.contains("sender=system") || c.contains("priority=MESSAGE_PRIORITY_") {
                    // Mensagem injetada via agentapi send-message (enviada do Lume):
                    if let Some(pos) = c.find("content=") {
                        let mut body = &c[pos + "content=".len()..];
                        if let Some(end) = body.find("\n</SYSTEM_MESSAGE>") {
                            body = &body[..end];
                        } else if let Some(end) = body.find("</SYSTEM_MESSAGE>") {
                            body = &body[..end];
                        }
                        let text = clean_antigravity_user_prompt(body.trim());
                        if !text.is_empty() && !text.starts_with("Task id ") {
                            let images = antigravity_images(o);
                            t.msg("user", text, images);
                        }
                    }
                }
            }
        }
        "PLANNER_RESPONSE" => {
            if let Some(tool_calls) = o["tool_calls"].as_array() {
                for (idx, tc) in tool_calls.iter().enumerate() {
                    let name = tc["name"].as_str().unwrap_or("tool");
                    let args = &tc["args"];
                    let (title, detail, input, added, removed) = parse_antigravity_tool(name, args);
                    let tool_id = format!("step_{}_{}", step_idx, idx);
                    let m = Message {
                        text: name.to_string(),
                        title,
                        detail,
                        input,
                        added,
                        removed,
                        ..Default::default()
                    };
                    t.tool(Some(&tool_id), m);
                }
            }
            if let Some(c) = o["content"].as_str() {
                let images = antigravity_images(o);
                if !c.trim().is_empty() || !images.is_empty() {
                    t.msg_with_time("assistant", c.to_string(), images, ts);
                }
            }
        }
        "GENERIC" => {
            let output_text = o["content"].as_str().unwrap_or_default();
            let is_error = o["status"] == "ERROR";
            let prev_tool_id = format!("step_{}_0", step_idx.saturating_sub(1));
            if let Some(&i) = t.tools.get(&prev_tool_id) {
                t.out[i].output = clip(output_text, OUTPUT_MAX);
                if is_error {
                    t.out[i].failed = true;
                }
            } else if let Some(last) = t
                .out
                .iter_mut()
                .rev()
                .find(|m| m.role == "tool" && m.output.is_empty())
            {
                last.output = clip(output_text, OUTPUT_MAX);
                if is_error {
                    last.failed = true;
                }
            }
        }
        _ => {}
    }
}

#[tauri::command]
pub async fn transcript(
    app: AppHandle,
    provider: String,
    id: String,
    limit: Option<usize>,
) -> Result<Transcript, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transcript_sync(
            &app.state::<Store>(),
            provider,
            id,
            limit.unwrap_or(400).clamp(1, 100_000),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn transcript_sync(
    store: &Store,
    provider: String,
    id: String,
    limit: usize,
) -> Result<Transcript, String> {
    let mut s = find(&store, &provider, &id)?;
    if s.file.is_none() {
        // conversa nova: o arquivo só existe depois que o agente grava o primeiro turno
        match locate(&s) {
            Some(f) => {
                s.file = Some(f);
                remember(&store, s.clone());
            }
            None => {
                return Ok(Transcript {
                    messages: Some(vec![]),
                    updated: 0,
                    revision: "pending".into(),
                    active: false,
                    activity: String::new(),
                    has_more: false,
                    model: None,
                    context: None,
                })
            }
        }
    }
    let Some(path) = s.file.clone() else {
        return Ok(Transcript {
            messages: None,
            updated: 0,
            revision: "unavailable".into(),
            active: false,
            activity: String::new(),
            has_more: false,
            model: None,
            context: None,
        });
    };
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let stamp = (
        meta.modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        meta.len(),
    );
    let tail = tail_info(&s, &path);
    // cache: o polling de 3 s não relê arquivos de 100 MB
    if let Some((st, msgs)) = store.transcripts.lock().unwrap().get(&path) {
        if *st == stamp {
            return Ok(Transcript {
                messages: Some(
                    msgs.iter()
                        .skip(msgs.len().saturating_sub(limit))
                        .cloned()
                        .collect(),
                ),
                updated: stamp.0 as i64,
                revision: format!("{}:{}:{limit}", stamp.0, stamp.1),
                active: disk_activity(&s).0,
                activity: disk_activity(&s).1,
                has_more: msgs.len() > limit,
                model: tail.0,
                context: tail.1,
            });
        }
    }
    let msgs = read_messages(&s, &path).map_err(|e| e.to_string())?;
    store
        .transcripts
        .lock()
        .unwrap()
        .insert(path.clone(), (stamp, msgs.clone()));
    let (active, activity) = disk_activity(&s);
    Ok(Transcript {
        has_more: msgs.len() > limit,
        messages: Some(
            msgs.into_iter()
                .rev()
                .take(limit)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect(),
        ),
        updated: stamp.0 as i64,
        revision: format!("{}:{}:{limit}", stamp.0, stamp.1),
        active,
        activity,
        model: tail.0,
        context: tail.1,
    })
}

/// Modelo e janela de contexto, lidos da cauda do arquivo da sessão.
/// Claude: `usage` da última resposta (entrada + cache). Codex: evento `token_count` (último turno / janela do modelo).
fn tail_info(s: &Session, path: &Path) -> (Option<String>, Option<(u64, u64)>) {
    let read = || -> Option<Vec<u8>> {
        let mut file = File::open(path).ok()?;
        let size = file.metadata().ok()?.len();
        file.seek(SeekFrom::Start(size.saturating_sub(512 * 1024))).ok()?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).ok()?;
        Some(buf)
    };
    let Some(buf) = read() else { return (None, None) };
    let lines = || buf.split(|&b| b == b'\n').rev();
    match s.provider {
        "claude" => lines()
            .filter(|l| contains(l, b"\"type\":\"assistant\""))
            .find_map(|l| {
                let o: Value = serde_json::from_slice(l).ok()?;
                let m = &o["message"];
                let model = m["model"].as_str().filter(|x| x.starts_with("claude"))?.to_string();
                let u = &m["usage"];
                let used = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
                    .iter()
                    .map(|k| u[k].as_u64().unwrap_or(0))
                    .sum::<u64>();
                // ponytail: o arquivo não grava o limite; 1M nos modelos 5.x (e se já passou de 200k), senão 200k
                let big = used > 200_000 || ["opus-5", "sonnet-5", "fable-5"].iter().any(|f| model.contains(f));
                Some((Some(model), (used > 0).then_some((used, if big { 1_000_000 } else { 200_000 }))))
            })
            .unwrap_or((None, None)),
        "codex" => lines()
            .filter(|l| contains(l, b"\"token_count\""))
            .find_map(|l| {
                let o: Value = serde_json::from_slice(l).ok()?;
                let info = &o["payload"]["info"];
                let used = info["last_token_usage"]["total_tokens"].as_u64()?;
                let limit = info["model_context_window"].as_u64()?;
                Some((None, Some((used, limit))))
            })
            .unwrap_or((None, None)),
        "antigravity" => {
            let mut model = None;
            let mut ctx = None;
            for l in lines() {
                if model.is_none() && contains(l, b"Model Selection") {
                    if let Ok(o) = serde_json::from_slice::<Value>(l) {
                        if let Some(content) = o["content"].as_str() {
                            if let Some(pos) = content.find("`Model Selection` from None to ") {
                                let sub = &content[pos + "`Model Selection` from None to ".len()..];
                                if let Some(end) = sub.find('.') {
                                    model = Some(sub[..end].trim().to_string());
                                }
                            }
                        }
                    }
                }
                if ctx.is_none() && contains(l, b"\"PLANNER_RESPONSE\"") {
                    if let Ok(o) = serde_json::from_slice::<Value>(l) {
                        let input = o["input_tokens"].as_u64().unwrap_or(0);
                        let cache = o["cache_read_tokens"].as_u64().unwrap_or(0);
                        let used = input + cache;
                        if used > 0 {
                            ctx = Some((used, 1_048_576));
                        }
                    }
                }
                if model.is_some() && ctx.is_some() {
                    break;
                }
            }
            (model, ctx)
        }
        _ => (None, None),
    }
}

// ---------- busca dentro das conversas ----------

static SEARCH_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Serialize)]
pub struct Hit {
    provider: &'static str,
    id: String,
    snippet: String,
}

/// Trecho legível em volta do achado (tira o "ruído" do JSON da linha).
fn snippet(line: &[u8], at: usize, len: usize) -> String {
    let from = at.saturating_sub(60);
    let to = (at + len + 90).min(line.len());
    let text = String::from_utf8_lossy(&line[from..to])
        .replace("\\n", " ")
        .replace("\\\"", "\"");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Procura o texto em todas as conversas do Claude e do Codex, das mais recentes para as mais antigas.
// ponytail: varredura bruta (ASCII sem acento/caixa) em ~2 GB; índice só se ficar lento demais
#[tauri::command]
pub async fn search_content(store: State<'_, Store>, query: String) -> Result<Vec<Hit>, String> {
    let q = query.trim().to_ascii_lowercase();
    if q.len() < 3 {
        return Ok(vec![]);
    }
    let gen = SEARCH_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let mut sessions: Vec<Session> = store
        .sessions
        .lock()
        .unwrap()
        .values()
        .filter(|s| s.file.is_some() && s.provider != "antigravity")
        .cloned()
        .collect();
    sessions.sort_by_key(|s| -s.updated);
    tauri::async_runtime::spawn_blocking(move || scan(sessions, &q, gen))
        .await
        .map_err(|e| e.to_string())
}

fn scan(sessions: Vec<Session>, q: &str, gen: u64) -> Vec<Hit> {
    {
        let finder = memchr::memmem::Finder::new(q.as_bytes());
        let mut hits = vec![];
        for s in sessions {
            if SEARCH_GEN.load(std::sync::atomic::Ordering::SeqCst) != gen || hits.len() >= 30 {
                break; // nova busca começou (ou já basta)
            }
            let Ok(raw) = fs::read(s.file.as_ref().unwrap()) else {
                continue;
            };
            let lower = raw.to_ascii_lowercase();
            // só linhas de conversa (mensagem do usuário/IA), não metadados
            let needles: &[&[u8]] = if s.provider == "claude" {
                CLAUDE_NEEDLES
            } else {
                CODEX_NEEDLES
            };
            let mut start = 0;
            while let Some(i) = finder.find(&lower[start..]).map(|i| i + start) {
                let ls = lower[..i]
                    .iter()
                    .rposition(|&b| b == b'\n')
                    .map(|p| p + 1)
                    .unwrap_or(0);
                let le = lower[i..]
                    .iter()
                    .position(|&b| b == b'\n')
                    .map(|p| p + i)
                    .unwrap_or(lower.len());
                if needles.iter().any(|n| contains(&raw[ls..le], n)) {
                    hits.push(Hit {
                        provider: s.provider,
                        id: s.id.clone(),
                        snippet: snippet(&raw[ls..le], i - ls, q.len()),
                    });
                    break;
                }
                start = le;
            }
        }
        hits
    }
}

fn antigravity_disk_activity(path: &Path) -> (bool, String) {
    let Ok(mut file) = File::open(path) else {
        return (false, String::new());
    };
    let meta = match file.metadata() {
        Ok(m) => m,
        Err(_) => return (false, String::new()),
    };
    let age = meta
        .modified()
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|d| d.as_secs())
        .unwrap_or(u64::MAX);

    if age > BUSY_SECS {
        return (false, String::new());
    }

    let size = meta.len();
    let _ = file.seek(SeekFrom::Start(size.saturating_sub(64 * 1024)));
    let mut content = String::new();
    let _ = file.read_to_string(&mut content);

    for line in content.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let status = v["status"].as_str().unwrap_or_default();
        if status == "RUNNING" {
            let detail = v["tool_calls"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(|tc| tc["name"].as_str())
                .map(|n| format!("Executando {n}"))
                .unwrap_or_else(|| "Trabalhando no Antigravity".into());
            return (true, detail);
        }
        if status == "DONE" {
            let typ = v["type"].as_str().unwrap_or_default();
            if typ == "PLANNER_RESPONSE"
                && v["content"].as_str().is_some_and(|c| !c.trim().is_empty())
            {
                return (false, String::new());
            }
            if typ == "GENERIC" && age < 15 {
                return (true, "Pensando no Antigravity…".into());
            }
        }
    }
    (false, String::new())
}

/// Claude: o turno fecha num `assistant` com stop_reason end_turn; terminar num tool_use, num resultado de
/// ferramenta ou num prompt = ainda rodando (no app ou na CLI).
// ponytail: sem escrita há 10 min conta como parado (sessão largada no meio); hook de Stop se precisar exato
fn claude_disk_activity(path: &Path) -> (bool, String) {
    let fresh = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age.as_secs() < 600);
    if !fresh {
        return (false, String::new());
    }
    let Ok(mut file) = File::open(path) else {
        return (false, String::new());
    };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(size.saturating_sub(512 * 1024)));
    let mut buf = Vec::new();
    let _ = file.read_to_end(&mut buf);
    for line in buf.split(|&b| b == b'\n').rev() {
        let Ok(o) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let content = &o["message"]["content"];
        match o["type"].as_str() {
            Some("assistant") => {
                if matches!(
                    o["message"]["stop_reason"].as_str(),
                    Some("end_turn" | "stop_sequence" | "max_tokens" | "refusal")
                ) {
                    return (false, String::new());
                }
                let tool = content
                    .as_array()
                    .into_iter()
                    .flatten()
                    .rev()
                    .find(|c| c["type"] == "tool_use");
                let detail = match tool {
                    Some(t) => t["input"]["description"]
                        .as_str()
                        .map(String::from)
                        .unwrap_or_else(|| {
                            format!("Usando {}", t["name"].as_str().unwrap_or("ferramenta"))
                        }),
                    None => "Pensando…".into(),
                };
                return (true, detail);
            }
            Some("user") if o["isMeta"] != true => {
                if text_of(content).starts_with("[Request interrupted") {
                    return (false, String::new());
                }
                return (true, "Pensando…".into());
            }
            _ => {}
        }
    }
    (false, String::new())
}

pub fn disk_activity(s: &Session) -> (bool, String) {
    let Some(path) = &s.file else {
        return (false, String::new());
    };
    if s.provider == "antigravity" {
        return antigravity_disk_activity(path);
    }
    if s.provider == "claude" {
        return claude_disk_activity(path);
    }
    let Ok(mut file) = File::open(path) else {
        return (false, String::new());
    };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(size.saturating_sub(512 * 1024)));
    let mut content = String::new();
    let _ = file.read_to_string(&mut content);
    let mut detail = String::new();
    for line in content.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v["type"] != "event_msg" {
            continue;
        }
        let p = &v["payload"];
        match p["type"].as_str().unwrap_or_default() {
            "task_complete" | "task_completed" | "turn_aborted" => return (false, detail),
            "task_started" => {
                return (
                    true,
                    if detail.is_empty() {
                        "Trabalhando no Codex".into()
                    } else {
                        detail
                    },
                )
            }
            "item_completed" if detail.is_empty() => {
                let it = &p["item"];
                detail = match it["type"].as_str().unwrap_or_default() {
                    "AgentMessage" => text_of(&it["content"]).chars().take(180).collect(),
                    "CommandExecution" => "Executou um comando".into(),
                    "FileChange" => "Editou arquivos".into(),
                    "McpToolCall" => format!("Usou {}", it["tool"].as_str().unwrap_or("MCP")),
                    _ => String::new(),
                };
            }
            _ => {}
        }
    }
    (false, detail)
}

#[tauri::command]
pub async fn session_activity(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sessions: Vec<_> = app.state::<Store>().sessions.lock().unwrap().values().cloned().collect();
        sessions.iter().map(|s| { let (active, detail) = disk_activity(s); serde_json::json!({"id":s.id,"provider":s.provider,"active":active,"detail":detail,"updated":s.file.as_ref().map(|p| mtime_ms(p)).unwrap_or(0)}) }).collect::<Vec<_>>()
    }).await.map(|v| serde_json::json!(v)).map_err(|e| e.to_string())
}

// ---------- trava de sessão em uso ----------

/// ponytail: heurística por mtime — arquivo mexido há < 2 min = o app está usando a sessão agora.
/// O app não expõe "sessão ativa" de forma confiável (sessão nova nem leva o id na linha de comando).
pub fn busy_elsewhere(s: &Session) -> Result<(), String> {
    if s.provider == "codex" {
        return if disk_activity(s).0 {
            Err("Esta conversa ainda está executando no Codex. Aguarde o turno terminar antes de continuar pelo Lume.".into())
        } else {
            Ok(())
        };
    }
    if s.provider == "antigravity" {
        return if disk_activity(s).0 {
            Err("Esta conversa ainda está executando no Antigravity. Aguarde o turno terminar antes de continuar pelo Lume.".into())
        } else {
            Ok(())
        };
    }
    if let Some(f) = &s.file {
        let age = fs::metadata(f)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok());
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
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn launch(
    app: &AppHandle,
    provider: &str,
    cwd: &str,
    session_id: Option<&str>,
) -> Result<(), String> {
    if !Path::new(cwd).is_dir() {
        return Err(format!("pasta não existe: {cwd}"));
    }
    // deep links lidos dos bundles dos apps; o app abre já logado
    let url = match (provider, session_id) {
        ("claude", Some(id)) => format!("claude://resume?session={}", enc(id)), // importa da CLI ou só abre
        ("claude", None) => format!("claude://code/new?folder={}", enc(cwd)),
        ("codex", Some(id)) => format!("codex://threads/{}", enc(id)),
        ("codex", None) => format!("codex://threads/new?path={}", enc(cwd)),
        ("antigravity", Some(id)) => {
            let _ = crate::usage::antigravity_focus(id);
            let exe = home()
                .join("AppData")
                .join("Local")
                .join("Programs")
                .join("Antigravity")
                .join("Antigravity.exe");
            let mut cmd = Command::new(exe);
            cmd.arg(cwd);
            hidden(&mut cmd)
                .spawn()
                .map_err(|e| format!("não achei o Antigravity: {e}"))?;
            return Ok(());
        }
        ("antigravity", None) => {
            let exe = home()
                .join("AppData")
                .join("Local")
                .join("Programs")
                .join("Antigravity")
                .join("Antigravity.exe");
            let mut cmd = Command::new(exe);
            cmd.arg(cwd);
            hidden(&mut cmd)
                .spawn()
                .map_err(|e| format!("não achei o Antigravity: {e}"))?;
            return Ok(());
        }
        _ => return Err("provider inválido".into()),
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_session(
    app: AppHandle,
    store: State<'_, Store>,
    provider: String,
    id: String,
) -> Result<(), String> {
    let s = find(&store, &provider, &id)?;
    launch(&app, s.provider, &s.project, Some(&s.id))
}

#[tauri::command]
pub async fn new_session(
    app: AppHandle,
    store: State<'_, Store>,
    provider: String,
    project: String,
) -> Result<(), String> {
    // só em projeto que já tem sessão registrada
    if !store
        .sessions
        .lock()
        .unwrap()
        .values()
        .any(|s| s.project == project)
    {
        return Err("projeto desconhecido".into());
    }
    launch(&app, &provider, &project, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_path_unifica_formatos() {
        assert_eq!(
            norm_path("file:///c%3A/Projetos/Jogos/GrandchaseV2"),
            r"C:\Projetos\Jogos\GrandchaseV2"
        );
        assert_eq!(
            norm_path(r"\\?\C:\Projetos\FigmaLocalMCP"),
            r"C:\Projetos\FigmaLocalMCP"
        );
        assert_eq!(
            norm_path(r"C:\Projetos\Frellas\G5Rating\.claude\worktrees\spec-1"),
            r"C:\Projetos\Frellas\G5Rating"
        );
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
        let s = Session {
            provider,
            id: String::new(),
            project: String::new(),
            title: String::new(),
            updated: 0,
            file: None,
        };
        let msgs = read_messages(&s, Path::new(file)).unwrap();
        let tools: Vec<_> = msgs.iter().filter(|m| m.role == "tool").collect();
        let with_output = tools.iter().filter(|m| !m.output.is_empty()).count();
        println!(
            "{} mensagens, {} ferramentas, {} com saída",
            msgs.len(),
            tools.len(),
            with_output
        );
        for m in tools.iter().take(3) {
            println!(
                "  [{}] título={:?} detalhe={:?} saída={:?}",
                m.text,
                m.title,
                m.detail.chars().take(60).collect::<String>(),
                m.output.chars().take(60).collect::<String>()
            );
        }
        assert!(with_output > 0, "nenhuma ferramenta recebeu saída");
    }
}

#[cfg(test)]
mod claude_activity {
    use super::*;

    fn run(lines: &[&str]) -> bool {
        let p = std::env::temp_dir().join(format!("lume-act-{}.jsonl", lines.len()));
        fs::write(&p, lines.join("\n")).unwrap();
        claude_disk_activity(&p).0
    }

    #[test]
    fn detecta_turno_do_claude() {
        let tool = r#"{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash","input":{"description":"x"}}]}}"#;
        let result =
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#;
        let end = r#"{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"pronto"}]}}"#;
        let meta = r#"{"type":"attachment"}"#;
        assert!(run(&[tool]));
        assert!(run(&[tool, result, meta]));
        assert!(!run(&[tool, result, end, meta, meta]));
    }
}

/// Abre a pasta do projeto no Explorer (só projetos que o Lume conhece).
#[tauri::command]
pub async fn open_folder(
    app: AppHandle,
    store: State<'_, Store>,
    project: String,
) -> Result<(), String> {
    if !store
        .sessions
        .lock()
        .unwrap()
        .values()
        .any(|s| s.project == project)
    {
        return Err("projeto desconhecido".into());
    }
    app.opener()
        .open_path(&project, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod search_real {
    /// cargo test --lib busca_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn busca_real() {
        let mut all = super::claude_sessions();
        all.extend(super::codex_sessions().unwrap_or_default());
        all.sort_by_key(|s| -s.updated);
        let t = std::time::Instant::now();
        let hits = super::scan(all.clone(), "deploy", 0);
        println!(
            "{} sessões, {} achados em {:?}",
            all.len(),
            hits.len(),
            t.elapsed()
        );
        for h in hits.iter().take(3) {
            println!(
                "  [{}] {}",
                h.provider,
                h.snippet.chars().take(120).collect::<String>()
            );
        }
        assert!(!hits.is_empty());
    }
}

#[derive(Serialize)]
pub struct GitInfo {
    repo: String,
    branch: String,
    added: u32,
    removed: u32,
}

/// Repositório, branch e +/− do trabalho atual (commits da branch + o que ainda não foi commitado),
/// contra o ponto onde a branch saiu da principal. None = a pasta não é um repositório git.
#[tauri::command]
pub async fn git_info(project: String) -> Result<Option<GitInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let git = |args: &[&str]| -> Option<String> {
            let out = hidden(Command::new("git").args(args).current_dir(&project))
                .output()
                .ok()?;
            out.status
                .success()
                .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        };
        let Some(top) = git(&["rev-parse", "--show-toplevel"]) else {
            return Ok(None);
        };
        let branch = git(&["branch", "--show-current"])
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| "HEAD".into());
        // base = onde a branch saiu da principal; sem remoto, só o que não foi commitado
        let base = ["origin/HEAD", "origin/main", "origin/master"]
            .iter()
            .find_map(|r| git(&["merge-base", "HEAD", r]))
            .unwrap_or_else(|| "HEAD".into());
        let (mut added, mut removed) = (0, 0);
        for line in git(&["diff", "--numstat", &base])
            .unwrap_or_default()
            .lines()
        {
            let mut cols = line.split('\t');
            added += cols.next().and_then(|n| n.parse::<u32>().ok()).unwrap_or(0);
            removed += cols.next().and_then(|n| n.parse::<u32>().ok()).unwrap_or(0);
        }
        let repo = top.rsplit(['/', '\\']).next().unwrap_or(&top).to_string();
        Ok(Some(GitInfo {
            repo,
            branch,
            added,
            removed,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Imagem escolhida no "+ Adicionar arquivos ou fotos" (vira anexo, como colar uma imagem).
#[tauri::command]
pub async fn read_image(path: String) -> Result<Value, String> {
    let ext = Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
    let media = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return Err("não é uma imagem".into()),
    };
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("imagem maior que 10 MB".into());
    }
    Ok(serde_json::json!({"media_type": media, "data": base64::engine::general_purpose::STANDARD.encode(bytes)}))
}
