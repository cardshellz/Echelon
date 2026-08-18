export const VARIANT_UOM_TYPES = ["each", "pack", "inner_pack", "case", "skid"] as const;

export type VariantUomType = (typeof VARIANT_UOM_TYPES)[number];

export const VARIANT_UOM_DEFINITIONS: ReadonlyArray<{
  type: VariantUomType;
  label: string;
  skuPrefix: string | null;
  defaultHierarchyLevel: number;
}> = [
  { type: "each", label: "Each", skuPrefix: null, defaultHierarchyLevel: 1 },
  { type: "pack", label: "Pack", skuPrefix: "P", defaultHierarchyLevel: 1 },
  { type: "inner_pack", label: "Box / Inner Pack", skuPrefix: "B", defaultHierarchyLevel: 2 },
  { type: "case", label: "Case", skuPrefix: "C", defaultHierarchyLevel: 3 },
  { type: "skid", label: "Skid", skuPrefix: "SK", defaultHierarchyLevel: 4 },
] as const;

export function isVariantUomType(value: unknown): value is VariantUomType {
  return typeof value === "string" && VARIANT_UOM_TYPES.includes(value as VariantUomType);
}

export function getVariantUomDefinition(type: VariantUomType) {
  return VARIANT_UOM_DEFINITIONS.find((definition) => definition.type === type)!;
}

export function inferLegacyVariantUomType(input: {
  hierarchyLevel: number;
  unitsPerVariant: number;
  isBaseUnit?: boolean | null;
  parentVariantId?: number | null;
}): VariantUomType {
  if (
    input.hierarchyLevel === 1
    && input.isBaseUnit === true
    && input.unitsPerVariant === 1
    && (input.parentVariantId === null || input.parentVariantId === undefined)
  ) return "each";
  if (input.hierarchyLevel >= 4) return "skid";
  if (input.hierarchyLevel === 3) return "case";
  if (input.hierarchyLevel === 2) return "inner_pack";
  return "pack";
}