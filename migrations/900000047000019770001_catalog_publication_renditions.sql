-- A rendition is a separate immutable version, never a replacement for the
-- Catalog original. Both hashes remain reachable for audits and pinned plans.
CREATE TABLE catalog.product_asset_renditions (
  asset_id integer NOT NULL,
  product_id integer NOT NULL CHECK (product_id > 0),
  product_variant_id integer CHECK (product_variant_id > 0),
  source_hash text NOT NULL,
  source_longest_side integer NOT NULL CHECK (source_longest_side BETWEEN 1 AND 499),
  profile text NOT NULL CHECK (profile IN ('minimum-500-v1')),
  rendition_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (asset_id, source_hash, profile),
  FOREIGN KEY (asset_id, source_hash) REFERENCES catalog.product_asset_versions(asset_id, content_hash),
  FOREIGN KEY (asset_id, rendition_hash) REFERENCES catalog.product_asset_versions(asset_id, content_hash)
);
CREATE TRIGGER publication_image_renditions_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON catalog.product_asset_renditions
FOR EACH STATEMENT EXECUTE FUNCTION catalog.reject_publication_image_version_mutation();

-- A new rendition can change the selected image even when the original bytes
-- are unchanged. The existing listing-intent owner handles the resulting work.
CREATE TRIGGER listing_intent_invalidation
AFTER INSERT ON catalog.product_asset_renditions FOR EACH ROW
EXECUTE FUNCTION marketplace.capture_listing_intent_change(
  'asset', 'asset_id,product_id,product_variant_id,source_hash,source_longest_side,profile,rendition_hash',
  'asset_id,product_id,product_variant_id', ''
);
