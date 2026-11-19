/**
 * Public runtime service factories, domain helpers, and storage contracts for `server/modules/procurement`.
 */
import { type IProcurementStorage, procurementMethods } from "./procurement.storage";

export { type IProcurementStorage, procurementMethods };
export const procurementStorage: IProcurementStorage = procurementMethods;

export {
  createPurchasingService,
  type PurchasingError,
  type PurchasingService,
} from "./purchasing.service";
export {
  PoLifecycleError,
  buildFinancialTransitionChange,
  buildPhysicalTransitionChange,
  getAllowedFinancialTransitions,
  getAllowedLegacyTransitions,
  getAllowedPhysicalTransitions,
} from "./purchase-order-lifecycle.service";
export {
  findOpenPoLineByProduct,
  reconcilePurchaseOrderReceipt,
  type ReceiptReconciliationResult,
  type ReceivingReconciliationLine,
} from "./purchase-order-receipt-reconciliation.service";
export {
  buildPoCloseChange,
  buildPoCloseShortChange,
  buildPoCloseShortLinePatch,
} from "./purchase-order-close.service";
export {
  buildPoReconciliationLines,
  reconcileLinkedPurchaseOrder,
  type ReceivingOrchestrationPurchasing,
} from "./receiving-orchestration.service";
export {
  ReceivingError,
  ReceivingService,
  createReceivingService,
} from "./receiving.service";
export {
  ReceiptReversalService,
  createReceiptReversalService,
} from "./receipt-reversal.service";
export {
  ReceiveValidationService,
  createReceiveValidationService,
  evaluateReceiveWarnings,
} from "./receive-validation.service";
export { CostReportingRepository } from "./cost-reporting.repository";
export { createCostReportingService } from "./cost-reporting.service";
export {
  VendorService,
  VendorServiceError,
  createVendorService,
} from "./vendor.service";
export {
  createShipmentTrackingService,
  type ShipmentTrackingError,
  type ShipmentTrackingService,
} from "./shipment-tracking.service";
export {
  recordReceivingReconciliationFailure,
  recordReceiveValidationWarnings,
} from "./po-exceptions.service";
export { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } from "./ap-ledger.service";
export { renderPoHtml } from "./po-document";
