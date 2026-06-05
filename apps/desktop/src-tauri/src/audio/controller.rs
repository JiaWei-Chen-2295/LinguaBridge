use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::error::{AudioCaptureError, AudioCaptureErrorKind};
use super::types::{AudioCaptureConfig, AudioCaptureStatus, AudioCaptureStatusKind, AudioDevice};
use super::wasapi;
use tauri::AppHandle;

#[derive(Default)]
pub struct AudioState {
    inner: Mutex<AudioCaptureStatus>,
}

impl AudioState {
    pub fn list_devices(&self) -> Result<Vec<AudioDevice>, AudioCaptureError> {
        wasapi::list_loopback_devices()
    }

    pub fn status(&self) -> Result<AudioCaptureStatus, AudioCaptureError> {
        let status = self.inner.lock().map_err(|_| {
            AudioCaptureError::new(
                AudioCaptureErrorKind::Internal,
                "Audio status lock is poisoned.",
                true,
            )
        })?;

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

        match wasapi::start_loopback_capture(&config, app) {
            Ok(()) => {
                status.state = AudioCaptureStatusKind::Capturing;
                status.started_at_ms = Some(now_ms());
                Ok(status.clone())
            }
            Err(error) => {
                status.state = AudioCaptureStatusKind::Error;
                status.started_at_ms = None;
                status.last_error = Some(error.message.clone());
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

        if matches!(status.state, AudioCaptureStatusKind::Idle) {
            return Err(AudioCaptureError::not_capturing());
        }

        status.state = AudioCaptureStatusKind::Stopping;
        if let Err(error) = wasapi::stop_loopback_capture() {
            status.state = AudioCaptureStatusKind::Error;
            status.active_device_id = None;
            status.started_at_ms = None;
            status.last_error = Some(error.message.clone());
            return Err(error);
        }

        status.state = AudioCaptureStatusKind::Idle;
        status.active_device_id = None;
        status.started_at_ms = None;
        status.last_error = None;
        Ok(status.clone())
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
