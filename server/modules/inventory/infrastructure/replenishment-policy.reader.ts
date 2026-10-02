import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { productVariants, replenRules, replenTierDefaults } from "@shared/schema";
import type { db } from "../../../db";
import { getReplenishmentSettingsForWarehouse } from "../../warehouse/settings.resolver";
import { resolveReplenishmentAutoExecution } from "../domain/replenishment-auto-execution";
import { ReplenishmentExecutionDomainError } from "../domain/replenishment-execution.domain";

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

/** Read policy in the pick's serializable transaction, never from a stale UI preview. */
export async function isClaimPackageConversionInline(client: PoolClient, input: {
  destinationVariantId: number; warehouseId: number; outputQty: bigint;
  method: "case_break" | "package_conversion";
}): Promise<boolean> {
  const reader = drizzle(client);
  const [variant] = await reader.select({
    hierarchyLevel: productVariants.hierarchyLevel, unitsPerVariant: productVariants.unitsPerVariant,
  }).from(productVariants).where(eq(productVariants.id, input.destinationVariantId));
  if (!variant || !Number.isSafeInteger(variant.unitsPerVariant) || variant.unitsPerVariant <= 0) {
    throw new ReplenishmentExecutionDomainError("CLAIM_REPLENISHMENT_VARIANT_INVALID",
      "The package-conversion destination has invalid replenishment metadata.", { destinationVariantId: input.destinationVariantId });
  }
  const rule = await readReplenishmentRule(reader, input.destinationVariantId);
  const tier = await readReplenishmentTierDefault(reader, variant.hierarchyLevel, input.warehouseId);
  const settings = await getReplenishmentSettingsForWarehouse(input.warehouseId, reader);
  const baseUnits = input.outputQty * BigInt(variant.unitsPerVariant);
  if (baseUnits <= BigInt(0) || baseUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ReplenishmentExecutionDomainError("CLAIM_REPLENISHMENT_QUANTITY_INVALID",
      "Claim package-conversion quantity exceeds the supported replenishment range.", { baseUnits: baseUnits.toString() });
  }
  // Match resolveReplenParams: a non-null SKU override (including defer=0)
  // wins over the tier before the warehouse fallback is evaluated.
  return resolveReplenishmentAutoExecution(rule?.autoReplen ?? tier?.autoReplen ?? 0,
    null, settings, Number(baseUnits), input.method).shouldAutoExecute;
}
