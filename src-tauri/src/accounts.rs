//! Contas do Claude Code e do Antigravity.
//! Claude Code: cada conta é uma pasta de configuração (CLAUDE_CONFIG_DIR) em ~/.lume/claude/<nome> (principal: ~/.claude).
//! Antigravity: cada conta extra abre com --user-data-dir em ~/.lume/antigravity/<nome> (principal: instalação normal do app).
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

fn home() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
}

fn extras_root() -> PathBuf {
    home().join(".lume").join("claude")
}

pub fn extras_root_antigravity() -> PathBuf {
    home().join(".lume").join("antigravity")
}

/// Pasta da conta do Claude; None = principal.
pub fn claude_dir(account: Option<&str>) -> PathBuf {
    match account {
        Some(a) => extras_root().join(a),
        None => home().join(".claude"),
    }
}

/// Todas as contas do Claude: a principal (None) primeiro, depois as extras em ordem alfabética.
pub fn claude_accounts() -> Vec<Option<String>> {
    let mut extra: Vec<String> = fs::read_dir(extras_root())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| valid(n))
        .collect();
    extra.sort();
    std::iter::once(None).chain(extra.into_iter().map(Some)).collect()
}

/// Comando `claude` com a pasta da conta e sem variáveis CLAUDE* herdadas.
pub fn claude_env(cmd: &mut Command, account: Option<&str>) {
    for (k, _) in std::env::vars() {
        if k.to_uppercase().starts_with("CLAUDE") {
            cmd.env_remove(k);
        }
    }
    if account.is_some() {
        cmd.env("CLAUDE_CONFIG_DIR", claude_dir(account));
    }
}

// ---------- Antigravity ----------

/// Pasta de dados do perfil da conta do Antigravity (passada ao Electron via --user-data-dir nas contas extras).
pub fn antigravity_dir(account: Option<&str>) -> PathBuf {
    match account {
        Some(a) => extras_root_antigravity().join(a),
        None => home().join("AppData").join("Roaming").join("Antigravity"),
    }
}

/// Todas as contas do Antigravity: principal (None) primeiro, depois as extras em ordem alfabética.
pub fn antigravity_accounts() -> Vec<Option<String>> {
    let mut extra: Vec<String> = fs::read_dir(extras_root_antigravity())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| valid(n))
        .collect();
    extra.sort();
    std::iter::once(None).chain(extra.into_iter().map(Some)).collect()
}

/// Executável GUI do Antigravity no Windows (prefere Antigravity IDE, senão o Antigravity Hub).
pub fn antigravity_app_exe() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let ide = PathBuf::from(&local)
        .join("Programs")
        .join("Antigravity IDE")
        .join("Antigravity IDE.exe");
    if ide.exists() {
        return Some(ide);
    }
    let hub = PathBuf::from(&local)
        .join("Programs")
        .join("Antigravity")
        .join("Antigravity.exe");
    hub.exists().then_some(hub)
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct AntigravityProcessEntry {
    pub pid: u32,
    pub cmd: String,
    pub parent_cmd: String,
    pub ports: Vec<u16>,
}

/// Escolhe o processo do language_server que pertence à conta (verificando o processo pai Antigravity.exe).
pub fn match_antigravity_server(
    entries: &[AntigravityProcessEntry],
    account: Option<&str>,
) -> Option<AntigravityProcessEntry> {
    entries
        .iter()
        .find(|e| {
            let parent = e.parent_cmd.to_lowercase().replace('/', "\\");
            match account {
                None => {
                    // Instância principal: o processo pai NÃO usa pasta de conta extra em .lume\antigravity
                    !parent.contains(".lume\\antigravity\\")
                }
                Some(name) => {
                    let n = name.to_lowercase();
                    let pattern = format!(".lume\\antigravity\\{n}");
                    parent.contains(&pattern)
                }
            }
        })
        .cloned()
}

/// Salva perfil da conta do Antigravity em cache quando o servidor responder.
pub fn save_antigravity_profile(account: Option<&str>, email: Option<&str>, plan: Option<&str>) {
    let p = match account {
        Some(a) => antigravity_dir(Some(a)).join("profile.json"),
        None => extras_root_antigravity().join("main_profile.json"),
    };
    let _ = fs::create_dir_all(p.parent().unwrap());
    let data = serde_json::json!({
        "email": email,
        "plan": plan,
    });
    let _ = fs::write(p, data.to_string());
}

fn read_antigravity_profile(account: Option<&str>) -> (Option<String>, Option<String>) {
    let p = match account {
        Some(a) => antigravity_dir(Some(a)).join("profile.json"),
        None => extras_root_antigravity().join("main_profile.json"),
    };
    if let Ok(b) = fs::read(p) {
        if let Ok(v) = serde_json::from_slice::<Value>(&b) {
            let email = v["email"].as_str().map(String::from);
            let plan = v["plan"].as_str().map(String::from);
            return (email, plan);
        }
    }
    (None, None)
}

/// Salva a associação de uma conversa com uma conta do Antigravity.
pub fn antigravity_save_session_account(id: &str, account: Option<&str>) {
    let path = extras_root_antigravity().join("session_accounts.json");
    let _ = fs::create_dir_all(extras_root_antigravity());
    let mut map: HashMap<String, Option<String>> = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    map.insert(id.to_string(), account.map(String::from));
    let _ = fs::write(path, serde_json::to_string(&map).unwrap_or_default());
}

/// Recupera a conta de uma conversa do Antigravity.
pub fn antigravity_get_session_account(id: &str) -> Option<String> {
    let path = extras_root_antigravity().join("session_accounts.json");
    if let Ok(b) = fs::read(&path) {
        if let Ok(map) = serde_json::from_slice::<HashMap<String, Option<String>>>(&b) {
            if let Some(acc) = map.get(id) {
                return acc.clone();
            }
        }
    }
    for acc in antigravity_accounts().into_iter().flatten() {
        let storage = antigravity_dir(Some(&acc)).join("app_storage.json");
        if let Ok(txt) = fs::read_to_string(&storage) {
            if txt.contains(id) {
                return Some(acc);
            }
        }
    }
    None
}

#[derive(Serialize)]
pub struct AccountView {
    pub name: Option<String>,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub logged_in: bool,
    pub dir: String,
}

fn claude_view(account: Option<String>) -> AccountView {
    let dir = claude_dir(account.as_deref());
    let profile = match account {
        Some(_) => dir.join(".claude.json"),
        None => home().join(".claude.json"),
    };
    let read = |p: PathBuf| fs::read(p).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let creds = read(dir.join(".credentials.json"));
    AccountView {
        email: read(profile).and_then(|v| v["oauthAccount"]["emailAddress"].as_str().map(String::from)),
        plan: creds.as_ref().and_then(|c| c["claudeAiOauth"]["subscriptionType"].as_str().map(String::from)),
        logged_in: creds.is_some(),
        dir: dir.to_string_lossy().into_owned(),
        name: account,
    }
}

fn antigravity_view(account: Option<String>) -> AccountView {
    let dir = antigravity_dir(account.as_deref());
    let (cached_email, cached_plan) = read_antigravity_profile(account.as_deref());
    // Se a janela estiver aberta e o language server responder, está conectado
    let server_active = crate::usage::antigravity_server(account.as_deref()).is_ok();
    let has_files = dir.exists();
    AccountView {
        name: account,
        email: cached_email,
        plan: cached_plan,
        logged_in: server_active || has_files,
        dir: dir.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub async fn claude_accounts_list() -> Vec<AccountView> {
    claude_accounts().into_iter().map(claude_view).collect()
}

#[tauri::command]
pub async fn antigravity_accounts_list() -> Vec<AccountView> {
    antigravity_accounts().into_iter().map(antigravity_view).collect()
}

pub fn valid(name: &str) -> bool {
    (1..=32).contains(&name.len()) && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Abre um console com `claude auth login` na pasta da conta; o login termina no navegador.
#[tauri::command]
pub async fn claude_account_login(account: Option<String>) -> Result<(), String> {
    if account.as_deref().is_some_and(|a| !valid(a) || !claude_dir(Some(a)).is_dir()) {
        return Err("conta desconhecida".into());
    }
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "start", "Login do Claude Code", "cmd", "/k", "claude", "auth", "login"]);
    claude_env(&mut cmd, account.as_deref());
    cmd.spawn().map(|_| ()).map_err(|e| format!("não consegui abrir o login: {e}"))
}

#[tauri::command]
pub async fn claude_account_add(name: String) -> Result<(), String> {
    if !valid(&name) {
        return Err("use só letras minúsculas, números e hífen (até 32)".into());
    }
    let dir = claude_dir(Some(&name));
    if dir.exists() {
        return Err("já existe uma conta com esse nome".into());
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    claude_account_login(Some(name)).await
}

/// Abre a janela do Antigravity para a conta informada (ou a principal se None).
#[tauri::command]
pub async fn antigravity_account_login(account: Option<String>) -> Result<(), String> {
    if account.as_deref().is_some_and(|a| !valid(a) || !antigravity_dir(Some(a)).is_dir()) {
        return Err("conta desconhecida".into());
    }
    let exe = antigravity_app_exe().ok_or("não achei o executável do Antigravity")?;
    let mut cmd = Command::new(&exe);
    if let Some(a) = account.as_deref() {
        let dir = antigravity_dir(Some(a));
        cmd.arg(format!("--user-data-dir={}", dir.display()));
    }
    cmd.arg("--new-window");
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("não consegui abrir o Antigravity: {e}"))
}

#[tauri::command]
pub async fn antigravity_account_add(name: String) -> Result<(), String> {
    if !valid(&name) {
        return Err("use só letras minúsculas, números e hífen (até 32)".into());
    }
    let dir = antigravity_dir(Some(&name));
    if dir.exists() {
        return Err("já existe uma conta com esse nome".into());
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    antigravity_account_login(Some(name)).await
}

#[tauri::command]
pub fn claude_account_remove(name: String) -> Result<(), String> {
    if !valid(&name) {
        return Err("nome de conta inválido".into());
    }
    let dir = claude_dir(Some(&name));
    if !dir.exists() {
        return Err("conta não encontrada".into());
    }
    fs::remove_dir_all(&dir)
        .map_err(|e| format!("não consegui remover a pasta da conta (feche o terminal se estiver aberto): {e}"))
}

#[tauri::command]
pub fn antigravity_account_remove(name: String) -> Result<(), String> {
    if !valid(&name) {
        return Err("nome de conta inválido".into());
    }
    let dir = antigravity_dir(Some(&name));
    if !dir.exists() {
        return Err("conta não encontrada".into());
    }
    fs::remove_dir_all(&dir)
        .map_err(|e| format!("não consegui remover a pasta da conta (feche a janela do Antigravity se estiver aberta): {e}"))?;

    // Limpa associações dessa conta em session_accounts.json
    let path = extras_root_antigravity().join("session_accounts.json");
    if let Ok(b) = fs::read(&path) {
        if let Ok(mut map) = serde_json::from_slice::<HashMap<String, Option<String>>>(&b) {
            map.retain(|_, acc| acc.as_deref() != Some(&name));
            let _ = fs::write(path, serde_json::to_string(&map).unwrap_or_default());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nomes_de_conta() {
        assert!(valid("trabalho-2"));
        assert!(!valid("Trabalho"));
        assert!(!valid("../fora"));
        assert!(!valid(""));
    }

    #[test]
    fn remove_conta_invalida_ou_inexistente() {
        assert!(claude_account_remove("../fora".into()).is_err());
        assert!(claude_account_remove("conta-que-nunca-existiu-12345".into()).is_err());
        assert!(antigravity_account_remove("../fora".into()).is_err());
        assert!(antigravity_account_remove("conta-que-nunca-existiu-12345".into()).is_err());
    }

    #[test]
    fn escolhe_servidor_por_conta() {
        let entries = vec![
            AntigravityProcessEntry {
                pid: 1001,
                cmd: "language_server.exe --app_data_dir antigravity --csrf_token t1".into(),
                parent_cmd: r#""C:\Programs\Antigravity\Antigravity.exe" "#.into(),
                ports: vec![5001, 5002],
            },
            AntigravityProcessEntry {
                pid: 1002,
                cmd: "language_server.exe --app_data_dir antigravity --csrf_token t2".into(),
                parent_cmd: r#"C:\Programs\Antigravity\Antigravity.exe --user-data-dir=C:\Users\foo\.lume\antigravity\teste"#.into(),
                ports: vec![6001, 6002],
            },
        ];

        // Principal: escolhe o processo pai sem pasta de conta extra em .lume
        let main_server = match_antigravity_server(&entries, None);
        assert!(main_server.is_some());
        assert_eq!(main_server.unwrap().pid, 1001);

        // Conta extra 'teste': escolhe o processo pai com a pasta correspondente
        let extra_server = match_antigravity_server(&entries, Some("teste"));
        assert!(extra_server.is_some());
        assert_eq!(extra_server.unwrap().pid, 1002);

        // Conta inexistente: retorna None
        let not_found = match_antigravity_server(&entries, Some("outra"));
        assert!(not_found.is_none());
    }
}
