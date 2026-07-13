-- Migration 134: Preserve vendor quote basis on PO lines and catalog prices.
--
-- Existing lines are intentionally classified as legacy_unknown. Their unit
-- costs and totals are historical records and are not reinterpreted here.
-- Existing vendor-product mappings receive the same legacy classification.

-- Historical rows with a NULL status have always behaved like open lines in
-- most workflows. Make that interpretation explicit before the duplicate
-- preflight so NULL rows cannot evade the active-line uniqueness invariant.
UPDATE procurement.purchase_order_lines
SET status = 'open'
WHERE status IS NULL;

ALTER TABLE procurement.purchase_order_lines
  ALTER COLUMN status SET DEFAULT 'open',
  ALTER COLUMN status SET NOT NULL;

-- Fail with actionable identifiers before attempting the active-line index.
DO $$
DECLARE
  duplicate_lines TEXT;
BEGIN
  SELECT string_agg(
    format(
      'purchase_order_id=%s line_number=%s count=%s',
      duplicate_group.purchase_order_id,
      duplicate_group.line_number,
      duplicate_group.duplicate_count
    ),
    '; ' ORDER BY duplicate_group.purchase_order_id, duplicate_group.line_number
  )
  INTO duplicate_lines
  FROM (
    SELECT purchase_order_id, line_number, COUNT(*) AS duplicate_count
    FROM procurement.purchase_order_lines
    WHERE status <> 'cancelled'
    GROUP BY purchase_order_id, line_number
    HAVING COUNT(*) > 1
    ORDER BY purchase_order_id, line_number
    LIMIT 20
  ) AS duplicate_group;

  IF duplicate_lines IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce unique active PO line numbers; duplicate active rows found: %',
      duplicate_lines
      USING
        ERRCODE = '23505',
        HINT = 'Cancel or renumber duplicate active purchase_order_lines, then rerun migration 134.';
  END IF;
END $$;

ALTER TABLE procurement.purchase_order_lines
  ADD COLUMN IF NOT EXISTS pricing_basis VARCHAR(30) NOT NULL DEFAULT 'legacy_unknown',
  ADD COLUMN IF NOT EXISTS pricing_source VARCHAR(30) NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS purchase_uom VARCHAR(50),
  ADD COLUMN IF NOT EXISTS purchase_uom_quantity INTEGER,
  ADD COLUMN IF NOT EXISTS pieces_per_purchase_uom INTEGER,
  ADD COLUMN IF NOT EXISTS quoted_unit_cost_mills BIGINT,
  ADD COLUMN IF NOT EXISTS quoted_total_cents BIGINT,
  ADD COLUMN IF NOT EXISTS pricing_remainder_mills BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quote_reference VARCHAR(255),
  ADD COLUMN IF NOT EXISTS quoted_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS quote_valid_until DATE;

-- Supports a safe rerun after any earlier partial/manual column creation.
UPDATE procurement.purchase_order_lines
SET
  pricing_basis = COALESCE(pricing_basis, 'legacy_unknown'),
  pricing_source = COALESCE(pricing_source, 'legacy'),
  pricing_remainder_mills = COALESCE(pricing_remainder_mills, 0)
WHERE pricing_basis IS NULL
   OR pricing_source IS NULL
   OR pricing_remainder_mills IS NULL;

-- Quote basis only applies to product economics. Historical fee, tax,
-- discount, rebate, and adjustment rows are therefore known to be
-- not-applicable rather than unknown. Historical product rows deliberately
-- remain legacy_unknown and must be reviewed before a new lifecycle send.
-- A prior partial/manual execution may have populated quote columns under a
-- legacy/not-applicable label, so clear every quote-specific value while
-- converging those classifications.
UPDATE procurement.purchase_order_lines
SET
  pricing_basis = 'legacy_unknown',
  pricing_source = 'legacy',
  purchase_uom = NULL,
  purchase_uom_quantity = NULL,
  pieces_per_purchase_uom = NULL,
  quoted_unit_cost_mills = NULL,
  quoted_total_cents = NULL,
  pricing_remainder_mills = 0,
  quote_reference = NULL,
  quoted_at = NULL,
  quote_valid_until = NULL
WHERE line_type = 'product'
  AND pricing_basis IN ('legacy_unknown', 'not_applicable');

UPDATE procurement.purchase_order_lines
SET
  pricing_basis = 'not_applicable',
  pricing_source = CASE
    WHEN pricing_basis = 'not_applicable'
      AND pricing_source IN ('legacy', 'manual')
      THEN pricing_source
    ELSE 'legacy'
  END,
  purchase_uom = NULL,
  purchase_uom_quantity = NULL,
  pieces_per_purchase_uom = NULL,
  quoted_unit_cost_mills = NULL,
  quoted_total_cents = NULL,
  pricing_remainder_mills = 0,
  quote_reference = NULL,
  quoted_at = NULL,
  quote_valid_until = NULL
WHERE line_type <> 'product';

ALTER TABLE procurement.purchase_order_lines
  ALTER COLUMN pricing_basis SET DEFAULT 'legacy_unknown',
  ALTER COLUMN pricing_basis SET NOT NULL,
  ALTER COLUMN pricing_source SET DEFAULT 'legacy',
  ALTER COLUMN pricing_source SET NOT NULL,
  ALTER COLUMN pricing_remainder_mills SET DEFAULT 0,
  ALTER COLUMN pricing_remainder_mills SET NOT NULL;

-- Vendor-product catalog prices retain their own reusable vendor quote basis.
-- Existing mappings remain legacy_unknown and keep their historical costs.
ALTER TABLE procurement.vendor_products
  ADD COLUMN IF NOT EXISTS pricing_basis VARCHAR(30) NOT NULL DEFAULT 'legacy_unknown',
  ADD COLUMN IF NOT EXISTS purchase_uom VARCHAR(50),
  ADD COLUMN IF NOT EXISTS quoted_unit_cost_mills BIGINT,
  ADD COLUMN IF NOT EXISTS pieces_per_purchase_uom INTEGER,
  ADD COLUMN IF NOT EXISTS quote_reference VARCHAR(255),
  ADD COLUMN IF NOT EXISTS quoted_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS quote_valid_until DATE;

UPDATE procurement.vendor_products
SET pricing_basis = COALESCE(pricing_basis, 'legacy_unknown')
WHERE pricing_basis IS NULL;

-- If a partial/manual run produced an explicit basis without an actual quote
-- date, do not fabricate verification from row audit timestamps. Preserve the
-- normalized cost, but put the mapping back into the legacy review queue.
UPDATE procurement.vendor_products
SET
  pricing_basis = 'legacy_unknown',
  purchase_uom = NULL,
  quoted_unit_cost_mills = NULL,
  pieces_per_purchase_uom = NULL,
  quote_reference = NULL,
  quoted_at = NULL,
  quote_valid_until = NULL
WHERE pricing_basis IN ('per_piece', 'per_purchase_uom')
  AND quoted_at IS NULL;

UPDATE procurement.vendor_products
SET
  purchase_uom = NULL,
  quoted_unit_cost_mills = NULL,
  pieces_per_purchase_uom = NULL,
  quote_reference = NULL,
  quoted_at = NULL,
  quote_valid_until = NULL
WHERE pricing_basis = 'legacy_unknown';

ALTER TABLE procurement.vendor_products
  ALTER COLUMN pricing_basis SET DEFAULT 'legacy_unknown',
  ALTER COLUMN pricing_basis SET NOT NULL;

-- A vendor-product mapping is durable provenance. Deleting a referenced
-- variant must be blocked explicitly instead of SET NULL collapsing it into
-- the product-level business key (and potentially violating uniqueness).
ALTER TABLE procurement.vendor_products
  DROP CONSTRAINT IF EXISTS vendor_products_product_variant_id_product_variants_id_fk;

ALTER TABLE procurement.vendor_products
  ADD CONSTRAINT vendor_products_product_variant_id_product_variants_id_fk
  FOREIGN KEY (product_variant_id)
  REFERENCES catalog.product_variants(id)
  ON DELETE RESTRICT;

-- These definitions gained trusted-source freshness requirements during the
-- hardening work. Dropping only the named CHECK constraints makes a rerun
-- converge after any earlier partial/manual execution of migration 134.
ALTER TABLE procurement.purchase_order_lines
  DROP CONSTRAINT IF EXISTS po_lines_pricing_source_basis_consistency_chk,
  DROP CONSTRAINT IF EXISTS po_lines_explicit_pricing_consistency_chk;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'po_lines_pricing_basis_chk'
      AND conrelid = 'procurement.purchase_order_lines'::regclass
  ) THEN
    ALTER TABLE procurement.purchase_order_lines
      ADD CONSTRAINT po_lines_pricing_basis_chk
      CHECK (
        pricing_basis IN (
          'legacy_unknown',
          'not_applicable',
          'per_piece',
          'per_purchase_uom',
          'extended_total'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'po_lines_pricing_source_chk'
      AND conrelid = 'procurement.purchase_order_lines'::regclass
  ) THEN
    ALTER TABLE procurement.purchase_order_lines
      ADD CONSTRAINT po_lines_pricing_source_chk
      CHECK (pricing_source IN ('legacy', 'manual', 'vendor_catalog', 'recommendation'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'po_lines_pricing_source_basis_consistency_chk'
      AND conrelid = 'procurement.purchase_order_lines'::regclass
  ) THEN
    ALTER TABLE procurement.purchase_order_lines
      ADD CONSTRAINT po_lines_pricing_source_basis_consistency_chk
      CHECK (
        (
          pricing_basis = 'legacy_unknown'
          AND pricing_source = 'legacy'
        ) OR (
          pricing_basis = 'not_applicable'
          AND pricing_source IN ('legacy', 'manual')
        ) OR (
          pricing_basis IN ('per_piece', 'per_purchase_uom', 'extended_total')
          AND pricing_source = 'manual'
        ) OR (
          pricing_basis IN ('per_piece', 'per_purchase_uom')
          AND pricing_source IN ('vendor_catalog', 'recommendation')
          AND vendor_product_id IS NOT NULL
          AND quoted_at IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'po_lines_quote_quantities_positive_chk'
      AND conrelid = 'procurement.purchase_order_lines'::regclass
  ) THEN
    ALTER TABLE procurement.purchase_order_lines
      ADD CONSTRAINT po_lines_quote_quantities_positive_chk
      CHECK (
        (purchase_uom_quantity IS NULL OR purchase_uom_quantity > 0)
        AND (pieces_per_purchase_uom IS NULL OR pieces_per_purchase_uom > 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'po_lines_quote_dates_consistency_chk'
      AND conrelid = 'procurement.purchase_order_lines'::regclass
  ) THEN
    ALTER TABLE procurement.purchase_order_lines
      ADD CONSTRAINT po_lines_quote_dates_consistency_chk
      CHECK (
        quoted_at IS NULL
        OR quote_valid_until IS NULL
        OR quote_valid_until >= quoted_at::date
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'po_lines_quoted_amounts_nonnegative_chk'
      AND conrelid = 'procurement.purchase_order_lines'::regclass
  ) THEN
    ALTER TABLE procurement.purchase_order_lines
      ADD CONSTRAINT po_lines_quoted_amounts_nonnegative_chk
      CHECK (
        (quoted_unit_cost_mills IS NULL OR quoted_unit_cost_mills >= 0)
        AND (quoted_total_cents IS NULL OR quoted_total_cents >= 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'po_lines_explicit_pricing_consistency_chk'
      AND conrelid = 'procurement.purchase_order_lines'::regclass
  ) THEN
    ALTER TABLE procurement.purchase_order_lines
      ADD CONSTRAINT po_lines_explicit_pricing_consistency_chk
      CHECK (
        (
          pricing_basis = 'legacy_unknown'
          AND line_type = 'product'
          AND purchase_uom IS NULL
          AND purchase_uom_quantity IS NULL
          AND pieces_per_purchase_uom IS NULL
          AND quoted_unit_cost_mills IS NULL
          AND quoted_total_cents IS NULL
          AND pricing_remainder_mills = 0
          AND quote_reference IS NULL
          AND quoted_at IS NULL
          AND quote_valid_until IS NULL
        ) OR (
          pricing_basis = 'not_applicable'
          AND line_type <> 'product'
          AND purchase_uom IS NULL
          AND purchase_uom_quantity IS NULL
          AND pieces_per_purchase_uom IS NULL
          AND quoted_unit_cost_mills IS NULL
          AND quoted_total_cents IS NULL
          AND pricing_remainder_mills = 0
          AND quote_reference IS NULL
          AND quoted_at IS NULL
          AND quote_valid_until IS NULL
        ) OR (
          line_type = 'product'
          AND order_qty > 0
          AND unit_cost_mills IS NOT NULL
          AND unit_cost_mills >= 0
          AND unit_cost_cents >= 0
          AND total_product_cost_cents >= 0
          AND packaging_cost_cents >= 0
          AND discount_cents IS NOT NULL
          AND discount_cents >= 0
          AND tax_cents IS NOT NULL
          AND tax_cents >= 0
          AND line_total_cents IS NOT NULL
          AND (
            (
              pricing_basis = 'per_piece'
              AND purchase_uom IS NULL
              AND purchase_uom_quantity IS NULL
              AND pieces_per_purchase_uom IS NULL
              AND quoted_unit_cost_mills IS NOT NULL
              AND quoted_total_cents IS NULL
            ) OR (
              pricing_basis = 'per_purchase_uom'
              AND purchase_uom IS NOT NULL
              AND btrim(purchase_uom) <> ''
              AND purchase_uom_quantity IS NOT NULL
              AND purchase_uom_quantity > 0
              AND pieces_per_purchase_uom IS NOT NULL
              AND pieces_per_purchase_uom > 0
              AND quoted_unit_cost_mills IS NOT NULL
              AND quoted_total_cents IS NULL
              AND order_qty::bigint =
                purchase_uom_quantity::bigint * pieces_per_purchase_uom::bigint
            ) OR (
              pricing_basis = 'extended_total'
              AND purchase_uom IS NULL
              AND purchase_uom_quantity IS NULL
              AND pieces_per_purchase_uom IS NULL
              AND quoted_unit_cost_mills IS NULL
              AND quoted_total_cents IS NOT NULL
            )
          )
          AND unit_cost_mills::numeric = floor((
            CASE pricing_basis
              WHEN 'per_piece' THEN quoted_unit_cost_mills::numeric * order_qty::numeric
              WHEN 'per_purchase_uom' THEN quoted_unit_cost_mills::numeric * purchase_uom_quantity::numeric
              WHEN 'extended_total' THEN quoted_total_cents::numeric * 100
            END
          ) / NULLIF(order_qty, 0)::numeric + 0.5)
          AND (
            CASE pricing_basis
              WHEN 'per_piece' THEN quoted_unit_cost_mills::numeric * order_qty::numeric
              WHEN 'per_purchase_uom' THEN quoted_unit_cost_mills::numeric * purchase_uom_quantity::numeric
              WHEN 'extended_total' THEN quoted_total_cents::numeric * 100
            END
          ) = unit_cost_mills::numeric * order_qty::numeric
            + pricing_remainder_mills::numeric
          AND total_product_cost_cents::numeric = floor(((
            CASE pricing_basis
              WHEN 'per_piece' THEN quoted_unit_cost_mills::numeric * order_qty::numeric
              WHEN 'per_purchase_uom' THEN quoted_unit_cost_mills::numeric * purchase_uom_quantity::numeric
              WHEN 'extended_total' THEN quoted_total_cents::numeric * 100
            END
          ) + 50) / 100)
          AND unit_cost_cents::numeric = floor((unit_cost_mills::numeric + 50) / 100)
          AND line_total_cents::numeric =
            total_product_cost_cents::numeric
            + packaging_cost_cents::numeric
            - discount_cents::numeric
            + tax_cents::numeric
        )
      );
  END IF;
END $$;

ALTER TABLE procurement.vendor_products
  DROP CONSTRAINT IF EXISTS vendor_products_explicit_pricing_consistency_chk;

-- MOQ is a base-piece floor, not a count of receive packs or quoted purchase
-- UOMs. Surface bad legacy values with row ids before enforcing the invariant.
DO $$
DECLARE
  invalid_moqs TEXT;
BEGIN
  SELECT string_agg(format('id=%s moq=%s', id, moq), '; ' ORDER BY id)
  INTO invalid_moqs
  FROM (
    SELECT id, moq
    FROM procurement.vendor_products
    WHERE moq IS NOT NULL
      AND moq <= 0
    ORDER BY id
    LIMIT 20
  ) AS invalid_rows;

  IF invalid_moqs IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce positive vendor MOQ; invalid rows found: %',
      invalid_moqs
      USING
        ERRCODE = '23514',
        HINT = 'Set each listed MOQ to a positive base-piece quantity or NULL, then rerun migration 134.';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'vendor_products_pricing_basis_chk'
      AND conrelid = 'procurement.vendor_products'::regclass
  ) THEN
    ALTER TABLE procurement.vendor_products
      ADD CONSTRAINT vendor_products_pricing_basis_chk
      CHECK (pricing_basis IN ('legacy_unknown', 'per_piece', 'per_purchase_uom'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'vendor_products_moq_positive_chk'
      AND conrelid = 'procurement.vendor_products'::regclass
  ) THEN
    ALTER TABLE procurement.vendor_products
      ADD CONSTRAINT vendor_products_moq_positive_chk
      CHECK (moq IS NULL OR moq > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'vendor_products_explicit_pricing_consistency_chk'
      AND conrelid = 'procurement.vendor_products'::regclass
  ) THEN
    ALTER TABLE procurement.vendor_products
      ADD CONSTRAINT vendor_products_explicit_pricing_consistency_chk
      CHECK (
        (
          pricing_basis = 'legacy_unknown'
          AND purchase_uom IS NULL
          AND quoted_unit_cost_mills IS NULL
          AND pieces_per_purchase_uom IS NULL
          AND quote_reference IS NULL
          AND quoted_at IS NULL
          AND quote_valid_until IS NULL
        ) OR (
          unit_cost_mills IS NOT NULL
          AND unit_cost_mills >= 0
          AND unit_cost_cents IS NOT NULL
          AND unit_cost_cents >= 0
          AND quoted_unit_cost_mills IS NOT NULL
          AND quoted_unit_cost_mills >= 0
          AND quoted_at IS NOT NULL
          AND (
            quote_valid_until IS NULL
            OR quote_valid_until >= quoted_at::date
          )
          AND unit_cost_cents::numeric = floor((unit_cost_mills::numeric + 50) / 100)
          AND (
            (
              pricing_basis = 'per_piece'
              AND purchase_uom IS NULL
              AND pieces_per_purchase_uom IS NULL
              AND unit_cost_mills = quoted_unit_cost_mills
            ) OR (
              pricing_basis = 'per_purchase_uom'
              AND purchase_uom IS NOT NULL
              AND btrim(purchase_uom) <> ''
              AND pieces_per_purchase_uom IS NOT NULL
              AND pieces_per_purchase_uom > 0
              AND unit_cost_mills::numeric = floor(
                quoted_unit_cost_mills::numeric / NULLIF(pieces_per_purchase_uom, 0)::numeric + 0.5
              )
            )
          )
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN procurement.purchase_order_lines.pricing_basis IS
  'Vendor quote basis: legacy_unknown, not_applicable, per_piece, per_purchase_uom, or extended_total.';
COMMENT ON COLUMN procurement.purchase_order_lines.pricing_source IS
  'Quote provenance: legacy, manual, vendor_catalog, or recommendation.';
COMMENT ON COLUMN procurement.purchase_order_lines.quoted_unit_cost_mills IS
  'Original vendor unit or purchase-UOM quote in mills; interpretation is determined by pricing_basis.';
COMMENT ON COLUMN procurement.purchase_order_lines.pricing_remainder_mills IS
  'Signed deterministic residual retained when an exact vendor quote is normalized to per-piece mills.';
COMMENT ON COLUMN procurement.vendor_products.pricing_basis IS
  'Reusable vendor catalog quote basis: legacy_unknown, per_piece, or per_purchase_uom.';
COMMENT ON COLUMN procurement.vendor_products.quoted_unit_cost_mills IS
  'Original vendor price in mills per piece or purchase UOM, interpreted by pricing_basis.';
COMMENT ON COLUMN procurement.vendor_products.quoted_at IS
  'When the reusable vendor quote was issued or last explicitly refreshed; metadata-only edits must not change it.';
COMMENT ON COLUMN procurement.vendor_products.quote_valid_until IS
  'Optional inclusive calendar date through which the reusable vendor quote is valid.';
COMMENT ON COLUMN procurement.vendor_products.moq IS
  'Minimum order quantity in base pieces; independent of receive configuration and quoted purchase UOM.';

-- Preserve the existing (purchase_order_id, id) composite unique index used
-- by recommendation handoff FKs; this is an additional business-key guard.
CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_lines_po_id_line_number_active_uidx
  ON procurement.purchase_order_lines (purchase_order_id, line_number)
  WHERE status <> 'cancelled';

-- The former three-column unique index allowed multiple product-level rows
-- because PostgreSQL considers NULL values distinct. Fail with exact mapping
-- identifiers before replacing it with the real business key.
DO $$
DECLARE
  duplicate_mappings TEXT;
BEGIN
  SELECT string_agg(
    format(
      'vendor_id=%s product_id=%s product_variant_id=%s ids=%s',
      duplicate_group.vendor_id,
      duplicate_group.product_id,
      CASE
        WHEN duplicate_group.variant_key = 0 THEN 'NULL'
        ELSE duplicate_group.variant_key::text
      END,
      duplicate_group.mapping_ids
    ),
    '; ' ORDER BY duplicate_group.vendor_id, duplicate_group.product_id, duplicate_group.variant_key
  )
  INTO duplicate_mappings
  FROM (
    SELECT
      vendor_id,
      product_id,
      COALESCE(product_variant_id, 0) AS variant_key,
      COUNT(*) AS duplicate_count,
      array_agg(id ORDER BY id) AS mapping_ids
    FROM procurement.vendor_products
    GROUP BY vendor_id, product_id, COALESCE(product_variant_id, 0)
    HAVING COUNT(*) > 1
    ORDER BY vendor_id, product_id, COALESCE(product_variant_id, 0)
    LIMIT 20
  ) AS duplicate_group;

  IF duplicate_mappings IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce unique vendor catalog mappings; duplicates found: %',
      duplicate_mappings
      USING
        ERRCODE = '23505',
        HINT = 'Merge or delete duplicate procurement.vendor_products rows, repoint references to the retained id, then rerun migration 134.';
  END IF;
END $$;

DROP INDEX IF EXISTS procurement.vendor_products_vendor_product_variant_idx;

CREATE UNIQUE INDEX IF NOT EXISTS vendor_products_vendor_product_variant_key_uidx
  ON procurement.vendor_products (
    vendor_id,
    product_id,
    (COALESCE(product_variant_id, 0))
  );

-- Recommendation automation needs one unambiguous active preferred supplier
-- for each product/configuration across all vendors.
DO $$
DECLARE
  duplicate_preferences TEXT;
BEGIN
  SELECT string_agg(
    format(
      'product_id=%s product_variant_id=%s vendor_product_ids=%s vendor_ids=%s',
      duplicate_group.product_id,
      CASE
        WHEN duplicate_group.variant_key = 0 THEN 'NULL'
        ELSE duplicate_group.variant_key::text
      END,
      duplicate_group.mapping_ids,
      duplicate_group.vendor_ids
    ),
    '; ' ORDER BY duplicate_group.product_id, duplicate_group.variant_key
  )
  INTO duplicate_preferences
  FROM (
    SELECT
      product_id,
      COALESCE(product_variant_id, 0) AS variant_key,
      array_agg(id ORDER BY id) AS mapping_ids,
      array_agg(vendor_id ORDER BY id) AS vendor_ids
    FROM procurement.vendor_products
    WHERE is_active = 1
      AND is_preferred = 1
    GROUP BY product_id, COALESCE(product_variant_id, 0)
    HAVING COUNT(*) > 1
    ORDER BY product_id, COALESCE(product_variant_id, 0)
    LIMIT 20
  ) AS duplicate_group;

  IF duplicate_preferences IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce one active preferred vendor per product/configuration; duplicates found: %',
      duplicate_preferences
      USING
        ERRCODE = '23505',
        HINT = 'Choose one preferred mapping for each product/configuration and set is_preferred=0 (or is_active=0) on the others, then rerun migration 134.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS vendor_products_one_active_preferred_key_uidx
  ON procurement.vendor_products (
    product_id,
    (COALESCE(product_variant_id, 0))
  )
  WHERE is_active = 1
    AND is_preferred = 1;
