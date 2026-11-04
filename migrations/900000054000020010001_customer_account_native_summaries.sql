-- Presentation facts only. Shopify remains the money and purchase authority.
-- No OMS foreign key: purchases older than OMS must have the same fast path.
CREATE TABLE oms.customer_account_native_summaries (
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  external_order_id varchar(30) NOT NULL CHECK (external_order_id ~ '^[1-9][0-9]*$'),
  external_customer_id varchar(30) CHECK (external_customer_id ~ '^[1-9][0-9]*$'),
  connection_id integer REFERENCES channels.channel_connections(id),
  shop_domain varchar(255),
  fact jsonb,
  source_updated_at timestamptz,
  verified_at timestamptz,
  next_refresh_at timestamptz NOT NULL DEFAULT '-infinity',
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  lease_id uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code varchar(100),
  source_error_code varchar(100),
  source_error_updated_at timestamptz,
  source_error_observed_at timestamptz,
  PRIMARY KEY(channel_id, external_order_id),
  CHECK ((source_error_code IS NULL AND source_error_updated_at IS NULL AND source_error_observed_at IS NULL)
    OR (source_error_code IN ('ACCOUNT_NATIVE_SOURCE_INVALID','MONEY_INVALID','MONEY_OVERFLOW','CURRENCY_CONVERSION_UNSUPPORTED')
      AND source_error_updated_at IS NOT NULL AND source_error_observed_at IS NOT NULL)),
  CHECK ((fact IS NULL AND source_updated_at IS NULL AND verified_at IS NULL)
    OR (fact IS NOT NULL AND source_updated_at IS NOT NULL AND verified_at IS NOT NULL
      AND connection_id IS NOT NULL AND shop_domain IS NOT NULL))
);
CREATE INDEX customer_account_native_customer_idx
  ON oms.customer_account_native_summaries(channel_id,external_customer_id,external_order_id)
  WHERE fact IS NOT NULL;
CREATE INDEX customer_account_native_due_idx
  ON oms.customer_account_native_summaries(next_refresh_at,channel_id,external_order_id);

CREATE TABLE oms.customer_account_native_cursors (
  connection_id integer PRIMARY KEY REFERENCES channels.channel_connections(id),
  backfill_after varchar(30) CHECK (backfill_after ~ '^[1-9][0-9]*$'),
  backfill_complete boolean NOT NULL DEFAULT false,
  next_backfill_at timestamptz NOT NULL DEFAULT '-infinity',
  delta_since timestamptz NOT NULL,
  delta_after varchar(30) CHECK (delta_after ~ '^[1-9][0-9]*$'),
  delta_started_at timestamptz NOT NULL,
  delta_covered_until timestamptz,
  next_delta_at timestamptz NOT NULL DEFAULT '-infinity',
  lease_id uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT '-infinity',
  last_error_code varchar(100)
);
