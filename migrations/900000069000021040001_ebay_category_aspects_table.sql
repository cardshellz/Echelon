-- The aspects (item specifics) eBay defines per category. Production has this
-- table only because the legacy schema fallback in server/db.ts created it; no
-- tracked migration declared it. The fallback block is retired in the same
-- change (REFACTOR-PLAN P4.1).
--
-- Both statements are IF NOT EXISTS: in production the table and index already
-- exist with these definitions, so this changes nothing there.
--
-- The same fallback block also created ebay.ebay_type_aspect_defaults,
-- ebay.ebay_product_aspect_overrides and channels.channel_pricing_rules. They
-- are deliberately not declared here: *_listing_intent_propagation.sql, which
-- runs before this file, refuses to run unless they already exist, so creating
-- them here could never take effect (and would leave them without the triggers
-- that migration attaches).

CREATE TABLE IF NOT EXISTS ebay.ebay_category_aspects (
  id SERIAL PRIMARY KEY,
  category_id VARCHAR(20) NOT NULL,
  aspect_name VARCHAR(200) NOT NULL,
  aspect_required BOOLEAN NOT NULL DEFAULT false,
  aspect_mode VARCHAR(20) NOT NULL DEFAULT 'FREE_TEXT',
  aspect_usage VARCHAR(20) NOT NULL DEFAULT 'RECOMMENDED',
  aspect_values JSONB,
  aspect_order INT NOT NULL DEFAULT 0,
  fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (category_id, aspect_name)
);

CREATE INDEX IF NOT EXISTS idx_ebay_cat_aspects_cat
  ON ebay.ebay_category_aspects (category_id);
