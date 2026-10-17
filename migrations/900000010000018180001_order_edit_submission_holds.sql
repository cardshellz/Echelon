-- Drafts never reserve fulfillment. A committing operation is persisted only
-- after explicit approval, before warehouse acquisition. Financial intent keeps
-- later payment/reconciliation states held even if their status needs review.
ALTER TABLE oms.order_edit_provider_holds ADD COLUMN released_at timestamptz;

CREATE OR REPLACE FUNCTION wms.inherit_order_edit_operation() RETURNS trigger LANGUAGE plpgsql AS $$
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
    AND status NOT IN ('completed','recovered','failed','expired')
    AND (status='committing' OR document->>'commitStartedAt' IS NOT NULL
      OR document->>'commitKey' IS NOT NULL OR document->>'refundIntent' IS NOT NULL
      OR document->>'refundStartedAt' IS NOT NULL OR document->>'recoveryStartedAt' IS NOT NULL
      OR EXISTS (SELECT 1 FROM oms.order_edit_paid_projections p WHERE p.operation_id=oms.order_edit_operations.id));
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

-- Include failed, unsubmitted attempts in cleanup without removing any hold in
-- a migration. The application verifies and audits each owned release.
CREATE INDEX order_edit_unsubmitted_cleanup ON oms.order_edit_operations(updated_at,id)
  WHERE status NOT IN ('completed','recovered','failed','expired') AND document->>'commitStartedAt' IS NULL;
