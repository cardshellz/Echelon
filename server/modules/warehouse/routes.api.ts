/**
 * HTTP route registration facade for `@echelon/warehouse` (`CI-03`).
 */
export { registerLocationRoutes } from "./interfaces/http/locations.routes";
export { registerPickZoneRoutes } from "./interfaces/http/pick-zones.routes";
export {
  registerSettingsRoutes,
  registerWarehouseRoutes,
} from "./warehouse-settings-routes.api";
