-- Walmart credentials and controls are separate from public channel metadata.
-- Setup never enables order intake or inventory publication implicitly.
CREATE TABLE channels.walmart_connections (
  channel_id integer PRIMARY KEY REFERENCES channels.channels(id) ON DELETE RESTRICT,
  connection_id integer NOT NULL UNIQUE,
  partner_id varchar(100) NOT NULL CHECK (length(btrim(partner_id)) > 0),
  partner_name text NOT NULL,
  market varchar(2) NOT NULL DEFAULT 'us' CHECK (market = 'us'),
  environment varchar(10) NOT NULL CHECK (environment IN ('production', 'sandbox')),
  ship_node_id varchar(100) NOT NULL CHECK (length(btrim(ship_node_id)) > 0),
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id),
  encrypted_credentials jsonb NOT NULL CHECK (jsonb_typeof(encrypted_credentials) = 'object'),
  orders_enabled boolean NOT NULL DEFAULT false,
  import_since timestamptz NOT NULL,
  checkpoint_at timestamptz,
  last_poll_at timestamptz,
  last_success_at timestamptz,
  last_error_code varchar(120),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (connection_id, channel_id) REFERENCES channels.channel_connections(id, channel_id),
  UNIQUE (market, environment, partner_id)
);
CREATE TABLE channels.walmart_connection_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.walmart_connections(channel_id),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  event_type text NOT NULL,
  before_state jsonb,
  after_state jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE FUNCTION channels.reject_walmart_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Walmart connection audit events are immutable';
END;
$$;
CREATE TRIGGER walmart_connection_events_immutable
  BEFORE UPDATE OR DELETE ON channels.walmart_connection_events
  FOR EACH ROW EXECUTE FUNCTION channels.reject_walmart_audit_mutation();

CREATE TABLE channels.walmart_order_receipts (
  channel_id integer NOT NULL REFERENCES channels.walmart_connections(channel_id),
  purchase_order_id varchar(100) NOT NULL,
  source_hash varchar(64) NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  oms_order_id bigint REFERENCES oms.oms_orders(id),
  status varchar(20) NOT NULL CHECK (status IN ('processing','completed','failed','ignored')),
  error_code varchar(120),
  observed_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (channel_id,purchase_order_id)
);
