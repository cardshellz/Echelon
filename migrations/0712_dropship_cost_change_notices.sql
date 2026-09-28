-- 0712: what each recorded .ops cost change did about telling the vendor
-- (docs/DROPSHIP-COST-CHANGE-CONTROLS.md, part C4).
--
-- One row per change log row (0711), written by the notice pass once it has
-- decided under the active policy whether the change is announced to the
-- vendor: sent as part of one grouped notification, or skipped and why. The
-- row is the proof either way. Append-only: a decision is never edited.

CREATE TABLE IF NOT EXISTS dropship.dropship_cost_change_notices (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  log_id bigint NOT NULL REFERENCES dropship.dropship_cost_change_log(id),
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  entry_id bigint NOT NULL REFERENCES dropship.dropship_cost_schedule_entries(id),
  -- The change log event the decision is about.
  event_type varchar(40) NOT NULL,
  -- 'sent', or why nothing was sent.
  decision varchar(40) NOT NULL,
  -- What the vendor was told, when sent: an announced change, one applied at
  -- once, or an update to a change announced earlier.
  notice_kind varchar(20),
  notice_event_type varchar(80),
  -- The grouped notification's key (one per vendor, reading and kind).
  idempotency_key varchar(200),
  policy_id integer REFERENCES dropship.dropship_cost_change_policies(id),
  decided_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dropship_cost_change_notices_event_chk
    CHECK (event_type IN ('baseline', 'increase_announced', 'increase_applied', 'decrease_announced', 'decrease_applied', 'increase_reduced', 'change_withdrawn')),
  CONSTRAINT dropship_cost_change_notices_decision_chk
    CHECK (decision IN ('sent', 'skipped_baseline', 'skipped_decrease', 'skipped_below_minimum', 'skipped_channels_off', 'skipped_unannounced')),
  CONSTRAINT dropship_cost_change_notices_kind_chk
    CHECK (notice_kind IS NULL OR notice_kind IN ('announced', 'applied', 'updated')),
  -- A sent notice names what was sent and under which key; a skip names neither.
  CONSTRAINT dropship_cost_change_notices_sent_chk
    CHECK (
      (decision = 'sent' AND notice_kind IS NOT NULL AND notice_event_type IS NOT NULL AND idempotency_key IS NOT NULL)
      OR (decision <> 'sent' AND notice_kind IS NULL AND notice_event_type IS NULL AND idempotency_key IS NULL)
    )
);

-- One decision per change log row; the notice pass replays safely on it.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_cost_change_notices_log_idx
  ON dropship.dropship_cost_change_notices(log_id);
-- A vendor's notices, and whether an entry's announcement was ever sent.
CREATE INDEX IF NOT EXISTS dropship_cost_change_notices_vendor_idx
  ON dropship.dropship_cost_change_notices(vendor_id, decided_at);
CREATE INDEX IF NOT EXISTS dropship_cost_change_notices_entry_idx
  ON dropship.dropship_cost_change_notices(entry_id)
  WHERE decision = 'sent';

-- Append-only: a decision is never edited or deleted.
CREATE OR REPLACE FUNCTION dropship.dropship_cost_change_notices_guard()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'dropship_cost_change_notices is append-only: rows cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dropship_cost_change_notices_guard_trg
  ON dropship.dropship_cost_change_notices;
CREATE TRIGGER dropship_cost_change_notices_guard_trg
  BEFORE UPDATE OR DELETE ON dropship.dropship_cost_change_notices
  FOR EACH ROW EXECUTE FUNCTION dropship.dropship_cost_change_notices_guard();
