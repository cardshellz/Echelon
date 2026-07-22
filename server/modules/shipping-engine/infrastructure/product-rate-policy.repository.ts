import { asc, eq, inArray } from "drizzle-orm";
import {
  shippingRateRuleBands,
  shippingRateRuleMembers,
  shippingRateRules,
  type ShippingRateRuleAction,
  type ShippingRateRuleDestinationScope,
  type ShippingRateRuleKind,
  type ShippingRateRuleMeasurementScope,
} from "@shared/schema";
import { db } from "../../../db";
import type { ProductRateRule } from "../domain/product-rate-policy";

export async function loadProductRateRules(
  rateTableIds: readonly number[],
): Promise<Map<number, ProductRateRule[]>> {
  const uniqueIds = [...new Set(rateTableIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (uniqueIds.length === 0) return new Map();

  const [rules, members, bands] = await Promise.all([
    db.select().from(shippingRateRules)
      .where(inArray(shippingRateRules.rateTableId, uniqueIds))
      .orderBy(asc(shippingRateRules.id)),
    db.select({
      rateRuleId: shippingRateRuleMembers.rateRuleId,
      productVariantId: shippingRateRuleMembers.productVariantId,
    }).from(shippingRateRuleMembers)
      .innerJoin(shippingRateRules, eq(shippingRateRuleMembers.rateRuleId, shippingRateRules.id))
      .where(inArray(shippingRateRules.rateTableId, uniqueIds))
      .orderBy(asc(shippingRateRuleMembers.rateRuleId), asc(shippingRateRuleMembers.productVariantId)),
    db.select({
      rateRuleId: shippingRateRuleBands.rateRuleId,
      minMeasure: shippingRateRuleBands.minMeasure,
      maxMeasure: shippingRateRuleBands.maxMeasure,
      rateCents: shippingRateRuleBands.rateCents,
    }).from(shippingRateRuleBands)
      .innerJoin(shippingRateRules, eq(shippingRateRuleBands.rateRuleId, shippingRateRules.id))
      .where(inArray(shippingRateRules.rateTableId, uniqueIds))
      .orderBy(asc(shippingRateRuleBands.rateRuleId), asc(shippingRateRuleBands.minMeasure)),
  ]);

  const membersByRule = new Map<number, number[]>();
  for (const row of members) {
    const list = membersByRule.get(row.rateRuleId) ?? [];
    list.push(row.productVariantId);
    membersByRule.set(row.rateRuleId, list);
  }
  const bandsByRule = new Map<number, Array<{
    minMeasure: number;
    maxMeasure: number | null;
    rateCents: number;
  }>>();
  for (const row of bands) {
    const list = bandsByRule.get(row.rateRuleId) ?? [];
    list.push({
      minMeasure: row.minMeasure,
      maxMeasure: row.maxMeasure,
      rateCents: row.rateCents,
    });
    bandsByRule.set(row.rateRuleId, list);
  }

  const result = new Map<number, ProductRateRule[]>();
  for (const rule of rules) {
    const list = result.get(rule.rateTableId) ?? [];
    list.push({
      id: rule.id,
      name: rule.name,
      kind: rule.kind as ShippingRateRuleKind,
      action: rule.action as ShippingRateRuleAction,
      measurementScope: rule.measurementScope as ShippingRateRuleMeasurementScope,
      destinationScope: rule.destinationScope as ShippingRateRuleDestinationScope,
      rateCents: rule.rateCents,
      perStartedPoundCents: rule.perStartedPoundCents,
      thresholdCents: rule.thresholdCents,
      memberVariantIds: membersByRule.get(rule.id) ?? [],
      bands: bandsByRule.get(rule.id) ?? [],
      isActive: rule.isActive,
    });
    result.set(rule.rateTableId, list);
  }
  return result;
}
