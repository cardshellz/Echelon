-- Forward-only durable work: no historical fulfillments are selected or changed.
CREATE TABLE oms.shopify_label_void_work (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipping_provider_label_id bigint NOT NULL REFERENCES wms.shipping_provider_labels(id) ON DELETE RESTRICT,
  physical_shipment_id bigint NOT NULL REFERENCES wms.physical_shipments(id) ON DELETE RESTRICT,
  oms_order_id bigint NOT NULL REFERENCES oms.oms_orders(id) ON DELETE RESTRICT,
  state varchar(20) NOT NULL DEFAULT 'pending' CONSTRAINT shopify_label_void_state CHECK (state IN ('pending', 'complete', 'review')),
  attempt_count integer NOT NULL DEFAULT 0 CONSTRAINT shopify_label_void_attempt_count CHECK (attempt_count BETWEEN 0 AND 10),
  next_attempt_at timestamptz,
  last_error_code varchar(100),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT shopify_label_void_package_order UNIQUE (physical_shipment_id, oms_order_id),
  CONSTRAINT shopify_label_void_due_state CHECK ((state = 'pending') = (next_attempt_at IS NOT NULL)),
  CONSTRAINT shopify_label_void_completed_state CHECK ((state = 'complete') = (completed_at IS NOT NULL))
);
CREATE INDEX shopify_label_void_due ON oms.shopify_label_void_work(next_attempt_at, id) WHERE state = 'pending';
CREATE FUNCTION oms.validate_shopify_label_void_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM wms.shipping_provider_labels label
    JOIN wms.physical_shipments package ON package.provider = label.provider
      AND package.provider_physical_shipment_id = label.provider_label_id
    JOIN oms.channel_fulfillment_pushes command ON command.physical_shipment_id = package.id
    WHERE label.id = NEW.shipping_provider_label_id AND package.id = NEW.physical_shipment_id
      AND command.oms_order_id = NEW.oms_order_id AND command.channel_provider = 'shopify'
      AND label.provider = 'shipstation' AND label.label_status = 'voided' AND label.label_direction = 'outbound'
  ) THEN
    RAISE EXCEPTION 'Shopify void work requires the exact voided label, package and order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER shopify_label_void_scope BEFORE INSERT ON oms.shopify_label_void_work
  FOR EACH ROW EXECUTE FUNCTION oms.validate_shopify_label_void_scope();
CREATE TABLE oms.shopify_label_void_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_id bigint NOT NULL REFERENCES oms.shopify_label_void_work(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CONSTRAINT shopify_label_void_attempt_range CHECK (attempt_number BETWEEN 1 AND 10),
  outcome varchar(20) NOT NULL CONSTRAINT shopify_label_void_attempt_outcome CHECK (outcome IN ('pending', 'complete', 'review')),
  error_code varchar(100),
  evidence jsonb NOT NULL CONSTRAINT shopify_label_void_attempt_evidence CHECK (jsonb_typeof(evidence) = 'object'),
  actor varchar(100) NOT NULL,
  completed_at timestamptz NOT NULL,
  CONSTRAINT shopify_label_void_attempt_number UNIQUE (work_id, attempt_number)
);
CREATE FUNCTION oms.protect_shopify_label_void_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state <> 'pending'
    OR ROW(NEW.shipping_provider_label_id, NEW.physical_shipment_id, NEW.oms_order_id, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.shipping_provider_label_id, OLD.physical_shipment_id, OLD.oms_order_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Shopify label correction identity and completed evidence are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER shopify_label_void_work_immutable BEFORE UPDATE OR DELETE ON oms.shopify_label_void_work
  FOR EACH ROW EXECUTE FUNCTION oms.protect_shopify_label_void_work();
CREATE FUNCTION oms.protect_shopify_label_void_attempts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Shopify label correction attempts are append-only' USING ERRCODE = '55000';
END; $$;
CREATE TRIGGER shopify_label_void_attempts_immutable BEFORE UPDATE OR DELETE ON oms.shopify_label_void_attempts
  FOR EACH ROW EXECUTE FUNCTION oms.protect_shopify_label_void_attempts();

-- Keep the historical relation name so old releases can still roll back safely.
-- This is the shared exact-allocation transfer ledger, not an eBay API outbox.
COMMENT ON TABLE wms.ebay_label_replacement_work IS
  'Shared ShipStation label replacement allocation work for eBay and Shopify; legacy name retained for rolling-deploy compatibility.';
CREATE OR REPLACE FUNCTION wms.validate_label_replacement_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.label_replacement_source_item_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM wms.ebay_label_replacement_work work
    JOIN wms.shipping_provider_labels label ON label.id = work.shipping_provider_label_id
    JOIN wms.physical_shipments package ON package.id = work.physical_shipment_id
    JOIN wms.outbound_shipment_items source ON source.id = NEW.label_replacement_source_item_id
    JOIN wms.order_items order_item ON order_item.id = source.order_item_id
    JOIN oms.oms_order_lines line ON line.id = order_item.oms_order_line_id
    JOIN oms.oms_orders orders ON orders.id = line.order_id
    JOIN channels.channels channel ON channel.id = orders.channel_id
    WHERE work.state = 'applied' AND work.physical_shipment_id = NEW.physical_shipment_id
      AND source.id = ANY(work.source_item_ids)
      AND ((channel.provider = 'ebay' AND source.qty = NEW.quantity_shipped)
        OR (channel.provider = 'shopify' AND source.qty >= NEW.quantity_shipped))
      AND source.order_item_id = NEW.wms_order_item_id
      AND source.shipment_item_purpose = 'customer_fulfillment' AND channel.provider IN ('ebay', 'shopify')
      AND package.provider = label.provider AND package.provider_physical_shipment_id = label.provider_label_id
      AND package.tracking_number = label.tracking_number AND label.label_status = 'active'
      AND label.label_direction = 'outbound'
  ) THEN
    RAISE EXCEPTION 'Physical item requires exact applied label replacement provenance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
