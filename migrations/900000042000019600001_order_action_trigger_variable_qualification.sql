-- A source table can itself have a column named source (receipts and WMS
-- returns do). Qualify the PL/pgSQL variable so PostgreSQL never resolves that
-- reference against a table column and aborts the source transaction.
-- Only the presentation invalidation function changes; no business rows change.
CREATE OR REPLACE FUNCTION oms.customer_order_actions_source_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,oms,wms,returns,channels AS $$
<<source_changed>>
DECLARE value jsonb; before_value jsonb; source jsonb; ids bigint[]; all_ids bigint[]:=ARRAY[]::bigint[]; identifier bigint; record_id bigint;
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)-'updated_at')=(to_jsonb(NEW)-'updated_at') THEN RETURN NEW; END IF;
  -- UPDATE OF also fires when an ORM lists an unchanged weight alongside other
  -- changed fields. Only an actual weight change affects return inspection.
  IF TG_ARGV[0]='catalog_variant' AND TG_OP='UPDATE'
    AND (to_jsonb(OLD)->'weight_grams') IS NOT DISTINCT FROM (to_jsonb(NEW)->'weight_grams') THEN RETURN NEW; END IF;
  IF TG_OP<>'INSERT' THEN before_value=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN value=to_jsonb(NEW); END IF;
  -- Invalidate BOTH parents if a record is relinked. No slow provider I/O and no
  -- eligibility or financial decision is made while the source transaction runs.
  FOR source IN SELECT DISTINCT item FROM unnest(ARRAY[before_value,value]) item WHERE item IS NOT NULL LOOP
    ids=NULL; record_id=CASE WHEN source_changed.source->>'id' ~ '^[0-9]{1,18}$' THEN (source_changed.source->>'id')::bigint END;
    CASE TG_ARGV[0]
      WHEN 'oms_order' THEN ids=ARRAY[record_id];
      WHEN 'oms_line' THEN ids=ARRAY[(source_changed.source->>'order_id')::bigint];
      WHEN 'direct' THEN ids=ARRAY[(source_changed.source->>'oms_order_id')::bigint];
      WHEN 'wms_order' THEN
        identifier=CASE WHEN source_changed.source->>'source'='oms' AND source_changed.source->>'oms_fulfillment_order_id' ~ '^[0-9]{1,18}$'
          THEN (source_changed.source->>'oms_fulfillment_order_id')::bigint
          WHEN source_changed.source->>'source_table_id' ~ '^[0-9]{1,18}$' THEN (source_changed.source->>'source_table_id')::bigint END;
        ids=ARRAY[identifier];
      WHEN 'wms_child' THEN ids=ARRAY[oms.customer_action_wms_order_id((source_changed.source->>'order_id')::integer)];
      WHEN 'return_item' THEN SELECT ARRAY[oms.customer_action_wms_order_id(r.order_id)] INTO ids FROM wms.returns r WHERE r.id=(source_changed.source->>'return_id')::bigint;
      WHEN 'authorization_child' THEN SELECT ARRAY[a.oms_order_id] INTO ids FROM returns.customer_return_authorizations a WHERE a.id=(source_changed.source->>'authorization_id')::bigint;
      WHEN 'receipt_child' THEN SELECT ARRAY[r.oms_order_id] INTO ids FROM oms.channel_fulfillment_receipts r WHERE r.id=(source_changed.source->>'receipt_id')::bigint;
      WHEN 'push_child' THEN SELECT ARRAY[p.oms_order_id] INTO ids FROM oms.channel_fulfillment_pushes p WHERE p.id=(source_changed.source->>'channel_fulfillment_push_id')::bigint;
      WHEN 'physical' THEN ids=oms.customer_action_physical_order_ids(record_id);
      WHEN 'physical_item' THEN
        ids=oms.customer_action_physical_order_ids((source_changed.source->>'physical_shipment_id')::bigint);
        SELECT array_append(ids,COALESCE(line.order_id,oms.customer_action_wms_order_id(wi.order_id))) INTO ids
        FROM (SELECT 1) seed LEFT JOIN wms.order_items wi ON wi.id=(source_changed.source->>'wms_order_item_id')::integer
        LEFT JOIN wms.fulfillment_plan_lines plan ON plan.id=(source_changed.source->>'fulfillment_plan_line_id')::bigint
        LEFT JOIN oms.oms_order_lines line ON line.id=plan.oms_order_line_id;
      WHEN 'physical_adjustment' THEN
        SELECT oms.customer_action_physical_order_ids(item.physical_shipment_id) INTO ids
        FROM wms.physical_shipment_items item WHERE item.id=(source_changed.source->>'physical_shipment_item_id')::bigint;
      WHEN 'label' THEN ids=oms.customer_action_label_order_ids(record_id);
      WHEN 'label_link' THEN ids=oms.customer_action_physical_order_ids((source_changed.source->>'physical_shipment_id')::bigint);
      WHEN 'carrier_match' THEN ids=oms.customer_action_label_order_ids((source_changed.source->>'shipping_provider_label_id')::bigint);
      WHEN 'carrier_state' THEN
        SELECT oms.customer_action_label_order_ids(m.shipping_provider_label_id) INTO ids FROM wms.carrier_tracking_event_matches m
        WHERE m.id=(source_changed.source->>'last_match_attempt_id')::bigint;
      WHEN 'carrier_event' THEN
        SELECT array_agg(DISTINCT linked.order_id) INTO ids FROM wms.carrier_tracking_event_matches m
        CROSS JOIN LATERAL unnest(oms.customer_action_label_order_ids(m.shipping_provider_label_id)) linked(order_id)
        WHERE m.carrier_tracking_event_id=record_id;
      WHEN 'catalog_variant' THEN SELECT array_agg(DISTINCT line.order_id) INTO ids FROM oms.oms_order_lines line WHERE line.product_variant_id=record_id;
      WHEN 'inventory_return' THEN
        IF source_changed.source->>'transaction_type'='return' THEN
          ids=ARRAY[oms.customer_action_wms_order_id((source_changed.source->>'order_id')::integer)];
          SELECT array_append(ids,line.order_id) INTO ids FROM (SELECT 1) seed
          LEFT JOIN wms.order_items wi ON wi.id=(source_changed.source->>'order_item_id')::integer
          LEFT JOIN oms.oms_order_lines line ON line.id=wi.oms_order_line_id;
        END IF;
      WHEN 'channel_record' THEN
        SELECT array_agg(p.oms_order_id) INTO ids FROM oms.customer_order_actions p JOIN oms.oms_orders o ON o.id=p.oms_order_id WHERE o.channel_id=record_id;
      WHEN 'channel' THEN
        SELECT array_agg(p.oms_order_id) INTO ids FROM oms.customer_order_actions p JOIN oms.oms_orders o ON o.id=p.oms_order_id
        WHERE o.channel_id=(source_changed.source->>'channel_id')::integer;
      WHEN 'connection' THEN
        SELECT array_agg(p.oms_order_id) INTO ids FROM oms.customer_order_actions p JOIN oms.oms_orders o ON o.id=p.oms_order_id
        JOIN channels.channel_connections cc ON cc.channel_id=o.channel_id WHERE cc.id=(source_changed.source->>'connection_id')::integer;
      WHEN 'policy' THEN
        SELECT array_agg(p.oms_order_id) INTO ids FROM oms.customer_order_actions p JOIN oms.oms_orders o ON o.id=p.oms_order_id
        WHERE source_changed.source->>'channel_id' IS NULL OR o.channel_id=(source_changed.source->>'channel_id')::integer;
      WHEN 'policy_shipping' THEN
        SELECT array_agg(p.oms_order_id) INTO ids FROM oms.customer_order_actions p JOIN oms.oms_orders o ON o.id=p.oms_order_id
        JOIN returns.return_policies policy ON policy.id=(source_changed.source->>'policy_id')::integer
        WHERE policy.channel_id IS NULL OR o.channel_id=policy.channel_id;
      ELSE RAISE EXCEPTION 'Unknown order action invalidation source';
    END CASE;
    all_ids=array_cat(all_ids,COALESCE(ids,ARRAY[]::bigint[]));
  END LOOP;
  PERFORM oms.invalidate_customer_order_actions(all_ids);
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
