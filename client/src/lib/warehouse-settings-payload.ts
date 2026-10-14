import { WAREHOUSE_SETTINGS_CREATE_FIELDS } from "@shared/warehouse/warehouse-settings-create";
import { PROCUREMENT_SETTING_KEYS } from "@shared/procurement/procurement-settings";

const excludedKeys = new Set<string>([
  "id", "createdAt", "updatedAt", "procurementPolicyRevision", ...PROCUREMENT_SETTING_KEYS,
]);

/** GET returns a combined settings row; the warehouse form may only echo
 * fields owned by its save endpoint, never procurement policy or its version. */
export function warehouseSettingsPayload(
  settings: Record<string, unknown>,
  operation: "create" | "update" = "update",
): Record<string, unknown> {
  const creationFields = new Set<string>(WAREHOUSE_SETTINGS_CREATE_FIELDS);
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !excludedKeys.has(key)
    && (operation === "update" || creationFields.has(key))));
}
