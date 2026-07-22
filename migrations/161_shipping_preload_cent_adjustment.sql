-- Apply the operator-approved one-cent reduction to the regional shipping
-- preload. Both executable rows and editor metadata must move together or a
-- later admin save could restore the old prices.

DO $$
DECLARE
  target_count integer;
BEGIN
  SELECT COUNT(*)::integer
    INTO target_count
  FROM shipping.rate_tables
  WHERE metadata ->> 'seedKey' = 'shopify-standard-regional-draft-2026-07-22-v1'
    AND metadata ->> 'preloadPriceAdjustmentCents' IS NULL;

  IF target_count > 1 THEN
    RAISE EXCEPTION
      'Expected at most one unadjusted regional shipping preload, found %',
      target_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM shipping.rate_tables
    WHERE metadata ->> 'seedKey' = 'shopify-standard-regional-draft-2026-07-22-v1'
      AND metadata ->> 'preloadPriceAdjustmentCents' IS NULL
      AND jsonb_typeof(metadata #> '{draftLayout,groups}') IS DISTINCT FROM 'array'
  ) THEN
    RAISE EXCEPTION 'Regional shipping preload is missing its draft group layout';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM shipping.rate_tables rt
    CROSS JOIN LATERAL jsonb_array_elements(rt.metadata #> '{draftLayout,groups}') AS group_data(value)
    WHERE rt.metadata ->> 'seedKey' = 'shopify-standard-regional-draft-2026-07-22-v1'
      AND rt.metadata ->> 'preloadPriceAdjustmentCents' IS NULL
      AND jsonb_typeof(group_data.value -> 'bands') IS DISTINCT FROM 'array'
  ) THEN
    RAISE EXCEPTION 'Regional shipping preload contains an invalid band layout';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM shipping.rate_tables rt
    CROSS JOIN LATERAL jsonb_array_elements(rt.metadata #> '{draftLayout,groups}') AS group_data(value)
    CROSS JOIN LATERAL jsonb_array_elements(group_data.value -> 'bands') AS band_data(value)
    WHERE rt.metadata ->> 'seedKey' = 'shopify-standard-regional-draft-2026-07-22-v1'
      AND rt.metadata ->> 'preloadPriceAdjustmentCents' IS NULL
      AND (
        COALESCE(band_data.value ->> 'rateUsd', '') !~ '^[0-9]+(\.[0-9]{1,2})?$'
        OR (band_data.value ->> 'rateUsd')::numeric <= 0
      )
  ) THEN
    RAISE EXCEPTION 'Regional shipping preload contains an invalid band price';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM shipping.rate_table_rows rr
    JOIN shipping.rate_tables rt ON rt.id = rr.rate_table_id
    WHERE rt.metadata ->> 'seedKey' = 'shopify-standard-regional-draft-2026-07-22-v1'
      AND rt.metadata ->> 'preloadPriceAdjustmentCents' IS NULL
      AND rr.charge_model = 'fixed_band'
      AND rr.rate_cents <= 0
  ) THEN
    RAISE EXCEPTION 'Regional shipping preload contains a non-positive fixed-band rate';
  END IF;
END
$$;

WITH target_tables AS (
  SELECT id
  FROM shipping.rate_tables
  WHERE metadata ->> 'seedKey' = 'shopify-standard-regional-draft-2026-07-22-v1'
    AND metadata ->> 'preloadPriceAdjustmentCents' IS NULL
)
UPDATE shipping.rate_table_rows rr
SET rate_cents = rr.rate_cents - 1
FROM target_tables target
WHERE rr.rate_table_id = target.id
  AND rr.charge_model = 'fixed_band';

WITH target_tables AS (
  SELECT id, metadata
  FROM shipping.rate_tables
  WHERE metadata ->> 'seedKey' = 'shopify-standard-regional-draft-2026-07-22-v1'
    AND metadata ->> 'preloadPriceAdjustmentCents' IS NULL
),
adjusted_layouts AS (
  SELECT
    target.id,
    jsonb_agg(
      jsonb_set(
        group_data.value,
        '{bands}',
        (
          SELECT jsonb_agg(
            jsonb_set(
              band_data.value,
              '{rateUsd}',
              to_jsonb(
                to_char(
                  (band_data.value ->> 'rateUsd')::numeric - 0.01,
                  'FM999999990.00'
                )
              ),
              false
            )
            ORDER BY band_data.ordinality
          )
          FROM jsonb_array_elements(group_data.value -> 'bands')
            WITH ORDINALITY AS band_data(value, ordinality)
        ),
        false
      )
      ORDER BY group_data.ordinality
    ) AS groups
  FROM target_tables target
  CROSS JOIN LATERAL jsonb_array_elements(target.metadata #> '{draftLayout,groups}')
    WITH ORDINALITY AS group_data(value, ordinality)
  GROUP BY target.id
)
UPDATE shipping.rate_tables rt
SET metadata = jsonb_set(
  jsonb_set(rt.metadata, '{draftLayout,groups}', adjusted.groups, false),
  '{preloadPriceAdjustmentCents}',
  to_jsonb(-1),
  true
)
FROM adjusted_layouts adjusted
WHERE rt.id = adjusted.id;
