use std::sync::Mutex;

use super::error::{AudioCaptureError, AudioCaptureErrorKind};
use super::types::{
    AudioCaptureConfig, AudioCaptureStatus, AudioCaptureStatusKind, AudioDevice,
    AUDIO_CAPTURE_STATUS_EVENT,
};
use super::wasapi;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct AudioState {
    inner: Mutex<AudioCaptureStatus>,
}

impl AudioState {
    pub fn list_devices(&self) -> Result<Vec<AudioDevice>, AudioCaptureError> {
        wasapi::list_loopback_devices()
    }

    pub fn status(&self) -> Result<AudioCaptureStatus, AudioCaptureError> {
        let mut status = self.inner.lock().map_err(|_| {
            AudioCaptureError::new(
                AudioCaptureErrorKind::Internal,
                "Audio status lock is poisoned.",
                true,
            )
        })?;

        sync_finished_capture(&mut status)?;
        Ok(status.clone())
    }

    pub fn start(
        &self,
        config: AudioCaptureConfig,
        app: AppHandle,
    ) -> Result<AudioCaptureStatus, AudioCaptureError> {
        let mut status = self.inner.lock().map_err(|_| {
            AudioCaptureError::new(
                AudioCaptureErrorKind::Internal,
                "Audio status lock is poisoned.",
                true,
            )
        })?;

        sync_finished_capture(&mut status)?;

        if matches!(
            status.state,
            AudioCaptureStatusKind::Starting | AudioCaptureStatusKind::Capturing
        ) {
            return Err(AudioCaptureError::already_capturing());
        }

        status.state = AudioCaptureStatusKind::Starting;
        status.active_device_id = config.device_id.clone();
        status.sample_rate_hz = config.sample_rate_hz;
        status.channels = config.channels;
        status.frame_duration_ms = config.frame_duration_ms;
        status.last_error = None;
        status.last_error_kind = None;
        emit_status(&app, &status);

        match wasapi::start_loopback_capture(&config, app.clone()) {
            Ok(start_info) => {
                status.state = AudioCaptureStatusKind::Capturing;
                status.active_device_id = Some(start_info.device_id);
                status.started_at_ms = Some(start_info.started_at_ms);
                status.last_error = None;
                status.last_error_kind = None;
                emit_status(&app, &status);
                Ok(status.clone())
            }
            Err(error) => {
                status.state = AudioCaptureStatusKind::Error;
                status.active_device_id = None;
                status.started_at_ms = None;
                status.last_error = Some(error.message.clone());
                status.last_error_kind = Some(error.kind);
                emit_status(&app, &status);
                Err(error)
            }
        }
    }

    pub fn stop(&self) -> Result<AudioCaptureStatus, AudioCaptureError> {
        let mut status = self.inner.lock().map_err(|_| {
            AudioCaptureError::new(
                AudioCaptureErrorKind::Internal,
                "Audio status lock is poisoned.",
                true,
            )
        })?;

        sync_finished_capture(&mut status)?;

        if matches!(status.state, AudioCaptureStatusKind::Idle) {
            return Err(AudioCaptureError::not_capturing());
        }

        status.state = AudioCaptureStatusKind::Stopping;
        if let Err(error) = wasapi::stop_loopback_capture() {
            status.state = AudioCaptureStatusKind::Error;
            status.active_device_id = None;
            status.started_at_ms = None;
            status.last_error = Some(error.message.clone());
            status.last_error_kind = Some(error.kind);
            return Err(error);
        }

        status.state = AudioCaptureStatusKind::Idle;
        status.active_device_id = None;
        status.started_at_ms = None;
        status.last_error = None;
        status.last_error_kind = None;
        Ok(status.clone())
    }
}

fn sync_finished_capture(status: &mut AudioCaptureStatus) -> Result<(), AudioCaptureError> {
    if !matches!(
        status.state,
        AudioCaptureStatusKind::Starting | AudioCaptureStatusKind::Capturing
    ) {
        return Ok(());
    }

    let Some(result) = wasapi::take_finished_loopback_capture()? else {
        return Ok(());
    };

    match result {
        Ok(()) => {
            status.state = AudioCaptureStatusKind::Idle;
            status.active_device_id = None;
            status.started_at_ms = None;
            status.last_error = None;
            status.last_error_kind = None;
        }
        Err(error) => {
            status.state = AudioCaptureStatusKind::Error;
            status.last_error = Some(error.message);
            status.last_error_kind = Some(error.kind);
        }
    }

    Ok(())
}

fn emit_status(app: &AppHandle, status: &AudioCaptureStatus) {
    let _ = app.emit(AUDIO_CAPTURE_STATUS_EVENT, status.clone());
}
