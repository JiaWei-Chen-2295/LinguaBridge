import { estimateTranslationTokens } from "@lingua-bridge/mock-models";
import type { ModelTrace } from "@lingua-bridge/protocol";
import { setTimeout as wait } from "node:timers/promises";
import type {
  AsrTextEvent,
  RealtimeAsrProvider,
  RealtimeAsrProviderCallbacks,
  RealtimeAudioFramePayload,
  ReviseContextInput,
  RevisionModelResult,
  SubtitleTextProvider,
  TextModelResult,
  TranslateInput
} from "./subtitle-engine";

interface MockAsrSegment {
  itemId: string;
  partialText: string;
  finalText: string;
  startAtMs: number;
  endAtMs: number;
}

const mockAsrSegments: MockAsrSegment[] = [
  {
    itemId: "mock_001",
    partialText: "We deploy it on Kubernetees with a side car proxy",
    finalText: "We deploy it on Kubernetes with a sidecar proxy.",
    startAtMs: 0,
    endAtMs: 3600
  },
  {
    itemId: "mock_002",
    partialText: "The gateway keeps model keys off the desktop client",
    finalText: "The gateway keeps model keys off the desktop client.",
    startAtMs: 3700,
    endAtMs: 7100
  },
  {
    itemId: "mock_003",
    partialText: "Later we can replay the transcript for close reading",
    finalText: "Later we can replay the transcript for close reading.",
    startAtMs: 7200,
    endAtMs: 10800
  }
];

export class MockRealtimeAsrProvider implements RealtimeAsrProvider {
  private callbacks: RealtimeAsrProviderCallbacks | undefined;
  private accumulatedAudioMs = 0;
  private stopped = false;
  private readonly emittedPartials = new Set<string>();
  private readonly emittedFinals = new Set<string>();

  public constructor(private readonly delayAudioMs: number) {}

  public start(callbacks: RealtimeAsrProviderCallbacks): Promise<void> {
    this.callbacks = callbacks;
    return Promise.resolve();
  }

  public async appendAudioFrame(frame: RealtimeAudioFramePayload): Promise<void> {
    if (this.stopped || this.callbacks === undefined) {
      return;
    }

    this.accumulatedAudioMs += frame.durationMs;
    for (const segment of mockAsrSegments) {
      await this.emitSegmentProgress(segment);
    }
  }

  public stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  private async emitSegmentProgress(segment: MockAsrSegment): Promise<void> {
    if (this.callbacks === undefined) {
      return;
    }

    const partialAtMs = Math.min(segment.startAtMs + 1600, segment.endAtMs);
    if (
      !this.emittedPartials.has(segment.itemId) &&
      this.accumulatedAudioMs >= partialAtMs
    ) {
      this.emittedPartials.add(segment.itemId);
      await this.delay();
      if (!this.stopped) {
        await this.callbacks.onPartial(asrEventFromSegment(segment, "partial"));
      }
    }

    if (
      !this.emittedFinals.has(segment.itemId) &&
      this.accumulatedAudioMs >= segment.endAtMs
    ) {
      this.emittedFinals.add(segment.itemId);
      await this.delay();
      if (!this.stopped) {
        await this.callbacks.onFinal(asrEventFromSegment(segment, "final"));
      }
    }
  }

  private async delay(): Promise<void> {
    if (this.delayAudioMs > 0) {
      await wait(this.delayAudioMs);
    }
  }
}

export class MockSubtitleTextProvider implements SubtitleTextProvider {
  public translate(input: TranslateInput): Promise<TextModelResult> {
    const text = mockTranslate(input.sourceText);
    return Promise.resolve({
      text,
      usage: {
        inputTokens: estimateTranslationTokens(
          `${input.sourceText}\n${input.glossary}`
        ),
        outputTokens: estimateTranslationTokens(text)
      }
    });
  }

  public revise(input: ReviseContextInput): Promise<RevisionModelResult> {
    const segments = input.targetSegmentIds
      .map((segmentId) => input.contextSegments.find((segment) => segment.segmentId === segmentId))
      .filter((segment): segment is NonNullable<typeof segment> => segment !== undefined)
      .map((segment) => ({
        segmentId: segment.segmentId,
        targetText: mockRevise(segment.sourceText, segment.targetText)
      }));
    const totalText = input.contextSegments
      .map((segment) => `${segment.sourceText}\n${segment.targetText}`)
      .join("\n");

    return Promise.resolve({
      segments,
      usage: {
        totalTokens: estimateTranslationTokens(`${totalText}\n${input.glossary}`)
      }
    });
  }

  public modelTrace(kind: "translation" | "revision"): ModelTrace {
    const trace: ModelTrace = {
      provider: "mock",
      asrModel: "mock-asr",
      mtModel: "mock-mt"
    };
    if (kind === "revision") {
      trace.correctionModel = "mock-correction";
    }
    return trace;
  }
}

function asrEventFromSegment(
  segment: MockAsrSegment,
  kind: "partial" | "final"
): AsrTextEvent {
  return {
    itemId: segment.itemId,
    sourceText: kind === "partial" ? segment.partialText : segment.finalText,
    startAtMs: segment.startAtMs,
    endAtMs:
      kind === "partial"
        ? Math.min(segment.startAtMs + 1600, segment.endAtMs)
        : segment.endAtMs,
    confidence: kind === "partial" ? 0.72 : 0.9
  };
}

function mockTranslate(sourceText: string): string {
  const normalized = sourceText.toLowerCase();
  if (normalized.includes("kubernetees") || normalized.includes("kubernetes")) {
    return normalized.includes("kubernetees")
      ? "我们把它部署到 Kubernetees，并使用 side car 代理"
      : "我们将它部署在 Kubernetes 上，并使用 sidecar 代理";
  }

  if (normalized.includes("model keys")) {
    return "网关避免模型密钥暴露在桌面客户端";
  }

  if (normalized.includes("transcript")) {
    return "之后可以回放 transcript 进行精读";
  }

  return `模拟译文：${sourceText}`;
}

function mockRevise(sourceText: string, targetText: string): string {
  const normalized = sourceText.toLowerCase();
  if (normalized.includes("kubernetes")) {
    return "我们将它部署在 Kubernetes 上，并使用 sidecar proxy";
  }

  if (normalized.includes("model keys")) {
    return "Realtime Gateway 避免模型密钥暴露在桌面客户端";
  }

  if (normalized.includes("transcript")) {
    return "之后可以基于落盘的 transcript 进行精读复盘";
  }

  return targetText;
}
