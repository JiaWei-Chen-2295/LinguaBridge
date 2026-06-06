import type { FastifyInstance } from "fastify";
import type { GatewayStore } from "../storage/store";

interface UsageParams {
  userId: string;
}

interface UsageQuery {
  userId?: string;
  inviteCode?: string;
}

export function registerUsageRoutes(
  app: FastifyInstance,
  store: GatewayStore
): void {
  app.get<{ Querystring: UsageQuery }>("/usage", async (request, reply) => {
    const user = await resolveQueryUser(store, request.query);
    if (user === "missing_identity") {
      return reply.code(400).send({
        error: "identity_required",
        message: "A userId or inviteCode query parameter is required."
      });
    }

    if (user === undefined) {
      return reply.code(404).send({
        error: "user_not_found",
        message: "Usage can only be queried for an activated user or invite."
      });
    }

    return store.getUsageSummary(user.id);
  });

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

async function resolveQueryUser(
  store: GatewayStore,
  query: UsageQuery
): Promise<{ id: string } | "missing_identity" | undefined> {
  const userId = query.userId?.trim();
  if (userId !== undefined && userId.length > 0) {
    return (await store.hasUser(userId)) ? { id: userId } : undefined;
  }

  const inviteCode = query.inviteCode?.trim();
  if (inviteCode !== undefined && inviteCode.length > 0) {
    return store.resolveActivatedInviteUser(inviteCode);
  }

  return "missing_identity";
}
