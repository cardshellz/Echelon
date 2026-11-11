/**
 * @echelon/shipping — Provider Execution, Carrier Tracking, Package Allocation Authority & Recovery
 *
 * External callers must import through this barrel or one of the capability-scoped
 * `*.api.ts` facades rather than deep module files (`CI-03`).
 */
export * from "./engine-and-reconcile.api";
export * from "./carrier-tracking-and-dispatch.api";
export * from "./shipstation-tracking-transport.api";
export * from "./package-allocation-authority.api";
export * from "./declared-package-lifecycle.api";
export * from "./shipstation-provider-reconciliation.api";
export * from "./historical-shipstation-contents.api";
export * from "./package-history-and-delivery.api";
export * from "./outbound-shipment-queries.api";
