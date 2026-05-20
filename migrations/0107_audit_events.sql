CREATE TABLE IF NOT EXISTS "audit_events" (
  "id" bigserial PRIMARY KEY,
  "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
  "level" text DEFAULT 'AUDIT' NOT NULL,
  "actor" text NOT NULL,
  "action" text NOT NULL,
  "target" text,
  "changes" jsonb,
  "context" jsonb
);

CREATE INDEX IF NOT EXISTS "audit_events_action_timestamp_idx"
  ON "audit_events" ("action", "timestamp" DESC);

CREATE INDEX IF NOT EXISTS "audit_events_target_timestamp_idx"
  ON "audit_events" ("target", "timestamp" DESC);
