import { allowedInventoryConversionSchema, type AllowedInventoryConversion } from "@shared/types/inventory-conversions";

interface CaseBreakVariant {
  id: number;
  productId: number;
  unitsPerVariant: number;
}

export interface CaseBreakTarget<T extends CaseBreakVariant> {
  target: T;
  conversion: AllowedInventoryConversion;
}

/**
 * The break targets a manual case-break task may offer for one source SKU.
 *
 * Only the product's active, saved break_pack directions count. Hierarchy
 * level, parent links and unit ratios are never used to infer a target: two
 * case sizes can share a hierarchy level (e.g. C5000 -> C2500), and an
 * unsaved direction would be refused by the server anyway.
 *
 * Ordered largest target first, so the next package down is listed first.
 */
export function caseBreakTargetsForSource<T extends CaseBreakVariant>(
  source: T,
  variants: readonly T[],
  conversions: readonly unknown[],
): CaseBreakTarget<T>[] {
  const result: CaseBreakTarget<T>[] = [];
  const seen = new Set<number>();
  for (const raw of conversions) {
    const parsed = allowedInventoryConversionSchema.safeParse(raw);
    if (!parsed.success) continue;
    const conversion = parsed.data;
    if (conversion.operationType !== "break_pack" || conversion.sourceVariantId !== source.id) continue;
    if (seen.has(conversion.destinationVariantId)) continue;
    const target = variants.find(variant => variant.id === conversion.destinationVariantId);
    if (!target || target.id === source.id || target.productId !== source.productId) continue;
    seen.add(target.id);
    result.push({ target, conversion });
  }
  return result.sort((a, b) => b.target.unitsPerVariant - a.target.unitsPerVariant);
}

/**
 * Target units produced by breaking `sourceQty` source units under a saved
 * direction, or null when the quantity is not a whole number of target units
 * (the server refuses fractional conversions).
 */
export function caseBreakTargetQty(sourceQty: number, conversion: AllowedInventoryConversion): number | null {
  if (!Number.isSafeInteger(sourceQty) || sourceQty <= 0) return null;
  const produced = sourceQty * conversion.outputQty;
  if (produced % conversion.inputQty !== 0) return null;
  const targetQty = produced / conversion.inputQty;
  return Number.isSafeInteger(targetQty) ? targetQty : null;
}
