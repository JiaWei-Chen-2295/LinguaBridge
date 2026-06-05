export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type SourceLanguage = "en";
export type TargetLanguage = "zh-CN";
export type LanguagePair = {
  sourceLang: SourceLanguage;
  targetLang: TargetLanguage;
};

export type SubtitleSegmentStatus = "draft" | "final" | "revised";
export type SessionStatus = "pending" | "active" | "paused" | "stopped" | "error" | "deleted";
export type ExportFormat = "markdown" | "srt" | "json";

export type DeviceInfo = {
  os: "windows";
  osVersion?: string;
  deviceId?: string;
  sampleRate: number;
  channels: number;
};

export type PrivacyConsent = {
  accepted: boolean;
  acceptedAt: string;
  retentionDays: 30;
  cloudStorageRequired: true;
};

export type RealtimeClientMessage =
  | RealtimeSessionStartMessage
  | RealtimeAudioFrameMessage
  | RealtimeSessionPauseMessage
  | RealtimeSessionResumeMessage
  | RealtimeSessionStopMessage;

export type RealtimeServerMessage =
  | GatewayReadyEvent
  | SessionStartedEvent
  | SubtitleSegmentUpdatedEvent
  | UsageUpdatedEvent
  | SessionStoppedEvent
  | GatewayErrorEvent;

export type RealtimeSessionStartMessage = {
  type: "session.start";
  version: ProtocolVersion;
  requestId: string;
  payload: {
    inviteCode: string;
    userId?: string;
    language: LanguagePair;
    device: DeviceInfo;
    privacyConsent: PrivacyConsent;
  };
};

export type RealtimeAudioFrameMessage = {
  type: "audio.frame";
  version: ProtocolVersion;
  requestId: string;
  payload: {
    sessionId: string;
    sequence: number;
    pcmBase64: string;
    capturedAtMs: number;
    durationMs: number;
    sampleRate: 16000;
    channels: 1;
  };
};

export type RealtimeSessionPauseMessage = {
  type: "session.pause";
  version: ProtocolVersion;
  requestId: string;
  payload: {
    sessionId: string;
  };
};

export type RealtimeSessionResumeMessage = {
  type: "session.resume";
  version: ProtocolVersion;
  requestId: string;
  payload: {
    sessionId: string;
  };
};

export type RealtimeSessionStopMessage = {
  type: "session.stop";
  version: ProtocolVersion;
  requestId: string;
  payload: {
    sessionId: string;
    reason: "user" | "network" | "quota_exhausted" | "device_error";
  };
};

export type GatewayReadyEvent = {
  type: "gateway.ready";
  version: ProtocolVersion;
  payload: {
    heartbeatIntervalMs: number;
    acceptedAudioFormat: AudioFormat;
  };
};

export type SessionStartedEvent = {
  type: "session.started";
  version: ProtocolVersion;
  payload: {
    sessionId: string;
    userId: string;
    startedAt: string;
    quotaRemainingMs: number;
  };
};

export type SubtitleSegmentUpdatedEvent = {
  type: "subtitle.segment.updated";
  version: ProtocolVersion;
  payload: SubtitleSegment;
};

export type UsageUpdatedEvent = {
  type: "session.usage.updated";
  version: ProtocolVersion;
  payload: {
    sessionId: string;
    userId: string;
    realtimeDurationMs: number;
    quotaRemainingMs: number;
    events: UsageEvent[];
  };
};

export type SessionStoppedEvent = {
  type: "session.stopped";
  version: ProtocolVersion;
  payload: {
    sessionId: string;
    status: Extract<SessionStatus, "stopped" | "error">;
    stoppedAt: string;
    durationMs: number;
    exportUrls: Partial<Record<ExportFormat, string>>;
  };
};

export type GatewayErrorEvent = {
  type: "gateway.error";
  version: ProtocolVersion;
  payload: GatewayError;
};

export type GatewayErrorCode =
  | "invalid_message"
  | "privacy_consent_required"
  | "invite_required"
  | "quota_exhausted"
  | "audio_device_error"
  | "model_provider_unavailable"
  | "session_not_found";

export type GatewayError = {
  code: GatewayErrorCode;
  message: string;
  nextStep: string;
  requestId?: string;
  sessionId?: string;
};

export type AudioFormat = {
  codec: "pcm_s16le";
  sampleRate: 16000;
  channels: 1;
  frameDurationMs: 20 | 40 | 60 | 100;
};

export type SubtitleSegment = {
  sessionId: string;
  segmentId: string;
  status: SubtitleSegmentStatus;
  sourceText: string;
  targetText: string;
  startAtMs: number;
  endAtMs: number;
  revision: number;
  revisionOf?: string;
  confidence: number;
  termsHit: string[];
  latencyMs: number;
  modelTrace: ModelTrace;
};

export type SegmentRevision = {
  sessionId: string;
  segmentId: string;
  revision: number;
  reason: "asr_final" | "context_rewrite" | "term_fix" | "manual_edit";
  sourceText: string;
  targetText: string;
  createdAt: string;
  modelTrace: ModelTrace;
};

export type ModelTrace = {
  provider: "mock" | "alibaba-cloud";
  asrModel: "mock-asr" | "qwen3-asr-flash-realtime" | "fun-asr-realtime" | "paraformer-realtime-v2";
  mtModel: "mock-mt" | "qwen-mt-flash" | "qwen-mt-lite" | "qwen-mt-plus";
  correctionModel?: "mock-correction" | "qwen-plus" | "qwen-turbo";
};

export type UsageEventType =
  | "asr_audio_duration"
  | "mt_input_tokens"
  | "mt_output_tokens"
  | "revision_tokens"
  | "oss_audio_storage"
  | "session_realtime_duration"
  | "session_interruption";

export type UsageUnit = "milliseconds" | "tokens" | "bytes" | "count";

export type UsageEvent = {
  id: string;
  userId: string;
  sessionId?: string;
  eventType: UsageEventType;
  amount: number;
  unit: UsageUnit;
  model?: string;
  costEstimateCny?: number;
  occurredAt: string;
  metadata?: Record<string, string | number | boolean>;
};

export type InviteActivationRequest = {
  code: string;
  account: {
    type: "email" | "phone";
    value: string;
  };
  privacyConsent: PrivacyConsent;
};

export type InviteActivationResponse = {
  userId: string;
  inviteBatchId: string;
  quotaTotalMs: number;
  quotaRemainingMs: number;
  activatedAt: string;
};

export type UsageSummary = {
  userId: string;
  quotaTotalMs: number;
  quotaUsedMs: number;
  quotaRemainingMs: number;
  storageBytes: number;
  currentMonthStartedAt: string;
};

export type TermEntry = {
  id: string;
  userId?: string;
  source: string;
  target?: string;
  mode: "keep_source" | "fixed_translation";
  aliases: string[];
};

export type SessionRecord = {
  id: string;
  userId: string;
  language: LanguagePair;
  status: SessionStatus;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  audio: {
    localPath?: string;
    cloudObjectKey?: string;
    durationMs: number;
    sampleRate: 16000;
    sizeBytes?: number;
  };
  segments: SubtitleSegment[];
  revisions: SegmentRevision[];
  usageEvents: UsageEvent[];
};

export const DEFAULT_AUDIO_FORMAT: AudioFormat = {
  codec: "pcm_s16le",
  sampleRate: 16000,
  channels: 1,
  frameDurationMs: 40
};

export function isRealtimeClientMessage(value: unknown): value is RealtimeClientMessage {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "session.start":
      return isSessionStartPayload(value.payload);
    case "audio.frame":
      return isAudioFramePayload(value.payload);
    case "session.pause":
    case "session.resume":
      return isSessionIdPayload(value.payload);
    case "session.stop":
      return isSessionStopPayload(value.payload);
    default:
      return false;
  }
}

function isSessionStartPayload(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.language) || !isRecord(value.device) || !isRecord(value.privacyConsent)) {
    return false;
  }

  return (
    typeof value.inviteCode === "string" &&
    value.inviteCode.length > 0 &&
    value.language.sourceLang === "en" &&
    value.language.targetLang === "zh-CN" &&
    value.device.os === "windows" &&
    typeof value.device.sampleRate === "number" &&
    typeof value.device.channels === "number" &&
    value.privacyConsent.accepted === true &&
    value.privacyConsent.cloudStorageRequired === true &&
    value.privacyConsent.retentionDays === 30
  );
}

function isAudioFramePayload(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.sessionId === "string" &&
    typeof value.sequence === "number" &&
    typeof value.pcmBase64 === "string" &&
    typeof value.capturedAtMs === "number" &&
    typeof value.durationMs === "number" &&
    value.sampleRate === 16000 &&
    value.channels === 1
  );
}

function isSessionIdPayload(value: unknown): boolean {
  return isRecord(value) && typeof value.sessionId === "string";
}

function isSessionStopPayload(value: unknown): boolean {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    return false;
  }

  return value.reason === "user" || value.reason === "network" || value.reason === "quota_exhausted" || value.reason === "device_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
