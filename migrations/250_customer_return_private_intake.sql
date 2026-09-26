-- Private staff intake: immutable manifests and exact operational mirrors exist
-- before any provider purchase. No provider, refund or inventory effect occurs here.
CREATE TABLE returns.customer_return_intakes (
  authorization_id BIGINT PRIMARY KEY REFERENCES returns.customer_return_authorizations(id),
  settings_version INTEGER NOT NULL CHECK (settings_version > 0),
  policy_id INTEGER NOT NULL REFERENCES returns.return_policies(id),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  operational_policy_snapshot JSONB NOT NULL CHECK (jsonb_typeof(operational_policy_snapshot) = 'object'),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE returns.customer_return_case_links (
  authorization_id BIGINT NOT NULL REFERENCES returns.customer_return_intakes(authorization_id),
  case_id BIGINT NOT NULL UNIQUE REFERENCES returns.return_cases(id),
  wms_order_id INTEGER NOT NULL REFERENCES wms.orders(id),
  wms_return_id BIGINT NOT NULL UNIQUE REFERENCES wms.returns(id),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (authorization_id, wms_order_id)
);
CREATE TABLE returns.customer_return_allocation_case_items (
  authorization_id BIGINT NOT NULL REFERENCES returns.customer_return_intakes(authorization_id),
  authorization_allocation_id BIGINT PRIMARY KEY REFERENCES returns.customer_return_authorization_allocations(id),
  case_item_id BIGINT NOT NULL REFERENCES returns.return_case_items(id),
  wms_return_item_id BIGINT NOT NULL REFERENCES wms.return_items(id),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX customer_return_allocation_case_items_wms_idx ON returns.customer_return_allocation_case_items(wms_return_item_id);
CREATE TABLE returns.customer_return_parcels (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  authorization_id BIGINT NOT NULL REFERENCES returns.customer_return_intakes(authorization_id),
  parcel_key VARCHAR(64) NOT NULL CHECK (btrim(parcel_key) <> ''),
  dimensions JSONB NOT NULL CHECK (jsonb_typeof(dimensions) = 'object'),
  weight_grams BIGINT NOT NULL CHECK (weight_grams BETWEEN 1 AND 9007199254740991),
  origin_address JSONB NOT NULL CHECK (jsonb_typeof(origin_address) = 'object'),
  destination_address JSONB NOT NULL CHECK (jsonb_typeof(destination_address) = 'object'),
  carrier_id VARCHAR(80) NOT NULL CHECK (btrim(carrier_id) <> ''),
  service_code VARCHAR(100) NOT NULL CHECK (btrim(service_code) <> ''),
  provider_external_shipment_id VARCHAR(50) GENERATED ALWAYS AS ('ecr-' || authorization_id::text || '-' || id::text) STORED,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (authorization_id, parcel_key), UNIQUE (provider_external_shipment_id), UNIQUE (id, authorization_id)
);
CREATE TABLE returns.customer_return_parcel_items (
  parcel_id BIGINT NOT NULL REFERENCES returns.customer_return_parcels(id),
  authorization_line_id BIGINT NOT NULL REFERENCES returns.customer_return_authorization_lines(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (parcel_id, authorization_line_id)
);
CREATE TABLE returns.customer_return_label_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parcel_id BIGINT NOT NULL REFERENCES returns.customer_return_parcels(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  idempotency_key VARCHAR(160) NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  status VARCHAR(20) NOT NULL CHECK (status IN ('executing','succeeded','failed','uncertain')),
  request_snapshot JSONB NOT NULL CHECK (jsonb_typeof(request_snapshot) = 'object'),
  result_snapshot JSONB CHECK (result_snapshot IS NULL OR jsonb_typeof(result_snapshot) = 'object'),
  error_code VARCHAR(100),
  actor VARCHAR(255) NOT NULL CHECK (btrim(actor) <> ''),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  UNIQUE (parcel_id, attempt_number),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK (status <> 'succeeded' OR (result_snapshot IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX customer_return_label_attempts_unresolved_uq ON returns.customer_return_label_attempts(parcel_id)
  WHERE status IN ('executing','succeeded','uncertain');

-- Legacy rows materialized from root claims consume no additional entitlement.
-- Deferred graph checks below prove their identity and complete quantity equality.
CREATE VIEW returns.customer_return_claimed_quantities AS
SELECT wms_order_item_id, SUM(quantity)::bigint AS claimed_quantity FROM (
  SELECT aa.wms_order_item_id, aa.quantity::bigint AS quantity
  FROM returns.customer_return_authorization_allocations aa
  UNION ALL
  SELECT ri.order_item_id, GREATEST(ri.expected_qty, ri.received_qty)::bigint
  FROM wms.return_items ri WHERE ri.order_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM returns.customer_return_allocation_case_items link WHERE link.wms_return_item_id = ri.id
  )
) claims GROUP BY wms_order_item_id;

CREATE FUNCTION returns.guard_customer_return_intake_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'customer_return_allocation_case_items' THEN
    IF NOT EXISTS (
      SELECT 1 FROM returns.customer_return_authorization_allocations aa
      JOIN returns.customer_return_authorization_lines al ON al.id=aa.authorization_line_id
      JOIN returns.return_case_items ci ON ci.id=NEW.case_item_id
      JOIN returns.customer_return_case_links cl ON cl.case_id=ci.return_case_id
      JOIN wms.return_items ri ON ri.id=NEW.wms_return_item_id
      WHERE aa.id=NEW.authorization_allocation_id AND aa.authorization_id=NEW.authorization_id
        AND cl.authorization_id=NEW.authorization_id AND ci.wms_return_item_id=ri.id
        AND ci.wms_order_item_id=aa.wms_order_item_id AND ri.order_item_id=aa.wms_order_item_id
        AND ci.oms_order_line_id=al.oms_order_line_id AND ri.oms_order_line_id=al.oms_order_line_id
        AND ci.external_line_item_id=al.external_line_item_id AND ri.external_line_item_id=al.external_line_item_id
        AND ri.return_id=cl.wms_return_id
    ) THEN RAISE EXCEPTION 'Portal allocation ownership mismatch' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME = 'customer_return_parcel_items' THEN
    IF NOT EXISTS (SELECT 1 FROM returns.customer_return_parcels p
      JOIN returns.customer_return_authorization_lines al ON al.authorization_id=p.authorization_id
      WHERE p.id=NEW.parcel_id AND al.id=NEW.authorization_line_id) THEN
      RAISE EXCEPTION 'Portal parcel line ownership mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_return_allocation_case_items_ownership BEFORE INSERT ON returns.customer_return_allocation_case_items
FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_intake_ownership();
CREATE TRIGGER customer_return_parcel_items_ownership BEFORE INSERT ON returns.customer_return_parcel_items
FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_intake_ownership();

CREATE FUNCTION returns.guard_customer_return_intake_graph() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_id BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'customer_return_parcel_items' THEN
    SELECT authorization_id INTO root_id FROM returns.customer_return_parcels WHERE id = NEW.parcel_id;
  ELSE root_id := NEW.authorization_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM returns.customer_return_intakes WHERE authorization_id = root_id) THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM returns.customer_return_parcels WHERE authorization_id = root_id)
    OR NOT EXISTS (SELECT 1 FROM returns.customer_return_case_links WHERE authorization_id = root_id)
    OR EXISTS (SELECT 1 FROM returns.return_case_customer_refunds refund
      JOIN returns.customer_return_case_links cl ON cl.case_id=refund.return_case_id WHERE cl.authorization_id=root_id)
    OR (SELECT COUNT(*) FROM returns.customer_return_parcels WHERE authorization_id = root_id) > 20
    OR EXISTS (
      SELECT 1 FROM returns.customer_return_authorization_allocations aa
      LEFT JOIN returns.customer_return_allocation_case_items link ON link.authorization_allocation_id = aa.id
      WHERE aa.authorization_id = root_id AND link.authorization_allocation_id IS NULL
    ) OR EXISTS (
      SELECT 1 FROM returns.customer_return_allocation_case_items link
      JOIN returns.customer_return_authorization_allocations aa ON aa.id = link.authorization_allocation_id
      JOIN returns.customer_return_authorization_lines al ON al.id = aa.authorization_line_id
      JOIN returns.return_case_items ci ON ci.id = link.case_item_id
      JOIN wms.return_items ri ON ri.id = link.wms_return_item_id
      JOIN returns.customer_return_case_links cl ON cl.case_id = ci.return_case_id
      WHERE link.authorization_id = root_id AND (aa.authorization_id <> root_id OR cl.authorization_id <> root_id
        OR ci.wms_return_item_id <> ri.id OR ci.wms_order_item_id <> aa.wms_order_item_id
        OR ri.order_item_id <> aa.wms_order_item_id OR ci.oms_order_line_id <> al.oms_order_line_id
        OR ri.oms_order_line_id <> al.oms_order_line_id OR ri.return_id <> cl.wms_return_id)
    ) OR EXISTS (
      SELECT 1 FROM returns.customer_return_case_links cl
      JOIN returns.return_cases rc ON rc.id = cl.case_id
      JOIN returns.customer_return_authorizations a ON a.id = cl.authorization_id
      JOIN wms.returns wr ON wr.id = cl.wms_return_id
      WHERE cl.authorization_id = root_id AND (rc.wms_return_id <> cl.wms_return_id OR rc.wms_order_id <> cl.wms_order_id
        OR wr.order_id <> cl.wms_order_id OR rc.oms_order_id <> a.oms_order_id OR rc.channel_id <> a.channel_id
        OR rc.source_provider <> 'customer_portal' OR rc.source_event_type <> 'private_customer_return'
        OR rc.source_event_id <> root_id::text || ':' || cl.wms_order_id::text OR rc.created_at <> a.created_at)
    ) OR EXISTS (
      SELECT ci.id FROM returns.return_case_items ci
      JOIN returns.customer_return_case_links cl ON cl.case_id = ci.return_case_id
      LEFT JOIN returns.customer_return_allocation_case_items link ON link.case_item_id = ci.id
      LEFT JOIN returns.customer_return_authorization_allocations aa ON aa.id = link.authorization_allocation_id
      JOIN wms.return_items ri ON ri.id = ci.wms_return_item_id
      WHERE cl.authorization_id = root_id
      GROUP BY ci.id, ci.quantity, ri.expected_qty HAVING COALESCE(SUM(aa.quantity),0) <> ci.quantity OR ci.quantity <> ri.expected_qty
    ) OR EXISTS (
      SELECT al.id FROM returns.customer_return_authorization_lines al
      LEFT JOIN returns.customer_return_parcel_items pi ON pi.authorization_line_id = al.id
      LEFT JOIN returns.customer_return_parcels p ON p.id = pi.parcel_id
      WHERE al.authorization_id = root_id
      GROUP BY al.id, al.quantity HAVING COALESCE(SUM(pi.quantity),0) <> al.quantity
        OR BOOL_OR(p.authorization_id <> root_id)
    ) OR EXISTS (
      SELECT p.id FROM returns.customer_return_parcels p LEFT JOIN returns.customer_return_parcel_items pi ON pi.parcel_id = p.id
      WHERE p.authorization_id = root_id GROUP BY p.id HAVING COUNT(pi.parcel_id) = 0
    ) THEN
    RAISE EXCEPTION 'Private return intake graph is incomplete or unbalanced' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
DO $$ DECLARE evidence_table TEXT; BEGIN
  FOREACH evidence_table IN ARRAY ARRAY['customer_return_intakes','customer_return_case_links',
    'customer_return_allocation_case_items','customer_return_parcels','customer_return_parcel_items'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON returns.%I FOR EACH ROW EXECUTE FUNCTION returns.reject_customer_return_authorization_evidence_mutation()', evidence_table || '_immutable', evidence_table);
    EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON returns.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_intake_graph()', evidence_table || '_complete', evidence_table);
  END LOOP;
END $$;

CREATE FUNCTION returns.guard_customer_return_linked_case_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM returns.customer_return_case_links WHERE case_id = OLD.id)
    AND (NEW.source_provider, NEW.source_event_type, NEW.source_event_id, NEW.oms_order_id, NEW.wms_order_id,
      NEW.wms_return_id, NEW.channel_id, NEW.policy_id, NEW.policy_version, NEW.policy_snapshot, NEW.created_at)
    IS DISTINCT FROM (OLD.source_provider, OLD.source_event_type, OLD.source_event_id, OLD.oms_order_id, OLD.wms_order_id,
      OLD.wms_return_id, OLD.channel_id, OLD.policy_id, OLD.policy_version, OLD.policy_snapshot, OLD.created_at) THEN
    RAISE EXCEPTION 'Portal return case identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_return_linked_case_identity BEFORE UPDATE ON returns.return_cases
FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_linked_case_identity();

CREATE FUNCTION returns.guard_customer_return_linked_wms_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM returns.customer_return_allocation_case_items WHERE wms_return_item_id=OLD.id)
    AND (NEW.return_id,NEW.order_item_id,NEW.oms_order_line_id,NEW.external_line_item_id,NEW.expected_qty)
      IS DISTINCT FROM (OLD.return_id,OLD.order_item_id,OLD.oms_order_line_id,OLD.external_line_item_id,OLD.expected_qty) THEN
    RAISE EXCEPTION 'Portal return item identity and entitlement are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_return_linked_wms_identity BEFORE UPDATE ON wms.return_items
FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_linked_wms_identity();

CREATE FUNCTION returns.guard_customer_return_manual_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM returns.customer_return_case_links WHERE case_id = NEW.return_case_id) THEN
    RAISE EXCEPTION 'Portal return refunds must be issued manually in Shopify' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
-- A fresh portal case is born linked in its creating transaction. This guard
-- additionally protects direct reservation writers; existing refunds are untouched.
CREATE TRIGGER customer_return_manual_refund BEFORE INSERT ON returns.return_case_customer_refunds
FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_manual_refund();
