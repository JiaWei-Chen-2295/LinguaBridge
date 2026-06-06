import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRealtimeClientMessage,
  PROTOCOL_VERSION,
  type RealtimeClientMessage,
  type TermEntry
} from "./index.js";

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

test("accepts risk-accepted interpretation audio with disabled echo avoidance", () => {
  const message: RealtimeClientMessage = {
    type: "session.start",
    version: PROTOCOL_VERSION,
    requestId: "req_001",
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
        sampleRate: 16000,
        channels: 1
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

test("rejects interpretation audio with disabled echo avoidance unless risk is accepted", () => {
  const message = {
    type: "session.start",
    version: PROTOCOL_VERSION,
    requestId: "req_001",
    payload: {
      inviteCode: "ALPHA-TEST",
      mode: "interpretation",
      interpretation: {
        outputAudio: true,
        echoAvoidance: "disabled"
      },
      language: {
        sourceLang: "en",
        targetLang: "zh-CN"
      },
      device: {
        os: "windows",
        sampleRate: 16000,
        channels: 1
      },
      privacyConsent: {
        accepted: true,
        acceptedAt: "2026-06-05T00:00:00.000Z",
        retentionDays: 30,
        cloudStorageRequired: true
      }
    }
  };

  assert.equal(isRealtimeClientMessage(message), false);
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

test("term entries can describe computer-course domain and entity kind", () => {
  const term: TermEntry = {
    id: "builtin_k8s",
    source: "Kubernetes",
    mode: "keep_source",
    aliases: ["K8s", "k eight s", "kates"],
    domain: "cloud_native",
    kind: "product",
    priority: 100
  };

  assert.equal(term.domain, "cloud_native");
  assert.equal(term.kind, "product");
  assert.equal(term.priority, 100);
});
