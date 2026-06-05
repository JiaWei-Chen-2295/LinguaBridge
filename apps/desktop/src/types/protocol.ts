import type {
  SubtitleSegment as SharedSubtitleSegment,
  SubtitleSegmentStatus as SharedSubtitleSegmentStatus
} from "@lingua-bridge/protocol";

export type SubtitleSegmentStatus = SharedSubtitleSegmentStatus;

export type SubtitleSegmentEvent = Pick<
  SharedSubtitleSegment,
  | "sessionId"
  | "segmentId"
  | "status"
  | "sourceText"
  | "targetText"
  | "startAtMs"
  | "endAtMs"
  | "revision"
  | "termsHit"
  | "latencyMs"
>;

export type OverlayLineMode = "single" | "dual";
