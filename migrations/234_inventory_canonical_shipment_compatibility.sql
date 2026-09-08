-- Exact original posting proof for omission corrections. Shipment quantity is
-- not an on-hand delta after canonical picking: its immutable dispatch receipt
-- and original-pick journal carry the shipped units. No stock is changed here.
CREATE OR REPLACE FUNCTION inventory.omission_source_posted_quantity(
  expected_order_id integer,
  expected_order_item_id integer,
  expected_shipment_id integer,
  expected_source_item_id integer,
  expected_variant_id integer,
  expected_source_quantity integer
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  posting record;
  posted_quantity bigint := 0;
  canonical_valid boolean;
BEGIN
  FOR posting IN
    SELECT ledger.*,
      COUNT(*) OVER () AS posting_count,
      receipt.id AS receipt_id,
      receipt.quantity AS receipt_quantity,
      receipt.order_id AS receipt_order_id,
      receipt.order_item_id AS receipt_order_item_id,
      receipt.outbound_shipment_id AS receipt_shipment_id,
      receipt.source_shipment_item_id AS receipt_source_item_id,
      receipt.product_variant_id AS receipt_variant_id,
      receipt.warehouse_location_id AS receipt_location_id,
      receipt.warehouse_id AS receipt_warehouse_id,
      receipt.physical_shipment_id AS receipt_physical_id,
      receipt.physical_shipment_item_id AS receipt_physical_item_id,
      journal.quantity AS movement_quantity,
      journal.invalid_count
    FROM inventory.inventory_transactions ledger
    LEFT JOIN inventory.availability_claim_dispatch_receipts receipt
      ON receipt.inventory_transaction_id = ledger.id
    LEFT JOIN LATERAL (
      SELECT SUM(movement.quantity) AS quantity,
        COUNT(*) FILTER (WHERE pick.id IS NULL OR pick.movement_type <> 'pick'
          OR movement.quantity <= 0 OR movement.quantity > pick.quantity
          OR movement.claim_id <> receipt.claim_id OR movement.claim_line_id <> receipt.claim_line_id
          OR pick.claim_id <> receipt.claim_id OR pick.claim_line_id <> receipt.claim_line_id) AS invalid_count
      FROM inventory.availability_claim_dispatch_movements movement
      LEFT JOIN inventory.availability_claim_pick_movements pick ON pick.id = movement.pick_movement_id
      WHERE movement.receipt_id = receipt.id
    ) journal ON true
    WHERE ledger.transaction_type = 'ship'
      AND ledger.shipment_id = expected_shipment_id
      AND ledger.order_item_id = expected_order_item_id
      AND ledger.product_variant_id = expected_variant_id
      AND ledger.voided_at IS NULL
      AND (ledger.shipment_item_id IS NULL OR ledger.shipment_item_id = expected_source_item_id)
    ORDER BY ledger.id
  LOOP
    IF posting.posting_count > 1000
       OR (posting.order_id IS NOT NULL AND posting.order_id <> expected_order_id) THEN
      RAISE EXCEPTION 'Omission source % has invalid or unbounded shipment evidence', expected_source_item_id
        USING ERRCODE = '23514', CONSTRAINT = 'outbound_shipment_items_omission_inventory_proof_chk';
    END IF;
    IF posting.reference_type = 'availability_claim_dispatch' OR posting.receipt_id IS NOT NULL THEN
      canonical_valid := posting.posting_count = 1
        AND posting.reference_type = 'availability_claim_dispatch'
        AND posting.receipt_id IS NOT NULL
        AND posting.variant_qty_delta = 0 AND posting.reserved_qty_delta = 0
        AND posting.source_state = 'picked' AND posting.target_state = 'shipped'
        AND posting.order_id = expected_order_id AND posting.receipt_order_id = posting.order_id
        AND posting.receipt_order_item_id = posting.order_item_id
        AND posting.receipt_shipment_id = posting.shipment_id
        AND posting.shipment_item_id = expected_source_item_id
        AND posting.receipt_source_item_id = posting.shipment_item_id
        AND posting.receipt_variant_id = posting.product_variant_id
        AND posting.from_location_id > 0 AND posting.receipt_location_id = posting.from_location_id
        AND posting.receipt_warehouse_id > 0
        AND ((posting.receipt_physical_id IS NULL AND posting.receipt_physical_item_id IS NULL)
          OR (posting.receipt_physical_id > 0 AND posting.receipt_physical_item_id > 0))
        AND posting.receipt_quantity = expected_source_quantity
        AND posting.movement_quantity = posting.receipt_quantity
        AND posting.invalid_count = 0;
      IF canonical_valid IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Omission source % lacks exact canonical dispatch evidence', expected_source_item_id
          USING ERRCODE = '23514', CONSTRAINT = 'outbound_shipment_items_omission_inventory_proof_chk';
      END IF;
      posted_quantity := posting.receipt_quantity;
    ELSE
      IF posting.variant_qty_delta IS NULL OR posting.variant_qty_delta >= 0 THEN
        RAISE EXCEPTION 'Omission source % lacks a negative legacy shipment debit', expected_source_item_id
          USING ERRCODE = '23514', CONSTRAINT = 'outbound_shipment_items_omission_inventory_proof_chk';
      END IF;
      posted_quantity := posted_quantity - posting.variant_qty_delta::bigint;
    END IF;
    IF posted_quantity > 2147483647 THEN
      RAISE EXCEPTION 'Omission source % shipment quantity exceeds the supported bound', expected_source_item_id
        USING ERRCODE = '23514', CONSTRAINT = 'outbound_shipment_items_omission_inventory_proof_chk';
    END IF;
  END LOOP;
  RETURN posted_quantity::integer;
END;
$$;



CREATE OR REPLACE FUNCTION wms.enforce_outbound_shipment_item_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  shipment_order_id INTEGER;
  authority_order_item_id INTEGER;
  item_order_id INTEGER;
  source_shipment_item RECORD;
  source_candidate_count INTEGER;
  source_inventory_shipped_quantity INTEGER;
  source_item_correction_quantity INTEGER;
BEGIN
  authority_order_item_id := CASE NEW.shipment_item_purpose
    WHEN 'customer_fulfillment' THEN NEW.order_item_id
    WHEN 'replacement' THEN NEW.replacement_for_order_item_id
    ELSE NULL
  END;

  IF NEW.shipment_item_purpose = 'customer_fulfillment'
     AND (
       NEW.order_item_id IS NULL
       OR NEW.replacement_for_order_item_id IS NOT NULL
       OR NEW.correction_for_shipment_item_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Customer fulfillment shipment item % must reference order_item_id only', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
  ELSIF NEW.shipment_item_purpose = 'replacement'
     AND (
       NEW.order_item_id IS NOT NULL
       OR NEW.replacement_for_order_item_id IS NULL
       OR NEW.correction_for_shipment_item_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Replacement shipment item % must reference replacement_for_order_item_id only', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
  ELSIF NEW.shipment_item_purpose = 'concession'
     AND (
       NEW.order_item_id IS NOT NULL
       OR NEW.replacement_for_order_item_id IS NOT NULL
       OR NEW.correction_for_shipment_item_id IS NOT NULL
       OR NEW.product_variant_id IS NULL
     ) THEN
    RAISE EXCEPTION 'Concession shipment item % must reference product_variant_id only', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
  ELSIF NEW.shipment_item_purpose = 'omission_correction'
     AND (
       NEW.order_item_id IS NOT NULL
       OR NEW.replacement_for_order_item_id IS NOT NULL
       OR NEW.correction_for_shipment_item_id IS NULL
       OR NEW.product_variant_id IS NULL
     ) THEN
    RAISE EXCEPTION 'Omission correction shipment item % must reference correction_for_shipment_item_id only', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
  ELSIF NEW.shipment_item_purpose = 'unclassified'
     AND (
       NEW.order_item_id IS NOT NULL
       OR NEW.replacement_for_order_item_id IS NOT NULL
       OR NEW.correction_for_shipment_item_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Unclassified shipment item % cannot claim order-line authority', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
  END IF;

  IF COALESCE(NEW.qty, 0) <= 0 THEN
    RAISE EXCEPTION 'Outbound shipment item % qty must be positive', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'wms_outbound_shipment_items_qty_positive_chk';
  END IF;

  SELECT shipment.order_id
  INTO shipment_order_id
  FROM wms.outbound_shipments shipment
  WHERE shipment.id = NEW.shipment_id;

  IF NEW.shipment_item_purpose = 'omission_correction' THEN
    IF NEW.correction_for_shipment_item_id = NEW.id THEN
      RAISE EXCEPTION 'Omission correction shipment item % cannot correct itself', NEW.id
        USING ERRCODE = '23514',
              CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
    END IF;

    SELECT
      source_item.order_item_id,
      source_item.shipment_id,
      source_item.product_variant_id,
      source_item.qty,
      source_item.shipment_item_purpose,
      source_shipment.order_id,
      source_shipment.status
    INTO source_shipment_item
    FROM wms.outbound_shipment_items source_item
    JOIN wms.outbound_shipments source_shipment
      ON source_shipment.id = source_item.shipment_id
    WHERE source_item.id = NEW.correction_for_shipment_item_id
    FOR UPDATE OF source_item;

    IF source_shipment_item.order_item_id IS NULL
       OR source_shipment_item.shipment_item_purpose <> 'customer_fulfillment'
       OR source_shipment_item.product_variant_id IS DISTINCT FROM NEW.product_variant_id
       OR source_shipment_item.order_id IS DISTINCT FROM shipment_order_id
       OR source_shipment_item.status NOT IN ('shipped', 'returned', 'lost') THEN
      RAISE EXCEPTION 'Omission correction shipment item % lacks a terminal customer-fulfillment source line on the same order', NEW.id
        USING ERRCODE = '23514',
              CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
    END IF;

    SELECT COUNT(*)::int
    INTO source_candidate_count
    FROM wms.outbound_shipment_items source_candidate
    WHERE source_candidate.shipment_id = source_shipment_item.shipment_id
      AND source_candidate.order_item_id = source_shipment_item.order_item_id
      AND source_candidate.shipment_item_purpose = 'customer_fulfillment'
      AND source_candidate.qty > 0;

    IF source_candidate_count <> 1 THEN
      RAISE EXCEPTION 'Omission correction source shipment item % is ambiguous across % customer-fulfillment lines',
        NEW.correction_for_shipment_item_id,
        source_candidate_count
        USING ERRCODE = '23514',
              CONSTRAINT = 'outbound_shipment_items_omission_source_ambiguity_chk';
    END IF;

    authority_order_item_id := source_shipment_item.order_item_id;

    SELECT COALESCE(SUM(correction_item.qty), 0)::int
    INTO source_item_correction_quantity
    FROM wms.outbound_shipment_items correction_item
    JOIN wms.outbound_shipments correction_shipment
      ON correction_shipment.id = correction_item.shipment_id
    WHERE correction_item.shipment_item_purpose = 'omission_correction'
      AND correction_item.correction_for_shipment_item_id = NEW.correction_for_shipment_item_id
      AND correction_shipment.status NOT IN ('cancelled', 'voided');

    IF source_item_correction_quantity > source_shipment_item.qty THEN
      RAISE EXCEPTION 'Omission correction quantity % exceeds source shipment item % quantity %',
        source_item_correction_quantity,
        NEW.correction_for_shipment_item_id,
        source_shipment_item.qty
        USING ERRCODE = '23514',
              CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
    END IF;

    source_inventory_shipped_quantity := inventory.omission_source_posted_quantity(
      source_shipment_item.order_id, source_shipment_item.order_item_id,
      source_shipment_item.shipment_id, NEW.correction_for_shipment_item_id,
      source_shipment_item.product_variant_id, source_shipment_item.qty
    );

    IF source_inventory_shipped_quantity < source_shipment_item.qty THEN
      RAISE EXCEPTION 'Omission correction source shipment item % has only % of % units posted to inventory',
        NEW.correction_for_shipment_item_id,
        source_inventory_shipped_quantity,
        source_shipment_item.qty
        USING ERRCODE = '23514',
              CONSTRAINT = 'outbound_shipment_items_omission_inventory_proof_chk';
    END IF;
  END IF;

  IF authority_order_item_id IS NOT NULL THEN
    SELECT order_item.order_id
    INTO item_order_id
    FROM wms.order_items order_item
    WHERE order_item.id = authority_order_item_id;
  END IF;

  IF shipment_order_id IS NOT NULL
     AND item_order_id IS NOT NULL
     AND shipment_order_id <> item_order_id THEN
    RAISE EXCEPTION 'Shipment item % references order item % from WMS order %, expected %',
      NEW.id,
      authority_order_item_id,
      item_order_id,
      shipment_order_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'wms_outbound_shipment_items_order_match_chk';
  END IF;

  RETURN NEW;
END $$;

-- Non-customer operational shipments consume NEW available stock. They do not
-- borrow customer claim/pick/COGS identity and cannot share another order's picked
-- pool. The source item and exact FIFO cost journal provide immutable ownership.
CREATE TABLE inventory.operational_shipment_dispatch_receipts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_shipment_item_id integer NOT NULL UNIQUE REFERENCES wms.outbound_shipment_items(id) ON DELETE RESTRICT,
  outbound_shipment_id integer NOT NULL REFERENCES wms.outbound_shipments(id) ON DELETE RESTRICT,
  order_id integer NOT NULL REFERENCES wms.orders(id) ON DELETE RESTRICT,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  warehouse_location_id integer NOT NULL REFERENCES warehouse.warehouse_locations(id) ON DELETE RESTRICT,
  physical_shipment_item_id bigint REFERENCES wms.physical_shipment_items(id) ON DELETE RESTRICT,
  replacement_for_order_item_id integer REFERENCES wms.order_items(id) ON DELETE RESTRICT,
  purpose varchar(30) NOT NULL CHECK (purpose IN ('replacement','concession')),
  quantity integer NOT NULL CHECK (quantity > 0),
  total_cost_mills bigint NOT NULL CHECK (total_cost_mills >= 0),
  inventory_transaction_id integer NOT NULL UNIQUE REFERENCES inventory.inventory_transactions(id) ON DELETE RESTRICT,
  actor varchar(100) NOT NULL CHECK (btrim(actor) <> ''),
  occurred_at timestamptz NOT NULL,
  CONSTRAINT operational_shipment_dispatch_purpose_chk CHECK (
    (purpose='replacement' AND replacement_for_order_item_id IS NOT NULL)
    OR (purpose='concession' AND replacement_for_order_item_id IS NULL)
  )
);
CREATE TABLE inventory.operational_shipment_dispatch_lots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id bigint NOT NULL REFERENCES inventory.operational_shipment_dispatch_receipts(id) ON DELETE RESTRICT,
  inventory_lot_id integer NOT NULL REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_cost_mills bigint NOT NULL CHECK (unit_cost_mills >= 0),
  total_cost_mills bigint NOT NULL CHECK (total_cost_mills = quantity::bigint * unit_cost_mills),
  UNIQUE(receipt_id, inventory_lot_id)
);
CREATE TRIGGER operational_shipment_dispatch_receipts_immutable
BEFORE UPDATE OR DELETE ON inventory.operational_shipment_dispatch_receipts FOR EACH ROW
EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER operational_shipment_dispatch_lots_immutable
BEFORE UPDATE OR DELETE ON inventory.operational_shipment_dispatch_lots FOR EACH ROW
EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();

CREATE FUNCTION inventory.validate_operational_shipment_dispatch_journal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt_key bigint;
  evidence record;
BEGIN
  IF TG_TABLE_NAME = 'operational_shipment_dispatch_receipts' THEN
    receipt_key := NEW.id;
  ELSE
    receipt_key := NEW.receipt_id;
    -- Only the last lot's deferred callback needs the aggregate check, avoiding
    -- quadratic journal verification for large exact FIFO allocations.
    IF NEW.id <> (SELECT movement.id FROM inventory.operational_shipment_dispatch_lots movement
      WHERE movement.receipt_id=receipt_key ORDER BY movement.id DESC LIMIT 1) THEN
      RETURN NULL;
    END IF;
  END IF;
  SELECT receipt.*, journal.quantity AS lot_quantity, journal.total_cost_mills AS lot_cost,
    journal.invalid_count,
    ledger.transaction_type='ship' AND ledger.reference_type='operational_shipment'
      AND ledger.order_id=receipt.order_id AND ledger.order_item_id IS NULL
      AND ledger.shipment_id=receipt.outbound_shipment_id AND ledger.shipment_item_id=receipt.source_shipment_item_id
      AND ledger.product_variant_id=receipt.product_variant_id AND ledger.from_location_id=receipt.warehouse_location_id
      AND ledger.variant_qty_delta=-receipt.quantity AND ledger.reserved_qty_delta=0
      AND ledger.variant_qty_before-ledger.variant_qty_after=receipt.quantity
      AND ledger.source_state='on_hand' AND ledger.target_state='shipped'
      AND ledger.total_cost_mills=receipt.total_cost_mills AS ledger_valid,
    source.shipment_id=receipt.outbound_shipment_id AND source.product_variant_id=receipt.product_variant_id
      AND source.qty=receipt.quantity AND source.shipment_item_purpose=receipt.purpose
      AND source.order_item_id IS NULL AND source.correction_for_shipment_item_id IS NULL
      AND source.replacement_for_order_item_id IS NOT DISTINCT FROM receipt.replacement_for_order_item_id AS source_valid
  INTO evidence
  FROM inventory.operational_shipment_dispatch_receipts receipt
  JOIN inventory.inventory_transactions ledger ON ledger.id=receipt.inventory_transaction_id
  JOIN wms.outbound_shipment_items source ON source.id=receipt.source_shipment_item_id
  LEFT JOIN LATERAL (
    SELECT SUM(movement.quantity) AS quantity, SUM(movement.total_cost_mills) AS total_cost_mills,
      COUNT(*) FILTER (WHERE lot.id IS NULL OR lot.product_variant_id<>receipt.product_variant_id
        OR lot.warehouse_location_id<>receipt.warehouse_location_id) AS invalid_count
    FROM inventory.operational_shipment_dispatch_lots movement
    LEFT JOIN inventory.inventory_lots lot ON lot.id=movement.inventory_lot_id
    WHERE movement.receipt_id=receipt.id
  ) journal ON true
  WHERE receipt.id=receipt_key;
  IF evidence.id IS NULL OR evidence.ledger_valid IS DISTINCT FROM TRUE OR evidence.source_valid IS DISTINCT FROM TRUE
    OR evidence.lot_quantity IS DISTINCT FROM evidence.quantity::numeric
    OR evidence.lot_cost IS DISTINCT FROM evidence.total_cost_mills::numeric OR evidence.invalid_count IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE='Operational shipment requires exact source, on-hand debit, and complete FIFO quantity/cost journal';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER operational_shipment_dispatch_receipts_complete
AFTER INSERT ON inventory.operational_shipment_dispatch_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION inventory.validate_operational_shipment_dispatch_journal();
CREATE CONSTRAINT TRIGGER operational_shipment_dispatch_lots_complete
AFTER INSERT ON inventory.operational_shipment_dispatch_lots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION inventory.validate_operational_shipment_dispatch_journal();
