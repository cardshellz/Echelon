-- Read-model checkpoints only; purchase, money, inventory and points are untouched.
-- The old numeric seek could skip a page-boundary ID. Start a complete scan with
-- the new checkpoints while retaining every saved fact and legacy checkpoint.
-- Separate columns also keep an overlapping older release from advancing the
-- new scan using its numeric seek. Both versions share the existing store lease.
ALTER TABLE oms.customer_account_native_cursors
  ADD COLUMN backfill_checkpoint jsonb,
  ADD COLUMN delta_checkpoint jsonb,
  ADD CONSTRAINT customer_account_backfill_checkpoint_shape CHECK (
    backfill_checkpoint IS NULL OR (jsonb_typeof(backfill_checkpoint)='object'
      AND backfill_checkpoint->>'version'='1' AND backfill_checkpoint->>'kind' IN ('scan','complete')) IS TRUE),
  ADD CONSTRAINT customer_account_delta_checkpoint_shape CHECK (
    delta_checkpoint IS NULL OR (jsonb_typeof(delta_checkpoint)='object'
      AND delta_checkpoint->>'version'='1' AND delta_checkpoint->>'kind'='scan') IS TRUE);
