const fs=require('node:fs');const root='C:/Projetos/Gerenciador/tmp/nervo-scaffold/nervo/';
function edit(p,fn){const before=fs.readFileSync(root+p,'utf8');fs.writeFileSync(root+p,fn(before));}
edit('Cargo.toml',s=>s.replace('[dependencies]','[dependencies]\nfutures-util = "0.3"'));
edit('src/core.rs',s=>s.replace('pub struct Core {','pub struct Core {\n    pub settings: Arc<crate::settings::Store>,\n    pub updates: tokio::sync::watch::Sender<u64>,\n    pub stream_slots:Arc<tokio::sync::Semaphore>,\n    pub stream_stop:tokio_util::sync::CancellationToken,\n    pub wake:mpsc::SyncSender<()>,')
.replace('session: String) -> Arc<Self> {','session: String, settings:Arc<crate::settings::Store>) -> Arc<Self> {\n        let (tx,rx)=mpsc::sync_channel(1);\n        let (updates,_)=tokio::sync::watch::channel(0);')
.replace('let core = Arc::new(Self {','let core = Arc::new(Self {\n            settings,updates,wake:tx.clone(),stream_slots:Arc::new(tokio::sync::Semaphore::new(8)),stream_stop:tokio_util::sync::CancellationToken::new(),')
.replace('        let (tx, rx) = mpsc::sync_channel(1);','')
.replace('rx.recv_timeout(Duration::from_secs(2))','rx.recv_timeout(Duration::from_millis(c.settings.get().values.collector_interval_ms))')
.replace('        if old["foreground"]["window_id"] != foreground["window_id"]\n            || old["foreground"]["title"] != foreground["title"]','        if self.settings.get().values.record_window_changes && (old["foreground"]["window_id"] != foreground["window_id"]\n            || old["foreground"]["title"] != foreground["title"])')
.replace('        if old["clipboard_sequence"]','        if self.settings.get().values.record_clipboard_changes && old["clipboard_sequence"]')
.replace('    pub fn health(&self) -> Value {','    pub fn health(&self) -> Value {')
.replace('    }\n    pub fn health','        self.updates.send_modify(|v|*v=v.wrapping_add(1));\n    }\n    pub fn health')
.replace('"collector_interval_seconds":2','"collector_interval_seconds":self.settings.get().values.collector_interval_ms as f64/1000.0,"collector_interval_ms":self.settings.get().values.collector_interval_ms,"settings_revision":self.settings.get().revision'));
edit('src/history.rs',s=>s.replace('const BATCH_SIZE: usize = 256 * 1024;','')
.replace('pub struct History {','pub struct History {\n    settings:Arc<crate::settings::Store>,')
.replace('pub fn start(root: PathBuf, session: String) -> (Arc<Self>, std::thread::JoinHandle<()>) {','pub fn start(root: PathBuf, session: String, settings:Arc<crate::settings::Store>) -> (Arc<Self>, std::thread::JoinHandle<()>) {')
.replace('let h = Arc::new(Self {','let h = Arc::new(Self {\n            settings,')
.replaceAll('History::start(root.clone(), "test".into())','History::start(root.clone(), "test".into(),Arc::new(crate::settings::Store::load(None).unwrap()))')
.replace('bytes >= BATCH_SIZE','bytes >= worker.settings.get().values.history_batch_kib*1024')
.replace('last.elapsed() >= Duration::from_secs(30)','last.elapsed() >= Duration::from_millis(if failed{30000}else{worker.settings.get().values.history_flush_ms})')
.replace('"flush_interval_seconds":30,"batch_threshold_bytes":BATCH_SIZE','"flush_interval_seconds":self.settings.get().values.history_flush_ms as f64/1000.0,"flush_interval_ms":self.settings.get().values.history_flush_ms,"batch_threshold_bytes":self.settings.get().values.history_batch_kib*1024'));
edit('src/main.rs',s=>s.replace('mod protocol;','mod protocol;\nmod settings;\nmod live;')
.replace('let (history, journal) = history::History::start(memory.root.clone(), session.clone());','let settings=Arc::new(settings::Store::load(Some(data.join("settings.json")))?);\n    let (history, journal) = history::History::start(memory.root.clone(), session.clone(),settings.clone());')
.replace('core::Core::start(files, memory, history.clone(), session)','core::Core::start(files, memory, history.clone(), session,settings)')
.replace('let app = Router::new()','let stream_stop=core.stream_stop.clone();\n    let app = Router::new()\n        .route("/api/settings",get(live::get_settings).put(live::save_settings))\n        .route("/api/live",get(live::stream))')
.replace('tokio::select! {_=tokio::signal::ctrl_c()=>{},_=stop.cancelled()=>{}}','tokio::select! {_=tokio::signal::ctrl_c()=>{},_=stop.cancelled()=>{}}\n            stream_stop.cancel();'));
