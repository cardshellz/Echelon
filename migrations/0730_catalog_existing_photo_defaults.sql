-- The shared-photo importer fixed NEW photos only. Existing imported photos
-- still carried variant links, so sibling SKUs could have no publishable photo.
-- Initialize those legacy photos to the requested all-variants default.
-- An assignment saved through Catalog's audited scope command is an explicit
-- exception, not an import default, and remains authoritative.

-- The migration executor owns the transaction. Block concurrent gallery writes
-- and FOR UPDATE editors until both the scope and its audit record commit.
-- Plain gallery reads remain available. No marketplace calls occur here.
LOCK TABLE catalog.product_assets IN EXCLUSIVE MODE;

WITH legacy_photos AS MATERIALIZED (
  SELECT asset.id, asset.product_id, asset.product_variant_id
  FROM catalog.product_assets asset
  WHERE asset.asset_type = 'image' AND asset.product_variant_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.audit_events event
      WHERE event.action = 'catalog.asset.scope_changed'
        AND event.target = 'catalog.product_assets:' || asset.id::text
        AND event.changes -> 'after' -> 'productId' = to_jsonb(asset.product_id)
        AND event.changes -> 'after' -> 'productVariantId' = to_jsonb(asset.product_variant_id)
    )
), shared_photos AS (
  UPDATE catalog.product_assets asset
  SET product_variant_id = NULL
  FROM legacy_photos legacy
  WHERE asset.id = legacy.id
  RETURNING asset.id, asset.product_id, legacy.product_variant_id AS previous_variant_id
)
INSERT INTO public.audit_events (actor, action, target, changes, context)
SELECT 'migration:0730_catalog_existing_photo_defaults', 'catalog.asset.shared_default_applied',
  'catalog.product_assets:' || photo.id::text,
  jsonb_build_object(
    'before', jsonb_build_object('productId', photo.product_id, 'productVariantId', photo.previous_variant_id),
    'after', jsonb_build_object('productId', photo.product_id, 'productVariantId', NULL)
  ),
  jsonb_build_object('migration', '0730_catalog_existing_photo_defaults.sql',
    'reason', 'Initialize existing photos to all variants; preserve audited variant choices')
FROM shared_photos photo
ORDER BY photo.id;
