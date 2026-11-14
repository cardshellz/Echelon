import { and, eq, isNull } from "drizzle-orm";
import { replenRules, replenTierDefaults } from "@shared/schema";
import type { db } from "../../../db";

type Reader = Pick<typeof db, "select">;

export async function readReplenishmentRule(reader: Reader, variantId: number) {
  const [rule] = await reader.select().from(replenRules)
    .where(and(eq(replenRules.pickProductVariantId, variantId), eq(replenRules.isActive, 1))).limit(1);
  return rule ?? null;
}

export async function readReplenishmentTierDefault(reader: Reader, hierarchyLevel: number, warehouseId?: number) {
  if (warehouseId != null) {
    const [specific] = await reader.select().from(replenTierDefaults).where(and(
      eq(replenTierDefaults.hierarchyLevel, hierarchyLevel),
      eq(replenTierDefaults.warehouseId, warehouseId), eq(replenTierDefaults.isActive, 1),
    )).limit(1);
    if (specific) return specific;
  }
  const [global] = await reader.select().from(replenTierDefaults).where(and(
    eq(replenTierDefaults.hierarchyLevel, hierarchyLevel), isNull(replenTierDefaults.warehouseId),
    eq(replenTierDefaults.isActive, 1),
  )).limit(1);
  return global ?? null;
}
