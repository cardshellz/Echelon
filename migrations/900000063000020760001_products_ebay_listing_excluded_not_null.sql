-- catalog.products.ebay_listing_excluded: bring tracked migrations in line with
-- production and shared/schema (boolean NOT NULL DEFAULT false).
--
-- History: 051_ensure_catalog_columns.sql adds this column as a nullable
-- `BOOLEAN DEFAULT FALSE`. Production has it NOT NULL only because the legacy
-- schema fallback routine in server/db.ts created it first. That fallback block
-- is retired (REFACTOR-PLAN-2026-07.md P4.1), so the definition lives here.
--
-- The catalog is checked before any ALTER TABLE, so where the column is
-- already NOT NULL (production) this takes no lock on catalog.products.
--
-- NULL rows are not rewritten here: an UPDATE of this column fires the
-- publication-selection gate and listing-intent triggers, which is a business
-- change that must not happen as a side effect of a schema migration. If any
-- exist the migration stops with a clear error instead.
DO $$
DECLARE
  column_nullable text;
BEGIN
  SELECT is_nullable INTO column_nullable
  FROM information_schema.columns
  WHERE table_schema = 'catalog'
    AND table_name = 'products'
    AND column_name = 'ebay_listing_excluded';

  IF column_nullable IS NULL THEN
    ALTER TABLE catalog.products
      ADD COLUMN ebay_listing_excluded boolean NOT NULL DEFAULT false;
  ELSIF column_nullable = 'YES' THEN
    IF EXISTS (SELECT 1 FROM catalog.products WHERE ebay_listing_excluded IS NULL) THEN
      RAISE EXCEPTION 'catalog.products.ebay_listing_excluded has NULL rows; set them explicitly before this migration can enforce NOT NULL'
        USING ERRCODE = 'not_null_violation';
    END IF;
    ALTER TABLE catalog.products ALTER COLUMN ebay_listing_excluded SET DEFAULT false;
    ALTER TABLE catalog.products ALTER COLUMN ebay_listing_excluded SET NOT NULL;
  END IF;
END $$;
