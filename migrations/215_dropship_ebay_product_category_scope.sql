-- eBay marketplace browse categories are product/listing data, not store-wide
-- connection configuration. Existing configs created before this migration
-- required a single categoryId for every product; remove that invalid gate and
-- require the canonical catalog product mapping instead.

UPDATE dropship.dropship_store_listing_configs
SET required_config_keys = COALESCE(
      (
        SELECT jsonb_agg(value ORDER BY ordinal_position)
        FROM jsonb_array_elements_text(required_config_keys)
          WITH ORDINALITY AS existing(value, ordinal_position)
        WHERE value <> 'categoryId'
      ),
      '[]'::jsonb
    ),
    required_product_fields = CASE
      WHEN required_product_fields @> '["ebayBrowseCategoryId"]'::jsonb
        THEN required_product_fields
      ELSE required_product_fields || '["ebayBrowseCategoryId"]'::jsonb
    END,
    updated_at = NOW()
WHERE platform = 'ebay';

CREATE TABLE IF NOT EXISTS dropship.dropship_ebay_store_category_assignment_revisions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  store_category_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  store_category_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  actor_type varchar(40) NOT NULL,
  actor_id varchar(255),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT dropship_ebay_store_category_revision_actor_chk
    CHECK (actor_type IN ('vendor', 'admin', 'system')),
  CONSTRAINT dropship_ebay_store_category_revision_ids_chk
    CHECK (
      jsonb_typeof(store_category_ids) = 'array'
      AND jsonb_array_length(store_category_ids) BETWEEN 0 AND 2
    ),
  CONSTRAINT dropship_ebay_store_category_revision_names_chk
    CHECK (
      jsonb_typeof(store_category_names) = 'array'
      AND jsonb_array_length(store_category_names) = jsonb_array_length(store_category_ids)
    ),
  CONSTRAINT dropship_ebay_store_category_revision_idem_uk
    UNIQUE (vendor_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS dropship_ebay_store_category_revision_target_idx
  ON dropship.dropship_ebay_store_category_assignment_revisions
    (store_connection_id, product_variant_id, created_at);

CREATE TABLE IF NOT EXISTS dropship.dropship_ebay_store_category_assignments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  revision_id integer NOT NULL REFERENCES dropship.dropship_ebay_store_category_assignment_revisions(id),
  store_category_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  store_category_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT dropship_ebay_store_category_assignment_target_uk
    UNIQUE (store_connection_id, product_variant_id),
  CONSTRAINT dropship_ebay_store_category_assignment_ids_chk
    CHECK (
      jsonb_typeof(store_category_ids) = 'array'
      AND jsonb_array_length(store_category_ids) BETWEEN 1 AND 2
    ),
  CONSTRAINT dropship_ebay_store_category_assignment_names_chk
    CHECK (
      jsonb_typeof(store_category_names) = 'array'
      AND jsonb_array_length(store_category_names) = jsonb_array_length(store_category_ids)
    )
);

CREATE INDEX IF NOT EXISTS dropship_ebay_store_category_assignment_vendor_idx
  ON dropship.dropship_ebay_store_category_assignments
    (vendor_id, store_connection_id);
