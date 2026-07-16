-- Keep purchase-order supplier provenance aligned across the PO header,
-- product line, receive configuration, and reusable supplier mapping.

DO $$
DECLARE
  invalid_links TEXT;
BEGIN
  SELECT string_agg(
    format(
      'line_id=%s po_id=%s vendor_product_id=%s po_vendor_id=%s line_product_id=%s mapping_vendor_id=%s mapping_product_id=%s',
      row_data.line_id,
      row_data.purchase_order_id,
      row_data.vendor_product_id,
      row_data.po_vendor_id,
      row_data.line_product_id,
      row_data.mapping_vendor_id,
      row_data.mapping_product_id
    ),
    '; ' ORDER BY row_data.line_id
  )
  INTO invalid_links
  FROM (
    SELECT
      pol.id AS line_id,
      pol.purchase_order_id,
      pol.vendor_product_id,
      po.vendor_id AS po_vendor_id,
      pol.product_id AS line_product_id,
      vp.vendor_id AS mapping_vendor_id,
      vp.product_id AS mapping_product_id
    FROM procurement.purchase_order_lines pol
    JOIN procurement.purchase_orders po ON po.id = pol.purchase_order_id
    JOIN procurement.vendor_products vp ON vp.id = pol.vendor_product_id
    WHERE pol.vendor_product_id IS NOT NULL
      AND (
        pol.line_type <> 'product'
        OR pol.product_id IS NULL
        OR vp.vendor_id <> po.vendor_id
        OR vp.product_id <> pol.product_id
      )
    ORDER BY pol.id
    LIMIT 20
  ) AS row_data;

  IF invalid_links IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce PO vendor-product identity; invalid links found: %',
      invalid_links
      USING
        ERRCODE = '23514',
        HINT = 'Repair each PO line to the active mapping matching its PO vendor and product, then rerun migration 146.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION procurement.guard_po_line_vendor_product_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  header_vendor_id INTEGER;
  mapping_vendor_id INTEGER;
  mapping_product_id INTEGER;
  mapping_variant_id INTEGER;
  mapping_active INTEGER;
  receive_variant_id INTEGER;
BEGIN
  IF NEW.vendor_product_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.line_type IS DISTINCT FROM 'product' OR NEW.product_id IS NULL THEN
    RAISE EXCEPTION
      'PO line % cannot link vendor product % without a product identity',
      COALESCE(NEW.id::text, '<new>'),
      NEW.vendor_product_id
      USING ERRCODE = '23514';
  END IF;

  SELECT po.vendor_id
  INTO header_vendor_id
  FROM procurement.purchase_orders po
  WHERE po.id = NEW.purchase_order_id;

  IF header_vendor_id IS NULL THEN
    RAISE EXCEPTION
      'PO line % references missing purchase order %',
      COALESCE(NEW.id::text, '<new>'),
      NEW.purchase_order_id
      USING ERRCODE = '23503';
  END IF;

  SELECT
    vp.vendor_id,
    vp.product_id,
    vp.product_variant_id,
    vp.is_active
  INTO
    mapping_vendor_id,
    mapping_product_id,
    mapping_variant_id,
    mapping_active
  FROM procurement.vendor_products vp
  WHERE vp.id = NEW.vendor_product_id;

  IF mapping_vendor_id IS NULL THEN
    RAISE EXCEPTION
      'PO line % references missing vendor product %',
      COALESCE(NEW.id::text, '<new>'),
      NEW.vendor_product_id
      USING ERRCODE = '23503';
  END IF;

  receive_variant_id :=
    COALESCE(NEW.expected_receive_variant_id, NEW.product_variant_id);

  IF mapping_active <> 1
    OR mapping_vendor_id <> header_vendor_id
    OR mapping_product_id <> NEW.product_id
    OR (
      mapping_variant_id IS NOT NULL
      AND mapping_variant_id IS DISTINCT FROM receive_variant_id
    )
  THEN
    RAISE EXCEPTION
      'PO line % vendor product % does not match active vendor/product/receive configuration',
      COALESCE(NEW.id::text, '<new>'),
      NEW.vendor_product_id
      USING
        ERRCODE = '23514',
        DETAIL = format(
          'po_vendor_id=%s line_product_id=%s receive_variant_id=%s mapping_vendor_id=%s mapping_product_id=%s mapping_variant_id=%s mapping_active=%s',
          header_vendor_id,
          NEW.product_id,
          COALESCE(receive_variant_id::text, 'NULL'),
          mapping_vendor_id,
          mapping_product_id,
          COALESCE(mapping_variant_id::text, 'NULL'),
          mapping_active
        );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS purchase_order_lines_vendor_product_identity_guard
  ON procurement.purchase_order_lines;

CREATE TRIGGER purchase_order_lines_vendor_product_identity_guard
BEFORE INSERT OR UPDATE OF
  purchase_order_id,
  line_type,
  product_id,
  product_variant_id,
  expected_receive_variant_id,
  vendor_product_id
ON procurement.purchase_order_lines
FOR EACH ROW
EXECUTE FUNCTION procurement.guard_po_line_vendor_product_identity();

CREATE OR REPLACE FUNCTION procurement.guard_po_vendor_change_for_linked_products()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invalid_line_ids TEXT;
BEGIN
  IF NEW.vendor_id IS NOT DISTINCT FROM OLD.vendor_id THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(pol.id::text, ', ' ORDER BY pol.id)
  INTO invalid_line_ids
  FROM procurement.purchase_order_lines pol
  JOIN procurement.vendor_products vp ON vp.id = pol.vendor_product_id
  WHERE pol.purchase_order_id = OLD.id
    AND pol.vendor_product_id IS NOT NULL
    AND vp.vendor_id <> NEW.vendor_id;

  IF invalid_line_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'Purchase order % vendor change would invalidate linked lines: %',
      OLD.id,
      invalid_line_ids
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS purchase_orders_linked_vendor_identity_guard
  ON procurement.purchase_orders;

CREATE TRIGGER purchase_orders_linked_vendor_identity_guard
BEFORE UPDATE OF vendor_id
ON procurement.purchase_orders
FOR EACH ROW
EXECUTE FUNCTION procurement.guard_po_vendor_change_for_linked_products();

CREATE OR REPLACE FUNCTION procurement.guard_linked_vendor_product_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invalid_line_ids TEXT;
BEGIN
  IF NEW.vendor_id IS NOT DISTINCT FROM OLD.vendor_id
    AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
    AND NEW.product_variant_id IS NOT DISTINCT FROM OLD.product_variant_id
  THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(pol.id::text, ', ' ORDER BY pol.id)
  INTO invalid_line_ids
  FROM procurement.purchase_order_lines pol
  JOIN procurement.purchase_orders po ON po.id = pol.purchase_order_id
  WHERE pol.vendor_product_id = OLD.id
    AND (
      NEW.vendor_id <> po.vendor_id
      OR NEW.product_id <> pol.product_id
      OR (
        NEW.product_variant_id IS NOT NULL
        AND NEW.product_variant_id IS DISTINCT FROM
          COALESCE(pol.expected_receive_variant_id, pol.product_variant_id)
      )
    );

  IF invalid_line_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'Vendor product % identity change would invalidate linked PO lines: %',
      OLD.id,
      invalid_line_ids
      USING
        ERRCODE = '23514',
        HINT = 'Create a new vendor-product mapping instead of reassigning an existing linked mapping.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vendor_products_linked_identity_guard
  ON procurement.vendor_products;

CREATE TRIGGER vendor_products_linked_identity_guard
BEFORE UPDATE OF vendor_id, product_id, product_variant_id
ON procurement.vendor_products
FOR EACH ROW
EXECUTE FUNCTION procurement.guard_linked_vendor_product_identity_change();

COMMENT ON FUNCTION procurement.guard_po_line_vendor_product_identity() IS
  'Rejects PO-line supplier links that do not match the active PO vendor, product, and receive configuration.';

COMMENT ON FUNCTION procurement.guard_po_vendor_change_for_linked_products() IS
  'Rejects PO vendor changes that would invalidate existing vendor-product provenance.';

COMMENT ON FUNCTION procurement.guard_linked_vendor_product_identity_change() IS
  'Rejects identity reassignment of vendor-product mappings referenced by PO lines.';
