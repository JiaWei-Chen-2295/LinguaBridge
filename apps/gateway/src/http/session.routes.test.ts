import assert from "node:assert/strict";
import { test } from "node:test";
import fastify from "fastify";
import { registerSessionRoutes } from "./session.routes";
import { registerTermRoutes } from "./term.routes";
import { registerUsageRoutes } from "./usage.routes";
import { SessionArtifactRecorder } from "../storage/session-artifact-recorder";
import type { ObjectStorage } from "../storage/object-storage";
import { createInMemoryStore } from "../storage/in-memory-store";

test("GET /sessions returns activated user's session history", async () => {
  const app = fastify();
  const store = createInMemoryStore({
    devInviteCode: "DEV-CODE",
    devInviteQuotaMinutes: 120
  });
  const activation = store.activateInvite({
    code: "DEV-CODE",
    email: "sessions@example.com"
  });
  assert.equal(activation.ok, true);
  if (!activation.ok) {
    return;
  }

  const session = store.createSession({
    userId: activation.user.id,
    sourceLang: "en",
    targetLang: "zh-Hans"
  });
  registerSessionRoutes(app, {
    store,
    objectStorage: stubObjectStorage,
    artifactRecorder: new SessionArtifactRecorder(stubObjectStorage)
  });

  const response = await app.inject({
    method: "GET",
    url: `/sessions?userId=${activation.user.id}`
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), [
    {
      id: session.id,
      userId: activation.user.id,
      sourceLang: "en",
      targetLang: "zh-Hans",
      status: "active",
      startedAt: session.startedAt.toISOString(),
      durationMs: 0,
      segmentCount: 0,
      storageBytes: 0
    }
  ]);
  await app.close();
});

test("GET /sessions can resolve history from invite code", async () => {
  const app = fastify();
  const store = createInMemoryStore({
    devInviteCode: "DEV-CODE",
    devInviteQuotaMinutes: 120
  });
  const activation = store.activateInvite({
    code: "DEV-CODE",
    email: "sessions-invite@example.com"
  });
  assert.equal(activation.ok, true);
  if (!activation.ok) {
    return;
  }

  const session = store.createSession({
    userId: activation.user.id,
    sourceLang: "en",
    targetLang: "zh-CN"
  });
  registerSessionRoutes(app, {
    store,
    objectStorage: stubObjectStorage,
    artifactRecorder: new SessionArtifactRecorder(stubObjectStorage)
  });

  const response = await app.inject({
    method: "GET",
    url: "/sessions?inviteCode=DEV-CODE"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json()[0].id, session.id);
  await app.close();
});

test("GET /sessions rejects unknown users", async () => {
  const app = fastify();
  const store = createInMemoryStore({
    devInviteCode: "DEV-CODE",
    devInviteQuotaMinutes: 120
  });
  registerSessionRoutes(app, {
    store,
    objectStorage: stubObjectStorage,
    artifactRecorder: new SessionArtifactRecorder(stubObjectStorage)
  });

  const response = await app.inject({
    method: "GET",
    url: "/sessions?userId=missing"
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, "user_not_found");
  await app.close();
});

test("GET /terms returns activated user's term entries", async () => {
  const app = fastify();
  const store = createInMemoryStore({
    devInviteCode: "DEV-CODE",
    devInviteQuotaMinutes: 120
  });
  const activation = store.activateInvite({
    code: "DEV-CODE",
    email: "terms@example.com"
  });
  assert.equal(activation.ok, true);
  if (!activation.ok) {
    return;
  }
  registerTermRoutes(app, store);

  const response = await app.inject({
    method: "GET",
    url: `/terms?userId=${activation.user.id}`
  });

  assert.equal(response.statusCode, 200);
  const terms = response.json();
  assert.ok(terms.length > 250);
  assert.ok(terms.some((term: { source: string }) => term.source === "Kubernetes"));
  await app.close();
});

test("GET /terms includes built-in computer terms without user terms", async () => {
  const app = fastify();
  const store = createInMemoryStore({
    devInviteCode: "DEV-CODE",
    devInviteQuotaMinutes: 120
  });
  registerTermRoutes(app, store);

  const response = await app.inject({
    method: "GET",
    url: "/terms"
  });

  assert.equal(response.statusCode, 200);
  const terms = response.json();
  assert.ok(terms.length > 250);
  assert.ok(terms.some((term: { source: string }) => term.source === "Kubernetes"));
  await app.close();
});

test("GET /usage can resolve summary from invite code", async () => {
  const app = fastify();
  const store = createInMemoryStore({
    devInviteCode: "DEV-CODE",
    devInviteQuotaMinutes: 120
  });
  const activation = store.activateInvite({
    code: "DEV-CODE",
    email: "usage-invite@example.com"
  });
  assert.equal(activation.ok, true);
  registerUsageRoutes(app, store);

  const response = await app.inject({
    method: "GET",
    url: "/usage?inviteCode=DEV-CODE"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().quotaMinutes, 120);
  await app.close();
});

test("GET /terms rejects unknown users", async () => {
  const app = fastify();
  const store = createInMemoryStore({
    devInviteCode: "DEV-CODE",
    devInviteQuotaMinutes: 120
  });
  registerTermRoutes(app, store);

  const response = await app.inject({
    method: "GET",
    url: "/terms?userId=missing"
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, "user_not_found");
  await app.close();
});

const stubObjectStorage: ObjectStorage = {
  async ensureReady() {
    return undefined;
  },
  async putObject() {
    return { key: "", sizeBytes: 0 };
  },
  async putFile() {
    return { key: "", sizeBytes: 0 };
  },
  async deleteObject() {
    return undefined;
  },
  async deletePrefix(prefix: string) {
    return { prefix, deletedKeys: [] };
  },
  makeSessionPrefix(userId: string, sessionId: string) {
    return `users/${userId}/sessions/${sessionId}/`;
  }
};
