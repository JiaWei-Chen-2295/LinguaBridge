import type {
  DeviceInfo,
  LanguagePair,
  PrivacyConsent,
  RealtimeAudioFrameMessage,
  RealtimeClientMessage,
  RealtimeSessionPauseMessage,
  RealtimeSessionResumeMessage,
  RealtimeSessionStartMessage,
  RealtimeSessionStopMessage
} from "@lingua-bridge/protocol";
import {
  isRecord,
  optionalNumber,
  optionalString,
  requiredString
} from "../http/validation";

export function parseRealtimeClientMessage(
  payload: string
): RealtimeClientMessage | undefined {
  const parsed = parseJson(payload);

  if (!isRecord(parsed) || parsed.version !== 1) {
    return undefined;
  }

  const type = requiredString(parsed, "type");
  if (type === "session.start") {
    return parseStartMessage(parsed);
  }

  if (type === "audio.frame") {
    return parseAudioFrameMessage(parsed);
  }

  if (type === "session.pause") {
    return parseSessionIdMessage(parsed, "session.pause");
  }

  if (type === "session.resume") {
    return parseSessionIdMessage(parsed, "session.resume");
  }

  if (type === "session.stop") {
    return parseStopMessage(parsed);
  }

  return undefined;
}

function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

function parseStartMessage(
  record: Record<string, unknown>
): RealtimeSessionStartMessage | undefined {
  const requestId = requiredString(record, "requestId");
  if (requestId === undefined || !isRecord(record.payload)) {
    return undefined;
  }

  const inviteCode = requiredString(record.payload, "inviteCode");
  const userId = optionalString(record.payload, "userId");
  const language = parseLanguage(record.payload.language);
  const device = parseDevice(record.payload.device);
  const privacyConsent = parsePrivacyConsent(record.payload.privacyConsent);

  if (
    inviteCode === undefined ||
    language === undefined ||
    device === undefined ||
    privacyConsent === undefined
  ) {
    return undefined;
  }

  const payload: RealtimeSessionStartMessage["payload"] = {
    inviteCode,
    language,
    device,
    privacyConsent
  };

  if (userId !== undefined) {
    payload.userId = userId;
  }

  return {
    type: "session.start",
    version: 1,
    requestId,
    payload
  };
}

function parseAudioFrameMessage(
  record: Record<string, unknown>
): RealtimeAudioFrameMessage | undefined {
  const requestId = requiredString(record, "requestId");
  if (requestId === undefined || !isRecord(record.payload)) {
    return undefined;
  }

  const sessionId = requiredString(record.payload, "sessionId");
  const pcmBase64 = requiredString(record.payload, "pcmBase64");
  const sequence = optionalNumber(record.payload, "sequence");
  const capturedAtMs = optionalNumber(record.payload, "capturedAtMs");
  const durationMs = optionalNumber(record.payload, "durationMs");

  if (
    sessionId === undefined ||
    pcmBase64 === undefined ||
    sequence === undefined ||
    capturedAtMs === undefined ||
    durationMs === undefined ||
    !Number.isInteger(sequence) ||
    !Number.isInteger(capturedAtMs) ||
    !Number.isInteger(durationMs) ||
    record.payload.sampleRate !== 16000 ||
    record.payload.channels !== 1
  ) {
    return undefined;
  }

  return {
    type: "audio.frame",
    version: 1,
    requestId,
    payload: {
      sessionId,
      sequence,
      pcmBase64,
      capturedAtMs,
      durationMs,
      sampleRate: 16000,
      channels: 1
    }
  };
}

function parseSessionIdMessage(
  record: Record<string, unknown>,
  type: "session.pause" | "session.resume"
): RealtimeSessionPauseMessage | RealtimeSessionResumeMessage | undefined {
  const requestId = requiredString(record, "requestId");
  if (requestId === undefined || !isRecord(record.payload)) {
    return undefined;
  }

  const sessionId = requiredString(record.payload, "sessionId");
  if (sessionId === undefined) {
    return undefined;
  }

  if (type === "session.pause") {
    return {
      type,
      version: 1,
      requestId,
      payload: { sessionId }
    };
  }

  return {
    type,
    version: 1,
    requestId,
    payload: { sessionId }
  };
}

function parseStopMessage(
  record: Record<string, unknown>
): RealtimeSessionStopMessage | undefined {
  const requestId = requiredString(record, "requestId");
  if (requestId === undefined || !isRecord(record.payload)) {
    return undefined;
  }

  const sessionId = requiredString(record.payload, "sessionId");
  const reason = requiredString(record.payload, "reason");
  if (
    sessionId === undefined ||
    (reason !== "user" &&
      reason !== "network" &&
      reason !== "quota_exhausted" &&
      reason !== "device_error")
  ) {
    return undefined;
  }

  return {
    type: "session.stop",
    version: 1,
    requestId,
    payload: { sessionId, reason }
  };
}

function parseLanguage(value: unknown): LanguagePair | undefined {
  if (!isRecord(value) || value.sourceLang !== "en" || value.targetLang !== "zh-CN") {
    return undefined;
  }

  return {
    sourceLang: "en",
    targetLang: "zh-CN"
  };
}

function parseDevice(value: unknown): DeviceInfo | undefined {
  if (!isRecord(value) || value.os !== "windows") {
    return undefined;
  }

  const sampleRate = optionalNumber(value, "sampleRate");
  const channels = optionalNumber(value, "channels");
  if (
    sampleRate === undefined ||
    channels === undefined ||
    !Number.isInteger(sampleRate) ||
    !Number.isInteger(channels)
  ) {
    return undefined;
  }

  const device: DeviceInfo = {
    os: "windows",
    sampleRate,
    channels
  };
  const osVersion = optionalString(value, "osVersion");
  const deviceId = optionalString(value, "deviceId");

  if (osVersion !== undefined) {
    device.osVersion = osVersion;
  }

  if (deviceId !== undefined) {
    device.deviceId = deviceId;
  }

  return device;
}

function parsePrivacyConsent(value: unknown): PrivacyConsent | undefined {
  if (
    !isRecord(value) ||
    value.accepted !== true ||
    value.retentionDays !== 30 ||
    value.cloudStorageRequired !== true
  ) {
    return undefined;
  }

  const acceptedAt = requiredString(value, "acceptedAt");
  if (acceptedAt === undefined) {
    return undefined;
  }

  return {
    accepted: true,
    acceptedAt,
    retentionDays: 30,
    cloudStorageRequired: true
  };
}
