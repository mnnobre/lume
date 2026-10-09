//! Versões dos harness: o que está instalado, o que há de mais novo e como atualizar.
//! Os apps desktop (Claude, Codex, Antigravity) se atualizam sozinhos: o Lume mostra a versão e avisa
//! quando ela muda. As CLIs podem ficar para trás sem você notar: compara com o npm e atualiza por aqui.
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::sessions::hidden;

#[derive(Serialize, Clone)]
pub struct Harness {
    id: &'static str,
    name: &'static str,
    installed: Option<String>,
    latest: Option<String>,
    detail: Option<String>, // ex.: versão do Claude Code embutido no app
    auto: bool,             // o próprio app se atualiza
    can_update: bool,       // o Lume sabe atualizar (CLI)
    outdated: bool,         // a versão comparada (CLI ou runtime) é menor que a mais nova
    #[serde(skip)]
    compare: Option<String>, // o que comparar com `latest` (no Codex é o runtime, não o app)
}

/// "0.162.0-alpha.2" -> [0,162,0]; pré-release da mesma versão não conta como atrasada.
fn base(v: &str) -> Vec<u64> {
    v.split(['-', '+'])
        .next()
        .unwrap_or(v)
        .split('.')
        .filter_map(|p| p.parse().ok())
        .collect()
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = hidden(Command::new(cmd).args(args)).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn ps(script: &str) -> Option<String> {
    run("powershell", &["-NoProfile", "-Command", script]).filter(|s| !s.is_empty())
}

/// "2.1.193 (Claude Code)" / "codex-cli 0.162.0-alpha.2" -> "2.1.193" / "0.162.0-alpha.2"
fn version_in(s: &str) -> Option<String> {
    s.split_whitespace()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()) && w.contains('.'))
        .map(String::from)
}

async fn npm_latest(pkg: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?;
    let v: Value = client
        .get(format!("https://registry.npmjs.org/{pkg}/latest"))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    v["version"].as_str().map(String::from)
}

fn local() -> PathBuf {
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default())
}

/// Maior versão entre as pastas (o app guarda uma pasta por versão do Claude Code embutido).
fn newest_dir_version(dir: PathBuf) -> Option<String> {
    let mut vs: Vec<(Vec<u64>, String)> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter_map(|n| {
            Some((
                n.split('.')
                    .map(|p| p.parse().ok())
                    .collect::<Option<Vec<u64>>>()?,
                n,
            ))
        })
        .collect();
    vs.sort();
    vs.pop().map(|(_, n)| n)
}

fn installed_versions() -> Vec<Harness> {
    let claude_cli = run("cmd", &["/c", "claude", "--version"]).and_then(|s| version_in(&s));
    let claude_app = ps("(Get-AppxPackage Claude).Version");
    let claude_embedded = newest_dir_version(
        PathBuf::from(std::env::var("APPDATA").unwrap_or_default())
            .join("Claude")
            .join("claude-code"),
    );
    let codex_app = ps("(Get-AppxPackage OpenAI.Codex).Version");
    let codex_runtime = crate::live::codex_exe()
        .and_then(|exe| run(&exe.to_string_lossy(), &["--version"]))
        .and_then(|s| version_in(&s));
    let agy = local()
        .join("Programs")
        .join("Antigravity")
        .join("Antigravity.exe");
    let agy_version = agy
        .exists()
        .then(|| {
            ps(&format!(
                "(Get-Item '{}').VersionInfo.ProductVersion",
                agy.display()
            ))
        })
        .flatten()
        .map(|v| v.trim_end_matches(".0").to_string());
    vec![
        Harness {
            id: "claude-cli",
            name: "Claude Code CLI",
            installed: claude_cli,
            latest: None,
            detail: None,
            auto: false,
            can_update: true,
            outdated: false,
            compare: None,
        },
        Harness {
            id: "claude-app",
            name: "Claude (app)",
            installed: claude_app,
            latest: None,
            detail: claude_embedded.map(|v| format!("Claude Code embutido {v}")),
            auto: true,
            can_update: false,
            outdated: false,
            compare: None,
        },
        Harness {
            id: "codex-app",
            name: "Codex (app)",
            installed: codex_app,
            latest: None,
            detail: codex_runtime.as_ref().map(|v| format!("runtime {v}")),
            auto: true,
            can_update: false,
            outdated: false,
            compare: codex_runtime,
        },
        Harness {
            id: "antigravity",
            name: "Antigravity",
            installed: agy_version,
            latest: None,
            detail: None,
            auto: true,
            can_update: false,
            outdated: false,
            compare: None,
        },
    ]
}

#[tauri::command]
pub async fn harness_versions() -> Result<Vec<Harness>, String> {
    let mut list = tauri::async_runtime::spawn_blocking(installed_versions)
        .await
        .map_err(|e| e.to_string())?;
    let claude = npm_latest("@anthropic-ai/claude-code").await;
    let codex = npm_latest("@openai/codex").await;
    for h in &mut list {
        h.latest = match h.id {
            "claude-cli" => claude.clone(),
            "codex-app" => codex.clone(), // a versão estável do runtime; o app atualiza o dele sozinho
            _ => None,
        };
        let current = if h.id == "claude-cli" {
            h.installed.clone()
        } else {
            h.compare.clone()
        };
        h.outdated = matches!((&current, &h.latest), (Some(c), Some(l)) if base(c) < base(l));
    }
    Ok(list)
}

/// Atualiza a CLI do Claude Code pelo mesmo caminho em que ela foi instalada.
#[tauri::command]
pub async fn update_harness(id: String) -> Result<String, String> {
    if id != "claude-cli" {
        return Err("esse harness se atualiza sozinho".into());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let path = run("where", &["claude"]).unwrap_or_default().to_lowercase();
        // instalado pelo npm: npm atualiza; instalador nativo: `claude update`
        let (cmd, args): (&str, Vec<&str>) = if path.contains("\\npm\\") {
            (
                "cmd",
                vec![
                    "/c",
                    "npm",
                    "install",
                    "-g",
                    "@anthropic-ai/claude-code@latest",
                ],
            )
        } else {
            ("cmd", vec!["/c", "claude", "update"])
        };
        let out = hidden(Command::new(cmd).args(&args))
            .output()
            .map_err(|e| e.to_string())?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        if !out.status.success() {
            return Err(text
                .trim()
                .chars()
                .rev()
                .take(400)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect());
        }
        let v = run("cmd", &["/c", "claude", "--version"])
            .and_then(|s| version_in(&s))
            .unwrap_or_default();
        Ok(format!("Claude Code CLI atualizado para {v}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extrai_versao() {
        assert_eq!(
            version_in("2.1.193 (Claude Code)").as_deref(),
            Some("2.1.193")
        );
        assert_eq!(
            version_in("codex-cli 0.162.0-alpha.2").as_deref(),
            Some("0.162.0-alpha.2")
        );
        assert_eq!(version_in("sem versão"), None);
        assert!(base("2.1.193") < base("2.1.295"));
        assert!(!(base("0.162.0-alpha.2") < base("0.162.0")));
    }
}

#[cfg(test)]
mod real {
    /// cargo test --lib versoes_reais -- --ignored --nocapture
    #[test]
    #[ignore]
    fn versoes_reais() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        for h in tauri::async_runtime::block_on(super::harness_versions()).unwrap() {
            println!(
                "{:<16} instalada={:?} mais_nova={:?} {:?} auto={}",
                h.name, h.installed, h.latest, h.detail, h.auto
            );
        }
    }
}
