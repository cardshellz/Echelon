-- Inventory Planning owns resumable, explicit product inventory sync commands.
-- Provider calls never run in the transaction which accepts or leases a request.
CREATE TABLE inventory.product_inventory_sync_requests (
  id uuid PRIMARY KEY,
  product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  requested_by varchar(100) NOT NULL CHECK (btrim(requested_by) <> ''),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  state varchar(24) NOT NULL CHECK (state IN ('checking_links','publishing','queued','blocked','failed')),
  message text NOT NULL CHECK (message <> ''),
  review jsonb NOT NULL,
  publication_command jsonb,
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  CONSTRAINT product_inventory_sync_requests_lease_check CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT product_inventory_sync_requests_deadline_check CHECK (deadline_at > requested_at),
  CONSTRAINT product_inventory_sync_requests_command_check CHECK (
    state NOT IN ('publishing','queued') OR COALESCE(jsonb_typeof(publication_command)='object',false))
);
CREATE INDEX product_inventory_sync_requests_due_idx
  ON inventory.product_inventory_sync_requests(next_attempt_at, requested_at, id)
  WHERE state IN ('checking_links','publishing');
CREATE INDEX product_inventory_sync_requests_product_idx
  ON inventory.product_inventory_sync_requests(product_id, requested_at DESC);
