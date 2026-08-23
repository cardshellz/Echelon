import type { VariantUomType } from "@shared/catalog/variant-uom";

export type CreateProductVariantInput = {
  sku: string | null;
  name: string;
  unitsPerVariant: number;
  hierarchyLevel: number;
  uomType: VariantUomType;
  barcode: string | null;
  parentVariantId: number | null;
  isBaseUnit: boolean;
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  shipsInOwnContainer?: boolean;
  maxUnitsPerPackage?: number | null;
};

export type CreatedProductVariant = {
  id: number;
  productId: number;
  sku: string | null;
  name: string;
  unitsPerVariant: number;
};

export type VariantSkuConflict = {
  id: number;
  sku: string;
  productId: number;
  productName: string | null;
};

export class CreateProductVariantError extends Error {
  readonly status: number;
  readonly conflictVariant: VariantSkuConflict | null;

  constructor(input: { message: string; status: number; conflictVariant?: VariantSkuConflict | null }) {
    super(input.message);
    this.name = "CreateProductVariantError";
    this.status = input.status;
    this.conflictVariant = input.conflictVariant ?? null;
  }
}

export async function createProductVariant(
  productId: number,
  input: CreateProductVariantInput,
): Promise<CreatedProductVariant> {
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw new CreateProductVariantError({ message: "Select a valid parent product.", status: 400 });
  }

  const response = await fetch(`/api/products/${productId}/variants`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new CreateProductVariantError({
      message: body?.error ?? `Variant creation failed (${response.status}).`,
      status: response.status,
      conflictVariant: body?.conflictVariant ?? null,
    });
  }
  return body as CreatedProductVariant;
}
