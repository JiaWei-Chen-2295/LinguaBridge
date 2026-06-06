import type { SubtitleSegmentEvent } from "../types/protocol";

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
