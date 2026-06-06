import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { SubtitleSegmentEvent } from "../types/protocol";
import { selectOverlaySegments } from "./overlaySubtitleSelection";

export const OVERLAY_SUBTITLE_SYNC_EVENT = "overlay-subtitle-sync";
const OVERLAY_WINDOW_LABEL = "subtitle-overlay";
const OVERLAY_SUBTITLE_CACHE_KEY = "lingua-bridge.overlay.subtitle-segments";

export interface OverlaySubtitleSyncPayload {
  segments: SubtitleSegmentEvent[];
}

export async function publishOverlaySubtitles(
  segments: SubtitleSegmentEvent[]
): Promise<void> {
  const visibleSegments = selectOverlaySegments(segments);
  writeCachedOverlaySubtitles(visibleSegments);
  await emitTo(OVERLAY_WINDOW_LABEL, OVERLAY_SUBTITLE_SYNC_EVENT, {
    segments: visibleSegments
  } satisfies OverlaySubtitleSyncPayload);
}

export async function listenToOverlaySubtitles(
  handler: (payload: OverlaySubtitleSyncPayload) => void
): Promise<UnlistenFn> {
  return listen<OverlaySubtitleSyncPayload>(OVERLAY_SUBTITLE_SYNC_EVENT, (event) => {
    handler(event.payload);
  });
}

export function readCachedOverlaySubtitles(): SubtitleSegmentEvent[] {
  try {
    const value = window.localStorage.getItem(OVERLAY_SUBTITLE_CACHE_KEY);
    if (value === null) {
      return [];
    }

    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return selectOverlaySegments(parsed.filter(isSubtitleSegmentEvent));
  } catch {
    return [];
  }
}

function writeCachedOverlaySubtitles(segments: SubtitleSegmentEvent[]): void {
  try {
    window.localStorage.setItem(OVERLAY_SUBTITLE_CACHE_KEY, JSON.stringify(segments));
  } catch {
    // Overlay sync is best-effort; live Tauri events still carry fresh subtitles.
  }
}

function isSubtitleSegmentEvent(value: unknown): value is SubtitleSegmentEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    typeof record.segmentId === "string" &&
    (record.status === "draft" ||
      record.status === "final" ||
      record.status === "revised") &&
    typeof record.sourceText === "string" &&
    typeof record.targetText === "string" &&
    typeof record.startAtMs === "number" &&
    typeof record.endAtMs === "number" &&
    typeof record.revision === "number" &&
    Array.isArray(record.termsHit) &&
    typeof record.latencyMs === "number"
  );
}
