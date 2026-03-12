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

// Routes
export { registerPickingRoutes } from "./picking.routes";

// Services
export { createPickingService } from "./picking.service";
export { createFulfillmentService } from "./fulfillment.service";
export { createFulfillmentRouterService } from "./fulfillment-router.service";
export { createReturnsService } from "./returns.service";
export { createOrderCombiningService } from "./combining.service";
export { createSLAMonitorService } from "./sla-monitor.service";
export { createOperationsDashboardService } from "./operations-dashboard.service";

// Order sync
export { setupOrderSyncListener, initOrderSyncServices, syncNewOrders, getSyncHealth } from "./order-sync-listener";

// Service types
export type { PickingService, PickItemResult, PickInventoryContext, CaseBreakResult, BinCountResult } from "./picking.service";
export type { ReturnResult, ReturnItemParams, ProcessReturnParams } from "./returns.service";
export type { OrderRoutingContext, RoutingResult } from "./fulfillment-router.service";
export type { OrderCombiningService, CombinableGroup, CombineResult, UncombineResult, GroupForShipping } from "./combining.service";
export type { SLAAlert, SLASummary } from "./sla-monitor.service";
export type { OperationsDashboardService, BinInventoryParams, ActionQueueParams } from "./operations-dashboard.service";
