CREATE TABLE IF NOT EXISTS dropship.dropship_catalog_rule_set_revisions (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(128) NOT NULL,
  actor_type varchar(40) NOT NULL,
  actor_id varchar(255),
  rule_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_catalog_rule_rev_actor_chk CHECK (actor_type IN ('admin','system')),
  CONSTRAINT dropship_catalog_rule_rev_count_chk CHECK (rule_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_catalog_rule_rev_idem_idx
  ON dropship.dropship_catalog_rule_set_revisions(idempotency_key);

CREATE INDEX IF NOT EXISTS dropship_catalog_rule_rev_created_idx
  ON dropship.dropship_catalog_rule_set_revisions(created_at);

ALTER TABLE dropship.dropship_catalog_rules
  ADD COLUMN IF NOT EXISTS revision_id integer
  REFERENCES dropship.dropship_catalog_rule_set_revisions(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS dropship_catalog_rules_revision_idx
  ON dropship.dropship_catalog_rules(revision_id);
