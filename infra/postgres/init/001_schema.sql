CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text UNIQUE,
  phone text UNIQUE,
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  quota_minutes integer NOT NULL CHECK (quota_minutes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invite_batches (
  id text PRIMARY KEY,
  name text NOT NULL,
  quota_minutes integer NOT NULL CHECK (quota_minutes >= 0),
  max_uses integer NOT NULL CHECK (max_uses > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
  id text PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  batch_id text NOT NULL REFERENCES invite_batches(id),
  status text NOT NULL CHECK (status IN ('available', 'activated', 'expired')),
  activated_by text REFERENCES users(id),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS realtime_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  source_lang text NOT NULL,
  target_lang text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'completed', 'interrupted')),
  device_label text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0)
);

CREATE TABLE IF NOT EXISTS session_audio_objects (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES realtime_sessions(id) ON DELETE CASCADE,
  oss_key text NOT NULL,
  format text NOT NULL,
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subtitle_segments (
  session_id text NOT NULL REFERENCES realtime_sessions(id) ON DELETE CASCADE,
  segment_id text NOT NULL,
  start_ms integer NOT NULL CHECK (start_ms >= 0),
  end_ms integer NOT NULL CHECK (end_ms >= start_ms),
  source_text text NOT NULL,
  target_text text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'final', 'revised')),
  revision integer NOT NULL CHECK (revision > 0),
  confidence numeric NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  terms_hit text[] NOT NULL DEFAULT ARRAY[]::text[],
  latency_ms integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, segment_id)
);

ALTER TABLE IF EXISTS subtitle_segments
  ADD COLUMN IF NOT EXISTS confidence numeric NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1);

CREATE TABLE IF NOT EXISTS term_entries (
  id text PRIMARY KEY,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL,
  target text,
  mode text NOT NULL CHECK (mode IN ('keep_source', 'fixed_translation')),
  aliases text[] NOT NULL DEFAULT ARRAY[]::text[],
  domain text,
  kind text,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (mode = 'keep_source' AND target IS NULL)
    OR (mode = 'fixed_translation' AND target IS NOT NULL)
  )
);

ALTER TABLE term_entries
  ADD COLUMN IF NOT EXISTS domain text,
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS segment_revisions (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES realtime_sessions(id) ON DELETE CASCADE,
  segment_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('draft', 'final', 'revised')),
  source_text text NOT NULL,
  target_text text NOT NULL,
  reason text NOT NULL,
  model_trace jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_events (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  session_id text REFERENCES realtime_sessions(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (
    event_type IN (
      'asr_audio_duration',
      'mt_input_tokens',
      'mt_output_tokens',
      'revision_tokens',
      'oss_audio_storage',
      'interpretation_audio_duration',
      'interpretation_audio_storage',
      'session_realtime_duration',
      'session_metadata',
      'session_interruption'
    )
  ),
  amount numeric NOT NULL CHECK (amount >= 0),
  unit text NOT NULL CHECK (unit IN ('milliseconds', 'tokens', 'bytes', 'count')),
  model text,
  cost_estimate numeric,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invites_batch_id ON invites(batch_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON realtime_sessions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_audio_objects_session_key
  ON session_audio_objects(session_id, oss_key);
CREATE INDEX IF NOT EXISTS idx_segments_session_time ON subtitle_segments(session_id, start_ms);
CREATE INDEX IF NOT EXISTS idx_revisions_session_segment ON segment_revisions(session_id, segment_id);
CREATE INDEX IF NOT EXISTS idx_term_entries_user_source ON term_entries(user_id, source);
CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON usage_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_session_created ON usage_events(session_id, created_at);

CREATE OR REPLACE FUNCTION prevent_usage_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.id = NEW.id
     AND OLD.user_id = NEW.user_id
     AND OLD.event_type = NEW.event_type
     AND OLD.amount = NEW.amount
     AND OLD.unit = NEW.unit
     AND OLD.model IS NOT DISTINCT FROM NEW.model
     AND OLD.cost_estimate IS NOT DISTINCT FROM NEW.cost_estimate
     AND OLD.created_at = NEW.created_at
     AND OLD.session_id IS NOT NULL
     AND NEW.session_id IS NULL
     AND NEW.metadata = OLD.metadata || '{"deletedSession": true}'::jsonb THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'usage_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS usage_events_no_update ON usage_events;
CREATE TRIGGER usage_events_no_update
BEFORE UPDATE OR DELETE ON usage_events
FOR EACH ROW EXECUTE FUNCTION prevent_usage_event_mutation();

INSERT INTO invite_batches (id, name, quota_minutes, max_uses, expires_at)
VALUES ('batch_alpha_dev', 'Alpha dev seed', 180, 1, '2026-12-31T23:59:59Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO invites (id, code_hash, batch_id, status)
VALUES (
  'inv_alpha_dev',
  encode(digest('ALPHA-DEV-2026', 'sha256'), 'hex'),
  'batch_alpha_dev',
  'available'
)
ON CONFLICT (id) DO NOTHING;
