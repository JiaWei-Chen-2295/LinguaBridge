import type { InterpretationAudioDeltaEvent } from "@lingua-bridge/protocol";

type InterpretationAudioPayload = InterpretationAudioDeltaEvent["payload"];

export interface InterpretationAudioPlayerSnapshot {
  bufferedMs: number;
  playedChunks: number;
  queuedChunks: number;
  lastLatencyMs: number | null;
}

const SCHEDULE_AHEAD_SECONDS = 0.025;

export class InterpretationAudioPlayer {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  private playedChunks = 0;
  private lastLatencyMs: number | null = null;
  private readonly scheduledSources = new Set<AudioBufferSourceNode>();

  public async resume(): Promise<void> {
    const context = this.ensureContext();
    if (context.state === "suspended") {
      await context.resume();
    }
    this.nextStartTime = Math.max(context.currentTime, this.nextStartTime);
  }

  public async enqueue(payload: InterpretationAudioPayload): Promise<InterpretationAudioPlayerSnapshot> {
    const context = this.ensureContext();
    if (context.state === "suspended") {
      await context.resume();
    }

    const buffer = createAudioBuffer(context, payload);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      this.scheduledSources.delete(source);
    };

    const startAt = Math.max(
      context.currentTime + SCHEDULE_AHEAD_SECONDS,
      this.nextStartTime
    );
    source.start(startAt);
    this.scheduledSources.add(source);
    this.nextStartTime = startAt + buffer.duration;
    this.playedChunks += 1;
    this.lastLatencyMs = payload.latencyMs;

    return this.snapshot();
  }

  public reset(): void {
    for (const source of this.scheduledSources) {
      try {
        source.stop();
      } catch {
        // Already ended or stopped.
      }
      source.disconnect();
    }

    this.scheduledSources.clear();
    this.nextStartTime = this.context?.currentTime ?? 0;
    this.playedChunks = 0;
    this.lastLatencyMs = null;
  }

  public async close(): Promise<void> {
    this.reset();
    if (this.context !== null && this.context.state !== "closed") {
      await this.context.close();
    }
    this.context = null;
    this.nextStartTime = 0;
  }

  public snapshot(): InterpretationAudioPlayerSnapshot {
    const currentTime = this.context?.currentTime ?? 0;
    return {
      bufferedMs: Math.max(0, Math.round((this.nextStartTime - currentTime) * 1000)),
      playedChunks: this.playedChunks,
      queuedChunks: this.scheduledSources.size,
      lastLatencyMs: this.lastLatencyMs
    };
  }

  private ensureContext(): AudioContext {
    if (this.context === null || this.context.state === "closed") {
      this.context = new AudioContext({
        latencyHint: "interactive"
      });
      this.nextStartTime = this.context.currentTime;
    }

    return this.context;
  }
}

function createAudioBuffer(
  context: AudioContext,
  payload: InterpretationAudioPayload
): AudioBuffer {
  const samples = decodePcmSamples(payload);
  const buffer = context.createBuffer(
    payload.channels,
    samples.length,
    payload.sampleRate
  );
  buffer.copyToChannel(samples, 0);
  return buffer;
}

function decodePcmSamples(payload: InterpretationAudioPayload): Float32Array<ArrayBuffer> {
  const bytes = base64ToBytes(payload.pcmBase64);
  if (payload.sampleFormat === "pcm_s24le") {
    return decodePcm24(bytes);
  }

  return decodePcm16(bytes);
}

function decodePcm16(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const samples = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = clampAudioSample(view.getInt16(index * 2, true) / 32_768);
  }

  return samples;
}

function decodePcm24(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const sampleCount = Math.floor(bytes.byteLength / 3);
  const samples = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    const offset = index * 3;
    let value =
      (bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16);
    if ((value & 0x800000) !== 0) {
      value |= 0xff000000;
    }
    samples[index] = clampAudioSample(value / 8_388_608);
  }

  return samples;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function clampAudioSample(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
