import type { FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type {
  GatewayErrorCode,
  GatewayErrorEvent,
  InterpretationOptions,
  GatewayReadyEvent,
  InterpretationAudioCompletedEvent,
  InterpretationAudioDeltaEvent,
  RealtimeSessionMode,
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
import type { UsageEventInput } from "../domain/models";
import type { SessionArtifactRecorder } from "../storage/session-artifact-recorder";
import type {
  FinalizeSessionResult,
  GatewayStore,
  ResolveSessionUserInput
} from "../storage/store";
import {
  createRealtimeModelSession,
  getRealtimeModelProviderIssue,
  type RealtimeModelProviderError,
  type RealtimeModelSession,
  type RealtimeModelSessionCallbacks,
  type RealtimeModelUsageEvent
} from "./model-session";
import { parseRealtimeClientMessage } from "./ws-messages";

export interface RealtimeGatewayDeps {
  config: GatewayConfig;
  store: GatewayStore;
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
  wss.on("error", (error) => {
    app.log.error(
      {
        error,
        host: deps.config.host,
        port: deps.config.port,
        path: deps.config.websocketPath
      },
      "realtime websocket server failed"
    );
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
  private modelSession: RealtimeModelSession | undefined;
  private sessionMode: RealtimeSessionMode = "subtitle";
  private sessionDiagnostics: Record<string, string | number | boolean> | undefined;
  private providerErrorSent = false;
  private readonly pendingSubtitlePersistence = new Set<Promise<void>>();

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

    const providerIssue = getRealtimeModelProviderIssue(this.deps.config);
    if (providerIssue !== undefined) {
      this.sendModelProviderError(providerIssue, message.requestId);
      return;
    }

    const resolveInput: ResolveSessionUserInput = {};
    if (message.payload.userId !== undefined) {
      resolveInput.userId = message.payload.userId;
    }
    resolveInput.inviteCode = message.payload.inviteCode;

    const resolved = await this.deps.store.resolveSessionUser(resolveInput);
    if (!resolved.ok) {
      this.sendError(
        "invite_required",
        resolved.message,
        "Activate a valid Alpha invite code before opening realtime subtitles.",
        message.requestId
      );
      return;
    }

    const session = await this.deps.store.createSession({
      userId: resolved.user.id,
      sourceLang: message.payload.language.sourceLang,
      targetLang: message.payload.language.targetLang,
      device: message.payload.device
    });
    this.userId = resolved.user.id;
    this.sessionId = session.id;
    this.sessionMode = message.payload.mode ?? "subtitle";
    this.sessionDiagnostics = buildSessionDiagnostics(
      this.sessionMode,
      message.payload.interpretation
    );
    await this.deps.artifactRecorder.startSession({
      userId: resolved.user.id,
      sessionId: session.id
    });
    this.recordUsageEvent({
      userId: resolved.user.id,
      sessionId: session.id,
      eventType: "session_metadata",
      amount: 1,
      unit: "count",
      model: "gateway",
      metadata: this.sessionDiagnostics
    });
    const termEntries = await this.deps.store.listTermEntries(resolved.user.id);

    const modelCallbacks: RealtimeModelSessionCallbacks = {
      onSubtitleEvent: (event) => this.handleSubtitleEvent(event),
      onInterpretationAudioDelta: (event) =>
        this.handleInterpretationAudioDelta(event),
      onInterpretationAudioCompleted: (event) =>
        this.handleInterpretationAudioCompleted(event),
      onUsageEvent: (event) => this.handleModelUsageEvent(event),
      onProviderError: (error) => this.sendModelProviderError(error)
    };
    const modelSessionInput = {
      config: this.deps.config,
      mode: this.sessionMode,
      context: {
        sessionId: session.id,
        sourceLang: session.sourceLang,
        targetLang: session.targetLang
      },
      callbacks: modelCallbacks,
      termEntries,
      log: this.app.log
    };
    this.modelSession = createRealtimeModelSession(
      message.payload.interpretation === undefined
        ? modelSessionInput
        : {
            ...modelSessionInput,
            interpretation: message.payload.interpretation
          }
    );

    try {
      await this.modelSession.start();
    } catch (error: unknown) {
      await this.finalizeActiveSession("interrupted", true);
      this.sendModelProviderError(
        {
          message: "Realtime model provider could not be started.",
          nextStep:
            "Check the gateway model environment variables and use MODEL_PROVIDER=mock for local validation without cloud credentials.",
          cause: error
        },
        message.requestId
      );
      return;
    }

    const event: SessionStartedEvent = {
      type: "session.started",
      version: 1,
      payload: {
        sessionId: session.id,
        userId: resolved.user.id,
        startedAt: session.startedAt.toISOString(),
        quotaRemainingMs: Math.round(
          (await this.deps.store.getUsageSummary(resolved.user.id))
            .remainingMinutes * 60_000
        )
      }
    };
    this.sendEvent(event);
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

    this.recordUsageEvent({
      userId: this.userId,
      sessionId: this.sessionId,
      eventType: "asr_audio_duration",
      amount: message.payload.durationMs,
      unit: "milliseconds",
      model: this.getInputAudioUsageModel(),
      metadata: {
        ...this.sessionDiagnostics,
        sequence: message.payload.sequence,
        sampleRate: message.payload.sampleRate,
        channels: message.payload.channels
      }
    });
    this.recordUsageEvent({
      userId: this.userId,
      sessionId: this.sessionId,
      eventType: "oss_audio_storage",
      amount: storedBytes,
      unit: "bytes",
      model: "local-dev-object-store"
    });

    try {
      await this.modelSession?.appendAudioFrame(message.payload);
    } catch (error: unknown) {
      this.sendModelProviderError({
        message: "Audio frame could not be sent to the realtime model provider.",
        nextStep:
          "Check the model provider connection and retry the session. Use MODEL_PROVIDER=mock to validate the local audio path.",
        cause: error
      });
    }
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

  private async handleSubtitleEvent(
    event: SubtitleSegmentUpdatedEvent
  ): Promise<void> {
    if (
      this.closed ||
      this.sessionId !== event.payload.sessionId ||
      this.userId === undefined
    ) {
      return;
    }

    this.sendEvent(event);
    this.app.log.info(
      {
        sessionId: event.payload.sessionId,
        segmentId: event.payload.segmentId,
        status: event.payload.status,
        revision: event.payload.revision,
        sourceLength: event.payload.sourceText.length,
        targetLength: event.payload.targetText.length,
        latencyMs: event.payload.latencyMs
      },
      "subtitle segment emitted"
    );

    const persistence = this.persistSubtitleEvent(event).catch((error: unknown) => {
      this.app.log.warn(
        {
          error,
          sessionId: event.payload.sessionId,
          segmentId: event.payload.segmentId,
          status: event.payload.status,
          revision: event.payload.revision
        },
        "subtitle event persistence failed"
      );
    });
    this.pendingSubtitlePersistence.add(persistence);
    void persistence.finally(() => {
      this.pendingSubtitlePersistence.delete(persistence);
    });
  }

  private async handleInterpretationAudioDelta(
    event: InterpretationAudioDeltaEvent
  ): Promise<void> {
    const sessionId = this.sessionId;
    const userId = this.userId;
    if (
      this.closed ||
      sessionId === undefined ||
      userId === undefined ||
      sessionId !== event.payload.sessionId
    ) {
      return;
    }

    this.sendEvent(event);
    const storedFrame = await this.deps.artifactRecorder.appendInterpretationAudioFrame({
      sessionId: event.payload.sessionId,
      pcmBase64: event.payload.pcmBase64,
      durationMs: event.payload.durationMs,
      sampleFormat: event.payload.sampleFormat,
      sampleRate: event.payload.sampleRate
    });
    const storedBytes =
      storedFrame?.sizeBytes ?? estimateBase64DecodedBytes(event.payload.pcmBase64);

    this.recordUsageEvent({
      userId,
      sessionId,
      eventType: "interpretation_audio_duration",
      amount: event.payload.durationMs,
      unit: "milliseconds",
      model: event.payload.modelTrace.liveTranslateModel ?? event.payload.modelTrace.mtModel,
      metadata: {
        ...this.sessionDiagnostics,
        sequence: event.payload.sequence,
        trackId: event.payload.trackId,
        sampleFormat: event.payload.sampleFormat,
        sampleRate: event.payload.sampleRate
      }
    });
    this.recordUsageEvent({
      userId,
      sessionId,
      eventType: "interpretation_audio_storage",
      amount: storedBytes,
      unit: "bytes",
      model: "local-dev-object-store",
      metadata: {
        ...this.sessionDiagnostics,
        trackId: event.payload.trackId
      }
    });
  }

  private async handleInterpretationAudioCompleted(
    event: InterpretationAudioCompletedEvent
  ): Promise<void> {
    if (this.closed || this.sessionId !== event.payload.sessionId) {
      return;
    }

    this.sendEvent(event);
  }

  private handleModelUsageEvent(event: RealtimeModelUsageEvent): void {
    if (this.userId === undefined || this.sessionId === undefined) {
      return;
    }

    this.recordUsageEvent({
      userId: this.userId,
      sessionId: this.sessionId,
      eventType: event.eventType,
      amount: event.amount,
      unit: event.unit,
      model: event.model,
      metadata: {
        ...this.sessionDiagnostics,
        ...event.metadata
      }
    });
  }

  private async finalizeActiveSession(
    status: "completed" | "interrupted",
    interrupted: boolean
  ): Promise<FinalizeSessionResult | undefined> {
    if (this.sessionId === undefined || this.userId === undefined) {
      return undefined;
    }

    if (interrupted && this.stoppedByClient) {
      return undefined;
    }

    const result = await this.deps.store.finalizeSession(this.sessionId, status);
    const activeModelSession = this.modelSession;
    this.modelSession = undefined;
    if (result !== undefined && result.finalizedNow && interrupted) {
      this.recordUsageEvent({
        userId: this.userId,
        sessionId: this.sessionId,
        eventType: "session_interruption",
        amount: 1,
        unit: "count",
        model: "gateway"
      });
    }

    if (result !== undefined) {
      await activeModelSession?.stop().catch((error: unknown) => {
        this.app.log.warn({ error }, "realtime model session stop failed");
      });
      await this.waitForSubtitlePersistence();
      await this.finalizeArtifacts(result);
      return result;
    }

    if (activeModelSession !== undefined) {
      await activeModelSession.stop().catch((error: unknown) => {
        this.app.log.warn({ error }, "realtime model session stop failed");
      });
      await this.waitForSubtitlePersistence();
    }

    return undefined;
  }

  private sendModelProviderError(
    error: RealtimeModelProviderError,
    requestId?: string
  ): void {
    if (this.providerErrorSent && requestId === undefined) {
      return;
    }

    this.providerErrorSent = true;
    this.app.log.warn(
      {
        error: error.cause,
        sessionId: this.sessionId,
        userId: this.userId,
        requestId,
        message: error.message,
        nextStep: error.nextStep
      },
      "realtime model provider error"
    );
    this.sendError(
      "model_provider_unavailable",
      error.message,
      error.nextStep,
      requestId
    );
  }

  private getInputAudioUsageModel(): string {
    if (this.sessionMode === "interpretation") {
      return this.deps.config.model.liveTranslateSpike.model;
    }

    if (this.deps.config.model.provider === "alibaba-cloud") {
      return this.deps.config.model.alibabaCloud.asrModel;
    }

    return "mock-asr";
  }

  private recordUsageEvent(input: UsageEventInput): void {
    void Promise.resolve(this.deps.store.appendUsageEvent(input)).catch(
      (error: unknown) => {
        this.app.log.warn(
          {
            error,
            sessionId: input.sessionId,
            userId: input.userId,
            eventType: input.eventType
          },
          "usage event persistence failed"
        );
      }
    );
  }

  private async finalizeArtifacts(
    result: FinalizeSessionResult
  ): Promise<void> {
    const initialSnapshot = await this.deps.store.getSessionSnapshot(
      result.session.id
    );
    if (initialSnapshot === undefined) {
      return;
    }

    const finalized = await this.deps.artifactRecorder.finalizeSession(
      initialSnapshot
    );
    if (finalized.audioObjects.length > 0) {
      for (const audioObject of finalized.audioObjects) {
        await this.deps.store.recordSessionAudioObject({
          sessionId: result.session.id,
          objectKey: audioObject.objectKey,
          format: audioObject.format,
          durationMs: audioObject.durationMs,
          sizeBytes: audioObject.sizeBytes
        });
      }
      const snapshot = await this.deps.store.getSessionSnapshot(result.session.id);
      if (snapshot !== undefined) {
        await this.deps.artifactRecorder.persistSessionDocuments(snapshot);
      }
      return;
    }

    if (finalized.audioObject !== undefined) {
      await this.deps.store.recordSessionAudioObject({
        sessionId: result.session.id,
        objectKey: finalized.audioObject.objectKey,
        format: finalized.audioObject.format,
        durationMs: finalized.audioObject.durationMs,
        sizeBytes: finalized.audioObject.sizeBytes
      });
      const snapshot = await this.deps.store.getSessionSnapshot(result.session.id);
      if (snapshot !== undefined) {
        await this.deps.artifactRecorder.persistSessionDocuments(snapshot);
      }
      return;
    }

    await this.deps.artifactRecorder.persistSessionDocuments(initialSnapshot);
  }

  private async persistTranscriptSnapshot(sessionId: string): Promise<void> {
    const snapshot = await this.deps.store.getSessionSnapshot(sessionId);
    if (snapshot === undefined) {
      return;
    }

    await this.deps.artifactRecorder.persistTranscriptSnapshot(snapshot);
  }

  private async persistSubtitleEvent(
    event: SubtitleSegmentUpdatedEvent
  ): Promise<void> {
    await this.deps.store.recordSubtitleEvent(event);
    await this.persistTranscriptSnapshot(event.payload.sessionId);
  }

  private async waitForSubtitlePersistence(): Promise<void> {
    while (this.pendingSubtitlePersistence.size > 0) {
      await Promise.allSettled(Array.from(this.pendingSubtitlePersistence));
    }
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

function buildSessionDiagnostics(
  mode: RealtimeSessionMode,
  interpretation: InterpretationOptions | undefined
): Record<string, string | number | boolean> {
  if (mode !== "interpretation") {
    return {
      mode,
      outputAudio: false,
      echoAvoidance: "disabled",
      echoRiskAccepted: false
    };
  }

  return {
    mode,
    outputAudio: interpretation?.outputAudio ?? false,
    echoAvoidance: interpretation?.echoAvoidance ?? "disabled",
    echoRiskAccepted: interpretation?.echoRiskAccepted === true
  };
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
