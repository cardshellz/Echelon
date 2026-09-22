-- Migration 0695: preserve forecast identity independently of a removable live catalog row.
-- No product, supplier, PO, count, observation or evaluation is changed/deleted.
-- The migration runner wraps this file in one transaction with bounded locks.
LOCK TABLE catalog.products IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE procurement.purchase_forecast_observations IN ACCESS EXCLUSIVE MODE;

CREATE TABLE catalog.forecast_product_identities (
  product_id integer PRIMARY KEY CHECK (product_id > 0),
  catalog_snapshot jsonb NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT forecast_product_identity_snapshot_chk CHECK (
    (jsonb_typeof(catalog_snapshot) = 'object' AND catalog_snapshot->'id' = to_jsonb(product_id)) IS TRUE
  )
);

INSERT INTO catalog.forecast_product_identities(product_id,catalog_snapshot)
SELECT p.id,to_jsonb(p) FROM catalog.products p
WHERE EXISTS (SELECT 1 FROM procurement.purchase_forecast_observations o WHERE o.product_id=p.id);

CREATE TABLE catalog.product_cleanup_receipts (
  command_key text PRIMARY KEY CHECK (length(btrim(command_key)) BETWEEN 1 AND 160),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  expected_hash varchar(64) NOT NULL CHECK (expected_hash ~ '^[a-f0-9]{64}$'),
  source_product_id integer NOT NULL UNIQUE REFERENCES catalog.forecast_product_identities(product_id) ON DELETE RESTRICT,
  target_product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  actor_id varchar(100) NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  database_actor text NOT NULL DEFAULT current_user,
  owner_transaction_id text NOT NULL DEFAULT pg_current_xact_id()::text,
  approval text NOT NULL CHECK (length(btrim(approval)) BETWEEN 10 AND 1000),
  occurred_at timestamptz NOT NULL,
  before_state jsonb NOT NULL CHECK (jsonb_typeof(before_state)='object'),
  after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state)='object'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  audit_event_id bigint NOT NULL REFERENCES public.audit_events(id) ON DELETE RESTRICT,
  CONSTRAINT product_cleanup_distinct_identities_chk CHECK (source_product_id <> target_product_id),
  CONSTRAINT product_cleanup_source_snapshot_chk CHECK ((before_state->'sourceProduct'->'id'=to_jsonb(source_product_id)) IS TRUE),
  CONSTRAINT product_cleanup_removed_source_chk CHECK ((after_state->'sourceProduct'='null'::jsonb) IS TRUE)
);
REVOKE ALL ON catalog.forecast_product_identities,catalog.product_cleanup_receipts FROM PUBLIC;

CREATE FUNCTION catalog.guard_cleanup_history_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CATALOG_CLEANUP_HISTORY_IMMUTABLE';
END $$;
CREATE TRIGGER forecast_identity_immutable BEFORE UPDATE OR DELETE ON catalog.forecast_product_identities
  FOR EACH ROW EXECUTE FUNCTION catalog.guard_cleanup_history_immutable();
CREATE TRIGGER forecast_identity_no_truncate BEFORE TRUNCATE ON catalog.forecast_product_identities
  FOR EACH STATEMENT EXECUTE FUNCTION catalog.guard_cleanup_history_immutable();
CREATE TRIGGER product_cleanup_receipt_immutable BEFORE UPDATE OR DELETE ON catalog.product_cleanup_receipts
  FOR EACH ROW EXECUTE FUNCTION catalog.guard_cleanup_history_immutable();
CREATE TRIGGER product_cleanup_receipt_no_truncate BEFORE TRUNCATE ON catalog.product_cleanup_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION catalog.guard_cleanup_history_immutable();

CREATE FUNCTION catalog.guard_forecast_identity_registration()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE original jsonb;
BEGIN
  SELECT to_jsonb(p) INTO original FROM catalog.products p WHERE p.id=NEW.product_id FOR KEY SHARE;
  IF original IS NULL OR original IS DISTINCT FROM NEW.catalog_snapshot THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='FORECAST_IDENTITY_REQUIRES_EXACT_CURRENT_PRODUCT';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER forecast_identity_registration BEFORE INSERT ON catalog.forecast_product_identities
  FOR EACH ROW EXECUTE FUNCTION catalog.guard_forecast_identity_registration();

-- The restricted trigger function permits an INSERT-only forecast writer to
-- register history without giving it direct access to either history table.
CREATE FUNCTION procurement.register_current_forecast_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE original jsonb;
BEGIN
  SELECT to_jsonb(p) INTO original FROM catalog.products p WHERE p.id=NEW.product_id FOR KEY SHARE;
  IF original IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='FORECAST_REQUIRES_CURRENT_CATALOG_PRODUCT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM catalog.forecast_product_identities WHERE product_id=NEW.product_id) THEN
    INSERT INTO catalog.forecast_product_identities(product_id,catalog_snapshot)
      VALUES(NEW.product_id,original) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION procurement.register_current_forecast_identity() FROM PUBLIC;
CREATE TRIGGER forecast_register_identity BEFORE INSERT ON procurement.purchase_forecast_observations
  FOR EACH ROW EXECUTE FUNCTION procurement.register_current_forecast_identity();

ALTER TABLE procurement.purchase_forecast_observations
  DROP CONSTRAINT purchase_forecast_observations_product_id_fkey;
ALTER TABLE procurement.purchase_forecast_observations
  ADD CONSTRAINT purchase_forecast_observations_product_id_fkey FOREIGN KEY(product_id)
    REFERENCES catalog.forecast_product_identities(product_id) ON DELETE RESTRICT;

CREATE FUNCTION catalog.guard_product_cleanup_receipt()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE original jsonb; permitted boolean;
BEGIN
  -- Administrative CLI only. A general app role cannot manufacture a receipt
  -- merely by acquiring INSERT via default privileges. The DB owner remains a
  -- trusted administrator, as it already can ALTER/DROP all database guards.
  IF current_user <> (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
     OR NEW.database_actor IS DISTINCT FROM current_user
     OR NEW.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()::text
     OR current_setting('transaction_isolation') <> 'serializable'
     OR current_setting('transaction_read_only') <> 'off' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='CATALOG_CLEANUP_ADMIN_TRANSACTION_REQUIRED';
  END IF;
  -- Lock all grant sources used for this decision, so account deactivation or
  -- a permission revocation cannot race a successful commit. No legacy role-name bypass.
  SELECT true INTO permitted FROM identity.users u
    JOIN identity.auth_user_roles ur ON ur.user_id=u.id
    JOIN identity.auth_roles r ON r.id=ur.role_id
    JOIN identity.auth_role_permissions rp ON rp.role_id=r.id
    JOIN identity.auth_permissions p ON p.id=rp.permission_id
    WHERE u.id=NEW.actor_id AND u.active=1 AND p.resource='inventory' AND p.action='delete'
      AND (rp.constraints IS NULL OR rp.constraints='{}'::jsonb)
    LIMIT 1 FOR SHARE OF u,ur,r,rp,p;
  IF permitted IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='CATALOG_CLEANUP_INVENTORY_DELETE_PERMISSION_REQUIRED';
  END IF;
  SELECT to_jsonb(p) INTO original FROM catalog.products p WHERE p.id=NEW.source_product_id FOR UPDATE;
  IF original IS NULL OR original IS DISTINCT FROM NEW.before_state->'sourceProduct' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CATALOG_CLEANUP_SOURCE_CHANGED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_events a WHERE a.id=NEW.audit_event_id
    AND a.actor=NEW.actor_id AND a.action='catalog.product_identity_removed'
    AND a.target='product:'||NEW.source_product_id::text
    AND a.timestamp=NEW.occurred_at AND a.context->>'requestHash'=NEW.request_hash) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CATALOG_CLEANUP_AUDIT_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_cleanup_receipt_admission BEFORE INSERT ON catalog.product_cleanup_receipts
  FOR EACH ROW EXECUTE FUNCTION catalog.guard_product_cleanup_receipt();

CREATE FUNCTION catalog.guard_product_history_removal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CATALOG_PRODUCT_HISTORY_TRUNCATE_FORBIDDEN';
  END IF;
  IF EXISTS (SELECT 1 FROM catalog.forecast_product_identities WHERE product_id=OLD.id)
    AND NOT EXISTS (SELECT 1 FROM catalog.product_cleanup_receipts r
      WHERE r.source_product_id=OLD.id AND r.owner_transaction_id=pg_current_xact_id()::text
        AND r.before_state->'sourceProduct'=to_jsonb(OLD)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CATALOG_PRODUCT_REQUIRES_CLEANUP_RECEIPT';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION catalog.guard_product_history_removal() FROM PUBLIC;
CREATE TRIGGER product_history_removal BEFORE DELETE ON catalog.products
  FOR EACH ROW EXECUTE FUNCTION catalog.guard_product_history_removal();
CREATE TRIGGER product_history_no_truncate BEFORE TRUNCATE ON catalog.products
  FOR EACH STATEMENT EXECUTE FUNCTION catalog.guard_product_history_removal();

CREATE FUNCTION catalog.guard_retired_product_id_reuse()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM catalog.forecast_product_identities WHERE product_id=NEW.id)
    AND NOT EXISTS(SELECT 1 FROM catalog.products WHERE id=NEW.id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CATALOG_HISTORICAL_PRODUCT_ID_REUSE';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION catalog.guard_retired_product_id_reuse() FROM PUBLIC;
CREATE TRIGGER retired_product_id_reuse BEFORE INSERT ON catalog.products
  FOR EACH ROW EXECUTE FUNCTION catalog.guard_retired_product_id_reuse();

-- An authorization receipt cannot commit on its own and authorize a later
-- delete. Receipt, audit and deletion are one atomic, non-reusable fact.
CREATE FUNCTION catalog.require_completed_product_cleanup()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM catalog.products WHERE id=NEW.source_product_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CATALOG_CLEANUP_NOT_COMPLETED';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER product_cleanup_completion AFTER INSERT ON catalog.product_cleanup_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.require_completed_product_cleanup();

COMMENT ON TABLE catalog.forecast_product_identities IS
  'Immutable catalog identity captured at registration, not a live product or inventory balance. Observation snapshots retain their original run-time facts.';
COMMENT ON TABLE catalog.product_cleanup_receipts IS
  'Non-expiring operator-approved cleanup receipt; original rows and exact before/after evidence survive live catalog removal.';
