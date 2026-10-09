mod live;
mod sessions;
mod update;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(sessions::Store::default())
        .manage(live::Live::default())
        .invoke_handler(tauri::generate_handler![
            update::check_update,
            update::install_update,
            sessions::list_sessions,
            sessions::transcript,
            sessions::open_session,
            sessions::new_session,
            live::live_send,
            live::live_answer,
            live::live_interrupt,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                live::shutdown(app); // agentes abertos pelo Lume não ficam órfãos
            }
        });
}
