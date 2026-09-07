BEGIN;

-- Revisions are the authoritative state: a disabled/replaced quote remains
-- historical evidence, and mappings with recorded evidence cannot be deleted.
CREATE TABLE procurement.supplier_sourcing_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_product_id integer NOT NULL REFERENCES procurement.vendor_products(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  before_policy jsonb,
  policy jsonb NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  recorded_by text NOT NULL CHECK (length(btrim(recorded_by)) BETWEEN 1 AND 255),
  recorded_at timestamptz NOT NULL,
  UNIQUE (vendor_product_id, revision), UNIQUE (vendor_product_id, idempotency_key),
  CHECK (COALESCE(jsonb_typeof(policy) = 'object' AND policy->>'version' = '1'
    AND jsonb_typeof(policy->'eligibleForProposals') = 'boolean'
    AND jsonb_typeof(policy->'priority') = 'number'
    AND (policy->>'priority')::numeric BETWEEN 0 AND 10000
    AND (policy->>'priority')::numeric = trunc((policy->>'priority')::numeric)
    AND policy ? 'priceList'
    AND jsonb_typeof(policy->'priceList') IN ('object', 'null'), false)),
  CHECK (before_policy IS NULL OR jsonb_typeof(before_policy) = 'object')
);
CREATE FUNCTION procurement.validate_supplier_price_list() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE quote jsonb; tier jsonb; last_quantity numeric := 0;
BEGIN
  quote := NEW.policy->'priceList';
  IF quote = 'null'::jsonb THEN RETURN NEW; END IF;
  IF jsonb_typeof(quote) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid supplier price list contract'; END IF;
  IF NOT (quote ?& ARRAY['currency','basis','purchaseUom','piecesPerPurchaseUom','quoteReference','quotedAt','validFrom','validUntil','tiers'])
    OR jsonb_typeof(quote->'currency') IS DISTINCT FROM 'string'
    OR jsonb_typeof(quote->'basis') IS DISTINCT FROM 'string'
    OR jsonb_typeof(quote->'quoteReference') IS DISTINCT FROM 'string'
    OR jsonb_typeof(quote->'quotedAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(quote->'validFrom') IS DISTINCT FROM 'string'
    OR jsonb_typeof(quote->'validUntil') IS DISTINCT FROM 'string'
    OR quote->>'validFrom' !~ '^\d{4}-\d{2}-\d{2}$'
    OR quote->>'validUntil' !~ '^\d{4}-\d{2}-\d{2}$'
    OR quote->>'quotedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$'
    OR quote->>'currency' !~ '^[A-Z]{3}$' OR quote->>'basis' NOT IN ('per_piece','per_purchase_uom')
    OR length(btrim(quote->>'quoteReference')) NOT BETWEEN 1 AND 255
    OR jsonb_typeof(quote->'tiers') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid supplier price list contract';
  END IF;
  IF jsonb_array_length(quote->'tiers') NOT BETWEEN 1 AND 50
    OR (quote->>'validUntil')::date < (quote->>'validFrom')::date
    OR (quote->>'validFrom')::date < ((quote->>'quotedAt')::timestamptz AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'Invalid supplier price list contract';
  END IF;
  IF quote->>'basis' = 'per_piece' AND (quote->'purchaseUom' <> 'null'::jsonb OR quote->'piecesPerPurchaseUom' <> 'null'::jsonb) THEN RAISE EXCEPTION 'Per-piece quote cannot have purchase-unit conversion'; END IF;
  IF quote->>'basis' = 'per_purchase_uom' AND (COALESCE(length(btrim(quote->>'purchaseUom')),0) NOT BETWEEN 1 AND 50 OR COALESCE((quote->>'piecesPerPurchaseUom')::numeric,0) NOT BETWEEN 1 AND 2147483647 OR (quote->>'piecesPerPurchaseUom')::numeric <> trunc((quote->>'piecesPerPurchaseUom')::numeric)) THEN RAISE EXCEPTION 'Purchase-unit quote requires a positive integer conversion'; END IF;
  FOR tier IN SELECT value FROM jsonb_array_elements(quote->'tiers') LOOP
    IF jsonb_typeof(tier) IS DISTINCT FROM 'object' OR NOT (tier ?& ARRAY['minimumQuantity','unitCostMills']) OR jsonb_typeof(tier->'minimumQuantity') IS DISTINCT FROM 'number' OR jsonb_typeof(tier->'unitCostMills') IS DISTINCT FROM 'number'
      OR (tier->>'minimumQuantity')::numeric <= last_quantity OR (tier->>'minimumQuantity')::numeric > 2147483647
      OR (tier->>'minimumQuantity')::numeric <> trunc((tier->>'minimumQuantity')::numeric)
      OR (tier->>'unitCostMills')::numeric NOT BETWEEN 0 AND 9007199254740991
      OR (tier->>'unitCostMills')::numeric <> trunc((tier->>'unitCostMills')::numeric) THEN RAISE EXCEPTION 'Invalid quantity-price tier'; END IF;
    last_quantity := (tier->>'minimumQuantity')::numeric;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_price_list_validation BEFORE INSERT ON procurement.supplier_sourcing_revisions FOR EACH ROW EXECUTE FUNCTION procurement.validate_supplier_price_list();
CREATE FUNCTION procurement.reject_supplier_sourcing_history_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Supplier sourcing revisions are immutable; record a correction'; END; $$;
CREATE TRIGGER supplier_sourcing_history_immutable BEFORE UPDATE OR DELETE ON procurement.supplier_sourcing_revisions FOR EACH ROW EXECUTE FUNCTION procurement.reject_supplier_sourcing_history_change();
CREATE TRIGGER supplier_sourcing_history_truncate_immutable BEFORE TRUNCATE ON procurement.supplier_sourcing_revisions FOR EACH STATEMENT EXECUTE FUNCTION procurement.reject_supplier_sourcing_history_change();
-- Product-level supplier mappings apply to every receive variant of the same
-- product. Exact variant mappings must still match; all allocation, stale
-- capture, immutability and override-evidence guards remain unchanged.
CREATE OR REPLACE FUNCTION procurement.guard_rfq_line_allocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  recommendation_qty INTEGER;
  recommendation_as_of TIMESTAMPTZ;
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
     OR (mapping_variant_id IS NOT NULL AND recommendation_variant_id IS DISTINCT FROM mapping_variant_id)
     OR mapping_vendor_id IS DISTINCT FROM rfq_vendor_id THEN
    RAISE EXCEPTION 'RFQ line supplier catalog identity does not match the recommendation and RFQ'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status IN ('draft', 'sent', 'quoted', 'accepted', 'ordered') THEN
    SELECT run.as_of INTO recommendation_as_of
      FROM procurement.purchase_recommendation_runs run
      JOIN procurement.purchase_recommendation_lines r ON r.run_id = run.id
     WHERE r.id = NEW.recommendation_line_id;
    IF EXISTS (
      SELECT 1 FROM procurement.rfq_purchase_order_line_links link
      JOIN procurement.request_for_quote_lines prior_rfq ON prior_rfq.id = link.rfq_line_id
      JOIN procurement.purchase_recommendation_lines source ON source.id = prior_rfq.recommendation_line_id
      JOIN procurement.purchase_orders po ON po.id = link.purchase_order_id
      JOIN procurement.purchase_order_lines line ON line.id = link.purchase_order_line_id AND line.purchase_order_id = po.id
      WHERE source.product_id = recommendation_product_id
        AND source.product_variant_id IS NOT DISTINCT FROM recommendation_variant_id
        AND source.warehouse_id IS NOT DISTINCT FROM recommendation_warehouse_id
        AND po.status NOT IN ('draft', 'pending_approval')
        AND (GREATEST(po.updated_at, line.updated_at) AT TIME ZONE 'UTC') > recommendation_as_of
    ) THEN
      RAISE EXCEPTION 'RFQ_SUPPLY_SNAPSHOT_STALE: generate fresh recommendations after purchase supply changes'
        USING ERRCODE = '23514';
    END IF;

    -- Match rfqPendingSourcingPieces: only uncommitted linked PO remainder is
    -- still a sourcing reservation. Original RFQ quantities remain immutable.
    SELECT COALESCE(SUM(CASE
      WHEN link.id IS NULL AND rfq_line.status IN ('draft', 'sent', 'quoted', 'accepted', 'ordered')
        AND header.status IN ('draft', 'sent', 'partially_quoted', 'quoted') THEN rfq_line.requested_pieces
      WHEN po.status IN ('draft', 'pending_approval') AND line.status IN ('open', 'partially_received')
        THEN GREATEST(line.order_qty - COALESCE(line.received_qty, 0) - COALESCE(line.cancelled_qty, 0), 0)
      ELSE 0 END), 0)
      INTO allocated_qty
      FROM procurement.request_for_quote_lines rfq_line
      JOIN procurement.purchase_recommendation_lines source_recommendation
        ON source_recommendation.id = rfq_line.recommendation_line_id
      JOIN procurement.request_for_quotes header ON header.id = rfq_line.rfq_id
      LEFT JOIN procurement.rfq_purchase_order_line_links link ON link.rfq_line_id = rfq_line.id
      LEFT JOIN procurement.purchase_orders po ON po.id = link.purchase_order_id
      LEFT JOIN procurement.purchase_order_lines line ON line.id = link.purchase_order_line_id AND line.purchase_order_id = po.id
     WHERE source_recommendation.product_id = recommendation_product_id
       AND source_recommendation.product_variant_id IS NOT DISTINCT FROM recommendation_variant_id
       AND source_recommendation.warehouse_id IS NOT DISTINCT FROM recommendation_warehouse_id;

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

COMMIT;
