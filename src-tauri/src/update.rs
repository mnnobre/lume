//! Auto-update a partir das releases do repositório privado mnnobre/lume.
//! Sem token gravado no app: usa o login do `gh` da máquina na hora da checagem.
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Url};
use tauri_plugin_updater::{Updater, UpdaterExt};

const REPO: &str = "mnnobre/lume";
const GH_USER: &str = "mnnobre";

fn gh(args: &[&str], token: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new("gh");
    cmd.args(args);
    if let Some(t) = token {
        cmd.env("GH_TOKEN", t); // vale mesmo se a conta ativa do gh for outra
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .map_err(|e| format!("gh não encontrado ({e})"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn updater(app: &AppHandle) -> Result<Updater, String> {
    let token = gh(&["auth", "token", "--user", GH_USER], None).map_err(|e| {
        format!("faça `gh auth login` com a conta {GH_USER} para receber atualizações ({e})")
    })?;
    // Repo privado: o latest.json só sai pela API de assets, então o endpoint muda a cada release.
    let manifest = gh(
        &[
            "api",
            &format!("repos/{REPO}/releases/latest"),
            "--jq",
            r#".assets[] | select(.name == "latest.json") | .url"#,
        ],
        Some(&token),
    )?;
    let url = Url::parse(&manifest).map_err(|_| "release sem latest.json".to_string())?;
    app.updater_builder()
        .endpoints(vec![url])
        .and_then(|b| b.header("Authorization", format!("Bearer {token}")))
        // octet-stream faz a API devolver o arquivo (manifesto e instalador); a assinatura continua sendo verificada
        .and_then(|b| b.header("Accept", "application/octet-stream"))
        .and_then(|b| b.build())
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = updater(&app)?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version,
        notes: u.body,
    }))
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let Some(update) = updater(&app)?.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}
