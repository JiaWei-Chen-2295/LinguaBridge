import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLiveTranslateGlossaryPhrases } from "./alibaba-cloud-livetranslate-session";

test("LiveTranslate glossary phrases include spoken aliases for computer terms", () => {
  const phrases = buildLiveTranslateGlossaryPhrases([
    {
      id: "builtin_kubernetes",
      source: "Kubernetes",
      mode: "keep_source",
      aliases: ["K8s", "k eight s", "kates"],
      domain: "cloud_native",
      kind: "product",
      priority: 100
    },
    {
      id: "builtin_nginx",
      source: "NGINX",
      mode: "keep_source",
      aliases: ["engine x"],
      domain: "backend",
      kind: "product",
      priority: 80
    }
  ]);

  assert.equal(phrases.Kubernetes, "Kubernetes");
  assert.equal(phrases["k eight s"], "Kubernetes");
  assert.equal(phrases.kates, "Kubernetes");
  assert.equal(phrases["engine x"], "NGINX");
});
