-- 0711: the .ops cost schedule per vendor and variant, its change log, and the
-- detection worker's state (docs/DROPSHIP-COST-CHANGE-CONTROLS.md, part C2).
--
-- A vendor's .ops cost can change at any time in Shellz Club. The detection
-- worker compares each listed variant's live cost with this schedule and
-- records what changed, when it takes effect under the active policy
-- (migration 0710), and the reading that caused it. Later parts charge the
-- cost in force (C3), tell vendors (C4) and act on listings (C5) from these
-- rows. Money is integer cents. Every statement is guarded so a re-run is a
-- no-op.

-- One row per schedule entry. The cost in force at a moment is the latest
-- non-withdrawn entry whose effective_at has passed; later entries are
-- announced changes (domain/cost-schedule.ts). Entries are never deleted:
-- an announced change that no longer holds is withdrawn (stamped), and an
-- announced increase may only ever be lowered.
CREATE TABLE IF NOT EXISTS dropship.dropship_cost_schedule_entries (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  -- 'baseline' starts a schedule; 'increase' and 'decrease' change it from from_cents.
  kind varchar(20) NOT NULL,
  from_cents bigint,
  unit_cost_cents bigint NOT NULL,
  effective_at timestamptz NOT NULL,
  -- The live reading that created the entry: when it was taken, the policy
  -- version that dated it, and where the cost came from (retail basis and
  -- discount let a later reading tell a Shopify retail move from a plan change).
  observed_at timestamptz NOT NULL,
  policy_id integer REFERENCES dropship.dropship_cost_change_policies(id),
  cost_source varchar(40) NOT NULL,
  plan_id varchar(255) NOT NULL,
  override_id varchar(255),
  retail_price_cents bigint,
  discount_bps integer,
  -- Which writer took the reading: the detection worker, or an order
  -- acceptance reconciling the schedule under the same vendor lock (C3).
  recorded_by varchar(20) NOT NULL,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dropship_cost_schedule_entries_kind_chk
    CHECK (kind IN ('baseline', 'increase', 'decrease')),
  CONSTRAINT dropship_cost_schedule_entries_recorded_by_chk
    CHECK (recorded_by IN ('detection', 'acceptance')),
  CONSTRAINT dropship_cost_schedule_entries_cost_chk
    CHECK (unit_cost_cents > 0),
  -- A change says what it changes from, in its direction; a baseline changes
  -- nothing. NULL is named explicitly: a NULL comparison would pass a CHECK.
  CONSTRAINT dropship_cost_schedule_entries_from_chk
    CHECK (
      (kind = 'baseline' AND from_cents IS NULL)
      OR (kind = 'increase' AND from_cents IS NOT NULL AND from_cents > 0 AND unit_cost_cents > from_cents)
      OR (kind = 'decrease' AND from_cents IS NOT NULL AND from_cents > 0 AND unit_cost_cents < from_cents)
    ),
  CONSTRAINT dropship_cost_schedule_entries_effective_chk
    CHECK (effective_at >= observed_at),
  CONSTRAINT dropship_cost_schedule_entries_source_chk
    CHECK (cost_source IN ('variant_fixed_price', 'variant_percent', 'plan_percent', 'retail')),
  -- The retail basis and its discount are recorded together or not at all.
  CONSTRAINT dropship_cost_schedule_entries_basis_chk
    CHECK ((retail_price_cents IS NULL) = (discount_bps IS NULL)),
  CONSTRAINT dropship_cost_schedule_entries_retail_chk
    CHECK (retail_price_cents IS NULL OR retail_price_cents >= 0),
  -- 10000 bps = 100%.
  CONSTRAINT dropship_cost_schedule_entries_bps_chk
    CHECK (discount_bps IS NULL OR discount_bps BETWEEN 0 AND 10000),
  CONSTRAINT dropship_cost_schedule_entries_withdrawn_chk
    CHECK (withdrawn_at IS NULL OR withdrawn_at >= observed_at)
);

-- The schedule of one vendor and variant, and everything due by a date.
CREATE INDEX IF NOT EXISTS dropship_cost_schedule_entries_active_idx
  ON dropship.dropship_cost_schedule_entries(vendor_id, product_variant_id, effective_at)
  WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS dropship_cost_schedule_entries_effective_idx
  ON dropship.dropship_cost_schedule_entries(effective_at)
  WHERE withdrawn_at IS NULL;

-- Immutability. An entry decided what a vendor was told and what an order is
-- charged. The only permitted changes are a withdrawal (stamping withdrawn_at,
-- once) and lowering an announced increase; DELETE is never permitted.
CREATE OR REPLACE FUNCTION dropship.dropship_cost_schedule_entries_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dropship_cost_schedule_entries is append-only: rows cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
     OR NEW.product_variant_id IS DISTINCT FROM OLD.product_variant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.from_cents IS DISTINCT FROM OLD.from_cents
     OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
     OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
     OR NEW.cost_source IS DISTINCT FROM OLD.cost_source
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.override_id IS DISTINCT FROM OLD.override_id
     OR NEW.retail_price_cents IS DISTINCT FROM OLD.retail_price_cents
     OR NEW.discount_bps IS DISTINCT FROM OLD.discount_bps
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'dropship_cost_schedule_entries is immutable: only withdrawn_at and a lowered unit_cost_cents may change';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'dropship_cost_schedule_entries: a withdrawn entry cannot change';
  END IF;
  IF NEW.withdrawn_at IS NOT NULL THEN
    IF NEW.unit_cost_cents IS DISTINCT FROM OLD.unit_cost_cents THEN
      RAISE EXCEPTION 'dropship_cost_schedule_entries: a withdrawal cannot change the cost';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.kind <> 'increase' OR NEW.unit_cost_cents >= OLD.unit_cost_cents THEN
    RAISE EXCEPTION 'dropship_cost_schedule_entries: an entry may only be withdrawn, or lowered when it is an announced increase';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dropship_cost_schedule_entries_guard_trg
  ON dropship.dropship_cost_schedule_entries;
CREATE TRIGGER dropship_cost_schedule_entries_guard_trg
  BEFORE UPDATE OR DELETE ON dropship.dropship_cost_schedule_entries
  FOR EACH ROW EXECUTE FUNCTION dropship.dropship_cost_schedule_entries_guard();

-- The change log: one row per operation the detection worker applied, with
-- the reading that caused it. This is the financial history; the entries
-- table is the current schedule it produces. For 'change_withdrawn',
-- from_cents is the amount that had been announced and to_cents is null.
CREATE TABLE IF NOT EXISTS dropship.dropship_cost_change_log (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  entry_id bigint NOT NULL REFERENCES dropship.dropship_cost_schedule_entries(id),
  event_type varchar(40) NOT NULL,
  from_cents bigint,
  to_cents bigint,
  effective_at timestamptz NOT NULL,
  -- Only the Shopify retail price moved under a retail-based cost.
  retail_driven boolean NOT NULL,
  observed_at timestamptz NOT NULL,
  policy_id integer REFERENCES dropship.dropship_cost_change_policies(id),
  cost_source varchar(40) NOT NULL,
  plan_id varchar(255) NOT NULL,
  override_id varchar(255),
  retail_price_cents bigint,
  discount_bps integer,
  recorded_by varchar(20) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dropship_cost_change_log_recorded_by_chk
    CHECK (recorded_by IN ('detection', 'acceptance')),
  CONSTRAINT dropship_cost_change_log_event_chk
    CHECK (event_type IN ('baseline', 'increase_announced', 'increase_applied', 'decrease_announced', 'decrease_applied', 'increase_reduced', 'change_withdrawn')),
  -- NULL is named explicitly: a NULL comparison would pass a CHECK.
  CONSTRAINT dropship_cost_change_log_amounts_chk
    CHECK (
      (event_type = 'baseline' AND from_cents IS NULL AND to_cents IS NOT NULL AND to_cents > 0)
      OR (event_type = 'change_withdrawn' AND from_cents IS NOT NULL AND from_cents > 0 AND to_cents IS NULL)
      OR (event_type NOT IN ('baseline', 'change_withdrawn') AND from_cents IS NOT NULL AND to_cents IS NOT NULL
          AND from_cents > 0 AND to_cents > 0 AND to_cents <> from_cents)
    ),
  CONSTRAINT dropship_cost_change_log_source_chk
    CHECK (cost_source IN ('variant_fixed_price', 'variant_percent', 'plan_percent', 'retail')),
  CONSTRAINT dropship_cost_change_log_basis_chk
    CHECK ((retail_price_cents IS NULL) = (discount_bps IS NULL)),
  CONSTRAINT dropship_cost_change_log_retail_chk
    CHECK (retail_price_cents IS NULL OR retail_price_cents >= 0),
  CONSTRAINT dropship_cost_change_log_bps_chk
    CHECK (discount_bps IS NULL OR discount_bps BETWEEN 0 AND 10000)
);

CREATE INDEX IF NOT EXISTS dropship_cost_change_log_variant_idx
  ON dropship.dropship_cost_change_log(vendor_id, product_variant_id, id);

-- Append-only: a log row is never edited or deleted.
CREATE OR REPLACE FUNCTION dropship.dropship_cost_change_log_guard()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'dropship_cost_change_log is append-only: rows cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dropship_cost_change_log_guard_trg
  ON dropship.dropship_cost_change_log;
CREATE TRIGGER dropship_cost_change_log_guard_trg
  BEFORE UPDATE OR DELETE ON dropship.dropship_cost_change_log
  FOR EACH ROW EXECUTE FUNCTION dropship.dropship_cost_change_log_guard();

-- The detection worker's one row of state: which pass it is on, how far
-- through the vendors it is, and what the current or last pass did. A pass
-- walks every active or paused vendor in id order; the cursor lets a pass
-- span ticks and resume after a restart, so no vendor is skipped.
CREATE TABLE IF NOT EXISTS dropship.dropship_cost_detection_state (
  id integer PRIMARY KEY,
  pass_number bigint NOT NULL DEFAULT 0,
  pass_started_at timestamptz,
  pass_completed_at timestamptz,
  -- The last vendor processed in the pass under way; null before the first vendor and once the pass completes.
  cursor_vendor_id integer,
  policy_id integer REFERENCES dropship.dropship_cost_change_policies(id),
  pass_vendors_processed integer NOT NULL DEFAULT 0,
  pass_variants_read integer NOT NULL DEFAULT 0,
  pass_unavailable_readings integer NOT NULL DEFAULT 0,
  pass_changes_recorded integer NOT NULL DEFAULT 0,
  last_tick_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dropship_cost_detection_state_singleton_chk
    CHECK (id = 1),
  CONSTRAINT dropship_cost_detection_state_counts_chk
    CHECK (pass_vendors_processed >= 0 AND pass_variants_read >= 0 AND pass_unavailable_readings >= 0 AND pass_changes_recorded >= 0),
  CONSTRAINT dropship_cost_detection_state_pass_chk
    CHECK (pass_number >= 0 AND (pass_completed_at IS NULL OR pass_started_at IS NOT NULL))
);

INSERT INTO dropship.dropship_cost_detection_state (id)
SELECT 1
WHERE NOT EXISTS (SELECT 1 FROM dropship.dropship_cost_detection_state);
