-- Append-only verified provider state for already-registered marketplace scopes.
-- Registration remains a one-time provenance receipt; subsequent fresh reads
-- are recorded here and drive reconciliation without rewriting history.

CREATE TABLE marketplace.listing_verification_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES marketplace.listing_scopes(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL,
  source_publication_id BIGINT NOT NULL,
  provider_account_id BIGINT NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  observation_hash VARCHAR(64) NOT NULL,
  desired_state_hash VARCHAR(64) NOT NULL,
  provider_publication_key VARCHAR(255),
  external_listing_id VARCHAR(255) NOT NULL,
  external_url TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  verified_by_type VARCHAR(20) NOT NULL,
  verified_by_id VARCHAR(255) NOT NULL,
  correlation_id VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT listing_verification_snapshots_id_product_uq UNIQUE (id, product_id),
  CONSTRAINT listing_verification_snapshots_publication_scope_product_fk
    FOREIGN KEY (source_publication_id, scope_id, product_id)
    REFERENCES marketplace.listing_publications(id, scope_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT listing_verification_snapshots_scope_account_fk
    FOREIGN KEY (scope_id, provider_account_id)
    REFERENCES marketplace.listing_scope_provider_accounts(scope_id, provider_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT listing_verification_snapshots_scope_idem_uq UNIQUE (scope_id, idempotency_key),
  CONSTRAINT listing_verification_snapshots_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
    AND observation_hash ~ '^[0-9a-f]{64}$'
    AND desired_state_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT listing_verification_snapshots_identity_chk CHECK (
    idempotency_key = btrim(idempotency_key) AND idempotency_key <> ''
    AND external_listing_id = btrim(external_listing_id) AND external_listing_id <> ''
    AND (provider_publication_key IS NULL OR (
      provider_publication_key = btrim(provider_publication_key)
      AND provider_publication_key <> ''
    ))
  ),
  CONSTRAINT listing_verification_snapshots_evidence_chk CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT listing_verification_snapshots_actor_chk CHECK (
    verified_by_type IN ('user', 'service', 'system')
    AND verified_by_id = btrim(verified_by_id)
    AND verified_by_id <> ''
  ),
  CONSTRAINT listing_verification_snapshots_time_chk CHECK (
    verified_at >= observed_at AND created_at >= verified_at
  )
);

CREATE INDEX listing_verification_snapshots_scope_latest_idx
  ON marketplace.listing_verification_snapshots(scope_id, verified_at DESC, id DESC);

CREATE TABLE marketplace.listing_verification_members (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  verification_id BIGINT NOT NULL,
  product_id INTEGER NOT NULL,
  product_variant_id INTEGER NOT NULL,
  sku_snapshot VARCHAR(100) NOT NULL,
  disposition VARCHAR(20) NOT NULL,
  reason_code VARCHAR(100),
  external_variant_id VARCHAR(255),
  external_offer_id VARCHAR(255),
  external_inventory_item_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT listing_verification_members_verification_product_fk
    FOREIGN KEY (verification_id, product_id)
    REFERENCES marketplace.listing_verification_snapshots(id, product_id) ON DELETE RESTRICT,
  CONSTRAINT listing_verification_members_variant_product_fk
    FOREIGN KEY (product_variant_id, product_id)
    REFERENCES catalog.product_variants(id, product_id) ON DELETE RESTRICT,
  CONSTRAINT listing_verification_members_verification_variant_uq
    UNIQUE (verification_id, product_variant_id),
  CONSTRAINT listing_verification_members_verification_sku_uq
    UNIQUE (verification_id, sku_snapshot),
  CONSTRAINT listing_verification_members_sku_chk CHECK (
    sku_snapshot = btrim(sku_snapshot) AND sku_snapshot <> ''
  ),
  CONSTRAINT listing_verification_members_disposition_chk CHECK (
    (disposition = 'included' AND reason_code IS NULL)
    OR (
      disposition = 'excluded'
      AND reason_code IS NOT NULL
      AND reason_code = btrim(reason_code)
      AND reason_code <> ''
    )
  ),
  CONSTRAINT listing_verification_members_external_identity_chk CHECK (
    (external_variant_id IS NULL OR (
      external_variant_id = btrim(external_variant_id) AND external_variant_id <> ''
    ))
    AND (external_offer_id IS NULL OR (
      external_offer_id = btrim(external_offer_id) AND external_offer_id <> ''
    ))
    AND (external_inventory_item_id IS NULL OR (
      external_inventory_item_id = btrim(external_inventory_item_id)
      AND external_inventory_item_id <> ''
    ))
  )
);

CREATE TRIGGER listing_verification_snapshots_immutable
BEFORE UPDATE OR DELETE ON marketplace.listing_verification_snapshots
FOR EACH ROW EXECUTE FUNCTION marketplace.reject_registration_history_mutation();

CREATE TRIGGER listing_verification_members_immutable
BEFORE UPDATE OR DELETE ON marketplace.listing_verification_members
FOR EACH ROW EXECUTE FUNCTION marketplace.reject_registration_history_mutation();

COMMENT ON TABLE marketplace.listing_verification_snapshots IS
  'Append-only fresh provider observations for an existing registered listing scope.';
COMMENT ON TABLE marketplace.listing_verification_members IS
  'Normalized member state captured by a verified listing observation.';