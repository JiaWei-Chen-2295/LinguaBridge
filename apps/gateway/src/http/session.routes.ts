import type { FastifyInstance } from "fastify";
import type { ObjectStorage } from "../storage/object-storage";
import type { SessionArtifactRecorder } from "../storage/session-artifact-recorder";
import type { GatewayStore } from "../storage/store";

interface SessionParams {
  sessionId: string;
}

interface SessionListQuery {
  userId?: string;
  inviteCode?: string;
}

export interface SessionRoutesDeps {
  store: GatewayStore;
  objectStorage: ObjectStorage;
  artifactRecorder: SessionArtifactRecorder;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  deps: SessionRoutesDeps
): void {
  app.get<{ Querystring: SessionListQuery }>("/sessions", async (request, reply) => {
    const user = await resolveQueryUser(deps.store, request.query);
    if (user === "missing_identity") {
      return reply.code(400).send({
        error: "identity_required",
        message: "A userId or inviteCode query parameter is required."
      });
    }

    if (user === undefined) {
      return reply.code(404).send({
        error: "user_not_found",
        message: "Sessions can only be queried for an activated user or invite."
      });
    }

    return deps.store.listUserSessions(user.id);
  });

  app.delete<{ Params: SessionParams }>(
    "/sessions/:sessionId",
    async (request, reply) => {
      const snapshot = await deps.store.getSessionSnapshot(request.params.sessionId);
      if (snapshot === undefined) {
        return reply.code(404).send({
          error: "session_not_found",
          message: "Session deletion is only available after a session exists."
        });
      }

      if (snapshot.session.status === "active") {
        return reply.code(409).send({
          error: "session_active",
          message: "Stop the realtime session before deleting its data."
        });
      }

      const sessionPrefix = deps.objectStorage.makeSessionPrefix(
        snapshot.session.userId,
        snapshot.session.id
      );
      const deletedObjects = await deps.objectStorage.deletePrefix(sessionPrefix);
      await deps.artifactRecorder.deleteLocalTemp(snapshot.session.id);
      const deleted = await deps.store.deleteSession(snapshot.session.id);

      return {
        sessionId: snapshot.session.id,
        status: "deleted",
        deletedObjectPrefix: deletedObjects.prefix,
        deletedObjectCount: deletedObjects.deletedKeys.length,
        deletedLocalCache: true,
        deletedSegments: snapshot.segments.length,
        deletedRevisions: snapshot.revisions.length,
        deletedAudioObjects: snapshot.audioObjects.length,
        anonymizedUsageEvents: deleted?.anonymizedUsageEvents ?? 0
      };
    }
  );
}

async function resolveQueryUser(
  store: GatewayStore,
  query: SessionListQuery
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
