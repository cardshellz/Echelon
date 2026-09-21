-- Product policy is independent of accounting inventory_type and shipping eligibility.
ALTER TABLE catalog.products
  ADD COLUMN IF NOT EXISTS inventory_tracking_default boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'catalog' AND table_name = 'product_variants' AND column_name = 'inventory_tracking_override') THEN
    ALTER TABLE catalog.product_variants ADD COLUMN inventory_tracking_override boolean;
    -- Preserve historical false choices only when introducing inheritance.
    UPDATE catalog.product_variants SET inventory_tracking_override = false WHERE track_inventory IS FALSE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS channels.channel_product_identities (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  product_id integer NOT NULL REFERENCES catalog.products(id),
  external_product_id varchar(100) NOT NULL CHECK (length(btrim(external_product_id)) > 0),
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT channel_product_identities_external_uq UNIQUE (channel_id, external_product_id),
  CONSTRAINT channel_product_identities_product_uq UNIQUE (channel_id, product_id)
);

ALTER TABLE oms.oms_order_lines
  ADD COLUMN IF NOT EXISTS catalog_product_id integer REFERENCES catalog.products(id),
  ADD COLUMN IF NOT EXISTS inventory_tracking boolean;
ALTER TABLE wms.order_items
  ADD COLUMN IF NOT EXISTS catalog_product_id integer REFERENCES catalog.products(id),
  ADD COLUMN IF NOT EXISTS inventory_tracking boolean;
-- Existing order identities/progress are intentionally not reclassified by this migration.

COMMENT ON COLUMN catalog.products.inventory_tracking_default IS
  'Warehouse inventory tracking default; applies directly to products without variants.';
COMMENT ON COLUMN catalog.product_variants.inventory_tracking_override IS
  'NULL inherits product inventory_tracking_default; true/false explicitly overrides it.';
COMMENT ON COLUMN catalog.product_variants.track_inventory IS
  'Effective inventory tracking projection maintained by the catalog policy writer.';

-- Integrity constraints validate the application-owned projection; they never choose
-- a policy or silently rewrite catalog data. Deferred checks allow one atomic family update.
CREATE OR REPLACE FUNCTION catalog.assert_inventory_tracking_projection() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE family_id integer;
BEGIN
  IF TG_TABLE_NAME = 'products' THEN
    IF TG_OP = 'UPDATE' AND OLD.inventory_tracking_default IS NOT DISTINCT FROM NEW.inventory_tracking_default THEN RETURN NULL; END IF;
    family_id := NEW.id;
  ELSE
    IF TG_OP = 'UPDATE' AND ROW(OLD.product_id, OLD.requires_shipping, OLD.track_inventory, OLD.inventory_tracking_override)
      IS NOT DISTINCT FROM ROW(NEW.product_id, NEW.requires_shipping, NEW.track_inventory, NEW.inventory_tracking_override) THEN RETURN NULL; END IF;
    family_id := NEW.product_id;
  END IF;
  PERFORM id FROM catalog.products WHERE id = family_id FOR SHARE;
  IF EXISTS (
    SELECT 1 FROM catalog.product_variants variant JOIN catalog.products product ON product.id = variant.product_id
    WHERE product.id = family_id AND COALESCE(variant.track_inventory, true)
      IS DISTINCT FROM (variant.requires_shipping AND COALESCE(variant.inventory_tracking_override, product.inventory_tracking_default))
  ) THEN
    RAISE EXCEPTION 'INVENTORY_POLICY_PROJECTION_CONFLICT: product %', family_id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS products_inventory_tracking_projection ON catalog.products;
CREATE CONSTRAINT TRIGGER products_inventory_tracking_projection AFTER INSERT OR UPDATE ON catalog.products
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.assert_inventory_tracking_projection();
DROP TRIGGER IF EXISTS variants_inventory_tracking_projection ON catalog.product_variants;
CREATE CONSTRAINT TRIGGER variants_inventory_tracking_projection AFTER INSERT OR UPDATE ON catalog.product_variants
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.assert_inventory_tracking_projection();

-- A key-share FK check alone does not protect a policy fact. SHARE serializes
-- nonzero custody/claim writes with the policy owner's FOR UPDATE variant lock.
CREATE OR REPLACE FUNCTION catalog.require_tracked_inventory_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE variant_id integer; tracked boolean;
BEGIN
  variant_id := (to_jsonb(NEW) ->> TG_ARGV[0])::integer;
  SELECT requires_shipping AND COALESCE(track_inventory, true) INTO tracked
    FROM catalog.product_variants WHERE id = variant_id FOR SHARE;
  IF tracked IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'INVENTORY_POLICY_NOT_TRACKED: variant %', variant_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS inventory_levels_require_tracking ON inventory.inventory_levels;
CREATE TRIGGER inventory_levels_require_tracking BEFORE INSERT OR UPDATE ON inventory.inventory_levels
FOR EACH ROW WHEN (NEW.variant_qty <> 0 OR NEW.reserved_qty <> 0 OR NEW.picked_qty <> 0 OR NEW.packed_qty <> 0 OR NEW.backorder_qty <> 0)
EXECUTE FUNCTION catalog.require_tracked_inventory_identity('product_variant_id');
DROP TRIGGER IF EXISTS inventory_lots_require_tracking ON inventory.inventory_lots;
CREATE TRIGGER inventory_lots_require_tracking BEFORE INSERT OR UPDATE ON inventory.inventory_lots
FOR EACH ROW WHEN (NEW.qty_on_hand <> 0 OR NEW.qty_reserved <> 0)
EXECUTE FUNCTION catalog.require_tracked_inventory_identity('product_variant_id');
DROP TRIGGER IF EXISTS claim_lines_require_tracking ON inventory.availability_claim_lines;
CREATE TRIGGER claim_lines_require_tracking BEFORE INSERT OR UPDATE ON inventory.availability_claim_lines
FOR EACH ROW WHEN (NEW.planned_qty > NEW.released_target_qty + NEW.consumed_target_qty)
EXECUTE FUNCTION catalog.require_tracked_inventory_identity('target_variant_id');
DROP TRIGGER IF EXISTS claim_resources_require_tracking ON inventory.availability_claim_resources;
CREATE TRIGGER claim_resources_require_tracking BEFORE INSERT OR UPDATE ON inventory.availability_claim_resources
FOR EACH ROW WHEN (NEW.claimed_qty > NEW.released_qty + NEW.consumed_qty)
EXECUTE FUNCTION catalog.require_tracked_inventory_identity('source_variant_id');
