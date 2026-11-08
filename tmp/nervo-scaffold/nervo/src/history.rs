use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs,
    io::{BufWriter, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, SyncSender},
    },
    time::{Duration, Instant},
};

const MAX_PENDING: usize = 4 * 1024 * 1024;

const RECENT_COUNT: usize = 500;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_events_keep_order_and_flush_on_stop() {
        let root = std::env::temp_dir().join(format!("nervo-history-{}", uuid::Uuid::new_v4()));
        let (h, writer) = History::start(
            root.clone(),
            "test".into(),
            Arc::new(crate::settings::Store::load(None).unwrap()),
        );
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let h = h.clone();
                std::thread::spawn(move || {
                    for _ in 0..25 {
                        h.record("test", "test", json!({}));
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let data = h.read(0, 200);
        let events = data["items"].as_array().unwrap();
        assert_eq!(events.len(), 100);
        for (i, event) in events.iter().enumerate() {
            assert_eq!(event["sequence"], (i + 1) as u64);
        }
        h.stopping.store(true, Ordering::Relaxed);
        writer.join().unwrap();
        assert_eq!(h.persisted.load(Ordering::Relaxed), 100);
        assert_eq!(h.pending.load(Ordering::Relaxed), 0);
        // Remove only exact files created by this test, without recursive deletion.
        for date in fs::read_dir(root.join("journal")).unwrap() {
            let dir = date.unwrap().path();
            for file in fs::read_dir(&dir).unwrap() {
                fs::remove_file(file.unwrap().path()).unwrap();
            }
            fs::remove_dir(dir).unwrap();
        }
        fs::remove_dir(root.join("journal")).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn failed_disk_write_keeps_events_and_reports_error() {
        let root = std::env::temp_dir().join(format!("nervo-blocked-{}", uuid::Uuid::new_v4()));
        fs::write(&root, "not a directory").unwrap();
        let (h, writer) = History::start(
            root.clone(),
            "test".into(),
            Arc::new(crate::settings::Store::load(None).unwrap()),
        );
        h.record("test", "test", json!({}));
        h.stopping.store(true, Ordering::Relaxed);
        writer.join().unwrap();
        assert!(h.last_error.lock().unwrap().is_some());
        assert!(h.pending.load(Ordering::Relaxed) > 0);
        assert_eq!(h.persisted.load(Ordering::Relaxed), 0);
        assert_eq!(h.read(0, 10)["items"].as_array().unwrap().len(), 1);
        fs::remove_file(root).unwrap();
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub sequence: u64,
    pub at: String,
    pub kind: String,
    pub source: String,
    pub data: Value,
}
pub struct History {
    settings: Arc<crate::settings::Store>,
    pub root: PathBuf,
    session: String,
    sequence: AtomicU64,
    tx: SyncSender<(Event, usize)>,
    recent: Mutex<VecDeque<Event>>,
    pub pending: AtomicUsize,
    pub dropped: AtomicU64,
    pub persisted: AtomicU64,
    pub batches: AtomicU64,
    pub last_error: Mutex<Option<String>>,
    pub last_flush: Mutex<Option<String>>,
    pub stopping: AtomicBool,
}
impl History {
    pub fn start(
        root: PathBuf,
        session: String,
        settings: Arc<crate::settings::Store>,
    ) -> (Arc<Self>, std::thread::JoinHandle<()>) {
        let (tx, rx) = mpsc::sync_channel(2048);
        let h = Arc::new(Self {
            settings,
            root,
            session,
            sequence: AtomicU64::new(0),
            tx,
            recent: Mutex::new(VecDeque::new()),
            pending: AtomicUsize::new(0),
            dropped: AtomicU64::new(0),
            persisted: AtomicU64::new(0),
            batches: AtomicU64::new(0),
            last_error: Mutex::new(None),
            last_flush: Mutex::new(None),
            stopping: AtomicBool::new(false),
        });
        let worker = h.clone();
        let handle = std::thread::Builder::new()
            .name("nervo-journal".into())
            .spawn(move || {
                let mut batch = Vec::new();
                let mut bytes = 0;
                let mut last = Instant::now();
                let mut failed = false;
                loop {
                    match rx.recv_timeout(Duration::from_millis(250)) {
                        Ok((e, n)) => {
                            batch.push(e);
                            bytes += n;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(_) => {}
                    }
                    let stop = worker.stopping.load(Ordering::Relaxed);
                    if stop {
                        while let Ok((e, n)) = rx.try_recv() {
                            batch.push(e);
                            bytes += n;
                        }
                    }
                    if !batch.is_empty()
                        && ((!failed
                            && bytes >= worker.settings.get().values.history_batch_kib * 1024)
                            || last.elapsed()
                                >= Duration::from_millis(if failed {
                                    30000
                                } else {
                                    worker.settings.get().values.history_flush_ms
                                })
                            || stop)
                    {
                        match worker.persist(&batch) {
                            Ok(()) => {
                                failed = false;
                                worker.pending.fetch_sub(bytes, Ordering::Relaxed);
                                worker
                                    .persisted
                                    .fetch_add(batch.len() as u64, Ordering::Relaxed);
                                worker.batches.fetch_add(1, Ordering::Relaxed);
                                *worker.last_flush.lock().unwrap() = Some(Utc::now().to_rfc3339());
                                *worker.last_error.lock().unwrap() = None;
                                batch.clear();
                                bytes = 0;
                            }
                            Err(e) => {
                                failed = true;
                                *worker.last_error.lock().unwrap() = Some(e.to_string());
                            }
                        }
                        last = Instant::now();
                    }
                    if stop {
                        break;
                    }
                }
            })
            .expect("journal worker");
        (h, handle)
    }
    pub fn record(&self, kind: &str, source: &str, data: Value) {
        let mut recent = self.recent.lock().unwrap();
        let seq = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let event = Event {
            id: format!("{}:{seq}", self.session),
            sequence: seq,
            at: Utc::now().to_rfc3339(),
            kind: kind.into(),
            source: source.into(),
            data,
        };
        let n = serde_json::to_vec(&event)
            .map(|v| v.len() + 64)
            .unwrap_or(MAX_PENDING + 1);
        recent.push_back(event.clone());
        while recent.len() > RECENT_COUNT {
            recent.pop_front();
        }
        if self
            .pending
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| {
                v.checked_add(n).filter(|&x| x <= MAX_PENDING)
            })
            .is_err()
        {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if self.tx.try_send((event, n)).is_err() {
            self.pending.fetch_sub(n, Ordering::Relaxed);
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
    pub fn read(&self, after: u64, limit: usize) -> Value {
        let recent = self.recent.lock().unwrap();
        let first = recent.front().map(|e| e.sequence).unwrap_or(0);
        let events: Vec<_> = recent
            .iter()
            .filter(|e| e.sequence > after)
            .take(limit.min(200))
            .cloned()
            .collect();
        let next = events.last().map(|e| e.sequence).unwrap_or(after);
        json!({"items":events,"next_cursor":next,"session_id":self.session,"gap":first>after.saturating_add(1),"oldest_available":first,"persistence_dropped":self.dropped.load(Ordering::Relaxed)})
    }
    pub fn stats(&self) -> Value {
        json!({"pending_bytes":self.pending.load(Ordering::Relaxed),"queue_limit_bytes":MAX_PENDING,"persisted_events":self.persisted.load(Ordering::Relaxed),"batches":self.batches.load(Ordering::Relaxed),"dropped_events":self.dropped.load(Ordering::Relaxed),"last_error":*self.last_error.lock().unwrap(),"last_flush_at":*self.last_flush.lock().unwrap(),"flush_interval_seconds":self.settings.get().values.history_flush_ms as f64/1000.0,"flush_interval_ms":self.settings.get().values.history_flush_ms,"batch_threshold_bytes":self.settings.get().values.history_batch_kib*1024,"durability":"Windows buffered I/O; no physical sync per batch"})
    }
    fn persist(&self, events: &[Event]) -> std::io::Result<()> {
        let date = &events[0].at[..10];
        let dir = self.root.join("journal").join(date);
        fs::create_dir_all(&dir)?;
        let stem = format!(
            "{}-{:08}-{:08}",
            self.session,
            events[0].sequence,
            events.last().unwrap().sequence
        );
        let target = dir.join(format!("{stem}.md"));
        let pending = dir.join(format!("{stem}.pending"));
        let mut out = BufWriter::new(fs::File::create(&pending)?);
        writeln!(
            out,
            "---\nschema_version: 1\nkind: event_batch\nsession_id: {}\nrecorded_timezone: UTC\n---\n",
            self.session
        )?;
        for e in events {
            writeln!(
                out,
                "## {}\n\n```json\n{}\n```\n",
                e.id,
                serde_json::to_string(e)?
            )?;
        }
        out.flush()?;
        drop(out);
        fs::rename(pending, target)?;
        Ok(())
    }
}
