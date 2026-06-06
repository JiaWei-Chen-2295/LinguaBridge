import assert from "node:assert/strict";
import { test } from "node:test";

import { LiveTranslateTextBuffer } from "./livetranslate-text-buffer";

test("LiveTranslateTextBuffer accumulates target chunks into one sentence", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "draft",
    text: "我们正在",
    receivedAtMs: 100
  });
  const updated = buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "draft",
    text: "生成中文同传。",
    receivedAtMs: 200
  });

  assert.equal(updated?.targetText, "我们正在生成中文同传。");
  assert.equal(updated?.status, "draft");
  assert.equal(updated?.changed, true);
});

test("LiveTranslateTextBuffer ignores shorter non-final target rollback", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "draft",
    text: "我们正在生成中文同传。",
    receivedAtMs: 100
  });
  const updated = buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "draft",
    text: "我们正在",
    receivedAtMs: 200
  });

  assert.equal(updated?.targetText, "我们正在生成中文同传。");
  assert.equal(updated?.changed, false);
  assert.equal(updated?.shortTextIgnored, true);
});

test("LiveTranslateTextBuffer applies shorter completed target text", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "completed",
    text: "We are generating Chinese interpretation.",
    receivedAtMs: 100
  });
  buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "draft",
    text: "我们正在生成中文同传临时文本。",
    receivedAtMs: 200
  });
  const finalSegment = buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "completed",
    text: "我们正在生成中文同传。",
    receivedAtMs: 300
  });

  assert.equal(finalSegment?.targetText, "我们正在生成中文同传。");
  assert.equal(finalSegment?.changed, true);
  assert.equal(finalSegment?.shortTextIgnored, false);
  assert.equal(finalSegment?.status, "final");
});

test("LiveTranslateTextBuffer stays draft until both source and target complete", () => {
  const buffer = new LiveTranslateTextBuffer();

  const sourceOnly = buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "completed",
    text: "We are generating Chinese interpretation.",
    receivedAtMs: 100
  });
  const targetDraft = buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "draft",
    text: "我们正在生成中文同传。",
    receivedAtMs: 200
  });

  assert.equal(sourceOnly?.status, "draft");
  assert.equal(targetDraft?.status, "draft");
  assert.equal(targetDraft?.sourceCompleted, true);
  assert.equal(targetDraft?.targetCompleted, false);
});

test("LiveTranslateTextBuffer finalizes after source and target completion", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "completed",
    text: "We are generating Chinese interpretation.",
    receivedAtMs: 100
  });
  const finalSegment = buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "completed",
    text: "我们正在生成中文同传。",
    receivedAtMs: 200
  });

  assert.equal(finalSegment?.status, "final");
  assert.equal(finalSegment?.sourceCompleted, true);
  assert.equal(finalSegment?.targetCompleted, true);
});

test("LiveTranslateTextBuffer keeps missing item_id events on the active item", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "draft",
    text: "We are",
    receivedAtMs: 100
  });
  const updated = buffer.apply({
    kind: "target",
    phase: "draft",
    text: "我们正在",
    receivedAtMs: 200
  });

  assert.equal(updated?.itemId, "item_1");
  assert.equal(updated?.sourceText, "We are");
  assert.equal(updated?.targetText, "我们正在");
});
