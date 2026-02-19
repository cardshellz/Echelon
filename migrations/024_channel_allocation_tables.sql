-- Migration 024: Channel allocation tables
-- Adds channel_product_allocation (product-level rules per channel) and channel_sync_log (audit trail)

CREATE TABLE IF NOT EXISTS channel_product_allocation (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  channel_id integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  min_atp_base integer,
  max_atp_base integer,
  is_listed integer NOT NULL DEFAULT 1,
  notes text,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_product_alloc_channel_product_idx ON channel_product_allocation(channel_id, product_id);

CREATE TABLE IF NOT EXISTS channel_sync_log (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  product_id integer REFERENCES products(id),
  product_variant_id integer REFERENCES product_variants(id),
  channel_id integer REFERENCES channels(id),
  channel_feed_id integer REFERENCES channel_feeds(id),
  atp_base integer NOT NULL,
  pushed_qty integer NOT NULL,
  previous_qty integer,
  status varchar(20) NOT NULL,
  error_message text,
  response_code integer,
  duration_ms integer,
  triggered_by varchar(30),
  created_at timestamp DEFAULT now() NOT NULL
);
