-- Preserve existing purchase events and all history attached to a PO. The
-- event stream has always been append-only by contract (migration 0557); this
-- adds enforcement without rewriting or discarding any historical row.
BEGIN;

-- Foreign keys alone do not index referencing columns. These reads also serve
-- the application delete guard for older orders that predate po_events.
CREATE INDEX IF NOT EXISTS po_status_history_purchase_retention_idx
  ON procurement.po_status_history (purchase_order_id);
CREATE INDEX IF NOT EXISTS po_revisions_purchase_retention_idx
  ON procurement.po_revisions (purchase_order_id);

CREATE OR REPLACE FUNCTION procurement.reject_po_event_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'po_event_history_immutable',
    MESSAGE = 'Purchase order events are immutable. Append a new event instead of changing or removing history.';
END;
$$;

DROP TRIGGER IF EXISTS po_event_history_immutable_rows ON procurement.po_events;
CREATE TRIGGER po_event_history_immutable_rows
  BEFORE UPDATE OR DELETE ON procurement.po_events
  FOR EACH ROW EXECUTE FUNCTION procurement.reject_po_event_history_mutation();
DROP TRIGGER IF EXISTS po_event_history_immutable_truncate ON procurement.po_events;
CREATE TRIGGER po_event_history_immutable_truncate
  BEFORE TRUNCATE ON procurement.po_events
  FOR EACH STATEMENT EXECUTE FUNCTION procurement.reject_po_event_history_mutation();

-- Legacy POs may have status/revision history without any po_events. Protect
-- their parent from a cascading delete as well. Existing user/line SET NULL
-- policies on those older tables are outside this event-retention migration.
CREATE OR REPLACE FUNCTION procurement.reject_purchase_order_history_deletion()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  retained_history boolean;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    retained_history := EXISTS (SELECT 1 FROM procurement.po_events)
      OR EXISTS (SELECT 1 FROM procurement.po_status_history)
      OR EXISTS (SELECT 1 FROM procurement.po_revisions);
  ELSE
    retained_history := EXISTS (SELECT 1 FROM procurement.po_events WHERE po_id=OLD.id)
      OR EXISTS (SELECT 1 FROM procurement.po_status_history WHERE purchase_order_id=OLD.id)
      OR EXISTS (SELECT 1 FROM procurement.po_revisions WHERE purchase_order_id=OLD.id);
  END IF;
  IF retained_history THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'purchase_order_history_retention',
      MESSAGE = 'This purchase order has recorded history. Cancel it instead of deleting it to preserve the audit trail.';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS purchase_order_history_retention_rows ON procurement.purchase_orders;
CREATE TRIGGER purchase_order_history_retention_rows
  BEFORE DELETE ON procurement.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION procurement.reject_purchase_order_history_deletion();
DROP TRIGGER IF EXISTS purchase_order_history_retention_truncate ON procurement.purchase_orders;
CREATE TRIGGER purchase_order_history_retention_truncate
  BEFORE TRUNCATE ON procurement.purchase_orders
  FOR EACH STATEMENT EXECUTE FUNCTION procurement.reject_purchase_order_history_deletion();

COMMIT;
