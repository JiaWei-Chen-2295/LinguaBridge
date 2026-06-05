import { Eye, EyeOff, GripHorizontal, Lock, Maximize2, Minus, Type, Unlock } from "lucide-react";
import type { ReactElement } from "react";
import { useMemo, useState } from "react";

import { IconButton } from "../components/IconButton";
import { StatusPill } from "../components/StatusPill";
import { subtitleSegments } from "../data/mockData";
import type { OverlayLineMode } from "../types/protocol";

export function OverlayWindow(): ReactElement {
  const [locked, setLocked] = useState(false);
  const [opacity, setOpacity] = useState(88);
  const [fontSize, setFontSize] = useState(30);
  const [lineMode, setLineMode] = useState<OverlayLineMode>("dual");
  const [showChrome, setShowChrome] = useState(true);

  const visibleSegments = useMemo(() => subtitleSegments.slice(-2), []);
  const currentSegment = visibleSegments[visibleSegments.length - 1];

  return (
    <main className="overlay-shell" style={{ opacity: opacity / 100 }}>
      {showChrome ? (
        <header className="overlay-toolbar" data-tauri-drag-region={locked ? undefined : true}>
          <div className="overlay-grip" data-tauri-drag-region={locked ? undefined : true}>
            <GripHorizontal size={18} aria-hidden="true" />
            <span>LinguaBridge</span>
          </div>
          <div className="overlay-actions">
            <StatusPill
              label={currentSegment?.status === "draft" ? "draft" : "live"}
              tone={currentSegment?.status === "draft" ? "warning" : "active"}
            />
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
        {visibleSegments.map((segment) => (
          <article
            className={`caption-line caption-line--${segment.status}`}
            key={segment.segmentId}
            style={{ fontSize: `${fontSize}px` }}
          >
            <p>{segment.targetText}</p>
            {lineMode === "dual" ? <span>{segment.sourceText}</span> : null}
          </article>
        ))}
      </section>

      {showChrome ? (
        <footer className="overlay-settings">
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
        </footer>
      ) : null}
    </main>
  );
}
