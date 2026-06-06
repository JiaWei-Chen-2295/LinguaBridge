import assert from "node:assert/strict";
import { test } from "node:test";
import type { AlibabaCloudModelConfig } from "../config";
import { AlibabaCloudSubtitleTextProvider } from "./alibaba-cloud-model-session";

test("Qwen-MT requests include computer-course glossary and protected entities", async () => {
  const capturedBodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.ok(init !== undefined);
    const body = init.body;
    if (typeof body !== "string") {
      throw new TypeError("Expected request body to be a JSON string.");
    }
    capturedBodies.push(JSON.parse(body) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "运行 kubectl apply -f deployment.yaml，并调用 getUserById()。"
            }
          }
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18
        }
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  };

  try {
    const provider = new AlibabaCloudSubtitleTextProvider({
      config: fakeAlibabaConfig(),
      log: silentLogger()
    });

    await provider.translate({
      sourceText:
        "Run kubectl apply -f deployment.yaml, then call getUserById().",
      sourceLang: "en",
      targetLang: "zh-CN",
      glossary: '- Keep "kubectl" in English.'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(capturedBodies.length, 1);
  const messageText = readMessagesText(capturedBodies[0]);
  assert.match(messageText, /computer programming course/u);
  assert.match(messageText, /Keep "kubectl" in English/u);
  assert.match(messageText, /kubectl apply -f deployment\.yaml/u);
  assert.match(messageText, /getUserById\(\)/u);
});

function fakeAlibabaConfig(): AlibabaCloudModelConfig {
  return {
    apiKey: "test-key",
    asrWebsocketUrl: "wss://dashscope.test/realtime",
    openAiBaseUrl: "https://dashscope.test/compatible-mode/v1",
    asrModel: "qwen3-asr-flash-realtime",
    mtModel: "qwen-mt-flash",
    revisionModel: "qwen-turbo",
    inputAudioFormat: "pcm",
    asrVadThreshold: 0.5,
    asrSilenceDurationMs: 800,
    translateDrafts: true,
    requestTimeoutMs: 1_000
  };
}

function silentLogger(): never {
  return {
    info: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger()
  } as never;
}

function readMessagesText(body: Record<string, unknown> | undefined): string {
  assert.ok(body !== undefined);
  const messages = body.messages;
  assert.ok(Array.isArray(messages));
  return messages
    .map((message) => {
      assert.equal(typeof message, "object");
      assert.notEqual(message, null);
      const content = (message as Record<string, unknown>).content;
      assert.equal(typeof content, "string");
      return content;
    })
    .join("\n");
}
