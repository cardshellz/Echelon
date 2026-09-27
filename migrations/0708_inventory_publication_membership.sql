-- Existing destinations keep their historical whole-product scope. New Walmart
-- destinations start explicitly empty; linking a seller SKU never opts it in.
-- Existing target guards rejected every live -> live revision bump as if it
-- were a new activation. Membership/hold commands need revision-only changes;
-- preserve every identity and transition restriction while admitting that edge.
CREATE OR REPLACE FUNCTION inventory.guard_inventory_publication_target_update()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.destination_kind IS DISTINCT FROM OLD.destination_kind
     OR NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.channel_connection_id IS DISTINCT FROM OLD.channel_connection_id
     OR NEW.dropship_store_connection_id IS DISTINCT FROM OLD.dropship_store_connection_id
     OR NEW.fulfillment_node_id IS DISTINCT FROM OLD.fulfillment_node_id
     OR NEW.provider_scope_type IS DISTINCT FROM OLD.provider_scope_type OR NEW.external_scope_id IS DISTINCT FROM OLD.external_scope_id
     OR NEW.publication_authority IS DISTINCT FROM OLD.publication_authority OR NEW.change_reason IS DISTINCT FROM OLD.change_reason
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'inventory publication target identity and creation evidence are immutable';
  END IF;
  IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'inventory publication target revision must increment by 1'; END IF;
  IF OLD.state='live' AND NEW.state NOT IN ('live','disabled') THEN
    RAISE EXCEPTION 'a live publication target can only remain live or enter the scoped disabled stop state';
  END IF;
  IF NEW.state='live' AND OLD.state NOT IN ('preview','live') THEN
    RAISE EXCEPTION 'a publication target must be previewed before it becomes live';
  END IF;
  NEW.updated_at:=transaction_timestamp(); RETURN NEW;
END $$;

ALTER TABLE inventory.inventory_publication_targets
  ADD COLUMN membership_mode varchar(20) NOT NULL DEFAULT 'whole_product',
  ADD CONSTRAINT inventory_publication_targets_membership_mode_chk
    CHECK (membership_mode IN ('whole_product','explicit'));

CREATE FUNCTION inventory.guard_publication_membership_mode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.destination_kind = 'channel_connection' AND EXISTS (
      SELECT 1 FROM channels.channels WHERE id=NEW.channel_id AND lower(provider)='walmart'
    ) THEN NEW.membership_mode := 'explicit'; END IF;
  ELSIF NEW.membership_mode IS DISTINCT FROM OLD.membership_mode THEN
    RAISE EXCEPTION 'Publication membership mode is immutable; a reviewed migration is required'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_publication_targets_membership_mode_guard
BEFORE INSERT OR UPDATE ON inventory.inventory_publication_targets
FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_membership_mode();

CREATE TABLE inventory.publication_membership_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_target_id integer NOT NULL REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  version bigint NOT NULL CHECK (version>0),
  included boolean NOT NULL,
  definition_hash varchar(64) NOT NULL CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
  review_hash varchar(64) NOT NULL CHECK (review_hash ~ '^[a-f0-9]{64}$'),
  created_by varchar(100) NOT NULL CHECK (created_by=btrim(created_by) AND created_by<>''),
  created_at timestamptz NOT NULL,
  UNIQUE(publication_target_id,product_variant_id,version),
  UNIQUE(id,publication_target_id,product_variant_id)
);
CREATE TABLE inventory.publication_membership_heads (
  publication_target_id integer NOT NULL REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  active_version_id bigint NOT NULL,
  PRIMARY KEY(publication_target_id,product_variant_id),
  FOREIGN KEY(active_version_id,publication_target_id,product_variant_id)
    REFERENCES inventory.publication_membership_versions(id,publication_target_id,product_variant_id) ON DELETE RESTRICT
);
CREATE TABLE inventory.publication_membership_applications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_target_id integer NOT NULL REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  idempotency_key varchar(120) NOT NULL UNIQUE CHECK (btrim(idempotency_key)<>''),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor varchar(100) NOT NULL CHECK (actor=btrim(actor) AND actor<>''),
  occurred_at timestamptz NOT NULL,
  review jsonb NOT NULL CHECK (jsonb_typeof(review)='object'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object')
);
CREATE FUNCTION inventory.guard_publication_membership_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Publication membership evidence is append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER publication_membership_versions_immutable
BEFORE UPDATE OR DELETE ON inventory.publication_membership_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_membership_evidence();
CREATE TRIGGER publication_membership_applications_immutable
BEFORE UPDATE OR DELETE ON inventory.publication_membership_applications
FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_membership_evidence();
CREATE INDEX publication_membership_heads_variant_idx
  ON inventory.publication_membership_heads(product_variant_id,publication_target_id);

CREATE FUNCTION inventory.guard_publication_membership_head() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Publication membership must be excluded by an audited version' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM inventory.inventory_publication_targets WHERE id=NEW.publication_target_id AND membership_mode='explicit') THEN
    RAISE EXCEPTION 'Only explicit targets accept selected membership' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.publication_target_id<>OLD.publication_target_id OR NEW.product_variant_id<>OLD.product_variant_id
    OR (SELECT version FROM inventory.publication_membership_versions WHERE id=NEW.active_version_id)
       <=(SELECT version FROM inventory.publication_membership_versions WHERE id=OLD.active_version_id)) THEN
    RAISE EXCEPTION 'Publication membership heads must advance within one target and variant' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_membership_heads_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory.publication_membership_heads
FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_membership_head();

COMMENT ON COLUMN inventory.inventory_publication_targets.membership_mode IS
  'Immutable outbound membership policy. Existing targets retain whole_product; new Walmart targets are explicit and empty until reviewed inclusion.';
COMMENT ON TABLE inventory.publication_membership_versions IS
  'Inventory-owned immutable selected/excluded destination variants. Exclusion of a managed SKU requires held, current verified zero through the membership service.';
