-- Shared shipping rate books (expand phase).
--
-- Existing shipping tables become the default Shopify/internal retail book.
-- Dropship rates are intentionally NOT copied or activated here; the live
-- dropship provider remains authoritative until a later dual-run proves parity.

CREATE TABLE shipping.zone_sets (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code VARCHAR(80) NOT NULL,
  name VARCHAR(160) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_zone_set_status_chk CHECK (status IN ('draft', 'active', 'retired'))
);

CREATE UNIQUE INDEX shipping_zone_set_code_idx
  ON shipping.zone_sets(code);

INSERT INTO shipping.zone_sets (code, name, status, metadata)
VALUES (
  'retail-us-default',
  'Retail US default zones',
  'active',
  '{"source":"shipping-zone-rules-backfill","migration":137}'::jsonb
);

ALTER TABLE shipping.zone_rules
  ADD COLUMN zone_set_id INTEGER REFERENCES shipping.zone_sets(id) ON DELETE CASCADE;

UPDATE shipping.zone_rules
SET zone_set_id = (
  SELECT id FROM shipping.zone_sets WHERE code = 'retail-us-default'
)
WHERE zone_set_id IS NULL;

DROP INDEX IF EXISTS shipping.shipping_zone_rules_lookup_idx;
CREATE INDEX shipping_zone_rules_lookup_idx
  ON shipping.zone_rules(zone_set_id, origin_warehouse_id, destination_country, postal_prefix, is_active);

CREATE TABLE shipping.rate_books (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code VARCHAR(80) NOT NULL,
  name VARCHAR(160) NOT NULL,
  zone_set_id INTEGER NOT NULL REFERENCES shipping.zone_sets(id) ON DELETE RESTRICT,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_rate_book_status_chk CHECK (status IN ('draft', 'active', 'retired'))
);

CREATE UNIQUE INDEX shipping_rate_book_code_idx
  ON shipping.rate_books(code);

INSERT INTO shipping.rate_books (code, name, zone_set_id, status, metadata)
SELECT
  'shopify-retail-default',
  'Shopify retail default',
  id,
  'active',
  '{"source":"shipping-rate-tables-backfill","migration":137}'::jsonb
FROM shipping.zone_sets
WHERE code = 'retail-us-default';

ALTER TABLE shipping.rate_tables
  ADD COLUMN rate_book_id INTEGER REFERENCES shipping.rate_books(id) ON DELETE RESTRICT;

UPDATE shipping.rate_tables
SET rate_book_id = (
  SELECT id FROM shipping.rate_books WHERE code = 'shopify-retail-default'
)
WHERE rate_book_id IS NULL;

DROP INDEX IF EXISTS shipping.shipping_rate_table_carrier_service_idx;
CREATE INDEX shipping_rate_table_carrier_service_idx
  ON shipping.rate_tables(rate_book_id, carrier, service_code, status);

CREATE TABLE shipping.rate_book_assignments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_book_id INTEGER NOT NULL REFERENCES shipping.rate_books(id) ON DELETE RESTRICT,
  pricing_channel VARCHAR(40) NOT NULL,
  rate_purpose VARCHAR(60) NOT NULL,
  origin_warehouse_id INTEGER REFERENCES warehouse.warehouses(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One channel-wide assignment and, optionally, one override per warehouse.
-- This gives deterministic specificity without an operator-entered priority.
CREATE UNIQUE INDEX shipping_rate_book_assignment_global_idx
  ON shipping.rate_book_assignments(pricing_channel, rate_purpose)
  WHERE is_active = TRUE AND origin_warehouse_id IS NULL;

CREATE UNIQUE INDEX shipping_rate_book_assignment_warehouse_idx
  ON shipping.rate_book_assignments(pricing_channel, rate_purpose, origin_warehouse_id)
  WHERE is_active = TRUE AND origin_warehouse_id IS NOT NULL;

INSERT INTO shipping.rate_book_assignments (
  rate_book_id,
  pricing_channel,
  rate_purpose,
  origin_warehouse_id,
  is_active
)
SELECT
  book.id,
  channel.pricing_channel,
  'customer_checkout',
  NULL,
  TRUE
FROM shipping.rate_books book
CROSS JOIN (VALUES ('shopify'), ('internal')) AS channel(pricing_channel)
WHERE book.code = 'shopify-retail-default';

