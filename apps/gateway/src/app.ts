import fastify, { type FastifyInstance } from "fastify";
import type { GatewayConfig } from "./config";
import { loadConfig } from "./config";
import { registerCorsSupport } from "./http/cors";
import { registerExportRoutes } from "./http/export.routes";
import { registerHealthRoutes } from "./http/health.routes";
import { registerInviteRoutes } from "./http/invite.routes";
import { registerSessionRoutes } from "./http/session.routes";
import { registerTermRoutes } from "./http/term.routes";
import { registerUsageRoutes } from "./http/usage.routes";
import { registerRealtimeGateway } from "./realtime/realtime-gateway";
import { createInMemoryStore } from "./storage/in-memory-store";
import {
  createObjectStorage,
  type ObjectStorage
} from "./storage/object-storage";
import { createPgStore } from "./storage/pg-store";
import { SessionArtifactRecorder } from "./storage/session-artifact-recorder";
import type { GatewayStore } from "./storage/store";

export interface GatewayApp {
  app: FastifyInstance;
  store: GatewayStore;
  objectStorage: ObjectStorage;
  artifactRecorder: SessionArtifactRecorder;
  config: GatewayConfig;
}

export async function buildGatewayApp(
  config: GatewayConfig = loadConfig()
): Promise<GatewayApp> {
  const app = fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel }
  });
  const store = await createGatewayStore(config);
  const objectStorage = createObjectStorage(config);
  await objectStorage.ensureReady();
  const artifactRecorder = new SessionArtifactRecorder(objectStorage);

  registerCorsSupport(app);
  registerHealthRoutes(app, config);
  registerInviteRoutes(app, store);
  registerUsageRoutes(app, store);
  registerTermRoutes(app, store);
  registerExportRoutes(app, store);
  registerSessionRoutes(app, { store, objectStorage, artifactRecorder });
  registerRealtimeGateway(app, { config, store, artifactRecorder });
  app.addHook("onClose", async () => {
    await store.close?.();
  });

  return { app, store, objectStorage, artifactRecorder, config };
}

async function createGatewayStore(config: GatewayConfig): Promise<GatewayStore> {
  const seed = {
    devInviteCode: config.devInviteCode,
    devInviteQuotaMinutes: config.devInviteQuotaMinutes
  };

  if (config.databaseUrl !== undefined) {
    return createPgStore({
      databaseUrl: config.databaseUrl,
      seed
    });
  }

  return createInMemoryStore(seed);
}
