-- Customer receiving is anchored to verified purchased lines. Do not create
-- synthetic outbound orders, shipments or fulfillment identities.
ALTER TABLE wms.returns ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE wms.returns ADD COLUMN source_authorization_id bigint REFERENCES returns.customer_return_authorizations(id);
ALTER TABLE wms.returns ADD CONSTRAINT purchase_return_receiving_source CHECK (
  (order_id IS NOT NULL AND source_authorization_id IS NULL)
  OR (order_id IS NULL AND source='customer_portal' AND source_authorization_id IS NOT NULL));
CREATE UNIQUE INDEX purchase_return_receiving_once ON wms.returns(source_authorization_id) WHERE source_authorization_id IS NOT NULL;
ALTER TABLE returns.return_cases ALTER COLUMN wms_order_id DROP NOT NULL;
ALTER TABLE returns.return_cases ADD CONSTRAINT purchase_return_case_source CHECK (wms_order_id IS NOT NULL OR source_provider='customer_portal');
ALTER TABLE returns.return_case_items ALTER COLUMN unit_paid_price_cents DROP NOT NULL;
ALTER TABLE returns.return_case_items ALTER COLUMN source_line_total_cents DROP NOT NULL;
ALTER TABLE returns.customer_return_authorization_allocations
  ADD COLUMN source_kind text NOT NULL DEFAULT 'shopify_fulfillment',
  ALTER COLUMN wms_order_item_id DROP NOT NULL,
  ALTER COLUMN fulfillment_id DROP NOT NULL,
  ALTER COLUMN fulfillment_line_item_id DROP NOT NULL;
ALTER TABLE returns.customer_return_authorization_allocations ADD CONSTRAINT purchase_return_allocation_source CHECK (
  (source_kind='shopify_fulfillment' AND wms_order_item_id IS NOT NULL AND fulfillment_id IS NOT NULL AND fulfillment_line_item_id IS NOT NULL)
  OR (source_kind='shopify_purchase' AND wms_order_item_id IS NULL AND fulfillment_id IS NULL AND fulfillment_line_item_id IS NULL));
CREATE UNIQUE INDEX purchase_return_line_allocation_once ON returns.customer_return_authorization_allocations(authorization_line_id)
  WHERE source_kind='shopify_purchase';
ALTER TABLE returns.customer_return_case_links DROP CONSTRAINT customer_return_case_links_pkey;
ALTER TABLE returns.customer_return_case_links ALTER COLUMN wms_order_id DROP NOT NULL;
ALTER TABLE returns.customer_return_case_links ADD PRIMARY KEY(authorization_id,case_id);
CREATE UNIQUE INDEX customer_return_legacy_partition_once ON returns.customer_return_case_links(authorization_id,wms_order_id) WHERE wms_order_id IS NOT NULL;
CREATE UNIQUE INDEX customer_return_purchase_case_once ON returns.customer_return_case_links(authorization_id) WHERE wms_order_id IS NULL;

CREATE OR REPLACE FUNCTION returns.guard_customer_return_authorization_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'customer_return_authorizations' THEN
    IF NOT EXISTS (SELECT 1 FROM oms.oms_orders WHERE id=NEW.oms_order_id AND channel_id=NEW.channel_id) THEN
      RAISE EXCEPTION 'Authorization source channel does not match its OMS order' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'customer_return_authorization_lines' THEN
    IF NOT EXISTS (SELECT 1 FROM returns.customer_return_authorizations a JOIN oms.oms_order_lines ol ON ol.order_id=a.oms_order_id
      WHERE a.id=NEW.authorization_id AND ol.id=NEW.oms_order_line_id AND ol.external_line_item_id=NEW.external_line_item_id) THEN
      RAISE EXCEPTION 'Authorization line does not match its OMS source' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.source_kind='shopify_purchase' THEN
      IF NOT EXISTS (SELECT 1 FROM returns.customer_return_authorization_lines al
        JOIN returns.customer_return_authorizations a ON a.id=al.authorization_id
        JOIN oms.oms_order_lines ol ON ol.id=al.oms_order_line_id AND ol.order_id=a.oms_order_id
        WHERE al.id=NEW.authorization_line_id AND al.authorization_id=NEW.authorization_id
          AND ol.external_line_item_id=al.external_line_item_id
          AND NEW.delivery_evidence->>'method'='verified_shopify_purchase_v1') THEN
        RAISE EXCEPTION 'Purchase authorization does not match its purchased source' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
    IF (SELECT count(*) FROM returns.customer_return_authorization_lines al
      JOIN returns.customer_return_authorizations a ON a.id=al.authorization_id
      JOIN returns.customer_return_source_items s ON s.oms_order_id=a.oms_order_id
        AND s.oms_order_line_id=al.oms_order_line_id AND s.wms_order_item_id=NEW.wms_order_item_id
      WHERE al.id=NEW.authorization_line_id AND al.authorization_id=NEW.authorization_id) <> 1 THEN
      RAISE EXCEPTION 'Authorization allocation does not match its purchased-line source' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION returns.guard_customer_return_intake_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
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
        AND ci.wms_order_item_id IS NOT DISTINCT FROM aa.wms_order_item_id AND ri.order_item_id IS NOT DISTINCT FROM aa.wms_order_item_id
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
CREATE OR REPLACE FUNCTION returns.guard_customer_return_intake_graph() RETURNS trigger LANGUAGE plpgsql AS $$
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
        OR ci.wms_return_item_id <> ri.id OR ci.wms_order_item_id IS DISTINCT FROM aa.wms_order_item_id
        OR ri.order_item_id IS DISTINCT FROM aa.wms_order_item_id OR ci.oms_order_line_id <> al.oms_order_line_id
        OR ri.oms_order_line_id <> al.oms_order_line_id OR ri.return_id <> cl.wms_return_id)
    ) OR EXISTS (
      SELECT 1 FROM returns.customer_return_case_links cl
      JOIN returns.return_cases rc ON rc.id = cl.case_id
      JOIN returns.customer_return_authorizations a ON a.id = cl.authorization_id
      JOIN wms.returns wr ON wr.id = cl.wms_return_id
      WHERE cl.authorization_id = root_id AND (rc.wms_return_id <> cl.wms_return_id OR rc.wms_order_id IS DISTINCT FROM cl.wms_order_id
        OR wr.order_id IS DISTINCT FROM cl.wms_order_id OR rc.oms_order_id <> a.oms_order_id OR rc.channel_id <> a.channel_id
        OR (cl.wms_order_id IS NULL AND wr.source_authorization_id IS DISTINCT FROM root_id)
        OR rc.source_provider <> 'customer_portal' OR rc.source_event_type <> 'private_customer_return'
        OR rc.source_event_id <> root_id::text || ':' || COALESCE(cl.wms_order_id::text,'purchase') OR rc.created_at <> a.created_at)
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
CREATE FUNCTION returns.guard_purchase_receiving_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.order_id,NEW.source_authorization_id,NEW.source,NEW.source_event_key)
    IS DISTINCT FROM (OLD.order_id,OLD.source_authorization_id,OLD.source,OLD.source_event_key)
    AND (OLD.source_authorization_id IS NOT NULL OR NEW.source_authorization_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Purchased return receiving provenance is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_receiving_identity BEFORE UPDATE ON wms.returns
  FOR EACH ROW EXECUTE FUNCTION returns.guard_purchase_receiving_identity();

-- Stock receipts use the canonical disposition as their audit reference when
-- original sold-cost evidence is absent. Existing unresolved-cost follow-ups
-- retain the costing obligation; absence of WMS history must not block receiving.
ALTER TABLE IF EXISTS inventory.return_cost_allocations ALTER COLUMN wms_order_id DROP NOT NULL;
DO $$ BEGIN
  IF to_regclass('inventory.return_cost_allocations') IS NOT NULL THEN
    ALTER TABLE inventory.return_cost_allocations ADD CONSTRAINT purchase_return_cost_source CHECK (
      wms_order_id IS NOT NULL OR (wms_order_item_id IS NULL AND source_order_item_cost_id IS NULL
        AND operation_key ~ '^return_inventory_treatment:[1-9][0-9]*$'));
  END IF;
END $$;

CREATE FUNCTION returns.guard_purchase_return_money_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.unit_paid_price_cents IS NULL) IS DISTINCT FROM (NEW.source_line_total_cents IS NULL)
    OR (NEW.unit_paid_price_cents IS NULL AND NOT EXISTS (
      SELECT 1 FROM returns.return_cases rc WHERE rc.id=NEW.return_case_id
        AND rc.source_provider='customer_portal' AND rc.wms_order_id IS NULL AND NEW.wms_order_item_id IS NULL)) THEN
    RAISE EXCEPTION 'Unknown money is permitted only on a purchased-line return with manual Shopify refund authority' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_return_money_snapshot BEFORE INSERT ON returns.return_case_items
  FOR EACH ROW EXECUTE FUNCTION returns.guard_purchase_return_money_snapshot();

-- Refresh derived options through the normal bounded worker. This changes no
-- order facts and is not a special-case repair for an individual customer.
DO $$ BEGIN
  IF to_regclass('oms.customer_order_actions') IS NOT NULL THEN
    INSERT INTO oms.customer_order_action_invalidations(oms_order_id)
    SELECT projection.oms_order_id FROM oms.customer_order_actions projection
    JOIN oms.oms_orders purchase ON purchase.id=projection.oms_order_id
    JOIN channels.channels channel ON channel.id=purchase.channel_id
    WHERE channel.provider='shopify' AND (projection.snapshot->>'returnFailed'='true'
      OR projection.snapshot #>> '{returnOrder,order,returnWindowEndsAt}' >= to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      AND NOT EXISTS (SELECT 1 FROM oms.customer_order_action_invalidations dirty WHERE dirty.oms_order_id=projection.oms_order_id)
    ORDER BY projection.oms_order_id;
  END IF;
END $$;
