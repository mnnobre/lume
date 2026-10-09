//! Uso do plano de cada IA, pelo mesmo caminho que os apps e os projetos de referência usam
//! (CodexBar, ClaudeBar, usage-kun):
//! - Claude: GET api.anthropic.com/api/oauth/usage com o login do Claude Code (~/.claude/.credentials.json)
//! - Codex: `account/rateLimits/read` no codex app-server (protocolo oficial)
//! - Antigravity: `RetrieveUserQuotaSummary` no language server local do app (porta + CSRF da linha de comando)
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::live::Live;
use crate::sessions::hidden;

#[derive(Serialize, Clone)]
pub struct Window {
    label: String,
    used: f64,              // 0–100
    resets_at: Option<i64>, // ms
}

#[derive(Serialize, Clone)]
pub struct Report {
    provider: &'static str,
    plan: Option<String>,
    windows: Vec<Window>,
    error: Option<String>,
}

fn ms_from_iso(s: Option<&str>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s?)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("cliente http")
}

// ---------- Claude ----------

async fn claude() -> Result<Report, String> {
    let path = dirs_home().join(".claude").join(".credentials.json");
    let creds: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).map_err(|_| "faça `claude auth login` para ver o uso")?,
    )
    .map_err(|e| e.to_string())?;
    let oauth = &creds["claudeAiOauth"];
    let token = oauth["accessToken"]
        .as_str()
        .ok_or("faça `claude auth login` para ver o uso")?;
    if oauth["expiresAt"]
        .as_i64()
        .is_some_and(|exp| exp < chrono::Utc::now().timestamp_millis())
    {
        // ponytail: não renova o token sozinho; o Claude Code renova na próxima vez que rodar
        return Err(
            "login do Claude Code expirou; abra uma conversa do Claude para renovar".into(),
        );
    }
    let r: Value = http()
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let mut windows = vec![];
    for (key, label) in [
        ("five_hour", "Sessão (5 h)"),
        ("seven_day", "Semanal"),
        ("seven_day_opus", "Semanal · Opus"),
        ("seven_day_sonnet", "Semanal · Sonnet"),
    ] {
        if let Some(used) = r[key]["utilization"].as_f64() {
            windows.push(Window {
                label: label.into(),
                used,
                resets_at: ms_from_iso(r[key]["resets_at"].as_str()),
            });
        }
    }
    let plan = oauth["subscriptionType"]
        .as_str()
        .map(|p| p[..1].to_uppercase() + &p[1..]);
    Ok(Report {
        provider: "claude",
        plan,
        windows,
        error: None,
    })
}

fn dirs_home() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
}

// ---------- Codex ----------

fn codex_window(w: &Value) -> Option<Window> {
    let used = w["usedPercent"].as_f64()?;
    let label = match w["windowDurationMins"].as_i64() {
        Some(300) => "5 horas".to_string(),
        Some(10080) => "Semanal".to_string(),
        Some(m) if m % 1440 == 0 => format!("{} dias", m / 1440),
        Some(m) => format!("{} h", m / 60),
        None => "Limite".to_string(),
    };
    Some(Window {
        label,
        used,
        resets_at: w["resetsAt"].as_i64().map(|s| s * 1000),
    })
}

fn codex(app: &AppHandle, live: &Live) -> Result<Report, String> {
    let r = crate::live::codex_request(app, live, "account/rateLimits/read", json!({}))?;
    let buckets: Vec<(&str, &Value)> = match r["rateLimitsByLimitId"]
        .as_object()
        .filter(|m| !m.is_empty())
    {
        Some(m) => m.iter().map(|(k, v)| (k.as_str(), v)).collect(),
        None => vec![("codex", &r["rateLimits"])],
    };
    let mut windows = Vec::new();
    for (id, bucket) in &buckets {
        for w in [&bucket["primary"], &bucket["secondary"]]
            .into_iter()
            .filter_map(codex_window)
        {
            windows.push(Window {
                label: if buckets.len() > 1 {
                    format!(
                        "{} · {}",
                        bucket["limitName"].as_str().unwrap_or(id),
                        w.label
                    )
                } else {
                    w.label
                },
                ..w
            });
        }
    }
    let plan = buckets
        .iter()
        .find_map(|(_, b)| b["planType"].as_str())
        .map(String::from);
    Ok(Report {
        provider: "codex",
        plan,
        windows,
        error: None,
    })
}

// ---------- Antigravity ----------

/// Acha o language server do app (não o da IDE), o token CSRF e as portas em que ele escuta.
/// No Windows ele sobe com --https_server_port 0, então as portas vêm do sistema, não da linha de comando.
pub fn antigravity_server() -> Result<(String, Vec<u16>), String> {
    let ps = r#"$p = Get-CimInstance Win32_Process -Filter "Name='language_server.exe'" | Where-Object { $_.CommandLine -match '--app_data_dir[= ]antigravity(\s|$)' } | Select-Object -First 1
if ($p) { [pscustomobject]@{ cmd = $p.CommandLine; ports = @((Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue).LocalPort) } | ConvertTo-Json -Compress }"#;
    let out = hidden(Command::new("powershell").args(["-NoProfile", "-Command", ps]))
        .output()
        .map_err(|e| e.to_string())?;
    let v: Value =
        serde_json::from_slice(&out.stdout).map_err(|_| "abra o Antigravity para ver o uso")?;
    let cmd = v["cmd"].as_str().unwrap_or_default();
    let token = cmd
        .split_whitespace()
        .collect::<Vec<_>>()
        .windows(2)
        .find_map(|w| match w[0] {
            "--csrf_token" => Some(w[1].to_string()),
            s if s.starts_with("--csrf_token=") => Some(s["--csrf_token=".len()..].to_string()),
            _ => None,
        })
        .ok_or("não achei o token do Antigravity")?;
    let ports = match &v["ports"] {
        Value::Array(a) => a
            .iter()
            .filter_map(|p| p.as_u64().map(|n| n as u16))
            .collect(),
        p => p.as_u64().map(|n| vec![n as u16]).unwrap_or_default(),
    };
    Ok((token, ports))
}

pub fn antigravity_cancel(id: &str) -> Result<(), String> {
    let (token, ports) = antigravity_server()?;
    let client = http();
    for port in ports {
        let url =
            format!("http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/CancelCascadeInvocation");
        let body = json!({
            "metadata": {"ideName": "antigravity", "extensionName": "antigravity", "locale": "en", "ideVersion": "unknown"},
            "cascadeId": id,
            "conversationId": id,
        });
        let _ = client
            .post(url)
            .header("X-Codeium-Csrf-Token", &token)
            .header("Connect-Protocol-Version", "1")
            .json(&body)
            .send();
    }
    Ok(())
}

pub fn antigravity_focus(id: &str) -> Result<(), String> {
    let (token, ports) = antigravity_server()?;
    let client = http();
    for port in ports {
        let url =
            format!("http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/SmartFocusConversation");
        let body = json!({
            "metadata": {"ideName": "antigravity", "extensionName": "antigravity", "locale": "en", "ideVersion": "unknown"},
            "cascadeId": id,
            "conversationId": id,
        });
        let _ = client
            .post(url)
            .header("X-Codeium-Csrf-Token", &token)
            .header("Connect-Protocol-Version", "1")
            .json(&body)
            .send();
    }
    Ok(())
}

async fn agy_call(client: &reqwest::Client, port: u16, token: &str, method: &str) -> Option<Value> {
    // uma das portas fala HTTP simples no loopback; a outra é HTTPS com certificado próprio
    let url =
        format!("http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{method}");
    let body = json!({"metadata": {"ideName": "antigravity", "extensionName": "antigravity", "locale": "en", "ideVersion": "unknown"}});
    let r = client
        .post(url)
        .header("X-Codeium-Csrf-Token", token)
        .header("Connect-Protocol-Version", "1")
        .json(&body)
        .send()
        .await
        .ok()?;
    r.status().is_success().then_some(())?;
    r.json().await.ok()
}

async fn antigravity() -> Result<Report, String> {
    let (token, ports) = tokio_blocking(antigravity_server).await?;
    let client = http();
    for port in ports {
        let Some(summary) = agy_call(&client, port, &token, "RetrieveUserQuotaSummary").await
        else {
            continue;
        };
        let mut windows = vec![];
        for g in summary["response"]["groups"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let group = match g["displayName"].as_str().unwrap_or_default() {
                n if n.contains("Gemini") => "Gemini",
                n if n.contains("Claude") => "Claude + GPT",
                n => n,
            }
            .to_string();
            for b in g["buckets"].as_array().into_iter().flatten() {
                let Some(left) = b["remainingFraction"]
                    .as_f64()
                    .or(b["remaining"]["remainingFraction"].as_f64())
                else {
                    continue;
                };
                let window = if b["window"] == "weekly" {
                    "semanal"
                } else {
                    "5 h"
                };
                windows.push(Window {
                    label: format!("{group} · {window}"),
                    used: ((1.0 - left) * 100.0).clamp(0.0, 100.0),
                    resets_at: ms_from_iso(b["resetTime"].as_str()),
                });
            }
        }
        let plan = agy_call(&client, port, &token, "GetUserStatus")
            .await
            .and_then(|s| {
                s["userStatus"]["planStatus"]["planInfo"]["planName"]
                    .as_str()
                    .map(String::from)
            });
        return Ok(Report {
            provider: "antigravity",
            plan,
            windows,
            error: None,
        });
    }
    Err("o Antigravity não respondeu; abra o app".into())
}

async fn tokio_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn failed(provider: &'static str, error: String) -> Report {
    Report {
        provider,
        plan: None,
        windows: vec![],
        error: Some(error),
    }
}

#[tauri::command]
pub async fn usage(app: AppHandle) -> Result<Vec<Report>, String> {
    use tauri::Manager;
    // os três em paralelo; o Codex conversa com o app-server (bloqueante), então vai para uma thread própria
    let c = tauri::async_runtime::spawn(claude());
    let a = tauri::async_runtime::spawn(antigravity());
    let x = tokio_blocking(move || codex(&app, &app.state::<Live>()));
    let x = x.await;
    let join = |r: Result<Result<Report, String>, tauri::Error>| {
        r.map_err(|e| e.to_string()).and_then(|r| r)
    };
    Ok(vec![
        join(c.await).unwrap_or_else(|e| failed("claude", e)),
        x.unwrap_or_else(|e| failed("codex", e)),
        join(a.await).unwrap_or_else(|e| failed("antigravity", e)),
    ])
}

#[cfg(test)]
mod real {
    /// Bate nas fontes reais: cargo test --lib uso_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn uso_real() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        for r in tauri::async_runtime::block_on(async {
            [super::claude().await, super::antigravity().await]
        }) {
            match r {
                Ok(r) => {
                    println!("{} plano={:?}", r.provider, r.plan);
                    for w in &r.windows {
                        println!(
                            "   {:<22} {:>5.1}%  reset={:?}",
                            w.label, w.used, w.resets_at
                        );
                    }
                    assert!(!r.windows.is_empty());
                }
                Err(e) => panic!("{e}"),
            }
        }
    }
}
