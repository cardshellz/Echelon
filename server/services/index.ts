/**
 * Service wiring module for Echelon WMS.
 *
 * Creates all service instances with their dependencies injected and
 * exports them as a single object.  Import this module once in your
 * server entry point to get a fully-wired service container.
 *
 * ```ts
 * import { db } from "./db";
 * import { createServices } from "./services";
 *
 * const services = createServices(db);
 * await services.inventoryCore.receiveInventory({ ... });
 * await services.atp.getAtpPerVariant(productId);
 * ```
 *
 * Dependency graph:
 *   inventory-core (foundation — no deps)
 *     ├── inventory-atp   (read-only, depends on core indirectly via DB)
 *     ├── channel-sync     (depends on atp)
 *     ├── break-assembly   (depends on core)
 *     ├── fulfillment      (depends on core + channelSync)
 *     ├── reservation      (depends on core + channelSync)
 *     ├── replenishment    (depends on core)
 *     ├── picking           (depends on core + replenishment + storage)
 *     └── returns          (depends on core)
 */

import { createInventoryCoreService } from "../modules/inventory/core.service";
import { createInventoryLotService } from "../modules/inventory/lots.service";
import { createInventoryAtpService } from "../modules/inventory/atp.service";
import { createBreakAssemblyService } from "../modules/inventory/break-assembly.service";
import { createFulfillmentService } from "./fulfillment";
import { createReservationService } from "./reservation";
import { createReplenishmentService } from "../modules/inventory/replen.service";
import { createChannelSyncService } from "./channel-sync";
import { createReturnsService } from "./returns";
import { createInventoryAlertService } from "../modules/inventory/alerts.service";
import { createFulfillmentRouterService } from "./fulfillment-router";
import { createInventorySourceService } from "../modules/inventory/source.service";
import { createSLAMonitorService } from "./sla-monitor";
import { createPickingService } from "./picking";
import { createOrderCombiningService } from "./order-combining";
import { createCycleCountService } from "../modules/inventory/cycle-count.service";
import { createOperationsDashboardService } from "./operations-dashboard";
import { createReceivingService } from "./receiving";
import { createProductImportService } from "../modules/catalog/product-import.service";
import { createChannelProductPushService } from "./channel-product-push";
import { createBinAssignmentService } from "../modules/warehouse/bin-assignment.service";
import { createPurchasingService } from "./purchasing";
import { createShipmentTrackingService } from "./shipment-tracking";
import { storage } from "../storage";

export function createServices(db: any) {
  // Foundation
  const inventoryLots = createInventoryLotService(db);
  const inventoryCore = createInventoryCoreService(db, inventoryLots);
  const atp = createInventoryAtpService(db);

  // Channel sync (depends on atp only — must precede fulfillment/reservation)
  const channelSync = createChannelSyncService(db, atp);

  // Depends on inventoryCore (+ channelSync for fulfillment/reservation)
  const breakAssembly = createBreakAssemblyService(db, inventoryCore);
  const fulfillment = createFulfillmentService(db, inventoryCore, channelSync);
  const reservation = createReservationService(db, inventoryCore, channelSync);
  const replenishment = createReplenishmentService(db, inventoryCore);
  const returns = createReturnsService(db, inventoryCore);

  // Depends on inventoryCore + replenishment + storage
  const picking = createPickingService(db, inventoryCore, replenishment, storage);

  // Standalone
  const inventoryAlerts = createInventoryAlertService(db);
  const fulfillmentRouter = createFulfillmentRouterService(db);
  const inventorySource = createInventorySourceService(db, inventoryCore);
  const slaMonitor = createSLAMonitorService(db);
  const orderCombining = createOrderCombiningService(db);

  // Depends on inventoryCore + channelSync + replenishment + storage + reservation
  const cycleCount = createCycleCountService(db, inventoryCore, channelSync, replenishment, storage, reservation);

  // Standalone (read-only analytics)
  const operationsDashboard = createOperationsDashboardService(db);

  // Purchasing (depends on storage) — must precede receiving
  const purchasing = createPurchasingService(db, storage);

  // Shipment tracking (depends on storage)
  const shipmentTracking = createShipmentTrackingService(db, storage);

  // Depends on inventoryCore + channelSync + storage + purchasing + shipmentTracking
  const receiving = createReceivingService(db, inventoryCore, channelSync, storage, purchasing, shipmentTracking);

  // Standalone (imports from Shopify)
  const productImport = createProductImportService();

  // Channel product push (depends on storage only)
  const channelProductPush = createChannelProductPushService(db);

  // Bin assignment (depends on storage)
  const binAssignment = createBinAssignmentService(db, storage);

  return {
    inventoryCore,
    inventoryLots,
    atp,
    breakAssembly,
    fulfillment,
    reservation,
    replenishment,
    picking,
    channelSync,
    returns,
    inventoryAlerts,
    fulfillmentRouter,
    inventorySource,
    slaMonitor,
    orderCombining,
    cycleCount,
    operationsDashboard,
    receiving,
    productImport,
    channelProductPush,
    binAssignment,
    purchasing,
    shipmentTracking,
  };
}

// Re-export factory functions for individual service creation
export { createInventoryCoreService } from "../modules/inventory/core.service";
export { createInventoryAtpService } from "../modules/inventory/atp.service";
export { createBreakAssemblyService } from "../modules/inventory/break-assembly.service";
export { createFulfillmentService } from "./fulfillment";
export { createReservationService } from "./reservation";
export { createReplenishmentService } from "../modules/inventory/replen.service";
export { createChannelSyncService } from "./channel-sync";
export { createReturnsService } from "./returns";
export { createInventoryAlertService } from "../modules/inventory/alerts.service";
export { createFulfillmentRouterService } from "./fulfillment-router";
export { createInventorySourceService } from "../modules/inventory/source.service";
export { createSLAMonitorService } from "./sla-monitor";
export { createPickingService } from "./picking";
export { createOrderCombiningService } from "./order-combining";
export { createCycleCountService } from "../modules/inventory/cycle-count.service";
export { createOperationsDashboardService } from "./operations-dashboard";
export { createReceivingService } from "./receiving";
export { createProductImportService } from "../modules/catalog/product-import.service";
export { createChannelProductPushService } from "./channel-product-push";

// Re-export service types
export type { InventoryCoreService } from "../modules/inventory/core.service";
export type { BreakResult, AssembleResult, ConversionPreview } from "../modules/inventory/break-assembly.service";
export type { BaseUnitTotals, VariantAtp, ChannelVariantAtp, ProductAtpSummary } from "../modules/inventory/atp.service";
export type { SyncResult } from "./channel-sync";
export type { ReservationResult } from "./reservation";
export type { ReturnResult, ReturnItemParams, ProcessReturnParams } from "./returns";
export type { OrderRoutingContext, RoutingResult } from "./fulfillment-router";
export type { SyncResult as InventorySourceSyncResult } from "../modules/inventory/source.service";
export type { SLAAlert, SLASummary } from "./sla-monitor";
export type { PickingService, PickItemResult, PickInventoryContext, CaseBreakResult, BinCountResult } from "./picking";
export type { OrderCombiningService, CombinableGroup, CombineResult, UncombineResult, GroupForShipping } from "./order-combining";
export type { CycleCountService, CycleCountError, ApproveResult, BulkApproveResult } from "../modules/inventory/cycle-count.service";
export type { OperationsDashboardService, BinInventoryParams, ActionQueueParams } from "./operations-dashboard";
export type { ReceivingService, ReceivingError } from "./receiving";
export type { ProductImportService, ContentSyncResult, ProductSyncResult } from "../modules/catalog/product-import.service";
export type { ChannelProductPushService, ResolvedChannelProduct, ProductPushResult, BulkPushResult } from "./channel-product-push";
export { createBinAssignmentService } from "../modules/warehouse/bin-assignment.service";
export type { BinAssignmentService, BinAssignmentRow, AssignmentFilters, ImportResult } from "../modules/warehouse/bin-assignment.service";
export { createPurchasingService } from "./purchasing";
export type { PurchasingService, PurchasingError } from "./purchasing";
export { createShipmentTrackingService } from "./shipment-tracking";
export type { ShipmentTrackingService, ShipmentTrackingError } from "./shipment-tracking";
export { createInventoryLotService } from "../modules/inventory/lots.service";
export type { InventoryLotService } from "../modules/inventory/lots.service";
