-- Preserve historical scalar readbacks without inventing multi-surface evidence.
-- NULL retains the existing scalar-only contract; false proves provider drift
-- even when the provider's conservative scalar equals our desired quantity.
ALTER TABLE inventory.inventory_publication_readbacks ADD COLUMN quantity_consistent boolean;

CREATE OR REPLACE FUNCTION inventory.guard_inventory_publication_readback_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  desired_quantity bigint;
  desired_target_id integer;
  desired_variant_id integer;
BEGIN
  IF NEW.outbox_id IS NULL THEN RETURN NEW; END IF;
  SELECT outbox.desired_quantity,outbox.publication_target_id,outbox.product_variant_id
    INTO desired_quantity,desired_target_id,desired_variant_id
    FROM inventory.inventory_publication_outbox outbox WHERE outbox.id=NEW.outbox_id FOR SHARE;
  IF desired_quantity IS NULL THEN RAISE EXCEPTION 'publication outbox row does not exist'; END IF;
  IF NEW.publication_target_id<>desired_target_id OR NEW.product_variant_id<>desired_variant_id THEN
    RAISE EXCEPTION 'readback identity differs from its publication outbox row';
  END IF;
  IF NEW.matches_desired IS DISTINCT FROM (COALESCE(NEW.quantity_consistent,true) AND NEW.observed_quantity=desired_quantity) THEN
    RAISE EXCEPTION 'readback match flag does not match provider consistency and desired quantity';
  END IF;
  RETURN NEW;
END $$;
