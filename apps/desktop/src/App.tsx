import type { ReactElement } from "react";

import { MainWindow } from "./views/MainWindow";
import { OverlayWindow } from "./views/OverlayWindow";

type DesktopWindow = "main" | "overlay";

export function App(): ReactElement {
  const windowKind = getWindowKind();

  return windowKind === "overlay" ? <OverlayWindow /> : <MainWindow />;
}

function getWindowKind(): DesktopWindow {
  const params = new URLSearchParams(window.location.search);
  return params.get("window") === "overlay" ? "overlay" : "main";
}
