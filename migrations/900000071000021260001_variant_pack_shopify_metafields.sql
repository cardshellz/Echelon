-- Pack size and pack type on Shopify variants, mastered here.
--
-- The storefront's product card prints "Pack of 25" / "Case of 1,000" from two
-- Shopify variant metafields: cardshellz.units_per_variant (number_integer) and
-- cardshellz.pack_type (single_line_text_field). They were filled once by hand
-- on 2026-11-16. From here every change to a variant's pack size, pack type,
-- Shopify link or active flag queues both values, so a new or changed variant
-- never shows a wrong or missing pack name.
--
-- HOW: like server/modules/catalog/shipping-group-sync.ts, rows go into the
-- club app's durable outbox (membership.shopify_metafield_outbox, same
-- database), which its worker drains to Shopify about once a minute. The row
-- shape and dedupe key must match shellz-club-app server/sync/outbox.ts, and
-- both keys must be in its server/sync/metafield-registry.ts, or the worker
-- fails the rows.
--
-- The queue write happens inside the catalog write's own transaction, so a
-- failed enqueue rolls the catalog change back instead of leaving drift. A
-- database without the club app's tables (a fresh or test database) is left
-- alone. scripts/backfill-variant-pack-metafields.ts calls the same function
-- for every mapped variant.
--
-- The migration runner wraps this file in its own transaction.

CREATE OR REPLACE FUNCTION catalog.enqueue_variant_pack_metafields(target_shopify_variant_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  variant_gid TEXT;
  owner_found BOOLEAN := FALSE;
  owner_uom_type TEXT;
  owner_units INTEGER;
  pack_label TEXT;
  units_value JSONB;
  label_value JSONB;
BEGIN
  IF target_shopify_variant_id IS NULL OR target_shopify_variant_id !~ '^[0-9]+$' THEN
    RETURN 0;
  END IF;

  -- Only the shared production database has the club app's outbox.
  IF to_regclass('membership.shopify_metafield_outbox') IS NULL THEN
    RETURN 0;
  END IF;

  variant_gid := 'gid://shopify/ProductVariant/' || target_shopify_variant_id;

  -- Shopify already said this variant is gone; the worker would only be told
  -- again. Nested so the table is not read where it does not exist.
  IF to_regclass('membership.shopify_dead_owners') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM membership.shopify_dead_owners AS dead_owner
      WHERE dead_owner.target_type = 'productvariant'
        AND dead_owner.target_id = variant_gid
        AND dead_owner.cleared_at IS NULL
    ) THEN
      RETURN 0;
    END IF;
  END IF;

  -- One Shopify variant can be linked from more than one catalog row (a
  -- retired duplicate). The active row speaks for it, then the oldest.
  SELECT TRUE, variant_row.uom_type, variant_row.units_per_variant
  INTO owner_found, owner_uom_type, owner_units
  FROM catalog.product_variants AS variant_row
  WHERE variant_row.shopify_variant_id = target_shopify_variant_id
  ORDER BY (variant_row.is_active IS TRUE) DESC, variant_row.id ASC
  LIMIT 1;

  IF owner_found THEN
    -- Labels from shared/catalog/variant-uom.ts, with "Box / Inner Pack"
    -- shortened to "Box" so the card reads "Box of 500".
    pack_label := CASE owner_uom_type
      WHEN 'piece' THEN 'Piece'
      WHEN 'each' THEN 'Each'
      WHEN 'pack' THEN 'Pack'
      WHEN 'inner_pack' THEN 'Box'
      WHEN 'case' THEN 'Case'
      WHEN 'skid' THEN 'Skid'
    END;
    IF owner_units IS NOT NULL AND owner_units > 0 THEN
      units_value := to_jsonb(owner_units);
    END IF;
    IF pack_label IS NOT NULL THEN
      label_value := to_jsonb(pack_label);
    END IF;
  END IF;

  -- No catalog row links this Shopify variant any more: its values are no
  -- longer known, so both metafields are removed rather than left stale.
  INSERT INTO membership.shopify_metafield_outbox
    (target_type, target_id, namespace, key, value, operation, dedupe_key, scheduled_for)
  VALUES
    ('productvariant', variant_gid, 'cardshellz', 'units_per_variant',
     units_value, CASE WHEN units_value IS NULL THEN 'delete' ELSE 'set' END,
     'productvariant:' || variant_gid || ':cardshellz:units_per_variant', now()),
    ('productvariant', variant_gid, 'cardshellz', 'pack_type',
     label_value, CASE WHEN label_value IS NULL THEN 'delete' ELSE 'set' END,
     'productvariant:' || variant_gid || ':cardshellz:pack_type', now())
  ON CONFLICT (dedupe_key) WHERE status = 'pending'
  DO UPDATE SET
    value = EXCLUDED.value,
    operation = EXCLUDED.operation,
    scheduled_for = EXCLUDED.scheduled_for,
    attempts = 0,
    last_error = NULL;

  RETURN 2;
END;
$$;

COMMENT ON FUNCTION catalog.enqueue_variant_pack_metafields(TEXT) IS
  'Queues cardshellz.units_per_variant and cardshellz.pack_type for one Shopify variant id into membership.shopify_metafield_outbox. Returns the number of rows queued (0 when skipped).';

CREATE OR REPLACE FUNCTION catalog.product_variants_enqueue_pack_metafields()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM catalog.enqueue_variant_pack_metafields(OLD.shopify_variant_id);
    RETURN OLD;
  END IF;

  PERFORM catalog.enqueue_variant_pack_metafields(NEW.shopify_variant_id);

  -- A variant moved to another Shopify variant: the old one is recomputed too
  -- (another catalog row may still link it, or it loses both values).
  IF TG_OP = 'UPDATE' AND OLD.shopify_variant_id IS DISTINCT FROM NEW.shopify_variant_id THEN
    PERFORM catalog.enqueue_variant_pack_metafields(OLD.shopify_variant_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_variants_pack_metafields_insert ON catalog.product_variants;
CREATE TRIGGER product_variants_pack_metafields_insert
AFTER INSERT ON catalog.product_variants
FOR EACH ROW
WHEN (NEW.shopify_variant_id IS NOT NULL)
EXECUTE FUNCTION catalog.product_variants_enqueue_pack_metafields();

DROP TRIGGER IF EXISTS product_variants_pack_metafields_update ON catalog.product_variants;
CREATE TRIGGER product_variants_pack_metafields_update
AFTER UPDATE OF uom_type, units_per_variant, shopify_variant_id, is_active ON catalog.product_variants
FOR EACH ROW
WHEN (
  OLD.uom_type IS DISTINCT FROM NEW.uom_type
  OR OLD.units_per_variant IS DISTINCT FROM NEW.units_per_variant
  OR OLD.shopify_variant_id IS DISTINCT FROM NEW.shopify_variant_id
  OR OLD.is_active IS DISTINCT FROM NEW.is_active
)
EXECUTE FUNCTION catalog.product_variants_enqueue_pack_metafields();

DROP TRIGGER IF EXISTS product_variants_pack_metafields_delete ON catalog.product_variants;
CREATE TRIGGER product_variants_pack_metafields_delete
AFTER DELETE ON catalog.product_variants
FOR EACH ROW
WHEN (OLD.shopify_variant_id IS NOT NULL)
EXECUTE FUNCTION catalog.product_variants_enqueue_pack_metafields();

