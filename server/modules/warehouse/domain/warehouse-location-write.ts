import { z } from "zod";
import { locationTypeEnum } from "@shared/schema/warehouse.schema";
import { normalizeLocationType } from "../location-integrity";

export const WAREHOUSE_BIN_TYPES = [
  "bin",
  "shelf",
  "pallet",
  "carton_flow",
  "floor",
] as const;

export const WAREHOUSE_LOCATION_PATCH_FIELDS = [
  "locationType",
  "binType",
  "isPickable",
  "zone",
  "aisle",
  "bay",
  "level",
  "bin",
  "name",
  "warehouseId",
  "isActive",
] as const;

export type WarehouseLocationPatchField = (typeof WAREHOUSE_LOCATION_PATCH_FIELDS)[number];

const ALLOWED_PATCH_KEYS = new Set<string>(WAREHOUSE_LOCATION_PATCH_FIELDS);
const VALID_LOCATION_TYPES = new Set<string>(locationTypeEnum);
const VALID_BIN_TYPES = new Set<string>(WAREHOUSE_BIN_TYPES);

const postgresId = z.number().int().positive().max(2_147_483_647);
const binaryFlag = z
  .number()
  .int()
  .refine((v): v is 0 | 1 => v === 0 || v === 1, {
    message: "Must be 0 or 1",
  });

const nullableTrimmedSegment = (maxLen: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().max(maxLen))
    .transform((s) => (s.length === 0 ? null : s))
    .nullable()
    .optional();

const warehouseLocationPatchSchema = z
  .object({
    locationType: z
      .string()
      .trim()
      .min(1, "locationType cannot be empty")
      .transform((val) => normalizeLocationType(val))
      .refine((val) => VALID_LOCATION_TYPES.has(val), {
        message: `locationType must be one of: ${locationTypeEnum.join(", ")}`,
      })
      .optional(),
    binType: z
      .string()
      .trim()
      .min(1, "binType cannot be empty")
      .transform((val) => val.toLowerCase())
      .refine((val) => VALID_BIN_TYPES.has(val), {
        message: `binType must be one of: ${WAREHOUSE_BIN_TYPES.join(", ")}`,
      })
      .optional(),
    isPickable: binaryFlag.optional(),
    isActive: binaryFlag.optional(),
    warehouseId: postgresId.nullable().optional(),
    zone: nullableTrimmedSegment(10),
    aisle: nullableTrimmedSegment(5),
    bay: nullableTrimmedSegment(5),
    level: nullableTrimmedSegment(5),
    bin: nullableTrimmedSegment(5),
    name: z
      .string()
      .transform((s) => {
        const trimmed = s.trim();
        return trimmed.length === 0 ? null : trimmed;
      })
      .nullable()
      .optional(),
  })
  .strict();

export type WarehouseLocationPatch = z.infer<typeof warehouseLocationPatchSchema>;

export class WarehouseLocationWriteError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WarehouseLocationWriteError";
  }
}

export function parseWarehouseLocationId(value: unknown): number {
  const candidate =
    typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  const parsed = postgresId.safeParse(candidate);
  if (!parsed.success) {
    throw new WarehouseLocationWriteError(
      "Warehouse location id must be a positive integer.",
      400,
      "WAREHOUSE_LOCATION_ID_INVALID",
    );
  }
  return parsed.data;
}

/**
 * Strict parser for public `PATCH /api/warehouse/locations/:id` requests.
 *
 * Allows only the 11 editor metadata fields (`WAREHOUSE_LOCATION_PATCH_FIELDS`).
 * Rejects `cycleCountFreezeId`, `id`, `code`, `createdAt`, `updatedAt`, and any
 * unrecognised fields before touching persistence (`WH-F01`), and preserves
 * omitted fields (`undefined`) so partial updates never default `locationType`
 * to `"pick"` (`WH-F02`).
 */
export function parseWarehouseLocationPatch(value: unknown): WarehouseLocationPatch {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WarehouseLocationWriteError(
      "Warehouse location update payload must be a JSON object.",
      400,
      "WAREHOUSE_LOCATION_PATCH_INVALID",
    );
  }

  const rawObj = value as Record<string, unknown>;
  const keys = Object.keys(rawObj);

  if (keys.includes("cycleCountFreezeId")) {
    throw new WarehouseLocationWriteError(
      "cycleCountFreezeId is owned by the cycle count workflow and cannot be modified via location metadata.",
      400,
      "WAREHOUSE_LOCATION_FREEZE_PROTECTED",
      { fields: ["cycleCountFreezeId"] },
    );
  }

  const unsupportedFields = keys.filter((key) => !ALLOWED_PATCH_KEYS.has(key));
  if (unsupportedFields.length > 0) {
    throw new WarehouseLocationWriteError(
      `Unsupported or protected field(s) in location metadata update: ${unsupportedFields.join(", ")}.`,
      400,
      "WAREHOUSE_LOCATION_PATCH_FIELDS_UNSUPPORTED",
      { fields: unsupportedFields },
    );
  }

  const definedKeys = keys.filter((key) => rawObj[key] !== undefined);
  if (definedKeys.length === 0) {
    throw new WarehouseLocationWriteError(
      "At least one location metadata field must be provided.",
      400,
      "WAREHOUSE_LOCATION_PATCH_EMPTY",
    );
  }

  const parsed = warehouseLocationPatchSchema.safeParse(rawObj);
  if (!parsed.success) {
    throw new WarehouseLocationWriteError(
      parsed.error.errors[0]?.message || "Invalid warehouse location metadata.",
      400,
      "WAREHOUSE_LOCATION_PATCH_INVALID",
      { fields: parsed.error.flatten().fieldErrors },
    );
  }

  const output: Record<string, unknown> = {};
  for (const key of WAREHOUSE_LOCATION_PATCH_FIELDS) {
    if (parsed.data[key] !== undefined) {
      output[key] = parsed.data[key];
    }
  }
  return output as WarehouseLocationPatch;
}
