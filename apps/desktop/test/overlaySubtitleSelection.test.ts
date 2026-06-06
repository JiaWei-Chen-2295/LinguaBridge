import assert from "node:assert/strict";
import { test } from "node:test";

import { selectOverlaySegments } from "../src/services/overlaySubtitleSelection";
import type { SubtitleSegmentEvent } from "../src/types/protocol";

function subtitle(
  input: Partial<SubtitleSegmentEvent> & Pick<SubtitleSegmentEvent, "segmentId" | "startAtMs">
): SubtitleSegmentEvent {
  return {
    sessionId: input.sessionId ?? "session_1",
    segmentId: input.segmentId,
    status: input.status ?? "final",
    sourceText: input.sourceText ?? `source ${input.segmentId}`,
    targetText: input.targetText ?? `target ${input.segmentId}`,
    startAtMs: input.startAtMs,
    endAtMs: input.endAtMs ?? input.startAtMs + 1_000,
    revision: input.revision ?? 1,
    termsHit: input.termsHit ?? [],
    latencyMs: input.latencyMs ?? 120
  };
}

test("selectOverlaySegments returns an empty list for no subtitles", () => {
  assert.deepEqual(selectOverlaySegments([]), []);
});

test("selectOverlaySegments returns one segment when only one sentence exists", () => {
  const only = subtitle({ segmentId: "seg_1", startAtMs: 0 });

  assert.deepEqual(selectOverlaySegments([only]), [only]);
});

test("selectOverlaySegments returns the previous sentence and current sentence", () => {
  const first = subtitle({ segmentId: "seg_1", startAtMs: 0 });
  const second = subtitle({ segmentId: "seg_2", startAtMs: 2_000 });
  const third = subtitle({ segmentId: "seg_3", startAtMs: 4_000 });

  assert.deepEqual(selectOverlaySegments([first, second, third]), [second, third]);
});

test("selectOverlaySegments keeps one entry for updated revisions of the same segment", () => {
  const previous = subtitle({ segmentId: "seg_1", startAtMs: 0 });
  const draft = subtitle({
    segmentId: "seg_2",
    status: "draft",
    startAtMs: 2_000,
    targetText: "半句草稿",
    revision: 1
  });
  const final = subtitle({
    segmentId: "seg_2",
    status: "final",
    startAtMs: 2_000,
    targetText: "完整句子。",
    revision: 1
  });

  const selected = selectOverlaySegments([previous, draft, final]);

  assert.equal(selected.length, 2);
  assert.equal(selected[0]?.segmentId, "seg_1");
  assert.equal(selected[1]?.segmentId, "seg_2");
  assert.equal(selected[1]?.status, "final");
  assert.equal(selected[1]?.targetText, "完整句子。");
});

test("selectOverlaySegments sorts by subtitle time instead of input order", () => {
  const current = subtitle({ segmentId: "seg_3", startAtMs: 4_000 });
  const previous = subtitle({ segmentId: "seg_2", startAtMs: 2_000 });
  const old = subtitle({ segmentId: "seg_1", startAtMs: 0 });

  const selected = selectOverlaySegments([current, old, previous]);

  assert.deepEqual(
    selected.map((segment) => segment.segmentId),
    ["seg_2", "seg_3"]
  );
});
