-- Durable order projection outbox. No historical orders are queued automatically.
CREATE SEQUENCE IF NOT EXISTS oms.archon_order_revision_seq;
CREATE TABLE IF NOT EXISTS oms.archon_order_outbox (
 order_id integer PRIMARY KEY REFERENCES oms.oms_orders(id) ON DELETE CASCADE,
 revision bigint NOT NULL DEFAULT nextval('oms.archon_order_revision_seq'),
 delivered_revision bigint NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_id text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 last_error text, delivered_at timestamptz
);
CREATE OR REPLACE FUNCTION oms.queue_archon_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO oms.archon_order_outbox(order_id) VALUES(NEW.id)
 ON CONFLICT(order_id) DO UPDATE SET revision=nextval('oms.archon_order_revision_seq'),next_attempt_at=now(),attempts=0,last_error=NULL;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS queue_archon_order ON oms.oms_orders;
CREATE TRIGGER queue_archon_order AFTER INSERT OR UPDATE ON oms.oms_orders
 FOR EACH ROW EXECUTE FUNCTION oms.queue_archon_order();
CREATE INDEX IF NOT EXISTS archon_order_outbox_due ON oms.archon_order_outbox(next_attempt_at) WHERE delivered_revision<revision;
CREATE OR REPLACE FUNCTION oms.queue_archon_order_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id integer;
BEGIN
 target_id=CASE WHEN TG_OP='DELETE' THEN OLD.order_id ELSE NEW.order_id END;
 INSERT INTO oms.archon_order_outbox(order_id) SELECT target_id WHERE EXISTS(SELECT 1 FROM oms.oms_orders WHERE id=target_id)
 ON CONFLICT(order_id) DO UPDATE SET revision=nextval('oms.archon_order_revision_seq'),next_attempt_at=now(),attempts=0,last_error=NULL;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS queue_archon_order_lines ON oms.oms_order_lines;
CREATE TRIGGER queue_archon_order_lines AFTER INSERT OR UPDATE OR DELETE ON oms.oms_order_lines
 FOR EACH ROW EXECUTE FUNCTION oms.queue_archon_order_lines();
