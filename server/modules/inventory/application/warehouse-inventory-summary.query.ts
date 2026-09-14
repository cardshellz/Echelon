import type { ProductInventoryStrategy } from "@shared/catalog/inventory-strategy";

export interface WarehouseInventorySummaryAtpRow {
  productVariantId: number;
  atpUnits: number;
  atpBase: number;
}

export interface WarehouseInventorySummaryAtpReader {
  getAtpPerVariantByWarehouse(
    productId: number,
    warehouseId: number,
  ): Promise<WarehouseInventorySummaryAtpRow[]>;
}

export interface WarehouseInventorySummaryLevel {
  productVariantId: number | null;
  variantQty: number;
  reservedQty: number;
  pickedQty: number;
}

export interface WarehouseInventorySummaryVariant {
  id: number;
  productId: number;
  sku: string | null;
  name: string;
  unitsPerVariant: number;
}

export interface WarehouseInventorySummaryProduct {
  id: number;
  sku: string | null;
  name: string;
  inventoryStrategy: ProductInventoryStrategy;
}

export interface WarehouseInventoryItemSummary {
  productId: number;
  baseSku: string;
  name: string;
  totalOnHandPieces: number;
  totalReservedPieces: number;
  totalAtpPieces: number;
  variants: Array<{
    variantId: number;
    sku: string;
    name: string;
    unitsPerVariant: number;
    /** @deprecated Compatibility alias for atpUnits. */
    available: number;
    atpUnits: number;
    variantQty: number;
    reservedQty: number;
    pickedQty: number;
    atpPieces: number;
  }>;
}

/**
 * Projects one warehouse's physical counters alongside ATP supplied by the
 * authority-aware operational reader. Picked is retained as workflow evidence
 * and is never deducted from on-hand a second time in this projection.
 */
export async function projectWarehouseInventorySummary(input: {
  warehouseId: number;
  authority: "legacy" | "canonical";
  levels: readonly WarehouseInventorySummaryLevel[];
  variants: readonly WarehouseInventorySummaryVariant[];
  products: readonly WarehouseInventorySummaryProduct[];
  atp: WarehouseInventorySummaryAtpReader;
}): Promise<WarehouseInventoryItemSummary[]> {
  const variantsById = new Map(input.variants.map((variant) => [variant.id, variant] as const));
  const productsById = new Map(input.products.map((product) => [product.id, product] as const));
  const levelsByVariant = new Map<number, WarehouseInventorySummaryLevel[]>();

  for (const level of input.levels) {
    if (level.productVariantId == null || !variantsById.has(level.productVariantId)) continue;
    const existing = levelsByVariant.get(level.productVariantId) ?? [];
    existing.push(level);
    levelsByVariant.set(level.productVariantId, existing);
  }

  const productIds = [...new Set([...levelsByVariant.keys()]
    .map((variantId) => variantsById.get(variantId)?.productId)
    .filter((productId): productId is number => productId != null && productsById.has(productId)))]
    .sort((left, right) => left - right);
  const atpRowsByProduct = new Map<number, WarehouseInventorySummaryAtpRow[]>();
  await Promise.all(productIds.map(async (productId) => {
    atpRowsByProduct.set(
      productId,
      await input.atp.getAtpPerVariantByWarehouse(productId, input.warehouseId),
    );
  }));

  const summaries: WarehouseInventoryItemSummary[] = [];
  for (const productId of productIds) {
    const product = productsById.get(productId)!;
    const atpByVariant = new Map(
      (atpRowsByProduct.get(productId) ?? []).map((row) => [row.productVariantId, row] as const),
    );
    const variants = input.variants
      .filter((variant) => variant.productId === productId && levelsByVariant.has(variant.id))
      .sort((left, right) => left.id - right.id)
      .map((variant) => {
        if (!Number.isSafeInteger(variant.unitsPerVariant) || variant.unitsPerVariant <= 0) {
          throw new RangeError(`Variant ${variant.id} has an invalid units-per-variant value.`);
        }
        const levels = levelsByVariant.get(variant.id)!;
        const variantQty = sumQuantities(levels.map((level) => level.variantQty), "variantQty", variant.id);
        const reservedQty = sumQuantities(levels.map((level) => level.reservedQty), "reservedQty", variant.id);
        const pickedQty = sumQuantities(levels.map((level) => level.pickedQty), "pickedQty", variant.id);
        const atp = atpByVariant.get(variant.id);
        const atpUnits = nonnegativeSafeQuantity(atp?.atpUnits ?? 0, "atpUnits", variant.id);
        const atpPieces = nonnegativeSafeQuantity(atp?.atpBase ?? 0, "atpBase", variant.id);
        return {
          variantId: variant.id,
          sku: variant.sku ?? "",
          name: variant.name,
          unitsPerVariant: variant.unitsPerVariant,
          available: atpUnits,
          atpUnits,
          variantQty,
          reservedQty,
          pickedQty,
          atpPieces,
        };
      });

    const totalOnHandPieces = sumQuantities(
      variants.map((variant) => variant.variantQty * variant.unitsPerVariant),
      "totalOnHandPieces",
      productId,
    );
    const totalReservedPieces = sumQuantities(
      variants.map((variant) => variant.reservedQty * variant.unitsPerVariant),
      "totalReservedPieces",
      productId,
    );
    const aggregateAtp = input.authority === "canonical" || product.inventoryStrategy === "physical_fungible"
      ? variants.reduce((maximum, variant) => Math.max(maximum, variant.atpPieces), 0)
      : sumQuantities(variants.map((variant) => variant.atpPieces), "totalAtpPieces", productId);
    summaries.push({
      productId,
      baseSku: product.sku ?? "",
      name: product.name,
      totalOnHandPieces,
      totalReservedPieces,
      totalAtpPieces: aggregateAtp,
      variants,
    });
  }
  return summaries;
}

function sumQuantities(values: readonly number[], field: string, subjectId: number): number {
  const total = values.reduce((sum, value) => sum + Number(value), 0);
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`${field} for ${subjectId} must be a safe integer.`);
  }
  return total;
}

function nonnegativeSafeQuantity(value: number, field: string, variantId: number): number {
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError(`${field} for variant ${variantId} must be a nonnegative safe integer.`);
  }
  return quantity;
}
