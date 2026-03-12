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

// Routes
export { registerPurchasingRoutes } from "./procurement.routes";

// Services
export { createPurchasingService } from "./purchasing.service";
export { createReceivingService } from "./receiving.service";
export { createShipmentTrackingService } from "./shipment-tracking.service";
export { renderPoHtml } from "./po-document";

// Service types
export type { PurchasingService, PurchasingError } from "./purchasing.service";
export type { ReceivingService, ReceivingError } from "./receiving.service";
export type { ShipmentTrackingService, ShipmentTrackingError } from "./shipment-tracking.service";
