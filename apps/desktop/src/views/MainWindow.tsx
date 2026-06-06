import {
  AlertCircle,
  BookOpenText,
  CheckCircle2,
  CirclePause,
  CirclePlay,
  CircleStop,
  Clock3,
  Database,
  Headphones,
  History,
  KeyRound,
  Languages,
  ListChecks,
  MonitorUp,
  Pencil,
  RefreshCw,
  Settings,
  ShieldCheck,
  TimerReset,
  Volume2,
  X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MutableRefObject, ReactElement } from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { IconButton } from "../components/IconButton";
import { MetricTile } from "../components/MetricTile";
import { StatusPill } from "../components/StatusPill";
import { formatDurationRange, formatMinutes, formatPercent } from "../lib/format";
import {
  getAudioCaptureCapabilities,
  getAudioCaptureStatus,
  listenToAudioFrames,
  listAudioDevices,
  startAudioCapture,
  stopAudioCapture,
  toAudioCommandError
} from "../services/audioCommands";
import {
  getOverlayWindowFeedback,
  hideOverlayWindow,
  isOverlayWindowVisible,
  listenToOverlayVisibility,
  showOverlayWindow
} from "../services/overlayWindow";
import { publishOverlaySubtitles } from "../services/overlaySubtitle";
import {
  InterpretationAudioPlayer,
  type InterpretationAudioPlayerSnapshot
} from "../services/interpretationAudioPlayer";
import {
  loadDesktopGlossary,
  loadDesktopHistory,
  loadDesktopUsage,
  type DesktopDataIdentity,
  type DesktopSessionSummary,
  type DesktopTermEntry,
  type DesktopUsageSummary
} from "../services/desktopApi";
import { RealtimeGatewayConnection } from "../services/realtimeGateway";
import type {
  AudioCaptureCapabilities,
  AudioCaptureMode,
  AudioCaptureStatus,
  AudioCommandError,
  AudioDevice
} from "../types/audio";
import type { SubtitleSegmentEvent } from "../types/protocol";
import type { InterpretationOptions } from "@lingua-bridge/protocol";

type MainTab = "session" | "history" | "usage" | "glossary";
type SessionMode = "idle" | "capturing" | "paused" | "error";
type SetupStepState = "waiting" | "current" | "complete" | "active" | "error";
type EchoAvoidance = InterpretationOptions["echoAvoidance"];

interface PanelLoadState<T> {
  data: T;
  loading: boolean;
  error: string | null;
}

const invitePattern = /^[A-Z0-9-]{6,32}$/;
const EMPTY_INTERPRETATION_AUDIO_STATUS: InterpretationAudioPlayerSnapshot = {
  bufferedMs: 0,
  playedChunks: 0,
  queuedChunks: 0,
  lastLatencyMs: null
};

export function MainWindow(): ReactElement {
  const [inviteCode, setInviteCode] = useState("");
  const [inviteActivated, setInviteActivated] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [selectedTab, setSelectedTab] = useState<MainTab>("session");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [captureStatus, setCaptureStatus] = useState<AudioCaptureStatus | null>(null);
  const [audioCapabilities, setAudioCapabilities] = useState<AudioCaptureCapabilities | null>(null);
  const [echoRiskAccepted, setEchoRiskAccepted] = useState(false);
  const [activeInterpretationPolicy, setActiveInterpretationPolicy] =
    useState<InterpretationStartPolicy | null>(null);
  const [sessionMode, setSessionMode] = useState<SessionMode>("idle");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [liveSubtitleSegments, setLiveSubtitleSegments] = useState<SubtitleSegmentEvent[]>([]);
  const [interpretationAudioStatus, setInterpretationAudioStatus] =
    useState<InterpretationAudioPlayerSnapshot>(EMPTY_INTERPRETATION_AUDIO_STATUS);
  const [userId, setUserId] = useState<string | null>(null);
  const [historyState, setHistoryState] = useState<PanelLoadState<DesktopSessionSummary[]>>({
    data: [],
    loading: false,
    error: null
  });
  const [usageState, setUsageState] = useState<PanelLoadState<DesktopUsageSummary | null>>({
    data: null,
    loading: false,
    error: null
  });
  const [glossaryState, setGlossaryState] = useState<PanelLoadState<DesktopTermEntry[]>>({
    data: [],
    loading: false,
    error: null
  });
  const [panelRefreshKey, setPanelRefreshKey] = useState(0);
  const realtimeConnectionRef = useRef<RealtimeGatewayConnection | null>(null);
  const audioFrameUnlistenRef = useRef<(() => void) | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const audioSendingEnabledRef = useRef(false);
  const interpretationAudioPlayerRef = useRef<InterpretationAudioPlayer | null>(null);
  const subtitleStreamEndRef = useRef<HTMLDivElement | null>(null);

  const audioErrored = sessionMode === "error" || captureStatus?.state === "error";
  const audioReady = !audioErrored && audioCapabilities !== null;
  const canStart =
    inviteActivated &&
    privacyAccepted &&
    audioReady &&
    sessionMode !== "capturing" &&
    sessionMode !== "paused";
  const activeDeviceName = useMemo(() => {
    if (selectedDeviceId === null) {
      return "Default Windows output";
    }

    return devices.find((device) => device.id === selectedDeviceId)?.name ?? "Selected output";
  }, [devices, selectedDeviceId]);
  const setupSteps: SetupStep[] = [
    {
      id: "invite",
      title: "准入",
      detail: inviteActivated ? "邀请码已校验" : "输入 Alpha 邀请码",
      icon: KeyRound,
      state: inviteActivated ? "complete" : "current"
    },
    {
      id: "privacy",
      title: "授权",
      detail: privacyAccepted ? "已确认数据策略" : "确认音频上传与落盘",
      icon: ShieldCheck,
      state: inviteActivated ? (privacyAccepted ? "complete" : "current") : "waiting"
    },
    {
      id: "audio",
      title: "音频源",
      detail: audioErrored ? "设备需要处理" : activeDeviceName,
      icon: Headphones,
      state:
        inviteActivated && privacyAccepted
          ? audioErrored
            ? "error"
            : "complete"
          : "waiting"
    },
    {
      id: "start",
      title: "开始",
      detail:
        sessionMode === "capturing"
          ? "正在推送音频帧"
          : sessionMode === "paused"
            ? "字幕流已暂停"
            : "启动真实链路",
      icon: CirclePlay,
      state:
        sessionMode === "capturing" || sessionMode === "paused"
          ? "active"
          : inviteActivated && privacyAccepted && audioReady
            ? "current"
            : "waiting"
    }
  ];
  const guideSummary = getGuideSummary({
    inviteActivated,
    privacyAccepted,
    audioErrored,
    sessionMode
  });
  const previewInterpretationPolicy =
    audioCapabilities === null
      ? null
      : chooseInterpretationStartPolicy(audioCapabilities, echoRiskAccepted);
  const panelDataIdentity = useMemo<DesktopDataIdentity | null>(() => {
    if (userId !== null) {
      return { userId };
    }

    if (inviteActivated) {
      const normalizedInviteCode = inviteCode.trim().toUpperCase();
      if (normalizedInviteCode.length > 0) {
        return { inviteCode: normalizedInviteCode };
      }
    }

    return null;
  }, [inviteActivated, inviteCode, userId]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateAudioState(): Promise<void> {
      try {
        const [nextDevices, nextStatus, nextCapabilities] = await Promise.all([
          listAudioDevices(),
          getAudioCaptureStatus(),
          getAudioCaptureCapabilities()
        ]);
        const nextOverlayVisible = await isOverlayWindowVisible().catch(() => true);

        if (cancelled) {
          return;
        }

        setDevices(nextDevices);
        setCaptureStatus(nextStatus);
        setAudioCapabilities(nextCapabilities);
        setOverlayVisible(nextOverlayVisible);
        setSelectedDeviceId(getDefaultAudioDeviceId(nextDevices));
      } catch (error) {
        if (!cancelled) {
          const commandError = toAudioCommandError(error);
          setFeedback(getAudioFeedbackMessage(commandError));
          setSessionMode("error");
        }
      }
    }

    void hydrateAudioState();

    return () => {
      cancelled = true;
      audioSendingEnabledRef.current = false;
      audioFrameUnlistenRef.current?.();
      audioFrameUnlistenRef.current = null;
      realtimeConnectionRef.current?.close();
      realtimeConnectionRef.current = null;
      void interpretationAudioPlayerRef.current?.close().catch(() => undefined);
      interpretationAudioPlayerRef.current = null;
      void stopAudioCapture().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlistenVisibility: (() => void) | null = null;

    async function subscribeToOverlayVisibility(): Promise<void> {
      try {
        const unlisten = await listenToOverlayVisibility((payload) => {
          setOverlayVisible(payload.visible);
        });

        if (cancelled) {
          unlisten();
          return;
        }

        unlistenVisibility = unlisten;
      } catch {
        // Overlay visibility sync is best-effort; toggle still queries the real window state.
      }
    }

    void subscribeToOverlayVisibility();

    return () => {
      cancelled = true;
      unlistenVisibility?.();
    };
  }, []);

  useEffect(() => {
    void publishOverlaySubtitles(liveSubtitleSegments).catch(() => undefined);
  }, [liveSubtitleSegments]);

  useEffect(() => {
    if (panelDataIdentity === null) {
      setHistoryState({ data: [], loading: false, error: null });
      setUsageState({ data: null, loading: false, error: null });
      setGlossaryState({ data: [], loading: true, error: null });

      let cancelled = false;
      void loadDesktopGlossary()
        .then((terms) => {
          if (!cancelled) {
            setGlossaryState({ data: terms, loading: false, error: null });
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setGlossaryState({
              data: [],
              loading: false,
              error: formatPanelError(error)
            });
          }
        });

      return () => {
        cancelled = true;
      };
    }

    let cancelled = false;

    setHistoryState({ data: [], loading: true, error: null });
    setUsageState({ data: null, loading: true, error: null });
    setGlossaryState({ data: [], loading: true, error: null });

    void loadDesktopHistory(panelDataIdentity)
      .then((sessions) => {
        if (!cancelled) {
          setHistoryState({ data: sessions, loading: false, error: null });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHistoryState({
            data: [],
            loading: false,
            error: formatPanelError(error)
          });
        }
      });

    void loadDesktopUsage(panelDataIdentity)
      .then((usage) => {
        if (!cancelled) {
          setUsageState({ data: usage, loading: false, error: null });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setUsageState({
            data: null,
            loading: false,
            error: formatPanelError(error)
          });
        }
      });

    void loadDesktopGlossary(panelDataIdentity)
      .then((terms) => {
        if (!cancelled) {
          setGlossaryState({ data: terms, loading: false, error: null });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setGlossaryState({
            data: [],
            loading: false,
            error: formatPanelError(error)
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [panelDataIdentity, panelRefreshKey]);

  useEffect(() => {
    subtitleStreamEndRef.current?.scrollIntoView({
      block: "end",
      behavior: liveSubtitleSegments.length > 2 ? "smooth" : "auto"
    });
  }, [liveSubtitleSegments]);

  function activateInvite(): void {
    const normalizedCode = inviteCode.trim().toUpperCase();

    if (!invitePattern.test(normalizedCode)) {
      setInviteActivated(false);
      setFeedback("请输入 6-32 位邀请码，可包含大写字母、数字和连字符。");
      return;
    }

    setInviteCode(normalizedCode);
    setInviteActivated(true);
    setFeedback("邀请码已在本地通过格式校验，开始伴学时会交给 Gateway 激活。");
  }

  async function handleStart(): Promise<void> {
    if (!privacyAccepted) {
      setFeedback("请先确认系统音频上传与落盘授权。");
      return;
    }

    if (!inviteActivated) {
      setFeedback("请先完成邀请码激活。");
      return;
    }

    setFeedback(null);
    setLiveSubtitleSegments([]);
    setInterpretationAudioStatus(EMPTY_INTERPRETATION_AUDIO_STATUS);

    try {
      if (audioCapabilities === null) {
        setFeedback("正在探测音频能力，请稍后再开始。");
        return;
      }

      const interpretationPolicy = chooseInterpretationStartPolicy(
        audioCapabilities,
        echoRiskAccepted
      );
      const interpretationAudioPlayer = interpretationPolicy.outputAudio
        ? getInterpretationAudioPlayer(interpretationAudioPlayerRef)
        : null;
      interpretationAudioPlayer?.reset();
      await interpretationAudioPlayer?.resume();

      const connection = new RealtimeGatewayConnection({
        onSubtitle: (event) => {
          setLiveSubtitleSegments((currentSegments) =>
            upsertSubtitleSegment(currentSegments, event.payload)
          );
        },
        onInterpretationAudioDelta: (event) => {
          if (interpretationAudioPlayer === null) {
            return;
          }

          void interpretationAudioPlayer.enqueue(event.payload)
            .then((snapshot) => {
              setInterpretationAudioStatus(snapshot);
            })
            .catch((error: unknown) => {
              setFeedback(
                `中文同传播放失败：${
                  error instanceof Error
                    ? getRuntimeFeedbackMessage(error.message)
                    : "请停止后重新开始会话。"
                }`
              );
            });
        },
        onInterpretationAudioCompleted: () => {
          if (interpretationAudioPlayer !== null) {
            setInterpretationAudioStatus(interpretationAudioPlayer.snapshot());
          }
        },
        onError: (event) => {
          setFeedback(event.payload.message);
        },
        onStopped: (event) => {
          setFeedback(`会话已停止，时长 ${Math.round(event.payload.durationMs / 1_000)} 秒。`);
        }
      });
      realtimeConnectionRef.current = connection;
      const started = await connection.startSession({
        inviteCode,
        deviceId: selectedDeviceId,
        mode: "interpretation",
        outputAudio: interpretationPolicy.outputAudio,
        echoAvoidance: interpretationPolicy.echoAvoidance,
        echoRiskAccepted: interpretationPolicy.echoRiskAccepted,
        windowsBuild: audioCapabilities.windowsBuild
      });
      activeSessionIdRef.current = started.sessionId;
      setUserId(started.userId);
      setPanelRefreshKey((currentKey) => currentKey + 1);
      setActiveInterpretationPolicy(interpretationPolicy);

      audioFrameUnlistenRef.current = await listenToAudioFrames((frame) => {
        if (!audioSendingEnabledRef.current) {
          return;
        }

        connection.sendAudioFrame(started.sessionId, frame);
      });

      const nextStatus = await startAudioCapture({
        deviceId: selectedDeviceId,
        sampleRateHz: 16_000,
        channels: 1,
        frameDurationMs: 20,
        mode: interpretationPolicy.captureMode
      });

      audioSendingEnabledRef.current = true;
      setCaptureStatus(nextStatus);
      setSessionMode("capturing");
      setFeedback(`中文同传已启动：${interpretationPolicy.message} · Gateway session ${started.sessionId}`);
    } catch (error) {
      await cleanupRealtimeSession("device_error");
      const commandError = toAudioCommandError(error);
      setFeedback(
        error instanceof Error
          ? getRuntimeFeedbackMessage(error.message)
          : getAudioFeedbackMessage(commandError)
      );
      setSessionMode("error");
    }
  }

  function handlePause(): void {
    if (sessionMode === "capturing") {
      audioSendingEnabledRef.current = false;
      setSessionMode("paused");
      setFeedback("字幕流已暂停发送。");
      return;
    }

    if (sessionMode === "paused") {
      audioSendingEnabledRef.current = true;
      setSessionMode("capturing");
      setFeedback("字幕流已恢复发送。");
    }
  }

  async function handleStop(): Promise<void> {
    setFeedback(null);

    try {
      audioSendingEnabledRef.current = false;
      const nextStatus = await stopAudioCapture();
      await cleanupRealtimeSession("user");
      setCaptureStatus(nextStatus);
      setSessionMode("idle");
      setPanelRefreshKey((currentKey) => currentKey + 1);
    } catch (error) {
      await cleanupRealtimeSession("device_error");
      const commandError = toAudioCommandError(error);
      setFeedback(getAudioFeedbackMessage(commandError));
      setSessionMode(commandError.kind === "notCapturing" ? "idle" : "error");
    }
  }

  async function refreshDevices(): Promise<void> {
    try {
      const [nextDevices, nextCapabilities, nextOverlayVisible] = await Promise.all([
        listAudioDevices(),
        getAudioCaptureCapabilities(),
        isOverlayWindowVisible().catch(() => overlayVisible)
      ]);
      setDevices(nextDevices);
      setAudioCapabilities(nextCapabilities);
      setOverlayVisible(nextOverlayVisible);
      setSelectedDeviceId((currentDeviceId) =>
        nextDevices.some((device) => device.id === currentDeviceId)
          ? currentDeviceId
          : getDefaultAudioDeviceId(nextDevices)
      );
      setSessionMode((currentMode) => (currentMode === "error" ? "idle" : currentMode));
      setFeedback("音频设备列表已刷新。");
    } catch (error) {
      const commandError = toAudioCommandError(error);
      setFeedback(getAudioFeedbackMessage(commandError));
    }
  }

  async function toggleOverlayWindow(): Promise<void> {
    try {
      const currentlyVisible = await isOverlayWindowVisible();

      if (currentlyVisible) {
        await hideOverlayWindow();
        setOverlayVisible(false);
        setFeedback("悬浮字幕窗已隐藏，可在主界面重新打开。");
        return;
      }

      await showOverlayWindow();
      setOverlayVisible(true);
      setFeedback("悬浮字幕窗已显示。");
    } catch (error) {
      setFeedback(getOverlayWindowFeedback(error));
    }
  }

  async function cleanupRealtimeSession(
    reason: "user" | "network" | "quota_exhausted" | "device_error"
  ): Promise<void> {
    const connection = realtimeConnectionRef.current;
    const sessionId = activeSessionIdRef.current;

    audioSendingEnabledRef.current = false;
    audioFrameUnlistenRef.current?.();
    audioFrameUnlistenRef.current = null;

    if (connection !== null && sessionId !== null) {
      await connection.stopSession(sessionId, reason).catch(() => undefined);
    }

    connection?.close();
    realtimeConnectionRef.current = null;
    activeSessionIdRef.current = null;
    interpretationAudioPlayerRef.current?.reset();
    setActiveInterpretationPolicy(null);
    setInterpretationAudioStatus(EMPTY_INTERPRETATION_AUDIO_STATUS);
  }

  const latestSubtitle = liveSubtitleSegments[liveSubtitleSegments.length - 1] ?? null;
  const displayLatency =
    latestSubtitle?.latencyMs ??
    interpretationAudioStatus.lastLatencyMs ??
    null;

  return (
    <main className="app-shell">
      <div className="ambient-bg" aria-hidden="true">
        <div className="ambient-orb" />
      </div>

      <nav className="top-nav" aria-label="Primary">
        <div className="top-nav-brand">
          <span className="top-nav-title">LinguaBridge AI</span>
        </div>

        <div className="top-nav-center">
          <button
            type="button"
            className={`top-nav-tab ${selectedTab === "session" ? "is-active" : ""}`}
            onClick={() => setSelectedTab("session")}
          >
            Session
          </button>
        </div>

        <div className="top-nav-actions">
          <button
            type="button"
            className="nav-btn nav-btn--ghost"
            disabled={sessionMode !== "capturing" && sessionMode !== "paused"}
            onClick={handlePause}
          >
            {sessionMode === "paused" ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            className="nav-btn nav-btn--primary"
            disabled={sessionMode !== "idle" || !canStart}
            onClick={() => void handleStart()}
          >
            Start
          </button>
          <div className="top-nav-divider" aria-hidden="true" />
          <button
            type="button"
            className="nav-icon-btn"
            title={overlayVisible ? "隐藏悬浮窗" : "打开悬浮窗"}
            onClick={() => void toggleOverlayWindow()}
          >
            <MonitorUp size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`nav-icon-btn ${settingsOpen ? "is-active" : ""}`}
            title="会话设置"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <Settings size={18} aria-hidden="true" />
          </button>
        </div>
      </nav>

      <aside className="side-dock" aria-label="Sections">
        <button
          type="button"
          className={`side-dock-brand ${selectedTab === "session" ? "is-active" : ""}`}
          title="实时会话"
          onClick={() => setSelectedTab("session")}
        >
          <Languages size={18} aria-hidden="true" />
        </button>

        <nav className="side-dock-nav" aria-label="Main">
          <button
            type="button"
            className={`side-dock-item ${selectedTab === "history" ? "is-active" : ""}`}
            title="历史会话"
            onClick={() => setSelectedTab("history")}
          >
            <History size={20} aria-hidden="true" />
            <span className="side-dock-tooltip">History</span>
          </button>
          <button
            type="button"
            className={`side-dock-item ${selectedTab === "usage" ? "is-active" : ""}`}
            title="用量统计"
            onClick={() => setSelectedTab("usage")}
          >
            <TimerReset size={20} aria-hidden="true" />
            <span className="side-dock-tooltip">Usage</span>
          </button>
          <button
            type="button"
            className={`side-dock-item ${selectedTab === "glossary" ? "is-active" : ""}`}
            title="术语表"
            onClick={() => setSelectedTab("glossary")}
          >
            <BookOpenText size={20} aria-hidden="true" />
            <span className="side-dock-tooltip">Glossary</span>
          </button>
        </nav>
      </aside>

      <div className="main-canvas">
        {selectedTab === "session" ? (
          <>
            <header className="session-header">
              <div className="session-status-chip">
                <span
                  className={`pulse-indicator ${sessionMode === "capturing" ? "pulse-indicator--live" : ""}`}
                />
                <span className="session-status-label">
                  {sessionMode === "capturing"
                    ? "Capturing"
                    : sessionMode === "paused"
                      ? "Paused"
                      : sessionMode === "error"
                        ? "Error"
                        : "Idle"}
                </span>
                {displayLatency !== null ? (
                  <>
                    <span className="session-status-sep" aria-hidden="true" />
                    <span className="session-status-meta">Latency {displayLatency}ms</span>
                  </>
                ) : null}
              </div>

              <PipelineStrip steps={setupSteps} />
            </header>

            <section className="subtitle-stream scrollbar-hide" aria-label="Live subtitle preview">
              <div className="subtitle-stream-rail" aria-hidden="true" />

              {liveSubtitleSegments.length === 0 ? (
                <div className="glass-panel subtitle-card subtitle-card--empty">
                  <div className="subtitle-card-header">
                    <span className="subtitle-badge">READY</span>
                  </div>
                  <div className="subtitle-card-body">
                    <p className="subtitle-source">
                      {sessionMode === "capturing"
                        ? "Audio frames are streaming to Gateway. Subtitles will appear here as ASR results arrive."
                        : "Complete setup in the settings panel, then press Start to begin a live session."}
                    </p>
                    <p className="subtitle-target">
                      {sessionMode === "capturing" ? "正在等待 ASR 返回字幕" : "等待开始伴学"}
                    </p>
                  </div>
                </div>
              ) : (
                liveSubtitleSegments.map((segment) => (
                  <SubtitlePreview key={segment.segmentId} segment={segment} />
                ))
              )}
              <div className="subtitle-stream-end" ref={subtitleStreamEndRef} aria-hidden="true" />
            </section>

            {feedback ? (
              <p className={`feedback-toast ${audioErrored ? "feedback-toast--error" : ""}`}>
                {audioErrored ? <AlertCircle size={14} aria-hidden="true" /> : null}
                {feedback}
              </p>
            ) : null}
          </>
        ) : (
          <section className="panel-canvas glass-panel">
            {selectedTab === "history" ? (
              <HistoryPanel
                hasIdentity={panelDataIdentity !== null}
                sessions={historyState.data}
                loading={historyState.loading}
                error={historyState.error}
              />
            ) : null}
            {selectedTab === "usage" ? (
              <UsagePanel
                hasIdentity={panelDataIdentity !== null}
                usage={usageState.data}
                loading={usageState.loading}
                error={usageState.error}
              />
            ) : null}
            {selectedTab === "glossary" ? (
              <GlossaryPanel
                terms={glossaryState.data}
                loading={glossaryState.loading}
                error={glossaryState.error}
              />
            ) : null}
          </section>
        )}
      </div>

      {settingsOpen ? (
        <div className="settings-backdrop" onClick={() => setSettingsOpen(false)} />
      ) : null}

      <aside
        className={`settings-drawer ${settingsOpen ? "is-open" : ""}`}
        aria-label="Session settings"
        aria-hidden={!settingsOpen}
      >
        <header className="settings-drawer-header">
          <div>
            <span className="guide-eyebrow">Setup</span>
            <h2>{guideSummary.title}</h2>
            <p>{guideSummary.detail}</p>
          </div>
          <button
            type="button"
            className="nav-icon-btn"
            title="关闭设置"
            onClick={() => setSettingsOpen(false)}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="settings-drawer-body custom-scrollbar">
          <div className="setup-stack">
            <div className={`setup-row ${inviteActivated ? "setup-row--ready" : "setup-row--current"}`}>
              <div className="setup-row-title">
                <KeyRound size={16} aria-hidden="true" />
                <span>Alpha 邀请码</span>
              </div>
              <div className="invite-row">
                <input
                  value={inviteCode}
                  onChange={(event) => {
                    setInviteCode(event.target.value);
                    setInviteActivated(false);
                  }}
                  placeholder="INVITE-ALPHA"
                  aria-label="邀请码"
                />
                <button type="button" className="text-button" onClick={activateInvite}>
                  <CheckCircle2 size={14} aria-hidden="true" />
                  激活
                </button>
              </div>
            </div>

            <label
              className={`setup-row setup-row--check ${
                privacyAccepted ? "setup-row--ready" : inviteActivated ? "setup-row--current" : ""
              }`}
            >
              <input
                type="checkbox"
                checked={privacyAccepted}
                onChange={(event) => setPrivacyAccepted(event.target.checked)}
              />
              <span>
                <strong>允许上传系统音频与字幕落盘</strong>
                <small>
                  用于实时字幕、中文同传、会话复盘和删除会话时的对象存储清理；中文译音默认保存 30 天。
                </small>
              </span>
            </label>

            <div className="setup-row setup-row--ready">
              <div className="setup-row-title">
                <Volume2 size={16} aria-hidden="true" />
                <span>中文同传语音</span>
              </div>
              <div className="interpretation-status-row">
                <StatusPill
                  label={
                    sessionMode === "capturing"
                      ? activeInterpretationPolicy?.outputAudio === false
                        ? "仅中文字幕"
                        : interpretationAudioStatus.playedChunks > 0
                          ? "正在播放"
                          : "等待译音"
                      : previewInterpretationPolicy?.outputAudio === true
                        ? "可播放"
                        : "安全降级"
                  }
                  tone={
                    activeInterpretationPolicy?.echoRiskAccepted === true ||
                    previewInterpretationPolicy?.echoRiskAccepted === true
                      ? "warning"
                      : sessionMode === "capturing"
                        ? "active"
                        : "idle"
                  }
                />
                <span>
                  {sessionMode === "capturing" && activeInterpretationPolicy?.outputAudio !== false
                    ? formatInterpretationAudioStatus(interpretationAudioStatus)
                    : formatEchoAvoidanceStatus(
                        activeInterpretationPolicy ?? previewInterpretationPolicy,
                        audioCapabilities
                      )}
                </span>
              </div>
              <p className="muted-line">
                {formatEchoAvoidanceDetail(previewInterpretationPolicy, audioCapabilities)}
              </p>
              {previewInterpretationPolicy?.echoAvoidance !== "process_exclude" ? (
                <label className="risk-confirm-row">
                  <input
                    type="checkbox"
                    checked={echoRiskAccepted}
                    onChange={(event) => setEchoRiskAccepted(event.target.checked)}
                  />
                  <span>高级风险模式：允许播放译音并接受回灌、回声和额外用量风险</span>
                </label>
              ) : null}
            </div>

            <div
              className={`setup-row ${
                audioErrored
                  ? "setup-row--error"
                  : inviteActivated && privacyAccepted
                    ? "setup-row--ready"
                    : ""
              }`}
            >
              <div className="setup-row-title">
                <Headphones size={16} aria-hidden="true" />
                <span>系统音频输出</span>
              </div>
              <div className="device-row">
                <select
                  value={selectedDeviceId ?? ""}
                  onChange={(event) => setSelectedDeviceId(event.target.value || null)}
                  aria-label="系统音频输出设备"
                >
                  <option value="">Default Windows output</option>
                  {devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name}
                    </option>
                  ))}
                </select>
                <IconButton icon={RefreshCw} label="刷新音频设备" onClick={refreshDevices} />
              </div>
              <p className="muted-line">
                {activeDeviceName} · 16 kHz mono PCM16 · 20 ms frames
              </p>
            </div>
          </div>
        </div>

        <footer className="settings-drawer-footer">
          <div className="settings-drawer-meta">
            <strong>{sessionMode === "capturing" ? "真实链路运行中" : "准备连接 Gateway"}</strong>
            <span>
              {activeDeviceName} ·{" "}
              {formatEchoAvoidanceStatus(previewInterpretationPolicy, audioCapabilities)}
            </span>
          </div>
          <div className="transport-controls">
            <button
              type="button"
              className="action-button action-button--primary"
              disabled={!canStart}
              onClick={() => void handleStart()}
            >
              <CirclePlay size={16} aria-hidden="true" />
              Start
            </button>
            <button
              type="button"
              className="action-button"
              disabled={sessionMode !== "capturing" && sessionMode !== "paused"}
              onClick={handlePause}
            >
              <CirclePause size={16} aria-hidden="true" />
              {sessionMode === "paused" ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              className="action-button action-button--danger"
              disabled={sessionMode === "idle"}
              onClick={() => void handleStop()}
            >
              <CircleStop size={16} aria-hidden="true" />
              Stop
            </button>
          </div>
        </footer>
      </aside>
    </main>
  );
}

interface SetupStep {
  id: string;
  title: string;
  detail: string;
  icon: LucideIcon;
  state: SetupStepState;
}

function PipelineStrip({ steps }: { steps: SetupStep[] }): ReactElement {
  return (
    <div className="pipeline-strip" aria-label="启动步骤">
      {steps.map((step, index) => (
        <Fragment key={step.id}>
          {index > 0 ? <div className="pipeline-connector" aria-hidden="true" /> : null}
          <div className={`pipeline-pill pipeline-pill--${step.state}`}>
            <span className="pipeline-pill-index">{index + 1}</span>
            <span className="pipeline-pill-label">{step.title}</span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

interface GuideSummaryInput {
  inviteActivated: boolean;
  privacyAccepted: boolean;
  audioErrored: boolean;
  sessionMode: SessionMode;
}

interface GuideSummary {
  title: string;
  detail: string;
  statusLabel: string;
  statusTone: "idle" | "active" | "warning" | "error";
}

interface InterpretationStartPolicy {
  outputAudio: boolean;
  echoAvoidance: EchoAvoidance;
  echoRiskAccepted: boolean;
  captureMode: AudioCaptureMode;
  message: string;
}

function chooseInterpretationStartPolicy(
  capabilities: AudioCaptureCapabilities,
  echoRiskAccepted: boolean
): InterpretationStartPolicy {
  if (capabilities.processExcludeLoopback.supported) {
    return {
      outputAudio: true,
      echoAvoidance: "process_exclude",
      echoRiskAccepted: false,
      captureMode: "processExcludeLoopback",
      message: "已启用 process-exclude 回灌规避"
    };
  }

  if (echoRiskAccepted) {
    return {
      outputAudio: true,
      echoAvoidance: "disabled",
      echoRiskAccepted: true,
      captureMode: "endpointLoopback",
      message: "高级风险模式已启用，Gateway 将记录 echoRiskAccepted"
    };
  }

  return {
    outputAudio: false,
    echoAvoidance: "disabled",
    echoRiskAccepted: false,
    captureMode: "endpointLoopback",
    message: "当前系统不支持 process-exclude，已降级为仅中文字幕"
  };
}

function formatEchoAvoidanceStatus(
  policy: InterpretationStartPolicy | null,
  capabilities: AudioCaptureCapabilities | null
): string {
  if (capabilities === null || policy === null) {
    return "正在探测回灌规避能力";
  }

  if (policy.echoAvoidance === "process_exclude") {
    return `process-exclude 可用 · Windows build ${capabilities.windowsBuild ?? "unknown"}`;
  }

  if (policy.echoRiskAccepted) {
    return "风险模式 · echoAvoidance=disabled";
  }

  return `仅中文字幕 · ${formatCapabilityReason(capabilities.processExcludeLoopback.reason)}`;
}

function formatEchoAvoidanceDetail(
  policy: InterpretationStartPolicy | null,
  capabilities: AudioCaptureCapabilities | null
): string {
  if (capabilities === null || policy === null) {
    return "正在探测 Windows process-exclude loopback 能力。";
  }

  if (policy.echoAvoidance === "process_exclude") {
    return "同传将使用 process-exclude loopback 捕获系统原声，排除 LinguaBridge 当前进程树播放的中文译音。";
  }

  if (policy.echoRiskAccepted) {
    return "已显式接受风险：中文译音可能重新进入主链路，Gateway usage metadata 会记录 echoRiskAccepted=true。";
  }

  return "当前系统无法确认 process-exclude loopback，同传默认不播放中文译音，只保留中文字幕。";
}

function formatCapabilityReason(
  reason: AudioCaptureCapabilities["processExcludeLoopback"]["reason"]
): string {
  if (reason === "activation_failed") {
    return "process-exclude activation failed";
  }

  if (reason === "not_windows") {
    return "not Windows";
  }

  return "unsupported Windows build";
}

function getGuideSummary({
  inviteActivated,
  privacyAccepted,
  audioErrored,
  sessionMode
}: GuideSummaryInput): GuideSummary {
  if (sessionMode === "capturing") {
    return {
      title: "字幕链路正在运行",
      detail: "保持学习材料播放，LinguaBridge 会持续接收系统音频并刷新字幕。",
      statusLabel: "运行中",
      statusTone: "active"
    };
  }

  if (sessionMode === "paused") {
    return {
      title: "字幕流已暂停",
      detail: "恢复后会继续向 Gateway 发送系统音频帧。",
      statusLabel: "已暂停",
      statusTone: "warning"
    };
  }

  if (audioErrored) {
    return {
      title: "先处理音频设备",
      detail: "刷新设备或切换默认输出后，再重新开始真实链路。",
      statusLabel: "需处理",
      statusTone: "error"
    };
  }

  if (!inviteActivated) {
    return {
      title: "输入 Alpha 邀请码",
      detail: "先完成本地格式校验，正式激活会在开始会话时交给 Gateway。",
      statusLabel: "第 1 步",
      statusTone: "idle"
    };
  }

  if (!privacyAccepted) {
    return {
      title: "确认音频与字幕授权",
      detail: "真实测试会上传系统音频，并保存音频、字幕与修订记录用于会话复盘。",
      statusLabel: "第 2 步",
      statusTone: "warning"
    };
  }

  return {
    title: "可以开始真实测试",
    detail: "选择系统输出设备后点击开始，桌面端会持续推送 20 ms 音频帧给 Gateway。",
    statusLabel: "就绪",
    statusTone: "active"
  };
}

function getAudioFeedbackMessage(error: AudioCommandError): string {
  if (error.kind === "internal") {
    return getRuntimeFeedbackMessage(error.message);
  }

  return error.message;
}

function getRuntimeFeedbackMessage(message: string): string {
  if (message.includes("reading 'invoke'") || message.includes("window.__TAURI__")) {
    return "当前是浏览器预览环境，系统音频采集需要在 Tauri 桌面端中运行。";
  }

  return message;
}

function formatPanelError(error: unknown): string {
  return error instanceof Error ? error.message : "Gateway 数据请求失败。";
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function msToRoundedMinutes(valueMs: number): number {
  return Math.max(0, Math.round(valueMs / 60_000));
}

function formatMsAsMinutes(valueMs: number): string {
  return formatMinutes(msToRoundedMinutes(valueMs));
}

function formatStorage(storageBytes: number): string {
  if (storageBytes < 1024 * 1024) {
    return `${Math.round(storageBytes / 1024)} KB`;
  }

  return `${Math.round(storageBytes / (1024 * 1024))} MB`;
}

function formatTermDetail(entry: DesktopTermEntry): string {
  const details = [
    entry.domain,
    entry.kind,
    entry.aliases.length > 0 ? `aliases: ${entry.aliases.join(", ")}` : null,
    entry.priority !== undefined ? `priority: ${entry.priority}` : null
  ].filter((detail): detail is string => detail !== null && detail !== undefined);

  return details.length > 0 ? details.join(" · ") : entry.mode;
}

function getDefaultAudioDeviceId(devices: AudioDevice[]): string | null {
  return devices.find((device) => device.isDefault)?.id ?? devices[0]?.id ?? null;
}

function getInterpretationAudioPlayer(
  ref: MutableRefObject<InterpretationAudioPlayer | null>
): InterpretationAudioPlayer {
  if (ref.current === null) {
    ref.current = new InterpretationAudioPlayer();
  }

  return ref.current;
}

function formatInterpretationAudioStatus(
  status: InterpretationAudioPlayerSnapshot
): string {
  if (status.playedChunks === 0) {
    return "等待 Gateway 返回中文译音";
  }

  const latencyText =
    status.lastLatencyMs === null ? "延迟待测" : `最近延迟 ${status.lastLatencyMs} ms`;
  return `${status.playedChunks} 段译音 · 缓冲 ${status.bufferedMs} ms · ${latencyText}`;
}

function SubtitlePreview({ segment }: { segment: SubtitleSegmentEvent }): ReactElement {
  const isDraft = segment.status === "draft";
  const isRevised = segment.status === "revised";

  return (
    <article className={`glass-panel subtitle-card subtitle-card--${segment.status}`}>
      <div
        className={`subtitle-timeline-dot ${isDraft ? "pulse-indicator pulse-indicator--live" : ""}`}
        aria-hidden="true"
      />
      <div className="subtitle-card-header">
        <div className="subtitle-card-badges">
          <span className="subtitle-badge">
            {isDraft ? <span className="subtitle-badge-dot pulse-indicator pulse-indicator--live" /> : null}
            {segment.status.toUpperCase()}
          </span>
          {isRevised ? <Pencil size={14} aria-hidden="true" /> : null}
          <span className="subtitle-badge subtitle-badge--muted">
            {formatDurationRange(segment.startAtMs, segment.endAtMs)}
          </span>
        </div>
        <span className="subtitle-latency">{segment.latencyMs}ms</span>
      </div>
      <div className="subtitle-card-body">
        <p className="subtitle-source">{segment.sourceText}</p>
        <p className="subtitle-target">
          {segment.targetText}
          {isDraft ? <span className="blinking-cursor" aria-hidden="true" /> : null}
        </p>
      </div>
    </article>
  );
}

function upsertSubtitleSegment(
  segments: SubtitleSegmentEvent[],
  nextSegment: SubtitleSegmentEvent
): SubtitleSegmentEvent[] {
  const existingIndex = segments.findIndex(
    (segment) => segment.segmentId === nextSegment.segmentId
  );

  if (existingIndex === -1) {
    return [...segments, nextSegment].sort(sortSubtitleSegments);
  }

  const nextSegments = [...segments];
  nextSegments[existingIndex] = nextSegment;
  return nextSegments.sort(sortSubtitleSegments);
}

function sortSubtitleSegments(
  left: SubtitleSegmentEvent,
  right: SubtitleSegmentEvent
): number {
  return left.startAtMs - right.startAtMs;
}

interface HistoryPanelProps {
  hasIdentity: boolean;
  sessions: DesktopSessionSummary[];
  loading: boolean;
  error: string | null;
}

function HistoryPanel({
  hasIdentity,
  sessions,
  loading,
  error
}: HistoryPanelProps): ReactElement {
  return (
    <>
      <div className="section-heading">
        <History size={18} aria-hidden="true" />
        <h2>历史会话</h2>
      </div>
      {!hasIdentity ? (
        <PanelMessage title="等待真实身份" detail="激活邀请码或完成一次 Gateway 会话后，这里会显示历史会话。" />
      ) : loading ? (
        <PanelMessage title="正在加载" detail="正在从 Gateway 拉取历史会话。" />
      ) : error !== null ? (
        <PanelMessage title="加载失败" detail={error} />
      ) : sessions.length === 0 ? (
        <PanelMessage title="暂无历史会话" detail="该用户还没有保存过会话。" />
      ) : (
        <div className="table-list">
          {sessions.map((session) => (
            <article className="row-item" key={session.id}>
              <div>
                <strong>{session.deviceLabel ?? session.id}</strong>
                <span>
                  {session.sourceLang} {"->"} {session.targetLang} · {formatDateTime(session.startedAt)}
                </span>
              </div>
              <div className="row-stats">
                <span>{formatMsAsMinutes(session.durationMs)}</span>
                <span>{session.segmentCount} segments</span>
                <span>{formatStorage(session.storageBytes)}</span>
                <span>{session.status}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

interface UsagePanelProps {
  hasIdentity: boolean;
  usage: DesktopUsageSummary | null;
  loading: boolean;
  error: string | null;
}

function UsagePanel({
  hasIdentity,
  usage,
  loading,
  error
}: UsagePanelProps): ReactElement {
  const usedRealtimeMinutes = usage === null ? 0 : msToRoundedMinutes(usage.usedRealtimeMs);
  const usagePercent =
    usage === null
      ? "0%"
      : formatPercent(usage.usedRealtimeMs, usage.quotaMinutes * 60_000);

  return (
    <>
      <div className="section-heading">
        <Clock3 size={18} aria-hidden="true" />
        <h2>本月用量</h2>
      </div>
      {!hasIdentity ? (
        <PanelMessage title="等待真实身份" detail="激活邀请码或完成一次 Gateway 会话后，这里会显示用量。" />
      ) : loading ? (
        <PanelMessage title="正在加载" detail="正在从 Gateway 拉取用量统计。" />
      ) : error !== null ? (
        <PanelMessage title="加载失败" detail={error} />
      ) : usage === null ? (
        <PanelMessage title="暂无用量" detail="Gateway 暂未返回该用户的用量数据。" />
      ) : (
        <>
          <div className="metrics-grid">
            <MetricTile
              label="实时字幕"
              value={formatMinutes(usedRealtimeMinutes)}
              detail={`${formatMinutes(usage.remainingMinutes)} remaining`}
            />
            <MetricTile
              label="额度占用"
              value={usagePercent}
              detail={`${formatMinutes(usage.quotaMinutes)} alpha quota`}
            />
            <MetricTile
              label="翻译 token"
              value={(usage.mtInputTokens + usage.mtOutputTokens).toLocaleString("en-US")}
              detail={`${usage.revisionTokens.toLocaleString("en-US")} revision tokens`}
            />
            <MetricTile label="存储" value={formatStorage(usage.storageBytes)} detail="audio + transcript cache" />
          </div>
          <div className="usage-meter" aria-label={`本月额度已使用 ${usagePercent}`}>
            <span style={{ width: usagePercent }} />
          </div>
        </>
      )}
    </>
  );
}

interface GlossaryPanelProps {
  terms: DesktopTermEntry[];
  loading: boolean;
  error: string | null;
}

function GlossaryPanel({
  terms,
  loading,
  error
}: GlossaryPanelProps): ReactElement {
  return (
    <>
      <div className="section-heading">
        <ListChecks size={18} aria-hidden="true" />
        <h2>术语表入口</h2>
      </div>
      {loading ? (
        <PanelMessage title="正在加载" detail="正在从 Gateway 拉取术语表。" />
      ) : error !== null ? (
        <PanelMessage title="加载失败" detail={error} />
      ) : terms.length === 0 ? (
        <PanelMessage title="暂无术语" detail="该用户还没有配置术语。" />
      ) : (
        <div className="table-list">
          {terms.map((entry) => (
            <article className="row-item" key={entry.id}>
              <div>
                <strong>
                  {entry.source} {"->"} {entry.target ?? entry.source}
                </strong>
                <span>{formatTermDetail(entry)}</span>
              </div>
              <StatusPill
                label={entry.mode === "fixed_translation" ? "固定译法" : "保留原文"}
                tone="active"
              />
            </article>
          ))}
        </div>
      )}
      <button className="inline-command">
        <Database size={16} aria-hidden="true" />
        打开完整术语管理
      </button>
    </>
  );
}

function PanelMessage({ title, detail }: { title: string; detail: string }): ReactElement {
  return (
    <div className="table-list">
      <article className="row-item">
        <div>
          <strong>{title}</strong>
          <span>{detail}</span>
        </div>
      </article>
    </div>
  );
}
