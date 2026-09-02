BEGIN;

ALTER TABLE inventory.availability_claim_lot_allocations
  ADD CONSTRAINT availability_claim_lot_allocations_id_claim_uq UNIQUE (id, claim_id);

ALTER TABLE inventory.build_component_reservations
  ADD COLUMN reservation_owner varchar(30) NOT NULL DEFAULT 'build_order',
  ADD COLUMN availability_claim_id bigint,
  ADD COLUMN availability_claim_lot_allocation_id bigint;

ALTER TABLE inventory.build_component_reservations
  ADD CONSTRAINT build_component_reservations_owner_chk CHECK (
    (reservation_owner = 'build_order'
      AND availability_claim_id IS NULL
      AND availability_claim_lot_allocation_id IS NULL)
    OR
    (reservation_owner = 'availability_claim'
      AND availability_claim_id IS NOT NULL
      AND availability_claim_lot_allocation_id IS NOT NULL)
  ),
  ADD CONSTRAINT build_component_reservations_claim_allocation_fk
    FOREIGN KEY (availability_claim_lot_allocation_id, availability_claim_id)
    REFERENCES inventory.availability_claim_lot_allocations(id, claim_id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX build_component_reservations_claim_allocation_uq
  ON inventory.build_component_reservations (availability_claim_lot_allocation_id)
  WHERE availability_claim_lot_allocation_id IS NOT NULL;

CREATE TABLE inventory.availability_claim_build_handoffs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id bigint NOT NULL REFERENCES inventory.availability_claims(id) ON DELETE RESTRICT,
  claim_operation_id bigint NOT NULL,
  build_order_id integer NOT NULL REFERENCES inventory.build_orders(id) ON DELETE RESTRICT,
  status varchar(30) NOT NULL,
  adopted_reservation_qty bigint NOT NULL,
  created_by varchar(100) NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_claim_build_handoffs_operation_fk
    FOREIGN KEY (claim_operation_id, claim_id)
    REFERENCES inventory.availability_claim_operations(id, claim_id)
    ON DELETE RESTRICT,
  CONSTRAINT availability_claim_build_handoffs_operation_uq UNIQUE (claim_id, claim_operation_id),
  CONSTRAINT availability_claim_build_handoffs_build_order_uq UNIQUE (build_order_id),
  CONSTRAINT availability_claim_build_handoffs_quantity_chk CHECK (adopted_reservation_qty > 0),
  CONSTRAINT availability_claim_build_handoffs_actor_chk CHECK (btrim(created_by) <> ''),
  CONSTRAINT availability_claim_build_handoffs_status_chk CHECK (
    status IN ('handed_off', 'completed', 'cancelled')
  ),
  CONSTRAINT availability_claim_build_handoffs_lifecycle_chk CHECK (
    (status = 'handed_off' AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND completed_at IS NULL AND cancelled_at IS NOT NULL)
  )
);

CREATE INDEX availability_claim_build_handoffs_claim_status_idx
  ON inventory.availability_claim_build_handoffs (claim_id, status, id);

ALTER TABLE inventory.availability_claim_commands
  DROP CONSTRAINT availability_claim_commands_type_chk;

ALTER TABLE inventory.availability_claim_commands
  ADD CONSTRAINT availability_claim_commands_type_chk CHECK (
    command_type IN ('claim', 'release', 'cancel', 'execute', 'handoff_build')
  );

COMMENT ON TABLE inventory.availability_claim_build_handoffs IS
  'Atomic ownership transfer from one canonical component-build operation to one inventory build order. Deployment does not create handoffs or activate canonical runtime authority.';
COMMENT ON COLUMN inventory.build_component_reservations.reservation_owner IS
  'build_order means the build reserved the lot; availability_claim means the build adopted an already-reserved canonical claim allocation and must never reserve or unreserve it independently.';

COMMIT;
