-- catalog.products / catalog.product_variants eBay policy override columns:
-- widen to varchar(100), the width declared by shared/schema and by
-- 051_ensure_catalog_columns.sql.
--
-- History: production has these six columns as varchar(20) because the legacy
-- schema fallback routine in server/db.ts created them (as VARCHAR(20)) before
-- 051 ran, so 051's ADD COLUMN IF NOT EXISTS ... VARCHAR(100) did nothing.
-- 900000012000018420001_ebay_category_policy_identity_capacity.sql already
-- widened the matching ebay.ebay_category_mappings columns to 100. The fallback
-- block is retired (REFACTOR-PLAN-2026-07.md P4.1), so the width is settled here.
--
-- Widening a varchar preserves every stored value and does not rewrite the
-- table. The catalog is checked first: a table whose three columns are already
-- 100 wide or more is not altered and takes no lock. A table that needs
-- widening takes one ACCESS EXCLUSIVE lock for all three columns.
DO $$
DECLARE
  target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['products', 'product_variants'] LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'catalog'
        AND table_name = target_table
        AND column_name IN (
          'ebay_fulfillment_policy_override',
          'ebay_return_policy_override',
          'ebay_payment_policy_override'
        )
        AND character_maximum_length < 100
    ) THEN
      EXECUTE format(
        'ALTER TABLE catalog.%I
           ALTER COLUMN ebay_fulfillment_policy_override TYPE varchar(100),
           ALTER COLUMN ebay_return_policy_override TYPE varchar(100),
           ALTER COLUMN ebay_payment_policy_override TYPE varchar(100)',
        target_table
      );
    END IF;
  END LOOP;
END $$;
