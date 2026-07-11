-- Shipment-cost capture, deterministic vendor-shipping allocation, and
-- immutable carrier-claim intake snapshots.

ALTER TABLE wms.outbound_shipments
  ADD COLUMN IF NOT EXISTS service_code varchar(100),
  ADD COLUMN IF NOT EXISTS carrier_cost_source varchar(40),
  ADD COLUMN IF NOT EXISTS carrier_cost_recorded_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'outbound_shipments_carrier_cost_capture_chk'
      AND conrelid = 'wms.outbound_shipments'::regclass
  ) THEN
    ALTER TABLE wms.outbound_shipments
      ADD CONSTRAINT outbound_shipments_carrier_cost_capture_chk CHECK (
        (carrier_cost_source IS NULL AND carrier_cost_recorded_at IS NULL)
        OR (
          btrim(carrier_cost_source) <> ''
          AND carrier_cost_recorded_at IS NOT NULL
          AND carrier_cost_cents > 0
        )
      );
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS dropship.dropship_shipment_shipping_allocations (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  intake_id integer NOT NULL REFERENCES dropship.dropship_order_intake(id) ON DELETE RESTRICT,
  economics_snapshot_id integer NOT NULL REFERENCES dropship.dropship_order_economics_snapshots(id) ON DELETE RESTRICT,
  oms_order_id bigint NOT NULL REFERENCES oms.oms_orders(id) ON DELETE RESTRICT,
  wms_order_id integer NOT NULL REFERENCES wms.orders(id) ON DELETE RESTRICT,
  wms_shipment_id integer NOT NULL REFERENCES wms.outbound_shipments(id) ON DELETE RESTRICT,
  currency varchar(3) NOT NULL,
  allocation_method varchar(80) NOT NULL,
  order_shipping_charge_cents bigint NOT NULL,
  shipment_carrier_cost_cents bigint,
  total_carrier_cost_cents bigint,
  allocated_shipping_charge_cents bigint NOT NULL,
  allocation_group_hash varchar(64) NOT NULL,
  source_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_shipment_shipping_allocation_intake_shipment_uq
    UNIQUE (intake_id, wms_shipment_id),
  CONSTRAINT dropship_shipment_shipping_allocation_currency_chk
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT dropship_shipment_shipping_allocation_method_chk
    CHECK (allocation_method IN (
      'single_shipment_full_charge_v1',
      'carrier_cost_proportional_largest_remainder_v1',
      'zero_shipping_charge_v1'
    )),
  CONSTRAINT dropship_shipment_shipping_allocation_money_chk CHECK (
    order_shipping_charge_cents >= 0
    AND (shipment_carrier_cost_cents IS NULL OR shipment_carrier_cost_cents > 0)
    AND (total_carrier_cost_cents IS NULL OR total_carrier_cost_cents > 0)
    AND allocated_shipping_charge_cents >= 0
    AND allocated_shipping_charge_cents <= order_shipping_charge_cents
  ),
  CONSTRAINT dropship_shipment_shipping_allocation_method_values_chk CHECK (
    (allocation_method = 'zero_shipping_charge_v1'
      AND order_shipping_charge_cents = 0
      AND allocated_shipping_charge_cents = 0)
    OR (allocation_method = 'single_shipment_full_charge_v1'
      AND allocated_shipping_charge_cents = order_shipping_charge_cents)
    OR (allocation_method = 'carrier_cost_proportional_largest_remainder_v1'
      AND order_shipping_charge_cents > 0
      AND shipment_carrier_cost_cents > 0
      AND total_carrier_cost_cents > 0)
  ),
  CONSTRAINT dropship_shipment_shipping_allocation_hash_chk
    CHECK (allocation_group_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS dropship_shipment_shipping_allocation_economics_idx
  ON dropship.dropship_shipment_shipping_allocations(economics_snapshot_id, wms_shipment_id);

ALTER TABLE dropship.dropship_carrier_claims
  ADD COLUMN IF NOT EXISTS wms_shipment_id integer REFERENCES wms.outbound_shipments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS currency varchar(3),
  ADD COLUMN IF NOT EXISTS carrier_protection_assignment_id integer REFERENCES dropship.dropship_carrier_protection_assignments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS shipping_allocation_id bigint REFERENCES dropship.dropship_shipment_shipping_allocations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS occurred_at timestamptz,
  ADD COLUMN IF NOT EXISTS eligible_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(200),
  ADD COLUMN IF NOT EXISTS request_hash varchar(64),
  ADD COLUMN IF NOT EXISTS actor_type varchar(40),
  ADD COLUMN IF NOT EXISTS actor_id varchar(255);

ALTER TABLE dropship.dropship_carrier_claims
  DROP CONSTRAINT IF EXISTS dropship_carrier_claim_money_chk;
ALTER TABLE dropship.dropship_carrier_claims
  ADD CONSTRAINT dropship_carrier_claim_money_chk CHECK (
    (claim_amount_cents IS NULL OR claim_amount_cents >= 0)
    AND (insurance_pool_credit_cents IS NULL OR insurance_pool_credit_cents >= 0)
    AND (wholesale_cost_snapshot_cents IS NULL OR wholesale_cost_snapshot_cents >= 0)
    AND (shipping_charge_snapshot_cents IS NULL OR shipping_charge_snapshot_cents >= 0)
    AND (calculated_credit_cents IS NULL OR calculated_credit_cents >= 0)
    AND (approved_credit_cents IS NULL OR approved_credit_cents >= 0)
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'dropship_carrier_claim_intake_snapshot_chk'
      AND conrelid = 'dropship.dropship_carrier_claims'::regclass
  ) THEN
    ALTER TABLE dropship.dropship_carrier_claims
      ADD CONSTRAINT dropship_carrier_claim_intake_snapshot_chk CHECK (
        wms_shipment_id IS NULL OR (
          intake_id IS NOT NULL
          AND currency IS NOT NULL
          AND currency ~ '^[A-Z]{3}$'
          AND carrier IS NOT NULL
          AND btrim(carrier) <> ''
          AND tracking_number IS NOT NULL
          AND btrim(tracking_number) <> ''
          AND event_type IS NOT NULL
          AND event_type IN ('loss','misdelivery','damage')
          AND policy_id IS NOT NULL
          AND carrier_protection_assignment_id IS NOT NULL
          AND shipping_allocation_id IS NOT NULL
          AND policy_snapshot IS NOT NULL
          AND source_snapshot IS NOT NULL
          AND wholesale_cost_snapshot_cents IS NOT NULL
          AND wholesale_cost_snapshot_cents >= 0
          AND shipping_charge_snapshot_cents IS NOT NULL
          AND shipping_charge_snapshot_cents >= 0
          AND calculated_credit_cents IS NOT NULL
          AND calculated_credit_cents >= 0
          AND occurred_at IS NOT NULL
          AND eligible_at IS NOT NULL
          AND idempotency_key IS NOT NULL
          AND btrim(idempotency_key) <> ''
          AND request_hash IS NOT NULL
          AND request_hash ~ '^[0-9a-f]{64}$'
          AND actor_type IS NOT NULL
          AND actor_type IN ('admin','system')
          AND (actor_type <> 'admin' OR (actor_id IS NOT NULL AND btrim(actor_id) <> ''))
        )
      ) NOT VALID;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS dropship_carrier_claim_idempotency_idx
  ON dropship.dropship_carrier_claims(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS dropship_carrier_claim_shipment_event_idx
  ON dropship.dropship_carrier_claims(wms_shipment_id, event_type)
  WHERE wms_shipment_id IS NOT NULL AND event_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS dropship_carrier_claim_intake_created_idx
  ON dropship.dropship_carrier_claims(intake_id, created_at DESC);

CREATE OR REPLACE FUNCTION dropship.guard_shipment_shipping_allocation_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'dropship shipment shipping allocations are immutable'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS dropship_shipment_shipping_allocation_update_guard
  ON dropship.dropship_shipment_shipping_allocations;
CREATE TRIGGER dropship_shipment_shipping_allocation_update_guard
  BEFORE UPDATE OR DELETE ON dropship.dropship_shipment_shipping_allocations
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_shipment_shipping_allocation_snapshot();

CREATE OR REPLACE FUNCTION dropship.guard_carrier_claim_policy_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.policy_id IS NOT NULL AND (
    NEW.event_type IS DISTINCT FROM OLD.event_type
    OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
    OR NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot
    OR NEW.wholesale_cost_snapshot_cents IS DISTINCT FROM OLD.wholesale_cost_snapshot_cents
    OR NEW.shipping_charge_snapshot_cents IS DISTINCT FROM OLD.shipping_charge_snapshot_cents
    OR NEW.calculated_credit_cents IS DISTINCT FROM OLD.calculated_credit_cents
    OR NEW.intake_id IS DISTINCT FROM OLD.intake_id
    OR NEW.wms_shipment_id IS DISTINCT FROM OLD.wms_shipment_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.carrier IS DISTINCT FROM OLD.carrier
    OR NEW.tracking_number IS DISTINCT FROM OLD.tracking_number
    OR NEW.carrier_protection_assignment_id IS DISTINCT FROM OLD.carrier_protection_assignment_id
    OR NEW.shipping_allocation_id IS DISTINCT FROM OLD.shipping_allocation_id
    OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
    OR NEW.eligible_at IS DISTINCT FROM OLD.eligible_at
    OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.actor_type IS DISTINCT FROM OLD.actor_type
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
  ) THEN
    RAISE EXCEPTION 'carrier-claim policy and source snapshots are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
