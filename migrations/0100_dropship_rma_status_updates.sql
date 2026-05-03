CREATE TABLE IF NOT EXISTS dropship.dropship_rma_status_updates (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rma_id integer NOT NULL REFERENCES dropship.dropship_rmas(id) ON DELETE CASCADE,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  previous_status varchar(40) NOT NULL,
  status varchar(40) NOT NULL,
  notes text,
  actor_type varchar(40) NOT NULL DEFAULT 'system',
  actor_id varchar(255),
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_rma_status_update_previous_chk CHECK (previous_status IN (
    'requested',
    'in_transit',
    'received',
    'inspecting',
    'approved',
    'rejected',
    'credited',
    'closed'
  )),
  CONSTRAINT dropship_rma_status_update_status_chk CHECK (status IN (
    'requested',
    'in_transit',
    'received',
    'inspecting',
    'approved',
    'rejected',
    'credited',
    'closed'
  )),
  CONSTRAINT dropship_rma_status_update_actor_chk CHECK (actor_type IN ('admin', 'system'))
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_rma_status_update_idem_idx
  ON dropship.dropship_rma_status_updates(idempotency_key);

CREATE INDEX IF NOT EXISTS dropship_rma_status_update_rma_created_idx
  ON dropship.dropship_rma_status_updates(rma_id, created_at);

CREATE INDEX IF NOT EXISTS dropship_rma_status_update_vendor_created_idx
  ON dropship.dropship_rma_status_updates(vendor_id, created_at);
