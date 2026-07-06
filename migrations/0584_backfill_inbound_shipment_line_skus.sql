UPDATE procurement.inbound_shipment_lines isl
SET sku = pol.sku,
    updated_at = NOW()
FROM procurement.purchase_order_lines pol
WHERE isl.purchase_order_line_id = pol.id
  AND pol.sku IS NOT NULL
  AND BTRIM(pol.sku) <> ''
  AND (
    isl.sku IS NULL
    OR BTRIM(isl.sku) = ''
    OR BTRIM(isl.sku) = '-'
  );
