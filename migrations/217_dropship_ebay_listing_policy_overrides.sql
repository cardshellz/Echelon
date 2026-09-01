-- Store listing configuration supplies eBay business-policy defaults. Vendors
-- may override those defaults for one product variant in one connected store.
-- Every change is revisioned so the effective listing policy is auditable.

CREATE TABLE IF NOT EXISTS dropship.dropship_ebay_listing_policy_override_revisions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  fulfillment_policy_id varchar(100),
  return_policy_id varchar(100),
  payment_policy_id varchar(100),
  actor_type varchar(40) NOT NULL,
  actor_id varchar(255),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT dropship_ebay_listing_policy_override_revision_actor_chk
    CHECK (actor_type IN ('vendor', 'admin', 'system')),
  CONSTRAINT dropship_ebay_listing_policy_override_revision_fulfillment_chk
    CHECK (fulfillment_policy_id IS NULL OR btrim(fulfillment_policy_id) <> ''),
  CONSTRAINT dropship_ebay_listing_policy_override_revision_return_chk
    CHECK (return_policy_id IS NULL OR btrim(return_policy_id) <> ''),
  CONSTRAINT dropship_ebay_listing_policy_override_revision_payment_chk
    CHECK (payment_policy_id IS NULL OR btrim(payment_policy_id) <> ''),
  CONSTRAINT dropship_ebay_listing_policy_override_revision_idem_uk
    UNIQUE (vendor_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS dropship_ebay_listing_policy_override_revision_target_idx
  ON dropship.dropship_ebay_listing_policy_override_revisions
    (store_connection_id, product_variant_id, created_at);

CREATE TABLE IF NOT EXISTS dropship.dropship_ebay_listing_policy_overrides (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  revision_id integer NOT NULL REFERENCES dropship.dropship_ebay_listing_policy_override_revisions(id),
  fulfillment_policy_id varchar(100),
  return_policy_id varchar(100),
  payment_policy_id varchar(100),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT dropship_ebay_listing_policy_override_target_uk
    UNIQUE (store_connection_id, product_variant_id),
  CONSTRAINT dropship_ebay_listing_policy_override_nonempty_chk
    CHECK (
      fulfillment_policy_id IS NOT NULL
      OR return_policy_id IS NOT NULL
      OR payment_policy_id IS NOT NULL
    ),
  CONSTRAINT dropship_ebay_listing_policy_override_fulfillment_chk
    CHECK (fulfillment_policy_id IS NULL OR btrim(fulfillment_policy_id) <> ''),
  CONSTRAINT dropship_ebay_listing_policy_override_return_chk
    CHECK (return_policy_id IS NULL OR btrim(return_policy_id) <> ''),
  CONSTRAINT dropship_ebay_listing_policy_override_payment_chk
    CHECK (payment_policy_id IS NULL OR btrim(payment_policy_id) <> '')
);

CREATE INDEX IF NOT EXISTS dropship_ebay_listing_policy_override_vendor_idx
  ON dropship.dropship_ebay_listing_policy_overrides
    (vendor_id, store_connection_id);
