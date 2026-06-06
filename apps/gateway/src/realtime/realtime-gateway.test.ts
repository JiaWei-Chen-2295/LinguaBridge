import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { test } from "node:test";
import fastify from "fastify";
import type { AddressInfo } from "node:net";
import { WebSocket, type RawData } from "ws";
import type {
  RealtimeServerMessage,
  SubtitleSegmentUpdatedEvent
} from "@lingua-bridge/protocol";
import { loadConfig } from "../config";
import { InMemoryStore } from "../storage/in-memory-store";
import type {
  DeletePrefixResult,
  ObjectStorage,
  PutFileInput,
  PutObjectInput,
  PutObjectResult
} from "../storage/object-storage";
import { SessionArtifactRecorder } from "../storage/session-artifact-recorder";
import { registerRealtimeGateway } from "./realtime-gateway";

test("session.stop waits for pending final subtitle persistence before exports", async () => {
  const config = loadConfig({
    DEV_INVITE_CODE: "ALPHA-TEST",
    DEV_INVITE_QUOTA_MINUTES: "180",
    LOG_LEVEL: "silent",
    MOCK_SUBTITLE_DELAY_MS: "1",
    MODEL_PROVIDER: "mock",
    OBJECT_STORAGE_PROVIDER: "disabled",
    SUBTITLE_REVISION_INTERVAL_MS: "15000",
    WEBSOCKET_PATH: "/realtime/sessions"
  });
  const app = fastify({ logger: false });
  const store = new DelayedFinalSubtitleStore({
    devInviteCode: "ALPHA-TEST",
    devInviteQuotaMinutes: 180
  });
  const objectStorage = new CapturingObjectStorage();
  const artifactRecorder = new SessionArtifactRecorder(objectStorage);
  registerRealtimeGateway(app, { config, store, artifactRecorder });

  let socket: WebSocket | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address !== null && typeof address !== "string");

    socket = new WebSocket(
      `ws://127.0.0.1:${(address as AddressInfo).port}${config.websocketPath}`
    );
    const reader = new ServerMessageReader(socket);
    await waitForOpen(socket);
    await reader.next("gateway.ready");

    socket.send(
      JSON.stringify({
        type: "session.start",
        version: 1,
        requestId: "req_start",
        payload: {
          inviteCode: "ALPHA-TEST",
          language: {
            sourceLang: "en",
            targetLang: "zh-CN"
          },
          device: {
            os: "windows",
            sampleRate: 48000,
            channels: 2
          },
          privacyConsent: {
            accepted: true,
            acceptedAt: "2026-06-06T00:00:00.000Z",
            retentionDays: 30,
            cloudStorageRequired: true
          }
        }
      })
    );
    const started = await reader.next("session.started");

    socket.send(
      JSON.stringify({
        type: "audio.frame",
        version: 1,
        requestId: "req_audio",
        payload: {
          sessionId: started.payload.sessionId,
          sequence: 1,
          pcmBase64: "AAAA",
          capturedAtMs: 0,
          durationMs: 3600,
          sampleRate: 16000,
          channels: 1
        }
      })
    );

    await reader.next(
      "subtitle.segment.updated",
      (message) => message.payload.status === "final"
    );
    await store.waitForBlockedFinalWrite();

    const stoppedPromise = reader.next("session.stopped");
    socket.send(
      JSON.stringify({
        type: "session.stop",
        version: 1,
        requestId: "req_stop",
        payload: {
          sessionId: started.payload.sessionId,
          reason: "user"
        }
      })
    );

    const stoppedBeforeFinalWrite = await Promise.race([
      stoppedPromise.then(() => true),
      wait(150).then(() => false)
    ]);
    assert.equal(
      stoppedBeforeFinalWrite,
      false,
      "session.stopped was emitted before the final subtitle write finished"
    );

    store.releaseFinalWrites();
    await withTimeout(stoppedPromise, 1_000, "session.stopped");

    const snapshot = store.getSessionSnapshot(started.payload.sessionId);
    assert.ok(snapshot !== undefined);
    assert.equal(snapshot.segments[0]?.status, "final");
    assert.equal(
      snapshot.segments[0]?.sourceText,
      "We deploy it on Kubernetes with a sidecar proxy."
    );

    const markdown = objectStorage.putObjects.find((upload) =>
      upload.key.endsWith("exports/transcript.md")
    );
    assert.ok(markdown !== undefined);
    assert.match(
      bodyToString(markdown.body),
      /We deploy it on Kubernetes with a sidecar proxy\./u
    );
  } finally {
    store.releaseFinalWrites();
    socket?.close();
    await app.close();
  }
});

test("risk-accepted interpretation sessions persist echo diagnostics in usage metadata", async () => {
  const config = loadConfig({
    DEV_INVITE_CODE: "ALPHA-TEST",
    DEV_INVITE_QUOTA_MINUTES: "180",
    LOG_LEVEL: "silent",
    MOCK_SUBTITLE_DELAY_MS: "1",
    MODEL_PROVIDER: "mock",
    OBJECT_STORAGE_PROVIDER: "disabled",
    SUBTITLE_REVISION_INTERVAL_MS: "15000",
    WEBSOCKET_PATH: "/realtime/sessions"
  });
  const app = fastify({ logger: false });
  const store = new InMemoryStore({
    devInviteCode: "ALPHA-TEST",
    devInviteQuotaMinutes: 180
  });
  const objectStorage = new CapturingObjectStorage();
  const artifactRecorder = new SessionArtifactRecorder(objectStorage);
  registerRealtimeGateway(app, { config, store, artifactRecorder });

  let socket: WebSocket | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address !== null && typeof address !== "string");

    socket = new WebSocket(
      `ws://127.0.0.1:${(address as AddressInfo).port}${config.websocketPath}`
    );
    const reader = new ServerMessageReader(socket);
    await waitForOpen(socket);
    await reader.next("gateway.ready");

    socket.send(
      JSON.stringify({
        type: "session.start",
        version: 1,
        requestId: "req_start",
        payload: {
          inviteCode: "ALPHA-TEST",
          mode: "interpretation",
          interpretation: {
            outputAudio: true,
            echoAvoidance: "disabled",
            echoRiskAccepted: true
          },
          language: {
            sourceLang: "en",
            targetLang: "zh-CN"
          },
          device: {
            os: "windows",
            osVersion: "10.0.19045",
            sampleRate: 16000,
            channels: 1
          },
          privacyConsent: {
            accepted: true,
            acceptedAt: "2026-06-06T00:00:00.000Z",
            retentionDays: 30,
            cloudStorageRequired: true
          }
        }
      })
    );
    const started = await reader.next("session.started");

    const snapshot = store.getSessionSnapshot(started.payload.sessionId);
    assert.ok(snapshot !== undefined);
    const metadataEvent = snapshot.usageEvents.find(
      (event) => event.eventType === "session_metadata"
    );
    assert.ok(metadataEvent !== undefined);
    assert.deepEqual(metadataEvent.metadata, {
      mode: "interpretation",
      outputAudio: true,
      echoAvoidance: "disabled",
      echoRiskAccepted: true
    });
  } finally {
    socket?.close();
    await app.close();
  }
});

class DelayedFinalSubtitleStore extends InMemoryStore {
  private readonly finalWriteResolvers: Array<() => void> = [];
  private readonly blockedFinalWriteWaiters: Array<() => void> = [];
  private blockedFinalWrites = 0;

  public override async recordSubtitleEvent(
    event: SubtitleSegmentUpdatedEvent
  ): Promise<void> {
    if (event.payload.status !== "final") {
      super.recordSubtitleEvent(event);
      return;
    }

    this.blockedFinalWrites += 1;
    this.notifyBlockedFinalWrite();
    await new Promise<void>((resolve) => {
      this.finalWriteResolvers.push(resolve);
    });
    super.recordSubtitleEvent(event);
  }

  public waitForBlockedFinalWrite(): Promise<void> {
    if (this.blockedFinalWrites > 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.blockedFinalWriteWaiters.push(resolve);
    });
  }

  public releaseFinalWrites(): void {
    for (const resolve of this.finalWriteResolvers.splice(0)) {
      resolve();
    }
  }

  private notifyBlockedFinalWrite(): void {
    for (const resolve of this.blockedFinalWriteWaiters.splice(0)) {
      resolve();
    }
  }
}

class CapturingObjectStorage implements ObjectStorage {
  public readonly putObjects: PutObjectInput[] = [];

  public ensureReady(): Promise<void> {
    return Promise.resolve();
  }

  public putObject(input: PutObjectInput): Promise<PutObjectResult> {
    this.putObjects.push(input);
    return Promise.resolve({
      key: input.key,
      sizeBytes: bodySize(input.body)
    });
  }

  public putFile(input: PutFileInput): Promise<PutObjectResult> {
    return Promise.resolve({
      key: input.key,
      sizeBytes: 0
    });
  }

  public deleteObject(_key: string): Promise<void> {
    return Promise.resolve();
  }

  public deletePrefix(prefix: string): Promise<DeletePrefixResult> {
    return Promise.resolve({ prefix, deletedKeys: [] });
  }

  public makeSessionPrefix(userId: string, sessionId: string): string {
    return `users/${userId}/sessions/${sessionId}/`;
  }
}

class ServerMessageReader {
  private readonly queue: RealtimeServerMessage[] = [];
  private readonly waiters: Array<() => void> = [];

  public constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      this.queue.push(parseServerMessage(data));
      this.flushWaiters();
    });
  }

  public async next<T extends RealtimeServerMessage["type"]>(
    type: T,
    predicate: (
      message: Extract<RealtimeServerMessage, { type: T }>
    ) => boolean = () => true
  ): Promise<Extract<RealtimeServerMessage, { type: T }>> {
    for (;;) {
      const index = this.queue.findIndex((message) => {
        if (message.type !== type) {
          return false;
        }

        return predicate(message as Extract<RealtimeServerMessage, { type: T }>);
      });
      if (index >= 0) {
        const [message] = this.queue.splice(index, 1);
        assert.ok(message !== undefined);
        return message as Extract<RealtimeServerMessage, { type: T }>;
      }

      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  private flushWaiters(): void {
    for (const resolve of this.waiters.splice(0)) {
      resolve();
    }
  }
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error) => reject(error));
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return Promise.race([
    promise,
    wait(ms).then(() => {
      throw new Error(`Timed out waiting for ${label}`);
    })
  ]);
}

function parseServerMessage(data: RawData): RealtimeServerMessage {
  return JSON.parse(rawDataToString(data)) as RealtimeServerMessage;
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
}

function bodyToString(body: Buffer | string): string {
  return Buffer.isBuffer(body) ? body.toString("utf8") : body;
}

function bodySize(body: Buffer | string): number {
  return Buffer.isBuffer(body)
    ? body.byteLength
    : Buffer.byteLength(body, "utf8");
}
