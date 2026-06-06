import type { ModelTrace } from "@lingua-bridge/protocol";
import type { FastifyBaseLogger } from "fastify";
import { WebSocket } from "ws";
import type { AlibabaCloudModelConfig } from "../config";
import type {
  AsrTextEvent,
  RealtimeAsrProvider,
  RealtimeAsrProviderCallbacks,
  RealtimeAudioFramePayload,
  ReviseContextInput,
  RevisionModelResult,
  SegmentRevisionResult,
  SubtitleProviderError,
  SubtitleTextProvider,
  TextModelResult,
  TranslateInput
} from "./subtitle-engine";

interface AlibabaCloudRealtimeAsrProviderInput {
  config: AlibabaCloudModelConfig;
  log: FastifyBaseLogger;
}

interface AlibabaCloudTextProviderInput {
  config: AlibabaCloudModelConfig;
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

interface ChatCompletionResponse {
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

interface RevisionResponseBody {
  segments?: SegmentRevisionResult[];
}

export class AlibabaCloudRealtimeAsrProvider implements RealtimeAsrProvider {
  private callbacks: RealtimeAsrProviderCallbacks | undefined;
  private socket: WebSocket | undefined;
  private audioCursorMs = 0;
  private frameCount = 0;
  private stopped = false;
  private readonly itemStartMs = new Map<string, number>();
  private readonly itemEndMs = new Map<string, number>();
  private readonly draftTextByItemId = new Map<string, string>();
  private sessionUpdatedResolver: (() => void) | undefined;
  private sessionUpdatedRejecter: ((error: Error) => void) | undefined;
  private finishedResolver: (() => void) | undefined;
  private readonly finished = new Promise<void>((resolve) => {
    this.finishedResolver = resolve;
  });

  public constructor(private readonly input: AlibabaCloudRealtimeAsrProviderInput) {}

  public async start(callbacks: RealtimeAsrProviderCallbacks): Promise<void> {
    if (this.input.config.apiKey === undefined) {
      throw new Error("Alibaba Cloud API key is not configured.");
    }

    this.callbacks = callbacks;
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
            asrModel: this.input.config.asrModel,
            mtModel: this.input.config.mtModel,
            revisionModel: this.input.config.revisionModel,
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

    await Promise.race([this.finished, wait(this.input.config.requestTimeoutMs)]);
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

    this.input.log.debug(
      {
        eventType: event.type === "unknown" ? event.rawType ?? "unknown" : event.type
      },
      "received Alibaba Cloud realtime ASR event"
    );

    if (event.type === "input_audio_buffer.speech_started") {
      this.recordSpeechStart(event as QwenAsrSpeechStartedEvent);
      return;
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      this.recordSpeechStop(event as QwenAsrSpeechStoppedEvent);
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.text") {
      await this.handleAsrPartial(event as QwenAsrTextEvent);
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      await this.handleAsrFinal(event as QwenAsrCompletedEvent);
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
      const messageText = alibabaCloudErrorMessage(
        errorEvent.error,
        "Alibaba Cloud ASR returned an error."
      );
      if (this.sessionUpdatedRejecter !== undefined) {
        this.sessionUpdatedRejecter(new Error(messageText));
        return;
      }

      this.reportProviderError(
        messageText,
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
    if (itemId !== undefined) {
      this.itemStartMs.set(itemId, event.audio_start_ms ?? this.audioCursorMs);
    }
  }

  private recordSpeechStop(event: QwenAsrSpeechStoppedEvent): void {
    const itemId = event.item_id;
    if (itemId !== undefined) {
      this.itemEndMs.set(itemId, event.audio_end_ms ?? this.audioCursorMs);
    }
  }

  private async handleAsrPartial(event: QwenAsrTextEvent): Promise<void> {
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
    await this.callbacks?.onPartial(this.asrTextEvent(itemId, sourceText, 0.72));
  }

  private async handleAsrFinal(event: QwenAsrCompletedEvent): Promise<void> {
    const sourceText = event.transcript?.trim();
    if (sourceText === undefined || sourceText.length === 0) {
      this.input.log.warn(
        {
          itemId: event.item_id
        },
        "Alibaba Cloud ASR completed with an empty transcript"
      );
      return;
    }

    const itemId = event.item_id ?? createEventId("item");
    this.input.log.info(
      {
        itemId,
        sourceLength: sourceText.length
      },
      "Alibaba Cloud ASR final transcript received"
    );
    await this.callbacks?.onFinal(this.asrTextEvent(itemId, sourceText, 0.9));
  }

  private asrTextEvent(
    itemId: string,
    sourceText: string,
    confidence: number
  ): AsrTextEvent {
    const startAtMs = this.itemStartMs.get(itemId) ?? Math.max(0, this.audioCursorMs - 2_000);
    const endAtMs = Math.max(startAtMs + 1, this.itemEndMs.get(itemId) ?? this.audioCursorMs);
    return {
      itemId,
      sourceText,
      startAtMs,
      endAtMs,
      confidence
    };
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

  private reportProviderError(
    message: string,
    nextStep: string,
    cause?: unknown
  ): void {
    const error: SubtitleProviderError = { message, nextStep };
    if (cause !== undefined) {
      error.cause = cause;
    }
    this.callbacks?.onError(error);
  }
}

export class AlibabaCloudSubtitleTextProvider implements SubtitleTextProvider {
  public constructor(private readonly input: AlibabaCloudTextProviderInput) {}

  public async translate(input: TranslateInput): Promise<TextModelResult> {
    const response = await this.chatCompletion({
      model: this.input.config.mtModel,
      messages: [
        {
          role: "user",
          content: input.sourceText
        }
      ],
      translation_options: {
        source_lang: "English",
        target_lang: "Chinese"
      }
    });
    const text = readChatContent(response, "Qwen-MT returned an empty translation.");
    this.input.log.info(
      {
        sourceLength: input.sourceText.length,
        targetLength: text.length,
        promptTokens: response.usage?.prompt_tokens,
        completionTokens: response.usage?.completion_tokens,
        glossaryLength: input.glossary.length
      },
      "Qwen-MT translation completed"
    );
    const result: TextModelResult = { text };
    const usage = toTextUsage(response);
    if (usage !== undefined) {
      result.usage = usage;
    }
    return result;
  }

  public async revise(input: ReviseContextInput): Promise<RevisionModelResult> {
    const response = await this.chatCompletion({
      model: this.input.config.revisionModel,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Revise recent subtitle translations using nearby context. Only rewrite requested target segment IDs. Return strict JSON."
        },
        {
          role: "user",
          content: JSON.stringify({
            sourceLang: input.sourceLang,
            targetLang: input.targetLang,
            glossary: input.glossary,
            contextSegments: input.contextSegments,
            targetSegmentIds: input.targetSegmentIds,
            outputShape: {
              segments: [
                {
                  segmentId: "string",
                  targetText: "string"
                }
              ]
            }
          })
        }
      ]
    });
    const content = readChatContent(response, "Qwen revision returned an empty response.");
    const parsed = readRevisionBody(content);
    const result: RevisionModelResult = {
      segments: parsed.segments ?? []
    };
    const usage = toTextUsage(response);
    if (usage !== undefined) {
      result.usage = usage;
    }
    return result;
  }

  public modelTrace(kind: "translation" | "revision"): ModelTrace {
    const trace: ModelTrace = {
      provider: "alibaba-cloud",
      asrModel: this.input.config.asrModel,
      mtModel: this.input.config.mtModel
    };
    if (kind === "revision") {
      trace.correctionModel = this.input.config.revisionModel;
    }
    return trace;
  }

  private async chatCompletion(body: Record<string, unknown>): Promise<ChatCompletionResponse> {
    const response = await fetch(`${this.input.config.openAiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.input.config.apiKey ?? ""}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.input.config.requestTimeoutMs)
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(`Alibaba Cloud chat completion failed with HTTP ${response.status}: ${bodyText}`);
    }

    return (await response.json()) as ChatCompletionResponse;
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

function readChatContent(
  payload: ChatCompletionResponse,
  emptyMessage: string
): string {
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (content === undefined || content.length === 0) {
    throw new Error(emptyMessage);
  }
  return content;
}

function readRevisionBody(value: string): RevisionResponseBody {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }

    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.segments)) {
      return {};
    }

    const segments: Array<{ segmentId: string; targetText: string }> = [];
    for (const segment of record.segments) {
      if (
        typeof segment !== "object" ||
        segment === null ||
        Array.isArray(segment)
      ) {
        continue;
      }

      const segmentRecord = segment as Record<string, unknown>;
      const segmentId = segmentRecord.segmentId;
      const targetText = segmentRecord.targetText;
      if (
        typeof segmentId === "string" &&
        typeof targetText === "string" &&
        targetText.trim().length > 0
      ) {
        segments.push({ segmentId, targetText });
      }
    }
    return { segments };
  } catch {
    return {};
  }
}

function toTextUsage(response: ChatCompletionResponse): TextModelResult["usage"] {
  const usage: NonNullable<TextModelResult["usage"]> = {};
  if (response.usage?.prompt_tokens !== undefined) {
    usage.inputTokens = response.usage.prompt_tokens;
  }
  if (response.usage?.completion_tokens !== undefined) {
    usage.outputTokens = response.usage.completion_tokens;
  }
  if (response.usage?.total_tokens !== undefined) {
    usage.totalTokens = response.usage.total_tokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
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

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
