import { estimateTranslationTokens } from "@lingua-bridge/mock-models";
import type {
  ModelTrace,
  RealtimeAudioFrameMessage,
  SubtitleSegment,
  SubtitleSegmentUpdatedEvent,
  TermEntry
} from "@lingua-bridge/protocol";
import type { FastifyBaseLogger } from "fastify";
import {
  applyTermPolicy,
  buildTermPrompt,
  findTermMatches,
  mergeTermEntries
} from "./terms";

export type RealtimeAudioFramePayload = RealtimeAudioFrameMessage["payload"];

export interface AsrTextEvent {
  itemId?: string;
  sourceText: string;
  startAtMs: number;
  endAtMs: number;
  confidence: number;
}

export interface RealtimeAsrProvider {
  start(callbacks: RealtimeAsrProviderCallbacks): Promise<void>;
  appendAudioFrame(frame: RealtimeAudioFramePayload): Promise<void>;
  stop(): Promise<void>;
}

export interface RealtimeAsrProviderCallbacks {
  onPartial(event: AsrTextEvent): Promise<void>;
  onFinal(event: AsrTextEvent): Promise<void>;
  onError(error: SubtitleProviderError): void;
}

export interface SubtitleProviderError {
  message: string;
  nextStep: string;
  cause?: unknown;
}

export interface TextModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface TextModelResult {
  text: string;
  usage?: TextModelUsage;
}

export interface TranslateInput {
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  glossary: string;
}

export interface RevisionSegmentInput {
  segmentId: string;
  sourceText: string;
  targetText: string;
  status: "final" | "revised";
  revision: number;
}

export interface ReviseContextInput {
  sourceLang: string;
  targetLang: string;
  glossary: string;
  contextSegments: RevisionSegmentInput[];
  targetSegmentIds: string[];
}

export interface SegmentRevisionResult {
  segmentId: string;
  targetText: string;
}

export interface RevisionModelResult {
  segments: SegmentRevisionResult[];
  usage?: TextModelUsage;
}

export interface SubtitleTextProvider {
  translate(input: TranslateInput): Promise<TextModelResult>;
  revise(input: ReviseContextInput): Promise<RevisionModelResult>;
  modelTrace(kind: "translation" | "revision"): ModelTrace;
}

export type RealtimeModelUsageEvent =
  | {
      eventType: "mt_input_tokens" | "mt_output_tokens";
      amount: number;
      unit: "tokens";
      model: string;
      metadata: Record<string, string | number | boolean>;
    }
  | {
      eventType: "revision_tokens";
      amount: number;
      unit: "tokens";
      model: string;
      metadata: Record<string, string | number | boolean>;
    };

export interface SubtitleEngineContext {
  sessionId: string;
  sourceLang: string;
  targetLang: string;
}

export interface SubtitleEngineCallbacks {
  onSubtitleEvent(event: SubtitleSegmentUpdatedEvent): Promise<void>;
  onUsageEvent(event: RealtimeModelUsageEvent): void;
  onProviderError(error: SubtitleProviderError): void;
}

export interface SubtitleEngineInput {
  context: SubtitleEngineContext;
  asrProvider: RealtimeAsrProvider;
  textProvider: SubtitleTextProvider;
  callbacks: SubtitleEngineCallbacks;
  termEntries: TermEntry[];
  translateDrafts: boolean;
  revisionIntervalMs: number;
  log: FastifyBaseLogger;
}

interface SegmentState {
  segmentId: string;
  itemId?: string;
  status: "draft" | "final" | "revised";
  sourceText: string;
  targetText: string;
  startAtMs: number;
  endAtMs: number;
  revision: number;
  confidence: number;
  termsHit: string[];
  latencyMs: number;
  modelTrace: ModelTrace;
}

export class SubtitleEngine {
  private readonly termEntries: TermEntry[];
  private readonly segments = new Map<string, SegmentState>();
  private readonly itemSegments = new Map<string, string>();
  private readonly pendingTasks = new Set<Promise<void>>();
  private readonly startedAtMs = Date.now();
  private eventQueue: Promise<void> = Promise.resolve();
  private revisionQueue: Promise<void> = Promise.resolve();
  private revisionTimer: ReturnType<typeof setInterval> | undefined;
  private lastRevisionSignature: string | undefined;
  private generatedSegmentIndex = 0;
  private stopped = false;

  public constructor(private readonly input: SubtitleEngineInput) {
    this.termEntries = mergeTermEntries(input.termEntries);
  }

  public async start(): Promise<void> {
    this.revisionTimer = setInterval(() => {
      this.queueRevision("timer");
    }, clampRevisionInterval(this.input.revisionIntervalMs));

    await this.input.asrProvider.start({
      onPartial: (event) => this.enqueueAsrEvent(() => this.handlePartial(event)),
      onFinal: (event) => this.enqueueAsrEvent(() => this.handleFinal(event)),
      onError: (error) => this.input.callbacks.onProviderError(error)
    });
  }

  public appendAudioFrame(frame: RealtimeAudioFramePayload): Promise<void> {
    return this.input.asrProvider.appendAudioFrame(frame);
  }

  public async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.revisionTimer !== undefined) {
      clearInterval(this.revisionTimer);
      this.revisionTimer = undefined;
    }

    await this.input.asrProvider.stop();
    await this.eventQueue;
    await this.revisionQueue;
    this.stopped = true;
    await this.runContextRevision("stop");
    await Promise.allSettled(Array.from(this.pendingTasks));
  }

  private enqueueAsrEvent(handler: () => Promise<void>): Promise<void> {
    this.eventQueue = this.eventQueue.then(handler).catch((error: unknown) => {
      this.input.callbacks.onProviderError({
        message: "Subtitle Engine could not handle an ASR event.",
        nextStep: "Check the gateway logs and retry the realtime session.",
        cause: error
      });
    });

    return this.eventQueue;
  }

  private async handlePartial(event: AsrTextEvent): Promise<void> {
    if (!this.input.translateDrafts || this.stopped) {
      return;
    }

    const sourceText = event.sourceText.trim();
    if (sourceText.length === 0 || !shouldTranslateDraft(sourceText, event)) {
      return;
    }

    const segment = this.getOrCreateSegment(event);
    if (
      segment.status !== "draft" ||
      segment.sourceText === sourceText ||
      sourceText.length < segment.sourceText.length
    ) {
      return;
    }

    const result = await this.input.textProvider.translate({
      sourceText,
      sourceLang: this.input.context.sourceLang,
      targetLang: this.input.context.targetLang,
      glossary: this.glossaryFor(sourceText)
    });
    this.recordTranslationUsage(result, sourceText, "draft");

    await this.updateSegmentFromTranslation(event, result.text, "draft", result.usage);
  }

  private async handleFinal(event: AsrTextEvent): Promise<void> {
    if (this.stopped) {
      return;
    }

    const sourceText = event.sourceText.trim();
    if (sourceText.length === 0) {
      return;
    }

    const result = await this.input.textProvider.translate({
      sourceText,
      sourceLang: this.input.context.sourceLang,
      targetLang: this.input.context.targetLang,
      glossary: this.glossaryFor(sourceText)
    });
    this.recordTranslationUsage(result, sourceText, "final");

    await this.updateSegmentFromTranslation(event, result.text, "final", result.usage);
  }

  private async updateSegmentFromTranslation(
    event: AsrTextEvent,
    rawTargetText: string,
    status: "draft" | "final",
    _usage: TextModelUsage | undefined
  ): Promise<void> {
    const segment = this.getOrCreateSegment(event);
    const sourceText = event.sourceText.trim();
    const constrained = applyTermPolicy(
      sourceText,
      rawTargetText,
      this.termEntries
    );

    const nextRevision =
      status === "draft" || segment.status === "draft"
        ? 1
        : Math.max(1, segment.revision);
    const nextState: SegmentState = {
      segmentId: segment.segmentId,
      status,
      sourceText,
      targetText: constrained.targetText,
      startAtMs: Math.max(0, event.startAtMs),
      endAtMs: Math.max(event.startAtMs + 1, event.endAtMs),
      revision: nextRevision,
      confidence: event.confidence,
      termsHit: constrained.termsHit,
      latencyMs: this.latencyFor(event.endAtMs),
      modelTrace: this.input.textProvider.modelTrace("translation")
    };
    if (segment.itemId !== undefined) {
      nextState.itemId = segment.itemId;
    }

    this.segments.set(nextState.segmentId, nextState);
    await this.emitSegment(nextState);
  }

  private queueRevision(reason: "timer" | "final" | "stop"): void {
    if (this.stopped && reason !== "stop") {
      return;
    }

    this.revisionQueue = this.revisionQueue
      .then(() => this.runContextRevision(reason))
      .catch((error: unknown) => {
        this.input.callbacks.onProviderError({
          message: "Subtitle Engine context revision failed.",
          nextStep: "Check Qwen revision model configuration and retry the session.",
          cause: error
        });
      });
    this.trackPending(this.revisionQueue);
  }

  private async runContextRevision(
    reason: "timer" | "final" | "stop"
  ): Promise<void> {
    const contextSegments = this.revisionContext();
    if (contextSegments.length < 2) {
      return;
    }

    const targetSegmentIds = contextSegments
      .slice(-2)
      .map((segment) => segment.segmentId);
    const signature = revisionSignature(contextSegments, targetSegmentIds);
    if (signature === this.lastRevisionSignature) {
      return;
    }

    const result = await this.input.textProvider.revise({
      sourceLang: this.input.context.sourceLang,
      targetLang: this.input.context.targetLang,
      glossary: buildTermPrompt(
        findTermMatches(
          contextSegments.map((segment) => segment.sourceText).join("\n"),
          this.termEntries
        )
      ),
      contextSegments,
      targetSegmentIds
    });

    this.lastRevisionSignature = signature;
    this.recordRevisionUsage(result, contextSegments, targetSegmentIds, reason);
    for (const revised of result.segments) {
      if (!targetSegmentIds.includes(revised.segmentId)) {
        continue;
      }

      const existing = this.segments.get(revised.segmentId);
      if (existing === undefined) {
        continue;
      }

      const constrained = applyTermPolicy(
        existing.sourceText,
        revised.targetText,
        this.termEntries
      );
      if (
        existing.status === "revised" &&
        existing.targetText === constrained.targetText
      ) {
        continue;
      }

      const nextState: SegmentState = {
        ...existing,
        status: "revised",
        targetText: constrained.targetText,
        revision: existing.revision + 1,
        termsHit: constrained.termsHit,
        latencyMs: this.latencyFor(existing.endAtMs),
        modelTrace: this.input.textProvider.modelTrace("revision")
      };
      this.segments.set(nextState.segmentId, nextState);
      await this.emitSegment(nextState);
    }
  }

  private revisionContext(): RevisionSegmentInput[] {
    return Array.from(this.segments.values())
      .filter(
        (segment): segment is SegmentState & { status: "final" | "revised" } =>
          segment.status === "final" || segment.status === "revised"
      )
      .sort((left, right) => left.startAtMs - right.startAtMs)
      .slice(-4)
      .map((segment) => ({
        segmentId: segment.segmentId,
        sourceText: segment.sourceText,
        targetText: segment.targetText,
        status: segment.status,
        revision: segment.revision
      }));
  }

  private getOrCreateSegment(event: AsrTextEvent): SegmentState {
    const segmentId = this.resolveSegmentId(event.itemId);
    const existing = this.segments.get(segmentId);
    if (existing !== undefined) {
      return existing;
    }

    const segment: SegmentState = {
      segmentId,
      status: "draft",
      sourceText: "",
      targetText: "",
      startAtMs: Math.max(0, event.startAtMs),
      endAtMs: Math.max(event.startAtMs + 1, event.endAtMs),
      revision: 1,
      confidence: event.confidence,
      termsHit: [],
      latencyMs: this.latencyFor(event.endAtMs),
      modelTrace: this.input.textProvider.modelTrace("translation")
    };
    if (event.itemId !== undefined) {
      segment.itemId = event.itemId;
    }
    this.segments.set(segmentId, segment);
    return segment;
  }

  private resolveSegmentId(itemId: string | undefined): string {
    if (itemId === undefined) {
      this.generatedSegmentIndex += 1;
      return `seg_generated_${String(this.generatedSegmentIndex).padStart(4, "0")}`;
    }

    const existing = this.itemSegments.get(itemId);
    if (existing !== undefined) {
      return existing;
    }

    const segmentId = `seg_${itemId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 72)}`;
    this.itemSegments.set(itemId, segmentId);
    return segmentId;
  }

  private async emitSegment(segment: SegmentState): Promise<void> {
    const payload: SubtitleSegment = {
      sessionId: this.input.context.sessionId,
      segmentId: segment.segmentId,
      status: segment.status,
      sourceText: segment.sourceText,
      targetText: segment.targetText,
      startAtMs: segment.startAtMs,
      endAtMs: segment.endAtMs,
      revision: segment.revision,
      confidence: segment.confidence,
      termsHit: [...segment.termsHit],
      latencyMs: segment.latencyMs,
      modelTrace: segment.modelTrace
    };
    const event: SubtitleSegmentUpdatedEvent = {
      type: "subtitle.segment.updated",
      version: 1,
      payload
    };
    await this.input.callbacks.onSubtitleEvent(event);
  }

  private recordTranslationUsage(
    result: TextModelResult,
    sourceText: string,
    status: "draft" | "final"
  ): void {
    const inputTokens =
      result.usage?.inputTokens ?? estimateTranslationTokens(sourceText);
    const outputTokens =
      result.usage?.outputTokens ?? estimateTranslationTokens(result.text);
    const trace = this.input.textProvider.modelTrace("translation");
    this.input.callbacks.onUsageEvent({
      eventType: "mt_input_tokens",
      amount: inputTokens,
      unit: "tokens",
      model: trace.mtModel,
      metadata: { status }
    });
    this.input.callbacks.onUsageEvent({
      eventType: "mt_output_tokens",
      amount: outputTokens,
      unit: "tokens",
      model: trace.mtModel,
      metadata: { status }
    });
  }

  private recordRevisionUsage(
    result: RevisionModelResult,
    contextSegments: RevisionSegmentInput[],
    targetSegmentIds: string[],
    reason: "timer" | "final" | "stop"
  ): void {
    const trace = this.input.textProvider.modelTrace("revision");
    const tokenFallback = estimateTranslationTokens(
      contextSegments
        .map((segment) => `${segment.sourceText}\n${segment.targetText}`)
        .join("\n")
    );
    this.input.callbacks.onUsageEvent({
      eventType: "revision_tokens",
      amount: result.usage?.totalTokens ?? tokenFallback,
      unit: "tokens",
      model: trace.correctionModel ?? trace.mtModel,
      metadata: {
        reason,
        contextSegments: contextSegments.length,
        targetSegments: targetSegmentIds.length
      }
    });
  }

  private glossaryFor(sourceText: string): string {
    return buildTermPrompt(findTermMatches(sourceText, this.termEntries));
  }

  private latencyFor(endAtMs: number): number {
    return Math.max(0, Date.now() - this.startedAtMs - endAtMs);
  }

  private trackPending(promise: Promise<void>): void {
    this.pendingTasks.add(promise);
    promise.finally(() => {
      this.pendingTasks.delete(promise);
    });
  }
}

function shouldTranslateDraft(sourceText: string, event: AsrTextEvent): boolean {
  if (/[.!?。！？]$/u.test(sourceText.trim())) {
    return true;
  }

  return sourceText.length >= 24 && event.endAtMs - event.startAtMs >= 1_200;
}

function revisionSignature(
  contextSegments: RevisionSegmentInput[],
  targetSegmentIds: string[]
): string {
  return JSON.stringify({
    context: contextSegments.map((segment) => [
      segment.segmentId,
      segment.revision,
      segment.sourceText,
      segment.targetText
    ]),
    targets: targetSegmentIds
  });
}

function clampRevisionInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return 20_000;
  }

  return Math.max(15_000, Math.min(30_000, Math.round(value)));
}
