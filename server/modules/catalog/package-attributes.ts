export const PACKAGE_ATTRIBUTE_KEYS = ["weightGrams", "lengthMm", "widthMm", "heightMm"] as const;
export const MAX_PACKAGE_ATTRIBUTE_VALUE = 1_000_000_000;
export const MAX_BULK_PACKAGE_ATTRIBUTE_ROWS = 500;

export type PackageAttributeKey = typeof PACKAGE_ATTRIBUTE_KEYS[number];
export type PackageAttributeUpdates = Partial<Record<PackageAttributeKey, number | null>>;

export interface PackageAttributeBulkRow {
  variantId: number;
  updates: PackageAttributeUpdates;
}

export class PackageAttributeValidationError extends Error {
  readonly statusCode = 400;
}

export function parsePackageAttributeValue(value: unknown, fieldName: PackageAttributeKey): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_PACKAGE_ATTRIBUTE_VALUE) {
    throw new PackageAttributeValidationError(`${fieldName} must be a positive integer or null`);
  }
  return value;
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
