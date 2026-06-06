import type {
  InterpretationAudioCompletedEvent,
  InterpretationAudioDeltaEvent,
  InterpretationOptions,
  ModelTrace,
  SubtitleSegmentUpdatedEvent,
  TermEntry
} from "@lingua-bridge/protocol";
import type { FastifyBaseLogger } from "fastify";
import { WebSocket } from "ws";
import type { ModelConfig } from "../config";
import {
  applyTermPolicy,
  mergeTermEntries,
  normalizeTechnicalSourceText
} from "./terms";
import type {
  RealtimeAudioFramePayload,
  RealtimeModelSessionCallbacks,
  RealtimeModelSessionContext
} from "./model-session";
import {
  LiveTranslateTextBuffer,
  type LiveTranslateTextKind,
  type LiveTranslateTextPhase
} from "./livetranslate-text-buffer";

interface AlibabaCloudLiveTranslateSessionInput {
  config: ModelConfig;
  context: RealtimeModelSessionContext;
  callbacks: RealtimeModelSessionCallbacks;
  interpretation?: InterpretationOptions;
  termEntries: TermEntry[];
  log: FastifyBaseLogger;
}

interface LiveTranslateErrorEvent {
  type: "error";
  error?: {
    code?: string;
    message?: string;
    param?: string;
  };
}

interface LiveTranslateGenericEvent {
  type: string;
  item_id?: string;
  text?: string;
  stash?: string;
  transcript?: string;
  delta?: string;
  language?: string;
}

interface SegmentState {
  segmentId: string;
  itemId: string;
  sourceText: string;
  targetText: string;
  startAtMs: number;
  endAtMs: number;
  revision: number;
  finalized: boolean;
}

const DEFAULT_SEGMENT_TARGET = "正在生成中文同传...";
const INPUT_SAMPLE_RATE = 16_000;

export class AlibabaCloudLiveTranslateSession {
  private readonly termEntries: TermEntry[];
  private readonly trace: ModelTrace;
  private socket: WebSocket | undefined;
  private stopped = false;
  private audioCursorMs = 0;
  private generatedSegmentIndex = 0;
  private audioSequence = 0;
  private audioDurationMs = 0;
  private lastItemId: string | undefined;
  private readonly textBuffer = new LiveTranslateTextBuffer();
  private readonly segments = new Map<string, SegmentState>();
  private sessionUpdatedResolver: (() => void) | undefined;
  private finishedResolver: (() => void) | undefined;
  private readonly finished = new Promise<void>((resolve) => {
    this.finishedResolver = resolve;
  });

  public constructor(private readonly input: AlibabaCloudLiveTranslateSessionInput) {
    this.termEntries = mergeTermEntries(input.termEntries);
    this.trace = {
      provider: "alibaba-cloud",
      asrModel: "qwen3-asr-flash-realtime",
      mtModel: "qwen3.5-livetranslate-flash-realtime",
      liveTranslateModel: "qwen3.5-livetranslate-flash-realtime"
    };
  }

  public async start(): Promise<void> {
    const apiKey = this.input.config.alibabaCloud.apiKey;
    if (apiKey === undefined) {
      throw new Error("Alibaba Cloud API key is not configured.");
    }

    const socket = new WebSocket(this.buildRealtimeUrl(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });
    this.socket = socket;

    socket.on("message", (data) => {
      this.handleServerMessage(data.toString()).catch((error: unknown) => {
        this.reportProviderError(
          "Alibaba Cloud LiveTranslate event handling failed.",
          "Check the gateway logs and retry the interpretation session.",
          error
        );
      });
    });
    socket.on("error", (error) => {
      this.reportProviderError(
        "Alibaba Cloud LiveTranslate WebSocket failed.",
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
        reject(new Error("Timed out waiting for LiveTranslate session.updated event."));
      }, this.input.config.alibabaCloud.requestTimeoutMs);
      const cleanup = (): void => {
        clearTimeout(timeout);
        socket.off("error", onError);
        socket.off("close", onClose);
        this.sessionUpdatedResolver = undefined;
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("LiveTranslate WebSocket closed before session.updated."));
      };

      this.sessionUpdatedResolver = () => {
        cleanup();
        this.input.log.info(
          {
            model: this.input.config.liveTranslateSpike.model,
            websocketUrl: redactUrlQuery(this.input.config.liveTranslateSpike.websocketUrl),
            voice: this.input.interpretation?.voice ?? this.input.config.liveTranslateSpike.voice,
            outputSampleFormat: this.input.config.liveTranslateSpike.outputSampleFormat,
            outputSampleRate: this.outputSampleRate()
          },
          "Alibaba Cloud LiveTranslate session connected"
        );
        resolve();
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
      wait(this.input.config.alibabaCloud.requestTimeoutMs)
    ]);
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(1000, "LinguaBridge interpretation session stopped");
    }
  }

  private async handleServerMessage(message: string): Promise<void> {
    const event = parseLiveTranslateEvent(message);
    if (event === undefined) {
      this.input.log.debug({ message }, "ignored unparseable LiveTranslate event");
      return;
    }

    if (event.type === "error") {
      const errorEvent = event as LiveTranslateErrorEvent;
      this.reportProviderError(
        alibabaCloudErrorMessage(
          errorEvent.error,
          "Alibaba Cloud LiveTranslate returned an error."
        ),
        "Check LiveTranslate session parameters, model availability, and account quota.",
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
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.text") {
      await this.handleTextEvent(event, "source", "draft");
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      await this.handleTextEvent(event, "source", "completed");
      return;
    }

    if (
      event.type === "response.text.text" ||
      event.type === "response.text.done" ||
      event.type === "response.audio_transcript.text" ||
      event.type === "response.audio_transcript.done"
    ) {
      await this.handleTextEvent(
        event,
        "target",
        event.type === "response.text.done" ||
          event.type === "response.audio_transcript.done"
          ? "completed"
          : "draft"
      );
      return;
    }

    if (event.type === "response.audio.delta") {
      await this.handleAudioDelta(event);
      return;
    }

    if (event.type === "response.audio.done") {
      await this.input.callbacks.onInterpretationAudioCompleted?.({
        type: "interpretation.audio.completed",
        version: 1,
        payload: {
          sessionId: this.input.context.sessionId,
          trackId: this.trackId(),
          totalDurationMs: this.audioDurationMs,
          modelTrace: this.trace
        }
      });
    }
  }

  private async handleTextEvent(
    event: LiveTranslateGenericEvent,
    kind: LiveTranslateTextKind,
    phase: LiveTranslateTextPhase
  ): Promise<void> {
    const text =
      kind === "source"
        ? normalizeTechnicalSourceText(readSourceText(event), this.termEntries)
        : readTargetText(event);
    const itemId =
      typeof event.item_id === "string" && event.item_id.length > 0
        ? event.item_id
        : undefined;
    const buffered = this.textBuffer.apply({
      ...(itemId === undefined ? {} : { itemId }),
      kind,
      phase,
      text,
      receivedAtMs: Date.now()
    });

    this.input.log.debug(
      {
        eventType: event.type,
        itemId,
        kind,
        phase,
        textLength: text.length,
        status: buffered?.status,
        changed: buffered?.changed ?? false,
        shortTextIgnored: buffered?.shortTextIgnored ?? false
      },
      "Alibaba Cloud LiveTranslate text buffered"
    );

    if (buffered === undefined || !buffered.changed) {
      return;
    }

    if (buffered.status !== "final") {
      this.lastItemId = buffered.itemId;
    }

    const segment = this.segmentForItemId(buffered.itemId);
    segment.sourceText = buffered.sourceText;
    segment.targetText = buffered.targetText;
    segment.endAtMs = Math.max(segment.endAtMs, this.audioCursorMs);
    segment.finalized = buffered.status === "final";
    await this.emitSegment(segment);
  }

  private async handleAudioDelta(event: LiveTranslateGenericEvent): Promise<void> {
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (delta.length === 0) {
      return;
    }

    const durationMs = estimatePcmDurationMs(
      delta,
      this.input.config.liveTranslateSpike.outputSampleFormat,
      this.outputSampleRate()
    );
    this.audioDurationMs += durationMs;
    this.audioSequence += 1;
    const payload: InterpretationAudioDeltaEvent["payload"] = {
      sessionId: this.input.context.sessionId,
      trackId: this.trackId(),
      sequence: this.audioSequence,
      pcmBase64: delta,
      sampleRate: this.outputSampleRate(),
      channels: 1,
      sampleFormat: this.input.config.liveTranslateSpike.outputSampleFormat,
      durationMs,
      latencyMs: Math.max(0, Date.now() - this.startedAtMs()),
      modelTrace: this.trace
    };
    const itemId = typeof event.item_id === "string" ? event.item_id : this.lastItemId;
    if (itemId !== undefined) {
      payload.sourceSegmentId = this.segmentForItemId(itemId).segmentId;
    }

    await this.input.callbacks.onInterpretationAudioDelta?.({
      type: "interpretation.audio.delta",
      version: 1,
      payload
    });
  }

  private async emitSegment(segment: SegmentState): Promise<void> {
    if (segment.sourceText.length === 0 && segment.targetText.length === 0) {
      return;
    }

    segment.revision += 1;
    const constrained = applyTermPolicy(
      segment.sourceText,
      segment.targetText.length > 0 ? segment.targetText : DEFAULT_SEGMENT_TARGET,
      this.termEntries
    );
    const event: SubtitleSegmentUpdatedEvent = {
      type: "subtitle.segment.updated",
      version: 1,
      payload: {
        sessionId: this.input.context.sessionId,
        segmentId: segment.segmentId,
        status: segment.finalized ? "final" : "draft",
        sourceText: segment.sourceText,
        targetText: constrained.targetText,
        startAtMs: Math.max(0, segment.startAtMs),
        endAtMs: Math.max(segment.startAtMs + 1, segment.endAtMs),
        revision: Math.max(1, segment.revision),
        confidence: segment.finalized ? 0.9 : 0.72,
        termsHit: constrained.termsHit,
        latencyMs: Math.max(0, Date.now() - this.startedAtMs()),
        modelTrace: this.trace
      }
    };

    await this.input.callbacks.onSubtitleEvent(event);
  }

  private segmentForItemId(itemId: string): SegmentState {
    const existing = this.segments.get(itemId);
    if (existing !== undefined) {
      return existing;
    }

    this.generatedSegmentIndex += 1;
    const segment: SegmentState = {
      segmentId: `lt_${this.generatedSegmentIndex.toString().padStart(4, "0")}`,
      itemId,
      sourceText: "",
      targetText: "",
      startAtMs: Math.max(0, this.audioCursorMs - 2_000),
      endAtMs: Math.max(1, this.audioCursorMs),
      revision: 0,
      finalized: false
    };
    this.segments.set(itemId, segment);
    return segment;
  }

  private sendSessionUpdate(): void {
    this.socket?.send(
      JSON.stringify({
        event_id: createEventId("session"),
        type: "session.update",
        session: {
          modalities: this.input.interpretation?.outputAudio === false
            ? ["text"]
            : ["text", "audio"],
          voice: this.input.interpretation?.voice ?? this.input.config.liveTranslateSpike.voice,
          sample_rate: INPUT_SAMPLE_RATE,
          input_audio_format: "pcm",
          output_audio_format: "pcm",
          input_audio_transcription: {
            model: "qwen3-asr-flash-realtime",
            language: "en"
          },
          translation: {
            language: "zh",
            corpus: {
              phrases: buildLiveTranslateGlossaryPhrases(this.termEntries)
            }
          }
        }
      })
    );
  }

  private buildRealtimeUrl(): string {
    const separator = this.input.config.liveTranslateSpike.websocketUrl.includes("?")
      ? "&"
      : "?";
    return `${this.input.config.liveTranslateSpike.websocketUrl}${separator}model=${encodeURIComponent(
      this.input.config.liveTranslateSpike.model
    )}`;
  }

  private trackId(): string {
    return `${this.input.context.sessionId}:interpretation`;
  }

  private outputSampleRate(): number {
    return this.input.config.liveTranslateSpike.outputSampleRate;
  }

  private readonly startedAt = Date.now();

  private startedAtMs(): number {
    return this.startedAt;
  }

  private reportProviderError(
    message: string,
    nextStep: string,
    cause?: unknown
  ): void {
    const error = { message, nextStep, cause };
    if (cause === undefined) {
      delete error.cause;
    }
    this.input.callbacks.onProviderError(error);
  }
}

function parseLiveTranslateEvent(
  message: string
): LiveTranslateGenericEvent | LiveTranslateErrorEvent | undefined {
  try {
    const parsed = JSON.parse(message) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    if (type === undefined) {
      return undefined;
    }
    return parsed as LiveTranslateGenericEvent | LiveTranslateErrorEvent;
  } catch {
    return undefined;
  }
}

function readSourceText(event: LiveTranslateGenericEvent): string {
  if (typeof event.transcript === "string" && event.transcript.trim().length > 0) {
    return event.transcript.trim();
  }

  return `${event.text ?? ""}${event.stash ?? ""}`.trim();
}

function readTargetText(event: LiveTranslateGenericEvent): string {
  if (typeof event.text === "string" && event.text.trim().length > 0) {
    return event.text.trim();
  }

  return `${event.transcript ?? ""}${event.stash ?? ""}`.trim();
}

export function buildLiveTranslateGlossaryPhrases(
  entries: TermEntry[]
): Record<string, string> {
  const phrases: Record<string, string> = {};
  for (const entry of entries) {
    const replacement =
      entry.mode === "fixed_translation" ? entry.target ?? entry.source : entry.source;
    for (const phrase of [entry.source, ...entry.aliases]) {
      if (phrase.trim().length > 0) {
        phrases[phrase] = replacement;
      }
    }
  }
  return phrases;
}

function estimatePcmDurationMs(
  pcmBase64: string,
  sampleFormat: "pcm_s16le" | "pcm_s24le",
  sampleRate: number
): number {
  const bytes = Buffer.from(pcmBase64, "base64").byteLength;
  const bytesPerSample = sampleFormat === "pcm_s24le" ? 3 : 2;
  return Math.max(1, Math.round((bytes / bytesPerSample / sampleRate) * 1000));
}

function createEventId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function redactUrlQuery(value: string): string {
  const [base] = value.split("?", 1);
  return base ?? value;
}

function alibabaCloudErrorMessage(
  error: LiveTranslateErrorEvent["error"],
  fallback: string
): string {
  const message = error?.message ?? fallback;
  return error?.code === undefined ? message : `${error.code}: ${message}`;
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
