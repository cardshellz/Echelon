-- Automatic selection changes shipping execution, not immutable return claims.
-- Existing settings and parcels remain explicitly fixed-service records.
ALTER TABLE returns.customer_return_settings
  ADD COLUMN selection_mode VARCHAR(30) NOT NULL DEFAULT 'fixed_service',
  ADD COLUMN carrier_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  ALTER COLUMN carrier_id DROP NOT NULL,
  ALTER COLUMN service_code DROP NOT NULL,
  ADD CONSTRAINT customer_return_settings_selection_chk CHECK (
    (selection_mode='fixed_service' AND carrier_id IS NOT NULL AND service_code IS NOT NULL AND carrier_rules='[]'::jsonb)
    OR (selection_mode='cheapest_eligible' AND carrier_id IS NULL AND service_code IS NULL
      AND jsonb_typeof(carrier_rules)='array' AND jsonb_array_length(carrier_rules) BETWEEN 1 AND 100)
  );
ALTER TABLE returns.customer_return_parcels
  ADD COLUMN selection_mode VARCHAR(30) NOT NULL DEFAULT 'fixed_service',
  ALTER COLUMN carrier_id DROP NOT NULL,
  ALTER COLUMN service_code DROP NOT NULL,
  ADD CONSTRAINT customer_return_parcels_selection_chk CHECK (
    (selection_mode='fixed_service' AND carrier_id IS NOT NULL AND service_code IS NOT NULL)
    OR (selection_mode='cheapest_eligible' AND carrier_id IS NULL AND service_code IS NULL)
  );

CREATE TABLE returns.customer_return_quote_decisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parcel_id BIGINT NOT NULL REFERENCES returns.customer_return_parcels(id),
  settings_version INTEGER NOT NULL CHECK (settings_version>0),
  settings_snapshot JSONB NOT NULL CHECK (jsonb_typeof(settings_snapshot)='object'),
  shipment_snapshot JSONB NOT NULL CHECK (jsonb_typeof(shipment_snapshot)='object'),
  shipment_hash VARCHAR(64) NOT NULL CHECK (shipment_hash ~ '^[a-f0-9]{64}$'),
  quote_result JSONB CHECK (quote_result IS NULL OR jsonb_typeof(quote_result)='object'),
  selected_rate JSONB CHECK (selected_rate IS NULL OR jsonb_typeof(selected_rate)='object'),
  status VARCHAR(20) NOT NULL CHECK (status IN ('selected','failed')),
  error_code VARCHAR(100) CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]+$'),
  quoted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at>quoted_at),
  actor VARCHAR(255) NOT NULL CHECK (btrim(actor)<>''),
  created_at TIMESTAMPTZ NOT NULL,
  CHECK ((status='selected' AND quote_result IS NOT NULL AND selected_rate IS NOT NULL AND error_code IS NULL)
    OR (status='failed' AND selected_rate IS NULL AND error_code IS NOT NULL)),
  UNIQUE(id,parcel_id)
);
CREATE INDEX customer_return_quote_decisions_parcel_idx ON returns.customer_return_quote_decisions(parcel_id,id);
CREATE TRIGGER customer_return_quote_decisions_immutable BEFORE UPDATE OR DELETE ON returns.customer_return_quote_decisions
FOR EACH ROW EXECUTE FUNCTION returns.reject_customer_return_authorization_evidence_mutation();

ALTER TABLE returns.customer_return_label_attempts ADD COLUMN quote_decision_id BIGINT;
ALTER TABLE returns.customer_return_label_attempts ADD CONSTRAINT customer_return_label_quote_parcel_fk
  FOREIGN KEY(quote_decision_id,parcel_id) REFERENCES returns.customer_return_quote_decisions(id,parcel_id);

CREATE FUNCTION returns.guard_customer_return_quote_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parcel_mode TEXT;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.quote_decision_id IS DISTINCT FROM OLD.quote_decision_id THEN
      RAISE EXCEPTION 'Return label quote linkage is immutable';
    END IF;
    RETURN NEW;
  END IF;
  SELECT selection_mode INTO parcel_mode FROM returns.customer_return_parcels WHERE id=NEW.parcel_id;
  IF parcel_mode='cheapest_eligible' AND NEW.quote_decision_id IS NULL THEN
    RAISE EXCEPTION 'Automatic return label requires a saved quote decision';
  END IF;
  IF NEW.quote_decision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM returns.customer_return_quote_decisions q
    WHERE q.id=NEW.quote_decision_id AND q.parcel_id=NEW.parcel_id AND q.status='selected'
      AND q.quoted_at<=NEW.started_at AND q.expires_at>NEW.started_at
      AND q.selected_rate->>'carrierId'=NEW.request_snapshot->>'carrierId'
      AND q.selected_rate->>'serviceCode'=NEW.request_snapshot->>'serviceCode'
      AND q.shipment_snapshot=NEW.request_snapshot-ARRAY['carrierId','serviceCode']
  ) THEN RAISE EXCEPTION 'Return label purchase does not match its saved quote decision'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_return_quote_attempt_guard BEFORE INSERT OR UPDATE ON returns.customer_return_label_attempts
FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_quote_attempt();
