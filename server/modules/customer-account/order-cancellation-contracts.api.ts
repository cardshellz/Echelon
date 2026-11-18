/**
 * Pure application contracts and orchestration service for customer order cancellation
 * and reward redemption coordination (CI-03).
 * Free of infrastructure and HTTP interface imports.
 */
export { OrderCancellationService } from "./application/order-cancellation.service";
export {
  cancellationPaymentsSettled,
  type OrderCancellationProvider,
  type OrderCancellationRewards,
} from "./application/order-cancellation.ports";
export type { CustomerRewards } from "./application/customer-rewards";
