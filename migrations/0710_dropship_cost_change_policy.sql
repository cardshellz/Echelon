-- 0710: the staff-set policy for .ops cost changes (owner decision of 2026-09-27).
--
-- When Card Shellz changes a .ops cost, vendors get notice before an increase
-- is charged, orders keep the current cost until then, vendors are told what
-- changed on their listings, and each of those choices is a setting staff can
-- change without a deploy. This table holds the settings. The cost schedule
-- and its enforcement arrive in later migrations
-- (docs/DROPSHIP-COST-CHANGE-CONTROLS.md).
--
-- Shape follows dropship.dropship_wallet_policies (0682): versioned and
-- immutable, exactly one active row enforced by a partial unique index; an
-- edit is a NEW VERSION that retires the previous row in the same transaction.
-- Ranges mirror dropshipCostChangePolicySettingsSchema in
-- shared/dropship/cost-change-policy.ts. Every statement is guarded so a
-- re-run is a no-op.

CREATE TABLE IF NOT EXISTS dropship.dropship_cost_change_policies (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  version integer NOT NULL,

  -- Days from the notice of an increase to the day orders are charged it.
  increase_notice_days integer NOT NULL,
  -- 'immediate' or 'after_notice' (the same notice as an increase).
  decrease_timing varchar(20) NOT NULL,
  -- Orders keep the cost in force until an announced increase takes effect.
  price_protection boolean NOT NULL,
  -- A change caused only by a Shopify retail move, under a cost set as a
  -- percentage of retail, gets the same notice (false: applies at once).
  retail_changes_get_notice boolean NOT NULL,

  notify_by_email boolean NOT NULL,
  notify_in_portal boolean NOT NULL,
  notify_on_decrease boolean NOT NULL,
  -- A notice is skipped for a change under either minimum (0 = no minimum).
  -- The change itself is still recorded, scheduled and protected.
  notice_minimum_change_cents integer NOT NULL,
  notice_minimum_change_bps integer NOT NULL,

  -- What happens to listings when an increase takes effect.
  rule_priced_listings varchar(40) NOT NULL,
  below_cost_fixed_listings varchar(40) NOT NULL,

  -- How often live .ops costs are compared with the cost schedule.
  detection_interval_minutes integer NOT NULL,

  is_active boolean NOT NULL DEFAULT true,
  change_note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_actor_type varchar(40) NOT NULL,
  created_by_actor_id varchar(255),
  deactivated_at timestamptz,

  CONSTRAINT dropship_cost_change_policies_version_chk
    CHECK (version > 0),
  -- 90 days = MAX_INCREASE_NOTICE_DAYS.
  CONSTRAINT dropship_cost_change_policies_notice_days_chk
    CHECK (increase_notice_days BETWEEN 0 AND 90),
  CONSTRAINT dropship_cost_change_policies_decrease_timing_chk
    CHECK (decrease_timing IN ('immediate', 'after_notice')),
  -- 100000 cents = MAX_NOTICE_MINIMUM_CHANGE_CENTS; 10000 bps = 100%.
  CONSTRAINT dropship_cost_change_policies_minimum_cents_chk
    CHECK (notice_minimum_change_cents BETWEEN 0 AND 100000),
  CONSTRAINT dropship_cost_change_policies_minimum_bps_chk
    CHECK (notice_minimum_change_bps BETWEEN 0 AND 10000),
  CONSTRAINT dropship_cost_change_policies_rule_priced_chk
    CHECK (rule_priced_listings IN ('reprice_automatically', 'wait_for_review')),
  CONSTRAINT dropship_cost_change_policies_below_cost_chk
    CHECK (below_cost_fixed_listings IN ('no_action', 'warn', 'pause_listing')),
  -- 15 minutes to one day: MIN/MAX_DETECTION_INTERVAL_MINUTES.
  CONSTRAINT dropship_cost_change_policies_interval_chk
    CHECK (detection_interval_minutes BETWEEN 15 AND 1440),
  -- A policy change is an operator decision: it always says why.
  CONSTRAINT dropship_cost_change_policies_change_note_chk
    CHECK (length(btrim(change_note)) BETWEEN 1 AND 1000),
  CONSTRAINT dropship_cost_change_policies_actor_chk
    CHECK (created_by_actor_type IN ('admin', 'system')),
  CONSTRAINT dropship_cost_change_policies_deactivated_chk
    CHECK ((is_active AND deactivated_at IS NULL) OR (NOT is_active AND deactivated_at IS NOT NULL))
);

-- Exactly one active row.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_cost_change_policies_one_active_idx
  ON dropship.dropship_cost_change_policies((true))
  WHERE is_active;

-- Versions are dense and unique; the history is the audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_cost_change_policies_version_idx
  ON dropship.dropship_cost_change_policies(version);

-- Immutability. A published version decided someone's notice and charge: it
-- is never edited in place. The only permitted UPDATE is retirement (active ->
-- inactive, stamping deactivated_at). DELETE is never permitted.
CREATE OR REPLACE FUNCTION dropship.dropship_cost_change_policies_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dropship_cost_change_policies is append-only: rows cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.increase_notice_days IS DISTINCT FROM OLD.increase_notice_days
     OR NEW.decrease_timing IS DISTINCT FROM OLD.decrease_timing
     OR NEW.price_protection IS DISTINCT FROM OLD.price_protection
     OR NEW.retail_changes_get_notice IS DISTINCT FROM OLD.retail_changes_get_notice
     OR NEW.notify_by_email IS DISTINCT FROM OLD.notify_by_email
     OR NEW.notify_in_portal IS DISTINCT FROM OLD.notify_in_portal
     OR NEW.notify_on_decrease IS DISTINCT FROM OLD.notify_on_decrease
     OR NEW.notice_minimum_change_cents IS DISTINCT FROM OLD.notice_minimum_change_cents
     OR NEW.notice_minimum_change_bps IS DISTINCT FROM OLD.notice_minimum_change_bps
     OR NEW.rule_priced_listings IS DISTINCT FROM OLD.rule_priced_listings
     OR NEW.below_cost_fixed_listings IS DISTINCT FROM OLD.below_cost_fixed_listings
     OR NEW.detection_interval_minutes IS DISTINCT FROM OLD.detection_interval_minutes
     OR NEW.change_note IS DISTINCT FROM OLD.change_note
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by_actor_type IS DISTINCT FROM OLD.created_by_actor_type
     OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
  THEN
    RAISE EXCEPTION 'dropship_cost_change_policies is immutable: publish a new version instead of editing one';
  END IF;
  IF NOT (OLD.is_active AND NOT NEW.is_active) THEN
    RAISE EXCEPTION 'dropship_cost_change_policies rows may only be retired (active -> inactive)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dropship_cost_change_policies_guard_trg
  ON dropship.dropship_cost_change_policies;
CREATE TRIGGER dropship_cost_change_policies_guard_trg
  BEFORE UPDATE OR DELETE ON dropship.dropship_cost_change_policies
  FOR EACH ROW EXECUTE FUNCTION dropship.dropship_cost_change_policies_guard();

-- Version 1 is DEFAULT_DROPSHIP_COST_CHANGE_POLICY, so the policy in force is
-- written down from the first deploy and a later change to the code defaults
-- cannot silently change it. Staff confirm or change it in the admin module.
INSERT INTO dropship.dropship_cost_change_policies (
  version,
  increase_notice_days,
  decrease_timing,
  price_protection,
  retail_changes_get_notice,
  notify_by_email,
  notify_in_portal,
  notify_on_decrease,
  notice_minimum_change_cents,
  notice_minimum_change_bps,
  rule_priced_listings,
  below_cost_fixed_listings,
  detection_interval_minutes,
  is_active,
  change_note,
  created_by_actor_type,
  created_by_actor_id
)
SELECT
  1,
  14,
  'immediate',
  true,
  true,
  true,
  true,
  true,
  0,
  0,
  'reprice_automatically',
  'warn',
  60,
  true,
  'Initial defaults from migration 0710. Confirm or change them in Dropship, Cost changes.',
  'system',
  'migration:0710'
WHERE NOT EXISTS (SELECT 1 FROM dropship.dropship_cost_change_policies);
