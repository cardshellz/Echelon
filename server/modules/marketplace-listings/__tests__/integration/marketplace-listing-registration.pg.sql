\set ON_ERROR_STOP on
\set VERBOSITY verbose

-- PostgreSQL integration proof for migrations 0607 and 0609. This file is
-- intentionally self-contained: it creates only the owner/catalog tables the
-- migrations reference, applies the real migrations, then exercises the
-- registration lifecycle and database invariants with deterministic fixtures.
SET TIME ZONE 'UTC';

CREATE SCHEMA catalog;
CREATE SCHEMA channels;
CREATE SCHEMA dropship;
CREATE SCHEMA ebay;

CREATE TABLE catalog.products (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE catalog.product_variants (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  sku VARCHAR(100),
  name TEXT NOT NULL
);

CREATE TABLE channels.channels (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  provider VARCHAR(30) NOT NULL
);

CREATE TABLE dropship.dropship_vendors (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE dropship.dropship_store_connections (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id INTEGER NOT NULL
    REFERENCES dropship.dropship_vendors(id) ON DELETE RESTRICT,
  platform VARCHAR(30) NOT NULL,
  external_account_id VARCHAR(255)
);

CREATE TABLE ebay.ebay_oauth_tokens (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id INTEGER NOT NULL
    REFERENCES channels.channels(id) ON DELETE RESTRICT,
  environment VARCHAR(20) NOT NULL,
  access_token TEXT NOT NULL,
  access_token_expires_at TIMESTAMP NOT NULL,
  refresh_token TEXT NOT NULL,
  refresh_token_expires_at TIMESTAMP,
  scopes TEXT,
  last_refreshed_at TIMESTAMP DEFAULT transaction_timestamp(),
  created_at TIMESTAMP NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMP NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT ebay_oauth_tokens_channel_environment_uq
    UNIQUE (channel_id, environment)
);

\ir ../../../../../migrations/0607_marketplace_listing_replacement_foundation.sql
\ir ../../../../../migrations/0609_marketplace_listing_registration.sql

INSERT INTO catalog.products (id, name) OVERRIDING SYSTEM VALUE VALUES
  (101, 'Channel registration product'),
  (102, 'Dropship registration product'),
  (103, 'Rollback-only product');

INSERT INTO catalog.product_variants (id, product_id, sku, name)
OVERRIDING SYSTEM VALUE VALUES
  (1001, 101, 'CHANNEL-SKU', 'Channel variant'),
  (1002, 102, 'DROPSHIP-SKU', 'Dropship variant'),
  (1003, 103, 'ROLLBACK-SKU', 'Rollback variant');

INSERT INTO channels.channels (id, name, provider)
OVERRIDING SYSTEM VALUE VALUES
  (11, 'Primary eBay channel', 'ebay'),
  (12, 'Timestamp mismatch channel', 'ebay');

INSERT INTO dropship.dropship_vendors (id, name)
OVERRIDING SYSTEM VALUE VALUES
  (21, 'Registered vendor'),
  (22, 'Different vendor'),
  (23, 'Collision vendor'),
  (24, 'Timestamp mismatch vendor');

INSERT INTO dropship.dropship_store_connections (
  id,
  vendor_id,
  platform,
  external_account_id,
  provider_environment,
  external_account_identity_scheme,
  external_account_verified_at
) OVERRIDING SYSTEM VALUE VALUES
  (
    31,
    21,
    'ebay',
    'account-dropship',
    'production',
    'provider_user_id',
    TIMESTAMPTZ '2026-08-04 14:00:00+00'
  ),
  (
    32,
    23,
    'ebay',
    'account-channel',
    'production',
    'provider_user_id',
    TIMESTAMPTZ '2026-08-04 14:05:00+00'
  ),
  (
    33,
    24,
    'ebay',
    'account-dropship-mismatch',
    'production',
    'provider_user_id',
    TIMESTAMPTZ '2026-08-04 14:10:00+00'
  );

INSERT INTO ebay.ebay_oauth_tokens (
  id,
  channel_id,
  environment,
  access_token,
  access_token_expires_at,
  refresh_token,
  external_account_id,
  external_account_display_name,
  external_account_identity_scheme,
  external_account_verified_at
) OVERRIDING SYSTEM VALUE VALUES
  (
    41,
    11,
    'production',
    'test-access-token',
    TIMESTAMP '2026-08-05 00:00:00',
    'test-refresh-token',
    'account-channel',
    'Channel Test Account',
    'provider_user_id',
    TIMESTAMPTZ '2026-08-04 14:00:00+00'
  ),
  (
    42,
    12,
    'production',
    'test-access-token-2',
    TIMESTAMP '2026-08-05 00:00:00',
    'test-refresh-token-2',
    'account-channel-mismatch',
    'Timestamp Test Account',
    'provider_user_id',
    TIMESTAMPTZ '2026-08-04 14:10:00+00'
  );

-- Register one Channel-owned live publication through the full lifecycle.
BEGIN;
INSERT INTO marketplace.listing_scopes (
  owner_kind,
  provider,
  marketplace_id,
  product_id,
  created_by_type,
  created_by_id
) VALUES (
  'channel',
  'ebay',
  'EBAY_US',
  101,
  'user',
  'integration-proof'
) RETURNING id AS scope_id
\gset channel_

INSERT INTO marketplace.channel_listing_scopes (
  scope_id,
  channel_id,
  product_id,
  marketplace_id
) VALUES (:channel_scope_id, 11, 101, 'EBAY_US');

INSERT INTO marketplace.provider_accounts (
  owner_kind,
  channel_id,
  provider,
  account_namespace,
  external_account_id,
  identity_scheme,
  external_display_name_snapshot,
  evidence_hash,
  verified_at,
  verified_by_type,
  verified_by_id
) VALUES (
  'channel',
  11,
  'ebay',
  'production',
  'account-channel',
  'provider_user_id',
  'Channel Test Account',
  repeat('a', 64),
  TIMESTAMPTZ '2026-08-04 14:00:00+00',
  'user',
  'integration-proof'
) RETURNING id AS account_id
\gset channel_

INSERT INTO marketplace.listing_scope_provider_accounts (
  scope_id,
  provider_account_id,
  bound_by_type,
  bound_by_id
) VALUES (
  :channel_scope_id,
  :channel_account_id,
  'user',
  'integration-proof'
);

INSERT INTO marketplace.listing_publications (
  scope_id,
  product_id,
  generation,
  status,
  desired_state_hash,
  created_by_type,
  created_by_id
) VALUES (
  :channel_scope_id,
  101,
  1,
  'planned',
  repeat('b', 64),
  'user',
  'integration-proof'
) RETURNING id AS publication_id
\gset channel_

INSERT INTO marketplace.listing_publication_members (
  publication_id,
  scope_id,
  product_id,
  product_variant_id,
  sku_snapshot,
  disposition
) VALUES (
  :channel_publication_id,
  :channel_scope_id,
  101,
  1001,
  'CHANNEL-SKU',
  'included'
) RETURNING id AS member_id
\gset channel_

UPDATE marketplace.listing_publications
SET status = 'staged',
    external_listing_id = 'channel-listing-1',
    external_url = 'https://example.invalid/channel-listing-1',
    metadata = '{"proof":"channel"}'::jsonb,
    published_at = transaction_timestamp(),
    updated_at = transaction_timestamp()
WHERE id = :channel_publication_id;

UPDATE marketplace.listing_publication_members
SET external_variant_id = 'channel-variant-1',
    external_offer_id = 'channel-offer-1',
    external_inventory_item_id = 'CHANNEL-SKU',
    updated_at = transaction_timestamp()
WHERE id = :channel_member_id;

INSERT INTO marketplace.provider_identity_claims (
  provider_account_id,
  scope_id,
  publication_id,
  member_id,
  identity_role,
  identity_namespace,
  external_id,
  created_by_type,
  created_by_id
) VALUES
  (
    :channel_account_id,
    :channel_scope_id,
    :channel_publication_id,
    NULL,
    'listing_id',
    'ebay:production:EBAY_US:listing_id',
    'channel-listing-1',
    'user',
    'integration-proof'
  ),
  (
    :channel_account_id,
    :channel_scope_id,
    :channel_publication_id,
    :channel_member_id,
    'variant_id',
    'ebay:production:EBAY_US:variant_id',
    'channel-variant-1',
    'user',
    'integration-proof'
  ),
  (
    :channel_account_id,
    :channel_scope_id,
    :channel_publication_id,
    :channel_member_id,
    'offer_id',
    'ebay:production:EBAY_US:offer_id',
    'channel-offer-1',
    'user',
    'integration-proof'
  ),
  (
    :channel_account_id,
    :channel_scope_id,
    :channel_publication_id,
    :channel_member_id,
    'inventory_item_id',
    'ebay:production:EBAY_US:inventory_item_id',
    'CHANNEL-SKU',
    'user',
    'integration-proof'
  );

UPDATE marketplace.listing_publications
SET status = 'active',
    verified_at = transaction_timestamp(),
    updated_at = transaction_timestamp()
WHERE id = :channel_publication_id;

INSERT INTO marketplace.listing_registrations (
  scope_id,
  provider_account_id,
  publication_id,
  idempotency_key,
  request_hash,
  observation_hash,
  desired_state_hash,
  evidence,
  observed_at,
  registered_at,
  registered_by_type,
  registered_by_id,
  correlation_id
) VALUES (
  :channel_scope_id,
  :channel_account_id,
  :channel_publication_id,
  'channel-registration-proof',
  repeat('c', 64),
  repeat('d', 64),
  repeat('b', 64),
  '{"source":"integration-proof"}'::jsonb,
  transaction_timestamp() - INTERVAL '1 second',
  transaction_timestamp(),
  'user',
  'integration-proof',
  'channel-proof-correlation'
);
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;

-- Register one Dropship-owned live publication through the same lifecycle.
BEGIN;
INSERT INTO marketplace.listing_scopes (
  owner_kind,
  provider,
  marketplace_id,
  product_id,
  created_by_type,
  created_by_id
) VALUES (
  'dropship',
  'ebay',
  'EBAY_US',
  102,
  'user',
  'integration-proof'
) RETURNING id AS scope_id
\gset dropship_

INSERT INTO marketplace.dropship_listing_scopes (
  scope_id,
  store_connection_id,
  product_id,
  marketplace_id
) VALUES (:dropship_scope_id, 31, 102, 'EBAY_US');

INSERT INTO marketplace.provider_accounts (
  owner_kind,
  store_connection_id,
  provider,
  account_namespace,
  external_account_id,
  identity_scheme,
  external_display_name_snapshot,
  evidence_hash,
  verified_at,
  verified_by_type,
  verified_by_id
) VALUES (
  'dropship',
  31,
  'ebay',
  'production',
  'account-dropship',
  'provider_user_id',
  'Dropship Test Account',
  repeat('e', 64),
  TIMESTAMPTZ '2026-08-04 14:00:00+00',
  'user',
  'integration-proof'
) RETURNING id AS account_id
\gset dropship_

INSERT INTO marketplace.listing_scope_provider_accounts (
  scope_id,
  provider_account_id,
  bound_by_type,
  bound_by_id
) VALUES (
  :dropship_scope_id,
  :dropship_account_id,
  'user',
  'integration-proof'
);

INSERT INTO marketplace.listing_publications (
  scope_id,
  product_id,
  generation,
  status,
  desired_state_hash,
  created_by_type,
  created_by_id
) VALUES (
  :dropship_scope_id,
  102,
  1,
  'planned',
  repeat('f', 64),
  'user',
  'integration-proof'
) RETURNING id AS publication_id
\gset dropship_

INSERT INTO marketplace.listing_publication_members (
  publication_id,
  scope_id,
  product_id,
  product_variant_id,
  sku_snapshot,
  disposition
) VALUES (
  :dropship_publication_id,
  :dropship_scope_id,
  102,
  1002,
  'DROPSHIP-SKU',
  'included'
) RETURNING id AS member_id
\gset dropship_

UPDATE marketplace.listing_publications
SET status = 'staged',
    external_listing_id = 'dropship-listing-1',
    metadata = '{"proof":"dropship"}'::jsonb,
    published_at = transaction_timestamp(),
    updated_at = transaction_timestamp()
WHERE id = :dropship_publication_id;

UPDATE marketplace.listing_publication_members
SET external_inventory_item_id = 'DROPSHIP-SKU',
    updated_at = transaction_timestamp()
WHERE id = :dropship_member_id;

INSERT INTO marketplace.provider_identity_claims (
  provider_account_id,
  scope_id,
  publication_id,
  member_id,
  identity_role,
  identity_namespace,
  external_id,
  created_by_type,
  created_by_id
) VALUES
  (
    :dropship_account_id,
    :dropship_scope_id,
    :dropship_publication_id,
    NULL,
    'listing_id',
    'ebay:production:EBAY_US:listing_id',
    'dropship-listing-1',
    'user',
    'integration-proof'
  ),
  (
    :dropship_account_id,
    :dropship_scope_id,
    :dropship_publication_id,
    :dropship_member_id,
    'inventory_item_id',
    'ebay:production:EBAY_US:inventory_item_id',
    'DROPSHIP-SKU',
    'user',
    'integration-proof'
  );

UPDATE marketplace.listing_publications
SET status = 'active',
    verified_at = transaction_timestamp(),
    updated_at = transaction_timestamp()
WHERE id = :dropship_publication_id;

INSERT INTO marketplace.listing_registrations (
  scope_id,
  provider_account_id,
  publication_id,
  idempotency_key,
  request_hash,
  observation_hash,
  desired_state_hash,
  evidence,
  observed_at,
  registered_at,
  registered_by_type,
  registered_by_id
) VALUES (
  :dropship_scope_id,
  :dropship_account_id,
  :dropship_publication_id,
  'dropship-registration-proof',
  repeat('1', 64),
  repeat('2', 64),
  repeat('f', 64),
  '{"source":"integration-proof"}'::jsonb,
  transaction_timestamp() - INTERVAL '1 second',
  transaction_timestamp(),
  'user',
  'integration-proof'
);
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;

DO $proof$
DECLARE
  registration_count INTEGER;
  ownership_mismatch_count INTEGER;
BEGIN
  SELECT count(*) INTO registration_count
  FROM marketplace.listing_registrations;

  IF registration_count <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED: expected 2 valid registrations, found %',
      registration_count;
  END IF;

  SELECT count(*) INTO ownership_mismatch_count
  FROM marketplace.provider_accounts AS account
  LEFT JOIN ebay.ebay_oauth_tokens AS token
    ON account.owner_kind = 'channel'
   AND token.channel_id = account.channel_id
   AND token.environment = account.account_namespace
   AND token.external_account_id = account.external_account_id
   AND token.external_account_verified_at = account.verified_at
  LEFT JOIN dropship.dropship_store_connections AS connection
    ON account.owner_kind = 'dropship'
   AND connection.id = account.store_connection_id
   AND connection.provider_environment = account.account_namespace
   AND connection.external_account_id = account.external_account_id
   AND connection.external_account_verified_at = account.verified_at
  WHERE (account.owner_kind = 'channel' AND token.id IS NULL)
     OR (account.owner_kind = 'dropship' AND connection.id IS NULL);

  IF ownership_mismatch_count <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED: registered provider account ownership mismatch count %',
      ownership_mismatch_count;
  END IF;
END
$proof$;

CREATE TEMP TABLE registration_proof_failures (
  invariant TEXT PRIMARY KEY,
  detail TEXT NOT NULL
) ON COMMIT PRESERVE ROWS;

-- The provider account timestamp must be the exact durable owner timestamp,
-- not merely another non-null time supplied by the caller.
DO $proof$
DECLARE
  inserted_id BIGINT;
BEGIN
  BEGIN
    INSERT INTO marketplace.provider_accounts (
      owner_kind,
      channel_id,
      provider,
      account_namespace,
      external_account_id,
      identity_scheme,
      evidence_hash,
      verified_at,
      verified_by_type,
      verified_by_id
    ) VALUES (
      'channel',
      12,
      'ebay',
      'production',
      'account-channel-mismatch',
      'provider_user_id',
      repeat('3', 64),
      TIMESTAMPTZ '2026-08-04 14:10:01+00',
      'user',
      'integration-proof'
    ) RETURNING id INTO inserted_id;
    RAISE EXCEPTION USING
      ERRCODE = 'PT001',
      MESSAGE = 'provider account accepted a non-matching Channel verified_at';
  EXCEPTION
    WHEN check_violation THEN
      IF position(
        'stable provider_user_id evidence' IN SQLERRM
      ) = 0 THEN
        RAISE;
      END IF;
    WHEN SQLSTATE 'PT001' THEN
      INSERT INTO registration_proof_failures VALUES (
        'channel_exact_verified_at',
        SQLERRM
      );
  END;
END
$proof$;

DO $proof$
DECLARE
  inserted_id BIGINT;
BEGIN
  BEGIN
    INSERT INTO marketplace.provider_accounts (
      owner_kind,
      store_connection_id,
      provider,
      account_namespace,
      external_account_id,
      identity_scheme,
      evidence_hash,
      verified_at,
      verified_by_type,
      verified_by_id
    ) VALUES (
      'dropship',
      33,
      'ebay',
      'production',
      'account-dropship-mismatch',
      'provider_user_id',
      repeat('4', 64),
      TIMESTAMPTZ '2026-08-04 14:10:01+00',
      'user',
      'integration-proof'
    ) RETURNING id INTO inserted_id;
    RAISE EXCEPTION USING
      ERRCODE = 'PT002',
      MESSAGE = 'provider account accepted a non-matching Dropship verified_at';
  EXCEPTION
    WHEN check_violation THEN
      IF position(
        'stable provider_user_id evidence' IN SQLERRM
      ) = 0 THEN
        RAISE;
      END IF;
    WHEN SQLSTATE 'PT002' THEN
      INSERT INTO registration_proof_failures VALUES (
        'dropship_exact_verified_at',
        SQLERRM
      );
  END;
END
$proof$;

-- Provider account identity ownership is global across owner modules.
DO $proof$
DECLARE
  collision_constraint TEXT;
BEGIN
  BEGIN
    INSERT INTO marketplace.provider_accounts (
      owner_kind,
      store_connection_id,
      provider,
      account_namespace,
      external_account_id,
      identity_scheme,
      evidence_hash,
      verified_at,
      verified_by_type,
      verified_by_id
    ) VALUES (
      'dropship',
      32,
      'ebay',
      'production',
      'account-channel',
      'provider_user_id',
      repeat('5', 64),
      TIMESTAMPTZ '2026-08-04 14:05:00+00',
      'user',
      'integration-proof'
    );
    RAISE EXCEPTION USING
      ERRCODE = 'PT003',
      MESSAGE = 'global provider account identity collision was accepted';
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS collision_constraint = CONSTRAINT_NAME;
      IF collision_constraint IS DISTINCT FROM
        'provider_accounts_global_identity_uq' THEN
        RAISE;
      END IF;
    WHEN SQLSTATE 'PT003' THEN
      INSERT INTO registration_proof_failures VALUES (
        'global_provider_account_collision',
        SQLERRM
      );
  END;
END
$proof$;

-- Once registered, Dropship tenant ownership is part of the immutable owner
-- identity. Reassigning a connection to another vendor must be rejected.
DO $proof$
BEGIN
  BEGIN
    UPDATE dropship.dropship_store_connections
    SET vendor_id = 22
    WHERE id = 31;
    RAISE EXCEPTION USING
      ERRCODE = 'PT004',
      MESSAGE = 'registered Dropship vendor_id drift was accepted';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN
      IF position(
        'Registered Dropship stable account identity is immutable' IN SQLERRM
      ) = 0 THEN
        RAISE;
      END IF;
    WHEN SQLSTATE 'PT004' THEN
      INSERT INTO registration_proof_failures VALUES (
        'registered_dropship_vendor_drift',
        SQLERRM
      );
  END;
END
$proof$;

-- Stable owner identities cannot drift after a registration is bound.
DO $proof$
BEGIN
  BEGIN
    UPDATE ebay.ebay_oauth_tokens
    SET external_account_id = 'different-channel-account'
    WHERE id = 41;
    RAISE EXCEPTION USING
      ERRCODE = 'PT005',
      MESSAGE = 'registered Channel account identity drift was accepted';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN
      IF position(
        'Registered eBay token stable account identity is immutable' IN SQLERRM
      ) = 0 THEN
        RAISE;
      END IF;
    WHEN SQLSTATE 'PT005' THEN
      INSERT INTO registration_proof_failures VALUES (
        'registered_channel_identity_drift',
        SQLERRM
      );
  END;
END
$proof$;

DO $proof$
BEGIN
  BEGIN
    UPDATE dropship.dropship_store_connections
    SET external_account_id = 'different-dropship-account'
    WHERE id = 31;
    RAISE EXCEPTION USING
      ERRCODE = 'PT006',
      MESSAGE = 'registered Dropship account identity drift was accepted';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN
      IF position(
        'Registered Dropship stable account identity is immutable' IN SQLERRM
      ) = 0 THEN
        RAISE;
      END IF;
    WHEN SQLSTATE 'PT006' THEN
      INSERT INTO registration_proof_failures VALUES (
        'registered_dropship_identity_drift',
        SQLERRM
      );
  END;
END
$proof$;

-- A registration-shaped subtransaction that has already created the scope and
-- owner binding must roll those writes back when the provider-account guard
-- rejects stale evidence.
DO $proof$
DECLARE
  rollback_scope_id BIGINT;
BEGIN
  BEGIN
    INSERT INTO marketplace.listing_scopes (
      owner_kind,
      provider,
      marketplace_id,
      product_id,
      created_by_type,
      created_by_id
    ) VALUES (
      'channel',
      'ebay',
      'EBAY_US',
      103,
      'user',
      'rollback-proof'
    ) RETURNING id INTO rollback_scope_id;

    INSERT INTO marketplace.channel_listing_scopes (
      scope_id,
      channel_id,
      product_id,
      marketplace_id
    ) VALUES (rollback_scope_id, 12, 103, 'EBAY_US');

    INSERT INTO marketplace.provider_accounts (
      owner_kind,
      channel_id,
      provider,
      account_namespace,
      external_account_id,
      identity_scheme,
      evidence_hash,
      verified_at,
      verified_by_type,
      verified_by_id
    ) VALUES (
      'channel',
      12,
      'ebay',
      'production',
      'account-channel-mismatch',
      'provider_user_id',
      repeat('6', 64),
      TIMESTAMPTZ '2026-08-04 14:10:01+00',
      'user',
      'rollback-proof'
    );
    RAISE EXCEPTION USING
      ERRCODE = 'PT007',
      MESSAGE = 'rollback setup unexpectedly accepted stale owner evidence';
  EXCEPTION
    WHEN check_violation THEN
      IF position(
        'stable provider_user_id evidence' IN SQLERRM
      ) = 0 THEN
        RAISE;
      END IF;
    WHEN SQLSTATE 'PT007' THEN
      INSERT INTO registration_proof_failures VALUES (
        'failed_registration_rollback_setup',
        SQLERRM
      );
  END;

  IF EXISTS (
    SELECT 1
    FROM marketplace.listing_scopes
    WHERE created_by_id = 'rollback-proof'
  ) OR EXISTS (
    SELECT 1
    FROM marketplace.channel_listing_scopes
    WHERE product_id = 103
  ) THEN
    RAISE EXCEPTION 'PROOF FAILED: registration transaction rollback leaked rows';
  END IF;
END
$proof$;

DO $proof$
DECLARE
  failure_summary TEXT;
BEGIN
  SELECT string_agg(invariant || ': ' || detail, '; ' ORDER BY invariant)
  INTO failure_summary
  FROM registration_proof_failures;

  IF failure_summary IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED: %', failure_summary;
  END IF;
END
$proof$;

SELECT jsonb_build_object(
  'validChannelRegistrations', count(*) FILTER (
    WHERE scope.owner_kind = 'channel'
  ),
  'validDropshipRegistrations', count(*) FILTER (
    WHERE scope.owner_kind = 'dropship'
  ),
  'providerAccounts', (SELECT count(*) FROM marketplace.provider_accounts),
  'identityClaims', (SELECT count(*) FROM marketplace.provider_identity_claims),
  'rollbackRows', (
    SELECT count(*)
    FROM marketplace.listing_scopes
    WHERE created_by_id = 'rollback-proof'
  )
) AS registration_proof_summary
FROM marketplace.listing_registrations AS registration
JOIN marketplace.listing_scopes AS scope ON scope.id = registration.scope_id;
