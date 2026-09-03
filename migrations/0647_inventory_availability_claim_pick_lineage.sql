BEGIN;

ALTER TABLE inventory.availability_claim_lines
  ADD COLUMN picked_target_qty bigint NOT NULL DEFAULT 0;

ALTER TABLE inventory.availability_claim_lines
  DROP CONSTRAINT availability_claim_lines_quantity_chk;

ALTER TABLE inventory.availability_claim_lines
  ADD CONSTRAINT availability_claim_lines_quantity_chk CHECK (
    requested_qty > 0
    AND planned_qty >= 0
    AND shortfall_qty >= 0
    AND requested_qty = planned_qty + shortfall_qty
    AND released_target_qty >= 0
    AND consumed_target_qty >= 0
    AND picked_target_qty >= 0
    AND released_target_qty + consumed_target_qty + picked_target_qty <= planned_qty
  );

ALTER TABLE inventory.availability_claim_resources
  ADD COLUMN picked_qty bigint NOT NULL DEFAULT 0;

ALTER TABLE inventory.availability_claim_resources
  DROP CONSTRAINT availability_claim_resources_quantity_chk;

ALTER TABLE inventory.availability_claim_resources
  ADD CONSTRAINT availability_claim_resources_quantity_chk CHECK (
    claimed_qty > 0
    AND released_qty >= 0
    AND consumed_qty >= 0
    AND picked_qty >= 0
    AND released_qty + consumed_qty + picked_qty <= claimed_qty
  );

ALTER TABLE inventory.availability_claim_lot_allocations
  ADD COLUMN picked_qty bigint NOT NULL DEFAULT 0;

ALTER TABLE inventory.availability_claim_lot_allocations
  DROP CONSTRAINT availability_claim_lot_allocations_quantity_chk;

ALTER TABLE inventory.availability_claim_lot_allocations
  ADD CONSTRAINT availability_claim_lot_allocations_quantity_chk CHECK (
    claimed_qty > 0
    AND released_qty >= 0
    AND consumed_qty >= 0
    AND picked_qty >= 0
    AND released_qty + consumed_qty + picked_qty <= claimed_qty
  );

ALTER TABLE inventory.availability_claim_lot_allocations
  ADD CONSTRAINT availability_claim_lot_allocations_id_lineage_uq
  UNIQUE (id, inventory_lot_id, claim_resource_id, claim_id);

ALTER TABLE inventory.availability_claim_commands
  DROP CONSTRAINT availability_claim_commands_type_chk;

ALTER TABLE inventory.availability_claim_commands
  ADD CONSTRAINT availability_claim_commands_type_chk CHECK (
    command_type IN (
      'claim', 'release', 'cancel', 'execute', 'handoff_build', 'execute_build',
      'pick', 'unpick'
    )
  );

ALTER TABLE inventory.availability_claim_commands
  ADD CONSTRAINT availability_claim_commands_id_claim_uq UNIQUE (id, claim_id);

CREATE TABLE inventory.availability_claim_pick_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id bigint NOT NULL REFERENCES inventory.availability_claims(id) ON DELETE RESTRICT,
  claim_line_id bigint NOT NULL,
  claim_resource_id bigint NOT NULL,
  claim_lot_allocation_id bigint NOT NULL,
  inventory_lot_id integer NOT NULL REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  command_id bigint NOT NULL,
  order_item_cost_id integer NOT NULL
    REFERENCES oms.order_item_costs(id) ON DELETE RESTRICT,
  movement_type varchar(20) NOT NULL,
  quantity bigint NOT NULL,
  reverses_pick_movement_id bigint,
  unit_cost_mills bigint NOT NULL,
  total_cost_mills bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_claim_pick_movements_line_fk
    FOREIGN KEY (claim_line_id, claim_id)
    REFERENCES inventory.availability_claim_lines(id, claim_id) ON DELETE RESTRICT,
  CONSTRAINT availability_claim_pick_movements_resource_fk
    FOREIGN KEY (claim_resource_id, claim_id)
    REFERENCES inventory.availability_claim_resources(id, claim_id) ON DELETE RESTRICT,
  CONSTRAINT availability_claim_pick_movements_allocation_fk
    FOREIGN KEY (claim_lot_allocation_id, inventory_lot_id, claim_resource_id, claim_id)
    REFERENCES inventory.availability_claim_lot_allocations(
      id, inventory_lot_id, claim_resource_id, claim_id
    ) ON DELETE RESTRICT,
  CONSTRAINT availability_claim_pick_movements_command_fk
    FOREIGN KEY (command_id, claim_id)
    REFERENCES inventory.availability_claim_commands(id, claim_id) ON DELETE RESTRICT,
  CONSTRAINT availability_claim_pick_movements_type_chk CHECK (
    (movement_type = 'pick' AND reverses_pick_movement_id IS NULL)
    OR (movement_type = 'unpick' AND reverses_pick_movement_id IS NOT NULL)
  ),
  CONSTRAINT availability_claim_pick_movements_quantity_chk CHECK (quantity > 0),
  CONSTRAINT availability_claim_pick_movements_cost_chk CHECK (
    unit_cost_mills >= 0 AND total_cost_mills = unit_cost_mills * quantity
  ),
  CONSTRAINT availability_claim_pick_movements_id_line_uq UNIQUE (id, claim_id, claim_line_id),
  CONSTRAINT availability_claim_pick_movements_reverse_fk
    FOREIGN KEY (reverses_pick_movement_id, claim_id, claim_line_id)
    REFERENCES inventory.availability_claim_pick_movements(id, claim_id, claim_line_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX availability_claim_pick_movements_command_allocation_uq
  ON inventory.availability_claim_pick_movements (
    command_id,
    claim_lot_allocation_id,
    COALESCE(reverses_pick_movement_id, 0)
  );

CREATE INDEX availability_claim_pick_movements_line_idx
  ON inventory.availability_claim_pick_movements (claim_line_id, occurred_at, id);

CREATE INDEX availability_claim_pick_movements_reverse_idx
  ON inventory.availability_claim_pick_movements (reverses_pick_movement_id, id)
  WHERE reverses_pick_movement_id IS NOT NULL;

CREATE TRIGGER availability_claim_pick_movements_append_only
BEFORE UPDATE OR DELETE ON inventory.availability_claim_pick_movements
FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();

COMMENT ON COLUMN inventory.availability_claim_lines.picked_target_qty IS
  'Target units physically removed from on-hand for this order line but not yet shipped.';
COMMENT ON COLUMN inventory.availability_claim_resources.picked_qty IS
  'Claim-owned units moved from reserved on-hand to the picked bucket. Unpick reverses this balance explicitly.';
COMMENT ON TABLE inventory.availability_claim_pick_movements IS
  'Append-only exact lot and COGS lineage for canonical claim pick and compensating unpick commands.';

COMMIT;
