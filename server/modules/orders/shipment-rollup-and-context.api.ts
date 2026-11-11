/**
 * Orders — Shipment Rollup Internal API (`CI-03`)
 *
 * Note: `shipment-order-context.query.ts` is intentionally NOT re-exported here;
 * `shipment-context-boundary.test.ts` enforces that only `outbound-shipment-access.query.ts`
 * may consume that private same-transaction participant directly.
 */
export * from "./shipment-rollup";
