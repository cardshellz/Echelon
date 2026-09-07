-- Vendor quotes may be recorded from communication outside Echelon. Recording
-- response evidence does not prove an RFQ was sent by Echelon, so preserve a null
-- sent_at instead of manufacturing a send event. Existing lifecycle rows remain valid.
ALTER TABLE procurement.request_for_quotes DROP CONSTRAINT request_for_quotes_lifecycle_chk;
ALTER TABLE procurement.request_for_quotes ADD CONSTRAINT request_for_quotes_lifecycle_chk CHECK (
  (status = 'draft' AND sent_at IS NULL AND responded_at IS NULL AND cancelled_at IS NULL)
  OR (status = 'sent' AND sent_at IS NOT NULL AND responded_at IS NULL AND cancelled_at IS NULL)
  OR (status IN ('partially_quoted', 'quoted') AND responded_at IS NOT NULL AND cancelled_at IS NULL)
  OR (status = 'declined' AND sent_at IS NOT NULL AND responded_at IS NOT NULL AND cancelled_at IS NULL)
  OR (status = 'cancelled' AND cancelled_at IS NOT NULL)
  OR (status = 'expired')
);
-- Additive RFQ lifecycle evidence. Existing drafts and quote mirrors remain readable.
CREATE TABLE procurement.rfq_quote_revisions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rfq_id INTEGER NOT NULL REFERENCES procurement.request_for_quotes(id) ON DELETE RESTRICT,
  rfq_line_id INTEGER NOT NULL REFERENCES procurement.request_for_quote_lines(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  fingerprint VARCHAR(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  quoted_pieces INTEGER NOT NULL CHECK (quoted_pieces > 0),
  quoted_unit_cost_mills BIGINT NOT NULL CHECK (quoted_unit_cost_mills >= 0),
  product_total_mills BIGINT NOT NULL CHECK (product_total_mills >= 0),
  pricing_remainder_mills BIGINT NOT NULL,
  quote_data JSONB NOT NULL CHECK (jsonb_typeof(quote_data) = 'object'),
  created_by TEXT NOT NULL CHECK (NULLIF(BTRIM(created_by), '') IS NOT NULL),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT rfq_quote_revisions_line_revision_uidx UNIQUE (rfq_line_id, revision),
  CONSTRAINT rfq_quote_revisions_identity_uidx UNIQUE (id, rfq_id, rfq_line_id),
  CONSTRAINT rfq_quote_revisions_exact_total_chk CHECK (
    product_total_mills::numeric = quoted_unit_cost_mills::numeric * quoted_pieces::numeric + pricing_remainder_mills::numeric
  )
);
CREATE INDEX rfq_quote_revisions_rfq_idx ON procurement.rfq_quote_revisions(rfq_id, rfq_line_id, revision DESC);

CREATE TABLE procurement.rfq_purchase_order_line_links (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rfq_id INTEGER NOT NULL REFERENCES procurement.request_for_quotes(id) ON DELETE RESTRICT,
  rfq_line_id INTEGER NOT NULL REFERENCES procurement.request_for_quote_lines(id) ON DELETE RESTRICT,
  quote_revision_id INTEGER NOT NULL,
  purchase_order_id INTEGER NOT NULL REFERENCES procurement.purchase_orders(id) ON DELETE RESTRICT,
  purchase_order_line_id INTEGER NOT NULL REFERENCES procurement.purchase_order_lines(id) ON DELETE RESTRICT,
  quoted_pieces INTEGER NOT NULL CHECK (quoted_pieces > 0),
  quoted_unit_cost_mills BIGINT NOT NULL CHECK (quoted_unit_cost_mills >= 0),
  quote_reference VARCHAR(255) NOT NULL,
  quote_valid_until DATE,
  quantity_override_reason TEXT,
  conversion_idempotency_key VARCHAR(200) NOT NULL,
  created_by TEXT NOT NULL CHECK (NULLIF(BTRIM(created_by), '') IS NOT NULL),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT rfq_purchase_links_rfq_line_uidx UNIQUE (rfq_line_id),
  CONSTRAINT rfq_purchase_links_po_line_uidx UNIQUE (purchase_order_line_id),
  CONSTRAINT rfq_purchase_links_quote_identity_fk FOREIGN KEY (quote_revision_id, rfq_id, rfq_line_id)
    REFERENCES procurement.rfq_quote_revisions(id, rfq_id, rfq_line_id) ON DELETE RESTRICT
);
CREATE INDEX rfq_purchase_links_po_idx ON procurement.rfq_purchase_order_line_links(purchase_order_id, purchase_order_line_id);

CREATE FUNCTION procurement.guard_rfq_quote_evidence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'RFQ quote revisions and purchase links are immutable; record a new quote or purchase request'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM procurement.request_for_quote_lines WHERE id = NEW.rfq_line_id AND rfq_id = NEW.rfq_id) THEN
    RAISE EXCEPTION 'RFQ quote line does not belong to its RFQ' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'rfq_purchase_order_line_links' THEN
    IF NOT EXISTS (SELECT 1 FROM procurement.purchase_order_lines WHERE id = NEW.purchase_order_line_id AND purchase_order_id = NEW.purchase_order_id) THEN
      RAISE EXCEPTION 'RFQ purchase link does not belong to its purchase order' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rfq_quote_revisions_guard BEFORE INSERT OR UPDATE OR DELETE ON procurement.rfq_quote_revisions
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_rfq_quote_evidence();
CREATE TRIGGER rfq_purchase_order_line_links_guard BEFORE INSERT OR UPDATE OR DELETE ON procurement.rfq_purchase_order_line_links
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_rfq_quote_evidence();

COMMENT ON TABLE procurement.rfq_quote_revisions IS 'Immutable supplier quote economics, explicit packaging evidence, and actor history. Legacy mirrors are not inferred to be revisions.';
COMMENT ON TABLE procurement.rfq_purchase_order_line_links IS 'Exact RFQ line and quote revision consumed by one draft PO line. A cancelled PO retains its original sourcing history.';

-- Preserve the allocation guard while handing pending quantities to exact PO lines.
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
     OR recommendation_variant_id IS DISTINCT FROM mapping_variant_id
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
