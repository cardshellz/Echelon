BEGIN;

CREATE TABLE IF NOT EXISTS channels.channel_variant_availability_sync (
  channel_id INTEGER NOT NULL
    REFERENCES channels.channels(id) ON DELETE CASCADE,
  product_variant_id INTEGER NOT NULL
    REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  desired_active BOOLEAN NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_synced_quantity INTEGER,
  last_synced_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (channel_id, product_variant_id),
  CONSTRAINT channel_variant_availability_sync_revision_chk
    CHECK (revision > 0),
  CONSTRAINT channel_variant_availability_sync_attempt_chk
    CHECK (attempt_count >= 0),
  CONSTRAINT channel_variant_availability_sync_status_chk
    CHECK (status IN ('pending', 'processing', 'retryable', 'synced')),
  CONSTRAINT channel_variant_availability_sync_quantity_chk
    CHECK (last_synced_quantity IS NULL OR last_synced_quantity >= 0),
  CONSTRAINT channel_variant_availability_sync_lease_chk
    CHECK (
      (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR
      (status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
    )
);

COMMENT ON TABLE channels.channel_variant_availability_sync IS
  'Durable desired-state queue for propagating catalog product_variants.is_active changes to marketplace availability.';
COMMENT ON COLUMN channels.channel_variant_availability_sync.desired_active IS
  'Exact catalog is_active value captured by the database trigger. False always resolves to marketplace quantity zero.';
COMMENT ON COLUMN channels.channel_variant_availability_sync.revision IS
  'Monotonic per channel/variant revision used to prevent a stale worker from acknowledging a newer transition.';

CREATE INDEX IF NOT EXISTS idx_channel_variant_availability_sync_due
  ON channels.channel_variant_availability_sync(next_attempt_at, updated_at, channel_id, product_variant_id)
  WHERE status IN ('pending', 'retryable', 'processing');

CREATE INDEX IF NOT EXISTS idx_channel_variant_availability_sync_status
  ON channels.channel_variant_availability_sync(status, updated_at DESC);

CREATE OR REPLACE FUNCTION channels.enqueue_variant_availability_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
    RETURN NEW;
  END IF;

  INSERT INTO channels.channel_variant_availability_sync (
    channel_id,
    product_variant_id,
    desired_active,
    revision,
    status,
    attempt_count,
    next_attempt_at,
    created_at,
    updated_at
  )
  SELECT
    channel_row.id,
    NEW.id,
    NEW.is_active,
    1,
    'pending',
    0,
    transaction_timestamp(),
    transaction_timestamp(),
    transaction_timestamp()
  FROM channels.channels AS channel_row
  WHERE lower(channel_row.provider) = 'ebay'
    AND (
      EXISTS (
        SELECT 1
        FROM channels.channel_feeds AS feed_row
        WHERE feed_row.channel_id = channel_row.id
          AND feed_row.product_variant_id = NEW.id
      )
      OR EXISTS (
        SELECT 1
        FROM channels.channel_listings AS listing_row
        WHERE listing_row.channel_id = channel_row.id
          AND listing_row.product_variant_id = NEW.id
      )
    )
  ON CONFLICT (channel_id, product_variant_id)
  DO UPDATE SET
    desired_active = EXCLUDED.desired_active,
    revision = channels.channel_variant_availability_sync.revision + 1,
    status = 'pending',
    attempt_count = 0,
    next_attempt_at = transaction_timestamp(),
    lease_token = NULL,
    lease_expires_at = NULL,
    completed_at = NULL,
    last_error = NULL,
    updated_at = transaction_timestamp();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_variants_enqueue_availability_sync
  ON catalog.product_variants;

CREATE TRIGGER product_variants_enqueue_availability_sync
AFTER UPDATE OF is_active ON catalog.product_variants
FOR EACH ROW
WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active)
EXECUTE FUNCTION channels.enqueue_variant_availability_sync();

-- Mapping creation is another availability boundary. If an eBay feed/listing
-- is created after a variant is already inactive, enqueue its current state so
-- that the new remote mapping cannot remain accidentally purchasable.
CREATE OR REPLACE FUNCTION channels.enqueue_mapped_variant_availability_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  current_active BOOLEAN;
BEGIN
  SELECT variant_row.is_active
  INTO current_active
  FROM catalog.product_variants AS variant_row
  JOIN channels.channels AS channel_row
    ON channel_row.id = NEW.channel_id
   AND lower(channel_row.provider) = 'ebay'
  WHERE variant_row.id = NEW.product_variant_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- markVariantAvailabilitySynced may restore a missing listing row inside the
  -- worker transaction. Do not supersede that worker's own matching claim.
  IF EXISTS (
    SELECT 1
    FROM channels.channel_variant_availability_sync AS availability
    WHERE availability.channel_id = NEW.channel_id
      AND availability.product_variant_id = NEW.product_variant_id
      AND availability.desired_active = current_active
      AND availability.status = 'processing'
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO channels.channel_variant_availability_sync (
    channel_id,
    product_variant_id,
    desired_active,
    revision,
    status,
    attempt_count,
    next_attempt_at,
    created_at,
    updated_at
  ) VALUES (
    NEW.channel_id,
    NEW.product_variant_id,
    current_active,
    1,
    'pending',
    0,
    transaction_timestamp(),
    transaction_timestamp(),
    transaction_timestamp()
  )
  ON CONFLICT (channel_id, product_variant_id)
  DO UPDATE SET
    desired_active = EXCLUDED.desired_active,
    revision = channels.channel_variant_availability_sync.revision + 1,
    status = 'pending',
    attempt_count = 0,
    next_attempt_at = transaction_timestamp(),
    lease_token = NULL,
    lease_expires_at = NULL,
    completed_at = NULL,
    last_error = NULL,
    updated_at = transaction_timestamp();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channel_feeds_enqueue_availability_sync_insert
  ON channels.channel_feeds;
CREATE TRIGGER channel_feeds_enqueue_availability_sync_insert
AFTER INSERT ON channels.channel_feeds
FOR EACH ROW
EXECUTE FUNCTION channels.enqueue_mapped_variant_availability_sync();

DROP TRIGGER IF EXISTS channel_feeds_enqueue_availability_sync_mapping_update
  ON channels.channel_feeds;
CREATE TRIGGER channel_feeds_enqueue_availability_sync_mapping_update
AFTER UPDATE OF channel_id, product_variant_id ON channels.channel_feeds
FOR EACH ROW
WHEN (
  OLD.channel_id IS DISTINCT FROM NEW.channel_id
  OR OLD.product_variant_id IS DISTINCT FROM NEW.product_variant_id
)
EXECUTE FUNCTION channels.enqueue_mapped_variant_availability_sync();

DROP TRIGGER IF EXISTS channel_listings_enqueue_availability_sync_insert
  ON channels.channel_listings;
CREATE TRIGGER channel_listings_enqueue_availability_sync_insert
AFTER INSERT ON channels.channel_listings
FOR EACH ROW
EXECUTE FUNCTION channels.enqueue_mapped_variant_availability_sync();

DROP TRIGGER IF EXISTS channel_listings_enqueue_availability_sync_mapping_update
  ON channels.channel_listings;
CREATE TRIGGER channel_listings_enqueue_availability_sync_mapping_update
AFTER UPDATE OF channel_id, product_variant_id ON channels.channel_listings
FOR EACH ROW
WHEN (
  OLD.channel_id IS DISTINCT FROM NEW.channel_id
  OR OLD.product_variant_id IS DISTINCT FROM NEW.product_variant_id
)
EXECUTE FUNCTION channels.enqueue_mapped_variant_availability_sync();

-- Existing inactive eBay mappings are authoritative unsellable variants under
-- the same rule. Seed them so deployment repairs any stale marketplace quantity
-- that predates this trigger. Repeated execution is idempotent.
INSERT INTO channels.channel_variant_availability_sync (
  channel_id,
  product_variant_id,
  desired_active,
  revision,
  status,
  attempt_count,
  next_attempt_at,
  created_at,
  updated_at
)
SELECT DISTINCT
  channel_row.id,
  variant_row.id,
  FALSE,
  1,
  'pending',
  0,
  transaction_timestamp(),
  transaction_timestamp(),
  transaction_timestamp()
FROM catalog.product_variants AS variant_row
JOIN channels.channels AS channel_row
  ON lower(channel_row.provider) = 'ebay'
WHERE variant_row.is_active = FALSE
  AND (
    EXISTS (
      SELECT 1
      FROM channels.channel_feeds AS feed_row
      WHERE feed_row.channel_id = channel_row.id
        AND feed_row.product_variant_id = variant_row.id
    )
    OR EXISTS (
      SELECT 1
      FROM channels.channel_listings AS listing_row
      WHERE listing_row.channel_id = channel_row.id
        AND listing_row.product_variant_id = variant_row.id
    )
  )
ON CONFLICT (channel_id, product_variant_id) DO NOTHING;

COMMIT;
