import type {
  ModelTrace,
  SubtitleSegmentStatus,
  SubtitleSegmentUpdatedEvent
} from "@lingua-bridge/protocol";
import type { FastifyBaseLogger } from "fastify";
import { WebSocket } from "ws";
import type { AlibabaCloudModelConfig } from "../config";
import type {
  RealtimeAudioFramePayload,
  RealtimeModelSession,
  RealtimeModelSessionCallbacks,
  RealtimeModelSessionContext
} from "./model-session";

interface AlibabaCloudRealtimeModelSessionInput {
  config: AlibabaCloudModelConfig;
  context: RealtimeModelSessionContext;
  callbacks: RealtimeModelSessionCallbacks;
  log: FastifyBaseLogger;
}

interface QwenAsrTextEvent {
  type: "conversation.item.input_audio_transcription.text";
  item_id?: string;
  text?: string;
  stash?: string;
}

interface QwenAsrCompletedEvent {
  type: "conversation.item.input_audio_transcription.completed";
  item_id?: string;
  transcript?: string;
}

interface QwenAsrFailedEvent {
  type: "conversation.item.input_audio_transcription.failed";
  error?: {
    code?: string;
    message?: string;
    param?: string;
  };
}

interface QwenAsrSpeechStartedEvent {
  type: "input_audio_buffer.speech_started";
  item_id?: string;
  audio_start_ms?: number;
}

interface QwenAsrSpeechStoppedEvent {
  type: "input_audio_buffer.speech_stopped";
  item_id?: string;
  audio_end_ms?: number;
}

interface QwenAsrInputAudioBufferCommittedEvent {
  type: "input_audio_buffer.committed";
}

interface QwenAsrConversationItemCreatedEvent {
  type: "conversation.item.created";
}

interface QwenAsrErrorEvent {
  type: "error";
  error?: {
    code?: string;
    message?: string;
    param?: string;
  };
}

interface QwenAsrSessionFinishedEvent {
  type: "session.finished";
}

interface QwenAsrSessionCreatedEvent {
  type: "session.created";
}

interface QwenAsrSessionUpdatedEvent {
  type: "session.updated";
}

type QwenAsrServerEvent =
  | QwenAsrTextEvent
  | QwenAsrCompletedEvent
  | QwenAsrFailedEvent
  | QwenAsrSpeechStartedEvent
  | QwenAsrSpeechStoppedEvent
  | QwenAsrInputAudioBufferCommittedEvent
  | QwenAsrConversationItemCreatedEvent
  | QwenAsrErrorEvent
  | QwenAsrSessionCreatedEvent
  | QwenAsrSessionUpdatedEvent
  | QwenAsrSessionFinishedEvent
  | QwenAsrUnknownEvent;

interface QwenAsrUnknownEvent {
  type: "unknown";
  rawType?: string;
}

interface TranslationResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class AlibabaCloudRealtimeModelSession implements RealtimeModelSession {
  private socket: WebSocket | undefined;
  private startedAtMs = Date.now();
  private audioCursorMs = 0;
  private frameCount = 0;
  private segmentIndex = 0;
  private stopped = false;
  private readonly itemStartMs = new Map<string, number>();
  private readonly itemEndMs = new Map<string, number>();
  private readonly draftTextByItemId = new Map<string, string>();
  private readonly pendingEvents = new Set<Promise<void>>();
  private sessionUpdatedResolver: (() => void) | undefined;
  private sessionUpdatedRejecter: ((error: Error) => void) | undefined;
  private finishedResolver: (() => void) | undefined;
  private readonly finished = new Promise<void>((resolve) => {
    this.finishedResolver = resolve;
  });

  public constructor(private readonly input: AlibabaCloudRealtimeModelSessionInput) {}

  public async start(): Promise<void> {
    if (this.input.config.apiKey === undefined) {
      throw new Error("Alibaba Cloud API key is not configured.");
    }

    this.startedAtMs = Date.now();
    const socket = new WebSocket(this.buildRealtimeUrl(), {
      headers: {
        Authorization: `Bearer ${this.input.config.apiKey}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });
    this.socket = socket;

    socket.on("message", (data) => {
      this.handleServerMessage(data.toString()).catch((error: unknown) => {
        this.reportProviderError(
          "Alibaba Cloud ASR event handling failed.",
          "Check the gateway logs and retry the realtime session.",
          error
        );
      });
    });
    socket.on("error", (error) => {
      this.reportProviderError(
        "Alibaba Cloud ASR WebSocket failed.",
        "Verify DASHSCOPE_API_KEY, endpoint region, and outbound network access.",
        error
      );
    });
    socket.on("close", () => {
      this.finishedResolver?.();
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for Alibaba Cloud ASR session.updated event."));
      }, this.input.config.requestTimeoutMs);
      const cleanup = (): void => {
        clearTimeout(timeout);
        socket.off("error", onError);
        socket.off("close", onClose);
        this.sessionUpdatedResolver = undefined;
        this.sessionUpdatedRejecter = undefined;
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("Alibaba Cloud ASR WebSocket closed before session.updated."));
      };

      this.sessionUpdatedResolver = () => {
        cleanup();
        this.input.log.info(
          {
            sessionId: this.input.context.sessionId,
            asrModel: this.input.config.asrModel,
            mtModel: this.input.config.mtModel,
            inputAudioFormat: this.input.config.inputAudioFormat,
            asrWebsocketUrl: redactUrlQuery(this.input.config.asrWebsocketUrl),
            openAiBaseUrl: this.input.config.openAiBaseUrl
          },
          "Alibaba Cloud realtime ASR session connected"
        );
        resolve();
      };
      this.sessionUpdatedRejecter = (error) => {
        cleanup();
        reject(error);
      };
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("open", () => {
        this.sendSessionUpdate();
      });
    });
  }

  public appendAudioFrame(frame: RealtimeAudioFramePayload): Promise<void> {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.resolve();
    }

    this.audioCursorMs += frame.durationMs;
    this.frameCount += 1;
    if (this.frameCount === 1 || this.frameCount % 50 === 0) {
      this.input.log.debug(
        {
          sessionId: this.input.context.sessionId,
          framesSent: this.frameCount,
          audioCursorMs: this.audioCursorMs,
          frameDurationMs: frame.durationMs
        },
        "sent audio frame to Alibaba Cloud realtime ASR"
      );
    }
    this.socket.send(
      JSON.stringify({
        event_id: createEventId("audio"),
        type: "input_audio_buffer.append",
        audio: frame.pcmBase64
      })
    );
    return Promise.resolve();
  }

  public async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({
          event_id: createEventId("finish"),
          type: "session.finish"
        })
      );
    }

    await Promise.race([
      this.finished,
      wait(this.input.config.requestTimeoutMs)
    ]);
    await Promise.allSettled(Array.from(this.pendingEvents));

    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(1000, "LinguaBridge session stopped");
    }
  }

  private async handleServerMessage(message: string): Promise<void> {
    const event = parseServerEvent(message);
    if (event === undefined) {
      this.input.log.debug({ message }, "ignored unparseable Alibaba Cloud ASR event");
      return;
    }

    if (event.type !== "unknown") {
      this.input.log.debug(
        {
          sessionId: this.input.context.sessionId,
          eventType: event.type
        },
        "received Alibaba Cloud realtime ASR event"
      );
    } else {
      this.input.log.debug(
        {
          sessionId: this.input.context.sessionId,
          eventType: event.rawType ?? "unknown"
        },
        "received unsupported Alibaba Cloud realtime ASR event"
      );
    }

    if (event.type === "input_audio_buffer.speech_started") {
      this.recordSpeechStart(event as QwenAsrSpeechStartedEvent);
      return;
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      this.recordSpeechStop(event as QwenAsrSpeechStoppedEvent);
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.text") {
      this.handleAsrDraft(event as QwenAsrTextEvent);
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      this.trackPending(this.handleAsrFinal(event as QwenAsrCompletedEvent));
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.failed") {
      const failedEvent = event as QwenAsrFailedEvent;
      this.reportProviderError(
        failedEvent.error?.message ?? "Alibaba Cloud ASR failed to transcribe an audio item.",
        "Try a cleaner source, check that the audio is PCM16 16 kHz mono, or restart the session.",
        failedEvent.error
      );
      return;
    }

    if (event.type === "error") {
      const errorEvent = event as QwenAsrErrorEvent;
      const message = alibabaCloudErrorMessage(
        errorEvent.error,
        "Alibaba Cloud ASR returned an error."
      );
      if (this.sessionUpdatedRejecter !== undefined) {
        this.sessionUpdatedRejecter(new Error(message));
        return;
      }

      this.reportProviderError(
        message,
        "Check model provider credentials, endpoint region, model name, and request parameters.",
        errorEvent.error
      );
      return;
    }

    if (event.type === "session.updated") {
      this.sessionUpdatedResolver?.();
      return;
    }

    if (event.type === "session.finished") {
      this.finishedResolver?.();
    }
  }

  private recordSpeechStart(event: QwenAsrSpeechStartedEvent): void {
    const itemId = event.item_id;
    if (itemId === undefined) {
      return;
    }

    this.itemStartMs.set(itemId, event.audio_start_ms ?? this.audioCursorMs);
  }

  private recordSpeechStop(event: QwenAsrSpeechStoppedEvent): void {
    const itemId = event.item_id;
    if (itemId === undefined) {
      return;
    }

    this.itemEndMs.set(itemId, event.audio_end_ms ?? this.audioCursorMs);
  }

  private handleAsrDraft(event: QwenAsrTextEvent): void {
    const itemId = event.item_id;
    const sourceText = `${event.text ?? ""}${event.stash ?? ""}`.trim();
    if (
      itemId === undefined ||
      sourceText.length === 0 ||
      this.draftTextByItemId.get(itemId) === sourceText
    ) {
      return;
    }

    this.draftTextByItemId.set(itemId, sourceText);
    if (!this.input.config.translateDrafts) {
      return;
    }

    this.trackPending(
      this.translate(sourceText).then((targetText) =>
        this.emitSubtitle({
          itemId,
          sourceText,
          targetText,
          status: "draft"
        })
      )
    );
  }

  private async handleAsrFinal(event: QwenAsrCompletedEvent): Promise<void> {
    const sourceText = event.transcript?.trim();
    if (sourceText === undefined || sourceText.length === 0) {
      this.input.log.warn(
        {
          sessionId: this.input.context.sessionId,
          itemId: event.item_id
        },
        "Alibaba Cloud ASR completed with an empty transcript"
      );
      return;
    }

    this.input.log.info(
      {
        sessionId: this.input.context.sessionId,
        itemId: event.item_id,
        sourceLength: sourceText.length
      },
      "Alibaba Cloud ASR final transcript received"
    );
    const targetText = await this.translate(sourceText);
    await this.emitSubtitle({
      itemId: event.item_id,
      sourceText,
      targetText,
      status: "final"
    });
  }

  private async translate(sourceText: string): Promise<string> {
    const response = await fetch(`${this.input.config.openAiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.input.config.apiKey ?? ""}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.input.config.mtModel,
        messages: [
          {
            role: "user",
            content: sourceText
          }
        ],
        translation_options: {
          source_lang: "English",
          target_lang: "Chinese"
        }
      }),
      signal: AbortSignal.timeout(this.input.config.requestTimeoutMs)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Qwen-MT request failed with HTTP ${response.status}: ${body}`);
    }

    const payload = (await response.json()) as TranslationResponse;
    const targetText = payload.choices?.[0]?.message?.content?.trim();
    if (targetText === undefined || targetText.length === 0) {
      throw new Error("Qwen-MT returned an empty translation.");
    }

    this.input.log.debug(
      {
        sessionId: this.input.context.sessionId,
        sourceLength: sourceText.length,
        targetLength: targetText.length,
        promptTokens: payload.usage?.prompt_tokens,
        completionTokens: payload.usage?.completion_tokens
      },
      "Qwen-MT translation completed"
    );
    return targetText;
  }

  private async emitSubtitle(input: {
    itemId: string | undefined;
    sourceText: string;
    targetText: string;
    status: SubtitleSegmentStatus;
  }): Promise<void> {
    const itemId = input.itemId ?? `item_${this.segmentIndex + 1}`;
    const startAtMs = this.itemStartMs.get(itemId) ?? Math.max(0, this.audioCursorMs - 2_000);
    const endAtMs = Math.max(startAtMs + 1, this.itemEndMs.get(itemId) ?? this.audioCursorMs);
    const revision = input.status === "revised" ? 2 : 1;
    const segmentId =
      input.itemId !== undefined ? sanitizeSegmentId(input.itemId) : nextSegmentId(++this.segmentIndex);

    const event: SubtitleSegmentUpdatedEvent = {
      type: "subtitle.segment.updated",
      version: 1,
      payload: {
        sessionId: this.input.context.sessionId,
        segmentId,
        status: input.status,
        sourceText: input.sourceText,
        targetText: input.targetText,
        startAtMs,
        endAtMs,
        revision,
        confidence: input.status === "draft" ? 0.7 : 0.9,
        termsHit: detectTechnicalTerms(input.sourceText),
        latencyMs: Math.max(0, Date.now() - this.startedAtMs - endAtMs),
        modelTrace: this.modelTrace()
      }
    };

    await this.input.callbacks.onSubtitleEvent(event);
  }

  private sendSessionUpdate(): void {
    this.socket?.send(
      JSON.stringify({
        event_id: createEventId("session"),
        type: "session.update",
        session: {
          modalities: ["text"],
          input_audio_format: this.input.config.inputAudioFormat,
          sample_rate: 16000,
          input_audio_transcription: {
            language: "en"
          },
          turn_detection: {
            type: "server_vad",
            threshold: this.input.config.asrVadThreshold,
            silence_duration_ms: this.input.config.asrSilenceDurationMs
          }
        }
      })
    );
  }

  private buildRealtimeUrl(): string {
    const separator = this.input.config.asrWebsocketUrl.includes("?") ? "&" : "?";
    return `${this.input.config.asrWebsocketUrl}${separator}model=${encodeURIComponent(
      this.input.config.asrModel
    )}`;
  }

  private modelTrace(): ModelTrace {
    return {
      provider: "alibaba-cloud",
      asrModel: this.input.config.asrModel,
      mtModel: this.input.config.mtModel
    };
  }

  private reportProviderError(message: string, nextStep: string, cause?: unknown): void {
    this.input.callbacks.onProviderError({
      message,
      nextStep,
      cause
    });
  }

  private trackPending(promise: Promise<void>): void {
    this.pendingEvents.add(promise);
    promise
      .catch((error: unknown) => {
        this.reportProviderError(
          "Alibaba Cloud subtitle generation failed.",
          "Check ASR/Qwen-MT credentials, region, quota, and request logs.",
          error
        );
      })
      .finally(() => {
        this.pendingEvents.delete(promise);
      });
  }
}

function parseServerEvent(message: string): QwenAsrServerEvent | undefined {
  try {
    const parsed = JSON.parse(message) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    if (isKnownQwenAsrEventType(type)) {
      return parsed as QwenAsrServerEvent;
    }

    const unknownEvent: QwenAsrUnknownEvent = { type: "unknown" };
    if (type !== undefined) {
      unknownEvent.rawType = type;
    }
    return unknownEvent;
  } catch {
    return undefined;
  }
}

function isKnownQwenAsrEventType(
  type: string | undefined
): type is Exclude<QwenAsrServerEvent["type"], "unknown"> {
  return (
    type === "conversation.item.input_audio_transcription.text" ||
    type === "conversation.item.input_audio_transcription.completed" ||
    type === "conversation.item.input_audio_transcription.failed" ||
    type === "conversation.item.created" ||
    type === "input_audio_buffer.committed" ||
    type === "input_audio_buffer.speech_started" ||
    type === "input_audio_buffer.speech_stopped" ||
    type === "error" ||
    type === "session.created" ||
    type === "session.updated" ||
    type === "session.finished"
  );
}

function nextSegmentId(index: number): string {
  return `seg_alibaba_${String(index).padStart(4, "0")}`;
}

function sanitizeSegmentId(itemId: string): string {
  return itemId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function createEventId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function redactUrlQuery(value: string): string {
  const [base] = value.split("?", 1);
  return base ?? value;
}

function alibabaCloudErrorMessage(
  error: QwenAsrErrorEvent["error"],
  fallback: string
): string {
  const message = error?.message ?? fallback;
  return error?.code === undefined ? message : `${error.code}: ${message}`;
}

function detectTechnicalTerms(sourceText: string): string[] {
  const candidates = [
    "API",
    "Kubernetes",
    "React",
    "TypeScript",
    "Rust",
    "WebSocket",
    "PostgreSQL",
    "Redis",
    "Docker",
    "Tauri",
    "Qwen"
  ];
  const lowerSource = sourceText.toLowerCase();
  return candidates.filter((term) => lowerSource.includes(term.toLowerCase()));
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
