-- Non-operational source evidence. These tables must never be projected into
-- picking, inventory movements, financial journals or channel writebacks.
CREATE TABLE wms.shipping_package_history_jobs (
  oms_order_id bigint PRIMARY KEY REFERENCES oms.oms_orders(id) ON DELETE RESTRICT,
  generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
  computed_generation bigint CHECK(computed_generation>0 AND computed_generation<=generation),
  state varchar(20) NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','retry','review')),
  priority smallint NOT NULL DEFAULT 0 CHECK(priority IN (0,1)),
  document jsonb CHECK(document IS NULL OR jsonb_typeof(document)='object'),
  evidence_hash varchar(64) CHECK(evidence_hash IS NULL OR evidence_hash ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT '-infinity',
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
  lease_id uuid,lease_until timestamptz,
  last_error_code varchar(100),
  CHECK((lease_id IS NULL)=(lease_until IS NULL)),
  CHECK((document IS NULL)=(evidence_hash IS NULL)),
  CHECK(state<>'ready' OR (document IS NOT NULL AND verified_at IS NOT NULL AND computed_generation IS NOT NULL))
);
CREATE INDEX shipping_package_history_due_idx ON wms.shipping_package_history_jobs(next_attempt_at,oms_order_id);

CREATE TABLE wms.shipping_package_history_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  oms_order_id bigint NOT NULL REFERENCES oms.oms_orders(id) ON DELETE RESTRICT,
  evidence_hash varchar(64) NOT NULL CHECK(evidence_hash ~ '^[a-f0-9]{64}$'),
  document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
  actor varchar(200) NOT NULL,observed_at timestamptz NOT NULL,
  UNIQUE(oms_order_id,evidence_hash)
);
CREATE FUNCTION wms.shipping_package_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Shipping package history evidence is immutable'; END;
$$;
CREATE TRIGGER shipping_package_history_events_immutable BEFORE UPDATE OR DELETE ON wms.shipping_package_history_events
FOR EACH ROW EXECUTE FUNCTION wms.shipping_package_history_immutable();
ALTER TABLE wms.shipping_package_history_jobs ADD CONSTRAINT shipping_package_history_event_fk
  FOREIGN KEY(oms_order_id,evidence_hash) REFERENCES wms.shipping_package_history_events(oms_order_id,evidence_hash);

-- Append-only dirty events avoid taking a derived-row lock in source writers.
CREATE TABLE wms.shipping_package_history_invalidations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,oms_order_id bigint NOT NULL CHECK(oms_order_id>0)
);
CREATE INDEX shipping_package_history_dirty_order_idx ON wms.shipping_package_history_invalidations(oms_order_id,id);
CREATE TABLE wms.shipping_package_history_backfills (
  run_key varchar(64) NOT NULL,channel_id integer NOT NULL REFERENCES channels.channels(id),
  after_order_id bigint NOT NULL DEFAULT 0 CHECK(after_order_id>=0),through_order_id bigint NOT NULL CHECK(through_order_id>=0),
  state varchar(20) NOT NULL CHECK(state IN ('scanning','seeded')),
  actor varchar(200) NOT NULL,updated_at timestamptz NOT NULL,
  PRIMARY KEY(run_key,channel_id),CHECK(after_order_id<=through_order_id)
);

CREATE FUNCTION wms.invalidate_shipping_package_history(order_ids bigint[]) RETURNS void
LANGUAGE sql SET search_path=pg_catalog,oms,channels,wms AS $$
  INSERT INTO wms.shipping_package_history_invalidations(oms_order_id)
  SELECT DISTINCT o.id FROM oms.oms_orders o JOIN channels.channels c ON c.id=o.channel_id
  WHERE o.id=ANY(order_ids) AND c.provider='shopify' AND c.type='internal' ORDER BY o.id;
$$;

CREATE FUNCTION wms.shipping_package_history_label_orders(label_id bigint) RETURNS bigint[]
LANGUAGE sql STABLE SET search_path=pg_catalog,wms,oms AS $$
  WITH label AS (SELECT * FROM wms.shipping_provider_labels WHERE id=label_id),
  native_key AS (SELECT (regexp_match(provider_order_key,'^([1-9][0-9]{0,17})-[1-9][0-9]{0,17}$'))[1] AS order_id FROM label),
  existing_links AS (SELECT unnest(oms.customer_action_label_order_ids(label_id)) AS id),
  exact_external AS (SELECT o.id FROM oms.oms_orders o JOIN native_key key
    ON o.external_order_id=key.order_id OR o.external_order_id='gid://shopify/Order/'||key.order_id),
  engine_links AS (SELECT o.id FROM label JOIN wms.outbound_shipments s ON s.shipstation_order_id::text=label.provider_order_id
    JOIN wms.orders wo ON wo.id=s.order_id JOIN oms.oms_orders o ON o.channel_id=wo.channel_id
      AND (o.id=oms.customer_action_wms_order_id(wo.id)
        OR o.external_order_id=wo.external_order_id
        OR 'gid://shopify/Order/'||o.external_order_id=wo.external_order_id))
  SELECT array_agg(DISTINCT id) FROM (SELECT id FROM existing_links UNION SELECT id FROM exact_external UNION SELECT id FROM engine_links) ids;
$$;
CREATE FUNCTION wms.shipping_package_history_source_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,wms,oms AS $$
BEGIN
  IF TG_ARGV[0]='order' THEN
    IF TG_OP='UPDATE' AND (to_jsonb(OLD)-'updated_at')=(to_jsonb(NEW)-'updated_at') THEN RETURN NEW; END IF;
    PERFORM wms.invalidate_shipping_package_history(ARRAY[NEW.id]);
  ELSIF TG_ARGV[0]='line' THEN
    IF TG_OP<>'INSERT' THEN PERFORM wms.invalidate_shipping_package_history(ARRAY[OLD.order_id]); END IF;
    IF TG_OP<>'DELETE' THEN PERFORM wms.invalidate_shipping_package_history(ARRAY[NEW.order_id]); END IF;
  ELSIF TG_ARGV[0]='label_event' THEN
    PERFORM wms.invalidate_shipping_package_history(wms.shipping_package_history_label_orders(NEW.shipping_provider_label_id));
  ELSIF TG_ARGV[0]='label' THEN
    IF TG_OP='UPDATE' AND OLD.label_status=NEW.label_status AND OLD.label_direction=NEW.label_direction
      AND OLD.tracking_number=NEW.tracking_number THEN RETURN NEW; END IF;
    PERFORM wms.invalidate_shipping_package_history(wms.shipping_package_history_label_orders(NEW.id));
  ELSIF TG_ARGV[0]='label_link' THEN
    PERFORM wms.invalidate_shipping_package_history(wms.shipping_package_history_label_orders(NEW.shipping_provider_label_id));
  ELSIF TG_ARGV[0]='physical' THEN
    PERFORM wms.invalidate_shipping_package_history(oms.customer_action_physical_order_ids(NEW.id));
  ELSIF TG_ARGV[0]='physical_item' THEN
    PERFORM wms.invalidate_shipping_package_history(oms.customer_action_physical_order_ids(NEW.physical_shipment_id));
  ELSIF TG_ARGV[0]='receipt' THEN
    PERFORM wms.invalidate_shipping_package_history(ARRAY[NEW.oms_order_id]);
  ELSIF TG_ARGV[0]='connection' THEN
    IF TG_OP='UPDATE' AND OLD.shop_domain IS NOT DISTINCT FROM NEW.shop_domain AND OLD.access_token IS NOT DISTINCT FROM NEW.access_token
      AND OLD.api_version IS NOT DISTINCT FROM NEW.api_version THEN RETURN NEW; END IF;
    PERFORM wms.invalidate_shipping_package_history(ARRAY(SELECT id FROM oms.oms_orders WHERE channel_id=NEW.channel_id));
  ELSIF TG_ARGV[0]='channel' THEN
    IF OLD.status IS NOT DISTINCT FROM NEW.status AND OLD.provider IS NOT DISTINCT FROM NEW.provider AND OLD.type IS NOT DISTINCT FROM NEW.type THEN RETURN NEW; END IF;
    PERFORM wms.invalidate_shipping_package_history(ARRAY(SELECT id FROM oms.oms_orders WHERE channel_id=NEW.id));
  ELSE RAISE EXCEPTION 'Unknown shipping package history source';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER shipping_history_order AFTER INSERT OR UPDATE ON oms.oms_orders FOR EACH ROW EXECUTE FUNCTION wms.shipping_package_history_source_changed('order');
CREATE TRIGGER shipping_history_line AFTER INSERT OR UPDATE OR DELETE ON oms.oms_order_lines FOR EACH ROW EXECUTE FUNCTION wms.shipping_package_history_source_changed('line');
CREATE TRIGGER shipping_history_label_event AFTER INSERT ON wms.shipping_provider_label_events FOR EACH ROW EXECUTE FUNCTION wms.shipping_package_history_source_changed('label_event');
CREATE TRIGGER shipping_history_label AFTER INSERT OR UPDATE ON wms.shipping_provider_labels FOR EACH ROW EXECUTE FUNCTION wms.shipping_package_history_source_changed('label');
CREATE TRIGGER shipping_history_label_link AFTER INSERT OR UPDATE ON wms.shipping_provider_label_links FOR EACH ROW EXECUTE FUNCTION wms.shipping_package_history_source_changed('label_link');
CREATE TRIGGER shipping_history_physical AFTER INSERT OR UPDATE ON wms.physical_shipments FOR EACH ROW EXECUTE FUNCTION wms.shipping_package_history_source_changed('physical');
CREATE TRIGGER shipping_history_physical_item AFTER INSERT OR UPDATE ON wms.physical_shipment_items FOR EACH ROW EXECUTE FUNCTION wms.shipping_package_history_source_changed('physical_item');
CREATE TRIGGER shipping_history_receipt AFTER INSERT OR UPDATE ON oms.channel_fulfillment_receipts FOR EACH ROW EXECUTE FUNCTION wms.shipping_package_history_source_changed('receipt');
CREATE TRIGGER shipping_history_connection AFTER INSERT OR UPDATE ON channels.channel_connections FOR EACH ROW EXECUTE FUNCTION wms.shipping_package_history_source_changed('connection');
CREATE TRIGGER shipping_history_channel AFTER UPDATE ON channels.channels FOR EACH ROW EXECUTE FUNCTION wms.shipping_package_history_source_changed('channel');
-- No historical seed here. A reviewed, scoped dry-run/execute command owns it.
