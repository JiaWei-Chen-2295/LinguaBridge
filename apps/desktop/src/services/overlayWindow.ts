import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";

const MAIN_WINDOW_LABEL = "main";
const OVERLAY_WINDOW_LABEL = "subtitle-overlay";
export const OVERLAY_VISIBILITY_EVENT = "overlay-visibility-changed";

export interface OverlayVisibilityPayload {
  visible: boolean;
}

export async function showOverlayWindow(): Promise<void> {
  const overlayWindow = await Window.getByLabel(OVERLAY_WINDOW_LABEL);
  if (overlayWindow === null) {
    return;
  }

  await overlayWindow.show();
  await overlayWindow.setFocus();
  await publishOverlayVisibility(true);
}

export async function hideOverlayWindow(): Promise<void> {
  const overlayWindow = await Window.getByLabel(OVERLAY_WINDOW_LABEL);
  if (overlayWindow === null) {
    return;
  }

  await overlayWindow.hide();
  await publishOverlayVisibility(false);
}

export async function isOverlayWindowVisible(): Promise<boolean> {
  const overlayWindow = await Window.getByLabel(OVERLAY_WINDOW_LABEL);
  if (overlayWindow === null) {
    return false;
  }

  return overlayWindow.isVisible();
}

export async function publishOverlayVisibility(visible: boolean): Promise<void> {
  await emitTo(MAIN_WINDOW_LABEL, OVERLAY_VISIBILITY_EVENT, {
    visible
  } satisfies OverlayVisibilityPayload);
}

export async function listenToOverlayVisibility(
  handler: (payload: OverlayVisibilityPayload) => void
): Promise<UnlistenFn> {
  return listen<OverlayVisibilityPayload>(OVERLAY_VISIBILITY_EVENT, (event) => {
    handler(event.payload);
  });
}

export function getOverlayWindowFeedback(error: unknown): string {
  if (error instanceof Error) {
    if (
      error.message.includes("reading 'invoke'") ||
      error.message.includes("transformCallback") ||
      error.message.includes("window.__TAURI__")
    ) {
      return "当前是浏览器预览环境，浮窗控制需要在 Tauri 桌面端中运行。";
    }

    if (error.message.includes("not allowed") || error.message.includes("denied")) {
      return "浮窗控制权限未配置，请重启桌面端后重试。";
    }

    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  return "浮窗控制失败，请重新打开悬浮窗。";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
