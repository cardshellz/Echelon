/**
 * Inventory Planning — Legacy Admin Control Internal API (`CI-03`)
 *
 * Published cross-module interface for legacy admin control gates
 * (`catalog`, `channels`, `inventory`, `warehouse`).
 */
export {
  INVENTORY_LEGACY_ADMIN_CONTROLS,
  InventoryLegacyAdminControlError,
  InventoryLegacyAdminControlService,
  type InventoryLegacyAdminControl,
} from "./application/inventory-legacy-admin-control.service";
export { createInventoryLegacyAdminControlService } from "./infrastructure/inventory-legacy-admin-control.repository";
export { sendInventoryLegacyAdminControlError } from "./interfaces/http/inventory-legacy-admin-control.error";
