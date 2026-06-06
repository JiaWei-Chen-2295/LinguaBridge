import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("desktop capability allows subtitle overlay window controls", async () => {
  const capabilityPath = path.resolve(
    "src-tauri",
    "capabilities",
    "default.json"
  );
  const capability = JSON.parse(await readFile(capabilityPath, "utf8")) as {
    permissions?: string[];
  };
  const permissions = new Set(capability.permissions ?? []);

  assert.equal(permissions.has("core:window:allow-hide"), true);
  assert.equal(permissions.has("core:window:allow-show"), true);
  assert.equal(permissions.has("core:window:allow-set-focus"), true);
  assert.equal(permissions.has("core:window:allow-start-dragging"), true);
});
