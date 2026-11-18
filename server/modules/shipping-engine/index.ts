/**
 * @echelon/shipping-engine — Quote Plane, Rate Books/Tables, Routing, Shared Packaging Config & Return Labels
 *
 * External callers must import through this barrel or one of the capability-scoped
 * `*.api.ts` facades rather than deep module files (`CI-03`).
 */
export * from "./rate-quoting-and-policy.api";
export * from "./fulfillment-routing-and-connections.api";
export * from "./shared-packaging-configuration.api";
export * from "./return-shipping-and-labels.api";
export * from "./routes.api";
