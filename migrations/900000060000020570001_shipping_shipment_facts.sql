-- Shipment facts: the single record of "a package shipped, with these items".
--
-- Owner: the shipping engine. A row exists only because an engine reported a
-- package; a sales channel's "fulfilled" status never creates one. Rows are
-- written once by the shipping module's shipment-fact repository and never
-- changed: UPDATE and DELETE are rejected by trigger. A void is its own fact.
--
-- No foreign keys leave the shipping schema. `oms_order_line_id` names the
-- purchased line by identifier only, so the order and shipping systems can be
-- replaced independently.

CREATE TABLE shipping.shipments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  engine VARCHAR(40) NOT NULL,
  engine_shipment_id VARCHAR(200) NOT NULL,
  ship_date DATE NOT NULL,
  carrier VARCHAR(100),
  service_code VARCHAR(100),
  tracking_number VARCHAR(200),
  source VARCHAR(40) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT shipments_engine_identity_uq UNIQUE (engine, engine_shipment_id),
  CONSTRAINT shipments_engine_chk CHECK (engine ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT shipments_engine_shipment_id_chk CHECK (btrim(engine_shipment_id) <> ''),
  CONSTRAINT shipments_source_chk CHECK (source IN ('engine_event', 'history_import')),
  CONSTRAINT shipments_content_hash_chk CHECK (content_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX shipments_tracking_number_idx ON shipping.shipments (tracking_number) WHERE tracking_number IS NOT NULL;

CREATE TABLE shipping.shipment_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id BIGINT NOT NULL REFERENCES shipping.shipments(id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL,
  channel_line_ref VARCHAR(200),
  oms_order_line_id BIGINT,
  sku VARCHAR(200),
  quantity INTEGER NOT NULL,
  purpose VARCHAR(40) NOT NULL,
  CONSTRAINT shipment_items_line_uq UNIQUE (shipment_id, line_number),
  CONSTRAINT shipment_items_line_number_chk CHECK (line_number >= 1),
  CONSTRAINT shipment_items_quantity_chk CHECK (quantity >= 1),
  CONSTRAINT shipment_items_order_line_chk CHECK (oms_order_line_id IS NULL OR oms_order_line_id > 0),
  CONSTRAINT shipment_items_purpose_chk
    CHECK (purpose IN ('fulfillment', 'replacement', 'correction', 'concession'))
);
CREATE INDEX shipment_items_order_line_idx ON shipping.shipment_items (oms_order_line_id)
  WHERE oms_order_line_id IS NOT NULL;

CREATE TABLE shipping.shipment_voids (
  shipment_id BIGINT PRIMARY KEY REFERENCES shipping.shipments(id) ON DELETE RESTRICT,
  void_date DATE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
);

CREATE FUNCTION shipping.reject_shipment_fact_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'shipment facts are add-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER shipments_add_only BEFORE UPDATE OR DELETE ON shipping.shipments
  FOR EACH ROW EXECUTE FUNCTION shipping.reject_shipment_fact_change();
CREATE TRIGGER shipment_items_add_only BEFORE UPDATE OR DELETE ON shipping.shipment_items
  FOR EACH ROW EXECUTE FUNCTION shipping.reject_shipment_fact_change();
CREATE TRIGGER shipment_voids_add_only BEFORE UPDATE OR DELETE ON shipping.shipment_voids
  FOR EACH ROW EXECUTE FUNCTION shipping.reject_shipment_fact_change();
CREATE TRIGGER shipments_no_truncate BEFORE TRUNCATE ON shipping.shipments
  FOR EACH STATEMENT EXECUTE FUNCTION shipping.reject_shipment_fact_change();
CREATE TRIGGER shipment_items_no_truncate BEFORE TRUNCATE ON shipping.shipment_items
  FOR EACH STATEMENT EXECUTE FUNCTION shipping.reject_shipment_fact_change();
CREATE TRIGGER shipment_voids_no_truncate BEFORE TRUNCATE ON shipping.shipment_voids
  FOR EACH STATEMENT EXECUTE FUNCTION shipping.reject_shipment_fact_change();

-- The one definition of units shipped for a purchased line: the units of that
-- line in packages that shipped and were not voided. Replacements, corrections
-- and concessions are extra physical items and do not count toward the line.
CREATE VIEW shipping.shipped_units_by_order_line AS
SELECT item.oms_order_line_id, SUM(item.quantity)::bigint AS shipped_quantity
FROM shipping.shipment_items item
WHERE item.oms_order_line_id IS NOT NULL
  AND item.purpose = 'fulfillment'
  AND NOT EXISTS (SELECT 1 FROM shipping.shipment_voids voided WHERE voided.shipment_id = item.shipment_id)
GROUP BY item.oms_order_line_id;
