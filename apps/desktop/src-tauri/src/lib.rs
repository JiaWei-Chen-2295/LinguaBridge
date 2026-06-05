mod audio;
mod commands;

use audio::AudioState;
use commands::audio::{
    get_audio_capture_status, list_audio_devices, start_audio_capture, stop_audio_capture,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AudioState::default())
        .invoke_handler(tauri::generate_handler![
            start_audio_capture,
            stop_audio_capture,
            list_audio_devices,
            get_audio_capture_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running LinguaBridge desktop application");
}
