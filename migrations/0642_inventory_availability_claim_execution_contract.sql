BEGIN;

ALTER TABLE inventory.availability_claim_operations
  ADD COLUMN committed_output_qty bigint;

ALTER TABLE inventory.availability_claim_operations
  ADD CONSTRAINT availability_claim_operations_committed_output_chk CHECK (
    committed_output_qty IS NULL
    OR (committed_output_qty > 0 AND committed_output_qty <= output_qty)
  );

ALTER TABLE inventory.availability_claim_resources
  ADD COLUMN producer_operation_key varchar(300);

ALTER TABLE inventory.availability_claim_lot_allocations
  ADD COLUMN po_unit_cost_mills bigint,
  ADD COLUMN packaging_unit_cost_mills bigint,
  ADD COLUMN landed_unit_cost_mills bigint;

ALTER TABLE inventory.availability_claim_lot_allocations
  ADD CONSTRAINT availability_claim_lot_allocations_cost_breakdown_chk CHECK (
    (po_unit_cost_mills IS NULL AND packaging_unit_cost_mills IS NULL AND landed_unit_cost_mills IS NULL)
    OR (
      po_unit_cost_mills >= 0
      AND packaging_unit_cost_mills >= 0
      AND landed_unit_cost_mills >= 0
      AND po_unit_cost_mills + packaging_unit_cost_mills + landed_unit_cost_mills = unit_cost_mills
    )
  );

ALTER TABLE inventory.availability_claim_resources
  ADD CONSTRAINT availability_claim_resources_producer_operation_fk
  FOREIGN KEY (claim_id, producer_operation_key)
  REFERENCES inventory.availability_claim_operations(claim_id, operation_key)
  DEFERRABLE INITIALLY DEFERRED;

DROP INDEX inventory.availability_claim_resources_identity_uq;

CREATE UNIQUE INDEX availability_claim_resources_identity_uq
  ON inventory.availability_claim_resources (
    claim_line_id,
    warehouse_id,
    warehouse_location_id,
    inventory_level_id,
    source_variant_id,
    COALESCE(consumer_operation_key, ''),
    COALESCE(producer_operation_key, '')
  );

COMMENT ON COLUMN inventory.availability_claim_operations.committed_output_qty IS
  'Exact produced quantity committed to the parent operation or order line. Null is reserved for pre-0642 evidence and cannot be executed.';
COMMENT ON COLUMN inventory.availability_claim_resources.producer_operation_key IS
  'Operation that physically produced this claim-owned resource; null identifies inventory that existed when the claim was created.';
COMMENT ON CONSTRAINT availability_claim_lot_allocations_cost_breakdown_chk
  ON inventory.availability_claim_lot_allocations IS
  'New claims snapshot the exact normalized PO, packaging, and landed mill components. All-null identifies pre-0642 evidence and cannot be executed.';

COMMIT;
