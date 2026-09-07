BEGIN;

ALTER TABLE inventory.availability_claim_commands
  DROP CONSTRAINT availability_claim_commands_type_chk;
ALTER TABLE inventory.availability_claim_commands
  ADD CONSTRAINT availability_claim_commands_type_chk CHECK (
    command_type IN (
      'claim', 'replace', 'release', 'cancel', 'execute', 'handoff_build',
      'execute_build', 'pick', 'pick_observation', 'unpick', 'dispatch'
    )
  );

CREATE TABLE inventory.availability_claim_dispatch_receipts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  command_id bigint NOT NULL UNIQUE,
  claim_id bigint NOT NULL,
  claim_line_id bigint NOT NULL,
  order_id integer NOT NULL REFERENCES wms.orders(id) ON DELETE RESTRICT,
  order_item_id integer NOT NULL REFERENCES wms.order_items(id) ON DELETE RESTRICT,
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  warehouse_location_id integer NOT NULL REFERENCES warehouse.warehouse_locations(id) ON DELETE RESTRICT,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  outbound_shipment_id integer NOT NULL REFERENCES wms.outbound_shipments(id) ON DELETE RESTRICT,
  source_shipment_item_id integer NOT NULL UNIQUE REFERENCES wms.outbound_shipment_items(id) ON DELETE RESTRICT,
  physical_shipment_id bigint REFERENCES wms.physical_shipments(id) ON DELETE RESTRICT,
  physical_shipment_item_id bigint REFERENCES wms.physical_shipment_items(id) ON DELETE RESTRICT,
  quantity bigint NOT NULL,
  inventory_transaction_id integer NOT NULL UNIQUE REFERENCES inventory.inventory_transactions(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_claim_dispatch_receipts_claim_order_fk
    FOREIGN KEY (claim_id, order_id)
    REFERENCES inventory.availability_claims(id, order_id) ON DELETE RESTRICT,
  CONSTRAINT availability_claim_dispatch_receipts_line_fk
    FOREIGN KEY (claim_line_id, claim_id)
    REFERENCES inventory.availability_claim_lines(id, claim_id) ON DELETE RESTRICT,
  CONSTRAINT availability_claim_dispatch_receipts_command_fk
    FOREIGN KEY (command_id, claim_id)
    REFERENCES inventory.availability_claim_commands(id, claim_id) ON DELETE RESTRICT,
  CONSTRAINT availability_claim_dispatch_receipts_quantity_chk CHECK (quantity > 0),
  CONSTRAINT availability_claim_dispatch_receipts_physical_pair_chk CHECK (
    (physical_shipment_id IS NULL) = (physical_shipment_item_id IS NULL)
  ),
  CONSTRAINT availability_claim_dispatch_receipts_id_line_uq UNIQUE (id, claim_id, claim_line_id)
);

CREATE UNIQUE INDEX availability_claim_dispatch_receipts_physical_item_uq
  ON inventory.availability_claim_dispatch_receipts (physical_shipment_item_id)
  WHERE physical_shipment_item_id IS NOT NULL;
CREATE INDEX availability_claim_dispatch_receipts_line_idx
  ON inventory.availability_claim_dispatch_receipts (claim_id, claim_line_id, occurred_at, id);

CREATE TABLE inventory.availability_claim_dispatch_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id bigint NOT NULL,
  claim_id bigint NOT NULL,
  claim_line_id bigint NOT NULL,
  pick_movement_id bigint NOT NULL,
  quantity bigint NOT NULL,
  CONSTRAINT availability_claim_dispatch_movements_receipt_fk
    FOREIGN KEY (receipt_id, claim_id, claim_line_id)
    REFERENCES inventory.availability_claim_dispatch_receipts(id, claim_id, claim_line_id)
    ON DELETE RESTRICT,
  CONSTRAINT availability_claim_dispatch_movements_pick_fk
    FOREIGN KEY (pick_movement_id, claim_id, claim_line_id)
    REFERENCES inventory.availability_claim_pick_movements(id, claim_id, claim_line_id)
    ON DELETE RESTRICT,
  CONSTRAINT availability_claim_dispatch_movements_quantity_chk CHECK (quantity > 0),
  CONSTRAINT availability_claim_dispatch_movements_receipt_pick_uq UNIQUE (receipt_id, pick_movement_id)
);

CREATE INDEX availability_claim_dispatch_movements_pick_idx
  ON inventory.availability_claim_dispatch_movements (pick_movement_id, id);
CREATE INDEX availability_claim_dispatch_movements_receipt_idx
  ON inventory.availability_claim_dispatch_movements (receipt_id, id);

CREATE TRIGGER availability_claim_dispatch_receipts_append_only
BEFORE UPDATE OR DELETE ON inventory.availability_claim_dispatch_receipts
FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER availability_claim_dispatch_movements_append_only
BEFORE UPDATE OR DELETE ON inventory.availability_claim_dispatch_movements
FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();

CREATE FUNCTION inventory.validate_availability_claim_dispatch_journal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt_key bigint;
  receipt_quantity bigint;
  movement_quantity numeric;
  matching_command boolean;
BEGIN
  IF TG_TABLE_NAME = 'availability_claim_dispatch_receipts' THEN
    receipt_key := NEW.id;
  ELSE
    receipt_key := NEW.receipt_id;
    -- Every inserted row has a deferred callback. Only the last row needs the
    -- aggregate check, avoiding repeated full sums for a large split-lot pick.
    IF NEW.id <> (
      SELECT movement.id FROM inventory.availability_claim_dispatch_movements movement
      WHERE movement.receipt_id = receipt_key ORDER BY movement.id DESC LIMIT 1
    ) THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT receipt.quantity,
    command.command_type = 'dispatch' AND command.order_id = receipt.order_id
  INTO receipt_quantity, matching_command
  FROM inventory.availability_claim_dispatch_receipts receipt
  JOIN inventory.availability_claim_commands command
    ON command.id = receipt.command_id AND command.claim_id = receipt.claim_id
  WHERE receipt.id = receipt_key;
  IF receipt_quantity IS NULL OR matching_command IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Dispatch receipt requires its exact dispatch command and order';
  END IF;

  SELECT COALESCE(sum(movement.quantity), 0) INTO movement_quantity
  FROM inventory.availability_claim_dispatch_movements movement
  WHERE movement.receipt_id = receipt_key;
  IF movement_quantity <> receipt_quantity THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Dispatch receipt quantity must equal its exact pick movement quantities';
  END IF;
  IF EXISTS (
    SELECT 1 FROM inventory.availability_claim_dispatch_movements movement
    JOIN inventory.availability_claim_pick_movements pick ON pick.id = movement.pick_movement_id
    WHERE movement.receipt_id = receipt_key AND pick.movement_type <> 'pick'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Dispatch movements must reference original pick movements';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER availability_claim_dispatch_receipts_complete
AFTER INSERT ON inventory.availability_claim_dispatch_receipts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION inventory.validate_availability_claim_dispatch_journal();
CREATE CONSTRAINT TRIGGER availability_claim_dispatch_movements_complete
AFTER INSERT ON inventory.availability_claim_dispatch_movements
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION inventory.validate_availability_claim_dispatch_journal();

COMMENT ON TABLE inventory.availability_claim_dispatch_receipts IS
  'Append-only full-source-item dispatch receipts. Separate shipment items may partially fulfill an order or claim. Mutable source identity and remaining picked ownership are validated under owner locks before insertion.';
COMMENT ON TABLE inventory.availability_claim_dispatch_movements IS
  'Append-only consumption of exact original picks. Lot, resource, and cost lineage are derived from the referenced pick, never copied or newly minted.';
COMMENT ON COLUMN inventory.availability_claim_dispatch_receipts.inventory_transaction_id IS
  'Existing ship transaction for this exact source item; dispatch is a claim command, not a new inventory transaction type. Existing legacy ship unique indexes are unchanged.';

COMMIT;
