-- Warehouse-owned overrides. Legacy availability remains a read-only baseline:
-- editing warehouse A must not change implicit legacy availability at warehouse B.
CREATE TABLE shipping.warehouse_packaging_revisions (
  warehouse_id integer PRIMARY KEY REFERENCES warehouse.warehouses(id),
  revision integer NOT NULL CHECK (revision > 0)
);
CREATE TABLE shipping.warehouse_packaging_availability (
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id),
  box_id integer NOT NULL REFERENCES shipping.box_catalog(id),
  available boolean NOT NULL,
  PRIMARY KEY (warehouse_id, box_id)
);
CREATE INDEX warehouse_packaging_availability_box_idx
  ON shipping.warehouse_packaging_availability(box_id);

-- Both reviewed policies and legacy callers use the same warehouse override.
-- No rows or availability facts are invented by this migration.
CREATE FUNCTION shipping.box_available_at(p_box integer, p_warehouse integer, p_reviewed boolean)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT a.available FROM shipping.warehouse_packaging_availability a
      WHERE a.box_id=p_box AND a.warehouse_id=p_warehouse),
    (SELECT CASE WHEN p_reviewed THEN b.availability_reviewed AND EXISTS(
       SELECT 1 FROM shipping.box_warehouse_stock s WHERE s.box_id=b.id AND s.warehouse_id=p_warehouse AND s.is_stocked)
     ELSE (NOT b.availability_reviewed AND NOT EXISTS(SELECT 1 FROM shipping.box_warehouse_stock s WHERE s.box_id=b.id))
       OR EXISTS(SELECT 1 FROM shipping.box_warehouse_stock s WHERE s.box_id=b.id AND s.warehouse_id=p_warehouse AND s.is_stocked)
     END FROM shipping.box_catalog b WHERE b.id=p_box), false)
$$;
