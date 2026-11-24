/**
 * Advisory-lock namespaces for WMS shipment work.
 *
 * Postgres advisory locks are (int4 namespace, int4 key) pairs. These constants
 * are the single source of truth for the shipment-related namespaces so the
 * session-lock helper (`server/infrastructure/session-advisory-lock.ts`) and the
 * transaction-scoped `pg_advisory_xact_lock` call sites cannot drift apart.
 */

/**
 * Key = `wms.orders.id`. Serializes shipment creation and coverage work for one
 * WMS order: `createShipmentForOrder`, `late-order-shipment-coverage`, and the
 * SHIP_NOTIFY split / combined-child resolution in `shipstation.service.ts`.
 */
export const WMS_ORDER_SHIPMENT_LOCK_NAMESPACE = 918406;

/**
 * Key = `wms.outbound_shipments.id`. Serializes engine push and amend work for
 * one shipment: `pushShipment` and `appendShipmentItems`.
 *
 * KNOWN OVERLOAD: the same namespace is also used with an OMS order id
 * (`wms-sync.service.ts`) and a shipment item id (`inventory.use-cases.ts`).
 * Ids from different tables can collide, which causes false contention (a
 * short wait), never lost exclusion. Splitting those callers into their own
 * namespaces is a separate change.
 */
export const WMS_SHIPMENT_PUSH_LOCK_NAMESPACE = 918407;
