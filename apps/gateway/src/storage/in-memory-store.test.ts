import assert from "node:assert/strict";
import { test } from "node:test";
import { createInMemoryStore } from "./in-memory-store";

test("listUserSessions returns user history with segment and storage totals", async () => {
  const store = createInMemoryStore({
    devInviteCode: "DEV-CODE",
    devInviteQuotaMinutes: 120
  });
  const activation = store.activateInvite({
    code: "DEV-CODE",
    email: "history@example.com"
  });
  assert.equal(activation.ok, true);
  if (!activation.ok) {
    return;
  }

  const session = store.createSession({
    userId: activation.user.id,
    sourceLang: "en",
    targetLang: "zh-Hans",
    device: {
      deviceId: "Speakers (Realtek)",
      os: "windows",
      sampleRate: 16000,
      channels: 1
    }
  });
  store.recordSubtitleEvent({
    type: "subtitle.segment.updated",
    version: 1,
    payload: {
      sessionId: session.id,
      segmentId: "seg_1",
      status: "final",
      sourceText: "hello",
      targetText: "你好",
      startAtMs: 0,
      endAtMs: 1000,
      revision: 1,
      confidence: 0.95,
      termsHit: [],
      latencyMs: 120,
      modelTrace: {
        provider: "mock",
        asrModel: "mock-asr",
        mtModel: "mock-mt"
      }
    }
  });
  store.recordSessionAudioObject({
    sessionId: session.id,
    objectKey: "users/u/sessions/s/audio.pcm",
    format: "pcm_s16le",
    durationMs: 1000,
    sizeBytes: 4096
  });

  const sessions = await store.listUserSessions(activation.user.id);

  assert.equal(sessions.length, 1);
  assert.deepEqual(
    {
      id: sessions[0]?.id,
      userId: sessions[0]?.userId,
      sourceLang: sessions[0]?.sourceLang,
      targetLang: sessions[0]?.targetLang,
      status: sessions[0]?.status,
      durationMs: sessions[0]?.durationMs,
      deviceLabel: sessions[0]?.deviceLabel,
      segmentCount: sessions[0]?.segmentCount,
      storageBytes: sessions[0]?.storageBytes
    },
    {
      id: session.id,
      userId: activation.user.id,
      sourceLang: "en",
      targetLang: "zh-Hans",
      status: "active",
      durationMs: 0,
      deviceLabel: "Speakers (Realtek)",
      segmentCount: 1,
      storageBytes: 4096
    }
  );
  assert.ok(sessions[0]?.startedAt instanceof Date);
  assert.equal(sessions[0]?.endedAt, undefined);
});
