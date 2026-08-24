export interface InventoryLevelAtpRow {
  productVariantId: number;
  atpUnits: number;
}

export interface InventoryLevelAtpReader {
  getAtpPerVariant(productId: number): Promise<InventoryLevelAtpRow[]>;
  getAtpPerVariantByWarehouse(productId: number, warehouseId: number): Promise<InventoryLevelAtpRow[]>;
}

export interface InventoryLevelProjection {
  variantId: number;
  sku: string;
  name: string;
  unitsPerVariant: number;
  parentVariantId: number | null;
  hierarchyLevel: number;
  isBaseUnit: boolean;
  baseSku: string | null;
  productId: number | null;
  productName: string | null;
  inventoryStrategy: string | null;
  barcode: string | null;
  variantQty: number;
  reservedQty: number;
  pickedQty: number;
  available: number;
  locationCount: number;
  pickableQty: number;
  binCount: number;
  noBin: boolean;
  noCaseBreak: boolean;
  noBarcode: boolean;
  noReplen: boolean;
  overReserved: boolean;
  negativeQty: boolean;
  isDuplicate: boolean;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullablePositiveInteger(value: unknown): number | null {
  const parsed = integer(value);
  return parsed > 0 ? parsed : null;
}

export async function projectInventoryLevels(input: {
  rows: Array<Record<string, unknown>>;
  atp: InventoryLevelAtpReader;
  warehouseId?: number;
}): Promise<InventoryLevelProjection[]> {
  const levels = input.rows.map((row) => {
    const variantQty = integer(row.total_variant_qty);
    const reservedQty = integer(row.total_reserved_qty);
    const binCount = integer(row.bin_count);
    const hierarchyLevel = integer(row.hierarchy_level, 1);
    const parentVariantId = nullablePositiveInteger(row.parent_variant_id);
    const barcode = typeof row.barcode === "string" && row.barcode.length > 0 ? row.barcode : null;
    const isBaseUnit = row.is_base_unit === true;
    const inventoryStrategy = typeof row.inventory_strategy === "string" ? row.inventory_strategy : null;

    return {
      variantId: integer(row.variant_id),
      sku: typeof row.variant_sku === "string" ? row.variant_sku : "",
      name: typeof row.variant_name === "string" ? row.variant_name : "",
      unitsPerVariant: integer(row.units_per_variant, 1),
      parentVariantId,
      hierarchyLevel,
      isBaseUnit,
      baseSku: typeof row.base_sku === "string" ? row.base_sku : null,
      productId: nullablePositiveInteger(row.product_id),
      productName: typeof row.product_name === "string" ? row.product_name : null,
      inventoryStrategy,
      barcode,
      variantQty,
      reservedQty,
      pickedQty: integer(row.total_picked_qty),
      available: variantQty - reservedQty,
      locationCount: integer(row.location_count),
      pickableQty: integer(row.pickable_variant_qty),
      binCount,
      noBin: variantQty > 0 && binCount === 0,
      noCaseBreak: hierarchyLevel >= 2 && !parentVariantId && !isBaseUnit,
      noBarcode: !barcode,
      noReplen: binCount > 0 && integer(row.has_replen_rule) !== 1,
      overReserved: reservedQty > variantQty,
      negativeQty: variantQty < 0,
      isDuplicate: false,
    };
  });

  const recipeProductIds = [...new Set(levels
    .filter((level) => level.inventoryStrategy === "recipe_managed" && level.productId != null)
    .map((level) => level.productId as number))];
  const recipeAtpRows = await Promise.all(recipeProductIds.map((productId) => (
    input.warehouseId == null
      ? input.atp.getAtpPerVariant(productId)
      : input.atp.getAtpPerVariantByWarehouse(productId, input.warehouseId)
  )));
  const recipeAtpByVariant = new Map<number, number>();
  for (const row of recipeAtpRows.flat()) {
    recipeAtpByVariant.set(row.productVariantId, row.atpUnits);
  }

  const skuCounts = new Map<string, number>();
  for (const level of levels) {
    if (level.inventoryStrategy === "recipe_managed") {
      level.available = recipeAtpByVariant.get(level.variantId) ?? 0;
    }
    if (level.sku) {
      const normalizedSku = level.sku.toUpperCase();
      skuCounts.set(normalizedSku, (skuCounts.get(normalizedSku) ?? 0) + 1);
    }
  }

  return levels.map((level) => ({
    ...level,
    isDuplicate: level.sku ? (skuCounts.get(level.sku.toUpperCase()) ?? 0) > 1 : false,
  }));
}
