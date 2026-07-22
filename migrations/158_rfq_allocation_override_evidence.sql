-- Complete the dormant RFQ over-allocation path with attributable evidence.
-- Recommendations remain immutable; an RFQ line records the approved sourcing
-- exception that allowed its requested quantity to exceed remaining demand.

ALTER TABLE procurement.request_for_quotes
  ADD COLUMN IF NOT EXISTS request_hash VARCHAR(64);

-- Existing RFQs predate exact request hashing. Give them deterministic legacy
-- values so new retries fail closed instead of being mistaken for exact replays.
UPDATE procurement.request_for_quotes
   SET request_hash = MD5('legacy-rfq:' || id::text) || MD5('legacy-rfq-2:' || id::text)
 WHERE request_hash IS NULL;

ALTER TABLE procurement.request_for_quotes
  ALTER COLUMN request_hash SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'request_for_quotes_request_hash_chk'
       AND conrelid = 'procurement.request_for_quotes'::regclass
  ) THEN
    ALTER TABLE procurement.request_for_quotes
      ADD CONSTRAINT request_for_quotes_request_hash_chk
      CHECK (request_hash ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

ALTER TABLE procurement.request_for_quote_lines
  ADD COLUMN IF NOT EXISTS allocation_override_approved_by VARCHAR(255),
  ADD COLUMN IF NOT EXISTS allocation_override_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS allocation_override_baseline_pieces INTEGER,
  ADD COLUMN IF NOT EXISTS allocation_override_excess_pieces INTEGER;

UPDATE procurement.request_for_quote_lines
   SET allocation_override_reason = NULL
 WHERE allocation_override_reason IS NOT NULL
   AND NULLIF(BTRIM(allocation_override_reason), '') IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM procurement.request_for_quote_lines
     WHERE allocation_override_reason IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Existing RFQ allocation overrides require explicit remediation before migration 158';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'request_for_quote_lines_override_evidence_chk'
       AND conrelid = 'procurement.request_for_quote_lines'::regclass
  ) THEN
    ALTER TABLE procurement.request_for_quote_lines
      ADD CONSTRAINT request_for_quote_lines_override_evidence_chk
      CHECK (
        (
          allocation_override_reason IS NULL
          AND allocation_override_approved_by IS NULL
          AND allocation_override_approved_at IS NULL
          AND allocation_override_baseline_pieces IS NULL
          AND allocation_override_excess_pieces IS NULL
        )
        OR (
          NULLIF(BTRIM(quantity_override_reason), '') IS NOT NULL
          AND LENGTH(BTRIM(quantity_override_reason)) >= 3
          AND NULLIF(BTRIM(allocation_override_reason), '') IS NOT NULL
          AND LENGTH(BTRIM(allocation_override_reason)) >= 3
          AND allocation_override_reason = quantity_override_reason
          AND NULLIF(BTRIM(allocation_override_approved_by), '') IS NOT NULL
          AND allocation_override_approved_at IS NOT NULL
          AND allocation_override_baseline_pieces >= 0
          AND allocation_override_excess_pieces > 0
        )
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION procurement.guard_rfq_line_allocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  recommendation_qty INTEGER;
  allocated_qty BIGINT;
  baseline_qty INTEGER;
  excess_qty INTEGER;
  recommendation_product_id INTEGER;
  recommendation_variant_id INTEGER;
  recommendation_warehouse_id INTEGER;
  mapping_product_id INTEGER;
  mapping_variant_id INTEGER;
  mapping_vendor_id INTEGER;
  rfq_vendor_id INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.rfq_id IS DISTINCT FROM OLD.rfq_id
    OR NEW.recommendation_line_id IS DISTINCT FROM OLD.recommendation_line_id
    OR NEW.vendor_product_id IS DISTINCT FROM OLD.vendor_product_id
  ) THEN
    RAISE EXCEPTION 'RFQ line sourcing identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.requested_pieces IS DISTINCT FROM OLD.requested_pieces
    OR NEW.quantity_override_reason IS DISTINCT FROM OLD.quantity_override_reason
    OR NEW.allocation_override_reason IS DISTINCT FROM OLD.allocation_override_reason
    OR NEW.allocation_override_approved_by IS DISTINCT FROM OLD.allocation_override_approved_by
    OR NEW.allocation_override_approved_at IS DISTINCT FROM OLD.allocation_override_approved_at
    OR NEW.allocation_override_baseline_pieces IS DISTINCT FROM OLD.allocation_override_baseline_pieces
    OR NEW.allocation_override_excess_pieces IS DISTINCT FROM OLD.allocation_override_excess_pieces
  ) THEN
    RAISE EXCEPTION 'RFQ line quantity and override evidence are immutable; cancel and replace the line'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status NOT IN ('draft', 'sent', 'quoted', 'accepted', 'ordered')
     AND NEW.status IN ('draft', 'sent', 'quoted', 'accepted', 'ordered') THEN
    RAISE EXCEPTION 'Inactive RFQ lines cannot be reactivated; create a replacement line'
      USING ERRCODE = '23514';
  END IF;

  SELECT recommended_pieces, product_id, product_variant_id, warehouse_id
    INTO recommendation_qty, recommendation_product_id, recommendation_variant_id, recommendation_warehouse_id
    FROM procurement.purchase_recommendation_lines
   WHERE id = NEW.recommendation_line_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recommendation line does not exist'
      USING ERRCODE = '23503';
  END IF;

  PERFORM 1
    FROM catalog.products
   WHERE id = recommendation_product_id
   FOR UPDATE;

  SELECT product_id, product_variant_id, vendor_id
    INTO mapping_product_id, mapping_variant_id, mapping_vendor_id
    FROM procurement.vendor_products
   WHERE id = NEW.vendor_product_id;
  SELECT vendor_id INTO rfq_vendor_id
    FROM procurement.request_for_quotes
   WHERE id = NEW.rfq_id;

  IF recommendation_product_id IS DISTINCT FROM mapping_product_id
     OR recommendation_variant_id IS DISTINCT FROM mapping_variant_id
     OR mapping_vendor_id IS DISTINCT FROM rfq_vendor_id THEN
    RAISE EXCEPTION 'RFQ line supplier catalog identity does not match the recommendation and RFQ'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status IN ('draft', 'sent', 'quoted', 'accepted', 'ordered') THEN
    SELECT COALESCE(SUM(rfq_line.requested_pieces), 0)
      INTO allocated_qty
      FROM procurement.request_for_quote_lines rfq_line
      JOIN procurement.purchase_recommendation_lines source_recommendation
        ON source_recommendation.id = rfq_line.recommendation_line_id
     WHERE source_recommendation.product_id = recommendation_product_id
       AND source_recommendation.product_variant_id IS NOT DISTINCT FROM recommendation_variant_id
       AND source_recommendation.warehouse_id IS NOT DISTINCT FROM recommendation_warehouse_id
       AND rfq_line.status IN ('draft', 'sent', 'quoted', 'accepted', 'ordered');

    baseline_qty := GREATEST(recommendation_qty - allocated_qty, 0);
    excess_qty := GREATEST(NEW.requested_pieces - baseline_qty, 0);

    IF excess_qty > 0 THEN
      IF NULLIF(BTRIM(NEW.allocation_override_reason), '') IS NULL
         OR NULLIF(BTRIM(NEW.allocation_override_approved_by), '') IS NULL
         OR NEW.allocation_override_approved_at IS NULL THEN
        RAISE EXCEPTION 'RFQ allocation exceeds the recommendation without complete approval evidence'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.allocation_override_baseline_pieces IS DISTINCT FROM baseline_qty
         OR NEW.allocation_override_excess_pieces IS DISTINCT FROM excess_qty THEN
        RAISE EXCEPTION 'RFQ allocation approval does not match the locked recommendation baseline'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.allocation_override_reason IS NOT NULL
       OR NEW.allocation_override_approved_by IS NOT NULL
       OR NEW.allocation_override_approved_at IS NOT NULL
       OR NEW.allocation_override_baseline_pieces IS NOT NULL
       OR NEW.allocation_override_excess_pieces IS NOT NULL THEN
      RAISE EXCEPTION 'RFQ allocation override evidence is only valid for excess sourcing'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END $$;
