-- Distinct zero-only item-setup ownership; this never invents an outbox plan.
DO $$ DECLARE constraint_name text; BEGIN
  FOR constraint_name IN SELECT conname FROM pg_constraint
    WHERE conrelid='inventory.quantity_publication_attempts'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%owner_kind%'
      AND pg_get_constraintdef(oid) NOT LIKE '%outbox_id%'
  LOOP EXECUTE format('ALTER TABLE inventory.quantity_publication_attempts DROP CONSTRAINT %I',constraint_name); END LOOP;
END $$;
ALTER TABLE inventory.quantity_publication_attempts ADD CONSTRAINT quantity_publication_attempts_owner_kind_chk
  CHECK(owner_kind IN ('legacy','outbox','listing_setup_zero'));
ALTER TABLE inventory.quantity_publication_attempts ADD COLUMN listing_setup_operation_id varchar(120),
  ADD CONSTRAINT quantity_publication_attempts_setup_owner_chk
    CHECK ((owner_kind='listing_setup_zero')=(listing_setup_operation_id IS NOT NULL));
CREATE FUNCTION inventory.guard_listing_setup_attempt_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.listing_setup_operation_id IS DISTINCT FROM OLD.listing_setup_operation_id THEN
    RAISE EXCEPTION 'Initial listing operation identity is immutable' USING ERRCODE='23514';
  END IF; RETURN NEW;
END $$;
CREATE TRIGGER quantity_publication_setup_attempt_identity BEFORE UPDATE ON inventory.quantity_publication_attempts
FOR EACH ROW EXECUTE FUNCTION inventory.guard_listing_setup_attempt_identity();
ALTER TABLE inventory.quantity_publication_attempts
  DROP CONSTRAINT quantity_publication_attempts_state,
  DROP CONSTRAINT quantity_publication_attempts_terminal,
  DROP CONSTRAINT quantity_publication_attempts_basis;
ALTER TABLE inventory.quantity_publication_attempts
  ADD CONSTRAINT quantity_publication_attempts_state CHECK(state IN ('running','succeeded','uncertain','resolved','rejected','not_sent')),
  ADD CONSTRAINT quantity_publication_attempts_terminal CHECK((state IN ('succeeded','resolved','rejected','not_sent'))=(completed_at IS NOT NULL)),
  ADD CONSTRAINT quantity_publication_attempts_basis CHECK(resolution_basis IN ('owner_completion','operator_attestation','provider_rejection','owner_preflight_no_request')),
  ADD CONSTRAINT quantity_publication_attempts_no_request_basis CHECK((state='not_sent')=(resolution_basis IS NOT DISTINCT FROM 'owner_preflight_no_request'));
CREATE OR REPLACE FUNCTION inventory.guard_quantity_publication_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR
     (NEW.owner_token,NEW.owner_kind,NEW.gate_epoch,NEW.scope_key,NEW.scope,NEW.outbox_id,NEW.planned_outbox_id,NEW.affected_scope_keys,NEW.affected_scopes,NEW.planned_outbox_ids,NEW.started_at)
       IS DISTINCT FROM
     (OLD.owner_token,OLD.owner_kind,OLD.gate_epoch,OLD.scope_key,OLD.scope,OLD.outbox_id,OLD.planned_outbox_id,OLD.affected_scope_keys,OLD.affected_scopes,OLD.planned_outbox_ids,OLD.started_at) OR
     OLD.state IN ('succeeded','resolved','rejected','not_sent') OR NEW.state NOT IN ('succeeded','uncertain','resolved','rejected','not_sent') OR
     (NEW.state IN ('rejected','not_sent') AND OLD.state<>'running') THEN
    RAISE EXCEPTION 'Provider attempt identity and terminal evidence are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.state='rejected' AND (
    NOT EXISTS(SELECT 1 FROM inventory.quantity_provider_requests q JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
      WHERE q.attempt_id=OLD.id AND r.outcome='rejected') OR
    EXISTS(SELECT 1 FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
      WHERE q.attempt_id=OLD.id AND (r.request_id IS NULL OR r.outcome='uncertain' OR r.http_status IS NULL OR r.response_hash IS NULL))
  ) THEN RAISE EXCEPTION 'Terminal rejection requires complete request evidence' USING ERRCODE='23514'; END IF;
  IF NEW.state='not_sent' AND (OLD.owner_kind<>'listing_setup_zero' OR NEW.outcome_hash IS NULL OR NEW.error_code IS NULL
    OR EXISTS(SELECT 1 FROM inventory.quantity_provider_requests WHERE attempt_id=OLD.id)) THEN
    RAISE EXCEPTION 'Preflight no-request completion requires zero request records and listing setup ownership' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE inventory.quantity_publication_cooldowns DROP CONSTRAINT quantity_publication_cooldowns_provider_key_check;
ALTER TABLE inventory.quantity_publication_cooldowns ADD CONSTRAINT quantity_publication_cooldowns_provider_key_check
  CHECK(provider_key IN ('ebay','shopify','walmart'));
ALTER TABLE inventory.quantity_provider_requests DROP CONSTRAINT quantity_provider_requests_path_check;
ALTER TABLE inventory.quantity_provider_requests ADD CONSTRAINT quantity_provider_requests_path_check
  CHECK(length(path) BETWEEN 1 AND 1024 AND (
    path LIKE '/sell/inventory/v1/%'
    OR (method='POST' AND path IN ('/v3/feeds?feedType=MP_ITEM','/v3/feeds?feedType=MP_ITEM_MATCH'))
    OR (method='PUT' AND path ~ '^/v3/inventory\?sku=[^&#[:space:]]+&shipNode=[^&#[:space:]]+$')
  ));

CREATE TABLE inventory.publication_listing_setup_identities (
  publication_target_id integer NOT NULL REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  external_inventory_item_id varchar(100) NOT NULL CHECK(btrim(external_inventory_item_id)<>''),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(publication_target_id,product_variant_id),
  UNIQUE(publication_target_id,external_inventory_item_id),
  UNIQUE(publication_target_id,product_variant_id,external_inventory_item_id)
);
CREATE TRIGGER publication_listing_setup_identities_immutable BEFORE UPDATE OR DELETE ON inventory.publication_listing_setup_identities
FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_membership_evidence();
CREATE TABLE inventory.publication_listing_setup_scopes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_target_id integer NOT NULL REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  external_inventory_item_id varchar(100) NOT NULL CHECK(btrim(external_inventory_item_id)<>''),
  operation_id varchar(120) NOT NULL CHECK(btrim(operation_id)<>''),
  request_hash varchar(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  desired_quantity integer NOT NULL CHECK(desired_quantity=0),
  target_revision bigint NOT NULL CHECK(target_revision>0),
  created_at timestamptz NOT NULL,
  FOREIGN KEY(publication_target_id,product_variant_id,external_inventory_item_id)
    REFERENCES inventory.publication_listing_setup_identities(publication_target_id,product_variant_id,external_inventory_item_id) ON DELETE RESTRICT,
  UNIQUE(operation_id,product_variant_id)
);
CREATE INDEX publication_listing_setup_scopes_target_idx ON inventory.publication_listing_setup_scopes(publication_target_id,product_variant_id);
CREATE TRIGGER publication_listing_setup_scopes_immutable BEFORE UPDATE OR DELETE ON inventory.publication_listing_setup_scopes
FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_membership_evidence();
COMMENT ON TABLE inventory.publication_listing_setup_scopes IS
  'Immutable zero-only initial-listing scopes. Provider admission and target lifecycle commands fence these SKUs before channel mappings exist.';
