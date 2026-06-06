import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  CircleX,
  Eye,
  EyeOff,
  GripHorizontal,
  Lock,
  Maximize2,
  Minus,
  Type,
  Unlock
} from "lucide-react";
import type { MouseEvent, ReactElement } from "react";
import { useEffect, useState } from "react";

import { IconButton } from "../components/IconButton";
import { StatusPill } from "../components/StatusPill";
import {
  listenToOverlaySubtitles,
  readCachedOverlaySubtitles
} from "../services/overlaySubtitle";
import type { OverlayLineMode, SubtitleSegmentEvent } from "../types/protocol";

export function OverlayWindow(): ReactElement {
  const [locked, setLocked] = useState(false);
  const [opacity, setOpacity] = useState(88);
  const [fontSize, setFontSize] = useState(30);
  const [lineMode, setLineMode] = useState<OverlayLineMode>("dual");
  const [showChrome, setShowChrome] = useState(true);
  const [visibleSegments, setVisibleSegments] = useState<SubtitleSegmentEvent[]>(() =>
    readCachedOverlaySubtitles()
  );
  const [syncFeedback, setSyncFeedback] = useState("等待主窗口实时字幕。");

  const synced = visibleSegments.length > 0;

  useEffect(() => {
    let cancelled = false;
    let unlistenSubtitles: (() => void) | null = null;

    async function subscribeToSubtitles(): Promise<void> {
      try {
        const unlisten = await listenToOverlaySubtitles((payload) => {
          const nextSegments = payload.segments.slice(-2);
          setVisibleSegments(nextSegments);
          setSyncFeedback(
            nextSegments.length > 0
              ? `已同步主窗口最近 ${nextSegments.length} 段字幕。`
              : "等待主窗口实时字幕。"
          );
        });

        if (cancelled) {
          unlisten();
          return;
        }

        unlistenSubtitles = unlisten;
      } catch (error) {
        if (!cancelled) {
          setSyncFeedback(getOverlayRuntimeFeedback(error));
        }
      }
    }

    void subscribeToSubtitles();

    return () => {
      cancelled = true;
      unlistenSubtitles?.();
    };
  }, []);

  useEffect(() => {
    if (visibleSegments.length > 0) {
      setSyncFeedback(`已同步主窗口最近 ${visibleSegments.length} 段字幕。`);
    }
  }, [visibleSegments.length]);

  async function handleDragStart(event: MouseEvent<HTMLDivElement>): Promise<void> {
    if (locked || event.button !== 0) {
      return;
    }

    event.preventDefault();

    try {
      await getCurrentWindow().startDragging();
    } catch (error) {
      setSyncFeedback(getOverlayRuntimeFeedback(error));
    }
  }

  async function handleHideOverlay(): Promise<void> {
    try {
      await getCurrentWindow().hide();
    } catch (error) {
      setSyncFeedback(getOverlayRuntimeFeedback(error));
    }
  }

  return (
    <main className="overlay-shell" style={{ opacity: opacity / 100 }}>
      {showChrome ? (
        <header className="overlay-toolbar">
          <div
            className={`overlay-grip ${locked ? "overlay-grip--locked" : ""}`}
            data-tauri-drag-region={locked ? undefined : true}
            onMouseDown={handleDragStart}
            title={locked ? "浮窗已锁定" : "拖动浮窗"}
          >
            <GripHorizontal size={14} aria-hidden="true" />
            <span>Overlay HUD</span>
          </div>
          <div className="overlay-actions">
            <StatusPill label={synced ? "已同步" : "待同步"} tone={synced ? "active" : "idle"} />
            <IconButton
              icon={lineMode === "dual" ? Maximize2 : Minus}
              label={lineMode === "dual" ? "切换单行字幕" : "切换双行字幕"}
              onClick={() => setLineMode(lineMode === "dual" ? "single" : "dual")}
            />
            <IconButton
              icon={locked ? Lock : Unlock}
              label={locked ? "解锁浮窗" : "锁定浮窗"}
              onClick={() => setLocked((value) => !value)}
            />
            <IconButton icon={CircleX} label="隐藏悬浮窗" onClick={() => void handleHideOverlay()} />
            <IconButton icon={EyeOff} label="隐藏浮窗控制条" onClick={() => setShowChrome(false)} />
          </div>
        </header>
      ) : (
        <button className="overlay-reveal" title="显示浮窗控制条" onClick={() => setShowChrome(true)}>
          <Eye size={16} aria-hidden="true" />
          <span className="visually-hidden">显示浮窗控制条</span>
        </button>
      )}

      <section className="caption-stage" aria-label="Realtime subtitles">
        {visibleSegments.length === 0 ? (
          <div className="caption-empty" style={{ fontSize: `${Math.max(22, fontSize - 4)}px` }}>
            <p>等待实时字幕</p>
            {lineMode === "dual" ? <span>Start a session in the main window.</span> : null}
          </div>
        ) : (
          visibleSegments.map((segment) => (
            <article
              className={`caption-line caption-line--${segment.status}`}
              key={segment.segmentId}
              style={{ fontSize: `${fontSize}px` }}
            >
              <p>{segment.targetText}</p>
              {lineMode === "dual" ? <span>{segment.sourceText}</span> : null}
            </article>
          ))
        )}
      </section>

      {showChrome ? (
        <footer className="overlay-settings">
          <div className="overlay-range-controls">
            <label>
              <Type size={15} aria-hidden="true" />
              <input
                type="range"
                min="22"
                max="44"
                value={fontSize}
                onChange={(event) => setFontSize(event.target.valueAsNumber)}
                aria-label="字幕字号"
              />
            </label>
            <label>
              <Eye size={15} aria-hidden="true" />
              <input
                type="range"
                min="45"
                max="100"
                value={opacity}
                onChange={(event) => setOpacity(event.target.valueAsNumber)}
                aria-label="浮窗透明度"
              />
            </label>
          </div>
          <span
            className={`overlay-capture-line ${
              syncFeedback.includes("失败") ? "overlay-capture-line--error" : ""
            }`}
          >
            {syncFeedback}
          </span>
        </footer>
      ) : null}
    </main>
  );
}

function getOverlayRuntimeFeedback(error: unknown): string {
  if (error instanceof Error) {
    if (
      error.message.includes("reading 'invoke'") ||
      error.message.includes("transformCallback") ||
      error.message.includes("window.__TAURI__")
    ) {
      return "当前是浏览器预览环境，浮窗控制需要在 Tauri 桌面端中运行。";
    }

    return error.message;
  }

  return "浮窗控制失败，请重新打开悬浮窗。";
}
