use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
pub struct Files {
    pub root: PathBuf,
    write_lock: Mutex<()>,
}
pub fn version(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
impl Files {
    pub fn new(root: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&root)?;
        Ok(Self {
            root: root.canonicalize()?,
            write_lock: Mutex::new(()),
        })
    }
    pub fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        let p = Path::new(path);
        for component in p.components() {
            match component {
                Component::Normal(n) => {
                    let name = n.to_string_lossy();
                    let stem = name.split('.').next().unwrap_or("").to_uppercase();
                    if name.contains(':')
                        || name.ends_with('.')
                        || name.ends_with(' ')
                        || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
                        || (stem.len() == 4
                            && (stem.starts_with("COM") || stem.starts_with("LPT"))
                            && stem.as_bytes()[3].is_ascii_digit())
                    {
                        return Err("INVALID_PATH: nome de arquivo não permitido".into());
                    }
                }
                Component::CurDir => {}
                _ => {
                    return Err(
                        "OUTSIDE_WORKSPACE: use um caminho relativo à pasta de trabalho".into(),
                    );
                }
            }
        }
        let target = self.root.join(p);
        let mut ancestor = target.as_path();
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or("INVALID_PATH")?;
        }
        let resolved = ancestor.canonicalize().map_err(|e| e.to_string())?;
        if !resolved.starts_with(&self.root) {
            return Err("OUTSIDE_WORKSPACE: link ou junction sai da pasta de trabalho".into());
        }
        Ok(target)
    }
    pub fn list(&self, path: &str, offset: usize, limit: usize) -> Result<Value, String> {
        let target = self.resolve(path)?;
        let iter = fs::read_dir(target).map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        let mut cut = false;
        for entry in iter {
            let e = entry.map_err(|e| e.to_string())?;
            let m = e.metadata().map_err(|e| e.to_string())?;
            entries.push(json!({"name":e.file_name().to_string_lossy(),"path":Path::new(path).join(e.file_name()).to_string_lossy(),"directory":m.is_dir(),"bytes":m.len()}));
            if entries.len() >= 10000 {
                cut = true;
                break;
            }
        }
        entries.sort_by_key(|v| {
            (
                !v["directory"].as_bool().unwrap_or(false),
                v["name"].as_str().unwrap_or("").to_lowercase(),
            )
        });
        let total = entries.len();
        let items: Vec<_> = entries.into_iter().skip(offset).take(limit).collect();
        Ok(
            json!({"path":path,"items":items,"total":total,"truncated":cut,"next_cursor":(offset+limit<total).then_some(offset+limit)}),
        )
    }
    pub fn read(&self, path: &str) -> Result<Value, String> {
        self.read_chunk(path, 0)
    }
    pub fn read_chunk(&self, path: &str, offset: u64) -> Result<Value, String> {
        let target = self.resolve(path)?;
        let mut file = fs::File::open(&target).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        if offset > size {
            return Err("INVALID_ARGUMENT: byte_offset excede o arquivo".into());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(65537)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let truncated = bytes.len() > 65536;
        if truncated {
            bytes.truncate(65536);
        }
        if truncated
            && let Err(e) = std::str::from_utf8(&bytes)
            && e.error_len().is_none()
        {
            bytes.truncate(e.valid_up_to());
        }
        let next = offset + bytes.len() as u64;
        let ver = (!truncated && offset == 0).then(|| version(&bytes));
        let text = String::from_utf8_lossy(&bytes).into_owned();
        Ok(
            json!({"path":path,"text":text,"bytes":size,"version":ver,"truncated":truncated,"byte_offset":offset,"next_byte_offset":(next<size).then_some(next),"encoding":"utf-8 (invalid sequences replaced)"}),
        )
    }
    pub fn mkdir(&self, path: &str) -> Result<Value, String> {
        let _lock = self.write_lock.lock().map_err(|_| "LOCK_ERROR")?;
        let target = self.resolve(path)?;
        let exists = target.exists();
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        Ok(json!({"path":path,"created":!exists,"verified":target.is_dir()}))
    }
    pub fn write(
        &self,
        path: &str,
        content: &str,
        expected: Option<&str>,
    ) -> Result<Value, String> {
        if content.len() > 65536 {
            return Err("TOO_LARGE: limite de 64 KiB por escrita".into());
        }
        let _lock = self.write_lock.lock().map_err(|_| "LOCK_ERROR")?;
        let target = self.resolve(path)?;
        if target == self.root {
            return Err("INVALID_PATH".into());
        }
        let exists = target.exists();
        if exists {
            let requested = expected
                .ok_or("VERSION_REQUIRED: leia o arquivo e envie expected_version para alterar")?;
            let current = self.read(path)?;
            if current["version"].as_str() != Some(requested) {
                return Err(
                    "VERSION_CONFLICT: o arquivo mudou ou excede o limite de edição".into(),
                );
            }
        } else if expected.is_some() {
            return Err("VERSION_CONFLICT: arquivo não existe".into());
        }
        let parent = target.parent().ok_or("INVALID_PATH")?;
        if !parent.is_dir() {
            return Err("PARENT_NOT_FOUND: crie a pasta primeiro".into());
        }
        if !exists {
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|e| e.to_string())?;
            file.write_all(content.as_bytes())
                .map_err(|e| e.to_string())?;
        } else {
            let temp = parent.join(format!(".nervo-{}.tmp", uuid::Uuid::new_v4()));
            fs::write(&temp, content).map_err(|e| e.to_string())?;
            if let Err(e) = fs::rename(&temp, &target) {
                let _ = fs::remove_file(temp);
                return Err(e.to_string());
            }
        }
        let actual = fs::read(&target).map_err(|e| e.to_string())?;
        if actual != content.as_bytes() {
            return Err("VERIFICATION_FAILED: conteúdo mudou após a escrita".into());
        }
        Ok(
            json!({"path":path,"created":!exists,"bytes_written":content.len(),"version":version(&actual),"verification":"read_back_compare","durability":"buffered"}),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> Files {
        Files::new(std::env::temp_dir().join(format!("nervo-test-{}", uuid::Uuid::new_v4())))
            .unwrap()
    }
    #[test]
    fn blocks_escape_and_device_paths() {
        let f = setup();
        for path in ["../secret", "C:\\secret", "file:stream", "NUL.txt", "foo."] {
            assert!(f.resolve(path).is_err(), "{path}");
        }
        fs::remove_dir(&f.root).unwrap();
    }
    #[test]
    fn prevents_lost_updates() {
        let f = setup();
        let a = f.write("test.md", "one", None).unwrap();
        assert!(f.write("test.md", "two", None).is_err());
        assert!(f.write("test.md", "two", Some("stale")).is_err());
        f.write("test.md", "two", a["version"].as_str()).unwrap();
        assert_eq!(f.read("test.md").unwrap()["text"], "two");
        fs::remove_file(f.root.join("test.md")).unwrap();
        fs::remove_dir(&f.root).unwrap();
    }
    #[test]
    fn chunked_read_preserves_utf8() {
        let f = setup();
        let text = format!("{}áfim", "a".repeat(65535));
        fs::write(f.root.join("large.md"), &text).unwrap();
        let first = f.read("large.md").unwrap();
        assert!(first["truncated"].as_bool().unwrap());
        let second = f
            .read_chunk("large.md", first["next_byte_offset"].as_u64().unwrap())
            .unwrap();
        assert_eq!(
            format!(
                "{}{}",
                first["text"].as_str().unwrap(),
                second["text"].as_str().unwrap()
            ),
            text
        );
        assert!(second["next_byte_offset"].is_null());
        fs::remove_file(f.root.join("large.md")).unwrap();
        fs::remove_dir(&f.root).unwrap();
    }
}
