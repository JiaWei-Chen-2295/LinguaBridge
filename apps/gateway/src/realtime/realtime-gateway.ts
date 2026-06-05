import type { FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  estimateTranslationTokens,
  mockRealtimeSubtitleStream
} from "@lingua-bridge/mock-models";
import type {
  GatewayErrorCode,
  GatewayErrorEvent,
  GatewayReadyEvent,
  RealtimeAudioFrameMessage,
  RealtimeClientMessage,
  RealtimeServerMessage,
  RealtimeSessionStartMessage,
  RealtimeSessionStopMessage,
  SessionStartedEvent,
  SessionStoppedEvent,
  SubtitleSegmentUpdatedEvent
} from "@lingua-bridge/protocol";
import type { GatewayConfig } from "../config";
import type {
  InMemoryStore,
  ResolveSessionUserInput
} from "../storage/in-memory-store";
import type { SessionArtifactRecorder } from "../storage/session-artifact-recorder";
import { parseRealtimeClientMessage } from "./ws-messages";

export interface RealtimeGatewayDeps {
  config: GatewayConfig;
  store: InMemoryStore;
  artifactRecorder: SessionArtifactRecorder;
}

export function registerRealtimeGateway(
  app: FastifyInstance,
  deps: RealtimeGatewayDeps
): void {
  const wss = new WebSocketServer({
    server: app.server,
    path: deps.config.websocketPath,
    maxPayload: deps.config.wsMaxPayloadBytes,
    perMessageDeflate: false
  });

  wss.on("connection", (socket, request) => {
    app.log.info(
      {
        remoteAddress: request.socket.remoteAddress,
        path: deps.config.websocketPath
      },
      "realtime websocket connected"
    );
    new RealtimeConnection(socket, app, deps);
  });

  app.addHook("onClose", (_instance, done) => {
    wss.close(() => done());
  });
}

class RealtimeConnection {
  private sessionId: string | undefined;
  private userId: string | undefined;
  private closed = false;
  private stoppedByClient = false;
  private messageQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly socket: WebSocket,
    private readonly app: FastifyInstance,
    private readonly deps: RealtimeGatewayDeps
  ) {
    this.sendReady();
    this.socket.on("message", (data) => {
      this.messageQueue = this.messageQueue
        .then(() => this.handleRawMessage(data))
        .catch((error: unknown) => {
          this.app.log.warn({ error }, "realtime message handling failed");
        });
    });
    this.socket.on("close", () => {
      this.closed = true;
      this.messageQueue = this.messageQueue
        .then(() => this.finalizeActiveSession("interrupted", true))
        .then(() => undefined)
        .catch((error: unknown) => {
          this.app.log.warn({ error }, "realtime close finalization failed");
        });
    });
    this.socket.on("error", (error) => {
      this.app.log.warn({ error }, "realtime websocket error");
    });
  }

  private async handleRawMessage(data: RawData): Promise<void> {
    const payload = rawDataToUtf8(data);
    const message = parseRealtimeClientMessage(payload);

    if (message === undefined) {
      this.sendError(
        "invalid_message",
        "Realtime message is not valid.",
        "Send a protocol v1 JSON message with a supported type."
      );
      return;
    }

    await this.handleClientMessage(message);
  }

  private async handleClientMessage(
    message: RealtimeClientMessage
  ): Promise<void> {
    if (message.type === "session.start") {
      await this.handleStart(message);
      return;
    }

    if (message.type === "audio.frame") {
      await this.handleAudioFrame(message);
      return;
    }

    if (message.type === "session.stop") {
      await this.handleStop(message);
      return;
    }

    this.sendError(
      "invalid_message",
      "Pause and resume are not implemented in the Alpha gateway skeleton.",
      "Stop the session and start a new one for this skeleton.",
      message.requestId
    );
  }

  private async handleStart(
    message: RealtimeSessionStartMessage
  ): Promise<void> {
    if (this.sessionId !== undefined) {
      this.sendError(
        "invalid_message",
        "Session is already active.",
        "Stop the current session before starting another one.",
        message.requestId
      );
      return;
    }

    if (!message.payload.privacyConsent.accepted) {
      this.sendError(
        "privacy_consent_required",
        "User consent is required before uploading and persisting system audio.",
        "Ask the user to accept the 30-day cloud retention consent before recording.",
        message.requestId
      );
      return;
    }

    const resolveInput: ResolveSessionUserInput = {};
    if (message.payload.userId !== undefined) {
      resolveInput.userId = message.payload.userId;
    }
    resolveInput.inviteCode = message.payload.inviteCode;

    const resolved = this.deps.store.resolveSessionUser(resolveInput);
    if (!resolved.ok) {
      this.sendError(
        "invite_required",
        resolved.message,
        "Activate a valid Alpha invite code before opening realtime subtitles.",
        message.requestId
      );
      return;
    }

    const session = this.deps.store.createSession({
      userId: resolved.user.id,
      sourceLang: message.payload.language.sourceLang,
      targetLang: message.payload.language.targetLang,
      device: message.payload.device
    });
    this.userId = resolved.user.id;
    this.sessionId = session.id;
    await this.deps.artifactRecorder.startSession({
      userId: resolved.user.id,
      sessionId: session.id
    });

    const event: SessionStartedEvent = {
      type: "session.started",
      version: 1,
      payload: {
        sessionId: session.id,
        userId: resolved.user.id,
        startedAt: session.startedAt.toISOString(),
        quotaRemainingMs: Math.round(
          this.deps.store.getUsageSummary(resolved.user.id).remainingMinutes * 60_000
        )
      }
    };
    this.sendEvent(event);

    void this.pushMockSubtitleEvents(
      session.id,
      session.sourceLang,
      session.targetLang
    );
  }

  private async handleAudioFrame(
    message: RealtimeAudioFrameMessage
  ): Promise<void> {
    if (this.sessionId === undefined || this.userId === undefined) {
      this.sendError(
        "session_not_found",
        "Start a session before audio frames.",
        "Send session.start and wait for session.started.",
        message.requestId
      );
      return;
    }

    if (message.payload.sessionId !== this.sessionId) {
      this.sendError(
        "session_not_found",
        "Audio frame sessionId does not match.",
        "Use the active sessionId returned by session.started.",
        message.requestId
      );
      return;
    }

    const storedFrame = await this.deps.artifactRecorder.appendAudioFrame({
      sessionId: this.sessionId,
      pcmBase64: message.payload.pcmBase64,
      durationMs: message.payload.durationMs
    });
    const storedBytes =
      storedFrame?.sizeBytes ?? estimateBase64DecodedBytes(message.payload.pcmBase64);

    this.deps.store.appendUsageEvent({
      userId: this.userId,
      sessionId: this.sessionId,
      eventType: "asr_audio_duration",
      amount: message.payload.durationMs,
      unit: "milliseconds",
      model: "mock-asr",
      metadata: {
        sequence: message.payload.sequence,
        sampleRate: message.payload.sampleRate,
        channels: message.payload.channels
      }
    });
    this.deps.store.appendUsageEvent({
      userId: this.userId,
      sessionId: this.sessionId,
      eventType: "oss_audio_storage",
      amount: storedBytes,
      unit: "bytes",
      model: "local-dev-object-store"
    });
  }

  private async handleStop(
    message: RealtimeSessionStopMessage
  ): Promise<void> {
    if (this.sessionId === undefined) {
      this.sendError(
        "session_not_found",
        "No realtime session is active.",
        "Start a session before sending session.stop.",
        message.requestId
      );
      return;
    }

    if (message.payload.sessionId !== this.sessionId) {
      this.sendError(
        "session_not_found",
        "Stop sessionId does not match.",
        "Use the active sessionId returned by session.started.",
        message.requestId
      );
      return;
    }

    this.stoppedByClient = true;
    const result = await this.finalizeActiveSession("completed", false);
    if (result !== undefined) {
      const event: SessionStoppedEvent = {
        type: "session.stopped",
        version: 1,
        payload: {
          sessionId: result.session.id,
          status: "stopped",
          stoppedAt: result.session.endedAt?.toISOString() ?? new Date().toISOString(),
          durationMs: result.session.durationMs,
          exportUrls: {
            markdown: `/sessions/${result.session.id}/export?format=markdown`,
            srt: `/sessions/${result.session.id}/export?format=srt`,
            json: `/sessions/${result.session.id}/export?format=json`
          }
        }
      };
      this.sendEvent(event);
    }

    this.socket.close(1000, "session stopped");
  }

  private async pushMockSubtitleEvents(
    sessionId: string,
    sourceLang: string,
    targetLang: string
  ): Promise<void> {
    for await (const event of mockRealtimeSubtitleStream(
      { sessionId, sourceLang, targetLang },
      { delayMs: this.deps.config.mockSubtitleDelayMs }
    )) {
      if (this.closed || this.sessionId !== sessionId || this.userId === undefined) {
        return;
      }

      this.recordModelUsage(event);
      this.deps.store.recordSubtitleEvent(event);
      await this.persistTranscriptSnapshot(event.payload.sessionId);
      this.sendEvent(event);
    }
  }

  private recordModelUsage(event: SubtitleSegmentUpdatedEvent): void {
    if (this.userId === undefined) {
      return;
    }

    if (event.payload.status === "final" || event.payload.status === "revised") {
      this.deps.store.appendUsageEvent({
        userId: this.userId,
        sessionId: event.payload.sessionId,
        eventType: "mt_input_tokens",
        amount: estimateTranslationTokens(event.payload.sourceText),
        unit: "tokens",
        model: "mock-qwen-mt"
      });
      this.deps.store.appendUsageEvent({
        userId: this.userId,
        sessionId: event.payload.sessionId,
        eventType: "mt_output_tokens",
        amount: estimateTranslationTokens(event.payload.targetText),
        unit: "tokens",
        model: "mock-qwen-mt"
      });
    }

    if (event.payload.status === "revised") {
      this.deps.store.appendUsageEvent({
        userId: this.userId,
        sessionId: event.payload.sessionId,
        eventType: "revision_tokens",
        amount: estimateTranslationTokens(
          `${event.payload.sourceText} ${event.payload.targetText}`
        ),
        unit: "tokens",
        model: "mock-context-reviser"
      });
    }
  }

  private finalizeActiveSession(
    status: "completed" | "interrupted",
    interrupted: boolean
  ): Promise<ReturnType<InMemoryStore["finalizeSession"]>> {
    if (this.sessionId === undefined || this.userId === undefined) {
      return Promise.resolve(undefined);
    }

    if (interrupted && this.stoppedByClient) {
      return Promise.resolve(undefined);
    }

    const result = this.deps.store.finalizeSession(this.sessionId, status);
    if (result !== undefined && result.finalizedNow && interrupted) {
      this.deps.store.appendUsageEvent({
        userId: this.userId,
        sessionId: this.sessionId,
        eventType: "session_interruption",
        amount: 1,
        unit: "count",
        model: "gateway"
      });
    }

    if (result !== undefined) {
      return this.finalizeArtifacts(result).then(() => result);
    }

    return Promise.resolve(undefined);
  }

  private async finalizeArtifacts(
    result: NonNullable<ReturnType<InMemoryStore["finalizeSession"]>>
  ): Promise<void> {
    const initialSnapshot = this.deps.store.getSessionSnapshot(result.session.id);
    if (initialSnapshot === undefined) {
      return;
    }

    const finalized = await this.deps.artifactRecorder.finalizeSession(
      initialSnapshot
    );
    if (finalized.audioObject !== undefined) {
      this.deps.store.recordSessionAudioObject({
        sessionId: result.session.id,
        objectKey: finalized.audioObject.objectKey,
        format: finalized.audioObject.format,
        durationMs: finalized.audioObject.durationMs,
        sizeBytes: finalized.audioObject.sizeBytes
      });
      const snapshot = this.deps.store.getSessionSnapshot(result.session.id);
      if (snapshot !== undefined) {
        await this.deps.artifactRecorder.persistSessionDocuments(snapshot);
      }
      return;
    }

    await this.deps.artifactRecorder.persistSessionDocuments(initialSnapshot);
  }

  private async persistTranscriptSnapshot(sessionId: string): Promise<void> {
    const snapshot = this.deps.store.getSessionSnapshot(sessionId);
    if (snapshot === undefined) {
      return;
    }

    await this.deps.artifactRecorder.persistTranscriptSnapshot(snapshot);
  }

  private sendReady(): void {
    const event: GatewayReadyEvent = {
      type: "gateway.ready",
      version: 1,
      payload: {
        heartbeatIntervalMs: 30_000,
        acceptedAudioFormat: {
          codec: "pcm_s16le",
          sampleRate: 16000,
          channels: 1,
          frameDurationMs: 20
        }
      }
    };
    this.sendEvent(event);
  }

  private sendError(
    code: GatewayErrorCode,
    message: string,
    nextStep: string,
    requestId?: string
  ): void {
    const payload: GatewayErrorEvent["payload"] = {
      code,
      message,
      nextStep
    };

    if (requestId !== undefined) {
      payload.requestId = requestId;
    }

    if (this.sessionId !== undefined) {
      payload.sessionId = this.sessionId;
    }

    const event: GatewayErrorEvent = {
      type: "gateway.error",
      version: 1,
      payload
    };

    this.sendEvent(event);
  }

  private sendEvent(event: RealtimeServerMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event));
    }
  }
}

function rawDataToUtf8(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
}

function estimateBase64DecodedBytes(value: string): number {
  const normalized = value.replaceAll("=", "");
  return Math.floor((normalized.length * 3) / 4);
}
