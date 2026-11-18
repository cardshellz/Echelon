-- retire_inventory_sales_statuses
--
-- Sales status is retired (owner decision 2026-11-10: zero is Max 0 in the
-- stock rules; there is no separate "stop selling" concept). The release that
-- carries this migration no longer reads inventory.sales_statuses when it
-- calculates what a channel is sent, so any SKU still stopped here would
-- start selling again the moment that release goes live.
--
-- 1. Refuse the release while any stopped setting remains. The release runner
--    applies each migration in its own transaction and stops on error, so the
--    old release (which still honours the table) keeps running. The operator
--    converts each stop to a Max 0 stock rule on the product's Channels tab,
--    sets the sales status back to Selling, and redeploys.
--
-- 2. Freeze the table. The previous release stays live for the rest of the
--    release phase and still offers "Stop"; a stop written in that window
--    would be silently ignored by the new release. CHECK (false) NOT VALID
--    refuses every new or changed row and leaves existing rows alone (only
--    "selling" channel exceptions can remain, and with no stop they have no
--    effect). Deleting a row, which is how the old release resumes selling,
--    still works.
--
-- Kept on purpose: inventory.sales_status_events, the append-only history of
-- every stop and resume, and the settings table itself. Nothing is dropped and
-- no existing row is changed.

LOCK TABLE inventory.sales_statuses IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  stopped_count bigint;
BEGIN
  SELECT count(*) INTO stopped_count FROM inventory.sales_statuses WHERE status = 'stopped';
  IF stopped_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'SALES_STATUS_STOPS_REMAIN',
      DETAIL = format('%s stopped sales status setting(s) remain in inventory.sales_statuses.', stopped_count),
      HINT = 'Set Max 0 in the stock rule for each stopped product or SKU on every channel, set its sales status back to Selling, then deploy again.';
  END IF;
END;
$$;

ALTER TABLE inventory.sales_statuses
  ADD CONSTRAINT sales_statuses_retired_chk CHECK (false) NOT VALID;

COMMENT ON CONSTRAINT sales_statuses_retired_chk ON inventory.sales_statuses IS
  'Sales status is retired: nothing reads this table, so no setting may be added or changed. Stop a SKU on a channel with a Max 0 stock rule.';

COMMENT ON TABLE inventory.sales_statuses IS
  'RETIRED 2026-11. Frozen by sales_statuses_retired_chk and read by nothing. A SKU is stopped on a channel with a Max 0 stock rule (inventory.channel_exposure_policy_versions). History: inventory.sales_status_events.';
