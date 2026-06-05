import type { FastifyInstance } from "fastify";
import {
  normalizeExportFormat,
  renderSessionExport
} from "../domain/exports";
import type { InMemoryStore } from "../storage/in-memory-store";

interface ExportParams {
  sessionId: string;
}

interface ExportQuery {
  format?: string;
}

export function registerExportRoutes(
  app: FastifyInstance,
  store: InMemoryStore
): void {
  app.get<{ Params: ExportParams; Querystring: ExportQuery }>(
    "/sessions/:sessionId/export",
    async (request, reply) => {
      const snapshot = store.getSessionSnapshot(request.params.sessionId);
      if (snapshot === undefined) {
        return reply.code(404).send({
          error: "session_not_found",
          message: "Session export is only available after a session exists."
        });
      }

      const format = normalizeExportFormat(request.query.format);
      const rendered = renderSessionExport(snapshot, format);

      return reply
        .type(rendered.contentType)
        .header("Content-Disposition", `attachment; filename="${rendered.filename}"`)
        .send(rendered.body);
    }
  );
}
