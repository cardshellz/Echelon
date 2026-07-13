import type { CartonizeItem } from "./cartonize";

export interface CartonizeOrderLine {
  sku: string;
  quantity: number;
}

/**
 * Resolve source-neutral order lines into physical cartonizer inputs.
 * Unresolved SKUs become explicit incomplete items so callers fail closed
 * instead of silently dropping units from the plan.
 */
export function buildCartonizeItems(
  lines: readonly CartonizeOrderLine[],
  variantIdBySku: Map<string, number>,
  packingInputs: Map<number, CartonizeItem>,
): { items: CartonizeItem[]; warnings: string[] } {
  const items: CartonizeItem[] = [];
  const warnings: string[] = [];
  let syntheticId = -1;

  for (const line of lines) {
    if (line.quantity <= 0) continue;
    const variantId = variantIdBySku.get(line.sku);
    const input = variantId !== undefined ? packingInputs.get(variantId) : undefined;
    if (input) {
      items.push({ ...input, quantity: line.quantity });
      continue;
    }
    warnings.push(`sku ${line.sku} not found in catalog; used stub item`);
    items.push({
      productVariantId: syntheticId--,
      sku: line.sku,
      quantity: line.quantity,
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      shippingGroupCode: null,
      shipsInOwnContainer: false,
      riderEligible: false,
      riderVoidCm3: null,
      riderVoidMaxWeightGrams: null,
      riderVoidMaxItems: null,
    });
  }

  return { items, warnings };
}
