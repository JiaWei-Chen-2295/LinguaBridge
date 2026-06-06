import assert from "node:assert/strict";
import { test } from "node:test";

import { toOverlayWindowFeedbackMessage } from "../src/services/overlayWindow";

test("toOverlayWindowFeedbackMessage does not describe window failures as audio command failures", () => {
  const message = toOverlayWindowFeedbackMessage("not allowed");

  assert.equal(message.includes("Audio command failed"), false);
  assert.equal(message, "悬浮窗控制失败：not allowed");
});

test("toOverlayWindowFeedbackMessage explains browser preview limitations", () => {
  assert.equal(
    toOverlayWindowFeedbackMessage(
      "Cannot read properties of undefined (reading 'invoke')"
    ),
    "当前是浏览器预览环境，浮窗控制需要在 Tauri 桌面端中运行。"
  );
});
