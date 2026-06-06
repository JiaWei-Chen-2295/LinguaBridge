use tauri::{AppHandle, State};

use crate::audio::{
    AudioCaptureCapabilities, AudioCaptureConfig, AudioCaptureError, AudioCaptureStatus,
    AudioDevice, AudioState,
};

#[tauri::command]
pub fn list_audio_devices(
    state: State<'_, AudioState>,
) -> Result<Vec<AudioDevice>, AudioCaptureError> {
    state.list_devices()
}

#[tauri::command]
pub fn get_audio_capture_status(
    state: State<'_, AudioState>,
) -> Result<AudioCaptureStatus, AudioCaptureError> {
    state.status()
}

#[tauri::command]
pub fn get_audio_capture_capabilities(state: State<'_, AudioState>) -> AudioCaptureCapabilities {
    state.capabilities()
}

#[tauri::command]
pub fn start_audio_capture(
    app: AppHandle,
    state: State<'_, AudioState>,
    config: Option<AudioCaptureConfig>,
) -> Result<AudioCaptureStatus, AudioCaptureError> {
    state.start(config.unwrap_or_default(), app)
}

#[tauri::command]
pub fn stop_audio_capture(
    state: State<'_, AudioState>,
) -> Result<AudioCaptureStatus, AudioCaptureError> {
    state.stop()
}
