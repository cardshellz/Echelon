/**
 * Warehouse & Settings HTTP route registration facade for `@echelon/warehouse` (`CI-03`).
 *
 * Kept separate from `locations.routes` (`ordersStorage` / websocket broadcast)
 * so minimal connected-acceptance harnesses (`test/connected/procurement/server.ts`)
 * can mount warehouse & settings routes without pulling in the orders/picking graph.
 */
export { registerSettingsRoutes } from "./interfaces/http/settings.routes";
export { registerWarehouseRoutes } from "./interfaces/http/warehouse.routes";
