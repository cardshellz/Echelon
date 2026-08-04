ALTER TABLE ebay.ebay_oauth_tokens
  ADD COLUMN external_account_id VARCHAR(255),
  ADD COLUMN external_account_display_name VARCHAR(255),
  ADD COLUMN external_account_identity_scheme VARCHAR(50),
  ADD COLUMN external_account_verified_at TIMESTAMPTZ;

ALTER TABLE ebay.ebay_oauth_tokens
  ADD CONSTRAINT ebay_oauth_tokens_stable_identity_chk CHECK (
    external_account_identity_scheme IS NULL
    OR (
      external_account_identity_scheme = 'provider_user_id'
      AND environment IN ('sandbox', 'production')
      AND external_account_id IS NOT NULL
      AND external_account_id = btrim(external_account_id)
      AND external_account_id <> ''
      AND external_account_verified_at IS NOT NULL
    )
  );

CREATE UNIQUE INDEX ebay_oauth_tokens_stable_account_uidx
  ON ebay.ebay_oauth_tokens(environment, external_account_id)
  WHERE external_account_identity_scheme = 'provider_user_id';

ALTER TABLE dropship.dropship_store_connections
  ADD COLUMN provider_environment VARCHAR(30),
  ADD COLUMN external_account_identity_scheme VARCHAR(40),
  ADD COLUMN external_account_verified_at TIMESTAMPTZ;

ALTER TABLE dropship.dropship_store_connections
  ADD CONSTRAINT dropship_store_connections_stable_identity_chk CHECK (
    external_account_identity_scheme IS NULL
    OR (
      external_account_identity_scheme = 'provider_user_id'
      AND (
        lower(platform) <> 'ebay'
        OR provider_environment IN ('sandbox', 'production')
      )
      AND provider_environment IS NOT NULL
      AND provider_environment = btrim(provider_environment)
      AND provider_environment <> ''
      AND external_account_id IS NOT NULL
      AND external_account_id = btrim(external_account_id)
      AND external_account_id <> ''
      AND external_account_verified_at IS NOT NULL
    )
  );

CREATE UNIQUE INDEX dropship_store_connections_stable_account_uidx
  ON dropship.dropship_store_connections(
    platform,
    provider_environment,
    external_account_id
  )
  WHERE external_account_identity_scheme = 'provider_user_id';

CREATE TABLE marketplace.provider_accounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_kind VARCHAR(20) NOT NULL,
  channel_id INTEGER REFERENCES channels.channels(id) ON DELETE RESTRICT,
  store_connection_id INTEGER
    REFERENCES dropship.dropship_store_connections(id) ON DELETE RESTRICT,
  provider VARCHAR(40) NOT NULL,
  account_namespace VARCHAR(100) NOT NULL,
  external_account_id VARCHAR(255) NOT NULL,
  identity_scheme VARCHAR(50) NOT NULL,
  external_display_name_snapshot VARCHAR(255),
  evidence_hash VARCHAR(64) NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  verified_by_type VARCHAR(20) NOT NULL,
  verified_by_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT provider_accounts_global_identity_uq
    UNIQUE (provider, account_namespace, external_account_id),
  CONSTRAINT provider_accounts_owner_chk CHECK (
    (
      owner_kind = 'channel'
      AND channel_id IS NOT NULL
      AND store_connection_id IS NULL
    ) OR (
      owner_kind = 'dropship'
      AND channel_id IS NULL
      AND store_connection_id IS NOT NULL
    )
  ),
  CONSTRAINT provider_accounts_provider_chk CHECK (
    provider = lower(btrim(provider))
    AND provider ~ '^[a-z][a-z0-9_-]{0,39}$'
  ),
  CONSTRAINT provider_accounts_identity_chk CHECK (
    account_namespace = btrim(account_namespace)
    AND account_namespace <> ''
    AND external_account_id = btrim(external_account_id)
    AND external_account_id <> ''
    AND identity_scheme = 'provider_user_id'
  ),
  CONSTRAINT provider_accounts_evidence_chk CHECK (
    evidence_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT provider_accounts_actor_chk CHECK (
    verified_by_type IN ('user', 'service', 'system')
    AND verified_by_id = btrim(verified_by_id)
    AND verified_by_id <> ''
  )
);

CREATE UNIQUE INDEX provider_accounts_channel_owner_uidx
  ON marketplace.provider_accounts(channel_id, provider, account_namespace)
  WHERE channel_id IS NOT NULL;

CREATE UNIQUE INDEX provider_accounts_dropship_owner_uidx
  ON marketplace.provider_accounts(
    store_connection_id,
    provider,
    account_namespace
  )
  WHERE store_connection_id IS NOT NULL;

CREATE TABLE marketplace.listing_scope_provider_accounts (
  scope_id BIGINT PRIMARY KEY
    REFERENCES marketplace.listing_scopes(id) ON DELETE RESTRICT,
  provider_account_id BIGINT NOT NULL
    REFERENCES marketplace.provider_accounts(id) ON DELETE RESTRICT,
  bound_by_type VARCHAR(20) NOT NULL,
  bound_by_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT listing_scope_provider_accounts_scope_account_uq
    UNIQUE (scope_id, provider_account_id),
  CONSTRAINT listing_scope_provider_accounts_actor_chk CHECK (
    bound_by_type IN ('user', 'service', 'system')
    AND bound_by_id = btrim(bound_by_id)
    AND bound_by_id <> ''
  )
);

CREATE INDEX listing_scope_provider_accounts_account_idx
  ON marketplace.listing_scope_provider_accounts(provider_account_id, scope_id);

CREATE TABLE marketplace.provider_identity_claims (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_account_id BIGINT NOT NULL
    REFERENCES marketplace.provider_accounts(id) ON DELETE RESTRICT,
  scope_id BIGINT NOT NULL,
  publication_id BIGINT NOT NULL,
  member_id BIGINT
    REFERENCES marketplace.listing_publication_members(id) ON DELETE RESTRICT,
  identity_role VARCHAR(30) NOT NULL,
  identity_namespace VARCHAR(160) NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  created_by_type VARCHAR(20) NOT NULL,
  created_by_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT provider_identity_claims_scope_account_fk
    FOREIGN KEY (scope_id, provider_account_id)
    REFERENCES marketplace.listing_scope_provider_accounts(
      scope_id,
      provider_account_id
    ) ON DELETE RESTRICT,
  CONSTRAINT provider_identity_claims_publication_scope_fk
    FOREIGN KEY (publication_id, scope_id)
    REFERENCES marketplace.listing_publications(id, scope_id) ON DELETE RESTRICT,
  CONSTRAINT provider_identity_claims_account_identity_uq
    UNIQUE (provider_account_id, identity_namespace, external_id),
  CONSTRAINT provider_identity_claims_role_chk CHECK (
    identity_role IN (
      'publication_key',
      'listing_id',
      'variant_id',
      'offer_id',
      'inventory_item_id'
    )
  ),
  CONSTRAINT provider_identity_claims_subject_chk CHECK (
    (
      identity_role IN ('publication_key', 'listing_id')
      AND member_id IS NULL
    ) OR (
      identity_role IN ('variant_id', 'offer_id', 'inventory_item_id')
      AND member_id IS NOT NULL
    )
  ),
  CONSTRAINT provider_identity_claims_identity_chk CHECK (
    identity_namespace = btrim(identity_namespace)
    AND identity_namespace <> ''
    AND external_id = btrim(external_id)
    AND external_id <> ''
  ),
  CONSTRAINT provider_identity_claims_actor_chk CHECK (
    created_by_type IN ('user', 'service', 'system')
    AND created_by_id = btrim(created_by_id)
    AND created_by_id <> ''
  )
);

CREATE UNIQUE INDEX provider_identity_claims_publication_role_uidx
  ON marketplace.provider_identity_claims(
    provider_account_id,
    publication_id,
    identity_role
  )
  WHERE member_id IS NULL;

CREATE UNIQUE INDEX provider_identity_claims_member_role_uidx
  ON marketplace.provider_identity_claims(
    provider_account_id,
    member_id,
    identity_role
  )
  WHERE member_id IS NOT NULL;

CREATE INDEX provider_identity_claims_publication_idx
  ON marketplace.provider_identity_claims(publication_id, id);

CREATE TABLE marketplace.listing_registrations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_id BIGINT NOT NULL,
  provider_account_id BIGINT NOT NULL,
  publication_id BIGINT NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  observation_hash VARCHAR(64) NOT NULL,
  desired_state_hash VARCHAR(64) NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL,
  registered_by_type VARCHAR(20) NOT NULL,
  registered_by_id VARCHAR(255) NOT NULL,
  correlation_id VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT listing_registrations_scope_account_fk
    FOREIGN KEY (scope_id, provider_account_id)
    REFERENCES marketplace.listing_scope_provider_accounts(
      scope_id,
      provider_account_id
    ) ON DELETE RESTRICT,
  CONSTRAINT listing_registrations_publication_scope_fk
    FOREIGN KEY (publication_id, scope_id)
    REFERENCES marketplace.listing_publications(id, scope_id) ON DELETE RESTRICT,
  CONSTRAINT listing_registrations_scope_uq UNIQUE (scope_id),
  CONSTRAINT listing_registrations_publication_uq UNIQUE (publication_id),
  CONSTRAINT listing_registrations_scope_idem_uq
    UNIQUE (scope_id, idempotency_key),
  CONSTRAINT listing_registrations_idempotency_chk CHECK (
    idempotency_key = btrim(idempotency_key) AND idempotency_key <> ''
  ),
  CONSTRAINT listing_registrations_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
    AND observation_hash ~ '^[0-9a-f]{64}$'
    AND desired_state_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT listing_registrations_evidence_chk CHECK (
    jsonb_typeof(evidence) = 'object'
  ),
  CONSTRAINT listing_registrations_actor_chk CHECK (
    registered_by_type IN ('user', 'service', 'system')
    AND registered_by_id = btrim(registered_by_id)
    AND registered_by_id <> ''
  ),
  CONSTRAINT listing_registrations_time_chk CHECK (
    registered_at >= observed_at AND created_at >= registered_at
  )
);

CREATE INDEX listing_registrations_account_idx
  ON marketplace.listing_registrations(provider_account_id, created_at);

CREATE OR REPLACE FUNCTION marketplace.assert_provider_account_owner_verified()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  owner_verified BOOLEAN := FALSE;
BEGIN
  IF NEW.identity_scheme IS DISTINCT FROM 'provider_user_id' THEN
    RAISE EXCEPTION 'Provider account registration requires provider_user_id identity'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.owner_kind = 'channel' THEN
    SELECT token.external_account_verified_at = NEW.verified_at
      INTO owner_verified
    FROM ebay.ebay_oauth_tokens AS token
    JOIN channels.channels AS channel ON channel.id = token.channel_id
    WHERE token.channel_id = NEW.channel_id
      AND lower(channel.provider) = NEW.provider
      AND token.environment = NEW.account_namespace
      AND token.external_account_id = NEW.external_account_id
      AND token.external_account_identity_scheme = 'provider_user_id'
      AND token.external_account_verified_at IS NOT NULL
    FOR UPDATE OF token;
  ELSIF NEW.owner_kind = 'dropship' THEN
    SELECT connection.external_account_verified_at = NEW.verified_at
      INTO owner_verified
    FROM dropship.dropship_store_connections AS connection
    WHERE connection.id = NEW.store_connection_id
      AND lower(connection.platform) = NEW.provider
      AND connection.provider_environment = NEW.account_namespace
      AND connection.external_account_id = NEW.external_account_id
      AND connection.external_account_identity_scheme = 'provider_user_id'
      AND connection.external_account_verified_at IS NOT NULL
    FOR UPDATE;
  ELSE
    owner_verified := FALSE;
  END IF;

  IF owner_verified IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Provider account owner does not contain matching stable provider_user_id evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_accounts_owner_verified_guard
BEFORE INSERT ON marketplace.provider_accounts
FOR EACH ROW EXECUTE FUNCTION marketplace.assert_provider_account_owner_verified();

CREATE OR REPLACE FUNCTION marketplace.guard_listing_scope_provider_account()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  scope_row marketplace.listing_scopes%ROWTYPE;
  account_row marketplace.provider_accounts%ROWTYPE;
  channel_owner_id INTEGER;
  dropship_owner_id INTEGER;
BEGIN
  SELECT * INTO scope_row
  FROM marketplace.listing_scopes
  WHERE id = NEW.scope_id
  FOR UPDATE;

  SELECT * INTO account_row
  FROM marketplace.provider_accounts
  WHERE id = NEW.provider_account_id;

  SELECT channel_id INTO channel_owner_id
  FROM marketplace.channel_listing_scopes
  WHERE scope_id = NEW.scope_id;

  SELECT store_connection_id INTO dropship_owner_id
  FROM marketplace.dropship_listing_scopes
  WHERE scope_id = NEW.scope_id;

  IF scope_row.id IS NULL OR account_row.id IS NULL
     OR scope_row.owner_kind IS DISTINCT FROM account_row.owner_kind
     OR scope_row.provider IS DISTINCT FROM account_row.provider
     OR (
       scope_row.owner_kind = 'channel'
       AND (
         channel_owner_id IS NULL
         OR account_row.channel_id IS DISTINCT FROM channel_owner_id
         OR account_row.store_connection_id IS NOT NULL
       )
     )
     OR (
       scope_row.owner_kind = 'dropship'
       AND (
         dropship_owner_id IS NULL
         OR account_row.store_connection_id IS DISTINCT FROM dropship_owner_id
         OR account_row.channel_id IS NOT NULL
       )
     ) THEN
    RAISE EXCEPTION 'Listing scope and provider account owner do not match'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER listing_scope_provider_accounts_guard
BEFORE INSERT ON marketplace.listing_scope_provider_accounts
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_scope_provider_account();

CREATE OR REPLACE FUNCTION marketplace.guard_provider_identity_claim()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  publication_row marketplace.listing_publications%ROWTYPE;
  member_row marketplace.listing_publication_members%ROWTYPE;
  expected_external_id TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM marketplace.listing_scope_provider_accounts
    WHERE scope_id = NEW.scope_id
      AND provider_account_id = NEW.provider_account_id
  ) THEN
    RAISE EXCEPTION 'Provider identity claim requires the immutable scope account binding'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO publication_row
  FROM marketplace.listing_publications
  WHERE id = NEW.publication_id AND scope_id = NEW.scope_id
  FOR UPDATE;

  IF publication_row.id IS NULL OR publication_row.status <> 'staged' THEN
    RAISE EXCEPTION 'Provider identities may only be claimed for a staged publication'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.identity_role = 'publication_key' THEN
    expected_external_id := publication_row.provider_publication_key;
  ELSIF NEW.identity_role = 'listing_id' THEN
    expected_external_id := publication_row.external_listing_id;
  ELSE
    SELECT * INTO member_row
    FROM marketplace.listing_publication_members
    WHERE id = NEW.member_id
      AND publication_id = NEW.publication_id
      AND scope_id = NEW.scope_id;

    IF member_row.id IS NULL OR member_row.disposition <> 'included' THEN
      RAISE EXCEPTION 'Member provider identity claim requires an included publication member'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.identity_role = 'variant_id' THEN
      expected_external_id := member_row.external_variant_id;
    ELSIF NEW.identity_role = 'offer_id' THEN
      expected_external_id := member_row.external_offer_id;
    ELSIF NEW.identity_role = 'inventory_item_id' THEN
      expected_external_id := member_row.external_inventory_item_id;
    END IF;
  END IF;

  IF expected_external_id IS NULL
     OR expected_external_id IS DISTINCT FROM NEW.external_id THEN
    RAISE EXCEPTION 'Provider identity claim does not match publication identity data'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_identity_claims_guard
BEFORE INSERT ON marketplace.provider_identity_claims
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_provider_identity_claim();

CREATE OR REPLACE FUNCTION marketplace.guard_listing_registration_receipt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  publication_row marketplace.listing_publications%ROWTYPE;
  expected_claim_count INTEGER;
  actual_claim_count INTEGER;
BEGIN
  SELECT * INTO publication_row
  FROM marketplace.listing_publications
  WHERE id = NEW.publication_id AND scope_id = NEW.scope_id
  FOR UPDATE;

  IF publication_row.id IS NULL
     OR publication_row.status <> 'active'
     OR publication_row.generation <> 1
     OR publication_row.supersedes_publication_id IS NOT NULL
     OR publication_row.desired_state_hash IS DISTINCT FROM NEW.desired_state_hash THEN
    RAISE EXCEPTION 'Registration receipt requires the matching active first publication generation'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM marketplace.listing_scope_provider_accounts
    WHERE scope_id = NEW.scope_id
      AND provider_account_id = NEW.provider_account_id
  ) OR EXISTS (
    SELECT 1
    FROM marketplace.listing_replacement_operations
    WHERE scope_id = NEW.scope_id
  ) OR (
    SELECT count(*)
    FROM marketplace.listing_publications
    WHERE scope_id = NEW.scope_id
  ) <> 1 THEN
    RAISE EXCEPTION 'Registration is allowed only for an empty scope without replacement history'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    1
    + CASE WHEN publication_row.provider_publication_key IS NULL THEN 0 ELSE 1 END
    + COALESCE(sum(
        CASE WHEN external_variant_id IS NULL THEN 0 ELSE 1 END
        + CASE WHEN external_offer_id IS NULL THEN 0 ELSE 1 END
        + CASE WHEN external_inventory_item_id IS NULL THEN 0 ELSE 1 END
      ), 0)::INTEGER
  INTO expected_claim_count
  FROM marketplace.listing_publication_members
  WHERE publication_id = NEW.publication_id;

  SELECT count(*) INTO actual_claim_count
  FROM marketplace.provider_identity_claims
  WHERE provider_account_id = NEW.provider_account_id
    AND scope_id = NEW.scope_id
    AND publication_id = NEW.publication_id;

  IF actual_claim_count IS DISTINCT FROM expected_claim_count THEN
    RAISE EXCEPTION 'Registration receipt requires a complete provider identity claim set'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER listing_registrations_guard
BEFORE INSERT ON marketplace.listing_registrations
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_registration_receipt();

CREATE OR REPLACE FUNCTION marketplace.reject_registration_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Marketplace registration history is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER provider_accounts_immutable
BEFORE UPDATE OR DELETE ON marketplace.provider_accounts
FOR EACH ROW EXECUTE FUNCTION marketplace.reject_registration_history_mutation();

CREATE TRIGGER listing_scope_provider_accounts_immutable
BEFORE UPDATE OR DELETE ON marketplace.listing_scope_provider_accounts
FOR EACH ROW EXECUTE FUNCTION marketplace.reject_registration_history_mutation();

CREATE TRIGGER provider_identity_claims_immutable
BEFORE UPDATE OR DELETE ON marketplace.provider_identity_claims
FOR EACH ROW EXECUTE FUNCTION marketplace.reject_registration_history_mutation();

CREATE TRIGGER listing_registrations_immutable
BEFORE UPDATE OR DELETE ON marketplace.listing_registrations
FOR EACH ROW EXECUTE FUNCTION marketplace.reject_registration_history_mutation();

CREATE OR REPLACE FUNCTION marketplace.guard_registered_scope_drift()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM marketplace.listing_scope_provider_accounts
    WHERE scope_id = OLD.id
  ) AND (
    TG_OP = 'DELETE'
    OR ROW(NEW.owner_kind, NEW.provider, NEW.marketplace_id, NEW.product_id)
       IS DISTINCT FROM
       ROW(OLD.owner_kind, OLD.provider, OLD.marketplace_id, OLD.product_id)
  ) THEN
    RAISE EXCEPTION 'Registered listing scope identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER listing_scopes_registered_drift_guard
BEFORE UPDATE OR DELETE ON marketplace.listing_scopes
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_registered_scope_drift();

CREATE OR REPLACE FUNCTION marketplace.guard_registered_channel_provider_drift()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM marketplace.provider_accounts
    WHERE owner_kind = 'channel' AND channel_id = OLD.id
  ) AND (
    TG_OP = 'DELETE' OR lower(NEW.provider) IS DISTINCT FROM lower(OLD.provider)
  ) THEN
    RAISE EXCEPTION 'Registered Channel provider identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER channels_registered_provider_drift_guard
BEFORE UPDATE OR DELETE ON channels.channels
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_registered_channel_provider_drift();

CREATE OR REPLACE FUNCTION marketplace.guard_registered_ebay_identity_drift()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  bound_account marketplace.provider_accounts%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO bound_account
    FROM marketplace.provider_accounts
    WHERE owner_kind = 'channel'
      AND channel_id = NEW.channel_id
      AND provider = 'ebay'
      AND account_namespace = NEW.environment;
    IF bound_account.id IS NOT NULL AND ROW(
      NEW.external_account_id,
      NEW.external_account_identity_scheme
    ) IS DISTINCT FROM ROW(
      bound_account.external_account_id,
      bound_account.identity_scheme
    ) THEN
      RAISE EXCEPTION 'eBay token stable account identity does not match registered account'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO bound_account
  FROM marketplace.provider_accounts
  WHERE owner_kind = 'channel'
    AND channel_id = OLD.channel_id
    AND provider = 'ebay'
    AND account_namespace = OLD.environment
    AND external_account_id = OLD.external_account_id;

  IF bound_account.id IS NOT NULL AND (
    TG_OP = 'DELETE'
    OR ROW(
      NEW.channel_id,
      NEW.environment,
      NEW.external_account_id,
      NEW.external_account_identity_scheme
    ) IS DISTINCT FROM ROW(
      OLD.channel_id,
      OLD.environment,
      OLD.external_account_id,
      OLD.external_account_identity_scheme
    )
  ) THEN
    RAISE EXCEPTION 'Registered eBay token stable account identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ebay_oauth_tokens_registered_identity_drift_guard
BEFORE INSERT OR UPDATE OR DELETE ON ebay.ebay_oauth_tokens
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_registered_ebay_identity_drift();

CREATE OR REPLACE FUNCTION marketplace.guard_registered_dropship_identity_drift()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  bound_account marketplace.provider_accounts%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO bound_account
  FROM marketplace.provider_accounts
  WHERE owner_kind = 'dropship'
    AND store_connection_id = OLD.id;

  IF bound_account.id IS NOT NULL AND (
    TG_OP = 'DELETE'
    OR ROW(
      NEW.vendor_id,
      NEW.platform,
      NEW.provider_environment,
      NEW.external_account_id,
      NEW.external_account_identity_scheme
    ) IS DISTINCT FROM ROW(
      OLD.vendor_id,
      OLD.platform,
      OLD.provider_environment,
      OLD.external_account_id,
      OLD.external_account_identity_scheme
    )
  ) THEN
    RAISE EXCEPTION 'Registered Dropship stable account identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dropship_store_connections_registered_identity_drift_guard
BEFORE UPDATE OR DELETE ON dropship.dropship_store_connections
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_registered_dropship_identity_drift();

COMMENT ON TABLE marketplace.provider_accounts IS
  'Immutable owner-qualified stable marketplace account identities. Registration accepts provider_user_id only.';

COMMENT ON TABLE marketplace.listing_scope_provider_accounts IS
  'Immutable binding between one listing scope and the provider account that owns its external identities.';

COMMENT ON TABLE marketplace.provider_identity_claims IS
  'Immutable account-qualified claims for distinct publication, listing, variant, offer, and inventory-item identity namespaces.';

COMMENT ON TABLE marketplace.listing_registrations IS
  'Immutable idempotency and audit receipt for importing one observed live marketplace listing into an otherwise empty scope.';
