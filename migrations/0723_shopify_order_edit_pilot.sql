-- Private same-order edits. No customer route or live-write setting is enabled by migration.
CREATE TABLE oms.order_edit_settings (
  connection_id integer PRIMARY KEY REFERENCES channels.channel_connections(id),
  payment_window_minutes integer NOT NULL CHECK (payment_window_minutes BETWEEN 1 AND 10080),
  enabled boolean NOT NULL DEFAULT false,
  updated_by varchar(255) NOT NULL REFERENCES identity.users(id),
  updated_at timestamptz NOT NULL
);
CREATE TABLE oms.order_edit_operations (
  id uuid PRIMARY KEY,
  oms_order_id bigint NOT NULL REFERENCES oms.oms_orders(id),
  connection_id integer NOT NULL REFERENCES channels.channel_connections(id),
  request_key uuid NOT NULL UNIQUE,
  request_hash varchar(64) NOT NULL,
  actor_id varchar(255) NOT NULL REFERENCES identity.users(id),
  status varchar(30) NOT NULL CHECK (status IN ('preparing','ready','committing','awaiting_payment','refunding','synchronizing','recovering','completed','recovered','review_required','failed','expired')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document)='object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX order_edit_one_active_per_order ON oms.order_edit_operations(oms_order_id)
  WHERE status NOT IN ('completed','recovered','failed','expired');
CREATE INDEX order_edit_worker_pending ON oms.order_edit_operations(updated_at,id)
  WHERE status NOT IN ('completed','recovered','failed','expired','review_required');
CREATE TABLE oms.order_edit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid REFERENCES oms.order_edit_operations(id),
  connection_id integer NOT NULL REFERENCES channels.channel_connections(id),
  actor_id varchar(255) REFERENCES identity.users(id),
  action varchar(80) NOT NULL,
  before_state jsonb,
  after_state jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE FUNCTION oms.reject_order_edit_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Order edit audit events are append-only' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER order_edit_events_immutable BEFORE UPDATE OR DELETE ON oms.order_edit_events
  FOR EACH ROW EXECUTE FUNCTION oms.reject_order_edit_event_change();
ALTER TABLE wms.orders ADD COLUMN order_edit_operation_id uuid REFERENCES oms.order_edit_operations(id);
CREATE INDEX orders_active_order_edit ON wms.orders(order_edit_operation_id) WHERE order_edit_operation_id IS NOT NULL;

-- New fulfillment partitions must not bypass an edit acquired before they exist.
-- Same identity resolver as oms-wms-order-link.sql.ts; lock the OMS parent before
-- looking up the operation, matching warehouse acquisition/release lock order.
CREATE FUNCTION wms.inherit_order_edit_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id bigint; source_channel integer; source_external text; active_operation uuid;
BEGIN
  IF TG_OP='UPDATE' AND OLD.order_edit_operation_id IS NOT NULL
    AND (NEW.source,NEW.oms_fulfillment_order_id,NEW.source_table_id,NEW.channel_id,NEW.external_order_id)
      IS DISTINCT FROM (OLD.source,OLD.oms_fulfillment_order_id,OLD.source_table_id,OLD.channel_id,OLD.external_order_id) THEN
    RAISE EXCEPTION 'Held order identity cannot change during an order edit' USING ERRCODE='23514';
  END IF;
  source_id := CASE
    WHEN NEW.source='oms' AND NEW.oms_fulfillment_order_id ~ '^[0-9]+$' AND length(NEW.oms_fulfillment_order_id)<=18
      THEN NEW.oms_fulfillment_order_id::bigint
    WHEN NEW.source_table_id ~ '^[0-9]+$' AND length(NEW.source_table_id)<=18 THEN NEW.source_table_id::bigint
    ELSE NULL END;
  IF source_id IS NULL THEN RETURN NEW; END IF;
  SELECT channel_id,external_order_id INTO source_channel,source_external FROM oms.oms_orders WHERE id=source_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT id INTO active_operation FROM oms.order_edit_operations WHERE oms_order_id=source_id
    AND status NOT IN ('completed','recovered','failed','expired');
  IF active_operation IS NOT NULL THEN
    IF NEW.channel_id IS DISTINCT FROM source_channel
      OR regexp_replace(COALESCE(NEW.external_order_id,''),'^gid://shopify/Order/','')
        IS DISTINCT FROM regexp_replace(COALESCE(source_external,''),'^gid://shopify/Order/','') THEN
      RAISE EXCEPTION 'Order edit source and warehouse identities differ' USING ERRCODE='23514';
    END IF;
    NEW.order_edit_operation_id := active_operation;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_inherit_edit_hold BEFORE INSERT OR UPDATE OF source,oms_fulfillment_order_id,source_table_id,channel_id,external_order_id
  ON wms.orders FOR EACH ROW EXECUTE FUNCTION wms.inherit_order_edit_operation();
CREATE TABLE oms.order_edit_provider_holds (
  operation_id uuid NOT NULL REFERENCES oms.order_edit_operations(id),
  shipment_id integer NOT NULL REFERENCES wms.outbound_shipments(id),
  provider_order_id bigint NOT NULL,
  was_held boolean NOT NULL,
  PRIMARY KEY(operation_id,shipment_id)
);
CREATE TABLE oms.order_edit_paid_projections (
  oms_order_id bigint PRIMARY KEY REFERENCES oms.oms_orders(id),
  operation_id uuid NOT NULL REFERENCES oms.order_edit_operations(id),
  source_updated_at timestamptz NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  projected_at timestamptz NOT NULL
);

-- Defense in depth for generic Shopify writers that miss the application
-- projection guard. Disposition-owned refund/cancel writers remain independent.
CREATE FUNCTION oms.protect_order_edit_paid_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE protected_operation uuid; source_topic text; before_row jsonb; after_row jsonb;
BEGIN
  after_row := to_jsonb(NEW);
  source_topic := after_row->>'authority_source_topic';
  IF source_topic NOT IN ('orders/create','orders/paid','orders/updated','shopify/bridge','shopify/reconcile','reconciler/authorize')
    OR source_topic IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    before_row := to_jsonb(OLD);
    IF (after_row->'quantity',after_row->'paid_quantity',after_row->'authority_fulfillable_quantity',after_row->'product_variant_id',after_row->'paid_price_cents',after_row->'total_price_cents',after_row->'total_discount_cents',after_row->'plan_discount_cents',after_row->'coupon_discount_cents')
      IS NOT DISTINCT FROM
      (before_row->'quantity',before_row->'paid_quantity',before_row->'authority_fulfillable_quantity',before_row->'product_variant_id',before_row->'paid_price_cents',before_row->'total_price_cents',before_row->'total_discount_cents',before_row->'plan_discount_cents',before_row->'coupon_discount_cents') THEN RETURN NEW; END IF;
  END IF;
  -- The application guard owns OMS -> line locking. A row trigger already
  -- holds the line and must not invert that order by acquiring its OMS parent.
  SELECT operation_id INTO protected_operation FROM oms.order_edit_paid_projections WHERE oms_order_id=NEW.order_id;
  IF protected_operation IS NULL THEN RETURN NEW; END IF;
  IF current_setting('echelon.order_edit_ingress_allowed',true)=NEW.order_id::text THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM wms.orders wo WHERE
    (CASE WHEN wo.source='oms' AND wo.oms_fulfillment_order_id ~ '^[0-9]+$' AND length(wo.oms_fulfillment_order_id)<=18 THEN wo.oms_fulfillment_order_id::bigint
      WHEN wo.source_table_id ~ '^[0-9]+$' AND length(wo.source_table_id)<=18 THEN wo.source_table_id::bigint ELSE NULL END)=NEW.order_id
    AND wo.started_at IS NULL AND wo.assigned_picker_id IS NULL AND wo.picked_count=0 AND wo.warehouse_status IN ('pending','ready','on_hold')) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Certified order edit requires projection-aware Shopify ingress' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER oms_lines_protect_order_edit_projection BEFORE INSERT OR UPDATE ON oms.oms_order_lines
  FOR EACH ROW EXECUTE FUNCTION oms.protect_order_edit_paid_line();
