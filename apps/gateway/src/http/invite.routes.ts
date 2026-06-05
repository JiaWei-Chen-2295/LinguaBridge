import type { FastifyInstance } from "fastify";
import type { ActivateInviteInput, GatewayStore } from "../storage/store";
import { isRecord, optionalString, requiredString } from "./validation";

interface ActivateInviteResponse {
  userId: string;
  quotaMinutes: number;
  remainingMinutes: number;
  inviteStatus: string;
}

export function registerInviteRoutes(
  app: FastifyInstance,
  store: GatewayStore
): void {
  app.post<{ Body: unknown }>("/invites/activate", async (request, reply) => {
    const input = parseActivateInviteInput(request.body);
    if (input === undefined) {
      return reply.code(400).send({
        error: "invalid_invite_activation",
        message: "Request body must include a non-empty invite code."
      });
    }

    const result = await store.activateInvite(input);
    if (!result.ok) {
      return reply.code(result.code === "invite_already_used" ? 409 : 400).send({
        error: result.code,
        message: result.message
      });
    }

    const response: ActivateInviteResponse = {
      userId: result.user.id,
      quotaMinutes: result.usage.quotaMinutes,
      remainingMinutes: result.usage.remainingMinutes,
      inviteStatus: result.invite.status
    };

    return reply.code(201).send(response);
  });
}

function parseActivateInviteInput(
  body: unknown
): ActivateInviteInput | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  const code = requiredString(body, "code");
  if (code === undefined) {
    return undefined;
  }

  const input: ActivateInviteInput = { code };
  const email = optionalString(body, "email");
  const phone = optionalString(body, "phone");

  if (email !== undefined) {
    input.email = email;
  }

  if (phone !== undefined) {
    input.phone = phone;
  }

  return input;
}
