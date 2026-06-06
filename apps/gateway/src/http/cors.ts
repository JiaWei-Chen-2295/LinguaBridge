import type { FastifyInstance } from "fastify";

const ALLOWED_METHODS = "GET,POST,DELETE,OPTIONS";
const ALLOWED_HEADERS = "Content-Type,Authorization";

export function registerCorsSupport(app: FastifyInstance): void {
  app.addHook("onRequest", (request, reply, done) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", ALLOWED_METHODS);
    reply.header("Access-Control-Allow-Headers", ALLOWED_HEADERS);

    if (request.method === "OPTIONS") {
      void reply.code(204).send();
      return;
    }

    done();
  });
}
