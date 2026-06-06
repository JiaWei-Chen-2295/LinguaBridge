import type { FastifyInstance } from "fastify";
import { mergeTermEntries } from "../realtime/terms";
import type { GatewayStore } from "../storage/store";

interface TermListQuery {
  userId?: string;
  inviteCode?: string;
}

export function registerTermRoutes(
  app: FastifyInstance,
  store: GatewayStore
): void {
  app.get<{ Querystring: TermListQuery }>("/terms", async (request, reply) => {
    const user = await resolveOptionalQueryUser(store, request.query);
    if (user === undefined) {
      return mergeTermEntries([]);
    }

    if (user === "unknown_identity") {
      return reply.code(404).send({
        error: "user_not_found",
        message: "Terms can only include user entries for an activated user or invite."
      });
    }

    return mergeTermEntries(await store.listTermEntries(user.id));
  });
}

async function resolveOptionalQueryUser(
  store: GatewayStore,
  query: TermListQuery
): Promise<{ id: string } | "unknown_identity" | undefined> {
  const userId = query.userId?.trim();
  if (userId !== undefined && userId.length > 0) {
    return (await store.hasUser(userId)) ? { id: userId } : "unknown_identity";
  }

  const inviteCode = query.inviteCode?.trim();
  if (inviteCode !== undefined && inviteCode.length > 0) {
    return (await store.resolveActivatedInviteUser(inviteCode)) ?? "unknown_identity";
  }

  return undefined;
}
