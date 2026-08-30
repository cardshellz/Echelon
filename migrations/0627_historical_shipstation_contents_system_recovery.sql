-- Immutable system-recovery evidence for historical ShipStation label events
-- whose v1 payload omitted quantities. This extends the existing shipping
-- evidence ledger; it does not enable package-allocation effect execution.

ALTER TABLE wms.shipping_provider_label_events
  DROP CONSTRAINT IF EXISTS shipping_provider_label_events_type_chk;

ALTER TABLE wms.shipping_provider_label_events
  ADD CONSTRAINT shipping_provider_label_events_type_chk CHECK (
    event_type IN (
      'label_observed',
      'label_voided',
      'label_superseded',
      'contents_recovered'
    )
  );

ALTER TABLE wms.shipping_provider_label_events
  ADD CONSTRAINT shipping_provider_label_events_recovery_payload_chk CHECK (
    event_type <> 'contents_recovered'
    OR ((
      provider_occurred_at IS NULL
      AND jsonb_typeof(sanitized_payload) = 'object'
      AND sanitized_payload->>'payloadSchemaVersion' = '2'
      AND sanitized_payload->>'observationSource'
        = 'historical_shipstation_contents_system_recovery'
      AND sanitized_payload->>'recoveryContractVersion' = '1'
      AND sanitized_payload->>'recoveryStatus' IN (
        'provider_line_keys_authoritative',
        'exact_unique_wms_match'
      )
      AND BTRIM(sanitized_payload->>'providerLabelId') <> ''
      AND LENGTH(sanitized_payload->>'providerLabelId') <= 200
      AND sanitized_payload->>'trackingNumber' = tracking_number
      AND sanitized_payload->>'providerEvidenceHash' ~ '^[0-9a-f]{64}$'
      AND sanitized_payload->>'recoveryEvidenceHash' ~ '^[0-9a-f]{64}$'
      AND CASE
        WHEN jsonb_typeof(sanitized_payload->'resolvedLabelEventIds') = 'array'
          THEN jsonb_array_length(sanitized_payload->'resolvedLabelEventIds') BETWEEN 1 AND 500
        ELSE false
      END
      AND jsonb_typeof(sanitized_payload->'declaredContentsEvidence') = 'object'
      AND sanitized_payload->'declaredContentsEvidence'->>'evidenceSchemaVersion' = '1'
      AND sanitized_payload->'declaredContentsEvidence'->>'status' = 'authoritative'
      AND CASE
        WHEN jsonb_typeof(
          sanitized_payload->'declaredContentsEvidence'->'lines'
        ) = 'array'
          THEN jsonb_array_length(
            sanitized_payload->'declaredContentsEvidence'->'lines'
          ) BETWEEN 1 AND 500
        ELSE false
      END
    ) IS TRUE)
  );

CREATE UNIQUE INDEX uq_shipping_provider_label_events_one_contents_recovery
  ON wms.shipping_provider_label_events(shipping_provider_label_id)
  WHERE event_type = 'contents_recovered';
