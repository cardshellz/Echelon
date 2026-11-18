-- Wake the publication worker the moment there is work, instead of waiting for
-- its timer. NOTIFY is delivered only when the writing transaction commits, and
-- carries no data: the worker re-reads the durable work rows, so a lost or
-- duplicate notification changes nothing but latency (the timer still runs).
CREATE FUNCTION inventory.wake_publication_worker() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_notify('inventory_publication_work', '');
  RETURN NULL;
END;
$$;

-- A product was marked changed (inventory.invalidate_publication_selection_product
-- inserts the row or raises its revision). The worker's own ACK writes
-- acknowledged_revision only, so it does not wake itself.
CREATE TRIGGER publication_selection_work_wake
  AFTER INSERT OR UPDATE OF revision ON inventory.publication_selection_work
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.wake_publication_worker();

-- A quantity was queued for a channel by any planner (rule apply, hold, resume,
-- manual send, the worker itself).
CREATE TRIGGER inventory_publication_outbox_wake
  AFTER INSERT ON inventory.inventory_publication_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.wake_publication_worker();
