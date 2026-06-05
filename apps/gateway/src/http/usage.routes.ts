import type { FastifyInstance } from "fastify";
import type { GatewayStore } from "../storage/store";

interface UsageParams {
  userId: string;
}

export function registerUsageRoutes(
  app: FastifyInstance,
  store: GatewayStore
): void {
  app.get<{ Params: UsageParams }>("/usage/:userId", async (request, reply) => {
    const { userId } = request.params;
    if (!(await store.hasUser(userId))) {
      return reply.code(404).send({
        error: "user_not_found",
        message: "Usage can only be queried for an activated user."
      });
    }

    return store.getUsageSummary(userId);
  });
}
