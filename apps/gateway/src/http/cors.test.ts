import assert from "node:assert/strict";
import { test } from "node:test";
import fastify from "fastify";
import { registerCorsSupport } from "./cors";

test("CORS support allows desktop webview HTTP fetches", async () => {
  const app = fastify();
  registerCorsSupport(app);
  app.get("/probe", async () => ({ ok: true }));

  const getResponse = await app.inject({
    method: "GET",
    url: "/probe",
    headers: {
      origin: "http://localhost:1420"
    }
  });

  assert.equal(getResponse.statusCode, 200);
  assert.equal(getResponse.headers["access-control-allow-origin"], "*");

  const optionsResponse = await app.inject({
    method: "OPTIONS",
    url: "/probe",
    headers: {
      origin: "http://localhost:1420",
      "access-control-request-method": "GET"
    }
  });

  assert.equal(optionsResponse.statusCode, 204);
  assert.equal(optionsResponse.headers["access-control-allow-origin"], "*");
  assert.match(
    String(optionsResponse.headers["access-control-allow-methods"]),
    /GET/u
  );
  await app.close();
});
