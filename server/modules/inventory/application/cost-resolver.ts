import { readIntegerCents, readIntegerMills } from "@shared/money-read";
/**
 * Cost Resolver — COGS Phase 2 (4-decimal mills authoritative)
 *
 * Catalog estimate fallback when a stock owner has no explicit or exact sold
 * cost. Missing evidence remains unresolved; a recorded known zero is handled
 * by the owning lot/return policy before this estimate lookup.
 *
 * Waterfall order (first positive mills / cents wins):
 *   1. Explicit hint (caller-provided `hintMills` or `hintCents`, e.g. from PO line)
 *   2. Last purchase cost (`last_cost_mills` -> `last_cost_cents * 100`)
 *   3. Standard cost (`standard_cost_mills` -> `standard_cost_cents * 100`)
 *   4. Weighted average cost (`avg_cost_mills` -> `avg_cost_cents * 100`)
 *   5. Zero — flagged as unresolved
 *
 * Sub-half-cent items (< $0.0050, e.g. 38 mills = $0.0038 penny sleeves) retain
 * their exact positive `costMills` even when `costCents` rounds half-up to 0.
 */

import { eq } from "drizzle-orm";
import { productVariants } from "@shared/schema";
import { centsToMills, millsToCents } from "@shared/utils/money";

export type CostSource =
  | "explicit"       // Caller provided a value (PO, manual entry)
  | "last_paid"      // catalog.product_variants.last_cost_mills / last_cost_cents
  | "standard"       // catalog.product_variants.standard_cost_mills / standard_cost_cents
  | "avg"            // catalog.product_variants.avg_cost_mills / avg_cost_cents
  | "unresolved";    // Nothing found — flagged for review

export interface ResolvedCost {
  costCents: number;
  costMills: number;
  source: CostSource;
  provisional: boolean;
}

type MinimalDb = {
  select: (...args: any[]) => any;
  execute: (query: any) => Promise<any>;
};

function resolveTierMills(
  rawMills: unknown,
  rawCents: unknown,
  label: string,
): { costMills: number; costCents: number } {
  if (rawMills !== null && rawMills !== undefined) {
    const mills = readIntegerMills(rawMills, `${label} mills`, true);
    if (mills > 0) {
      return { costMills: mills, costCents: millsToCents(mills) };
    }
  }
  const cents = readIntegerCents(rawCents ?? 0, label, true);
  if (cents > 0) {
    return { costMills: centsToMills(cents), costCents: cents };
  }
  return { costMills: 0, costCents: 0 };
}

/**
 * Resolve the best available unit cost for a product variant.
 *
 * @param db          - Drizzle DB handle (or transaction)
 * @param variantId   - The product variant to look up
 * @param hintCents   - Optional explicit cost in cents from the caller
 * @param hintMills   - Optional explicit 4-decimal cost in mills from the caller (preferred)
 */
export async function resolveCost(
  db: MinimalDb,
  variantId: number,
  hintCents?: number | null,
  hintMills?: number | null,
): Promise<ResolvedCost> {
  const explicitMills =
    hintMills == null ? null : readIntegerMills(hintMills, "cost hint mills", true);
  if (explicitMills !== null && explicitMills > 0) {
    return {
      costCents: millsToCents(explicitMills),
      costMills: explicitMills,
      source: "explicit",
      provisional: false,
    };
  }

  const hint = hintCents == null ? null : readIntegerCents(hintCents, "cost hint", true);
  if (hint !== null && hint > 0) {
    return {
      costCents: hint,
      costMills: centsToMills(hint),
      source: "explicit",
      provisional: false,
    };
  }

  const [variant] = await db
    .select({
      lastCostMills: productVariants.lastCostMills,
      lastCostCents: productVariants.lastCostCents,
      standardCostMills: productVariants.standardCostMills,
      standardCostCents: productVariants.standardCostCents,
      avgCostMills: productVariants.avgCostMills,
      avgCostCents: productVariants.avgCostCents,
    })
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .limit(1);

  if (!variant) {
    return { costCents: 0, costMills: 0, source: "unresolved", provisional: true };
  }

  const last = resolveTierMills(variant.lastCostMills, variant.lastCostCents, "last");
  if (last.costMills > 0) {
    return { ...last, source: "last_paid", provisional: true };
  }

  const standard = resolveTierMills(variant.standardCostMills, variant.standardCostCents, "standard");
  if (standard.costMills > 0) {
    return { ...standard, source: "standard", provisional: true };
  }

  const avg = resolveTierMills(variant.avgCostMills, variant.avgCostCents, "avg");
  if (avg.costMills > 0) {
    return { ...avg, source: "avg", provisional: true };
  }

  return { costCents: 0, costMills: 0, source: "unresolved", provisional: true };
}
