/**
 * Public barrel for `@echelon/customer-account` (CI-03).
 *
 * Re-exports pure domain/application contracts and transaction-scoped invalidation.
 * Composition, worker, Shopify reader, and HTTP route consumers import the dedicated
 * `*.api.ts` facades (`runtime.api`, `order-action-projection.api`,
 * `shopify-account-native.api`, `routes.api`).
 */
export * from "./staging-config.api";
export * from "./account-native-contracts.api";
export * from "./order-cancellation-contracts.api";
export * from "./order-action-projection-contracts.api";
export * from "./progress-contracts.api";
export * from "./order-action-invalidation.api";
