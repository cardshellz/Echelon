-- Give operators a state-first pricing model with optional ZIP-prefix
-- overrides. The rating core still uses compact internal area keys so rate
-- selection, transit lookups, and quote snapshots remain compatible.

CREATE UNIQUE INDEX IF NOT EXISTS shipping_zone_rules_active_geography_idx
  ON shipping.zone_rules (
    zone_set_id,
    origin_warehouse_id,
    destination_country,
    COALESCE(destination_region, ''),
    COALESCE(postal_prefix, '')
  )
  WHERE is_active = TRUE;

INSERT INTO shipping.zone_sets (code, name, status, metadata)
VALUES (
  'retail-us-state-zip',
  'Retail US states and ZIP overrides',
  'active',
  '{"pricingGeography":"state_zip","country":"US"}'::jsonb
)
ON CONFLICT (code) DO NOTHING;

UPDATE shipping.rate_books
SET zone_set_id = (
      SELECT id FROM shipping.zone_sets WHERE code = 'retail-us-state-zip'
    ),
    metadata = COALESCE(metadata, '{}'::jsonb)
      || '{"pricingGeography":"state_zip","country":"US"}'::jsonb,
    updated_at = now()
WHERE code = 'shopify-retail-default';

-- Seed one internal pricing area per USPS state/territory abbreviation for
-- every warehouse. Imports add more-specific ZIP-prefix areas only when an
-- operator supplies an override.
INSERT INTO shipping.zone_rules (
  zone_set_id,
  origin_warehouse_id,
  destination_country,
  destination_region,
  postal_prefix,
  zone,
  priority,
  is_active
)
SELECT
  zs.id,
  w.id,
  'US',
  regions.code,
  NULL,
  'US-' || regions.code,
  0,
  TRUE
FROM shipping.zone_sets zs
CROSS JOIN warehouse.warehouses w
CROSS JOIN (VALUES
  ('AL'), ('AK'), ('AZ'), ('AR'), ('CA'), ('CO'), ('CT'), ('DE'), ('FL'), ('GA'),
  ('HI'), ('ID'), ('IL'), ('IN'), ('IA'), ('KS'), ('KY'), ('LA'), ('ME'), ('MD'),
  ('MA'), ('MI'), ('MN'), ('MS'), ('MO'), ('MT'), ('NE'), ('NV'), ('NH'), ('NJ'),
  ('NM'), ('NY'), ('NC'), ('ND'), ('OH'), ('OK'), ('OR'), ('PA'), ('RI'), ('SC'),
  ('SD'), ('TN'), ('TX'), ('UT'), ('VT'), ('VA'), ('WA'), ('WV'), ('WI'), ('WY'),
  ('DC'), ('AS'), ('GU'), ('MP'), ('PR'), ('VI')
) AS regions(code)
WHERE zs.code = 'retail-us-state-zip'
ON CONFLICT DO NOTHING;
