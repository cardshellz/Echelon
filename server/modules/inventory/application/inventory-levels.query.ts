import type { AllowedInventoryConversion } from "@shared/types/inventory-conversions";
import type { InventoryConversionReader } from "../../inventory-planning/application/inventory-conversion-read.port";

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
  /** Physical variant units not currently reserved. This is not ATP. */
  unreservedQty: number;
  /** Authority-aware sellable quantity returned by the operational ATP boundary. */
  atpUnits: number;
  /** @deprecated Compatibility alias for atpUnits. */
  available: number;
  locationCount: number;
  pickableQty: number;
  binCount: number;
  noBin: boolean;
  /** @deprecated Missing legacy parents are not configuration failures. */
  noCaseBreak: boolean;
  allowedConversions: AllowedInventoryConversion[];
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
  conversions: InventoryConversionReader;
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
      unreservedQty: variantQty - reservedQty,
      atpUnits: 0,
      available: 0,
      locationCount: integer(row.location_count),
      pickableQty: integer(row.pickable_variant_qty),
      binCount,
      noBin: variantQty > 0 && binCount === 0,
      noCaseBreak: false,
      allowedConversions: [] as AllowedInventoryConversion[],
      noBarcode: !barcode,
      noReplen: binCount > 0 && integer(row.has_replen_rule) !== 1,
      overReserved: reservedQty > variantQty,
      negativeQty: variantQty < 0,
      isDuplicate: false,
    };
  });

  const productIds = [...new Set(levels
    .filter((level) => level.productId != null)
    .map((level) => level.productId as number))];
  const atpRows = await Promise.all(productIds.map((productId) => (
    input.warehouseId == null
      ? input.atp.getAtpPerVariant(productId)
      : input.atp.getAtpPerVariantByWarehouse(productId, input.warehouseId)
  )));
  const atpByVariant = new Map<number, number>();
  for (const row of atpRows.flat()) {
    atpByVariant.set(row.productVariantId, row.atpUnits);
  }
  // Missing/retired models return no directions. Read failure fails this view;
  // never reconstruct a path from parent links, units or another SKU's stock.
  const conversionRows = await Promise.all(productIds.map(productId => input.conversions.getAllowedConversions(productId)));
  const conversionsByTarget = new Map<number, AllowedInventoryConversion[]>();
  for (const conversion of conversionRows.flat()) {
    const entries = conversionsByTarget.get(conversion.destinationVariantId) ?? [];
    entries.push(conversion);
    conversionsByTarget.set(conversion.destinationVariantId, entries);
  }

  const skuCounts = new Map<string, number>();
  for (const level of levels) {
    level.atpUnits = atpByVariant.get(level.variantId) ?? 0;
    level.available = level.atpUnits;
    level.allowedConversions = conversionsByTarget.get(level.variantId) ?? [];
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
