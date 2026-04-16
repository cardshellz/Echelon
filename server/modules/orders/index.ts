/**
 * @echelon/orders — Order lifecycle, picking, fulfillment, returns, combining, SLA
 *
 * Tables owned: orders, orderItems, pickingLogs, shipments, shipmentItems,
 *               combinedOrderGroups, fulfillmentRoutingRules, orderItemCosts, orderItemFinancials
 * Depends on: catalog, warehouse, inventory, channels
 */

// Storage
export { type IOrderStorage, orderMethods } from "./orders.storage";
export { type IPickingLogStorage, pickingLogMethods } from "./picking-logs.storage";
export { type IOrderHistoryStorage, orderHistoryMethods } from "./order-history.storage";

import { type IOrderStorage, orderMethods } from "./orders.storage";
import { type IPickingLogStorage, pickingLogMethods } from "./picking-logs.storage";
import { type IOrderHistoryStorage, orderHistoryMethods } from "./order-history.storage";

export type OrdersModuleStorage = IOrderStorage & IPickingLogStorage & IOrderHistoryStorage;
export const ordersStorage: OrdersModuleStorage = {
  ...orderMethods,
  ...pickingLogMethods,
  ...orderHistoryMethods,
};


// Service types
export type { PickingService, PickItemResult, PickInventoryContext, CaseBreakResult, BinCountResult } from "./picking.use-cases";
export type { ReturnResult, ReturnItemParams, ProcessReturnParams } from "./returns.service";
export type { OrderRoutingContext, RoutingResult } from "./fulfillment-router.service";
export type { OrderCombiningService, CombinableGroup, CombineResult, UncombineResult, GroupForShipping } from "./combining.service";
export type { SLAAlert, SLASummary } from "./sla-monitor.service";
export type { OperationsDashboardService, BinInventoryParams, ActionQueueParams } from "./operations-dashboard.service";
