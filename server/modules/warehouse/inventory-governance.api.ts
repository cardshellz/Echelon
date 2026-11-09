/**
 * Internal module API facade: Warehouse Location Integrity & Settings Write Governance (`CI-03`).
 *
 * Cross-module consumers (e.g., `inventory`) must import location integrity and
 * warehouse settings write-validation contracts through this boundary rather
 * than reaching into `warehouse/domain/*` or `warehouse/location-integrity`.
 */

export {
  assertPickFaceAssignmentEligible,
  normalizeLocationInput,
  normalizeLocationPatchInput,
  normalizeLocationType,
  validateWarehouseLocationIntegrity,
} from "./location-integrity";

export {
  assertWarehouseSettingsCreation,
  assertWarehouseSettingsDeletable,
  assertWarehouseSettingsIdentityChange,
  parseWarehouseSettingsCreation,
  parseWarehouseSettingsId,
  parseWarehouseSettingsWrite,
  WarehouseSettingsWriteError,
} from "./domain/warehouse-settings-write";

export {
  parseWarehouseLocationId,
  parseWarehouseLocationPatch,
  WAREHOUSE_BIN_TYPES,
  WAREHOUSE_LOCATION_PATCH_FIELDS,
  WarehouseLocationWriteError,
  type WarehouseLocationPatch,
  type WarehouseLocationPatchField,
} from "./domain/warehouse-location-write";
