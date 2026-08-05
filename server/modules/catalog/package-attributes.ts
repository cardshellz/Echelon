export const PACKAGE_ATTRIBUTE_KEYS = ["weightGrams", "lengthMm", "widthMm", "heightMm"] as const;
export const MAX_PACKAGE_ATTRIBUTE_VALUE = 1_000_000_000;
export const MAX_BULK_PACKAGE_ATTRIBUTE_ROWS = 500;

export type PackageAttributeKey = typeof PACKAGE_ATTRIBUTE_KEYS[number];
export type PackageAttributeUpdates = Partial<Record<PackageAttributeKey, number | null>>;

/**
 * Drizzle expects strings for numeric(10,2) columns. Convert validated
 * numbers to fixed 2-decimal strings at the write boundary.
 */
export function serializePackageAttributeUpdates(
  updates: PackageAttributeUpdates,
): Partial<Record<PackageAttributeKey, string | null>> {
  const serialized: Partial<Record<PackageAttributeKey, string | null>> = {};
  for (const key of PACKAGE_ATTRIBUTE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      const value = updates[key];
      serialized[key] = value === null || value === undefined ? null : value.toFixed(2);
    }
  }
  return serialized;
}

export interface PackageAttributeBulkRow {
  variantId: number;
  updates: PackageAttributeUpdates;
}

export class PackageAttributeValidationError extends Error {
  readonly statusCode = 400;
}

/**
 * Package facts are stored as numeric(10,2) (migration 184) so inch/pound
 * inputs round-trip exactly. Accept any positive finite number with at most
 * 2 decimal places; reject everything else.
 */
export function parsePackageAttributeValue(value: unknown, fieldName: PackageAttributeKey): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value <= 0
    || value > MAX_PACKAGE_ATTRIBUTE_VALUE
  ) {
    throw new PackageAttributeValidationError(
      `${fieldName} must be a positive number with at most 2 decimal places, or null`,
    );
  }
  // FP-safe 2-decimal check: 152.4 * 100 is 15239.999... in binary floating
  // point, so compare with an epsilon instead of strict equality.
  const rounded = Math.round(value * 100) / 100;
  if (Math.abs(rounded - value) > 1e-9) {
    throw new PackageAttributeValidationError(
      `${fieldName} must be a positive number with at most 2 decimal places, or null`,
    );
  }
  return rounded;
}

export function extractPackageAttributeUpdates(input: unknown): PackageAttributeUpdates {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PackageAttributeValidationError("Package attribute updates must be an object");
  }

  const source = input as Record<string, unknown>;
  const updates: PackageAttributeUpdates = {};
  for (const key of PACKAGE_ATTRIBUTE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      updates[key] = parsePackageAttributeValue(source[key], key);
    }
  }

  if (Object.keys(updates).length === 0) {
    throw new PackageAttributeValidationError("At least one package attribute update is required");
  }

  return updates;
}

export function coercePackageAttributesOnVariantPayload(input: unknown): PackageAttributeUpdates {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};

  const source = input as Record<string, unknown>;
  const updates: PackageAttributeUpdates = {};
  for (const key of PACKAGE_ATTRIBUTE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      updates[key] = parsePackageAttributeValue(source[key], key);
    }
  }
  return updates;
}

export function parsePackageAttributeBulkRows(rowsInput: unknown): PackageAttributeBulkRow[] {
  if (!Array.isArray(rowsInput) || rowsInput.length === 0) {
    throw new PackageAttributeValidationError("rows array required");
  }
  if (rowsInput.length > MAX_BULK_PACKAGE_ATTRIBUTE_ROWS) {
    throw new PackageAttributeValidationError(`Bulk package update is limited to ${MAX_BULK_PACKAGE_ATTRIBUTE_ROWS} variants per request`);
  }

  return rowsInput.map((row: unknown, index: number) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new PackageAttributeValidationError(`Row ${index + 1} must be an object`);
    }
    const source = row as Record<string, unknown>;
    const variantId = Number(source.variantId);
    if (!Number.isInteger(variantId) || variantId <= 0) {
      throw new PackageAttributeValidationError(`Row ${index + 1} has an invalid variantId`);
    }
    return {
      variantId,
      updates: extractPackageAttributeUpdates(source.updates),
    };
  });
}
