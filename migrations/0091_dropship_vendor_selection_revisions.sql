CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_selection_rule_set_revisions (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(128) NOT NULL,
  actor_type varchar(40) NOT NULL,
  actor_id varchar(255),
  rule_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_selection_rule_rev_actor_chk CHECK (actor_type IN ('vendor','admin','system')),
  CONSTRAINT dropship_selection_rule_rev_count_chk CHECK (rule_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_selection_rule_rev_vendor_idem_idx
  ON dropship.dropship_vendor_selection_rule_set_revisions(vendor_id, idempotency_key);

CREATE INDEX IF NOT EXISTS dropship_selection_rule_rev_vendor_created_idx
  ON dropship.dropship_vendor_selection_rule_set_revisions(vendor_id, created_at);

ALTER TABLE dropship.dropship_vendor_selection_rules
  ADD COLUMN IF NOT EXISTS revision_id integer
  REFERENCES dropship.dropship_vendor_selection_rule_set_revisions(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS dropship_selection_rules_revision_idx
  ON dropship.dropship_vendor_selection_rules(revision_id);
