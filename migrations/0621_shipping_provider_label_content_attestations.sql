-- Immutable operator attestations that resolve named non-authoritative provider
-- content observations. Provider events remain in their own append-only ledger.

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_provider_label_events_id_label
  ON wms.shipping_provider_label_events(id, shipping_provider_label_id);

CREATE TABLE IF NOT EXISTS wms.shipping_provider_label_content_attestations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipping_provider_label_id BIGINT NOT NULL
    REFERENCES wms.shipping_provider_labels(id) ON DELETE RESTRICT,
  recovery_contract_version INTEGER NOT NULL,
  recovery_status VARCHAR(50) NOT NULL,
  preview_evidence_hash VARCHAR(64) NOT NULL,
  provider_evidence_hash VARCHAR(64) NOT NULL,
  attested_contents JSONB NOT NULL,
  actor_user_id VARCHAR NOT NULL
    REFERENCES identity.users(id) ON DELETE RESTRICT,
  actor_role VARCHAR(20) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  attestation_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT shipping_provider_label_content_attestations_contract_chk
    CHECK (recovery_contract_version = 1),
  CONSTRAINT shipping_provider_label_content_attestations_status_chk
    CHECK (recovery_status IN ('provider_line_keys_authoritative', 'exact_unique_wms_match')),
  CONSTRAINT shipping_provider_label_content_attestations_preview_hash_chk
    CHECK (preview_evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shipping_provider_label_content_attestations_provider_hash_chk
    CHECK (provider_evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shipping_provider_label_content_attestations_hash_chk
    CHECK (attestation_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shipping_provider_label_content_attestations_contents_chk
    CHECK (
      jsonb_typeof(attested_contents) = 'array'
      AND jsonb_array_length(attested_contents) BETWEEN 1 AND 500
    ),
  CONSTRAINT shipping_provider_label_content_attestations_actor_role_chk
    CHECK (actor_role IN ('admin', 'lead')),
  CONSTRAINT shipping_provider_label_content_attestations_reason_chk
    CHECK (BTRIM(reason) <> '' AND reason = BTRIM(reason))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_provider_label_content_attestations_label_preview
  ON wms.shipping_provider_label_content_attestations(
    shipping_provider_label_id,
    preview_evidence_hash
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_provider_label_content_attestations_label_hash
  ON wms.shipping_provider_label_content_attestations(
    shipping_provider_label_id,
    attestation_hash
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_provider_label_content_attestations_id_label
  ON wms.shipping_provider_label_content_attestations(id, shipping_provider_label_id);

CREATE INDEX IF NOT EXISTS idx_shipping_provider_label_content_attestations_label
  ON wms.shipping_provider_label_content_attestations(
    shipping_provider_label_id,
    created_at,
    id
  );

CREATE TABLE IF NOT EXISTS wms.shipping_provider_label_content_attestation_resolutions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipping_provider_label_content_attestation_id BIGINT NOT NULL,
  shipping_provider_label_id BIGINT NOT NULL,
  shipping_provider_label_event_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT fk_shipping_provider_label_content_attestation_resolutions_attestation
    FOREIGN KEY (
      shipping_provider_label_content_attestation_id,
      shipping_provider_label_id
    ) REFERENCES wms.shipping_provider_label_content_attestations(
      id,
      shipping_provider_label_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fk_shipping_provider_label_content_attestation_resolutions_event
    FOREIGN KEY (
      shipping_provider_label_event_id,
      shipping_provider_label_id
    ) REFERENCES wms.shipping_provider_label_events(
      id,
      shipping_provider_label_id
    ) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_provider_label_content_attestation_resolutions_pair
  ON wms.shipping_provider_label_content_attestation_resolutions(
    shipping_provider_label_content_attestation_id,
    shipping_provider_label_event_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_provider_label_content_attestation_resolutions_event
  ON wms.shipping_provider_label_content_attestation_resolutions(
    shipping_provider_label_event_id
  );

CREATE INDEX IF NOT EXISTS idx_shipping_provider_label_content_attestation_resolutions_attestation
  ON wms.shipping_provider_label_content_attestation_resolutions(
    shipping_provider_label_content_attestation_id,
    shipping_provider_label_event_id
  );

DROP TRIGGER IF EXISTS shipping_provider_label_content_attestations_immutable
  ON wms.shipping_provider_label_content_attestations;
CREATE TRIGGER shipping_provider_label_content_attestations_immutable
  BEFORE UPDATE OR DELETE ON wms.shipping_provider_label_content_attestations
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

DROP TRIGGER IF EXISTS shipping_provider_label_content_attestation_resolutions_immutable
  ON wms.shipping_provider_label_content_attestation_resolutions;
CREATE TRIGGER shipping_provider_label_content_attestation_resolutions_immutable
  BEFORE UPDATE OR DELETE ON wms.shipping_provider_label_content_attestation_resolutions
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();
