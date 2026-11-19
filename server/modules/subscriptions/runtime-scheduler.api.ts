/**
 * Billing scheduler startup & advisory-locked pass execution facade for `subscriptions` (CI-03).
 */
export {
  startBillingScheduler,
  runBillingPassWithLock,
  type BillingPassSummary,
} from "./subscription.scheduler";
