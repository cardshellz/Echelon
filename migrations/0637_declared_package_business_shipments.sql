-- Phase 2 package-level business-shipment authority.
--
-- An explicit outbound label observation establishes the monotonic fact that
-- the declared package is business-shipped. This fact remains separate from
-- item-level allocation, inventory, channel fulfillment, carrier possession,
-- and notification execution.

CREATE TABLE wms.declared_package_business_shipments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipping_provider_label_id BIGINT NOT NULL,
  recognition_event_id BIGINT NOT NULL,
  business_shipment_recognized_at TIMESTAMPTZ NOT NULL,
  provider_occurred_at TIMESTAMPTZ,
  recognition_source VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT uq_declared_package_business_shipments_label
    UNIQUE (shipping_provider_label_id),
  CONSTRAINT uq_declared_package_business_shipments_event
    UNIQUE (recognition_event_id),
  CONSTRAINT fk_declared_package_business_shipments_label
    FOREIGN KEY (shipping_provider_label_id)
    REFERENCES wms.shipping_provider_labels(id) ON DELETE RESTRICT,
  CONSTRAINT fk_declared_package_business_shipments_event_label
    FOREIGN KEY (recognition_event_id, shipping_provider_label_id)
    REFERENCES wms.shipping_provider_label_events(id, shipping_provider_label_id)
    ON DELETE RESTRICT,
  CONSTRAINT declared_package_business_shipments_source_chk
    CHECK (recognition_source = 'outbound_label_observed')
);

CREATE INDEX idx_declared_package_business_shipments_recognized
  ON wms.declared_package_business_shipments(
    business_shipment_recognized_at,
    id
  );

CREATE OR REPLACE FUNCTION wms.guard_declared_package_business_shipment_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  persisted_event_type VARCHAR(40);
  persisted_label_direction VARCHAR(20);
  persisted_received_at TIMESTAMPTZ;
  persisted_provider_occurred_at TIMESTAMPTZ;
  persisted_is_return_label JSONB;
BEGIN
  SELECT
    event.event_type,
    label.label_direction,
    event.received_at,
    event.provider_occurred_at,
    event.sanitized_payload->'isReturnLabel'
  INTO
    persisted_event_type,
    persisted_label_direction,
    persisted_received_at,
    persisted_provider_occurred_at,
    persisted_is_return_label
  FROM wms.shipping_provider_label_events AS event
  JOIN wms.shipping_provider_labels AS label
    ON label.id = event.shipping_provider_label_id
  WHERE event.id = NEW.recognition_event_id
    AND event.shipping_provider_label_id = NEW.shipping_provider_label_id
  FOR KEY SHARE OF event, label;

  IF persisted_event_type IS NULL THEN
    RAISE EXCEPTION 'declared package business-shipment evidence does not exist'
      USING ERRCODE = '23503';
  END IF;
  IF persisted_event_type <> 'label_observed'
     OR persisted_label_direction <> 'outbound'
     OR persisted_is_return_label IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'declared package business shipment requires explicit outbound label evidence'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.business_shipment_recognized_at IS DISTINCT FROM persisted_received_at
     OR NEW.provider_occurred_at IS DISTINCT FROM persisted_provider_occurred_at
     OR NEW.recognition_source <> 'outbound_label_observed' THEN
    RAISE EXCEPTION 'declared package business-shipment fact differs from its evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION wms.record_declared_package_business_shipment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  persisted_label_direction VARCHAR(20);
BEGIN
  IF NEW.event_type <> 'label_observed'
     OR NEW.sanitized_payload->'isReturnLabel' IS DISTINCT FROM 'false'::jsonb THEN
    RETURN NEW;
  END IF;

  SELECT label.label_direction
  INTO persisted_label_direction
  FROM wms.shipping_provider_labels AS label
  WHERE label.id = NEW.shipping_provider_label_id
  FOR KEY SHARE;

  IF persisted_label_direction <> 'outbound' THEN
    RETURN NEW;
  END IF;

  INSERT INTO wms.declared_package_business_shipments (
    shipping_provider_label_id,
    recognition_event_id,
    business_shipment_recognized_at,
    provider_occurred_at,
    recognition_source
  ) VALUES (
    NEW.shipping_provider_label_id,
    NEW.id,
    NEW.received_at,
    NEW.provider_occurred_at,
    'outbound_label_observed'
  )
  ON CONFLICT (shipping_provider_label_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_declared_package_business_shipments_insert_guard
BEFORE INSERT ON wms.declared_package_business_shipments
FOR EACH ROW EXECUTE FUNCTION wms.guard_declared_package_business_shipment_insert();

CREATE TRIGGER trg_declared_package_business_shipments_immutable
BEFORE UPDATE OR DELETE ON wms.declared_package_business_shipments
FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

CREATE TRIGGER trg_shipping_provider_label_events_business_shipment
AFTER INSERT ON wms.shipping_provider_label_events
FOR EACH ROW EXECUTE FUNCTION wms.record_declared_package_business_shipment();

COMMENT ON TABLE wms.declared_package_business_shipments IS
  'One append-only package-level business-shipped fact per explicitly outbound provider label. No item-level or remote effect is authorized by this table.';

-- Existing labels are intentionally not backfilled. Historical label direction
-- defaults do not prove that the retained event explicitly identified outbound
-- transport; only new events carrying isReturnLabel=false create this fact.
