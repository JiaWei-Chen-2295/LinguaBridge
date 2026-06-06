import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type {
  ModelTrace,
  SubtitleSegmentStatus,
  SubtitleSegmentUpdatedEvent,
  TermEntry
} from "@lingua-bridge/protocol";
import { createId } from "../domain/ids";
import {
  segmentFromEvent,
  type Invite,
  type RealtimeSession,
  type SegmentRevision,
  type SessionAudioObject,
  type SessionSnapshot,
  type SessionStatus,
  type SubtitleSegment,
  type UsageEvent,
  type UsageEventInput,
  type UsageEventType,
  type UsageSummary,
  type User
} from "../domain/models";
import { hashInviteCode, revisionReasonFor } from "./in-memory-store";
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

export interface PgStoreConfig {
  databaseUrl: string;
  seed: StoreSeedConfig;
}

interface DbClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>>;
}

interface UserRow extends QueryResultRow {
  id: string;
  email: string | null;
  phone: string | null;
  status: User["status"];
  quota_minutes: number;
  created_at: Date;
}

interface InviteRow extends QueryResultRow {
  id: string;
  code_hash: string;
  batch_id: string;
  status: Invite["status"];
  activated_by: string | null;
  activated_at: Date | null;
  created_at: Date;
}

interface InviteWithBatchRow extends InviteRow {
  batch_quota_minutes: number;
  batch_expires_at: Date;
}

interface SessionRow extends QueryResultRow {
  id: string;
  user_id: string;
  source_lang: string;
  target_lang: string;
  status: SessionStatus;
  device_label: string | null;
  started_at: Date;
  ended_at: Date | null;
  duration_ms: number;
}

interface AudioObjectRow extends QueryResultRow {
  id: string;
  session_id: string;
  oss_key: string;
  format: string;
  duration_ms: number;
  size_bytes: string | number;
  created_at: Date;
}

interface SegmentRow extends QueryResultRow {
  session_id: string;
  segment_id: string;
  start_ms: number;
  end_ms: number;
  source_text: string;
  target_text: string;
  status: SubtitleSegmentStatus;
  revision: number;
  confidence: string | number;
  terms_hit: string[];
  latency_ms: number;
  updated_at: Date;
}

interface RevisionRow extends QueryResultRow {
  id: string;
  session_id: string;
  segment_id: string;
  revision: number;
  status: SubtitleSegmentStatus;
  source_text: string;
  target_text: string;
  reason: string;
  model_trace: unknown;
  created_at: Date;
}

interface UsageEventRow extends QueryResultRow {
  id: string;
  user_id: string;
  session_id: string | null;
  event_type: UsageEventType;
  amount: string | number;
  unit: UsageEvent["unit"];
  model: string | null;
  cost_estimate: string | number | null;
  metadata: unknown;
  created_at: Date;
}

interface TermEntryRow extends QueryResultRow {
  id: string;
  user_id: string | null;
  source: string;
  target: string | null;
  mode: TermEntry["mode"];
  aliases: string[];
}

interface UsageSumRow extends QueryResultRow {
  event_type: UsageEventType;
  amount: string | number;
}

export class PgStore implements GatewayStore {
  private readonly pool: Pool;

  public constructor(private readonly config: PgStoreConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl });
  }

  public async ensureReady(): Promise<void> {
    await this.pool.query("SELECT 1");
    await this.seedDevInvite();
  }

  public async activateInvite(
    input: ActivateInviteInput
  ): Promise<ActivateInviteResult> {
    return this.withTransaction(async (client) => {
      const codeHash = hashInviteCode(input.code);
      const inviteResult = await client.query<InviteWithBatchRow>(
        `
          SELECT
            i.*,
            b.quota_minutes AS batch_quota_minutes,
            b.expires_at AS batch_expires_at
          FROM invites i
          JOIN invite_batches b ON b.id = i.batch_id
          WHERE i.code_hash = $1
          FOR UPDATE OF i
        `,
        [codeHash]
      );
      const inviteRow = inviteResult.rows[0];
      if (inviteRow === undefined) {
        return {
          ok: false,
          code: "invite_not_found",
          message: "Invite code was not found."
        };
      }

      if (
        inviteRow.status === "expired" ||
        inviteRow.batch_expires_at.getTime() < Date.now()
      ) {
        await client.query("UPDATE invites SET status = 'expired' WHERE id = $1", [
          inviteRow.id
        ]);
        return {
          ok: false,
          code: "invite_expired",
          message: "Invite code has expired."
        };
      }

      const existingUser = await this.findUserByContact(
        client,
        input.email,
        input.phone
      );
      if (inviteRow.activated_by !== null) {
        const activatedUser = await this.getUserById(client, inviteRow.activated_by);
        if (existingUser !== undefined && existingUser.id === inviteRow.activated_by) {
          return {
            ok: true,
            user: existingUser,
            invite: toInvite(inviteRow),
            usage: await this.getUsageSummaryFor(client, existingUser.id)
          };
        }

        if (
          existingUser === undefined &&
          inviteRow.batch_id === "batch_alpha_dev" &&
          activatedUser?.status === "active"
        ) {
          return {
            ok: true,
            user: activatedUser,
            invite: toInvite(inviteRow),
            usage: await this.getUsageSummaryFor(client, activatedUser.id)
          };
        }

        return {
          ok: false,
          code: "invite_already_used",
          message: "Invite code has already been activated."
        };
      }

      const user =
        existingUser ??
        (await this.createUser(client, input, inviteRow.batch_quota_minutes));
      const activatedAt = new Date();
      const activatedInvite = await client.query<InviteRow>(
        `
          UPDATE invites
          SET status = 'activated', activated_by = $2, activated_at = $3
          WHERE id = $1
          RETURNING *
        `,
        [inviteRow.id, user.id, activatedAt]
      );

      return {
        ok: true,
        user,
        invite: toInvite(activatedInvite.rows[0] ?? inviteRow),
        usage: await this.getUsageSummaryFor(client, user.id)
      };
    });
  }

  public async resolveSessionUser(
    input: ResolveSessionUserInput
  ): Promise<ResolveSessionUserResult> {
    if (input.userId !== undefined) {
      const user = await this.getUserById(this.pool, input.userId);
      if (user !== undefined && user.status === "active") {
        return { ok: true, user };
      }
    }

    if (input.inviteCode !== undefined) {
      const activation = await this.activateInvite({ code: input.inviteCode });
      if (activation.ok) {
        return { ok: true, user: activation.user };
      }

      if (activation.code === "invite_already_used") {
        const activatedUser = await this.findActiveUserByInviteCode(input.inviteCode);
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

  public async createSession(input: CreateSessionInput): Promise<RealtimeSession> {
    const session: RealtimeSession = {
      id: createId("sess"),
      userId: input.userId,
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
      status: "active",
      startedAt: new Date(),
      durationMs: 0
    };
    if (input.device?.deviceId !== undefined) {
      session.deviceLabel = input.device.deviceId;
    }

    const inserted = await this.pool.query<SessionRow>(
      `
        INSERT INTO realtime_sessions (
          id, user_id, source_lang, target_lang, status, device_label, started_at, duration_ms
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `,
      [
        session.id,
        session.userId,
        session.sourceLang,
        session.targetLang,
        session.status,
        session.deviceLabel ?? null,
        session.startedAt,
        session.durationMs
      ]
    );

    return toSession(inserted.rows[0] ?? sessionRowFromModel(session));
  }

  public async finalizeSession(
    sessionId: string,
    status: Exclude<SessionStatus, "active">
  ): Promise<FinalizeSessionResult | undefined> {
    return this.withTransaction(async (client) => {
      const selected = await client.query<SessionRow>(
        "SELECT * FROM realtime_sessions WHERE id = $1 FOR UPDATE",
        [sessionId]
      );
      const row = selected.rows[0];
      if (row === undefined) {
        return undefined;
      }

      const session = toSession(row);
      if (session.status !== "active") {
        return { session, finalizedNow: false };
      }

      const endedAt = new Date();
      const durationMs = Math.max(0, endedAt.getTime() - session.startedAt.getTime());
      const updated = await client.query<SessionRow>(
        `
          UPDATE realtime_sessions
          SET status = $2, ended_at = $3, duration_ms = $4
          WHERE id = $1
          RETURNING *
        `,
        [sessionId, status, endedAt, durationMs]
      );
      const finalizedSession = toSession(updated.rows[0] ?? row);
      await this.insertUsageEvent(client, {
        userId: finalizedSession.userId,
        sessionId: finalizedSession.id,
        eventType: "session_realtime_duration",
        amount: finalizedSession.durationMs,
        unit: "milliseconds",
        model: "gateway"
      });

      return { session: finalizedSession, finalizedNow: true };
    });
  }

  public async recordSubtitleEvent(
    event: SubtitleSegmentUpdatedEvent
  ): Promise<void> {
    const updatedAt = new Date();
    const segment = segmentFromEvent(event, updatedAt);
    await this.withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO subtitle_segments (
            session_id,
            segment_id,
            start_ms,
            end_ms,
            source_text,
            target_text,
            status,
            revision,
            confidence,
            terms_hit,
            latency_ms,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (session_id, segment_id)
          DO UPDATE SET
            start_ms = EXCLUDED.start_ms,
            end_ms = EXCLUDED.end_ms,
            source_text = EXCLUDED.source_text,
            target_text = EXCLUDED.target_text,
            status = EXCLUDED.status,
            revision = EXCLUDED.revision,
            confidence = EXCLUDED.confidence,
            terms_hit = EXCLUDED.terms_hit,
            latency_ms = EXCLUDED.latency_ms,
            updated_at = EXCLUDED.updated_at
        `,
        [
          segment.sessionId,
          segment.segmentId,
          segment.startAtMs,
          segment.endAtMs,
          segment.sourceText,
          segment.targetText,
          segment.status,
          segment.revision,
          segment.confidence,
          segment.termsHit,
          segment.latencyMs,
          segment.updatedAt
        ]
      );

      await client.query(
        `
          INSERT INTO segment_revisions (
            id,
            session_id,
            segment_id,
            revision,
            status,
            source_text,
            target_text,
            reason,
            model_trace,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
        `,
        [
          createId("rev"),
          segment.sessionId,
          segment.segmentId,
          segment.revision,
          segment.status,
          segment.sourceText,
          segment.targetText,
          revisionReasonFor(segment.status),
          JSON.stringify(segment.modelTrace),
          updatedAt
        ]
      );
    });
  }

  public async recordSessionAudioObject(
    input: RecordSessionAudioObjectInput
  ): Promise<SessionAudioObject | undefined> {
    const selected = await this.pool.query<SessionRow>(
      "SELECT id FROM realtime_sessions WHERE id = $1",
      [input.sessionId]
    );
    if (selected.rows[0] === undefined) {
      return undefined;
    }

    const inserted = await this.pool.query<AudioObjectRow>(
      `
        INSERT INTO session_audio_objects (
          id, session_id, oss_key, format, duration_ms, size_bytes
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (session_id, oss_key)
        DO UPDATE SET
          format = EXCLUDED.format,
          duration_ms = EXCLUDED.duration_ms,
          size_bytes = EXCLUDED.size_bytes
        RETURNING *
      `,
      [
        createId("aud"),
        input.sessionId,
        input.objectKey,
        input.format,
        input.durationMs,
        input.sizeBytes
      ]
    );

    const row = inserted.rows[0];
    return row === undefined ? undefined : toAudioObject(row);
  }

  public async appendUsageEvent(input: UsageEventInput): Promise<UsageEvent> {
    return this.insertUsageEvent(this.pool, input);
  }

  public async listTermEntries(userId: string): Promise<TermEntry[]> {
    const result = await this.pool.query<TermEntryRow>(
      `
        SELECT id, user_id, source, target, mode, aliases
        FROM term_entries
        WHERE user_id IS NULL OR user_id = $1
        ORDER BY user_id NULLS FIRST, lower(source)
      `,
      [userId]
    );

    return result.rows.map(toTermEntry);
  }

  public async getUsageSummary(userId: string): Promise<UsageSummary> {
    return this.getUsageSummaryFor(this.pool, userId);
  }

  public async hasUser(userId: string): Promise<boolean> {
    const result = await this.pool.query<UserRow>(
      "SELECT id FROM users WHERE id = $1",
      [userId]
    );
    return result.rows[0] !== undefined;
  }

  public async getSessionSnapshot(
    sessionId: string
  ): Promise<SessionSnapshot | undefined> {
    const sessionResult = await this.pool.query<SessionRow>(
      "SELECT * FROM realtime_sessions WHERE id = $1",
      [sessionId]
    );
    const sessionRow = sessionResult.rows[0];
    if (sessionRow === undefined) {
      return undefined;
    }

    const [audioObjects, segments, revisions, usageEvents] = await Promise.all([
      this.pool.query<AudioObjectRow>(
        "SELECT * FROM session_audio_objects WHERE session_id = $1 ORDER BY created_at",
        [sessionId]
      ),
      this.pool.query<SegmentRow>(
        "SELECT * FROM subtitle_segments WHERE session_id = $1 ORDER BY start_ms, segment_id",
        [sessionId]
      ),
      this.pool.query<RevisionRow>(
        "SELECT * FROM segment_revisions WHERE session_id = $1 ORDER BY created_at, revision",
        [sessionId]
      ),
      this.pool.query<UsageEventRow>(
        "SELECT * FROM usage_events WHERE session_id = $1 ORDER BY created_at",
        [sessionId]
      )
    ]);

    const mappedRevisions = revisions.rows.map(toRevision);
    const modelTraceBySegment = new Map<string, ModelTrace>();
    for (const revision of mappedRevisions) {
      modelTraceBySegment.set(
        `${revision.sessionId}:${revision.segmentId}:${revision.revision}`,
        revision.modelTrace
      );
      modelTraceBySegment.set(
        `${revision.sessionId}:${revision.segmentId}`,
        revision.modelTrace
      );
    }

    return {
      session: toSession(sessionRow),
      audioObjects: audioObjects.rows.map(toAudioObject),
      segments: segments.rows.map((row) => toSegment(row, modelTraceBySegment)),
      revisions: mappedRevisions,
      usageEvents: usageEvents.rows.map(toUsageEvent)
    };
  }

  public async deleteSession(
    sessionId: string
  ): Promise<DeleteSessionResult | undefined> {
    const snapshot = await this.getSessionSnapshot(sessionId);
    if (snapshot === undefined) {
      return undefined;
    }

    const anonymizedUsageEvents = await this.withTransaction(async (client) => {
      const anonymized = await client.query(
        `
          UPDATE usage_events
          SET
            session_id = NULL,
            metadata = metadata || '{"deletedSession": true}'::jsonb
          WHERE session_id = $1
        `,
        [sessionId]
      );
      await client.query("DELETE FROM realtime_sessions WHERE id = $1", [sessionId]);
      return anonymized.rowCount ?? 0;
    });

    return { snapshot, anonymizedUsageEvents };
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  private async seedDevInvite(): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO invite_batches (id, name, quota_minutes, max_uses, expires_at)
          VALUES ('batch_alpha_dev', 'Alpha dev seed', $1, 1, '2026-12-31T23:59:59Z')
          ON CONFLICT (id)
          DO UPDATE SET quota_minutes = EXCLUDED.quota_minutes
        `,
        [this.config.seed.devInviteQuotaMinutes]
      );
      await client.query(
        `
          INSERT INTO invites (id, code_hash, batch_id, status)
          VALUES ('inv_alpha_dev', $1, 'batch_alpha_dev', 'available')
          ON CONFLICT (id) DO NOTHING
        `,
        [hashInviteCode(this.config.seed.devInviteCode)]
      );
    });
  }

  private async insertUsageEvent(
    client: DbClient,
    input: UsageEventInput
  ): Promise<UsageEvent> {
    const inserted = await client.query<UsageEventRow>(
      `
        INSERT INTO usage_events (
          id,
          user_id,
          session_id,
          event_type,
          amount,
          unit,
          model,
          cost_estimate,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING *
      `,
      [
        createId("use"),
        input.userId,
        input.sessionId ?? null,
        input.eventType,
        input.amount,
        input.unit,
        input.model ?? null,
        input.costEstimate ?? null,
        JSON.stringify(input.metadata ?? {})
      ]
    );

    return toUsageEvent(inserted.rows[0] ?? usageRowFromInput(input));
  }

  private async getUsageSummaryFor(
    client: DbClient,
    userId: string
  ): Promise<UsageSummary> {
    const user = await this.getUserById(client, userId);
    const quotaMinutes = user?.quotaMinutes ?? 0;
    const sums = await client.query<UsageSumRow>(
      `
        SELECT event_type, COALESCE(SUM(amount), 0) AS amount
        FROM usage_events
        WHERE user_id = $1
        GROUP BY event_type
      `,
      [userId]
    );
    const amountByType = new Map<UsageEventType, number>();
    for (const row of sums.rows) {
      amountByType.set(row.event_type, Number(row.amount));
    }

    const usedRealtimeMs = amountByType.get("session_realtime_duration") ?? 0;
    const usedMinutes = usedRealtimeMs / 60_000;

    return {
      userId,
      quotaMinutes,
      usedRealtimeMs,
      usedAsrMs: amountByType.get("asr_audio_duration") ?? 0,
      storageBytes: amountByType.get("oss_audio_storage") ?? 0,
      mtInputTokens: amountByType.get("mt_input_tokens") ?? 0,
      mtOutputTokens: amountByType.get("mt_output_tokens") ?? 0,
      revisionTokens: amountByType.get("revision_tokens") ?? 0,
      interpretationAudioMs:
        amountByType.get("interpretation_audio_duration") ?? 0,
      interruptions: amountByType.get("session_interruption") ?? 0,
      remainingMinutes: Math.max(0, quotaMinutes - usedMinutes)
    };
  }

  private async createUser(
    client: DbClient,
    input: ActivateInviteInput,
    quotaMinutes: number
  ): Promise<User> {
    const result = await client.query<UserRow>(
      `
        INSERT INTO users (id, email, phone, status, quota_minutes)
        VALUES ($1, $2, $3, 'active', $4)
        RETURNING *
      `,
      [createId("user"), input.email ?? null, input.phone ?? null, quotaMinutes]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("User insert did not return a row.");
    }
    return toUser(row);
  }

  private async findUserByContact(
    client: DbClient,
    email: string | undefined,
    phone: string | undefined
  ): Promise<User | undefined> {
    if (email !== undefined) {
      const result = await client.query<UserRow>(
        "SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1",
        [email]
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return toUser(row);
      }
    }

    if (phone !== undefined) {
      const result = await client.query<UserRow>(
        "SELECT * FROM users WHERE phone = $1 LIMIT 1",
        [phone]
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return toUser(row);
      }
    }

    return undefined;
  }

  private async getUserById(
    client: DbClient,
    userId: string
  ): Promise<User | undefined> {
    const result = await client.query<UserRow>(
      "SELECT * FROM users WHERE id = $1",
      [userId]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toUser(row);
  }

  private async findActiveUserByInviteCode(
    code: string
  ): Promise<User | undefined> {
    const result = await this.pool.query<UserRow>(
      `
        SELECT u.*
        FROM invites i
        JOIN users u ON u.id = i.activated_by
        WHERE i.code_hash = $1 AND u.status = 'active'
        LIMIT 1
      `,
      [hashInviteCode(code)]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toUser(row);
  }

  private async withTransaction<T>(
    handler: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await handler(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function createPgStore(config: PgStoreConfig): Promise<PgStore> {
  const store = new PgStore(config);
  await store.ensureReady();
  return store;
}

function toUser(row: UserRow): User {
  const user: User = {
    id: row.id,
    status: row.status,
    quotaMinutes: row.quota_minutes,
    createdAt: row.created_at
  };
  if (row.email !== null) {
    user.email = row.email;
  }
  if (row.phone !== null) {
    user.phone = row.phone;
  }
  return user;
}

function toInvite(row: InviteRow): Invite {
  const invite: Invite = {
    id: row.id,
    codeHash: row.code_hash,
    batchId: row.batch_id,
    status: row.status,
    createdAt: row.created_at
  };
  if (row.activated_by !== null) {
    invite.activatedBy = row.activated_by;
  }
  if (row.activated_at !== null) {
    invite.activatedAt = row.activated_at;
  }
  return invite;
}

function toSession(row: SessionRow): RealtimeSession {
  const session: RealtimeSession = {
    id: row.id,
    userId: row.user_id,
    sourceLang: row.source_lang,
    targetLang: row.target_lang,
    status: row.status,
    startedAt: row.started_at,
    durationMs: row.duration_ms
  };
  if (row.ended_at !== null) {
    session.endedAt = row.ended_at;
  }
  if (row.device_label !== null) {
    session.deviceLabel = row.device_label;
  }
  return session;
}

function toAudioObject(row: AudioObjectRow): SessionAudioObject {
  return {
    id: row.id,
    sessionId: row.session_id,
    objectKey: row.oss_key,
    format: row.format,
    durationMs: row.duration_ms,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at
  };
}

function toTermEntry(row: TermEntryRow): TermEntry {
  const entry: TermEntry = {
    id: row.id,
    source: row.source,
    mode: row.mode,
    aliases: [...row.aliases]
  };
  if (row.user_id !== null) {
    entry.userId = row.user_id;
  }
  if (row.target !== null) {
    entry.target = row.target;
  }
  return entry;
}

function toSegment(
  row: SegmentRow,
  modelTraceBySegment: Map<string, ModelTrace>
): SubtitleSegment {
  const exactRevisionKey = `${row.session_id}:${row.segment_id}:${row.revision}`;
  const segmentKey = `${row.session_id}:${row.segment_id}`;
  return {
    sessionId: row.session_id,
    segmentId: row.segment_id,
    status: row.status,
    sourceText: row.source_text,
    targetText: row.target_text,
    startAtMs: row.start_ms,
    endAtMs: row.end_ms,
    revision: row.revision,
    confidence: Number(row.confidence),
    termsHit: [...row.terms_hit],
    latencyMs: row.latency_ms,
    modelTrace:
      modelTraceBySegment.get(exactRevisionKey) ??
      modelTraceBySegment.get(segmentKey) ??
      fallbackModelTrace(),
    updatedAt: row.updated_at
  };
}

function toRevision(row: RevisionRow): SegmentRevision {
  return {
    id: row.id,
    sessionId: row.session_id,
    segmentId: row.segment_id,
    revision: row.revision,
    status: row.status,
    sourceText: row.source_text,
    targetText: row.target_text,
    reason: row.reason,
    modelTrace: readModelTrace(row.model_trace),
    createdAt: row.created_at
  };
}

function toUsageEvent(row: UsageEventRow): UsageEvent {
  const event: UsageEvent = {
    id: row.id,
    userId: row.user_id,
    eventType: row.event_type,
    amount: Number(row.amount),
    unit: row.unit,
    createdAt: row.created_at
  };
  if (row.session_id !== null) {
    event.sessionId = row.session_id;
  }
  if (row.model !== null) {
    event.model = row.model;
  }
  if (row.cost_estimate !== null) {
    event.costEstimate = Number(row.cost_estimate);
  }
  const metadata = readMetadata(row.metadata);
  if (metadata !== undefined) {
    event.metadata = metadata;
  }
  return event;
}

function readModelTrace(value: unknown): ModelTrace {
  if (!isRecord(value)) {
    return fallbackModelTrace();
  }

  if (
    (value.provider === "mock" || value.provider === "alibaba-cloud") &&
    (value.asrModel === "mock-asr" ||
      value.asrModel === "qwen3-asr-flash-realtime" ||
      value.asrModel === "fun-asr-realtime" ||
      value.asrModel === "paraformer-realtime-v2") &&
    (value.mtModel === "mock-mt" ||
      value.mtModel === "qwen-mt-flash" ||
      value.mtModel === "qwen-mt-lite" ||
      value.mtModel === "qwen-mt-plus") &&
    (value.correctionModel === undefined ||
      value.correctionModel === "mock-correction" ||
      value.correctionModel === "qwen-plus" ||
      value.correctionModel === "qwen-turbo")
  ) {
    const trace: ModelTrace = {
      provider: value.provider,
      asrModel: value.asrModel,
      mtModel: value.mtModel
    };
    if (value.correctionModel !== undefined) {
      trace.correctionModel = value.correctionModel;
    }
    return trace;
  }

  return fallbackModelTrace();
}

function fallbackModelTrace(): ModelTrace {
  return {
    provider: "mock",
    asrModel: "mock-asr",
    mtModel: "mock-mt"
  };
}

function readMetadata(
  value: unknown
): Record<string, string | number | boolean> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    ) {
      metadata[key] = entry;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionRowFromModel(session: RealtimeSession): SessionRow {
  return {
    id: session.id,
    user_id: session.userId,
    source_lang: session.sourceLang,
    target_lang: session.targetLang,
    status: session.status,
    device_label: session.deviceLabel ?? null,
    started_at: session.startedAt,
    ended_at: session.endedAt ?? null,
    duration_ms: session.durationMs
  };
}

function usageRowFromInput(input: UsageEventInput): UsageEventRow {
  return {
    id: createId("use"),
    user_id: input.userId,
    session_id: input.sessionId ?? null,
    event_type: input.eventType,
    amount: input.amount,
    unit: input.unit,
    model: input.model ?? null,
    cost_estimate: input.costEstimate ?? null,
    metadata: input.metadata ?? {},
    created_at: new Date()
  };
}
