-- Two things production has only because the legacy schema fallback in
-- server/db.ts declared them. No tracked migration did, so a database built
-- from migrations alone would lack both. The fallback blocks are retired in the
-- same change (REFACTOR-PLAN P4.1).
--
-- In production both statements change nothing: all 16 rows exist and the
-- check constraint exists.

-- 1. Product type reference rows. Product import classifies products by these
--    slugs (server/modules/catalog/product-import.service.ts).
INSERT INTO catalog.product_types (slug, name, sort_order) VALUES
  ('toploaders', 'Toploaders', 1),
  ('easy-glide-sleeves', 'Easy Glide Soft Sleeves', 2),
  ('magnetic-holders', 'Magnetic Holders', 3),
  ('semi-rigids', 'Semi-Rigid Holders', 4),
  ('armalopes', 'Armalope Envelopes', 5),
  ('hero-cases', 'HERO Graded Card Cases', 6),
  ('binders', 'Binders & Pages', 7),
  ('storage-boxes', 'Storage Boxes (Quad Box, 400ct, etc.)', 8),
  ('glove-fit-toploader', 'Glove-Fit Toploader Sleeves', 9),
  ('glove-fit-mag', 'Glove-Fit Magnetic Holder Sleeves', 10),
  ('glove-fit-graded', 'Glove-Fit Graded Card Sleeves', 11),
  ('glove-fit-semi', 'Glove-Fit Semi-Rigid Sleeves', 12),
  ('sleeves-bags', 'Sleeves & Bags (team bags, 8x10, etc.)', 13),
  ('accessories', 'Accessories (mats, stamps, dividers, stands)', 14),
  ('wax', 'Wax/Sealed Products (boxes, packs)', 15),
  ('other', 'Other', 99)
ON CONFLICT (slug) DO NOTHING;

-- 2. Allowed scopes for an eBay listing rule. The baseline created the table
--    without this check; the fallback's CREATE TABLE carried it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'ebay.ebay_listing_rules'::regclass
      AND conname = 'ebay_listing_rules_scope_type_check'
  ) THEN
    ALTER TABLE ebay.ebay_listing_rules
      ADD CONSTRAINT ebay_listing_rules_scope_type_check
      CHECK (scope_type IN ('default', 'product_type', 'sku'));
  END IF;
END $$;
