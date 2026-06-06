export type AudioDeviceKind = "loopbackOutput" | "microphoneInput";
export type AudioDeviceStatus = "available" | "unavailable" | "permissionRequired";

export interface AudioDevice {
  id: string;
  name: string;
  kind: AudioDeviceKind;
  status: AudioDeviceStatus;
  isDefault: boolean;
  sampleRateHz: number | null;
  channels: number | null;
}

export interface AudioCaptureConfig {
  deviceId: string | null;
  sampleRateHz: number;
  channels: number;
  frameDurationMs: number;
  mode: AudioCaptureMode;
}

export type AudioCaptureMode = "endpointLoopback" | "processExcludeLoopback";

export interface AudioCaptureCapabilities {
  endpointLoopback: AudioLoopbackCapability;
  processExcludeLoopback: ProcessExcludeLoopbackCapability;
  windowsBuild: number | null;
}

export interface AudioLoopbackCapability {
  supported: boolean;
  reason: AudioCaptureCapabilityReason | null;
}

export interface ProcessExcludeLoopbackCapability {
  supported: boolean;
  reason: AudioCaptureCapabilityReason | null;
  minimumBuild: number;
  currentBuild: number | null;
}

export type AudioCaptureCapabilityReason =
  | "unsupported_os"
  | "activation_failed"
  | "not_windows";

export type AudioCaptureStatusKind = "idle" | "starting" | "capturing" | "stopping" | "error";

export interface AudioCaptureStatus {
  state: AudioCaptureStatusKind;
  activeDeviceId: string | null;
  startedAtMs: number | null;
  sampleRateHz: number;
  channels: number;
  frameDurationMs: number;
  lastError: string | null;
  lastErrorKind: AudioCaptureErrorKind | null;
}

export interface AudioFramePayload {
  frameId: string;
  sequence: number;
  timestampMs: number;
  sampleRateHz: number;
  channels: number;
  frameDurationMs: number;
  samples: number[];
}

export type AudioCaptureErrorKind =
  | "unsupportedPlatform"
  | "wasapiUnavailable"
  | "permissionRequired"
  | "deviceUnavailable"
  | "deviceSwitchRequired"
  | "exclusiveModeBlocked"
  | "sampleRateConversionFailed"
  | "emptyAudio"
  | "alreadyCapturing"
  | "notCapturing"
  | "internal";

export interface AudioCommandError {
  kind: AudioCaptureErrorKind;
  message: string;
  recoverable: boolean;
}
