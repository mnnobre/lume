use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

static CREATING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
pub struct PetPlacement {
    alignment: &'static str,
}

fn placed_position(
    alignment: &str,
    position: (i32, i32),
    size: (i32, i32),
    work: (i32, i32, i32, i32),
    edge_offset: i32,
) -> (i32, i32, &'static str) {
    let (width, height) = size;
    let (work_x, work_y, work_width, work_height) = work;
    let old_offset = match alignment {
        "left" => edge_offset,
        "right" => width - edge_offset,
        _ => width / 2,
    };
    let pet_center = position.0 + old_offset;
    let relative = (pet_center - work_x) as f64 / work_width.max(1) as f64;
    let next_alignment = if relative < 0.30 {
        "left"
    } else if relative > 0.70 {
        "right"
    } else {
        "center"
    };
    let next_offset = match next_alignment {
        "left" => edge_offset,
        "right" => width - edge_offset,
        _ => width / 2,
    };
    let max_x = (work_x + work_width - width).max(work_x);
    let max_y = (work_y + work_height - height).max(work_y);
    (
        (pet_center - next_offset).clamp(work_x, max_x),
        position.1.clamp(work_y, max_y),
        next_alignment,
    )
}

#[tauri::command]
pub async fn pet_toggle(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(pet) = app.get_webview_window("pet") {
        return if enabled { pet.show() } else { pet.hide() }.map_err(|e| e.to_string());
    }
    if !enabled {
        return Ok(());
    }
    if CREATING.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            CREATING.store(false, Ordering::Release);
        }
    }
    let _reset = Reset;
    let pet = WebviewWindowBuilder::new(&app, "pet", WebviewUrl::App("index.html?pet=1".into()))
        .title("Lume · Pet")
        .inner_size(360.0, 235.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .build()
        .map_err(|e| e.to_string())?;
    if let Some(monitor) = pet.current_monitor().map_err(|e| e.to_string())? {
        let work = monitor.work_area();
        let scale = monitor.scale_factor();
        let x = work.position.x as f64 / scale + work.size.width as f64 / scale - 380.0;
        let y = work.position.y as f64 / scale + work.size.height as f64 / scale - 255.0;
        pet.set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Keeps the complete pet surface inside the current monitor and makes the
/// controls grow away from the nearest screen edge.
#[tauri::command]
pub fn pet_place(app: AppHandle, alignment: String) -> Result<PetPlacement, String> {
    let pet = app
        .get_webview_window("pet")
        .ok_or("Janela do pet indisponível")?;
    let monitor = pet
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(pet.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("Monitor do pet indisponível")?;
    let work = monitor.work_area();
    let position = pet.outer_position().map_err(|e| e.to_string())?;
    let size = pet.outer_size().map_err(|e| e.to_string())?;
    let scale = monitor.scale_factor();
    let edge_offset = (79.0 * scale).round() as i32;
    let (x, y, next_alignment) = placed_position(
        &alignment,
        (position.x, position.y),
        (size.width as i32, size.height as i32),
        (
            work.position.x,
            work.position.y,
            work.size.width as i32,
            work.size.height as i32,
        ),
        edge_offset,
    );
    if position.x != x || position.y != y {
        pet.set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    Ok(PetPlacement {
        alignment: next_alignment,
    })
}

#[cfg(test)]
mod tests {
    use super::placed_position;

    #[test]
    fn pet_fica_dentro_do_monitor_e_barras_apontam_para_dentro() {
        let (x, y, alignment) =
            placed_position("center", (1800, 1000), (360, 235), (0, 0, 1920, 1080), 79);
        assert_eq!((x, y, alignment), (1560, 845, "right"));

        let (x, y, alignment) =
            placed_position("center", (-200, -100), (360, 235), (0, 0, 1920, 1080), 79);
        assert_eq!((x, y, alignment), (0, 0, "left"));
    }
}

#[tauri::command]
pub async fn pet_open_chat(app: AppHandle, provider: String, id: String) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("Janela principal indisponível")?;
    main.show().map_err(|e| e.to_string())?;
    main.unminimize().map_err(|e| e.to_string())?;
    main.set_focus().map_err(|e| e.to_string())?;
    app.emit_to(
        "main",
        "pet-open-chat",
        json!({"provider":provider,"id":id}),
    )
    .map_err(|e| e.to_string())
}

/// Windows speech recognition; audio stays on the device. Only invoked by the microphone button.
#[tauri::command]
pub async fn pet_dictate() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let script = r#"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; $recognizers=[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers(); $ri=$recognizers | Where-Object { $_.Culture.Name -eq 'pt-BR' } | Select-Object -First 1; if (!$ri) { throw 'Instale o reconhecimento de fala em Português (Brasil) nas configurações de idioma do Windows.' }; $engine=New-Object System.Speech.Recognition.SpeechRecognitionEngine($ri); try { $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)); $engine.SetInputToDefaultAudioDevice(); $result=$engine.Recognize([TimeSpan]::FromSeconds(12)); if ($result) { [Console]::OutputEncoding=[Text.Encoding]::UTF8; $result.Text } } finally { $engine.Dispose() }"#;
        let out=crate::sessions::hidden(std::process::Command::new("powershell").args(["-NoProfile","-NonInteractive","-Command",script])).output().map_err(|e|e.to_string())?;
        if !out.status.success() {return Err(String::from_utf8_lossy(&out.stderr).chars().take(500).collect());}
        Ok(json!({"text":String::from_utf8_lossy(&out.stdout).trim()}))
    }).await.map_err(|e|e.to_string())?
}
