-- Product photos may be shared (NULL variant) or belong to a variant of that
-- same product. Independent FKs previously allowed cross-product links, making
-- photos visible in the product gallery but invisible to every listing SKU.
-- Preserve existing rows for explicit, audited repair; do not guess ownership.
ALTER TABLE catalog.product_assets
  ADD CONSTRAINT product_assets_variant_product_fk
  FOREIGN KEY (product_variant_id, product_id)
  REFERENCES catalog.product_variants (id, product_id)
  ON DELETE CASCADE NOT VALID;
