import assert from "node:assert/strict";
import { test } from "node:test";

import { getOverlayWindowFeedback } from "../src/services/overlayWindow";

test("getOverlayWindowFeedback does not describe window failures as audio command failures", () => {
  const message = getOverlayWindowFeedback("not allowed");

  assert.equal(message.includes("Audio command failed"), false);
  assert.equal(message, "浮窗控制权限未配置，请重启桌面端后重试。");
});

test("getOverlayWindowFeedback explains browser preview limitations", () => {
  assert.equal(
    getOverlayWindowFeedback(
      "Cannot read properties of undefined (reading 'invoke')"
    ),
    "当前是浏览器预览环境，浮窗控制需要在 Tauri 桌面端中运行。"
  );
});
