use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, RwLock},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub collector_interval_ms: u64,
    pub history_flush_ms: u64,
    pub history_batch_kib: usize,
    pub record_window_changes: bool,
    pub record_clipboard_changes: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            collector_interval_ms: 2000,
            history_flush_ms: 30000,
            history_batch_kib: 256,
            record_window_changes: true,
            record_clipboard_changes: true,
        }
    }
}
impl Settings {
    fn validate(&self) -> Result<(), String> {
        if !(50..=60000).contains(&self.collector_interval_ms) {
            return Err("Coleta: use entre 50 e 60000 ms".into());
        }
        if !(1000..=300000).contains(&self.history_flush_ms) {
            return Err("Gravação: use entre 1000 e 300000 ms".into());
        }
        if !(64..=1024).contains(&self.history_batch_kib) {
            return Err("Lote: use entre 64 e 1024 KiB".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Versioned {
    pub revision: u64,
    pub values: Settings,
}
pub struct Store {
    path: Option<PathBuf>,
    value: RwLock<Versioned>,
    writer: Mutex<()>,
}
impl Store {
    pub fn load(path: Option<PathBuf>) -> Result<Self, String> {
        let value = match path.as_ref().filter(|p| p.exists()) {
            Some(p) => {
                serde_json::from_slice::<Versioned>(&fs::read(p).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?
            }
            None => Versioned {
                revision: 0,
                values: Settings::default(),
            },
        };
        value.values.validate()?;
        Ok(Self {
            path,
            value: RwLock::new(value),
            writer: Mutex::new(()),
        })
    }
    pub fn get(&self) -> Versioned {
        self.value.read().unwrap().clone()
    }
    pub fn save(&self, input: Versioned) -> Result<Versioned, String> {
        input.values.validate()?;
        let _lock = self.writer.lock().unwrap();
        if input.revision != self.get().revision {
            return Err("CONFLICT: as configurações mudaram; recarregue antes de salvar".into());
        }
        let next = Versioned {
            revision: input.revision.checked_add(1).ok_or("Revision overflow")?,
            values: input.values,
        };
        if let Some(path) = &self.path {
            let pending = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
            fs::write(
                &pending,
                serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            if let Err(e) = fs::rename(&pending, path) {
                let _ = fs::remove_file(pending);
                return Err(e.to_string());
            }
        }
        *self.value.write().unwrap() = next.clone();
        Ok(next)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_persists_and_rejects_stale_updates() {
        let p = std::env::temp_dir().join(format!("nervo-settings-{}.json", uuid::Uuid::new_v4()));
        let s = Store::load(Some(p.clone())).unwrap();
        let mut first = s.get();
        first.values.collector_interval_ms = 100;
        let saved = s.save(first.clone()).unwrap();
        assert_eq!(saved.revision, 1);
        assert!(s.save(first).is_err());
        let loaded = Store::load(Some(p.clone())).unwrap();
        assert_eq!(loaded.get().values.collector_interval_ms, 100);
        let mut invalid = s.get();
        invalid.values.collector_interval_ms = 0;
        assert!(s.save(invalid).is_err());
        assert_eq!(s.get().values.collector_interval_ms, 100);
        fs::remove_file(p).unwrap();
    }
}
