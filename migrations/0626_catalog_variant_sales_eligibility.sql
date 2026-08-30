BEGIN;

-- Customer sellability is independent from physical inventory ownership.
-- Internal-only variants remain valid inventory/build identities, but cannot
-- become targets of a customer-facing listing, allocation, publication, or
-- reservation configuration.
ALTER TABLE catalog.product_variants
  ADD COLUMN IF NOT EXISTS sales_eligibility varchar(20) NOT NULL DEFAULT 'sellable';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_variants_sales_eligibility_chk'
      AND conrelid = 'catalog.product_variants'::regclass
  ) THEN
    ALTER TABLE catalog.product_variants
      ADD CONSTRAINT product_variants_sales_eligibility_chk
      CHECK (sales_eligibility IN ('sellable', 'internal_only'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_variants_internal_only_identity_chk'
      AND conrelid = 'catalog.product_variants'::regclass
  ) THEN
    ALTER TABLE catalog.product_variants
      ADD CONSTRAINT product_variants_internal_only_identity_chk
      CHECK (
        sales_eligibility = 'sellable'
        OR (
          shopify_variant_id IS NULL
          AND shopify_inventory_item_id IS NULL
          AND COALESCE(dropship_eligible, false) = false
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN catalog.product_variants.sales_eligibility IS
  'sellable permits customer/channel use; internal_only preserves physical inventory and transformation use while prohibiting customer promises and publication.';

-- Every customer-facing variant writer uses this same lock and assertion. The
-- catalog transition service takes the same advisory lock before checking
-- dependencies, preventing a concurrent exposure write from racing an
-- internal-only transition.
CREATE OR REPLACE FUNCTION catalog.assert_customer_sellable_variant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  variant_id integer;
  eligibility varchar(20);
BEGIN
  variant_id := NEW.product_variant_id;
  IF variant_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(918424, variant_id);
  SELECT pv.sales_eligibility
    INTO eligibility
  FROM catalog.product_variants AS pv
  WHERE pv.id = variant_id;

  IF eligibility IS DISTINCT FROM 'sellable' THEN
    RAISE EXCEPTION 'Catalog variant % is not customer-sellable and cannot be used by a customer-facing writer', variant_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'customer_sellable_variant_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION catalog.guard_internal_only_variant_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.sales_eligibility IS NOT DISTINCT FROM OLD.sales_eligibility
     OR NEW.sales_eligibility <> 'internal_only' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(918424, NEW.id);

  IF NEW.shopify_variant_id IS NOT NULL OR NEW.shopify_inventory_item_id IS NOT NULL THEN
    RAISE EXCEPTION 'Variant % still has a Shopify mapping', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'internal_only_variant_has_customer_exposure';
  END IF;
  IF COALESCE(NEW.dropship_eligible, false) THEN
    RAISE EXCEPTION 'Variant % is still enabled for dropship', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'internal_only_variant_has_customer_exposure';
  END IF;
  IF EXISTS (
    SELECT 1 FROM channels.channel_feeds f
    WHERE f.product_variant_id = NEW.id AND f.is_active = 1
  ) OR EXISTS (
    SELECT 1 FROM channels.channel_listings l
    WHERE l.product_variant_id = NEW.id
  ) OR EXISTS (
    SELECT 1 FROM channels.channel_reservations r
    WHERE r.product_variant_id = NEW.id
  ) OR EXISTS (
    SELECT 1 FROM channels.channel_variant_overrides o
    WHERE o.product_variant_id = NEW.id AND o.is_listed <> 0
  ) OR EXISTS (
    SELECT 1 FROM channels.channel_allocation_rules r
    WHERE r.product_variant_id = NEW.id
  ) OR EXISTS (
    SELECT 1 FROM channels.channel_variant_availability_sync a
    WHERE a.product_variant_id = NEW.id AND a.desired_active = true
  ) OR EXISTS (
    SELECT 1 FROM dropship.dropship_vendor_listings l
    WHERE l.product_variant_id = NEW.id
  ) OR EXISTS (
    SELECT 1 FROM dropship.dropship_vendor_variant_overrides o
    WHERE o.product_variant_id = NEW.id
  ) OR EXISTS (
    SELECT 1
    FROM marketplace.listing_publication_members m
    JOIN marketplace.listing_publications p ON p.id = m.publication_id
    WHERE m.product_variant_id = NEW.id
      AND m.disposition = 'included'
      AND p.status IN ('planned', 'staged', 'active')
  ) OR EXISTS (
    SELECT 1 FROM inventory.inventory_publication_outbox o
    WHERE o.product_variant_id = NEW.id
      AND o.state NOT IN ('verified', 'dead_letter', 'superseded', 'cancelled')
  ) OR EXISTS (
    SELECT 1
    FROM wms.order_items oi
    JOIN wms.orders o ON o.id = oi.order_id
    WHERE oi.sku = NEW.sku
      AND o.warehouse_status NOT IN ('shipped', 'completed', 'cancelled', 'voided')
      AND oi.status <> 'cancelled'
      AND oi.fulfilled_quantity < oi.quantity
  ) OR EXISTS (
    SELECT 1
    FROM oms.oms_order_lines ol
    JOIN oms.oms_orders o ON o.id = ol.order_id
    WHERE ol.product_variant_id = NEW.id
      AND o.status NOT IN ('shipped', 'delivered', 'cancelled', 'refunded')
  ) THEN
    RAISE EXCEPTION 'Variant % still has customer-facing channel, listing, allocation, or publication dependencies', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'internal_only_variant_has_customer_exposure';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_variants_guard_internal_only_transition
  ON catalog.product_variants;
CREATE TRIGGER product_variants_guard_internal_only_transition
BEFORE UPDATE OF sales_eligibility, shopify_variant_id, shopify_inventory_item_id, dropship_eligible
ON catalog.product_variants
FOR EACH ROW EXECUTE FUNCTION catalog.guard_internal_only_variant_transition();

-- Order intake is itself a customer-promise boundary. This guard serializes
-- with the catalog transition so a concurrent OMS insert either completes
-- first and blocks the transition, or observes internal-only and rolls back.
-- Terminal historical orders remain linkable for reconciliation/replay.
CREATE OR REPLACE FUNCTION catalog.assert_customer_sellable_oms_order_line()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  order_status varchar(30);
  eligibility varchar(20);
BEGIN
  IF NEW.product_variant_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT o.status
    INTO order_status
  FROM oms.oms_orders AS o
  WHERE o.id = NEW.order_id
  FOR SHARE;

  IF order_status IN ('shipped', 'delivered', 'cancelled', 'refunded') THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(918424, NEW.product_variant_id);
  SELECT pv.sales_eligibility
    INTO eligibility
  FROM catalog.product_variants AS pv
  WHERE pv.id = NEW.product_variant_id;

  IF eligibility IS DISTINCT FROM 'sellable' THEN
    RAISE EXCEPTION 'Catalog variant % is not customer-sellable and cannot be inserted on an open OMS order', NEW.product_variant_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'customer_sellable_order_line_required';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS oms_order_lines_require_sellable_variant
  ON oms.oms_order_lines;
CREATE TRIGGER oms_order_lines_require_sellable_variant
BEFORE INSERT OR UPDATE OF product_variant_id, order_id
ON oms.oms_order_lines
FOR EACH ROW EXECUTE FUNCTION catalog.assert_customer_sellable_oms_order_line();

-- A terminal historical order may keep its catalog linkage, but changing that
-- order back into an open promise must revalidate every linked variant. Locks
-- are acquired in variant-id order to match multi-line reservation planning.
CREATE OR REPLACE FUNCTION catalog.assert_customer_sellable_oms_order_reopen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  internal_variant_id integer;
BEGIN
  IF NEW.status IN ('shipped', 'delivered', 'cancelled', 'refunded')
     OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(918424, variants.product_variant_id)
  FROM (
    SELECT DISTINCT ol.product_variant_id
    FROM oms.oms_order_lines AS ol
    WHERE ol.order_id = NEW.id
      AND ol.product_variant_id IS NOT NULL
    ORDER BY ol.product_variant_id
  ) AS variants;

  SELECT ol.product_variant_id
    INTO internal_variant_id
  FROM oms.oms_order_lines AS ol
  JOIN catalog.product_variants AS pv ON pv.id = ol.product_variant_id
  WHERE ol.order_id = NEW.id
    AND pv.sales_eligibility <> 'sellable'
  ORDER BY ol.product_variant_id
  LIMIT 1;

  IF internal_variant_id IS NOT NULL THEN
    RAISE EXCEPTION 'Catalog variant % is not customer-sellable and prevents OMS order % from reopening', internal_variant_id, NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'customer_sellable_order_line_required';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS oms_orders_require_sellable_variants_on_reopen
  ON oms.oms_orders;
CREATE TRIGGER oms_orders_require_sellable_variants_on_reopen
BEFORE UPDATE OF status
ON oms.oms_orders
FOR EACH ROW EXECUTE FUNCTION catalog.assert_customer_sellable_oms_order_reopen();

DROP TRIGGER IF EXISTS channel_feeds_require_sellable_variant ON channels.channel_feeds;
CREATE TRIGGER channel_feeds_require_sellable_variant
BEFORE INSERT OR UPDATE OF product_variant_id, is_active ON channels.channel_feeds
FOR EACH ROW WHEN (NEW.is_active = 1)
EXECUTE FUNCTION catalog.assert_customer_sellable_variant();

DROP TRIGGER IF EXISTS channel_listings_require_sellable_variant ON channels.channel_listings;
CREATE TRIGGER channel_listings_require_sellable_variant
BEFORE INSERT OR UPDATE OF product_variant_id ON channels.channel_listings
FOR EACH ROW WHEN (NEW.product_variant_id IS NOT NULL)
EXECUTE FUNCTION catalog.assert_customer_sellable_variant();

DROP TRIGGER IF EXISTS channel_reservations_require_sellable_variant ON channels.channel_reservations;
CREATE TRIGGER channel_reservations_require_sellable_variant
BEFORE INSERT OR UPDATE OF product_variant_id ON channels.channel_reservations
FOR EACH ROW WHEN (NEW.product_variant_id IS NOT NULL)
EXECUTE FUNCTION catalog.assert_customer_sellable_variant();

DROP TRIGGER IF EXISTS channel_variant_overrides_require_sellable_variant ON channels.channel_variant_overrides;
CREATE TRIGGER channel_variant_overrides_require_sellable_variant
BEFORE INSERT OR UPDATE OF product_variant_id, is_listed ON channels.channel_variant_overrides
FOR EACH ROW WHEN (NEW.product_variant_id IS NOT NULL AND NEW.is_listed <> 0)
EXECUTE FUNCTION catalog.assert_customer_sellable_variant();

DROP TRIGGER IF EXISTS channel_allocation_rules_require_sellable_variant ON channels.channel_allocation_rules;
CREATE TRIGGER channel_allocation_rules_require_sellable_variant
BEFORE INSERT OR UPDATE OF product_variant_id ON channels.channel_allocation_rules
FOR EACH ROW WHEN (NEW.product_variant_id IS NOT NULL)
EXECUTE FUNCTION catalog.assert_customer_sellable_variant();

DROP TRIGGER IF EXISTS dropship_vendor_listings_require_sellable_variant ON dropship.dropship_vendor_listings;
CREATE TRIGGER dropship_vendor_listings_require_sellable_variant
BEFORE INSERT OR UPDATE OF product_variant_id ON dropship.dropship_vendor_listings
FOR EACH ROW EXECUTE FUNCTION catalog.assert_customer_sellable_variant();

DROP TRIGGER IF EXISTS dropship_variant_overrides_require_sellable_variant ON dropship.dropship_vendor_variant_overrides;
CREATE TRIGGER dropship_variant_overrides_require_sellable_variant
BEFORE INSERT OR UPDATE OF product_variant_id ON dropship.dropship_vendor_variant_overrides
FOR EACH ROW EXECUTE FUNCTION catalog.assert_customer_sellable_variant();

DROP TRIGGER IF EXISTS marketplace_publication_members_require_sellable_variant
  ON marketplace.listing_publication_members;
CREATE TRIGGER marketplace_publication_members_require_sellable_variant
BEFORE INSERT OR UPDATE OF product_variant_id, disposition ON marketplace.listing_publication_members
FOR EACH ROW WHEN (NEW.disposition = 'included')
EXECUTE FUNCTION catalog.assert_customer_sellable_variant();

DROP TRIGGER IF EXISTS inventory_publication_outbox_require_sellable_variant
  ON inventory.inventory_publication_outbox;
CREATE TRIGGER inventory_publication_outbox_require_sellable_variant
BEFORE INSERT OR UPDATE OF product_variant_id, state ON inventory.inventory_publication_outbox
FOR EACH ROW WHEN (NEW.state NOT IN ('verified', 'dead_letter', 'superseded', 'cancelled'))
EXECUTE FUNCTION catalog.assert_customer_sellable_variant();

DROP TRIGGER IF EXISTS channel_variant_availability_require_sellable_reactivation
  ON channels.channel_variant_availability_sync;
CREATE TRIGGER channel_variant_availability_require_sellable_reactivation
BEFORE INSERT OR UPDATE OF product_variant_id, desired_active
ON channels.channel_variant_availability_sync
FOR EACH ROW WHEN (NEW.desired_active = true)
EXECUTE FUNCTION catalog.assert_customer_sellable_variant();

COMMIT;
