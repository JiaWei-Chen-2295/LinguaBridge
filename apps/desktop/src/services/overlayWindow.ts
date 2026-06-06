import { Window } from "@tauri-apps/api/window";

const OVERLAY_WINDOW_LABEL = "subtitle-overlay";

export async function showOverlayWindow(): Promise<void> {
  const overlayWindow = await Window.getByLabel(OVERLAY_WINDOW_LABEL);
  if (overlayWindow === null) {
    return;
  }

  await overlayWindow.show();
  await overlayWindow.setFocus();
}

export async function hideOverlayWindow(): Promise<void> {
  const overlayWindow = await Window.getByLabel(OVERLAY_WINDOW_LABEL);
  if (overlayWindow === null) {
    return;
  }

  await overlayWindow.hide();
}

export async function isOverlayWindowVisible(): Promise<boolean> {
  const overlayWindow = await Window.getByLabel(OVERLAY_WINDOW_LABEL);
  if (overlayWindow === null) {
    return false;
  }

  return overlayWindow.isVisible();
}

export function toOverlayWindowFeedbackMessage(error: unknown): string {
  if (error instanceof Error) {
    return overlayRuntimeMessage(error.message);
  }

  if (typeof error === "string" && error.length > 0) {
    return overlayRuntimeMessage(error);
  }

  return "浮窗控制失败，请重新打开悬浮窗。";
}

function overlayRuntimeMessage(message: string): string {
  if (
    message.includes("reading 'invoke'") ||
    message.includes("transformCallback") ||
    message.includes("window.__TAURI__")
  ) {
    return "当前是浏览器预览环境，浮窗控制需要在 Tauri 桌面端中运行。";
  }

  return `悬浮窗控制失败：${message}`;
}
