import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getGatewayHttpBaseUrl,
  loadDesktopGlossary,
  loadDesktopHistory,
  loadDesktopUsage
} from "../src/services/desktopApi";

test("getGatewayHttpBaseUrl prefers explicit VITE_GATEWAY_HTTP_URL", () => {
  assert.equal(
    getGatewayHttpBaseUrl({
      VITE_GATEWAY_HTTP_URL: "https://gateway.example.test/base",
      VITE_GATEWAY_WS_URL: "ws://127.0.0.1:4318/realtime/sessions"
    }),
    "https://gateway.example.test/base"
  );
});

test("getGatewayHttpBaseUrl derives origin from VITE_GATEWAY_WS_URL", () => {
  assert.equal(
    getGatewayHttpBaseUrl({
      VITE_GATEWAY_WS_URL: "wss://gateway.example.test/realtime/sessions"
    }),
    "https://gateway.example.test"
  );
});

test("getGatewayHttpBaseUrl falls back to local gateway", () => {
  assert.equal(getGatewayHttpBaseUrl({}), "http://127.0.0.1:4318");
});

test("desktop API loaders call expected gateway endpoints", async () => {
  const requestedUrls: string[] = [];
  const fetcher = async (input: string | URL): Promise<Response> => {
    requestedUrls.push(String(input));

    if (String(input).includes("/usage/")) {
      return Response.json({
        userId: "user alpha",
        quotaMinutes: 300,
        usedRealtimeMs: 60_000,
        usedAsrMs: 45_000,
        storageBytes: 1024,
        mtInputTokens: 100,
        mtOutputTokens: 200,
        revisionTokens: 50,
        interpretationAudioMs: 30_000,
        interruptions: 1,
        remainingMinutes: 299
      });
    }

    if (String(input).includes("/sessions")) {
      return Response.json([
        {
          id: "sess_1",
          userId: "user alpha",
          sourceLang: "en",
          targetLang: "zh-CN",
          status: "stopped",
          startedAt: "2026-06-06T01:00:00.000Z",
          durationMs: 120_000,
          deviceLabel: "Default output",
          segmentCount: 10,
          storageBytes: 2048
        }
      ]);
    }

    return Response.json([
      {
        id: "term_1",
        userId: "user alpha",
        source: "latency budget",
        target: "延迟预算",
        mode: "fixed_translation",
        aliases: ["latency"],
        domain: "systems",
        kind: "term",
        priority: 5
      }
    ]);
  };

  const options = {
    env: { VITE_GATEWAY_HTTP_URL: "http://127.0.0.1:4318" },
    fetcher
  };

  const usage = await loadDesktopUsage("user alpha", options);
  const sessions = await loadDesktopHistory("user alpha", options);
  const terms = await loadDesktopGlossary("user alpha", options);

  assert.equal(usage.usedRealtimeMs, 60_000);
  assert.equal(sessions[0]?.id, "sess_1");
  assert.equal(terms[0]?.source, "latency budget");
  assert.deepEqual(requestedUrls, [
    "http://127.0.0.1:4318/usage/user%20alpha",
    "http://127.0.0.1:4318/sessions?userId=user+alpha",
    "http://127.0.0.1:4318/terms?userId=user+alpha"
  ]);
});

test("desktop API loaders can use invite code before user id is known", async () => {
  const requestedUrls: string[] = [];
  const fetcher = async (input: string | URL): Promise<Response> => {
    requestedUrls.push(String(input));

    if (String(input).includes("/usage")) {
      return Response.json({
        userId: "user from invite",
        quotaMinutes: 300,
        usedRealtimeMs: 0,
        usedAsrMs: 0,
        storageBytes: 0,
        mtInputTokens: 0,
        mtOutputTokens: 0,
        revisionTokens: 0,
        interpretationAudioMs: 0,
        interruptions: 0,
        remainingMinutes: 300
      });
    }

    return Response.json([]);
  };

  const options = {
    env: { VITE_GATEWAY_HTTP_URL: "http://127.0.0.1:4318" },
    fetcher
  };
  const identity = { inviteCode: "ALPHA-DEV-2026" };

  await loadDesktopUsage(identity, options);
  await loadDesktopHistory(identity, options);
  await loadDesktopGlossary(identity, options);

  assert.deepEqual(requestedUrls, [
    "http://127.0.0.1:4318/usage?inviteCode=ALPHA-DEV-2026",
    "http://127.0.0.1:4318/sessions?inviteCode=ALPHA-DEV-2026",
    "http://127.0.0.1:4318/terms?inviteCode=ALPHA-DEV-2026"
  ]);
});
