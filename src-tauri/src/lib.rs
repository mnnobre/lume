mod codex;
mod harness;
mod live;
mod pet;
mod sessions;
mod single_instance;
mod update;
mod usage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if !single_instance::claim() {
        return;
    }
    // provedor de criptografia do rustls para as chamadas HTTPS (uso do Claude); o mesmo do atualizador
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
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
            sessions::session_activity,
            codex::codex_catalog,
            codex::codex_manage,
            live::live_snapshot,
            live::live_respond,
            pet::pet_toggle,
            pet::pet_place,
            pet::pet_open_chat,
            pet::pet_dictate,
            sessions::open_session,
            sessions::new_session,
            sessions::open_folder,
            sessions::search_content,
            live::live_send,
            live::live_answer,
            live::live_interrupt,
            live::live_new,
            harness::harness_versions,
            harness::update_harness,
            usage::usage,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                live::shutdown(app); // agentes abertos pelo Lume não ficam órfãos
            }
        });
}
