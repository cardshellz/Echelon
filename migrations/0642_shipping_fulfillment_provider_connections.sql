-- Provider-neutral fulfillment connections and encrypted credential storage.
-- Existing ShipStation routing is attached to a system-managed environment
-- connection so this migration does not interrupt current routes.

CREATE TABLE shipping.fulfillment_provider_connections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider VARCHAR(80) NOT NULL,
  name VARCHAR(160) NOT NULL,
  status VARCHAR(20) NOT NULL,
  credential_source VARCHAR(20) NOT NULL,
  credential_ref VARCHAR(120),
  system_managed BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL DEFAULT 1,
  last_verified_at TIMESTAMPTZ,
  last_error_code VARCHAR(120),
  last_error_message VARCHAR(500),
  created_by VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_by VARCHAR(120) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT shipping_fulfillment_provider_connection_provider_chk
    CHECK (provider ~ '^[a-z][a-z0-9_]{1,79}$'),
  CONSTRAINT shipping_fulfillment_provider_connection_name_chk
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT shipping_fulfillment_provider_connection_status_chk
    CHECK (status IN ('active', 'disabled', 'error')),
  CONSTRAINT shipping_fulfillment_provider_connection_credential_source_chk
    CHECK (credential_source IN ('environment', 'vault')),
  CONSTRAINT shipping_fulfillment_provider_connection_credential_ref_chk CHECK (
    (
      credential_source = 'environment'
      AND credential_ref IS NOT NULL
      AND char_length(btrim(credential_ref)) BETWEEN 1 AND 120
      AND system_managed = TRUE
    )
    OR (
      credential_source = 'vault'
      AND credential_ref IS NULL
      AND system_managed = FALSE
    )
  ),
  CONSTRAINT shipping_fulfillment_provider_connection_revision_chk
    CHECK (revision > 0),
  CONSTRAINT shipping_fulfillment_provider_connection_error_chk CHECK (
    (status = 'error' AND last_error_code IS NOT NULL AND last_error_message IS NOT NULL)
    OR (status <> 'error' AND last_error_code IS NULL AND last_error_message IS NULL)
  ),
  CONSTRAINT shipping_fulfillment_provider_connection_actor_chk CHECK (
    char_length(btrim(created_by)) BETWEEN 1 AND 120
    AND char_length(btrim(updated_by)) BETWEEN 1 AND 120
  )
);

CREATE UNIQUE INDEX shipping_fulfillment_provider_connection_id_provider_idx
  ON shipping.fulfillment_provider_connections(id, provider);

CREATE UNIQUE INDEX shipping_fulfillment_provider_connection_name_idx
  ON shipping.fulfillment_provider_connections(provider, lower(name));

CREATE TABLE shipping.fulfillment_provider_credentials (
  connection_id BIGINT PRIMARY KEY
    REFERENCES shipping.fulfillment_provider_connections(id) ON DELETE RESTRICT,
  key_id VARCHAR(120) NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  updated_by VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT shipping_fulfillment_provider_credential_payload_chk CHECK (
    char_length(btrim(key_id)) BETWEEN 1 AND 120
    AND char_length(btrim(ciphertext)) > 0
    AND char_length(btrim(iv)) > 0
    AND char_length(btrim(auth_tag)) > 0
    AND char_length(btrim(updated_by)) BETWEEN 1 AND 120
  )
);

CREATE TABLE shipping.fulfillment_provider_connection_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connection_id BIGINT NOT NULL
    REFERENCES shipping.fulfillment_provider_connections(id) ON DELETE RESTRICT,
  action VARCHAR(40) NOT NULL,
  connection_revision INTEGER NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  before_snapshot JSONB,
  after_snapshot JSONB NOT NULL,
  actor_user_id VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT shipping_fulfillment_provider_connection_event_action_chk
    CHECK (action IN (
      'created', 'credential_replaced', 'verified', 'verification_failed',
      'enabled', 'disabled'
    )),
  CONSTRAINT shipping_fulfillment_provider_connection_event_revision_chk
    CHECK (connection_revision > 0),
  CONSTRAINT shipping_fulfillment_provider_connection_event_idempotency_chk
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 16 AND 200),
  CONSTRAINT shipping_fulfillment_provider_connection_event_request_hash_chk
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shipping_fulfillment_provider_connection_event_snapshot_chk CHECK (
    (before_snapshot IS NULL OR jsonb_typeof(before_snapshot) = 'object')
    AND jsonb_typeof(after_snapshot) = 'object'
  ),
  CONSTRAINT shipping_fulfillment_provider_connection_event_actor_chk
    CHECK (char_length(btrim(actor_user_id)) BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX shipping_fulfillment_provider_connection_event_idempotency_idx
  ON shipping.fulfillment_provider_connection_events(idempotency_key);

CREATE UNIQUE INDEX shipping_fulfillment_provider_connection_event_revision_idx
  ON shipping.fulfillment_provider_connection_events(connection_id, connection_revision);

INSERT INTO shipping.fulfillment_provider_connections (
  provider,
  name,
  status,
  credential_source,
  credential_ref,
  system_managed,
  revision,
  last_verified_at,
  last_error_code,
  last_error_message,
  created_by,
  created_at,
  updated_by,
  updated_at
)
VALUES (
  'shipstation_v2',
  'ShipStation (deployment credential)',
  'active',
  'environment',
  'SHIPSTATION_V2_API_KEY',
  TRUE,
  1,
  NULL,
  NULL,
  NULL,
  'system:migration:0642',
  transaction_timestamp(),
  'system:migration:0642',
  transaction_timestamp()
)
ON CONFLICT DO NOTHING;

INSERT INTO shipping.fulfillment_provider_connection_events (
  connection_id,
  action,
  connection_revision,
  idempotency_key,
  request_hash,
  before_snapshot,
  after_snapshot,
  actor_user_id,
  created_at
)
SELECT connection.id,
       'created',
       1,
       'migration:0642:shipstation-environment',
       'd59075b11f38e7f60e8f4b0247ce87265e48feb711beee6d560b00cc5322cfc8',
       NULL,
       jsonb_build_object(
         'id', connection.id,
         'provider', connection.provider,
         'name', connection.name,
         'status', connection.status,
         'credentialSource', connection.credential_source,
         'credentialStored', FALSE,
         'systemManaged', connection.system_managed,
         'revision', connection.revision,
         'routedMethodCount', (
           SELECT count(*)
           FROM shipping.service_level_methods AS method
           WHERE method.provider = 'shipstation_v2'
             AND method.provider_account_id IS NOT NULL
             AND method.is_active = TRUE
         ),
         'lastVerifiedAt', NULL,
         'lastErrorCode', NULL,
         'lastErrorMessage', NULL
       ),
       'system:migration:0642',
       transaction_timestamp()
FROM shipping.fulfillment_provider_connections AS connection
WHERE connection.provider = 'shipstation_v2'
  AND connection.name = 'ShipStation (deployment credential)'
ON CONFLICT (idempotency_key) DO NOTHING;

ALTER TABLE shipping.service_level_methods
  ADD COLUMN provider_connection_id BIGINT,
  ALTER COLUMN provider TYPE VARCHAR(80);

UPDATE shipping.service_level_methods AS method
SET provider_connection_id = connection.id
FROM shipping.fulfillment_provider_connections AS connection
WHERE method.provider = 'shipstation_v2'
  AND method.provider_account_id IS NOT NULL
  AND connection.provider = 'shipstation_v2'
  AND connection.name = 'ShipStation (deployment credential)';

DROP INDEX shipping.shipping_level_method_identity_idx;
DROP INDEX shipping.shipping_level_method_priority_idx;

ALTER TABLE shipping.service_level_methods
  DROP CONSTRAINT shipping_level_method_provider_chk,
  DROP CONSTRAINT shipping_level_method_identity_chk;

CREATE UNIQUE INDEX shipping_level_method_identity_idx
  ON shipping.service_level_methods(
    service_level_id,
    provider_connection_id,
    provider_account_id,
    service_code
  );

CREATE UNIQUE INDEX shipping_level_method_priority_idx
  ON shipping.service_level_methods(service_level_id, priority)
  WHERE provider_connection_id IS NOT NULL;

ALTER TABLE shipping.service_level_methods
  ADD CONSTRAINT shipping_level_method_provider_connection_fk
    FOREIGN KEY (provider_connection_id, provider)
    REFERENCES shipping.fulfillment_provider_connections(id, provider)
    ON DELETE RESTRICT,
  ADD CONSTRAINT shipping_level_method_provider_chk CHECK (
    provider = 'legacy_unscoped'
    OR provider ~ '^[a-z][a-z0-9_]{1,79}$'
  ),
  ADD CONSTRAINT shipping_level_method_identity_chk CHECK (
    (
      provider = 'legacy_unscoped'
      AND provider_connection_id IS NULL
      AND provider_account_id IS NULL
      AND revision_id IS NULL
    )
    OR (
      provider <> 'legacy_unscoped'
      AND provider_connection_id IS NOT NULL
      AND provider_account_id IS NOT NULL
      AND provider_account_name IS NOT NULL
      AND carrier_name IS NOT NULL
      AND service_name IS NOT NULL
      AND char_length(btrim(carrier)) BETWEEN 1 AND 50
      AND char_length(btrim(service_code)) BETWEEN 1 AND 80
      AND char_length(btrim(provider_account_id)) BETWEEN 1 AND 120
      AND char_length(btrim(provider_account_name)) BETWEEN 1 AND 160
      AND char_length(btrim(carrier_name)) BETWEEN 1 AND 160
      AND char_length(btrim(service_name)) BETWEEN 1 AND 160
      AND revision_id IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION shipping.guard_fulfillment_provider_connection_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shipping.fulfillment_provider_connections cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.revision <> 1 THEN
    RAISE EXCEPTION 'a fulfillment provider connection must start at revision 1';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.credential_source IS DISTINCT FROM OLD.credential_source
    OR NEW.credential_ref IS DISTINCT FROM OLD.credential_ref
    OR NEW.system_managed IS DISTINCT FROM OLD.system_managed
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.revision <> OLD.revision + 1
  ) THEN
    RAISE EXCEPTION 'fulfillment provider connection identity is immutable and revision must increment by 1';
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.status = 'disabled'
     AND OLD.status <> 'disabled'
     AND EXISTS (
       SELECT 1
       FROM shipping.service_level_methods AS method
       WHERE method.provider_connection_id = OLD.id
         AND method.is_active = TRUE
     ) THEN
    RAISE EXCEPTION 'a fulfillment provider connection used by active routes cannot be disabled';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fulfillment_provider_connections_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON shipping.fulfillment_provider_connections
FOR EACH ROW EXECUTE FUNCTION shipping.guard_fulfillment_provider_connection_write();

CREATE OR REPLACE FUNCTION shipping.guard_fulfillment_provider_connection_event_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'shipping.fulfillment_provider_connection_events is append-only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fulfillment_provider_connection_events_append_only_guard
BEFORE UPDATE OR DELETE ON shipping.fulfillment_provider_connection_events
FOR EACH ROW EXECUTE FUNCTION shipping.guard_fulfillment_provider_connection_event_write();

CREATE OR REPLACE FUNCTION shipping.guard_fulfillment_provider_credential_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  source_kind TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shipping.fulfillment_provider_credentials cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'fulfillment provider credential identity is immutable';
  END IF;
  SELECT connection.credential_source
  INTO source_kind
  FROM shipping.fulfillment_provider_connections AS connection
  WHERE connection.id = NEW.connection_id;
  IF source_kind IS DISTINCT FROM 'vault' THEN
    RAISE EXCEPTION 'stored fulfillment credentials require a vault-backed connection';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fulfillment_provider_credentials_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON shipping.fulfillment_provider_credentials
FOR EACH ROW EXECUTE FUNCTION shipping.guard_fulfillment_provider_credential_write();

CREATE OR REPLACE FUNCTION shipping.check_fulfillment_routing_method_coherence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  checked_service_level_id INTEGER;
  revision_snapshot JSONB;
  current_snapshot JSONB;
  legacy_current_snapshot JSONB;
  snapshot_has_connection_identity BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    checked_service_level_id := OLD.service_level_id;
  ELSE
    checked_service_level_id := NEW.service_level_id;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM shipping.service_level_methods AS method
    LEFT JOIN shipping.fulfillment_routing_profiles AS profile
      ON profile.service_level_id = method.service_level_id
    WHERE method.service_level_id = checked_service_level_id
      AND method.provider_connection_id IS NOT NULL
      AND (
        profile.current_revision_id IS NULL
        OR method.revision_id IS DISTINCT FROM profile.current_revision_id
      )
  ) THEN
    RAISE EXCEPTION 'scoped fulfillment methods must belong to the profile current revision';
  END IF;

  SELECT revision.methods_snapshot,
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'providerConnectionId', method.provider_connection_id,
               'providerConnectionName', connection.name,
               'provider', method.provider,
               'providerAccountId', method.provider_account_id,
               'providerAccountName', method.provider_account_name,
               'carrierCode', method.carrier,
               'carrierName', method.carrier_name,
               'serviceCode', method.service_code,
               'serviceName', method.service_name,
               'domestic', method.domestic,
               'international', method.international,
               'priority', method.priority
             ) ORDER BY method.priority
           ) FILTER (WHERE method.id IS NOT NULL),
           '[]'::jsonb
         ),
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'provider', method.provider,
               'providerAccountId', method.provider_account_id,
               'providerAccountName', method.provider_account_name,
               'carrierCode', method.carrier,
               'carrierName', method.carrier_name,
               'serviceCode', method.service_code,
               'serviceName', method.service_name,
               'domestic', method.domestic,
               'international', method.international,
               'priority', method.priority
             ) ORDER BY method.priority
           ) FILTER (WHERE method.id IS NOT NULL),
           '[]'::jsonb
         )
  INTO revision_snapshot, current_snapshot, legacy_current_snapshot
  FROM shipping.fulfillment_routing_profiles AS profile
  JOIN shipping.fulfillment_routing_revisions AS revision
    ON revision.id = profile.current_revision_id
   AND revision.service_level_id = profile.service_level_id
   AND revision.revision = profile.revision
  LEFT JOIN shipping.service_level_methods AS method
    ON method.service_level_id = profile.service_level_id
   AND method.provider_connection_id IS NOT NULL
   AND method.is_active = TRUE
  LEFT JOIN shipping.fulfillment_provider_connections AS connection
    ON connection.id = method.provider_connection_id
  WHERE profile.service_level_id = checked_service_level_id
  GROUP BY revision.methods_snapshot;

  snapshot_has_connection_identity := COALESCE(
    jsonb_array_length(revision_snapshot) > 0
    AND (revision_snapshot -> 0) ? 'providerConnectionId',
    FALSE
  );
  IF revision_snapshot IS NOT NULL
     AND revision_snapshot IS DISTINCT FROM CASE
       WHEN snapshot_has_connection_identity THEN current_snapshot
       ELSE legacy_current_snapshot
     END THEN
    RAISE EXCEPTION 'current fulfillment methods must match the immutable revision snapshot';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON TABLE shipping.fulfillment_provider_connections IS
  'Provider-neutral fulfillment accounts available to shipping routing; credentials are referenced, never stored here.';
COMMENT ON TABLE shipping.fulfillment_provider_credentials IS
  'AES-256-GCM encrypted credentials for operator-managed fulfillment provider connections.';
COMMENT ON TABLE shipping.fulfillment_provider_connection_events IS
  'Append-only, idempotent audit history for fulfillment provider connection changes.';
COMMENT ON COLUMN shipping.service_level_methods.provider_connection_id IS
  'Exact fulfillment provider connection that owns this executable routing method.';
