-- Additive customer authorization evidence. This does not enable intake or alter
-- any legacy writer. Enablement requires every writer to share quantity claims.
CREATE SEQUENCE IF NOT EXISTS returns.customer_return_authorization_number_seq;

CREATE TABLE returns.customer_return_authorizations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  authorization_number VARCHAR(32) NOT NULL DEFAULT
    ('RMA-' || nextval('returns.customer_return_authorization_number_seq')::text),
  channel_id INTEGER NOT NULL REFERENCES channels.channels(id),
  oms_order_id BIGINT NOT NULL REFERENCES oms.oms_orders(id),
  eligibility_revision VARCHAR(64) NOT NULL CHECK (eligibility_revision ~ '^[a-f0-9]{64}$'),
  policy_snapshot JSONB NOT NULL CHECK (jsonb_typeof(policy_snapshot) = 'object' AND octet_length(policy_snapshot::text) <= 65536),
  warehouse_snapshot JSONB NOT NULL CHECK (jsonb_typeof(warehouse_snapshot) = 'object' AND octet_length(warehouse_snapshot::text) <= 65536),
  actor VARCHAR(255) NOT NULL CHECK (btrim(actor) <> ''),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT customer_return_authorizations_number_unique UNIQUE (authorization_number),
  CONSTRAINT customer_return_authorizations_channel_identity UNIQUE (id, channel_id)
);
CREATE INDEX customer_return_authorizations_order_idx ON returns.customer_return_authorizations(oms_order_id, id);

CREATE TABLE returns.customer_return_authorization_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  authorization_id BIGINT NOT NULL REFERENCES returns.customer_return_authorizations(id),
  oms_order_line_id BIGINT NOT NULL REFERENCES oms.oms_order_lines(id),
  external_line_item_id VARCHAR(100) NOT NULL CHECK (btrim(external_line_item_id) <> ''),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  reason_code VARCHAR(100) CHECK (reason_code IS NULL OR btrim(reason_code) <> ''),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT customer_return_authorization_lines_identity UNIQUE (authorization_id, oms_order_line_id),
  CONSTRAINT customer_return_authorization_lines_parent UNIQUE (id, authorization_id)
);
CREATE INDEX customer_return_authorization_lines_source_idx ON returns.customer_return_authorization_lines(oms_order_line_id);

-- These append-only allocations are also the outstanding entitlement claims.
-- No timed expiry/release is introduced; later explicit release evidence must be
-- a separate audited operation, never deletion or mutation of original claims.
CREATE TABLE returns.customer_return_authorization_allocations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  authorization_id BIGINT NOT NULL REFERENCES returns.customer_return_authorizations(id),
  authorization_line_id BIGINT NOT NULL,
  wms_order_item_id INTEGER NOT NULL REFERENCES wms.order_items(id),
  fulfillment_id VARCHAR(200) NOT NULL CHECK (btrim(fulfillment_id) <> ''),
  fulfillment_line_item_id VARCHAR(200) NOT NULL CHECK (btrim(fulfillment_line_item_id) <> ''),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  eligible_quantity INTEGER NOT NULL CHECK (eligible_quantity > 0 AND quantity <= eligible_quantity),
  delivery_evidence JSONB NOT NULL CHECK (jsonb_typeof(delivery_evidence) = 'object' AND octet_length(delivery_evidence::text) <= 65536),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT customer_return_authorization_allocations_parent FOREIGN KEY (authorization_line_id, authorization_id)
    REFERENCES returns.customer_return_authorization_lines(id, authorization_id),
  CONSTRAINT customer_return_authorization_allocations_identity UNIQUE
    (authorization_line_id, wms_order_item_id, fulfillment_id, fulfillment_line_item_id)
);
CREATE INDEX customer_return_authorization_allocations_item_idx ON returns.customer_return_authorization_allocations(wms_order_item_id);
CREATE INDEX customer_return_authorization_allocations_fulfillment_idx ON returns.customer_return_authorization_allocations(fulfillment_id, fulfillment_line_item_id);

CREATE TABLE returns.customer_return_authorization_commands (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels.channels(id),
  idempotency_key VARCHAR(160) NOT NULL CHECK (btrim(idempotency_key) <> ''),
  semantic_hash VARCHAR(64) NOT NULL CHECK (semantic_hash ~ '^[a-f0-9]{64}$'),
  authorization_id BIGINT NOT NULL,
  response JSONB NOT NULL CHECK (jsonb_typeof(response) = 'object' AND octet_length(response::text) <= 65536),
  actor VARCHAR(255) NOT NULL CHECK (btrim(actor) <> ''),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT customer_return_authorization_commands_key UNIQUE (channel_id, idempotency_key),
  CONSTRAINT customer_return_authorization_commands_root UNIQUE (authorization_id),
  CONSTRAINT customer_return_authorization_commands_channel FOREIGN KEY (authorization_id, channel_id)
    REFERENCES returns.customer_return_authorizations(id, channel_id)
);

CREATE TABLE returns.customer_return_authorization_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  authorization_id BIGINT NOT NULL REFERENCES returns.customer_return_authorizations(id),
  event_type VARCHAR(80) NOT NULL CHECK (event_type = 'customer_return_authorized'),
  actor VARCHAR(255) NOT NULL CHECK (btrim(actor) <> ''),
  details JSONB NOT NULL CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 65536),
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT customer_return_authorization_events_once UNIQUE (authorization_id, event_type)
);

-- Durable effect intent only. No consumer or provider execution is enabled by
-- this migration. Delivery attempts belong in a separate mutable worker ledger.
CREATE TABLE returns.customer_return_authorization_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  authorization_id BIGINT NOT NULL REFERENCES returns.customer_return_authorizations(id),
  topic VARCHAR(100) NOT NULL CHECK (topic = 'customer_return_authorization.created'),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536),
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT customer_return_authorization_outbox_once UNIQUE (authorization_id, topic)
);

CREATE FUNCTION returns.guard_customer_return_authorization_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'customer_return_authorizations' THEN
    IF NOT EXISTS (SELECT 1 FROM oms.oms_orders WHERE id = NEW.oms_order_id AND channel_id = NEW.channel_id) THEN
      RAISE EXCEPTION 'Authorization source channel does not match its OMS order' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'customer_return_authorization_lines' THEN
    IF NOT EXISTS (
      SELECT 1 FROM returns.customer_return_authorizations a
      JOIN oms.oms_order_lines ol ON ol.order_id = a.oms_order_id
      WHERE a.id = NEW.authorization_id AND ol.id = NEW.oms_order_line_id
        AND ol.external_line_item_id = NEW.external_line_item_id
    ) THEN
      RAISE EXCEPTION 'Authorization line does not match its OMS source' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM returns.customer_return_authorization_lines al
      JOIN returns.customer_return_authorizations a ON a.id = al.authorization_id
      JOIN wms.order_items wi ON wi.id = NEW.wms_order_item_id AND wi.oms_order_line_id = al.oms_order_line_id
      JOIN wms.orders wo ON wo.id = wi.order_id AND wo.oms_fulfillment_order_id = a.oms_order_id::text
      WHERE al.id = NEW.authorization_line_id AND al.authorization_id = NEW.authorization_id
    ) THEN
      RAISE EXCEPTION 'Authorization allocation does not match its WMS source' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_return_authorizations_ownership BEFORE INSERT ON returns.customer_return_authorizations
FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_authorization_ownership();
CREATE TRIGGER customer_return_authorization_lines_ownership BEFORE INSERT ON returns.customer_return_authorization_lines
FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_authorization_ownership();
CREATE TRIGGER customer_return_authorization_allocations_ownership BEFORE INSERT ON returns.customer_return_authorization_allocations
FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_authorization_ownership();

CREATE FUNCTION returns.guard_customer_return_authorization_graph() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE root_id BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'customer_return_authorizations' THEN root_id := NEW.id;
  ELSE root_id := NEW.authorization_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM returns.customer_return_authorization_lines WHERE authorization_id = root_id)
    OR EXISTS (
      SELECT 1 FROM returns.customer_return_authorization_lines al
      LEFT JOIN returns.customer_return_authorization_allocations aa ON aa.authorization_line_id = al.id
      WHERE al.authorization_id = root_id
      GROUP BY al.id, al.quantity HAVING COALESCE(SUM(aa.quantity), 0) <> al.quantity
    )
    OR NOT EXISTS (SELECT 1 FROM returns.customer_return_authorization_commands WHERE authorization_id = root_id)
    OR NOT EXISTS (SELECT 1 FROM returns.customer_return_authorization_events WHERE authorization_id = root_id)
    OR NOT EXISTS (SELECT 1 FROM returns.customer_return_authorization_outbox WHERE authorization_id = root_id)
  THEN
    RAISE EXCEPTION 'Customer authorization evidence graph is incomplete or unbalanced' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER customer_return_authorizations_complete AFTER INSERT ON returns.customer_return_authorizations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_authorization_graph();
CREATE CONSTRAINT TRIGGER customer_return_authorization_lines_balanced AFTER INSERT ON returns.customer_return_authorization_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_authorization_graph();
CREATE CONSTRAINT TRIGGER customer_return_authorization_allocations_balanced AFTER INSERT ON returns.customer_return_authorization_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_authorization_graph();

CREATE FUNCTION returns.reject_customer_return_authorization_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only authorization evidence', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

DO $$
DECLARE evidence_table TEXT;
BEGIN
  FOREACH evidence_table IN ARRAY ARRAY[
    'customer_return_authorizations', 'customer_return_authorization_lines',
    'customer_return_authorization_allocations', 'customer_return_authorization_commands',
    'customer_return_authorization_events', 'customer_return_authorization_outbox'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON returns.%I FOR EACH ROW EXECUTE FUNCTION returns.reject_customer_return_authorization_evidence_mutation()',
      evidence_table || '_immutable', evidence_table);
  END LOOP;
END;
$$;
