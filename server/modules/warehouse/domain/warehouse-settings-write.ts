import { z } from "zod";
import { WAREHOUSE_SETTINGS_CREATE_FIELDS } from "@shared/warehouse/warehouse-settings-create";
import { insertWarehouseSettingsSchema } from "@shared/schema/inventory.schema";
import { PROCUREMENT_SETTING_KEYS, type ProcurementSettingKey } from "@shared/procurement/procurement-settings";

const procurementMask = Object.fromEntries(PROCUREMENT_SETTING_KEYS.map(key => [key, true])) as Record<ProcurementSettingKey, true>;
const protectedFields = new Set<string>([...PROCUREMENT_SETTING_KEYS, "procurementPolicyRevision"]);
const postgresId = z.number().int().positive().max(2_147_483_647);
const settingsWriteSchema = insertWarehouseSettingsSchema.omit(procurementMask).extend({
  warehouseCode: z.string().trim().min(1).max(50).optional(),
  warehouseName: z.string().trim().min(1).max(100).optional(),
  warehouseId: postgresId.nullable().optional(),
}).strict().superRefine((settings, context) => {
  // The generated insert schema accepts fractional JS numbers for integer DB
  // columns. Reject these at the boundary rather than relying on SQL coercion.
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === "number" && (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "Must be a PostgreSQL integer" });
    }
  }
});

export class WarehouseSettingsWriteError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WarehouseSettingsWriteError";
  }
}

/** Procurement policy has its own actor, revision, audit and command boundary.
 * Even unchanged copies of its fields must not enter a generic warehouse write. */
export function parseWarehouseSettingsWrite(value: unknown) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const fields = Object.keys(value).filter(key => protectedFields.has(key));
    if (fields.length > 0) {
      throw new WarehouseSettingsWriteError(
        "Change procurement policy in Procurement Settings using a settings editor account.",
        403, "PROCUREMENT_SETTINGS_OWNER_REQUIRED", { fields },
      );
    }
  }
  const parsed = settingsWriteSchema.safeParse(value);
  if (!parsed.success) {
    throw new WarehouseSettingsWriteError("Invalid warehouse settings. Review the named fields and try again.",
      400, "WAREHOUSE_SETTINGS_INVALID", { fields: parsed.error.flatten().fieldErrors });
  }
  return parsed.data;
}

/** Creation retains the original endpoint's explicit field boundary. */
export function parseWarehouseSettingsCreation(value: unknown) {
  const parsed = parseWarehouseSettingsWrite(value);
  const allowed = new Set<string>(WAREHOUSE_SETTINGS_CREATE_FIELDS);
  const fields = Object.keys(parsed).filter(key => !allowed.has(key));
  if (fields.length > 0) {
    throw new WarehouseSettingsWriteError("These fields cannot be supplied when creating warehouse settings. Use their owning settings workflow.",
      400, "WAREHOUSE_SETTINGS_CREATE_FIELDS_UNSUPPORTED", { fields });
  }
  return parsed;
}

export function parseWarehouseSettingsId(value: unknown): number {
  const candidate = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  const parsed = postgresId.safeParse(candidate);
  if (!parsed.success) throw new WarehouseSettingsWriteError("Warehouse settings id must be a positive integer.", 400, "WAREHOUSE_SETTINGS_ID_INVALID");
  return parsed.data;
}

export function assertWarehouseSettingsIdentityChange(
  current: { warehouseCode: string; warehouseId: number | null },
  updates: { warehouseCode?: string; warehouseId?: number | null },
): void {
  if (current.warehouseCode === "DEFAULT") {
    if ((updates.warehouseCode !== undefined && updates.warehouseCode !== "DEFAULT")
      || (updates.warehouseId !== undefined && updates.warehouseId !== null)) {
      throw new WarehouseSettingsWriteError(
        "The DEFAULT settings row owns global procurement policy and cannot be renamed or assigned to a warehouse.",
        409, "DEFAULT_WAREHOUSE_SETTINGS_PROTECTED",
      );
    }
  } else if (updates.warehouseCode?.toUpperCase() === "DEFAULT") {
    throw new WarehouseSettingsWriteError("An ordinary warehouse settings row cannot replace the global DEFAULT policy row.",
      409, "DEFAULT_WAREHOUSE_SETTINGS_PROTECTED");
  }
}

export function assertWarehouseSettingsCreation(data: { warehouseCode?: string; warehouseId?: number | null }): void {
  const code = data.warehouseCode ?? "DEFAULT";
  if (code.toUpperCase() === "DEFAULT" && (code !== "DEFAULT" || data.warehouseId != null)) {
    throw new WarehouseSettingsWriteError("DEFAULT settings must remain a global row with no warehouse assignment.",
      409, "DEFAULT_WAREHOUSE_SETTINGS_PROTECTED");
  }
}

export function assertWarehouseSettingsDeletable(current: { warehouseCode: string }): void {
  if (current.warehouseCode === "DEFAULT") {
    throw new WarehouseSettingsWriteError("The DEFAULT settings row owns global procurement policy and cannot be deleted.",
      409, "DEFAULT_WAREHOUSE_SETTINGS_PROTECTED");
  }
}
