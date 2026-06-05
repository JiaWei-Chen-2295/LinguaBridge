import type { SubtitleSegmentEvent } from "../types/protocol";

export interface HistorySession {
  id: string;
  title: string;
  source: string;
  startedAt: string;
  durationMinutes: number;
  segmentCount: number;
  storageMb: number;
}

export interface UsageSummary {
  month: string;
  usedMinutes: number;
  quotaMinutes: number;
  translatedTokens: number;
  revisionTokens: number;
  storageMb: number;
}

export interface GlossaryEntry {
  id: string;
  sourceTerm: string;
  targetTerm: string;
  note: string;
  enabled: boolean;
}

export const subtitleSegments: SubtitleSegmentEvent[] = [
  {
    sessionId: "sess_alpha_demo",
    segmentId: "seg_001",
    status: "final",
    sourceText: "We deploy it on Kubernetes and expose the service through an ingress controller.",
    targetText: "我们将它部署在 Kubernetes 上，并通过 ingress controller 暴露服务。",
    startAtMs: 12_030,
    endAtMs: 18_880,
    revision: 1,
    termsHit: ["Kubernetes", "ingress controller"],
    latencyMs: 2_200
  },
  {
    sessionId: "sess_alpha_demo",
    segmentId: "seg_002",
    status: "revised",
    sourceText: "The reconciliation loop keeps comparing desired state with the current cluster state.",
    targetText: "reconciliation loop 会持续比较期望状态和当前集群状态。",
    startAtMs: 19_140,
    endAtMs: 25_720,
    revision: 2,
    termsHit: ["reconciliation loop"],
    latencyMs: 3_040
  },
  {
    sessionId: "sess_alpha_demo",
    segmentId: "seg_003",
    status: "draft",
    sourceText: "If the pod crashes, the controller creates a replacement automatically...",
    targetText: "如果 pod 崩溃，controller 会自动创建替代实例……",
    startAtMs: 26_060,
    endAtMs: 30_900,
    revision: 1,
    termsHit: ["pod", "controller"],
    latencyMs: 1_860
  }
];

export const historySessions: HistorySession[] = [
  {
    id: "sess_alpha_demo",
    title: "Kubernetes controllers deep dive",
    source: "Browser audio",
    startedAt: "2026-06-05 08:10",
    durationMinutes: 42,
    segmentCount: 318,
    storageMb: 54
  },
  {
    id: "sess_gateway_spike",
    title: "Realtime gateway design review",
    source: "Meeting app",
    startedAt: "2026-06-04 21:35",
    durationMinutes: 28,
    segmentCount: 214,
    storageMb: 36
  },
  {
    id: "sess_rust_audio",
    title: "WASAPI loopback notes",
    source: "Local player",
    startedAt: "2026-06-03 19:20",
    durationMinutes: 18,
    segmentCount: 126,
    storageMb: 24
  }
];

export const usageSummary: UsageSummary = {
  month: "2026-06",
  usedMinutes: 88,
  quotaMinutes: 300,
  translatedTokens: 126_400,
  revisionTokens: 18_200,
  storageMb: 114
};

export const glossaryEntries: GlossaryEntry[] = [
  {
    id: "term_001",
    sourceTerm: "Kubernetes",
    targetTerm: "Kubernetes",
    note: "保留英文，避免译成容器编排系统。",
    enabled: true
  },
  {
    id: "term_002",
    sourceTerm: "reconciliation loop",
    targetTerm: "reconciliation loop",
    note: "技术上下文中保留英文。",
    enabled: true
  },
  {
    id: "term_003",
    sourceTerm: "latency budget",
    targetTerm: "延迟预算",
    note: "实时字幕链路指标。",
    enabled: true
  }
];
