/**
 * @echelon/orders — Order lifecycle, picking, fulfillment, returns, combining, SLA (`CI-03`)
 *
 * Tables owned: orders, orderItems, pickingLogs, shipments, shipmentItems,
 *               combinedOrderGroups, fulfillmentRoutingRules, orderItemCosts, orderItemFinancials
 * Depends on: catalog, warehouse, inventory, channels, wms
 */

// Storage (encapsulated: raw method objects are module-private)
export type { IOrderStorage } from "./infrastructure/orders.storage";
export { orderPageQuerySchema } from "./infrastructure/order-list.repository";
export type { IPickingLogStorage } from "./infrastructure/picking-logs.storage";
export type { IOrderHistoryStorage } from "./infrastructure/order-history.storage";

import { type IOrderStorage, orderMethods } from "./infrastructure/orders.storage";
import { type IPickingLogStorage, pickingLogMethods } from "./infrastructure/picking-logs.storage";
import { type IOrderHistoryStorage, orderHistoryMethods } from "./infrastructure/order-history.storage";

export type OrdersModuleStorage = IOrderStorage & IPickingLogStorage & IOrderHistoryStorage;
export const ordersStorage: OrdersModuleStorage = {
  ...orderMethods,
  ...pickingLogMethods,
  ...orderHistoryMethods,
};

// Service types
export type { PickingService, PickItemResult, PickInventoryContext, BinCountResult } from "./application/picking.use-cases";
export type { ReturnResult, ReturnItemParams, ProcessReturnParams } from "./application/returns.service";
export type { OrderRoutingContext, RoutingResult } from "./application/fulfillment-router.service";
export type { OrderCombiningService, CombinableGroup, CombineResult, UncombineResult, GroupForShipping } from "./application/combining.service";
export type { SLAAlert, SLASummary } from "./application/sla-monitor.service";
export type { OperationsDashboardService, BinInventoryParams, ActionQueueParams } from "./application/operations-dashboard.service";
export { backfillOpenOrderItemBinAssignment } from "./application/bin-location-backfill";
