-- Migration 0645: audited activation for exact package-allocation commercial fulfillment.
--
-- The package-allocation materializer introduced by migration 0641 writes only
-- non-dispatching shadow commands. Each command must receive an immutable
-- activation record before it may become claimable by the channel worker.

CREATE TABLE oms.package_allocation_commercial_fulfillment_activations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  package_allocation_plan_id BIGINT NOT NULL
    REFERENCES wms.package_allocation_plans(id) ON DELETE RESTRICT,
  channel_fulfillment_push_id BIGINT NOT NULL
    REFERENCES oms.channel_fulfillment_pushes(id) ON DELETE RESTRICT,
  activated_by VARCHAR(200) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  correlation_id VARCHAR(100),
  causation_id VARCHAR(100),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  activated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT package_allocation_commercial_activation_actor_chk
    CHECK (BTRIM(activated_by) <> ''),
  CONSTRAINT package_allocation_commercial_activation_reason_chk
    CHECK (BTRIM(reason) <> ''),
  CONSTRAINT package_allocation_commercial_activation_metadata_chk
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT uq_package_allocation_commercial_activation_plan_command
    UNIQUE (package_allocation_plan_id, channel_fulfillment_push_id),
  CONSTRAINT uq_package_allocation_commercial_activation_command
    UNIQUE (channel_fulfillment_push_id)
);

CREATE INDEX idx_package_allocation_commercial_activation_plan
  ON oms.package_allocation_commercial_fulfillment_activations (
    package_allocation_plan_id,
    channel_fulfillment_push_id
  );

CREATE OR REPLACE FUNCTION oms.validate_package_allocation_commercial_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence RECORD;
BEGIN
  SELECT
    allocation_plan.plan_version,
    allocation_plan.outcome,
    allocation_group.current_version,
    channel_command.push_status,
    channel_command.metadata
  INTO evidence
  FROM wms.package_allocation_plans AS allocation_plan
  JOIN wms.package_allocation_groups AS allocation_group
    ON allocation_group.id = allocation_plan.package_allocation_group_id
  JOIN oms.channel_fulfillment_pushes AS channel_command
    ON channel_command.id = NEW.channel_fulfillment_push_id
  WHERE allocation_plan.id = NEW.package_allocation_plan_id
  FOR UPDATE OF allocation_plan, allocation_group, channel_command;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Package-allocation commercial fulfillment activation lacks persisted plan or command evidence'
      USING ERRCODE = '23514';
  END IF;

  IF evidence.outcome <> 'proposed'
     OR evidence.current_version <> evidence.plan_version
     OR evidence.push_status <> 'shadow'
     OR evidence.metadata->>'materializationContract'
          IS DISTINCT FROM 'package-allocation-commercial-shadow-v1'
     OR evidence.metadata->>'packageAllocationPlanId'
          IS DISTINCT FROM NEW.package_allocation_plan_id::text
     OR NOT EXISTS (
       SELECT 1
       FROM oms.channel_fulfillment_push_items AS push_item
       JOIN wms.package_allocation_effect_intents AS intent
         ON intent.id = push_item.package_allocation_effect_intent_id
       WHERE push_item.channel_fulfillment_push_id = NEW.channel_fulfillment_push_id
         AND intent.package_allocation_plan_id = NEW.package_allocation_plan_id
         AND intent.effect_type = 'commercial_fulfillment'
         AND intent.executable IS FALSE
     )
     OR EXISTS (
       SELECT 1
       FROM oms.channel_fulfillment_push_items AS push_item
       WHERE push_item.channel_fulfillment_push_id = NEW.channel_fulfillment_push_id
         AND push_item.package_allocation_effect_intent_id IS NULL
     )
     OR EXISTS (
       SELECT 1
       FROM oms.channel_fulfillment_push_items AS push_item
       JOIN wms.package_allocation_effect_intents AS intent
         ON intent.id = push_item.package_allocation_effect_intent_id
       WHERE push_item.channel_fulfillment_push_id = NEW.channel_fulfillment_push_id
         AND intent.package_allocation_plan_id IS DISTINCT FROM NEW.package_allocation_plan_id
     )
     OR EXISTS (
       SELECT 1
       FROM wms.package_allocation_effect_intents AS intent
       WHERE intent.package_allocation_plan_id = NEW.package_allocation_plan_id
         AND intent.effect_type = 'commercial_fulfillment'
         AND (
           intent.executable IS DISTINCT FROM FALSE
           OR intent.quantity IS NULL
           OR intent.quantity IS DISTINCT FROM (
             SELECT COALESCE(SUM(push_item.quantity_pushed), 0)::integer
             FROM oms.channel_fulfillment_push_items AS push_item
             WHERE push_item.package_allocation_effect_intent_id = intent.id
           )
         )
     ) THEN
    RAISE EXCEPTION
      'Package-allocation commercial fulfillment activation lacks current exact shadow authority'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER package_allocation_commercial_activation_insert_guard
BEFORE INSERT
ON oms.package_allocation_commercial_fulfillment_activations
FOR EACH ROW
EXECUTE FUNCTION oms.validate_package_allocation_commercial_activation();

CREATE OR REPLACE FUNCTION oms.require_package_allocation_commercial_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.push_status = 'shadow'
     AND NEW.push_status = 'pending'
     AND NOT EXISTS (
       SELECT 1
       FROM oms.package_allocation_commercial_fulfillment_activations AS activation
       WHERE activation.channel_fulfillment_push_id = OLD.id
     ) THEN
    RAISE EXCEPTION
      'Shadow channel fulfillment command % has no commercial activation evidence',
      OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER channel_fulfillment_push_activation_guard
BEFORE UPDATE OF push_status
ON oms.channel_fulfillment_pushes
FOR EACH ROW
EXECUTE FUNCTION oms.require_package_allocation_commercial_activation();

CREATE OR REPLACE FUNCTION oms.guard_package_allocation_commercial_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Package-allocation commercial fulfillment activations are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER package_allocation_commercial_activation_append_only
BEFORE UPDATE OR DELETE
ON oms.package_allocation_commercial_fulfillment_activations
FOR EACH ROW
EXECUTE FUNCTION oms.guard_package_allocation_commercial_activation();

COMMENT ON TABLE oms.package_allocation_commercial_fulfillment_activations IS
  'Immutable proof that an exact package-allocation shadow command passed the label-time commercial activation gate.';
