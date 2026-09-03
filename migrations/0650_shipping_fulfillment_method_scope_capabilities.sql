BEGIN;

ALTER TABLE shipping.service_level_methods
  ADD COLUMN provider_capabilities JSONB;

DROP INDEX shipping.shipping_level_method_identity_idx;

CREATE UNIQUE INDEX shipping_level_method_identity_idx
  ON shipping.service_level_methods(
    service_level_id,
    provider_connection_id,
    provider_account_id,
    service_code,
    domestic,
    international
  );

-- Existing scoped routes predate provider capability snapshots. The scope
-- constraint can remain NOT VALID because destination flags already existed.
-- Capability presence needs a write guard instead: PostgreSQL applies a NOT
-- VALID check constraint to later UPDATEs, including no-op lifecycle updates on
-- historical rows whose capability snapshot is intentionally unknown.
ALTER TABLE shipping.service_level_methods
  ADD CONSTRAINT shipping_level_method_scope_chk CHECK (
    provider = 'legacy_unscoped' OR domestic OR international
  ) NOT VALID,
  ADD CONSTRAINT shipping_level_method_capabilities_chk CHECK (
    provider_capabilities IS NULL
    OR CASE
      WHEN jsonb_typeof(provider_capabilities) = 'object' THEN
        jsonb_typeof(provider_capabilities -> 'supportsMultiPackage') IS NOT DISTINCT FROM 'boolean'
        AND jsonb_typeof(provider_capabilities -> 'supportsReturns') IS NOT DISTINCT FROM 'boolean'
        AND jsonb_typeof(provider_capabilities -> 'supportsPrepaidDutiesTaxes') IS NOT DISTINCT FROM 'boolean'
        AND jsonb_typeof(provider_capabilities -> 'sendRates') IS NOT DISTINCT FROM 'boolean'
        AND CASE
          WHEN jsonb_typeof(provider_capabilities -> 'displaySchemes') = 'array'
            THEN jsonb_array_length(provider_capabilities -> 'displaySchemes') <= 20
          ELSE FALSE
        END
      ELSE FALSE
    END
  );

CREATE OR REPLACE FUNCTION shipping.guard_fulfillment_method_capabilities_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.provider = 'legacy_unscoped' THEN
    RETURN NEW;
  END IF;

  -- A historical scoped row may remain capability-unknown while it is left
  -- unchanged or deactivated. It cannot be repurposed or reactivated to bypass
  -- the capability requirement. A capability backfill is allowed by this same
  -- path as long as the route identity and immutable descriptor stay unchanged.
  IF TG_OP = 'UPDATE'
     AND OLD.provider <> 'legacy_unscoped'
     AND OLD.provider_capabilities IS NULL THEN
    IF ROW(
         NEW.id,
         NEW.service_level_id,
         NEW.provider_connection_id,
         NEW.provider,
         NEW.provider_account_id,
         NEW.provider_account_name,
         NEW.carrier,
         NEW.carrier_name,
         NEW.service_code,
         NEW.service_name,
         NEW.priority,
         NEW.domestic,
         NEW.international,
         NEW.revision_id,
         NEW.created_at
       ) IS NOT DISTINCT FROM ROW(
         OLD.id,
         OLD.service_level_id,
         OLD.provider_connection_id,
         OLD.provider,
         OLD.provider_account_id,
         OLD.provider_account_name,
         OLD.carrier,
         OLD.carrier_name,
         OLD.service_code,
         OLD.service_name,
         OLD.priority,
         OLD.domestic,
         OLD.international,
         OLD.revision_id,
         OLD.created_at
       )
       AND (OLD.is_active OR NOT NEW.is_active) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'historical fulfillment method without provider capabilities cannot be repurposed or reactivated',
      SCHEMA = TG_TABLE_SCHEMA,
      TABLE = TG_TABLE_NAME,
      CONSTRAINT = 'shipping_level_method_scoped_capabilities_chk';
  END IF;

  IF NEW.provider_capabilities IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'scoped fulfillment methods require provider capabilities',
    SCHEMA = TG_TABLE_SCHEMA,
    TABLE = TG_TABLE_NAME,
    CONSTRAINT = 'shipping_level_method_scoped_capabilities_chk';
END;
$$;

CREATE TRIGGER fulfillment_method_capabilities_write_guard
BEFORE INSERT OR UPDATE ON shipping.service_level_methods
FOR EACH ROW EXECUTE FUNCTION shipping.guard_fulfillment_method_capabilities_write();

CREATE OR REPLACE FUNCTION shipping.check_fulfillment_routing_method_coherence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  checked_service_level_id INTEGER;
  revision_snapshot JSONB;
  current_snapshot JSONB;
  current_snapshot_without_capabilities JSONB;
  legacy_current_snapshot JSONB;
  snapshot_has_connection_identity BOOLEAN;
  snapshot_has_capabilities BOOLEAN;
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
               'capabilities', method.provider_capabilities,
               'priority', method.priority
             ) ORDER BY method.priority
           ) FILTER (WHERE method.id IS NOT NULL),
           '[]'::jsonb
         ),
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
  INTO revision_snapshot,
       current_snapshot,
       current_snapshot_without_capabilities,
       legacy_current_snapshot
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
  snapshot_has_capabilities := COALESCE(
    jsonb_array_length(revision_snapshot) > 0
    AND (revision_snapshot -> 0) ? 'capabilities',
    FALSE
  );
  IF revision_snapshot IS NOT NULL
     AND revision_snapshot IS DISTINCT FROM (
       CASE
         WHEN snapshot_has_connection_identity AND snapshot_has_capabilities
           THEN current_snapshot
         WHEN snapshot_has_connection_identity
           THEN current_snapshot_without_capabilities
         ELSE legacy_current_snapshot
       END
     ) THEN
    RAISE EXCEPTION 'current fulfillment methods must match the immutable revision snapshot';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON COLUMN shipping.service_level_methods.provider_capabilities IS
  'Selection-time provider capability snapshot for this exact account, service code, and destination-scope variant.';

COMMIT;
