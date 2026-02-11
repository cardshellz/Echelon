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
 *     ├── break-assembly   (depends on core)
 *     ├── reservation      (depends on core)
 *     ├── replenishment    (depends on core)
 *     ├── fulfillment      (depends on core)
 *     ├── channel-sync     (depends on atp)
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

export function createServices(db: any) {
  // Foundation
  const inventoryCore = createInventoryCoreService(db);
  const atp = createInventoryAtpService(db);

  // Depends on inventoryCore
  const breakAssembly = createBreakAssemblyService(db, inventoryCore);
  const fulfillment = createFulfillmentService(db, inventoryCore);
  const reservation = createReservationService(db, inventoryCore);
  const replenishment = createReplenishmentService(db, inventoryCore);
  const returns = createReturnsService(db, inventoryCore);

  // Depends on atp
  const channelSync = createChannelSyncService(db, atp);

  // Standalone
  const inventoryAlerts = createInventoryAlertService(db);

  return {
    inventoryCore,
    atp,
    breakAssembly,
    fulfillment,
    reservation,
    replenishment,
    channelSync,
    returns,
    inventoryAlerts,
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

// Re-export service types
export type { InventoryCoreService } from "./inventory-core";
export type { BreakResult, AssembleResult, ConversionPreview } from "./break-assembly";
export type { BaseUnitTotals, VariantAtp, ChannelVariantAtp, ProductAtpSummary } from "./inventory-atp";
export type { SyncResult } from "./channel-sync";
export type { ReservationResult } from "./reservation";
export type { ReturnResult, ReturnItemParams, ProcessReturnParams } from "./returns";
