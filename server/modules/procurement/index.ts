/**
 * @echelon/procurement — Vendors, POs, receiving, inbound shipments, landed cost, AP
 *
 * Public entrypoint barrel for `server/modules/procurement`.
 * Re-exports only pure/service contracts (`runtime-services.api`, `cost-source-evidence.api`,
 * `catalog-identity-coordination.api`) so importing the barrel never evaluates HTTP routes or
 * background worker loops. Callers of routes, workers, custody fences, health observability,
 * pipeline jobs, and CLI maintenance scripts import their dedicated `*.api.ts` contracts directly.
 */
export * from "./runtime-services.api";
export * from "./cost-source-evidence.api";
export * from "./catalog-identity-coordination.api";
