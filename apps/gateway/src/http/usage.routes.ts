import type { FastifyInstance } from "fastify";
import type { InMemoryStore } from "../storage/in-memory-store";

interface UsageParams {
  userId: string;
}

export function registerUsageRoutes(
  app: FastifyInstance,
  store: InMemoryStore
): void {
  app.get<{ Params: UsageParams }>("/usage/:userId", async (request, reply) => {
    const { userId } = request.params;
    if (!store.hasUser(userId)) {
      return reply.code(404).send({
        error: "user_not_found",
        message: "Usage can only be queried for an activated user."
      });
    }

    return store.getUsageSummary(userId);
  });
}
