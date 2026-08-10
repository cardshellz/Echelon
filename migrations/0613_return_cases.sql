CREATE SEQUENCE IF NOT EXISTS returns.return_case_number_seq;

CREATE TABLE IF NOT EXISTS returns.return_cases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_number varchar(32) NOT NULL DEFAULT (
    'RET-' || lpad(nextval('returns.return_case_number_seq')::text, 10, '0')
  ),
  source_provider varchar(40) NOT NULL,
  source_event_type varchar(40) NOT NULL,
  source_event_id varchar(160) NOT NULL,
  business_context varchar(30) NOT NULL,
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  vendor_id integer REFERENCES dropship.dropship_vendors(id),
  store_connection_id integer REFERENCES dropship.dropship_store_connections(id),
  oms_order_id bigint NOT NULL REFERENCES oms.oms_orders(id),
  wms_order_id integer NOT NULL REFERENCES wms.orders(id),
  wms_return_id bigint NOT NULL REFERENCES wms.returns(id),
  policy_id integer NOT NULL REFERENCES returns.return_policies(id),
  policy_version integer NOT NULL,
  policy_snapshot jsonb NOT NULL,
  case_status varchar(24) NOT NULL,
  approval_status varchar(24) NOT NULL,
  logistics_status varchar(24) NOT NULL,
  inspection_status varchar(24) NOT NULL,
  customer_refund_status varchar(24) NOT NULL,
  vendor_settlement_status varchar(24) NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_cases_case_number_uq UNIQUE (case_number),
  CONSTRAINT return_cases_source_uq UNIQUE (source_provider, source_event_type, source_event_id),
  CONSTRAINT return_cases_wms_return_uq UNIQUE (wms_return_id),
  CONSTRAINT return_cases_business_context_chk CHECK (business_context IN ('retail','dropship')),
  CONSTRAINT return_cases_case_status_chk CHECK (case_status IN ('open','closed','cancelled','exception')),
  CONSTRAINT return_cases_approval_status_chk CHECK (approval_status IN ('pending','approved','rejected')),
  CONSTRAINT return_cases_logistics_status_chk CHECK (logistics_status IN ('not_required','awaiting_return','label_ready','in_transit','delivered','received')),
  CONSTRAINT return_cases_inspection_status_chk CHECK (inspection_status IN ('not_required','pending','approved','rejected')),
  CONSTRAINT return_cases_customer_refund_status_chk CHECK (customer_refund_status IN ('pending','completed','failed','not_required')),
  CONSTRAINT return_cases_vendor_settlement_status_chk CHECK (vendor_settlement_status IN ('not_applicable','pending','eligible','completed','held','failed')),
  CONSTRAINT return_cases_policy_snapshot_chk CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  CONSTRAINT return_cases_context_dimensions_chk CHECK (
    (business_context = 'retail' AND vendor_id IS NULL AND store_connection_id IS NULL)
    OR (business_context = 'dropship' AND vendor_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS return_cases_open_status_idx
  ON returns.return_cases (case_status, created_at DESC)
  WHERE case_status <> 'closed';
CREATE INDEX IF NOT EXISTS return_cases_order_idx
  ON returns.return_cases (oms_order_id, wms_order_id);
CREATE INDEX IF NOT EXISTS return_cases_channel_idx
  ON returns.return_cases (channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS returns.return_case_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_case_id bigint NOT NULL REFERENCES returns.return_cases(id) ON DELETE CASCADE,
  wms_return_item_id bigint NOT NULL REFERENCES wms.return_items(id),
  oms_order_line_id bigint REFERENCES oms.oms_order_lines(id),
  wms_order_item_id integer REFERENCES wms.order_items(id),
  external_line_item_id varchar(100),
  sku varchar(100),
  title text,
  quantity integer NOT NULL,
  unit_paid_price_cents bigint NOT NULL,
  source_line_total_cents bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_case_items_return_item_uq UNIQUE (return_case_id, wms_return_item_id),
  CONSTRAINT return_case_items_quantity_chk CHECK (quantity > 0),
  CONSTRAINT return_case_items_money_chk CHECK (unit_paid_price_cents >= 0 AND source_line_total_cents >= 0)
);

CREATE INDEX IF NOT EXISTS return_case_items_case_idx
  ON returns.return_case_items (return_case_id);

CREATE TABLE IF NOT EXISTS returns.return_case_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_case_id bigint NOT NULL REFERENCES returns.return_cases(id) ON DELETE CASCADE,
  event_type varchar(80) NOT NULL,
  actor varchar(255) NOT NULL,
  details jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_case_events_details_chk CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX IF NOT EXISTS return_case_events_case_idx
  ON returns.return_case_events (return_case_id, occurred_at, id);

CREATE OR REPLACE FUNCTION returns.reject_return_case_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only Return Case evidence; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS return_case_items_immutable
  ON returns.return_case_items;
CREATE TRIGGER return_case_items_immutable
  BEFORE UPDATE OR DELETE ON returns.return_case_items
  FOR EACH ROW EXECUTE FUNCTION returns.reject_return_case_evidence_mutation();

DROP TRIGGER IF EXISTS return_case_events_immutable
  ON returns.return_case_events;
CREATE TRIGGER return_case_events_immutable
  BEFORE UPDATE OR DELETE ON returns.return_case_events
  FOR EACH ROW EXECUTE FUNCTION returns.reject_return_case_evidence_mutation();

CREATE OR REPLACE FUNCTION returns.guard_return_case_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Return Cases are permanent operational records; DELETE is not allowed'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.case_number IS DISTINCT FROM OLD.case_number
     OR NEW.source_provider IS DISTINCT FROM OLD.source_provider
     OR NEW.source_event_type IS DISTINCT FROM OLD.source_event_type
     OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
     OR NEW.business_context IS DISTINCT FROM OLD.business_context
     OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
     OR NEW.store_connection_id IS DISTINCT FROM OLD.store_connection_id
     OR NEW.oms_order_id IS DISTINCT FROM OLD.oms_order_id
     OR NEW.wms_order_id IS DISTINCT FROM OLD.wms_order_id
     OR NEW.wms_return_id IS DISTINCT FROM OLD.wms_return_id
     OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Return Case identity, source linkage, and policy evidence are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS return_cases_mutation_guard
  ON returns.return_cases;
CREATE TRIGGER return_cases_mutation_guard
  BEFORE UPDATE OR DELETE ON returns.return_cases
  FOR EACH ROW EXECUTE FUNCTION returns.guard_return_case_mutation();
