import {
  isVariantUomType,
  type VariantUomType,
} from "@shared/catalog/variant-uom";

type VariantUomState = {
  uomType?: VariantUomType | null;
  unitsPerVariant?: number | null;
  hierarchyLevel?: number | null;
  parentVariantId?: number | null;
  isBaseUnit?: boolean | null;
};

function badRequest(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function validateVariantUomWrite(
  input: unknown,
  existing?: VariantUomState,
): { uomType?: VariantUomType } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const hasUomType = Object.prototype.hasOwnProperty.call(source, "uomType");

  if (hasUomType && !isVariantUomType(source.uomType)) {
    throw badRequest("uomType must be one of: each, pack, inner_pack, case, skid");
  }

  const effectiveUomType = hasUomType
    ? source.uomType as VariantUomType
    : existing?.uomType ?? undefined;

  if (effectiveUomType === "each") {
    const unitsPerVariant = source.unitsPerVariant ?? existing?.unitsPerVariant;
    const hierarchyLevel = source.hierarchyLevel ?? existing?.hierarchyLevel;
    const parentVariantId = Object.prototype.hasOwnProperty.call(source, "parentVariantId")
      ? source.parentVariantId
      : existing?.parentVariantId;
    const isBaseUnit = source.isBaseUnit ?? existing?.isBaseUnit;

    if (unitsPerVariant !== 1) throw badRequest("Each variants must contain exactly 1 unit");
    if (hierarchyLevel !== 1) throw badRequest("Each variants must use hierarchy level 1");
    if (parentVariantId !== null && parentVariantId !== undefined) {
      throw badRequest("Each variants cannot break into a parent variant");
    }
    if (isBaseUnit !== true) throw badRequest("Each variants must be marked as the base inventory unit");
  }

  return hasUomType ? { uomType: source.uomType as VariantUomType } : {};
}
