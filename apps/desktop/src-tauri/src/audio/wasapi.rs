use super::error::{AudioCaptureError, AudioCaptureErrorKind};
use super::types::{AudioCaptureConfig, AudioDevice, AudioDeviceKind, AudioDeviceStatus};

#[cfg(windows)]
pub fn list_loopback_devices() -> Result<Vec<AudioDevice>, AudioCaptureError> {
    Ok(vec![AudioDevice {
        id: "default-output-loopback".to_string(),
        name: "Default Windows output (WASAPI loopback stub)".to_string(),
        kind: AudioDeviceKind::LoopbackOutput,
        status: AudioDeviceStatus::Available,
        is_default: true,
        sample_rate_hz: Some(48_000),
        channels: Some(2),
    }])
}

#[cfg(not(windows))]
pub fn list_loopback_devices() -> Result<Vec<AudioDevice>, AudioCaptureError> {
    Err(AudioCaptureError::new(
        AudioCaptureErrorKind::UnsupportedPlatform,
        "LinguaBridge MVP audio capture is scoped to Windows 10/11 WASAPI loopback.",
        false,
    ))
}

#[cfg(windows)]
pub fn start_loopback_capture(_config: &AudioCaptureConfig) -> Result<(), AudioCaptureError> {
    Err(AudioCaptureError::new(
        AudioCaptureErrorKind::WasapiUnavailable,
        "Windows WASAPI loopback capture is stubbed in this client skeleton. The real capturer should live behind this module boundary.",
        true,
    ))
}

#[cfg(not(windows))]
pub fn start_loopback_capture(_config: &AudioCaptureConfig) -> Result<(), AudioCaptureError> {
    Err(AudioCaptureError::new(
        AudioCaptureErrorKind::UnsupportedPlatform,
        "LinguaBridge MVP audio capture can only start on Windows 10/11.",
        false,
    ))
}

pub fn stop_loopback_capture() -> Result<(), AudioCaptureError> {
    Ok(())
}
