use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioCaptureErrorKind {
    UnsupportedPlatform,
    WasapiUnavailable,
    PermissionRequired,
    DeviceUnavailable,
    DeviceSwitchRequired,
    ExclusiveModeBlocked,
    SampleRateConversionFailed,
    EmptyAudio,
    AlreadyCapturing,
    NotCapturing,
    Internal,
}

#[derive(Debug, Error, Serialize)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct AudioCaptureError {
    pub kind: AudioCaptureErrorKind,
    pub message: String,
    pub recoverable: bool,
}

impl AudioCaptureError {
    pub fn new(kind: AudioCaptureErrorKind, message: impl Into<String>, recoverable: bool) -> Self {
        Self {
            kind,
            message: message.into(),
            recoverable,
        }
    }

    pub fn already_capturing() -> Self {
        Self::new(
            AudioCaptureErrorKind::AlreadyCapturing,
            "Audio capture is already running.",
            true,
        )
    }

    pub fn not_capturing() -> Self {
        Self::new(
            AudioCaptureErrorKind::NotCapturing,
            "Audio capture is not running.",
            true,
        )
    }
}
