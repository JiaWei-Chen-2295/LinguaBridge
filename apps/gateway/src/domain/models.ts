import type {
  ModelTrace,
  SubtitleSegmentStatus,
  SubtitleSegmentUpdatedEvent
} from "@lingua-bridge/protocol";

export type UserStatus = "active" | "suspended";
export type InviteStatus = "available" | "activated" | "expired";
export type SessionStatus = "active" | "completed" | "interrupted";

export type UsageEventType =
  | "asr_audio_duration"
  | "mt_input_tokens"
  | "mt_output_tokens"
  | "revision_tokens"
  | "oss_audio_storage"
  | "interpretation_audio_duration"
  | "interpretation_audio_storage"
  | "session_realtime_duration"
  | "session_metadata"
  | "session_interruption";

export type UsageUnit = "milliseconds" | "tokens" | "bytes" | "count";

export interface User {
  id: string;
  status: UserStatus;
  quotaMinutes: number;
  createdAt: Date;
  email?: string;
  phone?: string;
}

export interface InviteBatch {
  id: string;
  name: string;
  quotaMinutes: number;
  maxUses: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface Invite {
  id: string;
  codeHash: string;
  batchId: string;
  status: InviteStatus;
  createdAt: Date;
  activatedBy?: string;
  activatedAt?: Date;
}

export interface RealtimeSession {
  id: string;
  userId: string;
  sourceLang: string;
  targetLang: string;
  status: SessionStatus;
  startedAt: Date;
  durationMs: number;
  endedAt?: Date;
  deviceLabel?: string;
}

export interface SubtitleSegment {
  sessionId: string;
  segmentId: string;
  status: SubtitleSegmentStatus;
  sourceText: string;
  targetText: string;
  startAtMs: number;
  endAtMs: number;
  revision: number;
  confidence: number;
  termsHit: string[];
  latencyMs: number;
  modelTrace: ModelTrace;
  updatedAt: Date;
}

export interface SegmentRevision {
  id: string;
  sessionId: string;
  segmentId: string;
  revision: number;
  status: SubtitleSegmentStatus;
  sourceText: string;
  targetText: string;
  reason: string;
  modelTrace: ModelTrace;
  createdAt: Date;
}

export interface SessionAudioObject {
  id: string;
  sessionId: string;
  objectKey: string;
  format: string;
  durationMs: number;
  sizeBytes: number;
  createdAt: Date;
}

export interface UsageEvent {
  id: string;
  userId: string;
  eventType: UsageEventType;
  amount: number;
  unit: UsageUnit;
  createdAt: Date;
  sessionId?: string;
  model?: string;
  costEstimate?: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface UsageEventInput {
  userId: string;
  eventType: UsageEventType;
  amount: number;
  unit: UsageUnit;
  sessionId?: string;
  model?: string;
  costEstimate?: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface UsageSummary {
  userId: string;
  quotaMinutes: number;
  usedRealtimeMs: number;
  usedAsrMs: number;
  storageBytes: number;
  mtInputTokens: number;
  mtOutputTokens: number;
  revisionTokens: number;
  interpretationAudioMs: number;
  interruptions: number;
  remainingMinutes: number;
}

export interface SessionSnapshot {
  session: RealtimeSession;
  audioObjects: SessionAudioObject[];
  segments: SubtitleSegment[];
  revisions: SegmentRevision[];
  usageEvents: UsageEvent[];
}

export function segmentFromEvent(
  event: SubtitleSegmentUpdatedEvent,
  updatedAt: Date
): SubtitleSegment {
  const segment = event.payload;
  return {
    sessionId: segment.sessionId,
    segmentId: segment.segmentId,
    status: segment.status,
    sourceText: segment.sourceText,
    targetText: segment.targetText,
    startAtMs: segment.startAtMs,
    endAtMs: segment.endAtMs,
    revision: segment.revision,
    confidence: segment.confidence,
    termsHit: [...segment.termsHit],
    latencyMs: segment.latencyMs,
    modelTrace: segment.modelTrace,
    updatedAt
  };
}
