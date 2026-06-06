mod audio;
mod commands;

use audio::AudioState;
use commands::audio::{
    get_audio_capture_capabilities, get_audio_capture_status, list_audio_devices,
    start_audio_capture, stop_audio_capture,
};
use tauri::{Manager, RunEvent, WindowEvent};

const MAIN_WINDOW_LABEL: &str = "main";
const OVERLAY_WINDOW_LABEL: &str = "subtitle-overlay";

fn shutdown_application(app: &tauri::AppHandle) {
    let _ = app.state::<AudioState>().stop();

    if let Some(overlay_window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        let _ = overlay_window.close();
    }

    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AudioState::default())
        .invoke_handler(tauri::generate_handler![
            start_audio_capture,
            stop_audio_capture,
            list_audio_devices,
            get_audio_capture_capabilities,
            get_audio_capture_status
        ])
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }

            if matches!(event, WindowEvent::CloseRequested { .. }) {
                shutdown_application(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running LinguaBridge desktop application")
        .run(|app_handle, event| {
            if matches!(event, RunEvent::Exit) {
                let _ = app_handle.state::<AudioState>().stop();
            }
        });
}
