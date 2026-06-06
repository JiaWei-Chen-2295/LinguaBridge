import assert from "node:assert/strict";
import { test } from "node:test";
import { pgCompatibilityMigrationStatements } from "./pg-store";

test("PostgreSQL compatibility migration repairs P0 schema drift", () => {
  const sql = pgCompatibilityMigrationStatements().join("\n");

  assert.match(sql, /ALTER TABLE term_entries/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS domain text/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS kind text/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS priority integer/u);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS usage_events_event_type_check/u);
  assert.match(sql, /ADD CONSTRAINT usage_events_event_type_check/u);
  assert.match(sql, /'session_metadata'/u);
  assert.match(sql, /'interpretation_audio_storage'/u);
});
