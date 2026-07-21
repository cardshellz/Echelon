/**
 * @echelon/procurement — Vendors, POs, receiving, inbound shipments, landed cost, AP
 *
 * Tables owned: vendors, vendorProducts, purchaseOrders, purchaseOrderLines,
 *               poApprovalTiers, poStatusHistory, poRevisions, poReceipts,
 *               receivingOrders, receivingLines, inboundShipments, inboundShipmentLines,
 *               shipmentCosts, shipmentCostAllocations, landedCostSnapshots,
 *               inboundShipmentStatusHistory, vendorInvoices, vendorInvoiceLines,
 *               vendorInvoicePoLinks, vendorInvoiceAttachments, apPayments, apPaymentAllocations
 * Depends on: catalog, warehouse, inventory
 */

// Storage
export { type IProcurementStorage, procurementMethods } from "./procurement.storage";
import { type IProcurementStorage, procurementMethods } from "./procurement.storage";
export const procurementStorage: IProcurementStorage = procurementMethods;

// Services
export { createPurchasingService } from "./purchasing.service";
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
} from "./purchase-order-receipt-reconciliation.service";
export {
  buildPoCloseChange,
  buildPoCloseShortChange,
  buildPoCloseShortLinePatch,
} from "./purchase-order-close.service";
export {
  buildPoReconciliationLines,
  reconcileLinkedPurchaseOrder,
} from "./receiving-orchestration.service";
export { createReceivingService } from "./receiving.service";
export { createShipmentTrackingService } from "./shipment-tracking.service";
export { createVendorService, VendorService, VendorServiceError } from "./vendor.service";
export {
  ProcurementSkuReferenceError,
  synchronizeProcurementSkuReferences,
} from "./procurement-sku-reference.service";
export { renderPoHtml } from "./po-document";

// Service types
export type { PurchasingService, PurchasingError } from "./purchasing.service";
export type {
  ReceiptReconciliationResult,
  ReceivingReconciliationLine,
} from "./purchase-order-receipt-reconciliation.service";
export type { ReceivingOrchestrationPurchasing } from "./receiving-orchestration.service";
export type { ReceivingService, ReceivingError } from "./receiving.service";
export type { ShipmentTrackingService, ShipmentTrackingError } from "./shipment-tracking.service";
export type {
  ProcurementSkuReferenceRename,
  ProcurementSkuReferenceRenameResult,
} from "./procurement-sku-reference.service";
