use serde::{Deserialize, Serialize};

use super::error::AudioCaptureErrorKind;

pub const AUDIO_CAPTURE_STATUS_EVENT: &str = "audio-capture-status";
pub const AUDIO_FRAME_EVENT: &str = "audio-frame";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCaptureConfig {
    pub device_id: Option<String>,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub frame_duration_ms: u16,
    pub mode: AudioCaptureMode,
}

impl Default for AudioCaptureConfig {
    fn default() -> Self {
        Self {
            device_id: None,
            sample_rate_hz: 16_000,
            channels: 1,
            frame_duration_ms: 20,
            mode: AudioCaptureMode::EndpointLoopback,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioCaptureMode {
    EndpointLoopback,
    ProcessExcludeLoopback,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCaptureCapabilities {
    pub endpoint_loopback: AudioLoopbackCapability,
    pub process_exclude_loopback: ProcessExcludeLoopbackCapability,
    pub windows_build: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLoopbackCapability {
    pub supported: bool,
    pub reason: Option<AudioCaptureCapabilityReason>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessExcludeLoopbackCapability {
    pub supported: bool,
    pub reason: Option<AudioCaptureCapabilityReason>,
    pub minimum_build: u32,
    pub current_build: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioCaptureCapabilityReason {
    UnsupportedOs,
    ActivationFailed,
    NotWindows,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub kind: AudioDeviceKind,
    pub status: AudioDeviceStatus,
    pub is_default: bool,
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u16>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioDeviceKind {
    LoopbackOutput,
    MicrophoneInput,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioDeviceStatus {
    Available,
    Unavailable,
    PermissionRequired,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioCaptureStatusKind {
    Idle,
    Starting,
    Capturing,
    Stopping,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCaptureStatus {
    pub state: AudioCaptureStatusKind,
    pub active_device_id: Option<String>,
    pub started_at_ms: Option<u64>,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub frame_duration_ms: u16,
    pub last_error: Option<String>,
    pub last_error_kind: Option<AudioCaptureErrorKind>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFramePayload {
    pub frame_id: String,
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub frame_duration_ms: u16,
    pub samples: Vec<i16>,
}

impl Default for AudioCaptureStatus {
    fn default() -> Self {
        let config = AudioCaptureConfig::default();

        Self {
            state: AudioCaptureStatusKind::Idle,
            active_device_id: None,
            started_at_ms: None,
            sample_rate_hz: config.sample_rate_hz,
            channels: config.channels,
            frame_duration_ms: config.frame_duration_ms,
            last_error: None,
            last_error_kind: None,
        }
    }
}
