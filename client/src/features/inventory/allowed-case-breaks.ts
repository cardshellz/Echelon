import { allowedInventoryConversionSchema, type AllowedInventoryConversion } from "@shared/types/inventory-conversions";

interface InventoryVariant {
  variantId: number;
  productId: number | null;
  locationCount: number;
  variantQty: number;
  allowedConversions?: AllowedInventoryConversion[];
}

/** Only a direct authorized edge can open the manual case-break command. A
 * transitive path needs its intermediate operations, never an inferred shortcut. */
export function allowedCaseBreakSources<T extends InventoryVariant>(target: T, variants: readonly T[]) {
  const result: Array<{ source: T; conversion: AllowedInventoryConversion }> = [];
  for (const raw of target.allowedConversions ?? []) {
    const parsed = allowedInventoryConversionSchema.safeParse(raw);
    if (!parsed.success) continue;
    const conversion = parsed.data;
    if (conversion.operationType !== "break_pack" || conversion.destinationVariantId !== target.variantId) continue;
    const source = variants.find(variant => variant.variantId === conversion.sourceVariantId);
    if (!source || source.variantId === target.variantId || target.productId === null
      || source.productId !== target.productId || (source.locationCount === 0 && source.variantQty === 0)) continue;
    result.push({ source, conversion });
  }
  return result;
}
