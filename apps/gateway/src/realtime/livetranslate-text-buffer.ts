export type LiveTranslateTextKind = "source" | "target";
export type LiveTranslateTextPhase = "draft" | "completed";
export type LiveTranslateBufferedStatus = "draft" | "final";

export interface LiveTranslateTextUpdate {
  itemId?: string;
  kind: LiveTranslateTextKind;
  phase: LiveTranslateTextPhase;
  text: string;
  receivedAtMs: number;
}

export interface LiveTranslateBufferedSegment {
  itemId: string;
  sourceText: string;
  targetText: string;
  sourceCompleted: boolean;
  targetCompleted: boolean;
  status: LiveTranslateBufferedStatus;
  revision: number;
  lastUpdatedAtMs: number;
  changed: boolean;
  shortTextIgnored: boolean;
}

interface MutableLiveTranslateBufferedSegment {
  itemId: string;
  sourceText: string;
  targetText: string;
  sourceCompleted: boolean;
  targetCompleted: boolean;
  revision: number;
  lastUpdatedAtMs: number;
}

interface MergeTextResult {
  text: string;
  shortTextIgnored: boolean;
}

const MIN_STREAMING_TEXT_OVERLAP_LENGTH = 2;

export class LiveTranslateTextBuffer {
  private readonly segments = new Map<
    string,
    MutableLiveTranslateBufferedSegment
  >();
  private generatedItemIndex = 0;
  private lastItemId: string | undefined;

  public apply(
    update: LiveTranslateTextUpdate
  ): LiveTranslateBufferedSegment | undefined {
    const incomingText = normalizeText(update.text);
    if (incomingText.length === 0 && update.phase !== "completed") {
      return undefined;
    }

    const itemId = this.resolveItemId(update.itemId);
    this.lastItemId = itemId;

    const segment = this.segmentFor(itemId, update.receivedAtMs);
    const currentText =
      update.kind === "source" ? segment.sourceText : segment.targetText;
    const merged =
      incomingText.length === 0
        ? { text: currentText, shortTextIgnored: false }
        : mergeStreamingText(
            currentText,
            incomingText,
            update.phase === "completed"
          );
    const textChanged = merged.text !== currentText;

    if (textChanged) {
      if (update.kind === "source") {
        segment.sourceText = merged.text;
      } else {
        segment.targetText = merged.text;
      }
    }

    const completionChanged = this.applyCompletion(segment, update);
    if (textChanged || completionChanged) {
      segment.revision += 1;
      segment.lastUpdatedAtMs = update.receivedAtMs;
    }

    return snapshotSegment(
      segment,
      textChanged || completionChanged,
      merged.shortTextIgnored
    );
  }

  private resolveItemId(itemId: string | undefined): string {
    if (itemId !== undefined && itemId.length > 0) {
      return itemId;
    }

    if (this.lastItemId !== undefined) {
      const lastSegment = this.segments.get(this.lastItemId);
      if (
        lastSegment !== undefined &&
        !(lastSegment.sourceCompleted && lastSegment.targetCompleted)
      ) {
        return this.lastItemId;
      }
    }

    this.generatedItemIndex += 1;
    return `lt_generated_${String(this.generatedItemIndex).padStart(4, "0")}`;
  }

  private segmentFor(
    itemId: string,
    receivedAtMs: number
  ): MutableLiveTranslateBufferedSegment {
    const existing = this.segments.get(itemId);
    if (existing !== undefined) {
      return existing;
    }

    const segment: MutableLiveTranslateBufferedSegment = {
      itemId,
      sourceText: "",
      targetText: "",
      sourceCompleted: false,
      targetCompleted: false,
      revision: 0,
      lastUpdatedAtMs: receivedAtMs
    };
    this.segments.set(itemId, segment);
    return segment;
  }

  private applyCompletion(
    segment: MutableLiveTranslateBufferedSegment,
    update: LiveTranslateTextUpdate
  ): boolean {
    if (update.phase !== "completed") {
      return false;
    }

    if (update.kind === "source" && !segment.sourceCompleted) {
      segment.sourceCompleted = true;
      return true;
    }

    if (update.kind === "target" && !segment.targetCompleted) {
      segment.targetCompleted = true;
      return true;
    }

    return false;
  }
}

function snapshotSegment(
  segment: MutableLiveTranslateBufferedSegment,
  changed: boolean,
  shortTextIgnored: boolean
): LiveTranslateBufferedSegment {
  return {
    itemId: segment.itemId,
    sourceText: segment.sourceText,
    targetText: segment.targetText,
    sourceCompleted: segment.sourceCompleted,
    targetCompleted: segment.targetCompleted,
    status:
      segment.sourceCompleted && segment.targetCompleted ? "final" : "draft",
    revision: segment.revision,
    lastUpdatedAtMs: segment.lastUpdatedAtMs,
    changed,
    shortTextIgnored
  };
}

function mergeStreamingText(
  previousText: string,
  incomingText: string,
  completed: boolean
): MergeTextResult {
  if (previousText.length === 0) {
    return { text: incomingText, shortTextIgnored: false };
  }

  if (incomingText === previousText) {
    return { text: previousText, shortTextIgnored: false };
  }

  if (completed) {
    return { text: incomingText, shortTextIgnored: false };
  }

  if (incomingText.startsWith(previousText)) {
    return { text: incomingText, shortTextIgnored: false };
  }

  const overlapLength = suffixPrefixOverlapLength(previousText, incomingText);
  if (overlapLength >= MIN_STREAMING_TEXT_OVERLAP_LENGTH) {
    return {
      text: `${previousText}${incomingText.slice(overlapLength)}`,
      shortTextIgnored: false
    };
  }

  if (incomingText.length < previousText.length) {
    return { text: previousText, shortTextIgnored: true };
  }

  if (previousText.startsWith(incomingText)) {
    return { text: previousText, shortTextIgnored: true };
  }

  if (previousText.endsWith(incomingText)) {
    return { text: previousText, shortTextIgnored: false };
  }

  return {
    text: `${previousText}${
      needsSeparator(previousText, incomingText) ? " " : ""
    }${incomingText}`,
    shortTextIgnored: false
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function suffixPrefixOverlapLength(left: string, right: string): number {
  const maxLength = Math.min(left.length, right.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (left.endsWith(right.slice(0, length))) {
      return length;
    }
  }

  return 0;
}

function needsSeparator(left: string, right: string): boolean {
  return /[A-Za-z0-9]$/u.test(left) && /^[A-Za-z0-9]/u.test(right);
}
