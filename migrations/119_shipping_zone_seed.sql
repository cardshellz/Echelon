-- Seed shipping.zone_rules with the v1 zone model decided in the design
-- walkthrough (docs/SHIPPING-ENGINE-DESIGN.md): lower-48 rates come from
-- local tables under a single 'US-48' zone; HI/AK/PR (+VI) are 'US-HIPRAK'
-- and get live-rated at checkout with the table rows as timeout fallback.
-- Matches Parcelify's existing Domestic-49 + HIPRAK split, so customer-facing
-- behavior carries over. Finer zone granularity (USPS zones 1-9) can be added
-- later when calibration data justifies it — resolveZone picks the longest
-- matching prefix, so more-specific rules layer on top without removing these.
--
-- Seeded for EVERY warehouse (multi-origin model). Idempotent via NOT EXISTS.

-- Country-wide default: continental US.
INSERT INTO shipping.zone_rules (origin_warehouse_id, destination_country, postal_prefix, zone, priority, is_active)
SELECT w.id, 'US', NULL, 'US-48', 0, TRUE
FROM warehouse.warehouses w
WHERE NOT EXISTS (
  SELECT 1 FROM shipping.zone_rules z
  WHERE z.origin_warehouse_id = w.id
    AND z.destination_country = 'US'
    AND z.postal_prefix IS NULL
    AND z.zone = 'US-48'
);

-- Non-continental prefixes → US-HIPRAK (higher priority is only a tiebreak;
-- prefix specificity already wins in resolveZone).
--   AK: 995-999 · HI: 967-968 · PR: 006, 007, 009 · VI: 008
INSERT INTO shipping.zone_rules (origin_warehouse_id, destination_country, destination_region, postal_prefix, zone, priority, is_active)
SELECT w.id, 'US', p.region, p.prefix, 'US-HIPRAK', 10, TRUE
FROM warehouse.warehouses w
CROSS JOIN (VALUES
  ('AK', '995'), ('AK', '996'), ('AK', '997'), ('AK', '998'), ('AK', '999'),
  ('HI', '967'), ('HI', '968'),
  ('PR', '006'), ('PR', '007'), ('PR', '009'),
  ('VI', '008')
) AS p(region, prefix)
WHERE NOT EXISTS (
  SELECT 1 FROM shipping.zone_rules z
  WHERE z.origin_warehouse_id = w.id
    AND z.destination_country = 'US'
    AND z.postal_prefix = p.prefix
    AND z.zone = 'US-HIPRAK'
);
