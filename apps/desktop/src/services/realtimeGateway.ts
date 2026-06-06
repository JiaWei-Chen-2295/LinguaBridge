import type {
  GatewayErrorEvent,
  InterpretationAudioCompletedEvent,
  InterpretationAudioDeltaEvent,
  InterpretationOptions,
  RealtimeAudioFrameMessage,
  RealtimeClientMessage,
  RealtimeSessionMode,
  RealtimeServerMessage,
  RealtimeSessionStartMessage,
  RealtimeSessionStopMessage,
  SessionStoppedEvent,
  SubtitleSegmentUpdatedEvent
} from "@lingua-bridge/protocol";

import type { AudioFramePayload } from "../types/audio";

const DEFAULT_GATEWAY_WS_URL = "ws://127.0.0.1:4318/realtime/sessions";
const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 3_000;

export interface StartRealtimeSessionInput {
  inviteCode: string;
  deviceId: string | null;
  mode?: RealtimeSessionMode;
  outputAudio?: boolean;
  interpretationVoice?: string;
  echoAvoidance?: InterpretationOptions["echoAvoidance"];
  echoRiskAccepted?: boolean;
  windowsBuild?: number | null;
}

export interface RealtimeGatewayHandlers {
  onSubtitle: (event: SubtitleSegmentUpdatedEvent) => void;
  onInterpretationAudioDelta?: (event: InterpretationAudioDeltaEvent) => void;
  onInterpretationAudioCompleted?: (event: InterpretationAudioCompletedEvent) => void;
  onError: (event: GatewayErrorEvent) => void;
  onStopped: (event: SessionStoppedEvent) => void;
}

export interface StartedRealtimeSession {
  sessionId: string;
  userId: string;
}

export class RealtimeGatewayConnection {
  private socket: WebSocket | null = null;
  private stopResolver: (() => void) | null = null;

  public constructor(private readonly handlers: RealtimeGatewayHandlers) {}

  public async startSession(
    input: StartRealtimeSessionInput
  ): Promise<StartedRealtimeSession> {
    const socket = new WebSocket(readGatewayWsUrl());
    this.socket = socket;

    const started = await new Promise<StartedRealtimeSession>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error("Realtime Gateway session.start timed out."));
      }, START_TIMEOUT_MS);

      socket.addEventListener("open", () => {
        this.send(startMessage(input));
      });

      socket.addEventListener("message", (event) => {
        const message = parseServerMessage(event.data);
        if (message === undefined) {
          return;
        }

        if (message.type === "session.started") {
          window.clearTimeout(timeout);
          const nextSession = {
            sessionId: message.payload.sessionId,
            userId: message.payload.userId
          };
          resolve(nextSession);
          return;
        }

        this.routeMessage(message);
        if (message.type === "gateway.error") {
          window.clearTimeout(timeout);
          reject(new Error(message.payload.message));
        }
      });

      socket.addEventListener("error", () => {
        window.clearTimeout(timeout);
        reject(new Error("Realtime Gateway WebSocket connection failed."));
      });
    });

    return started;
  }

  public sendAudioFrame(sessionId: string, frame: AudioFramePayload): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    const message: RealtimeAudioFrameMessage = {
      type: "audio.frame",
      version: 1,
      requestId: createRequestId("audio"),
      payload: {
        sessionId,
        sequence: frame.sequence,
        pcmBase64: pcm16SamplesToBase64(frame.samples),
        capturedAtMs: frame.timestampMs,
        durationMs: frame.frameDurationMs,
        sampleRate: 16_000,
        channels: 1
      }
    };
    this.send(message);
  }

  public async stopSession(
    sessionId: string,
    reason: RealtimeSessionStopMessage["payload"]["reason"] = "user"
  ): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, STOP_TIMEOUT_MS);
      this.stopResolver = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      this.send({
        type: "session.stop",
        version: 1,
        requestId: createRequestId("stop"),
        payload: {
          sessionId,
          reason
        }
      });
    });
  }

  public close(): void {
    this.stopResolver?.();
    this.stopResolver = null;
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(1000, "desktop cleanup");
    }
    this.socket = null;
  }

  private send(message: RealtimeClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private routeMessage(message: RealtimeServerMessage): void {
    if (message.type === "subtitle.segment.updated") {
      this.handlers.onSubtitle(message);
      return;
    }

    if (message.type === "interpretation.audio.delta") {
      this.handlers.onInterpretationAudioDelta?.(message);
      return;
    }

    if (message.type === "interpretation.audio.completed") {
      this.handlers.onInterpretationAudioCompleted?.(message);
      return;
    }

    if (message.type === "gateway.error") {
      this.handlers.onError(message);
      return;
    }

    if (message.type === "session.stopped") {
      this.handlers.onStopped(message);
      this.stopResolver?.();
      this.stopResolver = null;
    }
  }
}

function startMessage(
  input: StartRealtimeSessionInput
): RealtimeSessionStartMessage {
  const device: RealtimeSessionStartMessage["payload"]["device"] = {
    os: "windows",
    sampleRate: 16_000,
    channels: 1
  };

  if (input.deviceId !== null) {
    device.deviceId = input.deviceId;
  }
  if (input.windowsBuild !== undefined && input.windowsBuild !== null) {
    device.osVersion = `10.0.${input.windowsBuild}`;
  }

  const payload: RealtimeSessionStartMessage["payload"] = {
    inviteCode: input.inviteCode,
    language: {
      sourceLang: "en",
      targetLang: "zh-CN"
    },
    device,
    privacyConsent: {
      accepted: true,
      acceptedAt: new Date().toISOString(),
      retentionDays: 30,
      cloudStorageRequired: true
    }
  };
  const mode = input.mode ?? "subtitle";
  if (mode !== "subtitle") {
    payload.mode = mode;
  }

  if (mode === "interpretation") {
    const interpretation: InterpretationOptions = {
      outputAudio: input.outputAudio ?? true,
      echoAvoidance: input.echoAvoidance ?? "disabled"
    };
    if (input.echoRiskAccepted !== undefined) {
      interpretation.echoRiskAccepted = input.echoRiskAccepted;
    }
    if (input.interpretationVoice !== undefined) {
      interpretation.voice = input.interpretationVoice;
    }
    payload.interpretation = interpretation;
  }

  return {
    type: "session.start",
    version: 1,
    requestId: createRequestId("start"),
    payload
  };
}

function parseServerMessage(value: unknown): RealtimeServerMessage | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    return JSON.parse(value) as RealtimeServerMessage;
  } catch {
    return undefined;
  }
}

function pcm16SamplesToBase64(samples: number[]): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => {
    view.setInt16(index * 2, clampPcm16(sample), true);
  });

  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return window.btoa(binary);
}

function clampPcm16(sample: number): number {
  return Math.max(-32_768, Math.min(32_767, Math.round(sample)));
}

function createRequestId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function readGatewayWsUrl(): string {
  const value = import.meta.env.VITE_GATEWAY_WS_URL;
  return typeof value === "string" && value.trim().length > 0
    ? value
    : DEFAULT_GATEWAY_WS_URL;
}
