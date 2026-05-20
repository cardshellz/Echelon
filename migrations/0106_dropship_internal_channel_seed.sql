-- Seed the static internal channel used to tag dropship order intake rows.
-- This is not a marketplace integration; eBay and Shopify vendor stores connect
-- through dropship_store_connections.

INSERT INTO channels.channels
  (name, type, provider, status, shipping_config, created_at, updated_at)
SELECT
  'Dropship OMS', 'internal', 'manual', 'active', '{}'::jsonb, now(), now()
WHERE NOT EXISTS (
  SELECT 1
  FROM channels.channels
  WHERE LOWER(name) = LOWER('Dropship OMS')
    AND type = 'internal'
    AND provider = 'manual'
);

UPDATE channels.channels
SET status = 'active',
    shipping_config = jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(shipping_config, '{}'::jsonb),
              '{dropship}',
              COALESCE(
                CASE
                  WHEN jsonb_typeof(shipping_config -> 'dropship') = 'object'
                    THEN shipping_config -> 'dropship'
                  ELSE NULL
                END,
                '{}'::jsonb
              ),
              true
            ),
            '{dropship,role}',
            to_jsonb('oms'::text),
            true
          ),
          '{dropship,omsChannel}',
          'true'::jsonb,
          true
        ),
        '{dropship,configuredAt}',
        to_jsonb(now()::text),
        true
      ),
      '{dropship,configuredBy}',
      to_jsonb('migration_0106'::text),
      true
    ),
    updated_at = now()
WHERE id = (
  SELECT id
  FROM channels.channels
  WHERE LOWER(name) = LOWER('Dropship OMS')
    AND type = 'internal'
    AND provider = 'manual'
  ORDER BY id ASC
  LIMIT 1
);
