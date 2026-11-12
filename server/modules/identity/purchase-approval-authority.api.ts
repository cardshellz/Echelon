/**
 * Transaction-scoped purchase approval & AP invoice authority readers for `identity` (CI-03).
 * Deliberately free of database singletons; callers pass their active transaction executor.
 */
export {
  readPurchaseApprovalActor,
  readPurchaseApproverName,
  readPurchaseInvoiceActionActor,
  type PurchaseApprovalIdentityTransaction,
} from "./infrastructure/purchase-approval-access.repository";
export {
  purchaseApprovalActorSchema,
  type PurchaseApprovalActor,
} from "./domain/purchase-approval-authority";
