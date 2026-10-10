-- 0738: a kind on each stored price review (Listing settings redesign, M4 /
-- PR 8): store_default (a store default price change, today's only kind),
-- category_price (one Card Shellz category) and product_prices (many
-- products). The kind is a column, never part of the hashed input, because
-- the stored input is parsed strictly by the store default review loader.
--
-- Nothing changes for live data. Every existing review reads as
-- store_default, and code deployed before this file keeps working: it inserts
-- reviews without a kind, so they take the default. The store default loader
-- shipped with this file loads only store_default reviews, so a review of
-- another kind (written from PR 9 on) is never parsed as a store review.
--
-- Row triggers do not fire for ALTER TABLE, so the review immutability
-- trigger (0659) needs no change. A constant default adds the column without
-- rewriting the table (PostgreSQL 11 and later).
--
-- Lock: ALTER TABLE takes ACCESS EXCLUSIVE on the reviews table until commit,
-- and the CHECK scans the table once, so a pricing review or apply on an old
-- dyno waits for it. This file touches no other table.
--
-- The release executor owns the transaction, including its migration record.
-- Re-runnable: the column is added if missing, and the check is dropped if
-- present and added again.

ALTER TABLE dropship.dropship_pricing_reviews
  ADD COLUMN IF NOT EXISTS kind varchar(30) NOT NULL DEFAULT 'store_default';

ALTER TABLE dropship.dropship_pricing_reviews
  DROP CONSTRAINT IF EXISTS dropship_pricing_review_kind_chk;
ALTER TABLE dropship.dropship_pricing_reviews
  ADD CONSTRAINT dropship_pricing_review_kind_chk
  CHECK (kind IN ('store_default', 'category_price', 'product_prices'));
