-- Transient capture artifacts, NOT opening attestations or inventory authority.
-- One capture globally bounds the database load and prevents overlapping snapshots.
CREATE TABLE inventory.opening_capture_worker (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  heartbeat_at timestamptz NOT NULL
);
CREATE TABLE inventory.opening_capture_jobs (
  id uuid PRIMARY KEY,
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  request_key uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','complete','failed')),
  stage text NOT NULL CHECK (length(stage) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count BETWEEN 0 AND 2048),
  error_code text CHECK (length(error_code) <= 100),
  UNIQUE (actor,request_key),
  CHECK ((state IN ('complete','failed')) = (completed_at IS NOT NULL)),
  CHECK (state <> 'complete' OR (chunk_count > 0 AND error_code IS NULL)),
  CHECK (state <> 'failed' OR error_code IS NOT NULL)
);
CREATE UNIQUE INDEX opening_capture_one_active ON inventory.opening_capture_jobs ((true)) WHERE state IN ('queued','running');
CREATE TABLE inventory.opening_capture_chunks (
  capture_id uuid NOT NULL REFERENCES inventory.opening_capture_jobs(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 2047),
  content text NOT NULL CHECK (length(content) <= 32768 AND octet_length(content) <= 131072),
  PRIMARY KEY (capture_id,chunk_index)
);
