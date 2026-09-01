-- Permit one immutable, lead-authorized WMS-content confirmation to resolve a
-- stable historical ShipStation/WMS disagreement. Automatic recovery retains
-- its original payload contract; operator resolution must include actor audit
-- evidence inside the event hash.

ALTER TABLE wms.shipping_provider_label_events
  DROP CONSTRAINT IF EXISTS shipping_provider_label_events_recovery_payload_chk;

ALTER TABLE wms.shipping_provider_label_events
  ADD CONSTRAINT shipping_provider_label_events_recovery_payload_chk CHECK (
    event_type <> 'contents_recovered'
    OR ((
      provider_occurred_at IS NULL
      AND jsonb_typeof(sanitized_payload) = 'object'
      AND sanitized_payload->>'payloadSchemaVersion' = '2'
      AND sanitized_payload->>'observationSource' IN (
        'historical_shipstation_contents_system_recovery',
        'historical_shipstation_contents_operator_resolution'
      )
      AND sanitized_payload->>'recoveryContractVersion' = '1'
      AND sanitized_payload->>'recoveryStatus' IN (
        'provider_line_keys_authoritative',
        'exact_unique_wms_match',
        'wms_confirmed_after_provider_conflict'
      )
      AND (
        (
          sanitized_payload->>'observationSource'
            = 'historical_shipstation_contents_system_recovery'
          AND sanitized_payload->>'recoveryStatus' IN (
            'provider_line_keys_authoritative',
            'exact_unique_wms_match'
          )
          AND NOT (sanitized_payload ? 'actorUserId')
          AND NOT (sanitized_payload ? 'actorRole')
          AND NOT (sanitized_payload ? 'reason')
        )
        OR (
          sanitized_payload->>'observationSource'
            = 'historical_shipstation_contents_operator_resolution'
          AND sanitized_payload->>'recoveryStatus'
            = 'wms_confirmed_after_provider_conflict'
          AND BTRIM(sanitized_payload->>'actorUserId') <> ''
          AND LENGTH(sanitized_payload->>'actorUserId') <= 190
          AND sanitized_payload->>'actorRole' IN ('admin', 'lead')
          AND BTRIM(sanitized_payload->>'reason') <> ''
          AND LENGTH(sanitized_payload->>'reason') <= 500
        )
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
        WHEN jsonb_typeof(sanitized_payload->'declaredContentsEvidence'->'lines') = 'array'
          THEN jsonb_array_length(
            sanitized_payload->'declaredContentsEvidence'->'lines'
          ) BETWEEN 1 AND 500
        ELSE false
      END
    ) IS TRUE)
  );
