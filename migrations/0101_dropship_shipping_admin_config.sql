-- Dropship V2 admin shipping configuration command ledger.
-- Canonical design: DROPSHIP-V2-CONSOLIDATED-DESIGN.md

CREATE TABLE IF NOT EXISTS dropship.dropship_admin_config_commands (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  command_type varchar(100) NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(128) NOT NULL,
  entity_type varchar(100) NOT NULL,
  entity_id varchar(255),
  actor_type varchar(40) NOT NULL,
  actor_id varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT dropship_admin_config_command_actor_chk CHECK (actor_type IN ('admin','system'))
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_admin_config_command_idem_idx
  ON dropship.dropship_admin_config_commands(idempotency_key);

CREATE INDEX IF NOT EXISTS dropship_admin_config_command_type_created_idx
  ON dropship.dropship_admin_config_commands(command_type, created_at DESC);
