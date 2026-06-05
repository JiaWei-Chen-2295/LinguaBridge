import { invoke } from "@tauri-apps/api/core";

import type {
  AudioCaptureConfig,
  AudioCaptureStatus,
  AudioCommandError,
  AudioDevice
} from "../types/audio";

const defaultAudioConfig: AudioCaptureConfig = {
  deviceId: null,
  sampleRateHz: 16_000,
  channels: 1,
  frameDurationMs: 20
};

export async function listAudioDevices(): Promise<AudioDevice[]> {
  return invoke<AudioDevice[]>("list_audio_devices");
}

export async function getAudioCaptureStatus(): Promise<AudioCaptureStatus> {
  return invoke<AudioCaptureStatus>("get_audio_capture_status");
}

export async function startAudioCapture(
  config: Partial<AudioCaptureConfig> = {}
): Promise<AudioCaptureStatus> {
  return invoke<AudioCaptureStatus>("start_audio_capture", {
    config: {
      ...defaultAudioConfig,
      ...config
    }
  });
}

export async function stopAudioCapture(): Promise<AudioCaptureStatus> {
  return invoke<AudioCaptureStatus>("stop_audio_capture");
}

export function toAudioCommandError(error: unknown): AudioCommandError {
  if (isRecord(error)) {
    const kind = typeof error.kind === "string" ? error.kind : "internal";
    const message =
      typeof error.message === "string"
        ? error.message
        : "Audio command failed before returning a typed error.";
    const recoverable = typeof error.recoverable === "boolean" ? error.recoverable : true;

    return {
      kind: normalizeAudioErrorKind(kind),
      message,
      recoverable
    };
  }

  return {
    kind: "internal",
    message: "Audio command failed before returning a typed error.",
    recoverable: true
  };
}

function normalizeAudioErrorKind(kind: string): AudioCommandError["kind"] {
  const knownKinds: ReadonlySet<string> = new Set<AudioCommandError["kind"]>([
    "unsupportedPlatform",
    "wasapiUnavailable",
    "permissionRequired",
    "deviceUnavailable",
    "deviceSwitchRequired",
    "exclusiveModeBlocked",
    "sampleRateConversionFailed",
    "emptyAudio",
    "alreadyCapturing",
    "notCapturing",
    "internal"
  ]);

  return knownKinds.has(kind) ? (kind as AudioCommandError["kind"]) : "internal";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
