-- 125: ShipStation split shipments must not collide with the parent engine identity.
--
-- SHIP_NOTIFY can report a legitimate partial physical package for an active
-- WMS shipment. In that case shipstation.service.ts creates a child shipment
-- with source='shipstation_split' so the unshipped remainder stays tracked.
-- The child necessarily carries the same ShipStation order id/key as the
-- parent package, so the active engine identity uniqueness predicates must
-- exclude this source just like the active-per-order predicate already does.
--
-- Without this, SHIP_NOTIFY retries die before the shipment can roll forward:
--   duplicate key value violates unique constraint
--   "uq_outbound_shipments_active_shipstation_order_key"
-- or
--   "uq_outbound_shipments_active_shipstation_order_id"
--
-- DROP + CREATE because PostgreSQL cannot alter a partial index predicate.

DROP INDEX IF EXISTS wms.uq_outbound_shipments_active_shipstation_order_id;
DROP INDEX IF EXISTS wms.uq_outbound_shipments_active_shipstation_order_key;
DROP INDEX IF EXISTS wms.uq_outbound_shipments_active_engine_order_ref;

CREATE UNIQUE INDEX uq_outbound_shipments_active_shipstation_order_id
  ON wms.outbound_shipments USING btree (shipstation_order_id)
  WHERE (
    status = ANY (ARRAY[
      'planned'::wms.shipment_status,
      'queued'::wms.shipment_status,
      'labeled'::wms.shipment_status,
      'on_hold'::wms.shipment_status
    ])
    AND (COALESCE(source, ''::character varying))::text <> ALL ((ARRAY[
      'echelon_combined_child',
      'shipstation_combined_child',
      'shipstation_split'
    ])::text[])
    AND shipstation_order_id IS NOT NULL
  );

CREATE UNIQUE INDEX uq_outbound_shipments_active_shipstation_order_key
  ON wms.outbound_shipments USING btree (shipstation_order_key)
  WHERE (
    status = ANY (ARRAY[
      'planned'::wms.shipment_status,
      'queued'::wms.shipment_status,
      'labeled'::wms.shipment_status,
      'on_hold'::wms.shipment_status
    ])
    AND (COALESCE(source, ''::character varying))::text <> ALL ((ARRAY[
      'echelon_combined_child',
      'shipstation_combined_child',
      'shipstation_split'
    ])::text[])
    AND NULLIF(btrim((shipstation_order_key)::text), ''::text) IS NOT NULL
  );

CREATE UNIQUE INDEX uq_outbound_shipments_active_engine_order_ref
  ON wms.outbound_shipments USING btree (shipping_engine, engine_order_ref)
  WHERE (
    status = ANY (ARRAY[
      'planned'::wms.shipment_status,
      'queued'::wms.shipment_status,
      'labeled'::wms.shipment_status,
      'on_hold'::wms.shipment_status
    ])
    AND (COALESCE(source, ''::character varying))::text <> ALL ((ARRAY[
      'echelon_combined_child',
      'shipstation_combined_child',
      'shipstation_split'
    ])::text[])
    AND NULLIF(btrim((shipping_engine)::text), ''::text) IS NOT NULL
    AND NULLIF(btrim((engine_order_ref)::text), ''::text) IS NOT NULL
  );
