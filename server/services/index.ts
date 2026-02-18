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

import { createInventoryCoreService } from "./inventory-core";
import { createInventoryAtpService } from "./inventory-atp";
import { createBreakAssemblyService } from "./break-assembly";
import { createFulfillmentService } from "./fulfillment";
import { createReservationService } from "./reservation";
import { createReplenishmentService } from "./replenishment";
import { createChannelSyncService } from "./channel-sync";
import { createReturnsService } from "./returns";
import { createInventoryAlertService } from "./inventory-alerts";
import { createFulfillmentRouterService } from "./fulfillment-router";
import { createInventorySourceService } from "./inventory-source";
import { createSLAMonitorService } from "./sla-monitor";
import { createPickingService } from "./picking";
import { createOrderCombiningService } from "./order-combining";
import { createCycleCountService } from "./cycle-count";
import { createOperationsDashboardService } from "./operations-dashboard";
import { createReceivingService } from "./receiving";
import { createProductImportService } from "./product-import";
import { createChannelProductPushService } from "./channel-product-push";
import { storage } from "../storage";

export function createServices(db: any) {
  // Foundation
  const inventoryCore = createInventoryCoreService(db);
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

  // Depends on inventoryCore + channelSync + replenishment + storage
  const cycleCount = createCycleCountService(db, inventoryCore, channelSync, replenishment, storage);

  // Standalone (read-only analytics)
  const operationsDashboard = createOperationsDashboardService(db);

  // Depends on inventoryCore + channelSync + storage
  const receiving = createReceivingService(db, inventoryCore, channelSync, storage);

  // Standalone (imports from Shopify)
  const productImport = createProductImportService();

  // Channel product push (depends on storage only)
  const channelProductPush = createChannelProductPushService(db);

  return {
    inventoryCore,
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
  };
}

// Re-export factory functions for individual service creation
export { createInventoryCoreService } from "./inventory-core";
export { createInventoryAtpService } from "./inventory-atp";
export { createBreakAssemblyService } from "./break-assembly";
export { createFulfillmentService } from "./fulfillment";
export { createReservationService } from "./reservation";
export { createReplenishmentService } from "./replenishment";
export { createChannelSyncService } from "./channel-sync";
export { createReturnsService } from "./returns";
export { createInventoryAlertService } from "./inventory-alerts";
export { createFulfillmentRouterService } from "./fulfillment-router";
export { createInventorySourceService } from "./inventory-source";
export { createSLAMonitorService } from "./sla-monitor";
export { createPickingService } from "./picking";
export { createOrderCombiningService } from "./order-combining";
export { createCycleCountService } from "./cycle-count";
export { createOperationsDashboardService } from "./operations-dashboard";
export { createReceivingService } from "./receiving";
export { createProductImportService } from "./product-import";
export { createChannelProductPushService } from "./channel-product-push";

// Re-export service types
export type { InventoryCoreService } from "./inventory-core";
export type { BreakResult, AssembleResult, ConversionPreview } from "./break-assembly";
export type { BaseUnitTotals, VariantAtp, ChannelVariantAtp, ProductAtpSummary } from "./inventory-atp";
export type { SyncResult } from "./channel-sync";
export type { ReservationResult } from "./reservation";
export type { ReturnResult, ReturnItemParams, ProcessReturnParams } from "./returns";
export type { OrderRoutingContext, RoutingResult } from "./fulfillment-router";
export type { SyncResult as InventorySourceSyncResult } from "./inventory-source";
export type { SLAAlert, SLASummary } from "./sla-monitor";
export type { PickingService, PickItemResult, CaseBreakResult, BinCountResult } from "./picking";
export type { OrderCombiningService, CombinableGroup, CombineResult, UncombineResult, GroupForShipping } from "./order-combining";
export type { CycleCountService, CycleCountError, ApproveResult, BulkApproveResult } from "./cycle-count";
export type { OperationsDashboardService, BinInventoryParams, ActionQueueParams } from "./operations-dashboard";
export type { ReceivingService, ReceivingError } from "./receiving";
export type { ProductImportService, ContentSyncResult, ProductSyncResult } from "./product-import";
export type { ChannelProductPushService, ResolvedChannelProduct, ProductPushResult, BulkPushResult } from "./channel-product-push";
