/**
 * Pure customer-account delivery and return progress port contracts (CI-03).
 * Free of infrastructure and HTTP interface imports.
 */
export {
  customerAccountProgressScopeSchema,
  type CustomerAccountReturnProgressReader,
  type CustomerAccountDeliveryProgressReader,
  type CustomerOrderDeliveryProgress,
} from "./application/customer-account-progress.ports";
