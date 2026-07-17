-- Durable purchasing recommendations and supplier RFQs.
-- Recommendation evidence is immutable; sourcing quantities live on RFQ lines.

CREATE TABLE procurement.purchase_recommendation_runs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  calculation_version VARCHAR(80) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'completed',
  as_of TIMESTAMPTZ NOT NULL,
  lookback_days INTEGER NOT NULL,
  policy_snapshot JSONB NOT NULL,
  input_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_by VARCHAR(255),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT purchase_recommendation_runs_status_chk
    CHECK (status IN ('completed', 'failed')),
  CONSTRAINT purchase_recommendation_runs_lookback_chk CHECK (lookback_days > 0)
);

CREATE INDEX purchase_recommendation_runs_latest_idx
  ON procurement.purchase_recommendation_runs (generated_at DESC, id DESC)
  WHERE status = 'completed';

CREATE TABLE procurement.purchase_recommendation_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES procurement.purchase_recommendation_runs(id) ON DELETE RESTRICT,
  recommendation_key VARCHAR(160) NOT NULL,
  product_id INTEGER NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  product_variant_id INTEGER REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  warehouse_id INTEGER REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  sku VARCHAR(100) NOT NULL,
  product_name TEXT NOT NULL,
  required_by_date DATE,
  recommended_pieces INTEGER NOT NULL,
  base_uom VARCHAR(30) NOT NULL DEFAULT 'piece',
  preferred_vendor_id INTEGER REFERENCES procurement.vendors(id) ON DELETE RESTRICT,
  preferred_vendor_product_id INTEGER REFERENCES procurement.vendor_products(id) ON DELETE RESTRICT,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  evidence_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT purchase_recommendation_lines_run_key_uidx UNIQUE (run_id, recommendation_key),
  CONSTRAINT purchase_recommendation_lines_qty_chk CHECK (recommended_pieces > 0),
  CONSTRAINT purchase_recommendation_lines_status_chk
    CHECK (status IN ('open', 'cancelled'))
);

CREATE INDEX purchase_recommendation_lines_run_status_idx
  ON procurement.purchase_recommendation_lines (run_id, status, id);
CREATE INDEX purchase_recommendation_lines_product_idx
  ON procurement.purchase_recommendation_lines (product_id, product_variant_id, warehouse_id);

CREATE TABLE procurement.request_for_quotes (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rfq_number VARCHAR(80) NOT NULL UNIQUE,
  vendor_id INTEGER NOT NULL REFERENCES procurement.vendors(id) ON DELETE RESTRICT,
  idempotency_key VARCHAR(160) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  request_note TEXT,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  response_due_date DATE,
  created_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  CONSTRAINT request_for_quotes_status_chk CHECK (
    status IN ('draft', 'sent', 'partially_quoted', 'quoted', 'declined', 'cancelled', 'expired')
  ),
  CONSTRAINT request_for_quotes_currency_chk CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT request_for_quotes_lifecycle_chk CHECK (
    (status = 'draft' AND sent_at IS NULL AND responded_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'sent' AND sent_at IS NOT NULL AND responded_at IS NULL AND cancelled_at IS NULL)
    OR (status IN ('partially_quoted', 'quoted', 'declined') AND sent_at IS NOT NULL AND responded_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL)
    OR (status = 'expired')
  )
);

CREATE UNIQUE INDEX request_for_quotes_vendor_idempotency_uidx
  ON procurement.request_for_quotes (vendor_id, idempotency_key);

CREATE INDEX request_for_quotes_vendor_status_idx
  ON procurement.request_for_quotes (vendor_id, status, created_at DESC);
CREATE INDEX request_for_quotes_status_created_idx
  ON procurement.request_for_quotes (status, created_at DESC);

CREATE TABLE procurement.request_for_quote_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rfq_id INTEGER NOT NULL REFERENCES procurement.request_for_quotes(id) ON DELETE RESTRICT,
  recommendation_line_id INTEGER NOT NULL REFERENCES procurement.purchase_recommendation_lines(id) ON DELETE RESTRICT,
  vendor_product_id INTEGER NOT NULL REFERENCES procurement.vendor_products(id) ON DELETE RESTRICT,
  requested_pieces INTEGER NOT NULL,
  purchase_uom VARCHAR(50),
  pieces_per_purchase_uom INTEGER,
  requested_purchase_uom_qty NUMERIC(14, 4),
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  quantity_override_reason TEXT,
  allocation_override_reason TEXT,
  quoted_pieces INTEGER,
  quoted_unit_cost_mills BIGINT,
  quote_reference VARCHAR(255),
  quote_valid_until DATE,
  quoted_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  ordered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT request_for_quote_lines_rfq_recommendation_uidx UNIQUE (rfq_id, recommendation_line_id),
  CONSTRAINT request_for_quote_lines_requested_qty_chk CHECK (requested_pieces > 0),
  CONSTRAINT request_for_quote_lines_pack_chk CHECK (
    pieces_per_purchase_uom IS NULL OR pieces_per_purchase_uom > 0
  ),
  CONSTRAINT request_for_quote_lines_quote_chk CHECK (
    (quoted_pieces IS NULL OR quoted_pieces > 0)
    AND (quoted_unit_cost_mills IS NULL OR quoted_unit_cost_mills >= 0)
  ),
  CONSTRAINT request_for_quote_lines_status_chk CHECK (
    status IN ('draft', 'sent', 'quoted', 'declined', 'cancelled', 'accepted', 'ordered')
  )
);

CREATE INDEX request_for_quote_lines_recommendation_idx
  ON procurement.request_for_quote_lines (recommendation_line_id, status);
CREATE INDEX request_for_quote_lines_rfq_idx
  ON procurement.request_for_quote_lines (rfq_id, id);

-- Serializes allocation against one recommendation line. The original
-- recommendation never changes; cancelled/declined RFQ lines release quantity.
CREATE OR REPLACE FUNCTION procurement.guard_rfq_line_allocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  recommendation_qty INTEGER;
  allocated_qty BIGINT;
  recommendation_product_id INTEGER;
  recommendation_variant_id INTEGER;
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

  SELECT recommended_pieces, product_id, product_variant_id
    INTO recommendation_qty, recommendation_product_id, recommendation_variant_id
    FROM procurement.purchase_recommendation_lines
   WHERE id = NEW.recommendation_line_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recommendation line does not exist'
      USING ERRCODE = '23503';
  END IF;

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

  IF NEW.status IN ('draft', 'sent', 'quoted', 'accepted', 'ordered') THEN
    SELECT COALESCE(SUM(requested_pieces), 0)
      INTO allocated_qty
      FROM procurement.request_for_quote_lines
     WHERE recommendation_line_id = NEW.recommendation_line_id
       AND status IN ('draft', 'sent', 'quoted', 'accepted', 'ordered')
       AND (TG_OP = 'INSERT' OR id <> NEW.id);

    IF allocated_qty + NEW.requested_pieces > recommendation_qty
       AND NULLIF(BTRIM(NEW.allocation_override_reason), '') IS NULL THEN
      RAISE EXCEPTION 'RFQ allocation exceeds the recommended quantity'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER request_for_quote_lines_allocation_guard_trg
  BEFORE INSERT OR UPDATE ON procurement.request_for_quote_lines
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_rfq_line_allocation();

CREATE OR REPLACE FUNCTION procurement.guard_purchasing_evidence_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Purchasing recommendation and RFQ evidence is append-only; cancel instead of deleting'
    USING ERRCODE = '23514';
END $$;

CREATE OR REPLACE FUNCTION procurement.guard_purchase_recommendation_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Purchase recommendation calculation evidence is immutable'
    USING ERRCODE = '23514';
END $$;

CREATE TRIGGER purchase_recommendation_runs_update_guard_trg
  BEFORE UPDATE ON procurement.purchase_recommendation_runs
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_purchase_recommendation_update();
CREATE TRIGGER purchase_recommendation_lines_update_guard_trg
  BEFORE UPDATE ON procurement.purchase_recommendation_lines
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_purchase_recommendation_update();

CREATE TRIGGER purchase_recommendation_runs_delete_guard_trg
  BEFORE DELETE ON procurement.purchase_recommendation_runs
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_purchasing_evidence_delete();
CREATE TRIGGER purchase_recommendation_lines_delete_guard_trg
  BEFORE DELETE ON procurement.purchase_recommendation_lines
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_purchasing_evidence_delete();
CREATE TRIGGER request_for_quotes_delete_guard_trg
  BEFORE DELETE ON procurement.request_for_quotes
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_purchasing_evidence_delete();
CREATE TRIGGER request_for_quote_lines_delete_guard_trg
  BEFORE DELETE ON procurement.request_for_quote_lines
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_purchasing_evidence_delete();

COMMENT ON TABLE procurement.purchase_recommendation_runs IS
  'Immutable versioned outputs from the purchasing calculation engine.';
COMMENT ON TABLE procurement.purchase_recommendation_lines IS
  'Immutable SKU/location/date purchase requirements with full calculation evidence.';
COMMENT ON TABLE procurement.request_for_quotes IS
  'Supplier RFQ headers; one RFQ can contain many recommendation lines.';
COMMENT ON TABLE procurement.request_for_quote_lines IS
  'Selected sourcing quantities that may split or partially consume a recommendation.';
