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

import {
  InventoryUseCases,
  createInventoryLotService,
  createCOGSService,
  createInventoryAtpService,
  createBreakAssemblyService,
  createReplenishmentService,
  createCycleCountService,
  createInventoryAlertService,
} from "../modules/inventory";
import { createFulfillmentService } from "../modules/orders/fulfillment.service";
import { createReservationService } from "../modules/channels/reservation.service";
import { createChannelSyncService } from "../modules/channels/sync.service";
import { createReturnsService } from "../modules/orders/returns.service";
import { createFulfillmentRouterService } from "../modules/orders/fulfillment-router.service";
import { createSLAMonitorService } from "../modules/orders/sla-monitor.service";
import { createPickingService } from "../modules/orders/picking.use-cases";
import { createOrderCombiningService } from "../modules/orders/combining.service";
import { createOperationsDashboardService } from "../modules/orders/operations-dashboard.service";
import { createReceivingService } from "../modules/procurement/receiving.service";
import { createProductImportService } from "../modules/catalog/product-import.service";
import { createChannelProductPushService } from "../modules/channels/product-push.service";
import { createSyncSettingsService } from "../modules/channels/sync-settings.service";
import { createBinAssignmentService } from "../modules/warehouse/bin-assignment.service";
import { createPurchasingService } from "../modules/procurement/purchasing.service";
import { createShipmentTrackingService } from "../modules/procurement/shipment-tracking.service";
import { createOmsService } from "../modules/oms/oms.service";
import { createFulfillmentPushService } from "../modules/oms/fulfillment-push.service";
import { createShipStationService } from "../modules/oms/shipstation.service";
import { WmsSyncService } from "../modules/oms/wms-sync.service";
import { SyncRecoveryService } from "../modules/sync/sync-recovery.service";
import { catalogStorage } from "../modules/catalog";
import { warehouseStorage } from "../modules/warehouse";
import { inventoryStorage } from "../modules/inventory";
import { ordersStorage } from "../modules/orders";
import { channelsStorage } from "../modules/channels";
import { procurementStorage } from "../modules/procurement";
import { identityStorage } from "../modules/identity";
import { createAllocationEngine } from "../modules/channels/allocation-engine.service";
import { createSourceLockService } from "../modules/channels/source-lock.service";
import { createShopifyAdapter } from "../modules/channels/adapters/shopify.adapter";
import { ChannelAdapterRegistry } from "../modules/channels/channel-adapter.interface";
import { createEchelonSyncOrchestrator } from "../modules/channels/echelon-sync-orchestrator.service";
import { productVariants as pvTable } from "@shared/schema";
import { eq as eqOp } from "drizzle-orm";
export function createServices(db: any) {
  // Foundation
  const inventoryLots = createInventoryLotService(db);
  const cogs = createCOGSService(db);
  const inventoryCore = new InventoryUseCases(db, inventoryStorage, inventoryLots, cogs); // Temporary mapping
  const inventoryUseCases = inventoryCore;
  const atp = createInventoryAtpService(db);

  // Channel sync (depends on atp only — must precede fulfillment/reservation)
  const channelSync = createChannelSyncService(db, atp);

  // Depends on inventoryCore (+ channelSync for fulfillment/reservation)
  const breakAssembly = createBreakAssemblyService(db, inventoryCore);
  const fulfillment = createFulfillmentService(db, inventoryCore as any, channelSync);
  const reservation = createReservationService(db, inventoryCore as any, channelSync, atp);
  const replenishment = createReplenishmentService(db, inventoryCore);
  const returns = createReturnsService(db, inventoryCore as any);

  // Depends on inventoryCore + replenishment + multi-module storage
  const picking = createPickingService(db, inventoryCore as any, replenishment, {
    ...ordersStorage,
    ...catalogStorage,
    ...warehouseStorage,
    ...inventoryStorage,
    ...channelsStorage,
    ...identityStorage,
  }, channelSync);

  // Standalone
  const inventoryAlerts = createInventoryAlertService(db);
  const fulfillmentRouter = createFulfillmentRouterService(db);
  const inventorySource = null as any; // Removed, handled cleanly in picking and core now
  const slaMonitor = createSLAMonitorService(db);
  const orderCombining = createOrderCombiningService(db);

  // Depends on inventoryCore + channelSync + replenishment + multi-module storage + reservation
  const cycleCount = createCycleCountService(db, inventoryCore, channelSync, replenishment, {
    ...inventoryStorage,
    ...warehouseStorage,
    ...catalogStorage,
  }, reservation);

  // Standalone (read-only analytics)
  const operationsDashboard = createOperationsDashboardService(db);

  // Purchasing (depends on procurement + catalog + warehouse storage) — must precede receiving
  const purchasing = createPurchasingService(db, {
    ...procurementStorage,
    ...catalogStorage,
    ...warehouseStorage,
  });

  // Shipment tracking (depends on procurement + catalog storage)
  const shipmentTracking = createShipmentTrackingService(db, {
    ...procurementStorage,
    ...catalogStorage,
  });

  // Depends on inventoryCore + channelSync + multi-module storage + purchasing + shipmentTracking
  const receiving = createReceivingService(db, inventoryCore, channelSync, {
    ...procurementStorage,
    ...catalogStorage,
    ...warehouseStorage,
  }, purchasing, shipmentTracking);

  // Standalone (imports from Shopify)
  const productImport = createProductImportService();

  // Channel product push (depends on storage only)
  const channelProductPush = createChannelProductPushService(db);

  // Sync settings (sync control plane)
  const syncSettings = createSyncSettingsService(db);

  // Echelon sync orchestrator — the REAL sync engine (allocation + per-channel push)

  const allocationEngine = createAllocationEngine(db, atp);
  const sourceLockService = createSourceLockService(db);
  const shopifyAdapter = createShopifyAdapter(db);
  const adapterRegistry = new ChannelAdapterRegistry();
  adapterRegistry.register(shopifyAdapter);
  const echelonOrchestrator = createEchelonSyncOrchestrator(
    db, allocationEngine, sourceLockService, adapterRegistry, channelProductPush, atp,
  );

  // Wire orchestrator into legacy channelSync so event-driven syncs
  // respect channel_allocation_rules (fixed/share/mirror modes).
  // This breaks the chicken-and-egg dependency between channelSync and orchestrator.
  channelSync.setOrchestrator(echelonOrchestrator);

  // Wire inventory change → immediate channel sync
  // Every inventory mutation (receive, pick, ship, adjust) triggers allocation + push
  const pendingSyncs = new Set<number>(); // debounce by productId
  inventoryCore.onInventoryChange(async (productVariantId: number, triggeredBy: string) => {
    try {
      const [variant] = await db
        .select({ productId: pvTable.productId })
        .from(pvTable)
        .where(eqOp(pvTable.id, productVariantId))
        .limit(1);
      if (!variant) return;

      const productId = variant.productId;
      if (pendingSyncs.has(productId)) return; // already queued
      pendingSyncs.add(productId);

      // Small delay to batch rapid changes (e.g., multi-line receive)
      setTimeout(async () => {
        pendingSyncs.delete(productId);
        try {
          await echelonOrchestrator.syncInventoryForProduct(
            productId,
            { dryRun: false },
            `inventory_change:${triggeredBy}`,
          );
        } catch (err: any) {
          console.warn(`[InventorySync] Auto-sync failed for product ${productId}: ${err.message}`);
        }
        try {
          // Unblock and re-evaluate dependent replen tasks for this product across the warehouse
          // after bulk receipts, transfers, or inventory adjustments
          await replenishment.reevaluateReplenForProduct(productId);
        } catch (err: any) {
          console.warn(`[Replen] Auto-sync replen failed for product ${productId}: ${err.message}`);
        }
      }, 2000); // 2s debounce
    } catch (err: any) {
      console.warn(`[InventorySync] Failed to resolve variant ${productVariantId}: ${err.message}`);
    }
  });

  // Wire break/assembly inventory changes into the same sync mechanism as core
  // This ensures case breaks from replen, UI, or any other caller trigger channel sync
  breakAssembly.onInventoryChange((variantId: number, trigger: string) => {
    channelSync.queueSyncAfterInventoryChange(variantId).catch((err: any) =>
      console.warn(`[BreakAssembly] Post-${trigger} sync failed for variant ${variantId}:`, err),
    );
  });

  // Bin assignment (depends on catalog + warehouse storage)
  const binAssignment = createBinAssignmentService(db, {
    ...catalogStorage,
    ...warehouseStorage,
  });

  // OMS — Unified Order Management (wired to WMS reservation service for proper ATP-gated reserves)
  const oms = createOmsService(db, reservation);

  // Fulfillment Push — eBay API client created lazily when polling starts
  // For now, pass null — the eBay client is created in server/index.ts when polling starts
  const fulfillmentPush = createFulfillmentPushService(db, null);

  // ShipStation — order push + webhook integration
  const shipStation = createShipStationService(db, inventoryCore as any);

  // WMS Sync — bridges OMS → WMS for fulfillment
  const wmsSync = new WmsSyncService({
    inventoryCore: inventoryCore as any,
    reservation,
    fulfillmentRouter,
  });

  // SyncRecovery — unified order-pipeline gap recovery (Shopify → shopify_orders
  // → OMS → WMS). Runs on a schedule and is exposed via /api/sync/recover-orders.
  const syncRecovery = new SyncRecoveryService(db, { oms, wmsSync });

  return {
    inventoryCore,
    inventoryLots,
    atp,
    cogs,
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
    syncSettings,
    echelonOrchestrator,
    oms,
    fulfillmentPush,
    shipStation,
    wmsSync,
    syncRecovery,
  };
}

/** Typed service container — use instead of `as any` on `req.app.locals.services` */
export type ServiceRegistry = ReturnType<typeof createServices>;

// Re-export factory functions for individual service creation
export { createBreakAssemblyService, createReplenishmentService, createCycleCountService, createInventoryAtpService, createInventoryAlertService } from "../modules/inventory";
export { createFulfillmentService } from "../modules/orders/fulfillment.service";
export { createReservationService } from "../modules/channels/reservation.service";
export { createChannelSyncService } from "../modules/channels/sync.service";
export { createReturnsService } from "../modules/orders/returns.service";
export { createFulfillmentRouterService } from "../modules/orders/fulfillment-router.service";
export { createSLAMonitorService } from "../modules/orders/sla-monitor.service";
export { createPickingService } from "../modules/orders/picking.use-cases";
export { createOrderCombiningService } from "../modules/orders/combining.service";
export { createOperationsDashboardService } from "../modules/orders/operations-dashboard.service";
export { createReceivingService } from "../modules/procurement/receiving.service";
export { createProductImportService } from "../modules/catalog/product-import.service";
export { createChannelProductPushService } from "../modules/channels/product-push.service";

// Re-export service types
export type { BaseUnitTotals, VariantAtp, ChannelVariantAtp, ProductAtpSummary, BreakResult, AssembleResult, ConversionPreview } from "../modules/inventory";
export type { SyncResult } from "../modules/channels/sync.service";
export type { ReservationResult } from "../modules/channels/reservation.service";
export type { ReturnResult, ReturnItemParams, ProcessReturnParams } from "../modules/orders/returns.service";
export type { OrderRoutingContext, RoutingResult } from "../modules/orders/fulfillment-router.service";
export type { SLAAlert, SLASummary } from "../modules/orders/sla-monitor.service";
export type { PickingService, PickItemResult, PickInventoryContext, CaseBreakResult, BinCountResult } from "../modules/orders/picking.use-cases";
export type { OrderCombiningService, CombinableGroup, CombineResult, UncombineResult, GroupForShipping } from "../modules/orders/combining.service";
export type { CycleCountUseCases as CycleCountService, CycleCountError, ApproveResult, ReconciliationPreview, TransferSuggestion, ReconciliationItem } from "../modules/inventory";
export type { OperationsDashboardService, BinInventoryParams, ActionQueueParams } from "../modules/orders/operations-dashboard.service";
export type { ReceivingService, ReceivingError } from "../modules/procurement/receiving.service";
export type { ProductImportService, ContentSyncResult, ProductSyncResult } from "../modules/catalog/product-import.service";
export type { ChannelProductPushService, ResolvedChannelProduct, ProductPushResult, BulkPushResult } from "../modules/channels/product-push.service";
export { createSyncSettingsService } from "../modules/channels/sync-settings.service";
export type { SyncSettingsService, SyncLogWriteParams } from "../modules/channels/sync-settings.service";
export { createBinAssignmentService } from "../modules/warehouse/bin-assignment.service";
export type { BinAssignmentService, BinAssignmentRow, AssignmentFilters, ImportResult } from "../modules/warehouse/bin-assignment.service";
export { createPurchasingService } from "../modules/procurement/purchasing.service";
export type { PurchasingService, PurchasingError } from "../modules/procurement/purchasing.service";
export { createShipmentTrackingService } from "../modules/procurement/shipment-tracking.service";
export type { ShipmentTrackingService, ShipmentTrackingError } from "../modules/procurement/shipment-tracking.service";
export { createInventoryLotService } from "../modules/inventory/lots.service";
export type { InventoryLotService } from "../modules/inventory/lots.service";
export { createCOGSService } from "../modules/inventory/cogs.service";
export type { COGSService, CostLotConsumption, OrderCOGSResult, InventoryValuationResult, CostAdjustmentLog } from "../modules/inventory/cogs.service";
export { createShipStationService } from "../modules/oms/shipstation.service";
export type { ShipStationService } from "../modules/oms/shipstation.service";
