-- Generic fulfillment-routing authority for Card Shellz-owned service levels.
-- This migration does not alter checkout pricing, activate a service level,
-- change label purchasing, or wire any marketplace/dropship consumer.

CREATE TABLE shipping.fulfillment_routing_revisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_level_id INTEGER NOT NULL
    REFERENCES shipping.service_levels(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  catalog_hash VARCHAR(64) NOT NULL,
  catalog_fetched_at TIMESTAMPTZ NOT NULL,
  supersedes_revision_id BIGINT,
  methods_snapshot JSONB NOT NULL,
  actor_user_id VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT shipping_fulfillment_routing_revision_version_uq
    UNIQUE (service_level_id, revision),
  CONSTRAINT shipping_fulfillment_routing_revision_id_scope_uq
    UNIQUE (id, service_level_id),
  CONSTRAINT shipping_fulfillment_routing_revision_head_uq
    UNIQUE (id, service_level_id, revision),
  CONSTRAINT shipping_fulfillment_routing_revision_idempotency_uq
    UNIQUE (service_level_id, idempotency_key),
  CONSTRAINT shipping_fulfillment_routing_revision_supersedes_fk
    FOREIGN KEY (supersedes_revision_id, service_level_id)
    REFERENCES shipping.fulfillment_routing_revisions(id, service_level_id)
    ON DELETE RESTRICT,
  CONSTRAINT shipping_fulfillment_routing_revision_positive_chk
    CHECK (revision > 0),
  CONSTRAINT shipping_fulfillment_routing_revision_request_hash_chk
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shipping_fulfillment_routing_revision_catalog_hash_chk
    CHECK (catalog_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shipping_fulfillment_routing_revision_idempotency_chk
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 16 AND 200),
  CONSTRAINT shipping_fulfillment_routing_revision_actor_chk
    CHECK (char_length(btrim(actor_user_id)) BETWEEN 1 AND 120),
  CONSTRAINT shipping_fulfillment_routing_revision_snapshot_chk
    CHECK (jsonb_typeof(methods_snapshot) = 'array'),
  CONSTRAINT shipping_fulfillment_routing_revision_chain_chk CHECK (
    (revision = 1 AND supersedes_revision_id IS NULL)
    OR (revision > 1 AND supersedes_revision_id IS NOT NULL)
  )
);

CREATE TABLE shipping.fulfillment_routing_profiles (
  service_level_id INTEGER PRIMARY KEY
    REFERENCES shipping.service_levels(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 0,
  current_revision_id BIGINT,
  updated_by VARCHAR(120),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT shipping_fulfillment_routing_profile_revision_chk
    CHECK (revision >= 0),
  CONSTRAINT shipping_fulfillment_routing_profile_state_chk CHECK (
    (revision = 0 AND current_revision_id IS NULL AND updated_by IS NULL)
    OR (
      revision > 0
      AND current_revision_id IS NOT NULL
      AND updated_by IS NOT NULL
      AND char_length(btrim(updated_by)) BETWEEN 1 AND 120
    )
  ),
  CONSTRAINT shipping_fulfillment_routing_profile_current_revision_fk
    FOREIGN KEY (current_revision_id, service_level_id, revision)
    REFERENCES shipping.fulfillment_routing_revisions(id, service_level_id, revision)
    ON DELETE RESTRICT
);

ALTER TABLE shipping.service_level_methods
  ADD COLUMN provider VARCHAR(40) NOT NULL DEFAULT 'legacy_unscoped',
  ADD COLUMN provider_account_id VARCHAR(120),
  ADD COLUMN provider_account_name VARCHAR(160),
  ADD COLUMN carrier_name VARCHAR(160),
  ADD COLUMN service_name VARCHAR(160),
  ADD COLUMN priority INTEGER,
  ADD COLUMN domestic BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN international BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN revision_id BIGINT,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp();

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY service_level_id ORDER BY id)::INTEGER AS priority
  FROM shipping.service_level_methods
)
UPDATE shipping.service_level_methods AS method
SET priority = ranked.priority,
    carrier_name = method.carrier,
    service_name = method.service_code,
    updated_at = method.created_at
FROM ranked
WHERE ranked.id = method.id;

ALTER TABLE shipping.service_level_methods
  ALTER COLUMN priority SET NOT NULL,
  ALTER COLUMN priority DROP DEFAULT,
  ALTER COLUMN provider DROP DEFAULT;

DROP INDEX IF EXISTS shipping.shipping_level_method_idx;

CREATE UNIQUE INDEX shipping_level_method_identity_idx
  ON shipping.service_level_methods(
    service_level_id, provider, provider_account_id, service_code
  );

CREATE UNIQUE INDEX shipping_level_method_priority_idx
  ON shipping.service_level_methods(service_level_id, priority)
  WHERE provider_account_id IS NOT NULL;

ALTER TABLE shipping.service_level_methods
  ADD CONSTRAINT shipping_level_method_revision_fk
    FOREIGN KEY (revision_id, service_level_id)
    REFERENCES shipping.fulfillment_routing_revisions(id, service_level_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT shipping_level_method_provider_chk
    CHECK (provider IN ('legacy_unscoped', 'shipstation_v2')),
  ADD CONSTRAINT shipping_level_method_priority_chk
    CHECK (priority > 0),
  ADD CONSTRAINT shipping_level_method_identity_chk CHECK (
    (
      provider = 'legacy_unscoped'
      AND provider_account_id IS NULL
      AND revision_id IS NULL
    )
    OR (
      provider = 'shipstation_v2'
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

CREATE OR REPLACE FUNCTION shipping.guard_fulfillment_routing_revision_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  previous_revision INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision = 1 THEN
      RETURN NEW;
    END IF;
    SELECT revision
    INTO previous_revision
    FROM shipping.fulfillment_routing_revisions
    WHERE id = NEW.supersedes_revision_id
      AND service_level_id = NEW.service_level_id;
    IF previous_revision IS DISTINCT FROM NEW.revision - 1 THEN
      RAISE EXCEPTION 'fulfillment routing revision must supersede the immediately preceding revision';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'shipping.fulfillment_routing_revisions is append-only';
END;
$$;

CREATE TRIGGER fulfillment_routing_revisions_append_only_guard
BEFORE INSERT OR UPDATE OR DELETE ON shipping.fulfillment_routing_revisions
FOR EACH ROW EXECUTE FUNCTION shipping.guard_fulfillment_routing_revision_write();

CREATE OR REPLACE FUNCTION shipping.guard_fulfillment_routing_profile_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shipping.fulfillment_routing_profiles cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.revision <> 0 THEN
    RAISE EXCEPTION 'a new fulfillment routing profile must start at revision 0';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.service_level_id IS DISTINCT FROM OLD.service_level_id
    OR NEW.revision <> OLD.revision + 1
  ) THEN
    RAISE EXCEPTION 'fulfillment routing profile identity is immutable and revision must increment by 1';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fulfillment_routing_profiles_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON shipping.fulfillment_routing_profiles
FOR EACH ROW EXECUTE FUNCTION shipping.guard_fulfillment_routing_profile_write();

CREATE OR REPLACE FUNCTION shipping.check_fulfillment_routing_method_coherence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  checked_service_level_id INTEGER;
  revision_snapshot JSONB;
  current_snapshot JSONB;
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
      AND method.provider_account_id IS NOT NULL
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
  INTO revision_snapshot, current_snapshot
  FROM shipping.fulfillment_routing_profiles AS profile
  JOIN shipping.fulfillment_routing_revisions AS revision
    ON revision.id = profile.current_revision_id
   AND revision.service_level_id = profile.service_level_id
   AND revision.revision = profile.revision
  LEFT JOIN shipping.service_level_methods AS method
    ON method.service_level_id = profile.service_level_id
   AND method.provider_account_id IS NOT NULL
   AND method.is_active = TRUE
  WHERE profile.service_level_id = checked_service_level_id
  GROUP BY revision.methods_snapshot;

  IF revision_snapshot IS NOT NULL
     AND revision_snapshot IS DISTINCT FROM current_snapshot THEN
    RAISE EXCEPTION 'current fulfillment methods must match the immutable revision snapshot';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER fulfillment_routing_methods_coherence_guard
AFTER INSERT OR UPDATE OR DELETE ON shipping.service_level_methods
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION shipping.check_fulfillment_routing_method_coherence();

CREATE CONSTRAINT TRIGGER fulfillment_routing_profiles_coherence_guard
AFTER INSERT OR UPDATE ON shipping.fulfillment_routing_profiles
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION shipping.check_fulfillment_routing_method_coherence();

COMMENT ON TABLE shipping.fulfillment_routing_profiles IS
  'Optimistic-locking heads for ordered provider methods allowed to fulfill each Card Shellz service level.';
COMMENT ON TABLE shipping.fulfillment_routing_revisions IS
  'Immutable, idempotent audit snapshots for fulfillment-routing profile replacements.';
COMMENT ON TABLE shipping.service_level_methods IS
  'Current exact provider-account methods allowed for a service level; legacy unscoped rows are preserved but are not executable routes.';
