import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  CircleDot,
  Eye,
  EyeOff,
  GripHorizontal,
  Lock,
  Maximize2,
  Minus,
  Square,
  Type,
  Unlock
} from "lucide-react";
import type { MouseEvent, ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { IconButton } from "../components/IconButton";
import { StatusPill } from "../components/StatusPill";
import { subtitleSegments } from "../data/mockData";
import {
  getAudioCaptureStatus,
  listenToAudioFrames,
  startAudioCapture,
  stopAudioCapture,
  toAudioCommandError
} from "../services/audioCommands";
import type { AudioCaptureStatus } from "../types/audio";
import type { OverlayLineMode } from "../types/protocol";

export function OverlayWindow(): ReactElement {
  const [locked, setLocked] = useState(false);
  const [opacity, setOpacity] = useState(88);
  const [fontSize, setFontSize] = useState(30);
  const [lineMode, setLineMode] = useState<OverlayLineMode>("dual");
  const [showChrome, setShowChrome] = useState(true);
  const [captureStatus, setCaptureStatus] = useState<AudioCaptureStatus | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [audioFeedback, setAudioFeedback] = useState("点击录制 Windows 音频开始本地采集。");
  const [receivedFrames, setReceivedFrames] = useState(0);
  const overlayStartedCaptureRef = useRef(false);

  const visibleSegments = useMemo(() => subtitleSegments.slice(-2), []);
  const isCapturing = captureStatus?.state === "capturing";
  const captureOwnedByOverlay = isCapturing && overlayStartedCaptureRef.current;
  const captureControlDisabled = captureBusy || (isCapturing && !captureOwnedByOverlay);
  const CaptureIcon = isCapturing ? Square : CircleDot;

  useEffect(() => {
    let cancelled = false;
    let unlistenFrames: (() => void) | null = null;
    let refreshTimer: number | null = null;

    async function hydrateAudioCapture(): Promise<void> {
      try {
        const [nextStatus, nextUnlistenFrames] = await Promise.all([
          getAudioCaptureStatus(),
          listenToAudioFrames(() => {
            setReceivedFrames((current) => current + 1);
          })
        ]);

        if (cancelled) {
          nextUnlistenFrames();
          return;
        }

        unlistenFrames = nextUnlistenFrames;
        setCaptureStatus(nextStatus);
        setAudioFeedback(getOverlayAudioFeedback(nextStatus, 0, false));
      } catch (error) {
        if (!cancelled) {
          setAudioFeedback(getOverlayRuntimeFeedback(error));
        }
      }
    }

    async function refreshAudioCaptureStatus(): Promise<void> {
      try {
        const nextStatus = await getAudioCaptureStatus();

        if (!cancelled) {
          setCaptureStatus(nextStatus);
        }
      } catch {
        if (refreshTimer !== null) {
          window.clearInterval(refreshTimer);
          refreshTimer = null;
        }
      }
    }

    void hydrateAudioCapture();
    refreshTimer = window.setInterval(() => {
      void refreshAudioCaptureStatus();
    }, 1_500);

    return () => {
      cancelled = true;
      if (refreshTimer !== null) {
        window.clearInterval(refreshTimer);
      }
      unlistenFrames?.();

      if (overlayStartedCaptureRef.current) {
        overlayStartedCaptureRef.current = false;
        void stopAudioCapture().catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (captureStatus === null) {
      return;
    }

    setAudioFeedback(
      getOverlayAudioFeedback(captureStatus, receivedFrames, overlayStartedCaptureRef.current)
    );
  }, [captureStatus, receivedFrames]);

  async function handleDragStart(event: MouseEvent<HTMLDivElement>): Promise<void> {
    if (locked || event.button !== 0) {
      return;
    }

    event.preventDefault();

    try {
      await getCurrentWindow().startDragging();
    } catch (error) {
      setAudioFeedback(getOverlayRuntimeFeedback(error));
    }
  }

  async function handleCaptureToggle(): Promise<void> {
    if (captureBusy) {
      return;
    }

    setCaptureBusy(true);

    try {
      if (isCapturing && overlayStartedCaptureRef.current) {
        const nextStatus = await stopAudioCapture();
        overlayStartedCaptureRef.current = false;
        setCaptureStatus(nextStatus);
        setReceivedFrames(0);
        return;
      }

      const nextStatus = await startAudioCapture({
        deviceId: null,
        sampleRateHz: 16_000,
        channels: 1,
        frameDurationMs: 20
      });
      overlayStartedCaptureRef.current = true;
      setCaptureStatus(nextStatus);
      setReceivedFrames(0);
    } catch (error) {
      const commandError = toAudioCommandError(error);

      if (commandError.kind === "alreadyCapturing") {
        const nextStatus = await getAudioCaptureStatus().catch(() => null);
        overlayStartedCaptureRef.current = false;
        setCaptureStatus(nextStatus);
      }

      setAudioFeedback(getOverlayRuntimeFeedback(error));
    } finally {
      setCaptureBusy(false);
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
            <GripHorizontal size={18} aria-hidden="true" />
            <span>LinguaBridge</span>
          </div>
          <div className="overlay-actions">
            <StatusPill
              label={isCapturing ? "录制中" : "未录制"}
              tone={captureStatus?.state === "error" ? "error" : isCapturing ? "active" : "idle"}
            />
            <button
              className={`overlay-record-button ${isCapturing ? "overlay-record-button--active" : ""}`}
              disabled={captureControlDisabled}
              onClick={handleCaptureToggle}
              title={
                isCapturing && !captureOwnedByOverlay
                  ? "主窗口正在采集，停止请回主窗口"
                  : undefined
              }
              type="button"
            >
              <CaptureIcon size={16} aria-hidden="true" />
              <span>
                {isCapturing
                  ? captureOwnedByOverlay
                    ? "停止录制"
                    : "主窗口录制中"
                  : "录制 Windows 音频"}
              </span>
            </button>
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
              captureStatus?.state === "error" ? "overlay-capture-line--error" : ""
            }`}
          >
            {audioFeedback}
          </span>
        </footer>
      ) : null}
    </main>
  );
}

function getOverlayAudioFeedback(
  captureStatus: AudioCaptureStatus,
  receivedFrames: number,
  captureOwnedByOverlay: boolean
): string {
  if (captureStatus.state === "capturing") {
    if (receivedFrames > 0) {
      return `Windows 音频采集中，已收到 ${receivedFrames} 帧。`;
    }

    return captureOwnedByOverlay
      ? "Windows 音频采集中，等待第一帧。"
      : "主窗口正在录制 Windows 音频。";
  }

  if (captureStatus.state === "starting") {
    return "正在启动 Windows 音频采集。";
  }

  if (captureStatus.state === "stopping") {
    return "正在停止 Windows 音频采集。";
  }

  if (captureStatus.state === "error") {
    return captureStatus.lastError ?? "Windows 音频采集失败。";
  }

  return "点击录制 Windows 音频开始本地采集。";
}

function getOverlayRuntimeFeedback(error: unknown): string {
  const commandError = toAudioCommandError(error);

  if (commandError.kind !== "internal") {
    return commandError.message;
  }

  if (error instanceof Error) {
    if (error.message.includes("reading 'invoke'") || error.message.includes("window.__TAURI__")) {
      return "当前是浏览器预览环境，系统音频采集需要在 Tauri 桌面端中运行。";
    }

    return error.message;
  }

  return commandError.message;
}
