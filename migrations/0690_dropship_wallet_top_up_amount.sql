-- Dropship wallet funding design, phase 5: "keep $X" as the one setting.
--
-- The vendor keeps one number, the minimum balance (minimum_balance_cents).
-- An optional top-up amount says how much each automatic refill pulls, so a
-- vendor who wants fewer pulls can take bigger ones; NULL pulls the minimum.
-- max_single_reload_cents stays the per-charge bound, now derived by the
-- server as max(minimum, top-up) when the client sends none
-- (server/modules/dropship/domain/autopay-refill.ts).
ALTER TABLE dropship.dropship_auto_reload_settings
  ADD COLUMN IF NOT EXISTS top_up_amount_cents bigint;

ALTER TABLE dropship.dropship_auto_reload_settings
  DROP CONSTRAINT IF EXISTS dropship_auto_reload_top_up_chk;
ALTER TABLE dropship.dropship_auto_reload_settings
  ADD CONSTRAINT dropship_auto_reload_top_up_chk
    CHECK (top_up_amount_cents IS NULL OR top_up_amount_cents > 0);

COMMENT ON COLUMN dropship.dropship_auto_reload_settings.top_up_amount_cents IS
  'What each automatic refill pulls, in cents; NULL pulls the minimum balance. A refill pulls more only when this alone would not reach the minimum, and never more than max_single_reload_cents (migration 0690).';
