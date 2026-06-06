import type {
  RealtimeAudioFrameMessage,
  SubtitleSegmentUpdatedEvent,
  TermEntry
} from "@lingua-bridge/protocol";
import type { FastifyBaseLogger } from "fastify";
import type { GatewayConfig } from "../config";
import {
  AlibabaCloudRealtimeAsrProvider,
  AlibabaCloudSubtitleTextProvider
} from "./alibaba-cloud-model-session";
import {
  MockRealtimeAsrProvider,
  MockSubtitleTextProvider
} from "./mock-model-session";
import {
  SubtitleEngine,
  type RealtimeModelUsageEvent
} from "./subtitle-engine";

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
  onUsageEvent(event: RealtimeModelUsageEvent): void;
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
  termEntries: TermEntry[];
  log: FastifyBaseLogger;
}

export function createRealtimeModelSession(
  input: CreateRealtimeModelSessionInput
): RealtimeModelSession {
  if (input.config.model.provider === "alibaba-cloud") {
    return new SubtitleEngine({
      context: input.context,
      callbacks: input.callbacks,
      termEntries: input.termEntries,
      translateDrafts: input.config.model.alibabaCloud.translateDrafts,
      revisionIntervalMs: input.config.subtitleRevisionIntervalMs,
      asrProvider: new AlibabaCloudRealtimeAsrProvider({
        config: input.config.model.alibabaCloud,
        log: input.log
      }),
      textProvider: new AlibabaCloudSubtitleTextProvider({
        config: input.config.model.alibabaCloud,
        log: input.log
      }),
      log: input.log
    });
  }

  return new SubtitleEngine({
    context: input.context,
    callbacks: input.callbacks,
    termEntries: input.termEntries,
    translateDrafts: true,
    revisionIntervalMs: input.config.subtitleRevisionIntervalMs,
    asrProvider: new MockRealtimeAsrProvider(input.config.mockSubtitleDelayMs),
    textProvider: new MockSubtitleTextProvider(),
    log: input.log
  });
}

export type { RealtimeModelUsageEvent };

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
