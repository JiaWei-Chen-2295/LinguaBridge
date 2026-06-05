import fastify, { type FastifyInstance } from "fastify";
import type { GatewayConfig } from "./config";
import { loadConfig } from "./config";
import { registerExportRoutes } from "./http/export.routes";
import { registerHealthRoutes } from "./http/health.routes";
import { registerInviteRoutes } from "./http/invite.routes";
import { registerUsageRoutes } from "./http/usage.routes";
import { registerRealtimeGateway } from "./realtime/realtime-gateway";
import {
  createInMemoryStore,
  type InMemoryStore
} from "./storage/in-memory-store";
import {
  createObjectStorage,
  type ObjectStorage
} from "./storage/object-storage";

export interface GatewayApp {
  app: FastifyInstance;
  store: InMemoryStore;
  objectStorage: ObjectStorage;
  config: GatewayConfig;
}

export async function buildGatewayApp(
  config: GatewayConfig = loadConfig()
): Promise<GatewayApp> {
  const app = fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel }
  });
  const store = createInMemoryStore({
    devInviteCode: config.devInviteCode,
    devInviteQuotaMinutes: config.devInviteQuotaMinutes
  });
  const objectStorage = createObjectStorage(config);
  await objectStorage.ensureReady();

  registerHealthRoutes(app, config);
  registerInviteRoutes(app, store);
  registerUsageRoutes(app, store);
  registerExportRoutes(app, store);
  registerRealtimeGateway(app, { config, store });

  return { app, store, objectStorage, config };
}
