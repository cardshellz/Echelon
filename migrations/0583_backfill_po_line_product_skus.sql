UPDATE procurement.purchase_order_lines pol
SET sku = p.sku
FROM catalog.products p
WHERE pol.product_id = p.id
  AND (pol.line_type IS NULL OR pol.line_type = 'product')
  AND p.sku IS NOT NULL
  AND BTRIM(p.sku) <> ''
  AND (
    pol.sku IS NULL
    OR BTRIM(pol.sku) = ''
    OR BTRIM(pol.sku) = '-'
  );
