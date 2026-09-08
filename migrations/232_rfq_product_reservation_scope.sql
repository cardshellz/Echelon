-- RFQ quantities reserve product base pieces within the same warehouse scope.
-- A receiving choice can become unresolved or be explicitly resolved without
-- changing the forecast requirement. Keep supplier/line identities and existing
-- override evidence immutable; this migration only scopes future reservations.
BEGIN;
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
