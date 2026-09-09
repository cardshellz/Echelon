-- Keep historical suite revisions and assignment revisions recoverable.
-- A fresh install may run 238 and this migration in one transaction. Flush
-- its deferred suite foreign keys before altering the referenced tables.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE shipping.box_suites ADD COLUMN archived boolean NOT NULL DEFAULT false,
  ADD COLUMN imported boolean NOT NULL DEFAULT false;
UPDATE shipping.box_suites s SET imported=true FROM shipping.box_suite_revisions r
WHERE r.suite_id=s.id AND r.revision=1 AND r.actor_id='migration:238';
ALTER TABLE shipping.packaging_assignments ADD COLUMN is_active boolean NOT NULL DEFAULT true;
SET CONSTRAINTS ALL DEFERRED;

-- Revision tombstones prevent a stale editor from resurrecting a removed override.
CREATE OR REPLACE FUNCTION shipping.guard_active_packaging_suite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_active THEN
    PERFORM 1 FROM shipping.box_suites WHERE id=NEW.suite_id AND NOT archived FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SHIPPING_SUITE_ARCHIVED'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipping_packaging_active_suite BEFORE INSERT OR UPDATE ON shipping.packaging_assignments
FOR EACH ROW EXECUTE FUNCTION shipping.guard_active_packaging_suite();

CREATE OR REPLACE FUNCTION shipping.guard_suite_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.archived AND EXISTS (SELECT 1 FROM shipping.packaging_assignments WHERE suite_id=NEW.id AND is_active)
    THEN RAISE EXCEPTION 'SHIPPING_SUITE_IN_USE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipping_suite_archive_guard BEFORE UPDATE ON shipping.box_suites
FOR EACH ROW EXECUTE FUNCTION shipping.guard_suite_archive();
