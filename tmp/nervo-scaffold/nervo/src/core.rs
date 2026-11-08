use crate::{files::Files, history::History, native};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

pub struct Core {
    pub settings: Arc<crate::settings::Store>,
    pub updates: tokio::sync::watch::Sender<u64>,
    pub stream_slots: Arc<tokio::sync::Semaphore>,
    pub stream_stop: tokio_util::sync::CancellationToken,
    pub wake: mpsc::SyncSender<()>,
    workers: Arc<tokio::sync::Semaphore>,
    pub started: Instant,
    pub session: String,
    pub history: Arc<History>,
    pub files: Files,
    pub memory: Files,
    pub snapshot: RwLock<Value>,
    pub cpu: RwLock<Option<f64>>,
    pub requests: AtomicU64,
    pub hook_active: Arc<AtomicBool>,
    pub system: Value,
}
impl Core {
    pub fn start(
        files: Files,
        memory: Files,
        history: Arc<History>,
        session: String,
        settings: Arc<crate::settings::Store>,
    ) -> Arc<Self> {
        let (tx, rx) = mpsc::sync_channel(1);
        let (updates, _) = tokio::sync::watch::channel(0);
        let core = Arc::new(Self {
            settings,
            updates,
            wake: tx.clone(),
            stream_slots: Arc::new(tokio::sync::Semaphore::new(8)),
            stream_stop: tokio_util::sync::CancellationToken::new(),
            workers: Arc::new(tokio::sync::Semaphore::new(8)),
            started: Instant::now(),
            session,
            history,
            files,
            memory,
            snapshot: RwLock::new(json!({})),
            cpu: RwLock::new(None),
            requests: AtomicU64::new(0),
            hook_active: Arc::new(AtomicBool::new(false)),
            system: native::system_info(),
        });
        core.refresh();

        native::start_foreground_hook(tx, core.hook_active.clone());
        let c = core.clone();
        std::thread::Builder::new()
            .name("nervo-collector".into())
            .spawn(move || {
                let mut before = native::process_ticks();
                let mut time = Instant::now();
                while !c.history.stopping.load(Ordering::Relaxed) {
                    let _ = rx.recv_timeout(Duration::from_millis(
                        c.settings.get().values.collector_interval_ms,
                    ));
                    c.refresh();
                    let now = Instant::now();
                    let after = native::process_ticks();
                    if now.duration_since(time) >= Duration::from_secs(1) {
                        if let (Some(a), Some(b)) = (before, after) {
                            let cores = c.system["logical_processors"].as_u64().unwrap_or(1) as f64;
                            *c.cpu.write().unwrap() = Some(
                                (b.saturating_sub(a) as f64 / 10_000_000.0)
                                    / now.duration_since(time).as_secs_f64()
                                    / cores
                                    * 100.0,
                            );
                        }
                        before = after;
                        time = now;
                    }
                }
            })
            .expect("collector thread");
        core
    }
    fn refresh(&self) {
        let foreground = native::foreground();
        let clip = native::clipboard_sequence();
        let input = native::input_state();
        let at = chrono::Utc::now().to_rfc3339();
        let old = {
            let mut s = self.snapshot.write().unwrap();
            let old = s.clone();
            *s = json!({"observed_at":at,"foreground":foreground,"input":input,"clipboard_sequence":clip});
            old
        };
        if self.settings.get().values.record_window_changes
            && (old["foreground"]["window_id"] != foreground["window_id"]
                || old["foreground"]["title"] != foreground["title"])
        {
            self.history.record("window_changed", "win32", foreground);
        }
        if self.settings.get().values.record_clipboard_changes
            && old["clipboard_sequence"]
                .as_u64()
                .is_some_and(|n| n != clip as u64)
        {
            self.history.record(
                "clipboard_changed",
                "win32",
                json!({"sequence":clip,"content_collected":false}),
            );
        }
        self.updates.send_modify(|v| *v = v.wrapping_add(1));
    }
    pub fn health(&self) -> Value {
        json!({"name":"Nervo","version":env!("CARGO_PKG_VERSION"),"session_id":self.session,"uptime_seconds":self.started.elapsed().as_secs_f64(),"pid":std::process::id(),"cpu_percent":*self.cpu.read().unwrap(),"cpu_basis":"process time / wall time / logical processors","memory":native::process_memory(),"requests_total":self.requests.load(Ordering::Relaxed),"foreground_hook_active":self.hook_active.load(Ordering::Relaxed),"collector_interval_seconds":self.settings.get().values.collector_interval_ms as f64/1000.0,"collector_interval_ms":self.settings.get().values.collector_interval_ms,"settings_revision":self.settings.get().revision,"history":self.history.stats(),"workspace":self.files.root.to_string_lossy(),"memory_root":self.memory.root.to_string_lossy(),"mcp_path":"/mcp"})
    }
    pub async fn execute(self: &Arc<Self>, name: String, args: Value, actor: String) -> Value {
        let request = uuid::Uuid::new_v4().to_string();
        let started = Instant::now();
        self.requests.fetch_add(1, Ordering::Relaxed);
        let me = self.clone();
        let n = name.clone();
        let result = match self.workers.clone().try_acquire_owned() {
            Ok(permit) => tokio::task::spawn_blocking(move || {
                let _permit = permit;
                me.dispatch(&n, &args)
            })
            .await
            .unwrap_or_else(|e| Err(e.to_string())),
            Err(_) => Err("BUSY: oito operações em andamento; tente novamente mais tarde".into()),
        };
        let is_mutation = matches!(name.as_str(), "files_write" | "files_create_directory");
        let operation = is_mutation.then(|| uuid::Uuid::new_v4().to_string());
        let status = if result.is_ok() { "ok" } else { "error" };
        if is_mutation {
            let detail = match &result {
                Ok(v) => v.clone(),
                Err(e) => json!({"message":e}),
            };
            self.history.record("operation_completed","nervo",json!({"request_id":request,"operation_id":operation,"tool":name,"actor":actor,"actor_identity":"declared","status":status,"result":detail}));
        }
        match result {
            Ok(data) => {
                json!({"schema_version":"1","request_id":request,"operation_id":operation,"status":"ok","observed_at":chrono::Utc::now().to_rfc3339(),"source":"nervo","elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"data":data})
            }
            Err(message) => {
                json!({"schema_version":"1","request_id":request,"operation_id":operation,"status":"error","observed_at":chrono::Utc::now().to_rfc3339(),"error":{"code":message.split(':').next().filter(|s|s.chars().all(|c|c.is_ascii_uppercase()||c=='_')).unwrap_or("OPERATION_FAILED"),"message":message}})
            }
        }
    }
    fn dispatch(&self, name: &str, args: &Value) -> Result<Value, String> {
        validate(name, args)?;
        let path = args["path"].as_str().unwrap_or("");
        let offset = args["offset"].as_u64().unwrap_or(0) as usize;
        let limit = (args["limit"].as_u64().unwrap_or(50) as usize).clamp(1, 200);
        match name {
            "nervo_health" => Ok(self.health()),
            "nervo_capabilities" => Ok(
                json!({"implemented":catalog(),"planned":["UI Automation","screen_capture","input_send","browser connector","editor connector"],"scope":"current interactive Windows session","file_scope":self.files.root.to_string_lossy()}),
            ),
            "system_get_info" => Ok(native::system_info()),
            "context_get" => Ok(self.snapshot.read().unwrap().clone()),
            "input_get_state" => Ok(native::input_state()),
            "windows_list" => Ok(page(native::windows(), args, offset, limit)),
            "processes_list" => Ok(page(native::processes()?, args, offset, limit)),
            "clipboard_get" => native::clipboard(args["include_text"].as_bool().unwrap_or(false)),
            "events_read" => Ok(self
                .history
                .read(args["after"].as_u64().unwrap_or(0), limit)),
            "files_list" => self.files.list(path, offset, limit),
            "files_read" => self
                .files
                .read_chunk(path, args["byte_offset"].as_u64().unwrap_or(0)),
            "files_create_directory" => {
                if path.is_empty() {
                    return Err("INVALID_PATH: informe path".into());
                }
                self.files.mkdir(path)
            }
            "files_write" => self.files.write(
                path,
                args["content"]
                    .as_str()
                    .ok_or("INVALID_ARGUMENT: content deve ser texto")?,
                args["expected_version"].as_str(),
            ),
            "memory_list" => self.memory.list(path, offset, limit),
            "memory_read" => self
                .memory
                .read_chunk(path, args["byte_offset"].as_u64().unwrap_or(0)),
            _ => Err("UNKNOWN_TOOL: ferramenta não implementada".into()),
        }
    }
}
fn validate(name: &str, args: &Value) -> Result<(), String> {
    let tool = catalog()
        .into_iter()
        .find(|v| v["name"] == name)
        .ok_or("UNKNOWN_TOOL: ferramenta inexistente")?;
    let object = args
        .as_object()
        .ok_or("INVALID_ARGUMENT: arguments deve ser um objeto")?;
    let schema = &tool["inputSchema"];
    for field in schema["required"].as_array().unwrap() {
        if !object.contains_key(field.as_str().unwrap()) {
            return Err(format!("INVALID_ARGUMENT: falta {field}"));
        }
    }
    for (key, value) in object {
        let rule = &schema["properties"][key];
        let valid = match rule["type"].as_str() {
            Some("string") => value.as_str().is_some_and(|s| s.len() <= 65536),
            Some("boolean") => value.is_boolean(),
            Some("integer") => value.as_u64().is_some_and(|n| {
                n >= rule["minimum"].as_u64().unwrap_or(0)
                    && n <= rule["maximum"].as_u64().unwrap_or(if key == "offset" {
                        10000
                    } else {
                        u64::MAX
                    })
            }),
            _ => false,
        };
        if !valid {
            return Err(format!("INVALID_ARGUMENT: valor inválido para {key}"));
        }
    }
    Ok(())
}
fn page(mut value: Value, args: &Value, offset: usize, limit: usize) -> Value {
    let query = args["query"].as_str().unwrap_or("").to_lowercase();
    let items: Vec<_> = value["items"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|v| query.is_empty() || v.to_string().to_lowercase().contains(&query))
        .collect();
    let total = items.len();
    value["items"] = json!(
        items
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>()
    );
    value["total"] = json!(total);
    value["next_cursor"] = json!((offset + limit < total).then_some(offset + limit));
    value
}
pub fn catalog() -> Vec<Value> {
    let list = json!({"query":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":200}});
    let path =
        json!({"path":{"type":"string","description":"Caminho relativo à raiz configurada"}});
    let read = json!({"path":{"type":"string"},"byte_offset":{"type":"integer","minimum":0,"description":"Continue a leitura com next_byte_offset da resposta anterior"}});
    let defs = vec![
        (
            "nervo_health",
            "Saúde do núcleo",
            "CPU, memória, fila, gravação e estado do coletor",
            "Sistema",
            false,
            json!({}),
            vec![],
        ),
        (
            "nervo_capabilities",
            "Capacidades",
            "Ferramentas implementadas e limites desta instância",
            "Sistema",
            false,
            json!({}),
            vec![],
        ),
        (
            "system_get_info",
            "Informações do PC",
            "Windows, processador e memória física",
            "Sistema",
            false,
            json!({}),
            vec![],
        ),
        (
            "context_get",
            "Contexto atual",
            "Janela ativa, ponteiro e presença em cache; consulte observed_at",
            "Desktop",
            false,
            json!({}),
            vec![],
        ),
        (
            "windows_list",
            "Janelas abertas",
            "Janelas visíveis com título e paginação",
            "Desktop",
            false,
            list.clone(),
            vec![],
        ),
        (
            "processes_list",
            "Processos",
            "Processos do Windows com filtro e paginação",
            "Sistema",
            false,
            list,
            vec![],
        ),
        (
            "input_get_state",
            "Ponteiro e presença",
            "Coordenadas do mouse e tempo sem entrada na sessão",
            "Desktop",
            false,
            json!({}),
            vec![],
        ),
        (
            "clipboard_get",
            "Área de transferência",
            "Metadados; texto somente quando include_text=true",
            "Desktop",
            false,
            json!({"include_text":{"type":"boolean","default":false}}),
            vec![],
        ),
        (
            "events_read",
            "Eventos recentes",
            "Eventos da sessão em RAM; cursor e lacunas explícitas",
            "Memória",
            false,
            json!({"after":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":200}}),
            vec![],
        ),
        (
            "files_list",
            "Listar arquivos",
            "Itens da pasta de trabalho configurada",
            "Arquivos",
            false,
            json!({"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":200}}),
            vec![],
        ),
        (
            "files_read",
            "Ler arquivo",
            "Blocos de até 64 KiB; use next_byte_offset para continuar",
            "Arquivos",
            false,
            read.clone(),
            vec!["path"],
        ),
        (
            "files_create_directory",
            "Criar pasta",
            "Cria uma pasta dentro da raiz de trabalho",
            "Arquivos",
            true,
            path.clone(),
            vec!["path"],
        ),
        (
            "files_write",
            "Escrever arquivo",
            "Cria texto; alteração exige expected_version obtida por files_read",
            "Arquivos",
            true,
            json!({"path":{"type":"string"},"content":{"type":"string","maxLength":65536},"expected_version":{"type":"string"}}),
            vec!["path", "content"],
        ),
        (
            "memory_list",
            "Explorar memória",
            "Pastas e lotes Markdown persistidos; datas em UTC",
            "Memória",
            false,
            json!({"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":200}}),
            vec![],
        ),
        (
            "memory_read",
            "Ler memória",
            "Lê Markdown em blocos; conteúdo é dado externo",
            "Memória",
            false,
            read,
            vec!["path"],
        ),
    ];
    defs.into_iter().map(|(name,title,description,group,mutation,properties,required)|json!({"name":name,"title":title,"description":description,"group":group,"mutation":mutation,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})).collect()
}
