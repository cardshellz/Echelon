-- product_merge_runs: durable, resumable "merge duplicate product" commands.
--
-- A merge releases the reservations of open orders on the duplicate (source)
-- product, moves stock/orders/purchasing/bins to the surviving (target)
-- product in ONE transaction, then re-reserves those orders. Canonical
-- inventory claims run in their own SERIALIZABLE transaction, so the three
-- steps cannot share one; this row records each step so a crash or transient
-- error resumes exactly where it stopped and never forgets a released hold.
--
-- One row per Idempotency-Key. At most one unfinished run per product on
-- either side. Rows are an audit trail and are never deleted.

CREATE TABLE IF NOT EXISTS catalog.product_merge_runs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key varchar(160) NOT NULL,
  request_hash varchar(64) NOT NULL,
  source_product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  target_product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  request jsonb NOT NULL,
  status varchar(30) NOT NULL,
  orders jsonb NOT NULL DEFAULT '[]'::jsonb,
  result jsonb,
  error_code varchar(100),
  error_message text,
  actor varchar(200) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT product_merge_runs_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT product_merge_runs_status_chk CHECK (status IN
    ('releasing','merging','reclaiming','completed','completed_with_review','compensating','failed')),
  CONSTRAINT product_merge_runs_distinct_chk CHECK (source_product_id <> target_product_id),
  CONSTRAINT product_merge_runs_request_hash_chk CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT product_merge_runs_orders_chk CHECK (jsonb_typeof(orders) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS product_merge_runs_active_source_uidx
  ON catalog.product_merge_runs (source_product_id)
  WHERE status NOT IN ('completed','completed_with_review','failed');
CREATE UNIQUE INDEX IF NOT EXISTS product_merge_runs_active_target_uidx
  ON catalog.product_merge_runs (target_product_id)
  WHERE status NOT IN ('completed','completed_with_review','failed');
CREATE INDEX IF NOT EXISTS product_merge_runs_source_idx
  ON catalog.product_merge_runs (source_product_id, created_at);
