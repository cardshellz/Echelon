export const MAX_BIN_ASSIGNMENT_VARIANT_IDS = 200;

export class BinAssignmentFilterError extends Error {
  readonly code = "BIN_ASSIGNMENT_VARIANT_IDS_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "BinAssignmentFilterError";
  }
}

export function normalizeBinAssignmentVariantIds(
  productVariantIds: readonly number[],
): number[] {
  if (productVariantIds.length === 0) return [];
  if (productVariantIds.length > MAX_BIN_ASSIGNMENT_VARIANT_IDS) {
    throw new BinAssignmentFilterError(
      `At most ${MAX_BIN_ASSIGNMENT_VARIANT_IDS} product variant IDs may be requested.`,
    );
  }
  for (const id of productVariantIds) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new BinAssignmentFilterError("Product variant IDs must be positive safe integers.");
    }
  }
  return [...new Set(productVariantIds)].sort((left, right) => left - right);
}

export function parseBinAssignmentVariantIdsQuery(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BinAssignmentFilterError(
      "variantIds must be a comma-separated list of positive integers.",
    );
  }
  const parts = value.split(",").map((part) => part.trim());
  if (parts.some((part) => !/^\d+$/.test(part))) {
    throw new BinAssignmentFilterError(
      "variantIds must be a comma-separated list of positive integers.",
    );
  }
  return normalizeBinAssignmentVariantIds(parts.map((part) => Number(part)));
}
