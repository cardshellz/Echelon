-- Correct the canonical fulfillment model before production writers are cut over.
--
-- A shipping-engine order may combine multiple shipment requests, and one
-- physical package may therefore contain items from multiple OMS orders. The
-- item allocation is authoritative; the legacy direct request columns remain
-- nullable compatibility pointers only.

BEGIN;

-- A line may be physically shipped and later cancelled/refunded. Those are
-- independent historical facts, so their quantities must each remain bounded
-- by lifetime authority without incorrectly requiring their sum to fit inside
-- the original quantity.
ALTER TABLE wms.fulfillment_plan_lines
  DROP CONSTRAINT IF EXISTS fulfillment_plan_lines_quantity_chk;

ALTER TABLE wms.fulfillment_plan_lines
  ADD CONSTRAINT fulfillment_plan_lines_quantity_chk CHECK (
    quantity_planned > 0
    AND quantity_cancelled >= 0
    AND quantity_cancelled <= quantity_planned
    AND quantity_shipped >= 0
    AND quantity_shipped <= quantity_planned
  );

ALTER TABLE wms.shipping_engine_orders
  ADD COLUMN IF NOT EXISTS command_key VARCHAR(300);

UPDATE wms.shipping_engine_orders
SET command_key = 'shipping-order:legacy:v0:' || provider || ':' || id::text
WHERE command_key IS NULL;

ALTER TABLE wms.shipping_engine_orders
  ALTER COLUMN command_key SET NOT NULL,
  ALTER COLUMN shipment_request_id DROP NOT NULL;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT con.conname
  INTO constraint_name
  FROM pg_constraint con
  JOIN pg_attribute attr
    ON attr.attrelid = con.conrelid
   AND attr.attnum = ANY(con.conkey)
  WHERE con.contype = 'f'
    AND con.conrelid = 'wms.shipping_engine_orders'::regclass
    AND attr.attname = 'shipment_request_id'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE wms.shipping_engine_orders DROP CONSTRAINT %I',
      constraint_name
    );
  END IF;

  ALTER TABLE wms.shipping_engine_orders
    ADD CONSTRAINT shipping_engine_orders_shipment_request_fk
    FOREIGN KEY (shipment_request_id)
    REFERENCES wms.shipment_requests(id)
    ON DELETE SET NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_engine_orders_command_key
  ON wms.shipping_engine_orders(provider, command_key);

CREATE TABLE IF NOT EXISTS wms.shipping_engine_order_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipping_engine_order_id BIGINT NOT NULL
    REFERENCES wms.shipping_engine_orders(id) ON DELETE RESTRICT,
  shipment_request_id BIGINT NOT NULL
    REFERENCES wms.shipment_requests(id) ON DELETE RESTRICT,
  relationship_type VARCHAR(30) NOT NULL DEFAULT 'primary',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_engine_order_requests_relationship_chk CHECK (
    relationship_type IN ('primary', 'combined', 'split', 'reconciled')
  ),
  CONSTRAINT shipping_engine_order_requests_unique
    UNIQUE (shipping_engine_order_id, shipment_request_id)
);

INSERT INTO wms.shipping_engine_order_requests (
  shipping_engine_order_id,
  shipment_request_id,
  relationship_type
)
SELECT id, shipment_request_id, 'primary'
FROM wms.shipping_engine_orders
WHERE shipment_request_id IS NOT NULL
ON CONFLICT (shipping_engine_order_id, shipment_request_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_shipping_engine_order_requests_request
  ON wms.shipping_engine_order_requests(shipment_request_id, shipping_engine_order_id);

ALTER TABLE wms.physical_shipments
  ALTER COLUMN shipment_request_id DROP NOT NULL;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT con.conname
  INTO constraint_name
  FROM pg_constraint con
  JOIN pg_attribute attr
    ON attr.attrelid = con.conrelid
   AND attr.attnum = ANY(con.conkey)
  WHERE con.contype = 'f'
    AND con.conrelid = 'wms.physical_shipments'::regclass
    AND attr.attname = 'shipment_request_id'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE wms.physical_shipments DROP CONSTRAINT %I',
      constraint_name
    );
  END IF;

  ALTER TABLE wms.physical_shipments
    ADD CONSTRAINT physical_shipments_shipment_request_fk
    FOREIGN KEY (shipment_request_id)
    REFERENCES wms.shipment_requests(id)
    ON DELETE SET NULL;
END $$;

ALTER TABLE wms.physical_shipment_items
  ADD COLUMN IF NOT EXISTS legacy_wms_shipment_item_id INTEGER
    REFERENCES wms.outbound_shipment_items(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS shipment_item_purpose VARCHAR(30) NOT NULL
    DEFAULT 'customer_fulfillment',
  ADD COLUMN IF NOT EXISTS replacement_for_order_item_id INTEGER
    REFERENCES wms.order_items(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS product_variant_id INTEGER
    REFERENCES catalog.product_variants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sku VARCHAR(100);

UPDATE wms.physical_shipment_items AS physical_item
SET legacy_wms_shipment_item_id = request_item.legacy_wms_shipment_item_id,
    product_variant_id = plan_line.product_variant_id,
    sku = order_item.sku
FROM wms.shipment_request_items AS request_item
JOIN wms.order_items AS order_item ON order_item.id = request_item.wms_order_item_id
JOIN wms.fulfillment_plan_lines AS plan_line
  ON plan_line.id = request_item.fulfillment_plan_line_id
WHERE request_item.id = physical_item.shipment_request_item_id
  AND (
    physical_item.legacy_wms_shipment_item_id IS NULL
    OR physical_item.sku IS NULL
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM wms.physical_shipment_items
    WHERE NULLIF(BTRIM(sku), '') IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce physical shipment item SKU lineage: existing rows contain a blank SKU'
      USING ERRCODE = '23514';
  END IF;
END $$;

ALTER TABLE wms.physical_shipment_items
  ALTER COLUMN shipment_request_item_id DROP NOT NULL,
  ALTER COLUMN fulfillment_plan_line_id DROP NOT NULL,
  ALTER COLUMN wms_order_item_id DROP NOT NULL,
  ALTER COLUMN sku SET NOT NULL,
  DROP CONSTRAINT IF EXISTS physical_shipment_items_purpose_chk,
  DROP CONSTRAINT IF EXISTS physical_shipment_items_lineage_chk;

ALTER TABLE wms.physical_shipment_items
  ADD CONSTRAINT physical_shipment_items_purpose_chk CHECK (
    shipment_item_purpose IN ('customer_fulfillment', 'replacement', 'concession')
  ),
  ADD CONSTRAINT physical_shipment_items_lineage_chk CHECK (
    (
      shipment_item_purpose = 'customer_fulfillment'
      AND shipment_request_item_id IS NOT NULL
      AND fulfillment_plan_line_id IS NOT NULL
      AND wms_order_item_id IS NOT NULL
      AND replacement_for_order_item_id IS NULL
    )
    OR (
      shipment_item_purpose = 'replacement'
      AND shipment_request_item_id IS NULL
      AND fulfillment_plan_line_id IS NULL
      AND wms_order_item_id IS NULL
      AND replacement_for_order_item_id IS NOT NULL
    )
    OR (
      shipment_item_purpose = 'concession'
      AND shipment_request_item_id IS NULL
      AND fulfillment_plan_line_id IS NULL
      AND wms_order_item_id IS NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_physical_shipment_items_legacy_item
  ON wms.physical_shipment_items(legacy_wms_shipment_item_id)
  WHERE legacy_wms_shipment_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_physical_shipment_items_replacement_line
  ON wms.physical_shipment_items(replacement_for_order_item_id)
  WHERE replacement_for_order_item_id IS NOT NULL;

-- Physical shipment rows and allocations are permanent operational evidence.
-- Replace the shadow-schema delete actions before production writers cut over.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute attr
      ON attr.attrelid = con.conrelid
     AND attr.attnum = ANY(con.conkey)
    WHERE con.contype = 'f'
      AND con.conrelid = 'wms.physical_shipments'::regclass
      AND attr.attname = 'shipping_engine_order_id'
  LOOP
    EXECUTE format(
      'ALTER TABLE wms.physical_shipments DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;

  ALTER TABLE wms.physical_shipments
    ADD CONSTRAINT physical_shipments_shipping_engine_order_fk
    FOREIGN KEY (shipping_engine_order_id)
    REFERENCES wms.shipping_engine_orders(id)
    ON DELETE RESTRICT;

  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute attr
      ON attr.attrelid = con.conrelid
     AND attr.attnum = ANY(con.conkey)
    WHERE con.contype = 'f'
      AND con.conrelid = 'wms.physical_shipment_items'::regclass
      AND attr.attname = 'physical_shipment_id'
  LOOP
    EXECUTE format(
      'ALTER TABLE wms.physical_shipment_items DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;

  ALTER TABLE wms.physical_shipment_items
    ADD CONSTRAINT physical_shipment_items_physical_shipment_fk
    FOREIGN KEY (physical_shipment_id)
    REFERENCES wms.physical_shipments(id)
    ON DELETE RESTRICT;
END $$;

ALTER TABLE oms.channel_fulfillment_pushes
  ADD COLUMN IF NOT EXISTS channel_fulfillment_scope_key VARCHAR(200),
  ADD COLUMN IF NOT EXISTS command_key VARCHAR(400),
  ADD COLUMN IF NOT EXISTS request_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(200),
  ADD COLUMN IF NOT EXISTS carrier VARCHAR(100),
  ADD COLUMN IF NOT EXISTS tracking_url TEXT,
  ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS lease_token VARCHAR(100),
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error_code VARCHAR(100),
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS causation_id VARCHAR(100);

-- Commands and attempts are permanent fulfillment evidence. Cascading an OMS
-- order or physical package must never erase proof of what was sent to a sales
-- channel. Existing rows already satisfy these foreign keys; only the delete
-- action changes from CASCADE to RESTRICT.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute attr
      ON attr.attrelid = con.conrelid
     AND attr.attnum = ANY(con.conkey)
    WHERE con.contype = 'f'
      AND con.conrelid = 'oms.channel_fulfillment_pushes'::regclass
      AND attr.attname = 'oms_order_id'
  LOOP
    EXECUTE format(
      'ALTER TABLE oms.channel_fulfillment_pushes DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;

  ALTER TABLE oms.channel_fulfillment_pushes
    ADD CONSTRAINT channel_fulfillment_pushes_oms_order_fk
    FOREIGN KEY (oms_order_id)
    REFERENCES oms.oms_orders(id)
    ON DELETE RESTRICT;

  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute attr
      ON attr.attrelid = con.conrelid
     AND attr.attnum = ANY(con.conkey)
    WHERE con.contype = 'f'
      AND con.conrelid = 'oms.channel_fulfillment_pushes'::regclass
      AND attr.attname = 'physical_shipment_id'
  LOOP
    EXECUTE format(
      'ALTER TABLE oms.channel_fulfillment_pushes DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;

  ALTER TABLE oms.channel_fulfillment_pushes
    ADD CONSTRAINT channel_fulfillment_pushes_physical_shipment_fk
    FOREIGN KEY (physical_shipment_id)
    REFERENCES wms.physical_shipments(id)
    ON DELETE RESTRICT;
END $$;

UPDATE oms.channel_fulfillment_pushes
SET channel_fulfillment_scope_key = 'order'
WHERE channel_fulfillment_scope_key IS NULL;

UPDATE oms.channel_fulfillment_pushes
SET command_key =
  'fulfillment:legacy:v0:' || channel_provider || ':' || oms_order_id::text || ':' ||
  physical_shipment_id::text || ':' || channel_fulfillment_scope_key
WHERE command_key IS NULL;

UPDATE oms.channel_fulfillment_pushes
SET max_attempts = GREATEST(max_attempts, attempt_count, 1);

UPDATE oms.channel_fulfillment_pushes AS push
SET tracking_number = COALESCE(push.tracking_number, shipment.tracking_number),
    carrier = COALESCE(push.carrier, shipment.carrier),
    shipped_at = COALESCE(push.shipped_at, shipment.ship_date)
FROM wms.physical_shipments AS shipment
WHERE shipment.id = push.physical_shipment_id;

UPDATE oms.channel_fulfillment_pushes
SET completed_at = COALESCE(completed_at, updated_at, created_at)
WHERE push_status IN ('success', 'ignored');

ALTER TABLE oms.channel_fulfillment_pushes
  ALTER COLUMN channel_fulfillment_scope_key SET NOT NULL,
  ALTER COLUMN command_key SET NOT NULL;

ALTER TABLE oms.channel_fulfillment_pushes
  DROP CONSTRAINT IF EXISTS channel_fulfillment_pushes_unique_physical,
  DROP CONSTRAINT IF EXISTS channel_fulfillment_pushes_status_chk,
  DROP CONSTRAINT IF EXISTS channel_fulfillment_pushes_attempt_chk;

ALTER TABLE oms.channel_fulfillment_pushes
  ADD CONSTRAINT channel_fulfillment_pushes_status_chk CHECK (
    push_status IN (
      'pending',
      'processing',
      'retry',
      'success',
      'failed',
      'ignored',
      'review',
      'dead'
    )
  ),
  ADD CONSTRAINT channel_fulfillment_pushes_attempt_chk CHECK (
    attempt_count >= 0 AND max_attempts > 0 AND attempt_count <= max_attempts
  ),
  ADD CONSTRAINT channel_fulfillment_pushes_lease_chk CHECK (
    (push_status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (push_status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  ADD CONSTRAINT channel_fulfillment_pushes_completion_chk CHECK (
    (push_status IN ('success', 'ignored', 'dead')) = (completed_at IS NOT NULL)
  ),
  ADD CONSTRAINT channel_fulfillment_pushes_request_hash_chk CHECK (
    request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT channel_fulfillment_pushes_v1_contract_chk CHECK (
    command_key NOT LIKE 'fulfillment:v1:%'
    OR (
      request_hash IS NOT NULL
      AND NULLIF(BTRIM(tracking_number), '') IS NOT NULL
      AND NULLIF(BTRIM(carrier), '') IS NOT NULL
      AND metadata->>'contractVersion' = '1'
      AND push_status <> 'failed'
    )
  );

DROP INDEX IF EXISTS oms.uq_channel_fulfillment_pushes_command;
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_fulfillment_pushes_command
  ON oms.channel_fulfillment_pushes(
    channel_provider,
    oms_order_id,
    physical_shipment_id,
    channel_fulfillment_scope_key
  )
  WHERE request_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_fulfillment_pushes_command_key
  ON oms.channel_fulfillment_pushes(command_key);

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_pushes_due
  ON oms.channel_fulfillment_pushes(next_attempt_at, id)
  WHERE push_status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_pushes_expired_lease
  ON oms.channel_fulfillment_pushes(lease_expires_at, id)
  WHERE push_status = 'processing';

ALTER TABLE oms.channel_fulfillment_push_items
  ADD COLUMN IF NOT EXISTS physical_shipment_item_id BIGINT
    REFERENCES wms.physical_shipment_items(id) ON DELETE RESTRICT;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute attr
      ON attr.attrelid = con.conrelid
     AND attr.attnum = ANY(con.conkey)
    WHERE con.contype = 'f'
      AND con.conrelid = 'oms.channel_fulfillment_push_items'::regclass
      AND attr.attname = 'channel_fulfillment_push_id'
  LOOP
    EXECUTE format(
      'ALTER TABLE oms.channel_fulfillment_push_items DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;

  ALTER TABLE oms.channel_fulfillment_push_items
    ADD CONSTRAINT channel_fulfillment_push_items_command_fk
    FOREIGN KEY (channel_fulfillment_push_id)
    REFERENCES oms.channel_fulfillment_pushes(id)
    ON DELETE RESTRICT;
END $$;

ALTER TABLE oms.channel_fulfillment_push_items
  DROP CONSTRAINT IF EXISTS channel_fulfillment_push_items_unique_line;

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_fulfillment_push_items_physical_item
  ON oms.channel_fulfillment_push_items(
    channel_fulfillment_push_id,
    physical_shipment_item_id
  )
  WHERE physical_shipment_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_push_items_push_oms_line
  ON oms.channel_fulfillment_push_items(channel_fulfillment_push_id, oms_order_line_id);

CREATE OR REPLACE FUNCTION oms.validate_channel_fulfillment_push_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  command_row oms.channel_fulfillment_pushes%ROWTYPE;
  physical_row RECORD;
BEGIN
  SELECT * INTO command_row
  FROM oms.channel_fulfillment_pushes
  WHERE id = NEW.channel_fulfillment_push_id;

  IF command_row.command_key LIKE 'fulfillment:v1:%' THEN
    IF NEW.physical_shipment_item_id IS NULL THEN
      RAISE EXCEPTION 'v1 channel fulfillment items require physical shipment item lineage'
        USING ERRCODE = '23514';
    END IF;

    SELECT
      item.physical_shipment_id,
      line.oms_order_line_id
    INTO physical_row
    FROM wms.physical_shipment_items AS item
    JOIN wms.fulfillment_plan_lines AS line
      ON line.id = item.fulfillment_plan_line_id
    WHERE item.id = NEW.physical_shipment_item_id
      AND item.shipment_item_purpose = 'customer_fulfillment';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'channel fulfillment item does not reference a customer-fulfillment physical item'
        USING ERRCODE = '23514';
    END IF;

    IF physical_row.physical_shipment_id IS DISTINCT FROM command_row.physical_shipment_id
       OR physical_row.oms_order_line_id IS DISTINCT FROM NEW.oms_order_line_id THEN
      RAISE EXCEPTION 'channel fulfillment item lineage does not match its command or OMS line'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channel_fulfillment_push_item_lineage_guard
  ON oms.channel_fulfillment_push_items;
CREATE TRIGGER channel_fulfillment_push_item_lineage_guard
  BEFORE INSERT OR UPDATE ON oms.channel_fulfillment_push_items
  FOR EACH ROW EXECUTE FUNCTION oms.validate_channel_fulfillment_push_item();

CREATE TABLE IF NOT EXISTS oms.channel_fulfillment_push_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_fulfillment_push_id BIGINT NOT NULL
    REFERENCES oms.channel_fulfillment_pushes(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  outcome VARCHAR(30) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  provider_response_id VARCHAR(300),
  error_code VARCHAR(100),
  error_message VARCHAR(1000),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  correlation_id VARCHAR(100),
  causation_id VARCHAR(100),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT channel_fulfillment_push_attempts_number_chk CHECK (attempt_number > 0),
  CONSTRAINT channel_fulfillment_push_attempts_outcome_chk CHECK (
    outcome IN ('success', 'retry_scheduled', 'ignored', 'review_required', 'dead_lettered')
  ),
  CONSTRAINT channel_fulfillment_push_attempts_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT channel_fulfillment_push_attempts_time_chk CHECK (completed_at >= started_at),
  CONSTRAINT channel_fulfillment_push_attempts_unique
    UNIQUE (channel_fulfillment_push_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_push_attempts_push
  ON oms.channel_fulfillment_push_attempts(channel_fulfillment_push_id, attempt_number DESC);

CREATE TABLE IF NOT EXISTS oms.channel_fulfillment_receipts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_key VARCHAR(500) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  source_provider VARCHAR(40) NOT NULL,
  source_channel_id INTEGER REFERENCES channels.channels(id) ON DELETE RESTRICT,
  source_order_id VARCHAR(200) NOT NULL,
  source_fulfillment_id VARCHAR(200) NOT NULL,
  source_event_id VARCHAR(200),
  source_inbox_id INTEGER,
  event_kind VARCHAR(30) NOT NULL,
  source VARCHAR(80) NOT NULL,
  tracking_number VARCHAR(200),
  carrier VARCHAR(100),
  tracking_url TEXT,
  shipped_at TIMESTAMPTZ,
  processing_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token VARCHAR(100),
  lease_expires_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  oms_order_id BIGINT REFERENCES oms.oms_orders(id) ON DELETE RESTRICT,
  physical_shipment_id BIGINT REFERENCES wms.physical_shipments(id) ON DELETE RESTRICT,
  error_code VARCHAR(100),
  error_message TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id VARCHAR(100),
  causation_id VARCHAR(100),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT channel_fulfillment_receipts_key_unique UNIQUE (receipt_key),
  CONSTRAINT channel_fulfillment_receipts_hash_chk CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT channel_fulfillment_receipts_status_chk CHECK (
    processing_status IN ('pending', 'processing', 'processed', 'ignored', 'review')
  ),
  CONSTRAINT channel_fulfillment_receipts_attempt_chk CHECK (attempt_count >= 0),
  CONSTRAINT channel_fulfillment_receipts_lease_chk CHECK (
    (
      processing_status = 'processing'
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND last_attempt_at IS NOT NULL
    )
    OR (
      processing_status <> 'processing'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT channel_fulfillment_receipts_event_kind_chk CHECK (
    event_kind IN ('created', 'updated', 'reconciled')
  )
);

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_receipts_package
  ON oms.channel_fulfillment_receipts(
    source_provider,
    source_order_id,
    source_fulfillment_id
  );

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_receipts_status
  ON oms.channel_fulfillment_receipts(processing_status, created_at);

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_receipts_lease
  ON oms.channel_fulfillment_receipts(lease_expires_at)
  WHERE processing_status = 'processing';

CREATE TABLE IF NOT EXISTS oms.channel_fulfillment_receipt_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id BIGINT NOT NULL
    REFERENCES oms.channel_fulfillment_receipts(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  lease_token VARCHAR(100) NOT NULL,
  outcome VARCHAR(30) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  error_code VARCHAR(100),
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT channel_fulfillment_receipt_attempts_number_chk CHECK (attempt_number > 0),
  CONSTRAINT channel_fulfillment_receipt_attempts_outcome_chk CHECK (
    outcome IN ('processed', 'ignored', 'review', 'lease_expired')
  ),
  CONSTRAINT channel_fulfillment_receipt_attempts_time_chk CHECK (completed_at >= started_at),
  CONSTRAINT channel_fulfillment_receipt_attempts_unique UNIQUE (receipt_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_receipt_attempts_receipt
  ON oms.channel_fulfillment_receipt_attempts(receipt_id, attempt_number DESC);

CREATE TABLE IF NOT EXISTS oms.channel_fulfillment_receipt_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id BIGINT NOT NULL
    REFERENCES oms.channel_fulfillment_receipts(id) ON DELETE RESTRICT,
  source_fulfillment_line_id VARCHAR(200),
  channel_order_line_id VARCHAR(200) NOT NULL,
  quantity INTEGER NOT NULL,
  oms_order_line_id BIGINT REFERENCES oms.oms_order_lines(id) ON DELETE RESTRICT,
  wms_order_item_id INTEGER REFERENCES wms.order_items(id) ON DELETE RESTRICT,
  legacy_wms_shipment_item_id INTEGER
    REFERENCES wms.outbound_shipment_items(id) ON DELETE RESTRICT,
  physical_shipment_item_id BIGINT
    REFERENCES wms.physical_shipment_items(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT channel_fulfillment_receipt_items_quantity_chk CHECK (quantity > 0),
  CONSTRAINT channel_fulfillment_receipt_items_line_unique
    UNIQUE (receipt_id, channel_order_line_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_receipt_items_oms_line
  ON oms.channel_fulfillment_receipt_items(oms_order_line_id);

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_receipt_items_wms_line
  ON oms.channel_fulfillment_receipt_items(wms_order_item_id);

CREATE TABLE IF NOT EXISTS wms.physical_shipment_tracking_amendments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  physical_shipment_id BIGINT NOT NULL
    REFERENCES wms.physical_shipments(id) ON DELETE RESTRICT,
  provider VARCHAR(40) NOT NULL,
  provider_event_id VARCHAR(200),
  request_hash VARCHAR(64) NOT NULL,
  tracking_number VARCHAR(200),
  carrier VARCHAR(100),
  tracking_url TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  source VARCHAR(80) NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT physical_shipment_tracking_amendments_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT physical_shipment_tracking_amendments_hash_unique
    UNIQUE (physical_shipment_id, request_hash)
);

CREATE INDEX IF NOT EXISTS idx_physical_shipment_tracking_amendment_current
  ON wms.physical_shipment_tracking_amendments(
    physical_shipment_id,
    occurred_at DESC,
    id DESC
  );

CREATE OR REPLACE FUNCTION oms.reject_channel_fulfillment_attempt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS channel_fulfillment_push_attempts_immutable
  ON oms.channel_fulfillment_push_attempts;
CREATE TRIGGER channel_fulfillment_push_attempts_immutable
  BEFORE UPDATE OR DELETE ON oms.channel_fulfillment_push_attempts
  FOR EACH ROW EXECUTE FUNCTION oms.reject_channel_fulfillment_attempt_mutation();

DROP TRIGGER IF EXISTS channel_fulfillment_receipt_attempts_immutable
  ON oms.channel_fulfillment_receipt_attempts;
CREATE TRIGGER channel_fulfillment_receipt_attempts_immutable
  BEFORE UPDATE OR DELETE ON oms.channel_fulfillment_receipt_attempts
  FOR EACH ROW EXECUTE FUNCTION oms.reject_channel_fulfillment_attempt_mutation();

DROP TRIGGER IF EXISTS channel_fulfillment_push_items_immutable
  ON oms.channel_fulfillment_push_items;
CREATE TRIGGER channel_fulfillment_push_items_immutable
  BEFORE UPDATE OR DELETE ON oms.channel_fulfillment_push_items
  FOR EACH ROW EXECUTE FUNCTION oms.reject_channel_fulfillment_attempt_mutation();

CREATE OR REPLACE FUNCTION oms.channel_fulfillment_receipt_item_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'channel_fulfillment_receipt_items is permanent inbound evidence; DELETE is not allowed'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.physical_shipment_item_id IS NULL
     AND NEW.physical_shipment_item_id IS NOT NULL
     AND NEW.receipt_id IS NOT DISTINCT FROM OLD.receipt_id
     AND NEW.source_fulfillment_line_id IS NOT DISTINCT FROM OLD.source_fulfillment_line_id
     AND NEW.channel_order_line_id IS NOT DISTINCT FROM OLD.channel_order_line_id
     AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity
     AND NEW.oms_order_line_id IS NOT DISTINCT FROM OLD.oms_order_line_id
     AND NEW.wms_order_item_id IS NOT DISTINCT FROM OLD.wms_order_item_id
     AND NEW.legacy_wms_shipment_item_id IS NOT DISTINCT FROM OLD.legacy_wms_shipment_item_id
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Channel fulfillment receipt item evidence is immutable after lineage attachment'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS channel_fulfillment_receipt_items_immutable
  ON oms.channel_fulfillment_receipt_items;
CREATE TRIGGER channel_fulfillment_receipt_items_immutable
  BEFORE UPDATE OR DELETE ON oms.channel_fulfillment_receipt_items
  FOR EACH ROW EXECUTE FUNCTION oms.channel_fulfillment_receipt_item_update_guard();

DROP TRIGGER IF EXISTS physical_shipment_tracking_amendments_immutable
  ON wms.physical_shipment_tracking_amendments;
CREATE TRIGGER physical_shipment_tracking_amendments_immutable
  BEFORE UPDATE OR DELETE ON wms.physical_shipment_tracking_amendments
  FOR EACH ROW EXECUTE FUNCTION oms.reject_channel_fulfillment_attempt_mutation();

CREATE OR REPLACE FUNCTION oms.channel_fulfillment_receipt_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'channel_fulfillment_receipts is permanent inbound evidence; DELETE is not allowed'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.receipt_key IS DISTINCT FROM OLD.receipt_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.source_provider IS DISTINCT FROM OLD.source_provider
     OR (
       NEW.source_channel_id IS DISTINCT FROM OLD.source_channel_id
       AND NOT (OLD.source_channel_id IS NULL AND NEW.source_channel_id IS NOT NULL)
     )
     OR NEW.source_order_id IS DISTINCT FROM OLD.source_order_id
     OR NEW.source_fulfillment_id IS DISTINCT FROM OLD.source_fulfillment_id
     OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
     OR NEW.source_inbox_id IS DISTINCT FROM OLD.source_inbox_id
     OR NEW.event_kind IS DISTINCT FROM OLD.event_kind
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.tracking_number IS DISTINCT FROM OLD.tracking_number
     OR NEW.carrier IS DISTINCT FROM OLD.carrier
     OR NEW.tracking_url IS DISTINCT FROM OLD.tracking_url
     OR NEW.shipped_at IS DISTINCT FROM OLD.shipped_at
     OR NEW.raw_payload IS DISTINCT FROM OLD.raw_payload
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Channel fulfillment receipt identity and payload snapshot are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.processing_status IN ('processed', 'ignored')
     AND NEW.processing_status IS DISTINCT FROM OLD.processing_status THEN
    RAISE EXCEPTION 'Processed channel fulfillment receipts are terminal'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.attempt_count < OLD.attempt_count
     OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'Channel fulfillment receipt attempt_count must be monotonic'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.attempt_count = OLD.attempt_count + 1
     AND NEW.processing_status <> 'processing' THEN
    RAISE EXCEPTION 'A channel fulfillment receipt attempt can only begin in processing state'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channel_fulfillment_receipts_update_guard
  ON oms.channel_fulfillment_receipts;
CREATE TRIGGER channel_fulfillment_receipts_update_guard
  BEFORE UPDATE OR DELETE ON oms.channel_fulfillment_receipts
  FOR EACH ROW EXECUTE FUNCTION oms.channel_fulfillment_receipt_update_guard();

CREATE OR REPLACE FUNCTION wms.physical_shipment_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'physical_shipments is permanent fulfillment evidence; DELETE is not allowed'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.shipping_engine_order_id IS DISTINCT FROM OLD.shipping_engine_order_id
     OR NEW.shipment_request_id IS DISTINCT FROM OLD.shipment_request_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_physical_shipment_id IS DISTINCT FROM OLD.provider_physical_shipment_id
     OR NEW.tracking_number IS DISTINCT FROM OLD.tracking_number
     OR NEW.carrier IS DISTINCT FROM OLD.carrier
     OR NEW.service_code IS DISTINCT FROM OLD.service_code
     OR NEW.ship_date IS DISTINCT FROM OLD.ship_date
     OR NEW.raw_event_hash IS DISTINCT FROM OLD.raw_event_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Physical shipment identity and dispatch snapshot are immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS physical_shipments_identity_guard
  ON wms.physical_shipments;
CREATE TRIGGER physical_shipments_identity_guard
  BEFORE UPDATE OR DELETE ON wms.physical_shipments
  FOR EACH ROW EXECUTE FUNCTION wms.physical_shipment_update_guard();

CREATE OR REPLACE FUNCTION wms.reject_physical_shipment_item_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'physical_shipment_items is append-only fulfillment evidence; % is not allowed', TG_OP
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS physical_shipment_items_immutable
  ON wms.physical_shipment_items;
CREATE TRIGGER physical_shipment_items_immutable
  BEFORE UPDATE OR DELETE ON wms.physical_shipment_items
  FOR EACH ROW EXECUTE FUNCTION wms.reject_physical_shipment_item_mutation();

CREATE OR REPLACE FUNCTION oms.channel_fulfillment_push_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.oms_order_id IS DISTINCT FROM OLD.oms_order_id
     OR NEW.physical_shipment_id IS DISTINCT FROM OLD.physical_shipment_id
     OR NEW.channel_provider IS DISTINCT FROM OLD.channel_provider
     OR NEW.channel_fulfillment_scope_key IS DISTINCT FROM OLD.channel_fulfillment_scope_key
     OR NEW.command_key IS DISTINCT FROM OLD.command_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.tracking_number IS DISTINCT FROM OLD.tracking_number
     OR NEW.carrier IS DISTINCT FROM OLD.carrier
     OR NEW.tracking_url IS DISTINCT FROM OLD.tracking_url
     OR NEW.shipped_at IS DISTINCT FROM OLD.shipped_at
     OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Channel fulfillment command identity and request snapshot are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.command_key LIKE 'fulfillment:v1:%'
     AND NEW.metadata IS DISTINCT FROM OLD.metadata THEN
    RAISE EXCEPTION 'Canonical channel fulfillment command metadata is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'Channel fulfillment attempt count cannot decrease'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.push_status IN ('success', 'ignored', 'dead')
     AND NEW.push_status IS DISTINCT FROM OLD.push_status THEN
    RAISE EXCEPTION 'Terminal channel fulfillment commands are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (OLD.push_status = 'pending' AND NEW.push_status NOT IN ('pending', 'processing', 'review', 'dead'))
     OR (OLD.push_status = 'processing' AND NEW.push_status NOT IN ('processing', 'retry', 'success', 'ignored', 'review', 'dead'))
     OR (OLD.push_status = 'retry' AND NEW.push_status NOT IN ('retry', 'processing', 'review', 'dead'))
     OR (OLD.push_status = 'failed' AND NEW.push_status NOT IN ('failed', 'retry', 'processing', 'review', 'dead'))
     OR (OLD.push_status = 'review' AND NEW.push_status NOT IN ('review', 'pending', 'retry', 'dead')) THEN
    RAISE EXCEPTION 'Invalid channel fulfillment command status transition: % -> %', OLD.push_status, NEW.push_status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channel_fulfillment_push_update_guard
  ON oms.channel_fulfillment_pushes;
CREATE TRIGGER channel_fulfillment_push_update_guard
  BEFORE UPDATE ON oms.channel_fulfillment_pushes
  FOR EACH ROW EXECUTE FUNCTION oms.channel_fulfillment_push_update_guard();

COMMIT;
