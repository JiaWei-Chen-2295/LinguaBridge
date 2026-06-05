import {
  createMockSubtitleEvents,
  type MockSubtitleScenario
} from "@lingua-bridge/mock-models";
import type { SubtitleSegmentUpdatedEvent } from "@lingua-bridge/protocol";
import { setTimeout as wait } from "node:timers/promises";
import type {
  RealtimeAudioFramePayload,
  RealtimeModelSession,
  RealtimeModelSessionCallbacks,
  RealtimeModelSessionContext
} from "./model-session";

export interface MockRealtimeModelSessionInput {
  context: RealtimeModelSessionContext;
  callbacks: RealtimeModelSessionCallbacks;
  delayAudioMs: number;
}

export class MockRealtimeModelSession implements RealtimeModelSession {
  private readonly events: SubtitleSegmentUpdatedEvent[];
  private accumulatedAudioMs = 0;
  private nextEventIndex = 0;
  private stopped = false;

  public constructor(private readonly input: MockRealtimeModelSessionInput) {
    const scenario: MockSubtitleScenario = {
      sessionId: input.context.sessionId,
      sourceLang: input.context.sourceLang,
      targetLang: input.context.targetLang
    };
    this.events = createMockSubtitleEvents(scenario);
  }

  public start(): Promise<void> {
    return Promise.resolve();
  }

  public async appendAudioFrame(frame: RealtimeAudioFramePayload): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.accumulatedAudioMs += frame.durationMs;
    while (this.shouldEmitNextEvent()) {
      const event = this.events[this.nextEventIndex];
      this.nextEventIndex += 1;

      if (event === undefined) {
        return;
      }

      if (this.input.delayAudioMs > 0) {
        await wait(this.input.delayAudioMs);
      }

      if (this.stopped) {
        return;
      }

      await this.input.callbacks.onSubtitleEvent(event);
    }
  }

  public stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  private shouldEmitNextEvent(): boolean {
    const event = this.events[this.nextEventIndex];
    return (
      event !== undefined && event.payload.endAtMs <= this.accumulatedAudioMs
    );
  }
}
