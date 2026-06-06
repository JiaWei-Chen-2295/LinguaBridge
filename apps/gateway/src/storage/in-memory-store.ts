import { createHash } from "node:crypto";
import type {
  SubtitleSegmentStatus,
  SubtitleSegmentUpdatedEvent,
  TermEntry
} from "@lingua-bridge/protocol";
import { createId } from "../domain/ids";
import {
  segmentFromEvent,
  type Invite,
  type InviteBatch,
  type RealtimeSession,
  type SegmentRevision,
  type SessionAudioObject,
  type SessionSnapshot,
  type SessionStatus,
  type SubtitleSegment,
  type UsageEvent,
  type UsageEventInput,
  type UsageSummary,
  type User
} from "../domain/models";
import type {
  ActivateInviteInput,
  ActivateInviteResult,
  CreateSessionInput,
  DeleteSessionResult,
  FinalizeSessionResult,
  GatewayStore,
  RecordSessionAudioObjectInput,
  ResolveSessionUserInput,
  ResolveSessionUserResult,
  StoreSeedConfig
} from "./store";

export class InMemoryStore implements GatewayStore {
  private readonly users = new Map<string, User>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly usersByPhone = new Map<string, string>();
  private readonly inviteBatches = new Map<string, InviteBatch>();
  private readonly invitesByHash = new Map<string, Invite>();
  private readonly sessions = new Map<string, RealtimeSession>();
  private readonly audioObjects: SessionAudioObject[] = [];
  private readonly segments = new Map<string, SubtitleSegment>();
  private readonly revisions: SegmentRevision[] = [];
  private readonly usageEvents: UsageEvent[] = [];

  public constructor(seed: StoreSeedConfig) {
    this.seedDevInvite(seed);
  }

  public activateInvite(input: ActivateInviteInput): ActivateInviteResult {
    const codeHash = hashInviteCode(input.code);
    const invite = this.invitesByHash.get(codeHash);
    if (invite === undefined) {
      return {
        ok: false,
        code: "invite_not_found",
        message: "Invite code was not found."
      };
    }

    const batch = this.inviteBatches.get(invite.batchId);
    if (batch === undefined || batch.expiresAt.getTime() < Date.now()) {
      invite.status = "expired";
      return {
        ok: false,
        code: "invite_expired",
        message: "Invite code has expired."
      };
    }

    const existingUser = this.findUserByContact(input.email, input.phone);
    if (invite.activatedBy !== undefined) {
      const activatedUser = this.users.get(invite.activatedBy);
      if (existingUser !== undefined && existingUser.id === invite.activatedBy) {
        return {
          ok: true,
          user: existingUser,
          invite,
          usage: this.getUsageSummary(existingUser.id)
        };
      }

      if (
        existingUser === undefined &&
        invite.batchId === "batch_alpha_dev" &&
        activatedUser?.status === "active"
      ) {
        return {
          ok: true,
          user: activatedUser,
          invite,
          usage: this.getUsageSummary(activatedUser.id)
        };
      }

      return {
        ok: false,
        code: "invite_already_used",
        message: "Invite code has already been activated."
      };
    }

    const user = existingUser ?? this.createUser(input, batch.quotaMinutes);
    invite.status = "activated";
    invite.activatedBy = user.id;
    invite.activatedAt = new Date();

    return {
      ok: true,
      user,
      invite,
      usage: this.getUsageSummary(user.id)
    };
  }

  public resolveSessionUser(
    input: ResolveSessionUserInput
  ): ResolveSessionUserResult {
    if (input.userId !== undefined) {
      const user = this.users.get(input.userId);
      if (user !== undefined && user.status === "active") {
        return { ok: true, user };
      }
    }

    if (input.inviteCode !== undefined) {
      const activation = this.activateInvite({ code: input.inviteCode });
      if (activation.ok) {
        return { ok: true, user: activation.user };
      }

      if (activation.code === "invite_already_used") {
        const activatedUser = this.findActiveUserByInviteCode(input.inviteCode);
        if (activatedUser !== undefined) {
          return { ok: true, user: activatedUser };
        }
      }

      return activation;
    }

    return {
      ok: false,
      code: "user_not_found",
      message: "A valid userId or inviteCode is required."
    };
  }

  public createSession(input: CreateSessionInput): RealtimeSession {
    const now = new Date();
    const session: RealtimeSession = {
      id: createId("sess"),
      userId: input.userId,
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
      status: "active",
      startedAt: now,
      durationMs: 0
    };

    if (input.device?.deviceId !== undefined) {
      session.deviceLabel = input.device.deviceId;
    }

    this.sessions.set(session.id, session);
    return session;
  }

  public finalizeSession(
    sessionId: string,
    status: Exclude<SessionStatus, "active">
  ): FinalizeSessionResult | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return undefined;
    }

    if (session.status !== "active") {
      return { session, finalizedNow: false };
    }

    const endedAt = new Date();
    session.status = status;
    session.endedAt = endedAt;
    session.durationMs = Math.max(
      0,
      endedAt.getTime() - session.startedAt.getTime()
    );
    this.appendUsageEvent({
      userId: session.userId,
      sessionId: session.id,
      eventType: "session_realtime_duration",
      amount: session.durationMs,
      unit: "milliseconds",
      model: "gateway"
    });

    return { session, finalizedNow: true };
  }

  public recordSubtitleEvent(event: SubtitleSegmentUpdatedEvent): void {
    const updatedAt = new Date();
    const segment = segmentFromEvent(event, updatedAt);
    this.segments.set(
      makeSegmentKey(event.payload.sessionId, event.payload.segmentId),
      segment
    );

    this.revisions.push({
      id: createId("rev"),
      sessionId: event.payload.sessionId,
      segmentId: event.payload.segmentId,
      revision: event.payload.revision,
      status: event.payload.status,
      sourceText: event.payload.sourceText,
      targetText: event.payload.targetText,
      reason: revisionReasonFor(event.payload.status),
      modelTrace: event.payload.modelTrace,
      createdAt: updatedAt
    });
  }

  public recordSessionAudioObject(
    input: RecordSessionAudioObjectInput
  ): SessionAudioObject | undefined {
    if (!this.sessions.has(input.sessionId)) {
      return undefined;
    }

    const existing = this.audioObjects.find(
      (audioObject) =>
        audioObject.sessionId === input.sessionId &&
        audioObject.objectKey === input.objectKey
    );

    if (existing !== undefined) {
      existing.durationMs = input.durationMs;
      existing.sizeBytes = input.sizeBytes;
      return existing;
    }

    const audioObject: SessionAudioObject = {
      id: createId("aud"),
      sessionId: input.sessionId,
      objectKey: input.objectKey,
      format: input.format,
      durationMs: input.durationMs,
      sizeBytes: input.sizeBytes,
      createdAt: new Date()
    };
    this.audioObjects.push(audioObject);
    return audioObject;
  }

  public listTermEntries(_userId: string): TermEntry[] {
    return [];
  }

  public appendUsageEvent(input: UsageEventInput): UsageEvent {
    const event: UsageEvent = {
      id: createId("use"),
      userId: input.userId,
      eventType: input.eventType,
      amount: input.amount,
      unit: input.unit,
      createdAt: new Date()
    };

    if (input.sessionId !== undefined) {
      event.sessionId = input.sessionId;
    }

    if (input.model !== undefined) {
      event.model = input.model;
    }

    if (input.costEstimate !== undefined) {
      event.costEstimate = input.costEstimate;
    }

    if (input.metadata !== undefined) {
      event.metadata = { ...input.metadata };
    }

    this.usageEvents.push(event);
    return event;
  }

  public getUsageSummary(userId: string): UsageSummary {
    const user = this.users.get(userId);
    const quotaMinutes = user?.quotaMinutes ?? 0;
    const userEvents = this.usageEvents.filter((event) => event.userId === userId);

    const usedRealtimeMs = sumUsage(userEvents, "session_realtime_duration");
    const usedAsrMs = sumUsage(userEvents, "asr_audio_duration");
    const storageBytes = sumUsage(userEvents, "oss_audio_storage");
    const mtInputTokens = sumUsage(userEvents, "mt_input_tokens");
    const mtOutputTokens = sumUsage(userEvents, "mt_output_tokens");
    const revisionTokens = sumUsage(userEvents, "revision_tokens");
    const interpretationAudioMs = sumUsage(userEvents, "interpretation_audio_duration");
    const interruptions = sumUsage(userEvents, "session_interruption");
    const usedMinutes = usedRealtimeMs / 60_000;

    return {
      userId,
      quotaMinutes,
      usedRealtimeMs,
      usedAsrMs,
      storageBytes,
      mtInputTokens,
      mtOutputTokens,
      revisionTokens,
      interpretationAudioMs,
      interruptions,
      remainingMinutes: Math.max(0, quotaMinutes - usedMinutes)
    };
  }

  public hasUser(userId: string): boolean {
    return this.users.has(userId);
  }

  public getSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return undefined;
    }

    const segments = Array.from(this.segments.values())
      .filter((segment) => segment.sessionId === sessionId)
      .sort((left, right) => left.startAtMs - right.startAtMs);
    const audioObjects = this.audioObjects.filter(
      (audioObject) => audioObject.sessionId === sessionId
    );
    const revisions = this.revisions.filter(
      (revision) => revision.sessionId === sessionId
    );
    const usageEvents = this.usageEvents.filter(
      (event) => event.sessionId === sessionId
    );

    return { session, audioObjects, segments, revisions, usageEvents };
  }

  public deleteSession(sessionId: string): DeleteSessionResult | undefined {
    const snapshot = this.getSessionSnapshot(sessionId);
    if (snapshot === undefined) {
      return undefined;
    }

    this.sessions.delete(sessionId);
    for (const key of Array.from(this.segments.keys())) {
      if (key.startsWith(`${sessionId}:`)) {
        this.segments.delete(key);
      }
    }
    removeMatching(this.audioObjects, (audioObject) => audioObject.sessionId === sessionId);
    removeMatching(this.revisions, (revision) => revision.sessionId === sessionId);

    let anonymizedUsageEvents = 0;
    for (const usageEvent of this.usageEvents) {
      if (usageEvent.sessionId === sessionId) {
        delete usageEvent.sessionId;
        usageEvent.metadata = { deletedSession: true };
        anonymizedUsageEvents += 1;
      }
    }

    return { snapshot, anonymizedUsageEvents };
  }

  private seedDevInvite(seed: StoreSeedConfig): void {
    const now = new Date();
    const batch: InviteBatch = {
      id: "batch_alpha_dev",
      name: "Alpha dev seed",
      quotaMinutes: seed.devInviteQuotaMinutes,
      maxUses: 1,
      expiresAt: new Date("2026-12-31T23:59:59.000Z"),
      createdAt: now
    };
    const invite: Invite = {
      id: "inv_alpha_dev",
      codeHash: hashInviteCode(seed.devInviteCode),
      batchId: batch.id,
      status: "available",
      createdAt: now
    };

    this.inviteBatches.set(batch.id, batch);
    this.invitesByHash.set(invite.codeHash, invite);
  }

  private createUser(input: ActivateInviteInput, quotaMinutes: number): User {
    const user: User = {
      id: createId("user"),
      status: "active",
      quotaMinutes,
      createdAt: new Date()
    };

    if (input.email !== undefined) {
      user.email = input.email;
      this.usersByEmail.set(input.email.toLowerCase(), user.id);
    }

    if (input.phone !== undefined) {
      user.phone = input.phone;
      this.usersByPhone.set(input.phone, user.id);
    }

    this.users.set(user.id, user);
    return user;
  }

  private findUserByContact(
    email: string | undefined,
    phone: string | undefined
  ): User | undefined {
    if (email !== undefined) {
      const userId = this.usersByEmail.get(email.toLowerCase());
      if (userId !== undefined) {
        return this.users.get(userId);
      }
    }

    if (phone !== undefined) {
      const userId = this.usersByPhone.get(phone);
      if (userId !== undefined) {
        return this.users.get(userId);
      }
    }

    return undefined;
  }

  private findActiveUserByInviteCode(code: string): User | undefined {
    const invite = this.invitesByHash.get(hashInviteCode(code));
    if (invite?.activatedBy === undefined) {
      return undefined;
    }

    const user = this.users.get(invite.activatedBy);
    return user?.status === "active" ? user : undefined;
  }
}

export function createInMemoryStore(seed: StoreSeedConfig): InMemoryStore {
  return new InMemoryStore(seed);
}

export function hashInviteCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

function makeSegmentKey(sessionId: string, segmentId: string): string {
  return `${sessionId}:${segmentId}`;
}

export function revisionReasonFor(status: SubtitleSegmentStatus): string {
  if (status === "draft") {
    return "Initial realtime ASR/MT draft.";
  }

  if (status === "final") {
    return "Stable ASR segment finalized.";
  }

  return "Context window revised the latest subtitle segment.";
}

function sumUsage(
  events: UsageEvent[],
  eventType: UsageEvent["eventType"]
): number {
  return events
    .filter((event) => event.eventType === eventType)
    .reduce((total, event) => total + event.amount, 0);
}

function removeMatching<T>(
  values: T[],
  predicate: (value: T) => boolean
): void {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) {
      values.splice(index, 1);
    }
  }
}
