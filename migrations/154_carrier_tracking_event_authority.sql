-- Provider-neutral label lifecycle and carrier tracking authority, shadow phase.
--
-- A label or shipping-engine shipment record is not proof that a package left
-- the warehouse. These tables separate:
--   1. provider label artifacts,
--   2. many-to-many links from a label to authorized internal shipment work,
--   3. immutable provider label observations, and
--   4. immutable carrier tracking observations,
--   5. immutable signed-webhook verification receipts, and
--   6. immutable carrier-to-label matching attempts.
--
-- Runtime fulfillment and inventory state are intentionally unchanged by this
-- migration. Carrier-dispatch authority is enabled only after shadow evidence
-- has been validated in production.

CREATE TABLE IF NOT EXISTS wms.shipping_provider_labels (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider VARCHAR(40) NOT NULL,
  provider_label_id VARCHAR(200) NOT NULL,
  provider_order_id VARCHAR(200),
  provider_order_key VARCHAR(200),
  tracking_number VARCHAR(200) NOT NULL,
  normalized_tracking_number VARCHAR(200) NOT NULL,
  label_status VARCHAR(30) NOT NULL DEFAULT 'unknown',
  carrier VARCHAR(100),
  service_code VARCHAR(100),
  label_created_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  last_link_reconciled_at TIMESTAMPTZ,
  next_link_reconcile_at TIMESTAMPTZ,
  link_reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  source VARCHAR(50) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shipping_provider_labels_provider_chk CHECK (BTRIM(provider) <> ''),
  CONSTRAINT shipping_provider_labels_provider_label_chk CHECK (BTRIM(provider_label_id) <> ''),
  CONSTRAINT shipping_provider_labels_tracking_chk CHECK (BTRIM(tracking_number) <> ''),
  CONSTRAINT shipping_provider_labels_normalized_tracking_chk CHECK (
    normalized_tracking_number ~ '^[A-Z0-9]+$'
  ),
  CONSTRAINT shipping_provider_labels_status_chk CHECK (
    label_status IN ('active', 'voided', 'superseded', 'unknown')
  ),
  CONSTRAINT shipping_provider_labels_observed_range_chk CHECK (
    first_observed_at <= last_observed_at
  ),
  CONSTRAINT shipping_provider_labels_link_attempts_chk CHECK (
    link_reconcile_attempts >= 0
  ),
  CONSTRAINT shipping_provider_labels_void_shape_chk CHECK (
    label_status <> 'voided' OR voided_at IS NOT NULL
  ),
  CONSTRAINT shipping_provider_labels_source_chk CHECK (BTRIM(source) <> ''),
  CONSTRAINT uq_shipping_provider_labels_provider_label UNIQUE(provider, provider_label_id)
);

CREATE INDEX IF NOT EXISTS idx_shipping_provider_labels_tracking
  ON wms.shipping_provider_labels(provider, normalized_tracking_number);

CREATE INDEX IF NOT EXISTS idx_shipping_provider_labels_status_observed
  ON wms.shipping_provider_labels(label_status, first_observed_at);

CREATE INDEX IF NOT EXISTS idx_shipping_provider_labels_link_reconcile
  ON wms.shipping_provider_labels(next_link_reconcile_at, last_link_reconciled_at);

CREATE TABLE IF NOT EXISTS wms.shipping_provider_label_links (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipping_provider_label_id BIGINT NOT NULL
    REFERENCES wms.shipping_provider_labels(id) ON DELETE RESTRICT,
  shipment_request_id BIGINT REFERENCES wms.shipment_requests(id) ON DELETE RESTRICT,
  shipping_engine_order_id BIGINT REFERENCES wms.shipping_engine_orders(id) ON DELETE RESTRICT,
  physical_shipment_id BIGINT REFERENCES wms.physical_shipments(id) ON DELETE RESTRICT,
  legacy_wms_shipment_id INTEGER REFERENCES wms.outbound_shipments(id) ON DELETE RESTRICT,
  source VARCHAR(50) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shipping_provider_label_links_target_chk CHECK (
    NUM_NONNULLS(
      shipment_request_id,
      shipping_engine_order_id,
      physical_shipment_id,
      legacy_wms_shipment_id
    ) = 1
  ),
  CONSTRAINT shipping_provider_label_links_source_chk CHECK (BTRIM(source) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_provider_label_links_request
  ON wms.shipping_provider_label_links(shipping_provider_label_id, shipment_request_id)
  WHERE shipment_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_provider_label_links_engine_order
  ON wms.shipping_provider_label_links(shipping_provider_label_id, shipping_engine_order_id)
  WHERE shipping_engine_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_provider_label_links_physical
  ON wms.shipping_provider_label_links(shipping_provider_label_id, physical_shipment_id)
  WHERE physical_shipment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_provider_label_links_legacy
  ON wms.shipping_provider_label_links(shipping_provider_label_id, legacy_wms_shipment_id)
  WHERE legacy_wms_shipment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipping_provider_label_links_label
  ON wms.shipping_provider_label_links(shipping_provider_label_id);

CREATE TABLE IF NOT EXISTS wms.shipping_provider_label_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipping_provider_label_id BIGINT NOT NULL
    REFERENCES wms.shipping_provider_labels(id) ON DELETE RESTRICT,
  event_hash VARCHAR(64) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  label_status VARCHAR(30) NOT NULL,
  tracking_number VARCHAR(200) NOT NULL,
  provider_occurred_at TIMESTAMPTZ,
  sanitized_payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT shipping_provider_label_events_hash_chk CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shipping_provider_label_events_type_chk CHECK (
    event_type IN ('label_observed', 'label_voided', 'label_superseded')
  ),
  CONSTRAINT shipping_provider_label_events_status_chk CHECK (
    label_status IN ('active', 'voided', 'superseded', 'unknown')
  ),
  CONSTRAINT shipping_provider_label_events_tracking_chk CHECK (BTRIM(tracking_number) <> ''),
  CONSTRAINT uq_shipping_provider_label_events_hash UNIQUE(
    shipping_provider_label_id,
    event_hash
  )
);

CREATE INDEX IF NOT EXISTS idx_shipping_provider_label_events_label
  ON wms.shipping_provider_label_events(shipping_provider_label_id, received_at DESC, id DESC);

-- Tracking subscriptions are keyed by the carrier tuple consumed by the
-- provider API, not by an Echelon shipment or provider label. Multiple labels
-- may legitimately point at the same parcel identity, so label membership is
-- kept in a separate append-only link table.
CREATE TABLE IF NOT EXISTS wms.carrier_tracking_subscriptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tracking_provider VARCHAR(40) NOT NULL,
  carrier_code VARCHAR(100) NOT NULL,
  tracking_number VARCHAR(200) NOT NULL,
  normalized_tracking_number VARCHAR(200) NOT NULL,
  subscription_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  lease_owner VARCHAR(200),
  lease_expires_at TIMESTAMPTZ,
  last_error_code VARCHAR(100),
  last_error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT carrier_tracking_subscriptions_provider_chk CHECK (
    BTRIM(tracking_provider) <> ''
  ),
  CONSTRAINT carrier_tracking_subscriptions_carrier_chk CHECK (
    BTRIM(carrier_code) <> ''
  ),
  CONSTRAINT carrier_tracking_subscriptions_tracking_chk CHECK (
    BTRIM(tracking_number) <> ''
  ),
  CONSTRAINT carrier_tracking_subscriptions_normalized_tracking_chk CHECK (
    normalized_tracking_number ~ '^[A-Z0-9]+$'
  ),
  CONSTRAINT carrier_tracking_subscriptions_status_chk CHECK (
    subscription_status IN ('pending', 'processing', 'active', 'retry', 'review')
  ),
  CONSTRAINT carrier_tracking_subscriptions_attempts_chk CHECK (
    attempt_count >= 0 AND consecutive_failure_count >= 0
  ),
  CONSTRAINT carrier_tracking_subscriptions_lease_shape_chk CHECK (
    (
      subscription_status = 'processing'
      AND lease_owner IS NOT NULL
      AND BTRIM(lease_owner) <> ''
      AND lease_expires_at IS NOT NULL
      AND next_attempt_at IS NULL
    )
    OR (
      subscription_status <> 'processing'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT carrier_tracking_subscriptions_schedule_shape_chk CHECK (
    (subscription_status IN ('pending', 'retry') AND next_attempt_at IS NOT NULL)
    OR (subscription_status IN ('processing', 'active', 'review') AND next_attempt_at IS NULL)
  ),
  CONSTRAINT carrier_tracking_subscriptions_activation_shape_chk CHECK (
    subscription_status <> 'active' OR activated_at IS NOT NULL
  ),
  CONSTRAINT carrier_tracking_subscriptions_error_shape_chk CHECK (
    subscription_status NOT IN ('retry', 'review')
    OR (last_error_code IS NOT NULL AND BTRIM(last_error_code) <> '')
  ),
  CONSTRAINT uq_carrier_tracking_subscriptions_identity UNIQUE(
    tracking_provider,
    carrier_code,
    normalized_tracking_number
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_subscriptions_due
  ON wms.carrier_tracking_subscriptions(next_attempt_at, lease_expires_at, id);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_subscriptions_status
  ON wms.carrier_tracking_subscriptions(subscription_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS wms.carrier_tracking_subscription_labels (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carrier_tracking_subscription_id BIGINT NOT NULL
    REFERENCES wms.carrier_tracking_subscriptions(id) ON DELETE RESTRICT,
  shipping_provider_label_id BIGINT NOT NULL
    REFERENCES wms.shipping_provider_labels(id) ON DELETE RESTRICT,
  source VARCHAR(50) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT carrier_tracking_subscription_labels_source_chk CHECK (BTRIM(source) <> ''),
  CONSTRAINT uq_carrier_tracking_subscription_labels UNIQUE(
    carrier_tracking_subscription_id,
    shipping_provider_label_id
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_subscription_labels_label
  ON wms.carrier_tracking_subscription_labels(shipping_provider_label_id);

CREATE TABLE IF NOT EXISTS wms.carrier_tracking_subscription_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carrier_tracking_subscription_id BIGINT NOT NULL
    REFERENCES wms.carrier_tracking_subscriptions(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  attempt_outcome VARCHAR(30) NOT NULL,
  http_status INTEGER,
  error_code VARCHAR(100),
  error_message TEXT,
  request_evidence JSONB NOT NULL,
  response_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT carrier_tracking_subscription_attempts_number_chk CHECK (attempt_number > 0),
  CONSTRAINT carrier_tracking_subscription_attempts_outcome_chk CHECK (
    attempt_outcome IN ('activated', 'retry_scheduled', 'review_required')
  ),
  CONSTRAINT carrier_tracking_subscription_attempts_http_chk CHECK (
    http_status IS NULL OR (http_status >= 100 AND http_status <= 599)
  ),
  CONSTRAINT carrier_tracking_subscription_attempts_time_chk CHECK (
    started_at <= completed_at
  ),
  CONSTRAINT carrier_tracking_subscription_attempts_result_shape_chk CHECK (
    (
      attempt_outcome = 'activated'
      AND http_status = 204
      AND error_code IS NULL
      AND error_message IS NULL
    )
    OR (
      attempt_outcome IN ('retry_scheduled', 'review_required')
      AND error_code IS NOT NULL
      AND BTRIM(error_code) <> ''
    )
  ),
  CONSTRAINT uq_carrier_tracking_subscription_attempts_number UNIQUE(
    carrier_tracking_subscription_id,
    attempt_number
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_subscription_attempts_subscription
  ON wms.carrier_tracking_subscription_attempts(
    carrier_tracking_subscription_id,
    attempt_number DESC
  );

CREATE TABLE IF NOT EXISTS wms.carrier_tracking_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider VARCHAR(40) NOT NULL,
  event_hash VARCHAR(64) NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  tracking_number VARCHAR(200) NOT NULL,
  normalized_tracking_number VARCHAR(200) NOT NULL,
  provider_label_id VARCHAR(200),
  carrier VARCHAR(100),
  provider_status_code VARCHAR(30) NOT NULL,
  provider_status_detail_code VARCHAR(100),
  provider_carrier_status_code VARCHAR(100),
  provider_carrier_detail_code VARCHAR(100),
  canonical_status VARCHAR(40) NOT NULL,
  dispatch_evidence VARCHAR(30) NOT NULL,
  status_description TEXT,
  carrier_status_description TEXT,
  event_occurred_at TIMESTAMPTZ,
  event_time_source VARCHAR(30) NOT NULL,
  estimated_delivery_at TIMESTAMPTZ,
  actual_delivery_at TIMESTAMPTZ,
  sanitized_payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT carrier_tracking_events_provider_chk CHECK (BTRIM(provider) <> ''),
  CONSTRAINT carrier_tracking_events_event_hash_chk CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT carrier_tracking_events_payload_hash_chk CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT carrier_tracking_events_tracking_chk CHECK (BTRIM(tracking_number) <> ''),
  CONSTRAINT carrier_tracking_events_normalized_tracking_chk CHECK (
    normalized_tracking_number ~ '^[A-Z0-9]+$'
  ),
  CONSTRAINT carrier_tracking_events_status_chk CHECK (
    canonical_status IN (
      'unknown',
      'pre_transit',
      'accepted',
      'in_transit',
      'delivered',
      'exception',
      'delivery_attempt',
      'delivered_to_service_point'
    )
  ),
  CONSTRAINT carrier_tracking_events_dispatch_evidence_chk CHECK (
    dispatch_evidence IN ('confirmed', 'not_confirmed', 'review')
  ),
  CONSTRAINT carrier_tracking_events_time_source_chk CHECK (
    event_time_source IN ('carrier_event', 'actual_delivery', 'ship_date', 'unavailable')
  ),
  CONSTRAINT uq_carrier_tracking_events_provider_hash UNIQUE(provider, event_hash)
);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_events_tracking
  ON wms.carrier_tracking_events(provider, normalized_tracking_number, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_events_dispatch
  ON wms.carrier_tracking_events(dispatch_evidence, received_at DESC);

CREATE TABLE IF NOT EXISTS wms.carrier_tracking_webhook_receipts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider VARCHAR(40) NOT NULL,
  receipt_hash VARCHAR(64) NOT NULL,
  signature_algorithm VARCHAR(30) NOT NULL,
  signature_key_id VARCHAR(500) NOT NULL,
  signature_timestamp_raw VARCHAR(100) NOT NULL,
  signature_timestamp_at TIMESTAMPTZ NOT NULL,
  raw_body_base64 TEXT NOT NULL,
  raw_body_hash VARCHAR(64) NOT NULL,
  signature_base64 TEXT NOT NULL,
  signature_hash VARCHAR(64) NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT carrier_tracking_webhook_receipts_provider_chk CHECK (BTRIM(provider) <> ''),
  CONSTRAINT carrier_tracking_webhook_receipts_hash_chk CHECK (
    receipt_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT carrier_tracking_webhook_receipts_algorithm_chk CHECK (
    signature_algorithm = 'RSA-SHA256'
  ),
  CONSTRAINT carrier_tracking_webhook_receipts_key_chk CHECK (BTRIM(signature_key_id) <> ''),
  CONSTRAINT carrier_tracking_webhook_receipts_timestamp_chk CHECK (
    BTRIM(signature_timestamp_raw) <> ''
  ),
  CONSTRAINT carrier_tracking_webhook_receipts_raw_body_chk CHECK (
    BTRIM(raw_body_base64) <> ''
  ),
  CONSTRAINT carrier_tracking_webhook_receipts_raw_body_hash_chk CHECK (
    raw_body_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT carrier_tracking_webhook_receipts_signature_hash_chk CHECK (
    signature_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT carrier_tracking_webhook_receipts_signature_chk CHECK (
    BTRIM(signature_base64) <> ''
  ),
  CONSTRAINT uq_carrier_tracking_webhook_receipts_provider_hash UNIQUE(provider, receipt_hash)
);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_webhook_receipts_verified
  ON wms.carrier_tracking_webhook_receipts(provider, verified_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS wms.carrier_tracking_webhook_receipt_parses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carrier_tracking_webhook_receipt_id BIGINT NOT NULL
    REFERENCES wms.carrier_tracking_webhook_receipts(id) ON DELETE RESTRICT,
  carrier_tracking_event_id BIGINT
    REFERENCES wms.carrier_tracking_events(id) ON DELETE RESTRICT,
  attempt_hash VARCHAR(64) NOT NULL,
  parser_version VARCHAR(100) NOT NULL,
  outcome VARCHAR(30) NOT NULL,
  reason_code VARCHAR(100) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT carrier_tracking_webhook_receipt_parses_hash_chk CHECK (
    attempt_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT carrier_tracking_webhook_receipt_parses_parser_chk CHECK (
    BTRIM(parser_version) <> ''
  ),
  CONSTRAINT carrier_tracking_webhook_receipt_parses_outcome_chk CHECK (
    outcome IN ('normalized', 'rejected')
  ),
  CONSTRAINT carrier_tracking_webhook_receipt_parses_reason_chk CHECK (
    BTRIM(reason_code) <> ''
  ),
  CONSTRAINT carrier_tracking_webhook_receipt_parses_shape_chk CHECK (
    (outcome = 'normalized' AND carrier_tracking_event_id IS NOT NULL)
    OR (outcome = 'rejected' AND carrier_tracking_event_id IS NULL)
  ),
  CONSTRAINT uq_carrier_tracking_webhook_receipt_parses_attempt UNIQUE(
    carrier_tracking_webhook_receipt_id,
    attempt_hash
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_webhook_receipt_parses_receipt
  ON wms.carrier_tracking_webhook_receipt_parses(
    carrier_tracking_webhook_receipt_id,
    created_at DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_webhook_receipt_parses_event
  ON wms.carrier_tracking_webhook_receipt_parses(
    carrier_tracking_event_id,
    created_at DESC,
    id DESC
  )
  WHERE carrier_tracking_event_id IS NOT NULL;

-- ShipStation API documents the tracking webhook `data` object as optional.
-- A signed callback without `data` is therefore persisted immediately and
-- hydrated asynchronously from its authenticated `resource_url`. The mutable
-- projection below owns leases and retry scheduling; every provider request is
-- retained separately in the append-only attempts table.
CREATE TABLE IF NOT EXISTS wms.carrier_tracking_webhook_hydrations (
  carrier_tracking_webhook_receipt_id BIGINT PRIMARY KEY
    REFERENCES wms.carrier_tracking_webhook_receipts(id) ON DELETE RESTRICT,
  resource_url TEXT NOT NULL,
  carrier_code VARCHAR(100) NOT NULL,
  tracking_number VARCHAR(200) NOT NULL,
  normalized_tracking_number VARCHAR(200) NOT NULL,
  hydration_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  hydrated_at TIMESTAMPTZ,
  lease_owner VARCHAR(200),
  lease_expires_at TIMESTAMPTZ,
  last_error_code VARCHAR(100),
  last_error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT carrier_tracking_webhook_hydrations_url_chk CHECK (
    BTRIM(resource_url) <> ''
  ),
  CONSTRAINT carrier_tracking_webhook_hydrations_carrier_chk CHECK (
    BTRIM(carrier_code) <> ''
  ),
  CONSTRAINT carrier_tracking_webhook_hydrations_tracking_chk CHECK (
    BTRIM(tracking_number) <> ''
  ),
  CONSTRAINT carrier_tracking_webhook_hydrations_normalized_tracking_chk CHECK (
    normalized_tracking_number ~ '^[A-Z0-9]+$'
  ),
  CONSTRAINT carrier_tracking_webhook_hydrations_status_chk CHECK (
    hydration_status IN ('pending', 'processing', 'retry', 'complete', 'review')
  ),
  CONSTRAINT carrier_tracking_webhook_hydrations_attempts_chk CHECK (
    attempt_count >= 0 AND consecutive_failure_count >= 0
  ),
  CONSTRAINT carrier_tracking_webhook_hydrations_lease_shape_chk CHECK (
    (
      hydration_status = 'processing'
      AND lease_owner IS NOT NULL
      AND BTRIM(lease_owner) <> ''
      AND lease_expires_at IS NOT NULL
      AND next_attempt_at IS NULL
    )
    OR (
      hydration_status <> 'processing'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT carrier_tracking_webhook_hydrations_schedule_shape_chk CHECK (
    (hydration_status IN ('pending', 'retry') AND next_attempt_at IS NOT NULL)
    OR (hydration_status IN ('processing', 'complete', 'review') AND next_attempt_at IS NULL)
  ),
  CONSTRAINT carrier_tracking_webhook_hydrations_complete_shape_chk CHECK (
    hydration_status <> 'complete' OR hydrated_at IS NOT NULL
  ),
  CONSTRAINT carrier_tracking_webhook_hydrations_error_shape_chk CHECK (
    hydration_status NOT IN ('retry', 'review')
    OR (last_error_code IS NOT NULL AND BTRIM(last_error_code) <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_webhook_hydrations_due
  ON wms.carrier_tracking_webhook_hydrations(next_attempt_at, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_webhook_hydrations_status
  ON wms.carrier_tracking_webhook_hydrations(hydration_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS wms.carrier_tracking_webhook_hydration_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carrier_tracking_webhook_receipt_id BIGINT NOT NULL
    REFERENCES wms.carrier_tracking_webhook_receipts(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  attempt_outcome VARCHAR(30) NOT NULL,
  http_status INTEGER,
  error_code VARCHAR(100),
  error_message TEXT,
  request_evidence JSONB NOT NULL,
  response_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT carrier_tracking_webhook_hydration_attempts_number_chk CHECK (
    attempt_number > 0
  ),
  CONSTRAINT carrier_tracking_webhook_hydration_attempts_outcome_chk CHECK (
    attempt_outcome IN ('hydrated', 'retry_scheduled', 'review_required')
  ),
  CONSTRAINT carrier_tracking_webhook_hydration_attempts_http_chk CHECK (
    http_status IS NULL OR (http_status >= 100 AND http_status <= 599)
  ),
  CONSTRAINT carrier_tracking_webhook_hydration_attempts_time_chk CHECK (
    started_at <= completed_at
  ),
  CONSTRAINT carrier_tracking_webhook_hydration_attempts_result_shape_chk CHECK (
    (
      attempt_outcome = 'hydrated'
      AND http_status = 200
      AND error_code IS NULL
      AND error_message IS NULL
    )
    OR (
      attempt_outcome IN ('retry_scheduled', 'review_required')
      AND error_code IS NOT NULL
      AND BTRIM(error_code) <> ''
    )
  ),
  CONSTRAINT uq_carrier_tracking_webhook_hydration_attempts_number UNIQUE (
    carrier_tracking_webhook_receipt_id,
    attempt_number
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_webhook_hydration_attempts_receipt
  ON wms.carrier_tracking_webhook_hydration_attempts(
    carrier_tracking_webhook_receipt_id,
    attempt_number DESC
  );

CREATE TABLE IF NOT EXISTS wms.carrier_tracking_event_matches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carrier_tracking_event_id BIGINT NOT NULL
    REFERENCES wms.carrier_tracking_events(id) ON DELETE RESTRICT,
  attempt_hash VARCHAR(64) NOT NULL,
  match_status VARCHAR(30) NOT NULL,
  candidate_count INTEGER NOT NULL,
  shipping_provider_label_id BIGINT
    REFERENCES wms.shipping_provider_labels(id) ON DELETE SET NULL,
  reason_code VARCHAR(100) NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT carrier_tracking_event_matches_hash_chk CHECK (attempt_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT carrier_tracking_event_matches_status_chk CHECK (
    match_status IN ('matched', 'unmatched', 'ambiguous', 'voided_label', 'review')
  ),
  CONSTRAINT carrier_tracking_event_matches_candidate_count_chk CHECK (candidate_count >= 0),
  CONSTRAINT carrier_tracking_event_matches_reason_chk CHECK (BTRIM(reason_code) <> ''),
  CONSTRAINT carrier_tracking_event_matches_shape_chk CHECK (
    (match_status = 'matched' AND candidate_count = 1 AND shipping_provider_label_id IS NOT NULL)
    OR (match_status = 'unmatched' AND candidate_count = 0 AND shipping_provider_label_id IS NULL)
    OR (match_status = 'ambiguous' AND candidate_count > 1 AND shipping_provider_label_id IS NULL)
    OR (match_status = 'voided_label' AND candidate_count >= 1)
    OR (match_status = 'review')
  ),
  CONSTRAINT uq_carrier_tracking_event_matches_attempt UNIQUE(
    carrier_tracking_event_id,
    attempt_hash
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_event_matches_event
  ON wms.carrier_tracking_event_matches(carrier_tracking_event_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_event_matches_status
  ON wms.carrier_tracking_event_matches(match_status, created_at DESC);

-- Mutable scheduling projection kept separate from the append-only evidence
-- and match-attempt ledgers. It records when the current candidate set was
-- last evaluated so later label creation or voiding can reopen a prior match.
CREATE TABLE IF NOT EXISTS wms.carrier_tracking_reconciliation_state (
  carrier_tracking_event_id BIGINT PRIMARY KEY
    REFERENCES wms.carrier_tracking_events(id) ON DELETE RESTRICT,
  last_match_attempt_id BIGINT NOT NULL
    REFERENCES wms.carrier_tracking_event_matches(id) ON DELETE RESTRICT,
  last_match_attempt_hash VARCHAR(64) NOT NULL,
  last_match_status VARCHAR(30) NOT NULL,
  last_candidate_count INTEGER NOT NULL,
  last_reconciled_at TIMESTAMPTZ NOT NULL,
  next_reconcile_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT carrier_tracking_reconciliation_state_hash_chk CHECK (
    last_match_attempt_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT carrier_tracking_reconciliation_state_status_chk CHECK (
    last_match_status IN ('matched', 'unmatched', 'ambiguous', 'voided_label', 'review')
  ),
  CONSTRAINT carrier_tracking_reconciliation_state_candidates_chk CHECK (
    last_candidate_count >= 0
  ),
  CONSTRAINT carrier_tracking_reconciliation_state_retry_shape_chk CHECK (
    (last_match_status IN ('unmatched', 'ambiguous', 'review') AND next_reconcile_at IS NOT NULL)
    OR (last_match_status IN ('matched', 'voided_label') AND next_reconcile_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_tracking_reconciliation_state_due
  ON wms.carrier_tracking_reconciliation_state(next_reconcile_at, last_reconciled_at);

CREATE OR REPLACE FUNCTION wms.reject_shipping_evidence_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS shipping_provider_label_events_immutable
  ON wms.shipping_provider_label_events;
CREATE TRIGGER shipping_provider_label_events_immutable
  BEFORE UPDATE OR DELETE ON wms.shipping_provider_label_events
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

DROP TRIGGER IF EXISTS shipping_provider_label_links_immutable
  ON wms.shipping_provider_label_links;
CREATE TRIGGER shipping_provider_label_links_immutable
  BEFORE UPDATE OR DELETE ON wms.shipping_provider_label_links
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

DROP TRIGGER IF EXISTS carrier_tracking_subscription_labels_immutable
  ON wms.carrier_tracking_subscription_labels;
CREATE TRIGGER carrier_tracking_subscription_labels_immutable
  BEFORE UPDATE OR DELETE ON wms.carrier_tracking_subscription_labels
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

DROP TRIGGER IF EXISTS carrier_tracking_subscription_attempts_immutable
  ON wms.carrier_tracking_subscription_attempts;
CREATE TRIGGER carrier_tracking_subscription_attempts_immutable
  BEFORE UPDATE OR DELETE ON wms.carrier_tracking_subscription_attempts
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

DROP TRIGGER IF EXISTS carrier_tracking_events_immutable
  ON wms.carrier_tracking_events;
CREATE TRIGGER carrier_tracking_events_immutable
  BEFORE UPDATE OR DELETE ON wms.carrier_tracking_events
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

DROP TRIGGER IF EXISTS carrier_tracking_webhook_receipts_immutable
  ON wms.carrier_tracking_webhook_receipts;
CREATE TRIGGER carrier_tracking_webhook_receipts_immutable
  BEFORE UPDATE OR DELETE ON wms.carrier_tracking_webhook_receipts
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

DROP TRIGGER IF EXISTS carrier_tracking_webhook_receipt_parses_immutable
  ON wms.carrier_tracking_webhook_receipt_parses;
CREATE TRIGGER carrier_tracking_webhook_receipt_parses_immutable
  BEFORE UPDATE OR DELETE ON wms.carrier_tracking_webhook_receipt_parses
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

DROP TRIGGER IF EXISTS carrier_tracking_webhook_hydration_attempts_immutable
  ON wms.carrier_tracking_webhook_hydration_attempts;
CREATE TRIGGER carrier_tracking_webhook_hydration_attempts_immutable
  BEFORE UPDATE OR DELETE ON wms.carrier_tracking_webhook_hydration_attempts
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();

DROP TRIGGER IF EXISTS carrier_tracking_event_matches_immutable
  ON wms.carrier_tracking_event_matches;
CREATE TRIGGER carrier_tracking_event_matches_immutable
  BEFORE UPDATE OR DELETE ON wms.carrier_tracking_event_matches
  FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();
