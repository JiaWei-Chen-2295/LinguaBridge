import type { FastifyInstance } from "fastify";
import type { GatewayConfig } from "../config";

export function registerHealthRoutes(
  app: FastifyInstance,
  config: GatewayConfig
): void {
  app.get("/health", async () => ({
    status: "ok",
    service: "lingua-bridge-gateway",
    websocketPath: config.websocketPath,
    databaseConfigured: config.databaseUrlConfigured,
    redisConfigured: config.redisUrlConfigured,
    uptimeSec: Math.round(process.uptime())
  }));
}
