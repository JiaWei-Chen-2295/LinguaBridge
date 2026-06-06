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
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  TimerReset,
  Volume2
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MutableRefObject, ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { IconButton } from "../components/IconButton";
import { MetricTile } from "../components/MetricTile";
import { StatusPill } from "../components/StatusPill";
import { glossaryEntries, historySessions, usageSummary } from "../data/mockData";
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
  hideOverlayWindow,
  isOverlayWindowVisible,
  showOverlayWindow
} from "../services/overlayWindow";
import { publishOverlaySubtitles } from "../services/overlaySubtitle";
import {
  InterpretationAudioPlayer,
  type InterpretationAudioPlayerSnapshot
} from "../services/interpretationAudioPlayer";
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

type MainTab = "history" | "usage" | "glossary";
type SessionMode = "idle" | "capturing" | "paused" | "error";
type SetupStepState = "waiting" | "current" | "complete" | "active" | "error";
type EchoAvoidance = InterpretationOptions["echoAvoidance"];

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
  const [selectedTab, setSelectedTab] = useState<MainTab>("history");
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
  const realtimeConnectionRef = useRef<RealtimeGatewayConnection | null>(null);
  const audioFrameUnlistenRef = useRef<(() => void) | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const audioSendingEnabledRef = useRef(false);
  const interpretationAudioPlayerRef = useRef<InterpretationAudioPlayer | null>(null);

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
    void publishOverlaySubtitles(liveSubtitleSegments).catch(() => undefined);
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
      if (overlayVisible) {
        await hideOverlayWindow();
        setOverlayVisible(false);
        setFeedback("悬浮字幕窗已隐藏，可在主界面重新打开。");
        return;
      }

      await showOverlayWindow();
      setOverlayVisible(true);
      setFeedback("悬浮字幕窗已显示。");
    } catch (error) {
      const commandError = toAudioCommandError(error);
      setFeedback(
        error instanceof Error
          ? getRuntimeFeedbackMessage(error.message)
          : getAudioFeedbackMessage(commandError)
      );
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

  return (
    <main className="app-shell">
      <aside className="side-rail" aria-label="LinguaBridge sections">
        <div className="brand-lockup">
          <div className="brand-mark">LB</div>
          <div>
            <strong>LinguaBridge</strong>
            <span>Alpha client</span>
          </div>
        </div>

        <nav className="rail-nav" aria-label="Main">
          <button
            className={selectedTab === "history" ? "is-selected" : ""}
            onClick={() => setSelectedTab("history")}
          >
            <History size={18} aria-hidden="true" />
            历史
          </button>
          <button
            className={selectedTab === "usage" ? "is-selected" : ""}
            onClick={() => setSelectedTab("usage")}
          >
            <TimerReset size={18} aria-hidden="true" />
            用量
          </button>
          <button
            className={selectedTab === "glossary" ? "is-selected" : ""}
            onClick={() => setSelectedTab("glossary")}
          >
            <BookOpenText size={18} aria-hidden="true" />
            术语表
          </button>
        </nav>
      </aside>

      <section className="main-workspace">
        <header className="workspace-header">
          <div>
            <h1>实时字幕与中文同传</h1>
            <p>按顺序完成准入、授权和音频源设置，即可把 Windows 系统声音推给 Gateway 并播放中文译音。</p>
          </div>
          <div className="workspace-header-actions">
            <button className="action-button" onClick={() => void toggleOverlayWindow()}>
              <MonitorUp size={18} aria-hidden="true" />
              {overlayVisible ? "隐藏悬浮窗" : "打开悬浮窗"}
            </button>
            <SessionStatus mode={sessionMode} captureStatus={captureStatus} />
          </div>
        </header>

        <section className="session-guide" aria-label="Session controls">
          <div className="guide-steps" aria-label="启动步骤">
            {setupSteps.map((step) => (
              <GuideStep key={step.id} step={step} />
            ))}
          </div>

          <div className="guide-detail">
            <div className="guide-header">
              <div>
                <span className="guide-eyebrow">当前步骤</span>
                <h2>{guideSummary.title}</h2>
                <p>{guideSummary.detail}</p>
              </div>
              <StatusPill label={guideSummary.statusLabel} tone={guideSummary.statusTone} />
            </div>

            <div className="setup-stack">
              <div className={`setup-row ${inviteActivated ? "setup-row--ready" : "setup-row--current"}`}>
                <div className="setup-row-title">
                  <KeyRound size={18} aria-hidden="true" />
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
                  <button className="text-button" onClick={activateInvite}>
                    <CheckCircle2 size={16} aria-hidden="true" />
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
                  <small>用于实时字幕、中文同传、会话复盘和删除会话时的对象存储清理；中文译音默认保存 30 天。</small>
                </span>
              </label>

              <div className="setup-row setup-row--ready">
                <div className="setup-row-title">
                  <Volume2 size={18} aria-hidden="true" />
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
                  <Headphones size={18} aria-hidden="true" />
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

            <div className="primary-action-bar">
              <div className="action-context">
                <SlidersHorizontal size={18} aria-hidden="true" />
                <div>
                  <strong>{sessionMode === "capturing" ? "真实链路运行中" : "准备连接 Gateway"}</strong>
                  <span>{activeDeviceName} · {formatEchoAvoidanceStatus(previewInterpretationPolicy, audioCapabilities)}</span>
                </div>
              </div>
              <div className="transport-controls">
                <button
                  className="action-button action-button--primary"
                  disabled={!canStart}
                  onClick={() => void handleStart()}
                >
                  <CirclePlay size={18} aria-hidden="true" />
                  开始
                </button>
                <button
                  className="action-button"
                  disabled={sessionMode !== "capturing" && sessionMode !== "paused"}
                  onClick={handlePause}
                >
                  <CirclePause size={18} aria-hidden="true" />
                  {sessionMode === "paused" ? "恢复" : "暂停"}
                </button>
                <button
                  className="action-button action-button--danger"
                  disabled={sessionMode === "idle"}
                  onClick={() => void handleStop()}
                >
                  <CircleStop size={18} aria-hidden="true" />
                  停止
                </button>
              </div>
            </div>

            {feedback ? (
              <p className={`feedback-line ${audioErrored ? "feedback-line--error" : ""}`}>
                {audioErrored ? <AlertCircle size={15} aria-hidden="true" /> : null}
                {feedback}
              </p>
            ) : null}
          </div>
        </section>

        <section className="live-strip" aria-label="Live subtitle preview">
          <div className="section-heading">
            <Languages size={18} aria-hidden="true" />
            <h2>实时字幕预览</h2>
          </div>
          <div className="subtitle-feed">
            {liveSubtitleSegments.length === 0 ? (
              <div className="subtitle-empty">
                <Languages size={20} aria-hidden="true" />
                <div>
                  <strong>{sessionMode === "capturing" ? "正在等待 ASR 返回字幕" : "等待开始伴学"}</strong>
                  <span>
                    {sessionMode === "capturing"
                      ? "音频帧已开始推送，收到 Gateway 字幕和中文译音事件后会在这里更新。"
                      : "完成上方步骤并点击开始后，这里只显示真实会话字幕。"}
                  </span>
                </div>
              </div>
            ) : (
              liveSubtitleSegments.map((segment) => (
                <SubtitlePreview key={segment.segmentId} segment={segment} />
              ))
            )}
          </div>
        </section>

        <section className="tab-surface">
          {selectedTab === "history" ? <HistoryPanel /> : null}
          {selectedTab === "usage" ? <UsagePanel /> : null}
          {selectedTab === "glossary" ? <GlossaryPanel /> : null}
        </section>
      </section>
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

interface SessionStatusProps {
  mode: SessionMode;
  captureStatus: AudioCaptureStatus | null;
}

function SessionStatus({ mode, captureStatus }: SessionStatusProps): ReactElement {
  if (mode === "capturing") {
    return <StatusPill label="正在听" tone="active" />;
  }

  if (mode === "paused") {
    return <StatusPill label="已暂停" tone="warning" />;
  }

  if (mode === "error" || captureStatus?.state === "error") {
    return <StatusPill label="音频待接入" tone="error" />;
  }

  return <StatusPill label="待开始" tone="idle" />;
}

function GuideStep({ step }: { step: SetupStep }): ReactElement {
  const Icon = step.icon;

  return (
    <div className={`guide-step guide-step--${step.state}`}>
      <div className="guide-step-icon">
        {step.state === "complete" ? (
          <CheckCircle2 size={18} aria-hidden="true" />
        ) : step.state === "error" ? (
          <AlertCircle size={18} aria-hidden="true" />
        ) : (
          <Icon size={18} aria-hidden="true" />
        )}
      </div>
      <div>
        <strong>{step.title}</strong>
        <span>{step.detail}</span>
      </div>
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
  return (
    <article className={`subtitle-preview subtitle-preview--${segment.status}`}>
      <div className="subtitle-meta">
        <span>{formatDurationRange(segment.startAtMs, segment.endAtMs)}</span>
        <span>{segment.status}</span>
        <span>{segment.latencyMs} ms</span>
      </div>
      <p className="target-line">{segment.targetText}</p>
      <p className="source-line">{segment.sourceText}</p>
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

function HistoryPanel(): ReactElement {
  return (
    <>
      <div className="section-heading">
        <History size={18} aria-hidden="true" />
        <h2>历史会话</h2>
      </div>
      <div className="table-list">
        {historySessions.map((session) => (
          <article className="row-item" key={session.id}>
            <div>
              <strong>{session.title}</strong>
              <span>
                {session.source} · {session.startedAt}
              </span>
            </div>
            <div className="row-stats">
              <span>{formatMinutes(session.durationMinutes)}</span>
              <span>{session.segmentCount} segments</span>
              <span>{session.storageMb} MB</span>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function UsagePanel(): ReactElement {
  const remainingMinutes = usageSummary.quotaMinutes - usageSummary.usedMinutes;
  const usagePercent = formatPercent(usageSummary.usedMinutes, usageSummary.quotaMinutes);

  return (
    <>
      <div className="section-heading">
        <Clock3 size={18} aria-hidden="true" />
        <h2>本月用量</h2>
      </div>
      <div className="metrics-grid">
        <MetricTile
          label="实时字幕"
          value={formatMinutes(usageSummary.usedMinutes)}
          detail={`${formatMinutes(remainingMinutes)} remaining`}
        />
        <MetricTile
          label="额度占用"
          value={formatPercent(usageSummary.usedMinutes, usageSummary.quotaMinutes)}
          detail={`${usageSummary.month} alpha quota`}
        />
        <MetricTile
          label="翻译 token"
          value={usageSummary.translatedTokens.toLocaleString("en-US")}
          detail={`${usageSummary.revisionTokens.toLocaleString("en-US")} revision tokens`}
        />
        <MetricTile label="存储" value={`${usageSummary.storageMb} MB`} detail="audio + transcript cache" />
      </div>
      <div className="usage-meter" aria-label={`本月额度已使用 ${usagePercent}`}>
        <span style={{ width: usagePercent }} />
      </div>
    </>
  );
}

function GlossaryPanel(): ReactElement {
  return (
    <>
      <div className="section-heading">
        <ListChecks size={18} aria-hidden="true" />
        <h2>术语表入口</h2>
      </div>
      <div className="table-list">
        {glossaryEntries.map((entry) => (
          <article className="row-item" key={entry.id}>
            <div>
              <strong>
                {entry.sourceTerm} {"->"} {entry.targetTerm}
              </strong>
              <span>{entry.note}</span>
            </div>
            <StatusPill label={entry.enabled ? "启用" : "停用"} tone={entry.enabled ? "active" : "idle"} />
          </article>
        ))}
      </div>
      <button className="inline-command">
        <Database size={16} aria-hidden="true" />
        打开完整术语管理
      </button>
    </>
  );
}
