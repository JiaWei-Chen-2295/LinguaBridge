import { setTimeout as wait } from "node:timers/promises";
import type {
  ModelTrace,
  SubtitleSegmentStatus,
  SubtitleSegmentUpdatedEvent
} from "@lingua-bridge/protocol";

export interface MockSubtitleScenario {
  sessionId: string;
  sourceLang: string;
  targetLang: string;
}

export interface MockSubtitleStreamOptions {
  delayMs?: number;
}

interface MockSubtitleFixture {
  sourceDraft: string;
  sourceFinal: string;
  targetDraft: string;
  targetFinal: string;
  targetRevised: string;
  revisionReason: string;
  termsHit: string[];
  startAtMs: number;
  endAtMs: number;
}

const modelTrace: ModelTrace = {
  provider: "mock",
  asrModel: "mock-asr",
  mtModel: "mock-mt",
  correctionModel: "mock-correction"
};

const fixtures: MockSubtitleFixture[] = [
  {
    sourceDraft: "We deploy it on Kubernetees with a side car proxy",
    sourceFinal: "We deploy it on Kubernetes with a sidecar proxy",
    targetDraft: "我们把它部署到 Kubernetees，并使用 side car 代理",
    targetFinal: "我们将它部署在 Kubernetes 上，并使用 sidecar 代理",
    targetRevised: "我们将它部署在 Kubernetes 上，并使用 sidecar proxy",
    revisionReason: "Preserve the technical term sidecar proxy.",
    termsHit: ["Kubernetes", "sidecar proxy"],
    startAtMs: 0,
    endAtMs: 3600
  },
  {
    sourceDraft: "The gateway keeps model keys off the desktop client",
    sourceFinal: "The gateway keeps model keys off the desktop client",
    targetDraft: "网关让模型密钥不在桌面客户端中出现",
    targetFinal: "网关避免模型密钥暴露在桌面客户端",
    targetRevised: "Realtime Gateway 避免模型密钥暴露在桌面客户端",
    revisionReason: "Align with the product module name.",
    termsHit: ["Realtime Gateway"],
    startAtMs: 3700,
    endAtMs: 7100
  },
  {
    sourceDraft: "Later we can replay the transcript for close reading",
    sourceFinal: "Later we can replay the transcript for close reading",
    targetDraft: "之后我们可以重放转写内容来精读",
    targetFinal: "之后可以回放 transcript 进行精读",
    targetRevised: "之后可以基于落盘的 transcript 进行精读复盘",
    revisionReason: "Use persisted-session context.",
    termsHit: ["transcript"],
    startAtMs: 7200,
    endAtMs: 10800
  }
];

export function createMockSubtitleEvents(
  scenario: MockSubtitleScenario
): SubtitleSegmentUpdatedEvent[] {
  return fixtures.flatMap((fixture, index) => [
    buildEvent(scenario, fixture, index, "draft"),
    buildEvent(scenario, fixture, index, "final"),
    buildEvent(scenario, fixture, index, "revised")
  ]);
}

export async function* mockRealtimeSubtitleStream(
  scenario: MockSubtitleScenario,
  options: MockSubtitleStreamOptions = {}
): AsyncGenerator<SubtitleSegmentUpdatedEvent> {
  const delayMs = options.delayMs ?? 300;

  for (const event of createMockSubtitleEvents(scenario)) {
    if (delayMs > 0) {
      await wait(delayMs);
    }

    yield event;
  }
}

export function estimateTranslationTokens(text: string): number {
  const normalizedLength = text.trim().length;
  return Math.max(1, Math.ceil(normalizedLength / 4));
}

function buildEvent(
  scenario: MockSubtitleScenario,
  fixture: MockSubtitleFixture,
  index: number,
  status: SubtitleSegmentStatus
): SubtitleSegmentUpdatedEvent {
  const segmentId = `seg_mock_${String(index + 1).padStart(3, "0")}`;
  const sourceText =
    status === "draft" ? fixture.sourceDraft : fixture.sourceFinal;
  const targetText = selectTargetText(fixture, status);
  const revision = status === "revised" ? 2 : 1;
  const endAtMs =
    status === "draft"
      ? Math.min(fixture.startAtMs + 1600, fixture.endAtMs)
      : fixture.endAtMs;

  return {
    type: "subtitle.segment.updated",
    version: 1,
    payload: {
      sessionId: scenario.sessionId,
      segmentId,
      status,
      sourceText,
      targetText,
      startAtMs: fixture.startAtMs,
      endAtMs,
      revision,
      confidence: selectConfidence(status),
      termsHit: [...fixture.termsHit],
      latencyMs: selectLatencyMs(status),
      modelTrace
    }
  };
}

function selectTargetText(
  fixture: MockSubtitleFixture,
  status: SubtitleSegmentStatus
): string {
  if (status === "draft") {
    return fixture.targetDraft;
  }

  if (status === "final") {
    return fixture.targetFinal;
  }

  return fixture.targetRevised;
}

function selectLatencyMs(status: SubtitleSegmentStatus): number {
  if (status === "draft") {
    return 900;
  }

  if (status === "final") {
    return 1800;
  }

  return 2800;
}

function selectConfidence(status: SubtitleSegmentStatus): number {
  if (status === "draft") {
    return 0.72;
  }

  if (status === "final") {
    return 0.88;
  }

  return 0.93;
}
