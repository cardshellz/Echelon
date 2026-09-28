-- Shipping terms belong to one immutable return-policy version. A NULL row is
-- explicit unconfigured policy shipping; absence is reserved for historical
-- accepted returns that predate this migration.
CREATE TABLE returns.return_policy_shipping (
  policy_id INTEGER PRIMARY KEY REFERENCES returns.return_policies(id),
  configuration JSONB,
  warehouse_id INTEGER GENERATED ALWAYS AS ((configuration->>'warehouseId')::integer) STORED REFERENCES warehouse.warehouses(id),
  created_by VARCHAR(255) NOT NULL CHECK (btrim(created_by)<>''),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT return_policy_shipping_owner_chk CHECK (configuration IS NULL OR COALESCE(
    jsonb_typeof(configuration)='object'
    AND configuration->'policyId'=to_jsonb(policy_id)
    AND configuration->'version'=to_jsonb(policy_id)
    AND configuration ?& ARRAY['enabled','warehouseId','selectionMode','carrierRules','carrierId','serviceCode','destinationAddress','contactName','contactPhone']
    AND jsonb_typeof(configuration->'enabled')='boolean'
    AND jsonb_typeof(configuration->'warehouseId')='number'
    AND jsonb_typeof(configuration->'destinationAddress')='object'
    AND configuration->'destinationAddress'->>'countryCode'='US'
    AND jsonb_typeof(configuration->'carrierRules')='array'
    AND ((configuration->>'selectionMode'='fixed_service' AND jsonb_typeof(configuration->'carrierId')='string'
      AND jsonb_typeof(configuration->'serviceCode')='string' AND configuration->'carrierRules'='[]'::jsonb)
      OR (configuration->>'selectionMode'='cheapest_eligible' AND configuration->'carrierId'='null'::jsonb
        AND configuration->'serviceCode'='null'::jsonb AND jsonb_array_length(configuration->'carrierRules') BETWEEN 1 AND 100)),false))
);
CREATE TRIGGER return_policy_shipping_immutable BEFORE UPDATE OR DELETE ON returns.return_policy_shipping
FOR EACH ROW EXECUTE FUNCTION returns.reject_customer_return_authorization_evidence_mutation();

-- Emergency pause is mutable independently of immutable policy terms, including
-- labels for previously accepted returns. Missing row means unpaused/version 0.
CREATE TABLE returns.customer_return_label_controls (
  channel_id INTEGER PRIMARY KEY REFERENCES channels.channels(id),
  version INTEGER NOT NULL CHECK (version>0),
  paused BOOLEAN NOT NULL,
  updated_by VARCHAR(255) NOT NULL CHECK (btrim(updated_by)<>''),
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE returns.customer_return_label_control_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels.channels(id),
  version INTEGER NOT NULL CHECK (version>0),
  actor VARCHAR(255) NOT NULL CHECK (btrim(actor)<>''),
  before_snapshot JSONB,
  after_snapshot JSONB NOT NULL CHECK (jsonb_typeof(after_snapshot)='object'),
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE(channel_id,version)
);
CREATE TRIGGER customer_return_label_control_events_immutable BEFORE UPDATE OR DELETE ON returns.customer_return_label_control_events
FOR EACH ROW EXECUTE FUNCTION returns.reject_customer_return_authorization_evidence_mutation();

-- Explicit conversion provenance: never repoint or rewrite old RMA, quote,
-- parcel, attempt or channel-settings evidence. Unresolved channels stay visible.
CREATE TABLE returns.return_policy_shipping_migrations (
  channel_id INTEGER PRIMARY KEY REFERENCES channels.channels(id),
  source_settings_version INTEGER NOT NULL CHECK (source_settings_version>0),
  source_settings_snapshot JSONB NOT NULL CHECK (jsonb_typeof(source_settings_snapshot)='object'),
  resolved_policy_id INTEGER REFERENCES returns.return_policies(id),
  new_policy_id INTEGER UNIQUE REFERENCES returns.return_policies(id),
  outcome VARCHAR(30) NOT NULL CHECK (outcome IN ('migrated','no_active_policy','ambiguous_policy','invalid_policy_scope')),
  actor VARCHAR(255) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CHECK ((outcome='migrated')=(new_policy_id IS NOT NULL))
);
CREATE TRIGGER return_policy_shipping_migrations_immutable BEFORE UPDATE OR DELETE ON returns.return_policy_shipping_migrations
FOR EACH ROW EXECUTE FUNCTION returns.reject_customer_return_authorization_evidence_mutation();

DO $$
DECLARE
  legacy returns.customer_return_settings%ROWTYPE;
  effective returns.return_policies%ROWTYPE;
  prior_channel returns.return_policies%ROWTYPE;
  channel_scope TEXT;
  next_version INTEGER;
  new_policy INTEGER;
  top_rank INTEGER;
  winner_count INTEGER;
  snapshot JSONB;
  migration_actor CONSTANT TEXT := 'migration:255_return_policy_shipping';
  migrated_at CONSTANT TIMESTAMPTZ := transaction_timestamp();
BEGIN
  PERFORM pg_advisory_xact_lock(918421,1);
  -- Drain old-release DML before capturing configuration, and keep subsequent
  -- writers blocked until the legacy write fence becomes visible at commit.
  LOCK TABLE returns.customer_return_settings IN SHARE ROW EXCLUSIVE MODE;
  FOR legacy IN SELECT * FROM returns.customer_return_settings ORDER BY channel_id FOR UPDATE LOOP
    INSERT INTO returns.customer_return_label_controls(channel_id,version,paused,updated_by,updated_at)
      VALUES(legacy.channel_id,1,NOT legacy.enabled,migration_actor,migrated_at);
    INSERT INTO returns.customer_return_label_control_events(channel_id,version,actor,before_snapshot,after_snapshot,occurred_at)
      VALUES(legacy.channel_id,1,migration_actor,NULL,jsonb_build_object('paused',NOT legacy.enabled,'version',1),migrated_at);

    -- These are the same supported retail resolution scopes and ranks as the
    -- canonical resolver. Operational compatibility is deliberately not filtered.
    IF EXISTS(SELECT 1 FROM returns.return_policies p WHERE p.status='active'
      AND (p.scope_kind='global' OR (p.scope_kind='business_context' AND p.business_context='retail')
        OR (p.scope_kind='channel_context' AND p.business_context='retail' AND p.channel_id=legacy.channel_id))
      AND p.scope_key IS DISTINCT FROM CASE p.scope_kind WHEN 'global' THEN 'global'
        WHEN 'business_context' THEN 'context:retail' ELSE 'context:retail:channel:' || legacy.channel_id END) THEN
      INSERT INTO returns.return_policy_shipping_migrations(channel_id,source_settings_version,source_settings_snapshot,outcome,actor,occurred_at)
        VALUES(legacy.channel_id,legacy.version,to_jsonb(legacy),'invalid_policy_scope',migration_actor,migrated_at);
      CONTINUE;
    END IF;
    SELECT MAX(CASE scope_kind WHEN 'channel_context' THEN 300 WHEN 'business_context' THEN 200 WHEN 'global' THEN 100 END)
      INTO top_rank FROM returns.return_policies
      WHERE status='active' AND ((scope_kind='global') OR (scope_kind='business_context' AND business_context='retail')
        OR (scope_kind='channel_context' AND business_context='retail' AND channel_id=legacy.channel_id));
    IF top_rank IS NULL THEN
      INSERT INTO returns.return_policy_shipping_migrations(channel_id,source_settings_version,source_settings_snapshot,outcome,actor,occurred_at)
        VALUES(legacy.channel_id,legacy.version,to_jsonb(legacy),'no_active_policy',migration_actor,migrated_at);
      CONTINUE;
    END IF;
    SELECT COUNT(*) INTO winner_count FROM returns.return_policies
      WHERE status='active' AND CASE scope_kind
        WHEN 'global' THEN 100=top_rank
        WHEN 'business_context' THEN business_context='retail' AND 200=top_rank
        WHEN 'channel_context' THEN business_context='retail' AND channel_id=legacy.channel_id AND 300=top_rank
        ELSE false END;
    IF winner_count<>1 THEN
      INSERT INTO returns.return_policy_shipping_migrations(channel_id,source_settings_version,source_settings_snapshot,outcome,actor,occurred_at)
        VALUES(legacy.channel_id,legacy.version,to_jsonb(legacy),'ambiguous_policy',migration_actor,migrated_at);
      CONTINUE;
    END IF;
    SELECT * INTO STRICT effective FROM returns.return_policies
      WHERE status='active' AND CASE scope_kind
        WHEN 'global' THEN 100=top_rank
        WHEN 'business_context' THEN business_context='retail' AND 200=top_rank
        WHEN 'channel_context' THEN business_context='retail' AND channel_id=legacy.channel_id AND 300=top_rank
        ELSE false END;
    channel_scope := 'context:retail:channel:' || legacy.channel_id;
    SELECT * INTO prior_channel FROM returns.return_policies WHERE status='active' AND scope_key=channel_scope;
    SELECT COALESCE(MAX(version),0)+1 INTO next_version FROM returns.return_policies WHERE scope_key=channel_scope;
    IF prior_channel.id IS NOT NULL THEN
      UPDATE returns.return_policies SET status='retired',retired_by=migration_actor,retired_at=migrated_at WHERE id=prior_channel.id;
    END IF;
    -- Preserve existing per-channel settings with channel-specific versions.
    -- Separately configured channels keep different shipping terms. Broad fallback rules
    -- remain unchanged; future edits to those fallbacks do not override these
    -- explicit channel versions unless they are subsequently archived.
    INSERT INTO returns.return_policies(name,scope_kind,scope_key,business_context,channel_id,vendor_id,store_connection_id,
      version,status,return_window_days,return_destination,approval_authority,label_provider,return_shipping_payer,
      inspection_requirement,inspection_owner,customer_refund_authority,vendor_settlement_trigger,returnless_refund_allowed,
      notes,supersedes_policy_id,created_by,created_at)
    VALUES(effective.name,'channel_context',channel_scope,'retail',legacy.channel_id,NULL,NULL,next_version,'active',
      effective.return_window_days,effective.return_destination,effective.approval_authority,effective.label_provider,effective.return_shipping_payer,
      effective.inspection_requirement,effective.inspection_owner,effective.customer_refund_authority,effective.vendor_settlement_trigger,
      effective.returnless_refund_allowed,effective.notes,prior_channel.id,migration_actor,migrated_at) RETURNING id INTO new_policy;
    snapshot := jsonb_build_object('version',new_policy,'policyId',new_policy,'enabled',legacy.enabled,'warehouseId',legacy.warehouse_id,
      'selectionMode',legacy.selection_mode,'carrierRules',legacy.carrier_rules,'carrierId',legacy.carrier_id,'serviceCode',legacy.service_code,
      'destinationAddress',legacy.destination_address,'contactName',legacy.contact_name,'contactPhone',legacy.contact_phone);
    INSERT INTO returns.return_policy_shipping(policy_id,configuration,created_by,created_at)
      VALUES(new_policy,snapshot,migration_actor,migrated_at);
    INSERT INTO returns.return_policy_shipping_migrations(channel_id,source_settings_version,source_settings_snapshot,resolved_policy_id,
      new_policy_id,outcome,actor,occurred_at)
      VALUES(legacy.channel_id,legacy.version,to_jsonb(legacy),effective.id,new_policy,'migrated',migration_actor,migrated_at);
  END LOOP;
END $$;

-- Historical configuration remains readable, but an old application release
-- must not report a successful save into the retired configuration authority.
CREATE FUNCTION returns.reject_legacy_customer_return_settings_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'Return shipping settings moved to Returns > Policies. Refresh the application before saving.',
    DETAIL = 'RETURN_LABEL_SETTINGS_MOVED',
    HINT = 'Edit Return shipping in the applied policy; use the private portal Pause / Resume control for label purchases.';
END;
$$;
CREATE TRIGGER customer_return_settings_legacy_write_fence
BEFORE INSERT OR UPDATE OR DELETE ON returns.customer_return_settings
FOR EACH STATEMENT EXECUTE FUNCTION returns.reject_legacy_customer_return_settings_write();
