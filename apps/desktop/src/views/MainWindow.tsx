import {
  BookOpenText,
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
  RefreshCw,
  SlidersHorizontal,
  TimerReset
} from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { IconButton } from "../components/IconButton";
import { MetricTile } from "../components/MetricTile";
import { StatusPill } from "../components/StatusPill";
import { glossaryEntries, historySessions, subtitleSegments, usageSummary } from "../data/mockData";
import { formatDurationRange, formatMinutes, formatPercent } from "../lib/format";
import {
  getAudioCaptureStatus,
  listenToAudioFrames,
  listAudioDevices,
  startAudioCapture,
  stopAudioCapture,
  toAudioCommandError
} from "../services/audioCommands";
import { RealtimeGatewayConnection } from "../services/realtimeGateway";
import type { AudioCaptureStatus, AudioDevice } from "../types/audio";
import type { SubtitleSegmentEvent } from "../types/protocol";

type MainTab = "history" | "usage" | "glossary";
type SessionMode = "idle" | "capturing" | "paused" | "error";

const invitePattern = /^[A-Z0-9-]{6,32}$/;

export function MainWindow(): ReactElement {
  const [inviteCode, setInviteCode] = useState("");
  const [inviteActivated, setInviteActivated] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [selectedTab, setSelectedTab] = useState<MainTab>("history");
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [captureStatus, setCaptureStatus] = useState<AudioCaptureStatus | null>(null);
  const [sessionMode, setSessionMode] = useState<SessionMode>("idle");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [liveSubtitleSegments, setLiveSubtitleSegments] =
    useState<SubtitleSegmentEvent[]>(subtitleSegments);
  const realtimeConnectionRef = useRef<RealtimeGatewayConnection | null>(null);
  const audioFrameUnlistenRef = useRef<(() => void) | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const audioSendingEnabledRef = useRef(false);

  const canStart =
    inviteActivated &&
    privacyAccepted &&
    sessionMode !== "capturing" &&
    sessionMode !== "paused";
  const activeDeviceName = useMemo(() => {
    if (selectedDeviceId === null) {
      return "Default Windows output";
    }

    return devices.find((device) => device.id === selectedDeviceId)?.name ?? "Selected output";
  }, [devices, selectedDeviceId]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateAudioState(): Promise<void> {
      try {
        const [nextDevices, nextStatus] = await Promise.all([
          listAudioDevices(),
          getAudioCaptureStatus()
        ]);

        if (cancelled) {
          return;
        }

        setDevices(nextDevices);
        setCaptureStatus(nextStatus);
        setSelectedDeviceId(nextDevices.find((device) => device.isDefault)?.id ?? null);
      } catch (error) {
        if (!cancelled) {
          const commandError = toAudioCommandError(error);
          setFeedback(commandError.message);
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
      void stopAudioCapture();
    };
  }, []);

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

    try {
      const connection = new RealtimeGatewayConnection({
        onSubtitle: (event) => {
          setLiveSubtitleSegments((currentSegments) =>
            upsertSubtitleSegment(currentSegments, event.payload)
          );
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
        deviceId: selectedDeviceId
      });
      activeSessionIdRef.current = started.sessionId;

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
        frameDurationMs: 20
      });

      audioSendingEnabledRef.current = true;
      setCaptureStatus(nextStatus);
      setSessionMode("capturing");
      setFeedback(`真实链路已启动：Gateway session ${started.sessionId}`);
    } catch (error) {
      await cleanupRealtimeSession("device_error");
      const commandError = toAudioCommandError(error);
      setFeedback(error instanceof Error ? error.message : commandError.message);
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
      setFeedback(commandError.message);
      setSessionMode(commandError.kind === "notCapturing" ? "idle" : "error");
    }
  }

  async function refreshDevices(): Promise<void> {
    try {
      const nextDevices = await listAudioDevices();
      setDevices(nextDevices);
      setFeedback("音频设备列表已刷新。");
    } catch (error) {
      const commandError = toAudioCommandError(error);
      setFeedback(commandError.message);
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
            <h1>实时字幕伴学</h1>
            <p>Windows 系统音频 {"->"} Realtime Gateway {"->"} 英文原文与中文字幕。</p>
          </div>
          <SessionStatus mode={sessionMode} captureStatus={captureStatus} />
        </header>

        <section className="control-grid" aria-label="Session controls">
          <div className="activation-panel">
            <div className="section-heading">
              <KeyRound size={18} aria-hidden="true" />
              <h2>Alpha 准入</h2>
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
                激活
              </button>
            </div>
            <label className="privacy-check">
              <input
                type="checkbox"
                checked={privacyAccepted}
                onChange={(event) => setPrivacyAccepted(event.target.checked)}
              />
              <span>
                我确认系统音频会上传到 LinguaBridge Realtime Gateway，并按 MVP 策略落盘用于字幕与后续复盘。
              </span>
            </label>
          </div>

          <div className="audio-panel">
            <div className="section-heading">
              <Headphones size={18} aria-hidden="true" />
              <h2>系统音频</h2>
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

          <div className="transport-panel">
            <div className="section-heading">
              <SlidersHorizontal size={18} aria-hidden="true" />
              <h2>伴学控制</h2>
            </div>
            <div className="transport-controls">
              <IconButton
                icon={CirclePlay}
                label="开始伴学"
                tone="primary"
                disabled={!canStart}
                onClick={() => void handleStart()}
              />
              <IconButton
                icon={CirclePause}
                label={sessionMode === "paused" ? "恢复伴学" : "暂停伴学"}
                disabled={sessionMode !== "capturing" && sessionMode !== "paused"}
                onClick={handlePause}
              />
              <IconButton
                icon={CircleStop}
                label="停止伴学"
                tone="danger"
                disabled={sessionMode === "idle"}
                onClick={() => void handleStop()}
              />
            </div>
            {feedback ? <p className="feedback-line">{feedback}</p> : null}
          </div>
        </section>

        <section className="live-strip" aria-label="Live subtitle preview">
          <div className="section-heading">
            <Languages size={18} aria-hidden="true" />
            <h2>实时字幕预览</h2>
          </div>
          <div className="subtitle-feed">
            {liveSubtitleSegments.map((segment) => (
              <SubtitlePreview key={segment.segmentId} segment={segment} />
            ))}
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
