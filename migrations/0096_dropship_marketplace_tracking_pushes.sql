CREATE TABLE IF NOT EXISTS dropship.dropship_marketplace_tracking_pushes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intake_id integer NOT NULL REFERENCES dropship.dropship_order_intake(id) ON DELETE CASCADE,
  oms_order_id bigint NOT NULL REFERENCES oms.oms_orders(id) ON DELETE CASCADE,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  platform varchar(30) NOT NULL,
  external_order_id varchar(255) NOT NULL,
  external_order_number varchar(100),
  source_order_id varchar(255),
  status varchar(30) NOT NULL DEFAULT 'queued',
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(128) NOT NULL,
  carrier varchar(80) NOT NULL,
  tracking_number varchar(120) NOT NULL,
  shipped_at timestamptz NOT NULL,
  external_fulfillment_id varchar(255),
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code varchar(120),
  last_error_message text,
  raw_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT dropship_tracking_push_platform_chk
    CHECK (platform IN ('ebay','shopify','tiktok','instagram','bigcommerce')),
  CONSTRAINT dropship_tracking_push_status_chk
    CHECK (status IN ('queued','processing','succeeded','failed')),
  CONSTRAINT dropship_tracking_push_attempt_chk
    CHECK (attempt_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_tracking_push_idem_idx
  ON dropship.dropship_marketplace_tracking_pushes (idempotency_key);

CREATE INDEX IF NOT EXISTS dropship_tracking_push_intake_idx
  ON dropship.dropship_marketplace_tracking_pushes (intake_id);

CREATE INDEX IF NOT EXISTS dropship_tracking_push_status_idx
  ON dropship.dropship_marketplace_tracking_pushes (status, updated_at);
