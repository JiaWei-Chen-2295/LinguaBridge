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

test("LiveTranslateTextBuffer merges CJK suffix-prefix overlap", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "draft",
    text: "我们正在生成",
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
});

test("LiveTranslateTextBuffer merges English suffix-prefix overlap", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "draft",
    text: "Hello wor",
    receivedAtMs: 100
  });
  const updated = buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "draft",
    text: "world",
    receivedAtMs: 200
  });

  assert.equal(updated?.sourceText, "Hello world");
});

test("LiveTranslateTextBuffer does not merge one-character English overlap", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "draft",
    text: "cat",
    receivedAtMs: 100
  });
  const updated = buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "draft",
    text: "the dog",
    receivedAtMs: 200
  });

  assert.equal(updated?.sourceText, "cat the dog");
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

test("LiveTranslateTextBuffer ignores shorter non-final internal rollback", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "draft",
    text: "We are generating Chinese interpretation",
    receivedAtMs: 100
  });
  const updated = buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "draft",
    text: "generating Chinese",
    receivedAtMs: 200
  });

  assert.equal(updated?.sourceText, "We are generating Chinese interpretation");
  assert.equal(updated?.changed, false);
  assert.equal(updated?.shortTextIgnored, true);
});

test("LiveTranslateTextBuffer appends valid shorter chunk continuation", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "draft",
    text: "这是一个很长的",
    receivedAtMs: 100
  });
  const updated = buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "draft",
    text: "句子。",
    receivedAtMs: 200
  });

  assert.equal(updated?.targetText, "这是一个很长的句子。");
  assert.equal(updated?.changed, true);
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

test("LiveTranslateTextBuffer replaces draft with completed semantic target text", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "completed",
    text: "Final source.",
    receivedAtMs: 100
  });
  buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "draft",
    text: "临时草稿一",
    receivedAtMs: 200
  });
  const finalSegment = buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "completed",
    text: "最终译文更长一些。",
    receivedAtMs: 300
  });

  assert.equal(finalSegment?.targetText, "最终译文更长一些。");
  assert.equal(finalSegment?.status, "final");
});

test("LiveTranslateTextBuffer prefers completed target text over overlap merge", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "completed",
    text: "Final source.",
    receivedAtMs: 100
  });
  buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "draft",
    text: "Hello world",
    receivedAtMs: 200
  });
  const finalSegment = buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "completed",
    text: "world peace",
    receivedAtMs: 300
  });

  assert.equal(finalSegment?.targetText, "world peace");
  assert.equal(finalSegment?.status, "final");
  assert.equal(finalSegment?.changed, true);
  assert.equal(finalSegment?.shortTextIgnored, false);
});

test("LiveTranslateTextBuffer marks empty completed target while retaining draft text", () => {
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
    text: "我们正在生成中文同传。",
    receivedAtMs: 200
  });
  const finalSegment = buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "completed",
    text: "",
    receivedAtMs: 300
  });

  assert.equal(finalSegment?.targetText, "我们正在生成中文同传。");
  assert.equal(finalSegment?.targetCompleted, true);
  assert.equal(finalSegment?.status, "final");
  assert.equal(finalSegment?.changed, true);
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

test("LiveTranslateTextBuffer ignores late target draft after target completion", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "completed",
    text: "A",
    receivedAtMs: 100
  });
  buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "completed",
    text: "甲",
    receivedAtMs: 200
  });
  const updated = buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "draft",
    text: "乙",
    receivedAtMs: 300
  });

  assert.equal(updated?.targetText, "甲");
  assert.equal(updated?.status, "final");
  assert.equal(updated?.changed, false);
});

test("LiveTranslateTextBuffer ignores late source draft after source completion", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "completed",
    text: "A",
    receivedAtMs: 100
  });
  buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "completed",
    text: "甲",
    receivedAtMs: 200
  });
  const updated = buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "draft",
    text: "B",
    receivedAtMs: 300
  });

  assert.equal(updated?.sourceText, "A");
  assert.equal(updated?.status, "final");
  assert.equal(updated?.changed, false);
});

test("LiveTranslateTextBuffer keeps active item after stale explicit draft is ignored", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "completed",
    text: "A",
    receivedAtMs: 100
  });
  buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "completed",
    text: "甲",
    receivedAtMs: 200
  });
  buffer.apply({
    itemId: "item_2",
    kind: "source",
    phase: "draft",
    text: "Second",
    receivedAtMs: 300
  });
  buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "draft",
    text: "乙",
    receivedAtMs: 400
  });
  const updated = buffer.apply({
    kind: "target",
    phase: "draft",
    text: "第二句。",
    receivedAtMs: 500
  });

  assert.equal(updated?.itemId, "item_2");
  assert.equal(updated?.targetText, "第二句。");
  assert.equal(updated?.status, "draft");
});

test("LiveTranslateTextBuffer keeps active item after duplicate completed event no-op", () => {
  const buffer = new LiveTranslateTextBuffer();

  buffer.apply({
    itemId: "item_1",
    kind: "source",
    phase: "completed",
    text: "A",
    receivedAtMs: 100
  });
  buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "completed",
    text: "甲",
    receivedAtMs: 200
  });
  buffer.apply({
    itemId: "item_2",
    kind: "source",
    phase: "draft",
    text: "Second",
    receivedAtMs: 300
  });
  const duplicateFinal = buffer.apply({
    itemId: "item_1",
    kind: "target",
    phase: "completed",
    text: "甲",
    receivedAtMs: 400
  });
  const updated = buffer.apply({
    kind: "target",
    phase: "draft",
    text: "第二句。",
    receivedAtMs: 500
  });

  assert.equal(duplicateFinal?.changed, false);
  assert.equal(updated?.itemId, "item_2");
  assert.equal(updated?.targetText, "第二句。");
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

test("LiveTranslateTextBuffer starts a new item after missing item_id follows final segment", () => {
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
    phase: "completed",
    text: "我们正在生成中文同传。",
    receivedAtMs: 200
  });
  const updated = buffer.apply({
    kind: "target",
    phase: "draft",
    text: "下一句。",
    receivedAtMs: 300
  });

  assert.notEqual(updated?.itemId, "item_1");
  assert.equal(updated?.status, "draft");
  assert.equal(updated?.sourceText, "");
  assert.equal(updated?.targetText, "下一句。");
});
