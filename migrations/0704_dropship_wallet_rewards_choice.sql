-- 0704: rewards are used only when the vendor chooses (funding design phase 7,
-- owner decision of 2026-09-24).
--
-- Rewards points are spent only on .ops dropship orders, and only once the
-- vendor has chosen to auto-apply them; until they choose, the points are
-- saved. Auto-apply is therefore never a default: the choice column becomes
-- nullable with no default, NULL meaning "not chosen yet", which every reader
-- treats as saving. Rows that carried the old default (true) without a
-- recorded choice are reset to NULL, since nobody chose; a row whose vendor
-- did choose (a `wallet_rewards_preference_saved` audit event exists) keeps
-- its value.
--
-- Every statement is guarded so a re-run is a no-op: the reset only touches
-- rows still carrying a value without a recorded choice, which a first run
-- leaves empty.

ALTER TABLE dropship.dropship_auto_reload_settings
  ALTER COLUMN spend_rewards_first DROP NOT NULL;
ALTER TABLE dropship.dropship_auto_reload_settings
  ALTER COLUMN spend_rewards_first DROP DEFAULT;

UPDATE dropship.dropship_auto_reload_settings AS settings
SET spend_rewards_first = NULL
WHERE settings.spend_rewards_first IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM dropship.dropship_audit_events AS events
    WHERE events.vendor_id = settings.vendor_id
      AND events.entity_type = 'dropship_auto_reload_settings'
      AND events.event_type = 'wallet_rewards_preference_saved'
  );

COMMENT ON COLUMN dropship.dropship_auto_reload_settings.spend_rewards_first IS
  'The vendor''s choice for their rewards points: true auto-applies them to each order before cash, false saves them, NULL means not chosen yet and reads as saved (migration 0704; the default of true from 0702 is gone).';
