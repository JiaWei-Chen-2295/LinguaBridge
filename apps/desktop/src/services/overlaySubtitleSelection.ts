import type { SubtitleSegmentEvent } from "../types/protocol";

const statusRank: Record<SubtitleSegmentEvent["status"], number> = {
  draft: 0,
  final: 1,
  revised: 2
};

interface IndexedSubtitleSegment {
  segment: SubtitleSegmentEvent;
  index: number;
}

export function selectOverlaySegments(
  segments: SubtitleSegmentEvent[]
): SubtitleSegmentEvent[] {
  const latestBySegmentId = new Map<string, IndexedSubtitleSegment>();

  segments.forEach((segment, index) => {
    const existing = latestBySegmentId.get(segment.segmentId);
    if (
      existing === undefined ||
      compareSegmentFreshness(existing.segment, segment, existing.index, index) <= 0
    ) {
      latestBySegmentId.set(segment.segmentId, { segment, index });
    }
  });

  return Array.from(latestBySegmentId.values())
    .sort((left, right) =>
      compareSegmentPosition(left.segment, right.segment, left.index, right.index)
    )
    .slice(-2)
    .map((entry) => entry.segment);
}

function compareSegmentFreshness(
  left: SubtitleSegmentEvent,
  right: SubtitleSegmentEvent,
  leftIndex: number,
  rightIndex: number
): number {
  return (
    left.revision - right.revision ||
    statusRank[left.status] - statusRank[right.status] ||
    left.endAtMs - right.endAtMs ||
    leftIndex - rightIndex
  );
}

function compareSegmentPosition(
  left: SubtitleSegmentEvent,
  right: SubtitleSegmentEvent,
  leftIndex: number,
  rightIndex: number
): number {
  return (
    left.startAtMs - right.startAtMs ||
    left.endAtMs - right.endAtMs ||
    left.revision - right.revision ||
    leftIndex - rightIndex
  );
}
