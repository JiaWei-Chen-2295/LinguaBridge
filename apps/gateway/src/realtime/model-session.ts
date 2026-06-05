import type {
  RealtimeAudioFrameMessage,
  SubtitleSegmentUpdatedEvent
} from "@lingua-bridge/protocol";
import type { FastifyBaseLogger } from "fastify";
import type { GatewayConfig } from "../config";
import { AlibabaCloudRealtimeModelSession } from "./alibaba-cloud-model-session";
import { MockRealtimeModelSession } from "./mock-model-session";

export type RealtimeAudioFramePayload = RealtimeAudioFrameMessage["payload"];

export interface RealtimeModelSession {
  start(): Promise<void>;
  appendAudioFrame(frame: RealtimeAudioFramePayload): Promise<void>;
  stop(): Promise<void>;
}

export interface RealtimeModelSessionContext {
  sessionId: string;
  sourceLang: string;
  targetLang: string;
}

export interface RealtimeModelSessionCallbacks {
  onSubtitleEvent(event: SubtitleSegmentUpdatedEvent): Promise<void>;
  onProviderError(error: RealtimeModelProviderError): void;
}

export interface RealtimeModelProviderError {
  message: string;
  nextStep: string;
  cause?: unknown;
}

export interface CreateRealtimeModelSessionInput {
  config: GatewayConfig;
  context: RealtimeModelSessionContext;
  callbacks: RealtimeModelSessionCallbacks;
  log: FastifyBaseLogger;
}

export function createRealtimeModelSession(
  input: CreateRealtimeModelSessionInput
): RealtimeModelSession {
  if (input.config.model.provider === "alibaba-cloud") {
    return new AlibabaCloudRealtimeModelSession({
      config: input.config.model.alibabaCloud,
      context: input.context,
      callbacks: input.callbacks,
      log: input.log
    });
  }

  return new MockRealtimeModelSession({
    delayAudioMs: input.config.mockSubtitleDelayMs,
    context: input.context,
    callbacks: input.callbacks
  });
}

export function getRealtimeModelProviderIssue(
  config: GatewayConfig
): RealtimeModelProviderError | undefined {
  if (
    config.model.provider === "alibaba-cloud" &&
    config.model.alibabaCloud.apiKey === undefined
  ) {
    return {
      message: "Alibaba Cloud model provider is enabled, but no API key is configured.",
      nextStep:
        "Set ALIBABA_MODEL_STUDIO_API_KEY or DASHSCOPE_API_KEY on the gateway server, then restart it."
    };
  }

  return undefined;
}
