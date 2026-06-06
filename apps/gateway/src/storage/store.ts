import type {
  DeviceInfo,
  SubtitleSegmentUpdatedEvent,
  TermEntry
} from "@lingua-bridge/protocol";
import type {
  RealtimeSession,
  SegmentRevision,
  SessionAudioObject,
  SessionSnapshot,
  SessionStatus,
  SubtitleSegment,
  UsageEvent,
  UsageEventInput,
  UsageSummary,
  User,
  Invite
} from "../domain/models";

export interface StoreSeedConfig {
  devInviteCode: string;
  devInviteQuotaMinutes: number;
}

export interface ActivateInviteInput {
  code: string;
  email?: string;
  phone?: string;
}

export type StoreErrorCode =
  | "invite_not_found"
  | "invite_expired"
  | "invite_already_used"
  | "user_not_found"
  | "session_not_found";

export type ActivateInviteResult =
  | { ok: true; user: User; invite: Invite; usage: UsageSummary }
  | { ok: false; code: StoreErrorCode; message: string };

export interface ResolveSessionUserInput {
  inviteCode?: string;
  userId?: string;
}

export type ResolveSessionUserResult =
  | { ok: true; user: User }
  | { ok: false; code: StoreErrorCode; message: string };

export interface CreateSessionInput {
  userId: string;
  sourceLang: string;
  targetLang: string;
  device?: DeviceInfo;
}

export interface FinalizeSessionResult {
  session: RealtimeSession;
  finalizedNow: boolean;
}

export interface RecordSessionAudioObjectInput {
  sessionId: string;
  objectKey: string;
  format: string;
  durationMs: number;
  sizeBytes: number;
}

export interface DeleteSessionResult {
  snapshot: SessionSnapshot;
  anonymizedUsageEvents: number;
}

export type MaybePromise<T> = T | Promise<T>;

export interface GatewayStore {
  activateInvite(input: ActivateInviteInput): MaybePromise<ActivateInviteResult>;
  resolveSessionUser(
    input: ResolveSessionUserInput
  ): MaybePromise<ResolveSessionUserResult>;
  createSession(input: CreateSessionInput): MaybePromise<RealtimeSession>;
  finalizeSession(
    sessionId: string,
    status: Exclude<SessionStatus, "active">
  ): MaybePromise<FinalizeSessionResult | undefined>;
  recordSubtitleEvent(event: SubtitleSegmentUpdatedEvent): MaybePromise<void>;
  recordSessionAudioObject(
    input: RecordSessionAudioObjectInput
  ): MaybePromise<SessionAudioObject | undefined>;
  listTermEntries(userId: string): MaybePromise<TermEntry[]>;
  appendUsageEvent(input: UsageEventInput): MaybePromise<UsageEvent>;
  getUsageSummary(userId: string): MaybePromise<UsageSummary>;
  hasUser(userId: string): MaybePromise<boolean>;
  getSessionSnapshot(sessionId: string): MaybePromise<SessionSnapshot | undefined>;
  deleteSession(sessionId: string): MaybePromise<DeleteSessionResult | undefined>;
  close?(): Promise<void>;
}

export interface StoreSnapshotParts {
  session: RealtimeSession;
  audioObjects: SessionAudioObject[];
  segments: SubtitleSegment[];
  revisions: SegmentRevision[];
  usageEvents: UsageEvent[];
}
