-- Transit matrix seed — carrier PUBLISHED service standards (conservative).
-- Design: docs/SHIPPING-ENGINE-DESIGN.md ("ETA" — ship date from the warehouse
-- cutoff + shipping.transit_matrix business days → min/max_delivery_date on
-- every checkout rate).
--
-- Seeds shipping.transit_matrix for EVERY warehouse (CROSS JOIN
-- warehouse.warehouses) so any warehouse that becomes a quote origin has a
-- starting estimate. source = 'carrier_standard' marks these as published
-- starting values; admin edits / the calibration loop overwrite them with
-- source = 'observed' rows later — the source column is the provenance flag.
--
-- Idempotent: NOT EXISTS guards on the natural key
-- (carrier, service_code, origin_warehouse_id, destination_zone), so re-runs
-- add nothing and rows already tuned by an admin are never clobbered.
--
-- Zones (match migration 119's zone taxonomy, but do NOT depend on its rows):
--   US-48      lower 48 contiguous states
--   US-HIPRAK  Hawaii / Alaska / Puerto Rico + other US territories
--
-- Published claims backing each estimate:
--   usps  / ground_advantage : USPS advertises 2-5 business days nationwide,
--                              including HI/AK/PR and territories.
--   usps  / priority_mail    : USPS advertises 1-3 business days nationwide,
--                              including HI/AK/PR and territories.
--   ups   / ground           : UPS Ground advertises 1-5 business days within
--                              the contiguous 48 states. HI/AK move on air
--                              products with different day-ranges, so no
--                              US-HIPRAK row is seeded (absent row = the rate
--                              simply goes out without delivery dates).
--   fedex / fedex_ground     : FedEx Ground advertises 1-5 business days
--                              within the contiguous 48 states. HI/AK ship
--                              FedEx Ground Economy/air with different
--                              timetables, so no US-HIPRAK row is seeded.

INSERT INTO shipping.transit_matrix
  (carrier, service_code, origin_warehouse_id, destination_zone, min_business_days, max_business_days, source)
SELECT
  s.carrier,
  s.service_code,
  w.id,
  s.destination_zone,
  s.min_business_days,
  s.max_business_days,
  'carrier_standard'
FROM warehouse.warehouses w
CROSS JOIN (
  VALUES
    -- USPS Ground Advantage: published 2-5 business days, all US destinations.
    ('usps',  'ground_advantage', 'US-48',     2, 5),
    ('usps',  'ground_advantage', 'US-HIPRAK', 2, 5),
    -- USPS Priority Mail: published 1-3 business days, all US destinations.
    ('usps',  'priority_mail',    'US-48',     1, 3),
    ('usps',  'priority_mail',    'US-HIPRAK', 1, 3),
    -- UPS Ground: published 1-5 business days, contiguous 48 only.
    ('ups',   'ground',           'US-48',     1, 5),
    -- FedEx Ground: published 1-5 business days, contiguous 48 only.
    ('fedex', 'fedex_ground',     'US-48',     1, 5)
) AS s(carrier, service_code, destination_zone, min_business_days, max_business_days)
WHERE NOT EXISTS (
  SELECT 1
  FROM shipping.transit_matrix t
  WHERE t.carrier = s.carrier
    AND t.service_code = s.service_code
    AND t.origin_warehouse_id = w.id
    AND t.destination_zone = s.destination_zone
);
