-- Migration 139 seeded state/territory zone rules for the state-and-ZIP
-- pricing model but omitted military postal regions. Direct rate-table
-- selection can still quote AA/AE/AP, so the omission only surfaced as a
-- NULL resolved_zone in quote evidence. Seed the missing observability rules
-- idempotently for every existing warehouse.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM shipping.zone_sets
    WHERE code = 'retail-us-state-zip'
  ) THEN
    RAISE EXCEPTION 'retail-us-state-zip zone set is required before military zone rules can be seeded';
  END IF;
END
$$;

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
  ('AA'),
  ('AE'),
  ('AP')
) AS regions(code)
WHERE zs.code = 'retail-us-state-zip'
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM warehouse.warehouses w
    CROSS JOIN (VALUES ('AA'), ('AE'), ('AP')) AS regions(code)
    WHERE NOT EXISTS (
      SELECT 1
      FROM shipping.zone_rules zr
      INNER JOIN shipping.zone_sets zs ON zs.id = zr.zone_set_id
      WHERE zs.code = 'retail-us-state-zip'
        AND zr.origin_warehouse_id = w.id
        AND zr.destination_country = 'US'
        AND zr.destination_region = regions.code
        AND zr.postal_prefix IS NULL
        AND zr.zone = 'US-' || regions.code
        AND zr.is_active = TRUE
    )
  ) THEN
    RAISE EXCEPTION 'military zone rules were not seeded for every warehouse';
  END IF;
END
$$;
