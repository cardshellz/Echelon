/**
 * Cost Resolver — COGS Phase 2
 *
 * Catalog estimate fallback when a stock owner has no explicit or exact sold
 * cost. Missing evidence remains unresolved; a recorded known zero is handled
 * by the owning lot/return policy before this estimate lookup.
 *
 * Waterfall order (first non-zero wins):
 *   1. Explicit hint (caller-provided, e.g. from PO line)
 *   2. Last purchase cost (catalog.product_variants.last_cost_cents)
 *   3. Standard cost (catalog.product_variants.standard_cost_cents)
 *   4. Weighted average cost (catalog.product_variants.avg_cost_cents)
 *   5. Zero — flagged as unresolved
 *
 * Every resolved cost carries a `source` tag and a `provisional` flag so
 * downstream code knows the confidence level and landed-cost finalization
 * can tell whether to overwrite.
 */

import { eq } from "drizzle-orm";
import { productVariants } from "@shared/schema";

export type CostSource =
  | "explicit"       // Caller provided a value (PO, manual entry)
  | "last_paid"      // catalog.product_variants.last_cost_cents
  | "standard"       // catalog.product_variants.standard_cost_cents
  | "avg"            // catalog.product_variants.avg_cost_cents
  | "unresolved";    // Nothing found — flagged for review

export interface ResolvedCost {
  costCents: number;
  source: CostSource;
  provisional: boolean;
}

type MinimalDb = {
  select: (...args: any[]) => any;
  execute: (query: any) => Promise<any>;
};

/**
 * Resolve the best available unit cost for a product variant.
 *
 * @param db          - Drizzle DB handle (or transaction)
 * @param variantId   - The product variant to look up
 * @param hintCents   - Optional explicit cost from the caller (PO line, etc.)
 */
export async function resolveCost(
  db: MinimalDb,
  variantId: number,
  hintCents?: number | null,
): Promise<ResolvedCost> {
  if (hintCents !== undefined && hintCents !== null && hintCents > 0) {
    return { costCents: hintCents, source: "explicit", provisional: false };
  }

  const [variant] = await db
    .select({
      lastCostCents: productVariants.lastCostCents,
      standardCostCents: productVariants.standardCostCents,
      avgCostCents: productVariants.avgCostCents,
    })
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .limit(1);

  if (!variant) {
    return { costCents: 0, source: "unresolved", provisional: true };
  }

  const last = Number(variant.lastCostCents) || 0;
  if (last > 0) {
    return { costCents: last, source: "last_paid", provisional: true };
  }

  const standard = Number(variant.standardCostCents) || 0;
  if (standard > 0) {
    return { costCents: standard, source: "standard", provisional: true };
  }

  const avg = Number(variant.avgCostCents) || 0;
  if (avg > 0) {
    return { costCents: avg, source: "avg", provisional: true };
  }

  return { costCents: 0, source: "unresolved", provisional: true };
}
