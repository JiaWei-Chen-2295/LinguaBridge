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
