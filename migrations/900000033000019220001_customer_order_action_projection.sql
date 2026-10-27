-- Derived customer presentation only. No order, settlement, inventory, or points mutation.
CREATE TABLE oms.customer_order_actions (
  oms_order_id bigint PRIMARY KEY REFERENCES oms.oms_orders(id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
  computed_generation bigint CHECK(computed_generation>0 AND computed_generation<=generation),
  snapshot jsonb CHECK(snapshot IS NULL OR jsonb_typeof(snapshot)='object'),
  verified_at timestamptz,
  valid_until timestamptz,
  next_refresh_at timestamptz NOT NULL DEFAULT '-infinity',
  lease_id uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 30),
  last_error_code varchar(80),
  last_error_class varchar(20) CHECK(last_error_class IN ('transient','permanent')),
  CHECK((lease_id IS NULL)=(lease_until IS NULL)),
  CHECK((snapshot IS NULL)=(verified_at IS NULL)),
  CHECK((snapshot IS NULL)=(valid_until IS NULL)),
  CHECK((last_error_code IS NULL)=(last_error_class IS NULL))
);
CREATE INDEX customer_order_actions_due_idx ON oms.customer_order_actions(next_refresh_at,oms_order_id);

-- An invalidation retains a source identity even if the order is subsequently
-- removed. No FK or cache-row lock is taken in the source transaction. The worker
-- discards orphan events and verifies current ownership before publishing.
CREATE TABLE oms.customer_order_action_invalidations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  oms_order_id bigint NOT NULL CHECK(oms_order_id>0)
);
CREATE INDEX customer_order_action_invalidations_order_idx ON oms.customer_order_action_invalidations(oms_order_id,id);

CREATE TABLE returns.customer_return_box_measurements (
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  box_id varchar(68) NOT NULL CHECK(box_id ~ '^box-[a-f0-9]{64}$'),
  source_fingerprint varchar(64) NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
  dimensions jsonb NOT NULL CHECK(jsonb_typeof(dimensions)='object'),
  verified_at timestamptz NOT NULL,
  PRIMARY KEY(channel_id,box_id)
);

-- This is a transactional dirty queue, not a second eligibility engine. Source
-- writers only invalidate derived presentation. The worker owns every decision.
CREATE FUNCTION oms.invalidate_customer_order_actions(order_ids bigint[]) RETURNS void
LANGUAGE sql SET search_path=pg_catalog,oms,channels AS $$
  INSERT INTO oms.customer_order_action_invalidations(oms_order_id)
    SELECT DISTINCT o.id FROM oms.oms_orders o JOIN channels.channels c ON c.id=o.channel_id
    WHERE o.id=ANY(order_ids) AND c.provider='shopify' AND o.external_customer_id ~ '^[1-9][0-9]*$'
    ORDER BY o.id;
$$;

-- Same canonical link as oms-wms-order-link.sql.ts. Never cast a provider ID
-- or prefer a numeric legacy alias over a valid direct OMS reference.
CREATE FUNCTION oms.customer_action_wms_order_id(wms_id integer) RETURNS bigint
LANGUAGE sql STABLE SET search_path=pg_catalog,wms AS $$
  SELECT CASE WHEN wo.source='oms' AND wo.oms_fulfillment_order_id ~ '^[0-9]+$'
    AND length(wo.oms_fulfillment_order_id)<=18 THEN wo.oms_fulfillment_order_id::bigint
    WHEN wo.source_table_id ~ '^[0-9]+$' AND length(wo.source_table_id)<=18 THEN wo.source_table_id::bigint END
  FROM wms.orders wo WHERE wo.id=wms_id;
$$;

CREATE FUNCTION oms.customer_action_physical_order_ids(physical_id bigint) RETURNS bigint[]
LANGUAGE sql STABLE SET search_path=pg_catalog,wms,oms AS $$
  SELECT array_agg(DISTINCT COALESCE(line.order_id,oms.customer_action_wms_order_id(wi.order_id)))
  FROM wms.physical_shipment_items item
  LEFT JOIN wms.order_items wi ON wi.id=item.wms_order_item_id
  LEFT JOIN wms.fulfillment_plan_lines plan ON plan.id=item.fulfillment_plan_line_id
  LEFT JOIN oms.oms_order_lines line ON line.id=plan.oms_order_line_id
  WHERE item.physical_shipment_id=physical_id;
$$;

CREATE FUNCTION oms.customer_action_label_order_ids(label_id bigint) RETURNS bigint[]
LANGUAGE sql STABLE SET search_path=pg_catalog,wms,oms AS $$
  SELECT array_agg(DISTINCT ids.order_id) FROM wms.shipping_provider_label_links link
  CROSS JOIN LATERAL unnest(oms.customer_action_physical_order_ids(link.physical_shipment_id)) ids(order_id)
  WHERE link.shipping_provider_label_id=label_id;
$$;

CREATE FUNCTION oms.customer_order_actions_source_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,oms,wms,returns,channels AS $$
DECLARE value jsonb; before_value jsonb; source jsonb; ids bigint[]; all_ids bigint[]:=ARRAY[]::bigint[]; identifier bigint; record_id bigint;
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)-'updated_at')=(to_jsonb(NEW)-'updated_at') THEN RETURN NEW; END IF;
  IF TG_OP<>'INSERT' THEN before_value=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN value=to_jsonb(NEW); END IF;
  -- Invalidate BOTH parents if a record is relinked. No slow provider I/O and no
  -- eligibility or financial decision is made while the source transaction runs.
  FOR source IN SELECT DISTINCT item FROM unnest(ARRAY[before_value,value]) item WHERE item IS NOT NULL LOOP
    ids=NULL; record_id=CASE WHEN source->>'id' ~ '^[0-9]{1,18}$' THEN (source->>'id')::bigint END;
    CASE TG_ARGV[0]
      WHEN 'oms_order' THEN ids=ARRAY[record_id];
      WHEN 'oms_line' THEN ids=ARRAY[(source->>'order_id')::bigint];
      WHEN 'direct' THEN ids=ARRAY[(source->>'oms_order_id')::bigint];
      WHEN 'wms_order' THEN
        identifier=CASE WHEN source->>'source'='oms' AND source->>'oms_fulfillment_order_id' ~ '^[0-9]{1,18}$'
          THEN (source->>'oms_fulfillment_order_id')::bigint
          WHEN source->>'source_table_id' ~ '^[0-9]{1,18}$' THEN (source->>'source_table_id')::bigint END;
        ids=ARRAY[identifier];
      WHEN 'wms_child' THEN ids=ARRAY[oms.customer_action_wms_order_id((source->>'order_id')::integer)];
      WHEN 'return_item' THEN SELECT ARRAY[oms.customer_action_wms_order_id(r.order_id)] INTO ids FROM wms.returns r WHERE r.id=(source->>'return_id')::bigint;
      WHEN 'authorization_child' THEN SELECT ARRAY[a.oms_order_id] INTO ids FROM returns.customer_return_authorizations a WHERE a.id=(source->>'authorization_id')::bigint;
      WHEN 'receipt_child' THEN SELECT ARRAY[r.oms_order_id] INTO ids FROM oms.channel_fulfillment_receipts r WHERE r.id=(source->>'receipt_id')::bigint;
      WHEN 'push_child' THEN SELECT ARRAY[p.oms_order_id] INTO ids FROM oms.channel_fulfillment_pushes p WHERE p.id=(source->>'channel_fulfillment_push_id')::bigint;
      WHEN 'physical' THEN ids=oms.customer_action_physical_order_ids(record_id);
      WHEN 'physical_item' THEN
        ids=oms.customer_action_physical_order_ids((source->>'physical_shipment_id')::bigint);
        SELECT array_append(ids,COALESCE(line.order_id,oms.customer_action_wms_order_id(wi.order_id))) INTO ids
        FROM (SELECT 1) seed LEFT JOIN wms.order_items wi ON wi.id=(source->>'wms_order_item_id')::integer
        LEFT JOIN wms.fulfillment_plan_lines plan ON plan.id=(source->>'fulfillment_plan_line_id')::bigint
        LEFT JOIN oms.oms_order_lines line ON line.id=plan.oms_order_line_id;
      WHEN 'physical_adjustment' THEN
        SELECT oms.customer_action_physical_order_ids(item.physical_shipment_id) INTO ids
        FROM wms.physical_shipment_items item WHERE item.id=(source->>'physical_shipment_item_id')::bigint;
      WHEN 'label' THEN ids=oms.customer_action_label_order_ids(record_id);
      WHEN 'label_link' THEN ids=oms.customer_action_physical_order_ids((source->>'physical_shipment_id')::bigint);
      WHEN 'carrier_match' THEN ids=oms.customer_action_label_order_ids((source->>'shipping_provider_label_id')::bigint);
      WHEN 'carrier_state' THEN
        SELECT oms.customer_action_label_order_ids(m.shipping_provider_label_id) INTO ids FROM wms.carrier_tracking_event_matches m
        WHERE m.id=(source->>'last_match_attempt_id')::bigint;
      WHEN 'carrier_event' THEN
        SELECT array_agg(DISTINCT linked.order_id) INTO ids FROM wms.carrier_tracking_event_matches m
        CROSS JOIN LATERAL unnest(oms.customer_action_label_order_ids(m.shipping_provider_label_id)) linked(order_id)
        WHERE m.carrier_tracking_event_id=record_id;
      WHEN 'catalog_variant' THEN SELECT array_agg(DISTINCT line.order_id) INTO ids FROM oms.oms_order_lines line WHERE line.product_variant_id=record_id;
      WHEN 'inventory_return' THEN
        IF source->>'transaction_type'='return' THEN
          ids=ARRAY[oms.customer_action_wms_order_id((source->>'order_id')::integer)];
          SELECT array_append(ids,line.order_id) INTO ids FROM (SELECT 1) seed
          LEFT JOIN wms.order_items wi ON wi.id=(source->>'order_item_id')::integer
          LEFT JOIN oms.oms_order_lines line ON line.id=wi.oms_order_line_id;
        END IF;
      WHEN 'channel_record' THEN
        SELECT array_agg(p.oms_order_id) INTO ids FROM oms.customer_order_actions p JOIN oms.oms_orders o ON o.id=p.oms_order_id WHERE o.channel_id=record_id;
      WHEN 'channel' THEN
        SELECT array_agg(p.oms_order_id) INTO ids FROM oms.customer_order_actions p JOIN oms.oms_orders o ON o.id=p.oms_order_id
        WHERE o.channel_id=(source->>'channel_id')::integer;
      WHEN 'connection' THEN
        SELECT array_agg(p.oms_order_id) INTO ids FROM oms.customer_order_actions p JOIN oms.oms_orders o ON o.id=p.oms_order_id
        JOIN channels.channel_connections cc ON cc.channel_id=o.channel_id WHERE cc.id=(source->>'connection_id')::integer;
      WHEN 'policy' THEN
        SELECT array_agg(p.oms_order_id) INTO ids FROM oms.customer_order_actions p JOIN oms.oms_orders o ON o.id=p.oms_order_id
        WHERE source->>'channel_id' IS NULL OR o.channel_id=(source->>'channel_id')::integer;
      WHEN 'policy_shipping' THEN
        SELECT array_agg(p.oms_order_id) INTO ids FROM oms.customer_order_actions p JOIN oms.oms_orders o ON o.id=p.oms_order_id
        JOIN returns.return_policies policy ON policy.id=(source->>'policy_id')::integer
        WHERE policy.channel_id IS NULL OR o.channel_id=policy.channel_id;
      ELSE RAISE EXCEPTION 'Unknown order action invalidation source';
    END CASE;
    all_ids=array_cat(all_ids,COALESCE(ids,ARRAY[]::bigint[]));
  END LOOP;
  PERFORM oms.invalidate_customer_order_actions(all_ids);
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE TRIGGER customer_actions_order AFTER INSERT OR UPDATE ON oms.oms_orders FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('oms_order');
CREATE TRIGGER customer_actions_line AFTER INSERT OR UPDATE OR DELETE ON oms.oms_order_lines FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('oms_line');
CREATE TRIGGER customer_actions_operation AFTER INSERT OR UPDATE OR DELETE ON oms.order_edit_operations FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('direct');
CREATE TRIGGER customer_actions_warehouse AFTER INSERT OR UPDATE OR DELETE ON wms.orders FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('wms_order');
CREATE TRIGGER customer_actions_warehouse_item AFTER INSERT OR UPDATE OR DELETE ON wms.order_items FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('wms_child');
CREATE TRIGGER customer_actions_legacy_return AFTER INSERT OR UPDATE OR DELETE ON wms.returns FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('wms_child');
CREATE TRIGGER customer_actions_legacy_return_item AFTER INSERT OR UPDATE OR DELETE ON wms.return_items FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('return_item');
CREATE TRIGGER customer_actions_authorization AFTER INSERT OR UPDATE OR DELETE ON returns.customer_return_authorizations FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('direct');
CREATE TRIGGER customer_actions_authorization_line AFTER INSERT OR UPDATE OR DELETE ON returns.customer_return_authorization_lines FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('authorization_child');
CREATE TRIGGER customer_actions_authorization_allocation AFTER INSERT OR UPDATE OR DELETE ON returns.customer_return_authorization_allocations FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('authorization_child');
CREATE TRIGGER customer_actions_receipt AFTER INSERT OR UPDATE OR DELETE ON oms.channel_fulfillment_receipts FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('direct');
CREATE TRIGGER customer_actions_receipt_item AFTER INSERT OR UPDATE OR DELETE ON oms.channel_fulfillment_receipt_items FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('receipt_child');
CREATE TRIGGER customer_actions_push AFTER INSERT OR UPDATE OR DELETE ON oms.channel_fulfillment_pushes FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('direct');
CREATE TRIGGER customer_actions_push_item AFTER INSERT OR UPDATE OR DELETE ON oms.channel_fulfillment_push_items FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('push_child');
CREATE TRIGGER customer_actions_physical AFTER INSERT OR UPDATE OR DELETE ON wms.physical_shipments FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('physical');
CREATE TRIGGER customer_actions_physical_item AFTER INSERT OR UPDATE OR DELETE ON wms.physical_shipment_items FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('physical_item');
CREATE TRIGGER customer_actions_physical_adjustment AFTER INSERT OR UPDATE OR DELETE ON wms.physical_shipment_item_quantity_adjustments FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('physical_adjustment');
CREATE TRIGGER customer_actions_label AFTER INSERT OR UPDATE OR DELETE ON wms.shipping_provider_labels FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('label');
CREATE TRIGGER customer_actions_label_link AFTER INSERT OR UPDATE OR DELETE ON wms.shipping_provider_label_links FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('label_link');
CREATE TRIGGER customer_actions_carrier_match AFTER INSERT OR UPDATE OR DELETE ON wms.carrier_tracking_event_matches FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('carrier_match');
CREATE TRIGGER customer_actions_carrier_state AFTER INSERT OR UPDATE OR DELETE ON wms.carrier_tracking_reconciliation_state FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('carrier_state');
CREATE TRIGGER customer_actions_carrier_event AFTER UPDATE OR DELETE ON wms.carrier_tracking_events FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('carrier_event');
CREATE TRIGGER customer_actions_variant AFTER INSERT OR UPDATE OR DELETE ON catalog.product_variants FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('catalog_variant');
CREATE TRIGGER customer_actions_inventory_return AFTER INSERT OR UPDATE OR DELETE ON inventory.inventory_transactions FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('inventory_return');
CREATE TRIGGER customer_actions_channel AFTER UPDATE ON channels.channels FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('channel_record');
CREATE TRIGGER customer_actions_connection AFTER INSERT OR UPDATE OR DELETE ON channels.channel_connections FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('channel');
CREATE TRIGGER customer_actions_policy AFTER INSERT OR UPDATE OR DELETE ON returns.return_policies FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('policy');
CREATE TRIGGER customer_actions_policy_shipping AFTER INSERT OR UPDATE OR DELETE ON returns.return_policy_shipping FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('policy_shipping');
CREATE TRIGGER customer_actions_return_control AFTER INSERT OR UPDATE OR DELETE ON returns.customer_return_label_controls FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('channel');
CREATE TRIGGER customer_actions_edit_settings AFTER INSERT OR UPDATE OR DELETE ON oms.order_edit_settings FOR EACH ROW EXECUTE FUNCTION oms.customer_order_actions_source_changed('connection');
