import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTermPolicy,
  mergeTermEntries,
  normalizeTechnicalSourceText,
  protectTechnicalEntities
} from "./terms";

test("detects computer-course code entities that must not be translated", () => {
  const entities = protectTechnicalEntities(
    "Run kubectl apply -f deployment.yaml, then call getUserById() inside useEffect."
  );

  assert.deepEqual(
    entities.map((entity) => entity.text),
    ["kubectl apply -f deployment.yaml", "getUserById()", "useEffect"]
  );
});

test("keeps detected code entities in the translated subtitle", () => {
  const constrained = applyTermPolicy(
    "Set isLoading to false after getUserById() resolves.",
    "在用户请求完成后将加载状态设为 false。",
    []
  );

  assert.match(constrained.targetText, /isLoading/u);
  assert.match(constrained.targetText, /getUserById\(\)/u);
  assert.deepEqual(constrained.termsHit, ["isLoading", "getUserById()"]);
});

test("ships a broad computer-course glossary with spoken aliases", () => {
  const entries = mergeTermEntries([]);

  assert.ok(
    entries.length >= 250,
    `Expected at least 250 built-in computer terms, got ${entries.length}.`
  );
  assert.deepEqual(
    entries.find((entry) => entry.source === "Kubernetes")?.aliases,
    ["K8s", "k eight s", "kates", "kube"]
  );
  assert.ok(
    entries
      .find((entry) => entry.source === "kubectl")
      ?.aliases.includes("cube control")
  );
  assert.ok(
    entries
      .find((entry) => entry.source === "NGINX")
      ?.aliases.includes("engine x")
  );
});

test("normalizes spoken ASR aliases to canonical computer terms", () => {
  const normalized = normalizeTechnicalSourceText(
    "We deploy to k eight s through engine x.",
    mergeTermEntries([])
  );

  assert.equal(normalized, "We deploy to Kubernetes through NGINX.");
});
