/**
 * Transaction-scoped invalidation seam for upstream read-model writers (CI-03).
 * Deliberately free of database singletons and composition imports.
 */
export { invalidateCustomerOrderActions } from "./order-action-invalidation";
