import assert from "node:assert/strict";
import { test } from "node:test";
import { isRealtimeClientMessage, PROTOCOL_VERSION, type RealtimeClientMessage } from "./index.js";

test("accepts a valid session.start message", () => {
  const message: RealtimeClientMessage = {
    type: "session.start",
    version: PROTOCOL_VERSION,
    requestId: "req_001",
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
        acceptedAt: "2026-06-05T00:00:00.000Z",
        retentionDays: 30,
        cloudStorageRequired: true
      }
    }
  };

  assert.equal(isRealtimeClientMessage(message), true);
});

test("rejects session.start without privacy consent", () => {
  const message = {
    type: "session.start",
    version: PROTOCOL_VERSION,
    requestId: "req_001",
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
        accepted: false,
        acceptedAt: "2026-06-05T00:00:00.000Z",
        retentionDays: 30,
        cloudStorageRequired: true
      }
    }
  };

  assert.equal(isRealtimeClientMessage(message), false);
});

test("accepts a valid audio.frame message", () => {
  const message: RealtimeClientMessage = {
    type: "audio.frame",
    version: PROTOCOL_VERSION,
    requestId: "req_002",
    payload: {
      sessionId: "sess_001",
      sequence: 1,
      pcmBase64: "AAAA",
      capturedAtMs: 120,
      durationMs: 40,
      sampleRate: 16000,
      channels: 1
    }
  };

  assert.equal(isRealtimeClientMessage(message), true);
});
