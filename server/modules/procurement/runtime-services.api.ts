/**
 * Public runtime service factories, domain helpers, and storage contracts for `server/modules/procurement`.
 */
import { type IProcurementStorage, procurementMethods } from "./infrastructure/procurement.storage";

export { type IProcurementStorage, procurementMethods };
export const procurementStorage: IProcurementStorage = procurementMethods;

export {
  createPurchasingService,
  type PurchasingError,
  type PurchasingService,
} from "./application/purchasing.service";
export {
  PoLifecycleError,
  buildFinancialTransitionChange,
  buildPhysicalTransitionChange,
  getAllowedFinancialTransitions,
  getAllowedLegacyTransitions,
  getAllowedPhysicalTransitions,
} from "./application/purchase-order-lifecycle.service";
export {
  findOpenPoLineByProduct,
  reconcilePurchaseOrderReceipt,
  type ReceiptReconciliationResult,
  type ReceivingReconciliationLine,
} from "./application/purchase-order-receipt-reconciliation.service";
export {
  buildPoCloseChange,
  buildPoCloseShortChange,
  buildPoCloseShortLinePatch,
} from "./application/purchase-order-close.service";
export {
  buildPoReconciliationLines,
  reconcileLinkedPurchaseOrder,
  type ReceivingOrchestrationPurchasing,
} from "./application/receiving-orchestration.service";
export {
  ReceivingError,
  ReceivingService,
  createReceivingService,
} from "./application/receiving.service";
export {
  ReceiptReversalService,
  createReceiptReversalService,
} from "./application/receipt-reversal.service";
export {
  ReceiveValidationService,
  createReceiveValidationService,
  evaluateReceiveWarnings,
} from "./application/receive-validation.service";
export { CostReportingRepository } from "./infrastructure/cost-reporting.repository";
export { createCostReportingService } from "./application/cost-reporting.service";
export {
  VendorService,
  VendorServiceError,
  createVendorService,
} from "./application/vendor.service";
export {
  createShipmentTrackingService,
  type ShipmentTrackingError,
  type ShipmentTrackingService,
} from "./application/shipment-tracking.service";
export {
  recordReceivingReconciliationFailure,
  recordReceiveValidationWarnings,
} from "./application/po-exceptions.service";
export { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } from "./application/ap-ledger.service";
export { renderPoHtml } from "./application/po-document";
