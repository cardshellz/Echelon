import { createHash } from "node:crypto";
import type {
  DropshipProductCost,
  DropshipProductCostIssue,
  DropshipProductCostSource,
} from "../application/dropship-product-cost";

/**
 * The one product-cost authority for a Dropship order debit: the Shellz Club
 * `.ops` plan cost the vendor saw in preview. Acceptance must charge exactly
 * this contract, never a catalog-retail discount or a fabricated zero.
 */
export const ACCEPTANCE_COST_AUTHORITY = "shellz_club_ops_product_cost" as const;

/** Provenance frozen with every accepted line so the debit can be audited later. */
export interface DropshipAcceptanceProductCostEvidence {
  source: DropshipProductCostSource;
  planId: string;
  overrideId: string | null;
  /** The live .ops cost read in the acceptance transaction; equals the charged cost unless price protection applied a scheduled cost. */
  liveUnitCostCents: number;
  /** The cost schedule entry in force that the charged cost came from (migration 0711); null when the schedule was not consulted. */
  scheduleEntryId: number | null;
  /** The cost change policy version the schedule was reconciled under; null when the defaults applied. */
  costPolicyId: number | null;
  /** True when the policy's price protection decided the charged cost. */
  priceProtected: boolean;
}

export type ChargedUnitCostDecision = { unitCostCents: number; priceProtected: boolean };

/**
 * Which cost an accepted line is charged: the cost in force on the vendor's
 * schedule when the policy protects prices, else the live cost. Both are
 * positive whole cents; a protected cost may be higher than the live one only
 * when the policy gives decreases notice, so neither bound is assumed.
 */
export function decideChargedUnitCost(input: {
  liveUnitCostCents: number;
  inForceUnitCostCents: number;
  priceProtection: boolean;
}): ChargedUnitCostDecision {
  for (const [name, value] of [["liveUnitCostCents", input.liveUnitCostCents], ["inForceUnitCostCents", input.inForceUnitCostCents]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive whole number of cents.`);
    }
  }
  return input.priceProtection
    ? { unitCostCents: input.inForceUnitCostCents, priceProtected: true }
    : { unitCostCents: input.liveUnitCostCents, priceProtected: false };
}

export type AcceptanceUnitCostResolution =
  | { ok: true; unitCostCents: number; evidence: DropshipAcceptanceProductCostEvidence }
  | {
      ok: false;
      code:
        | "DROPSHIP_ORDER_PRODUCT_COST_UNAVAILABLE"
        | "DROPSHIP_ORDER_PRODUCT_COST_ZERO"
        | "DROPSHIP_ORDER_PRODUCT_COST_INVALID";
      message: string;
      /** Only a failed source read may be retried; every other outcome needs a human. */
      retryable: boolean;
      issue: DropshipProductCostIssue | null;
    };

/**
 * Decide whether a resolved `.ops` cost may be charged for an order line.
 *
 * Fail-closed rules:
 *   - no cost, or an `unavailable` cost, blocks acceptance (retryable only when
 *     the source read itself failed);
 *   - a zero cost blocks acceptance. A `0.00` fixed price is a legal preview
 *     outcome, but charging nothing for goods on a live order is a product
 *     decision that has not been taken, so the conservative default refuses it;
 *   - anything that is not a safe positive integer number of cents, or that
 *     lacks plan/source provenance, blocks acceptance.
 */
export function resolveAcceptanceUnitCost(
  cost: DropshipProductCost | undefined,
): AcceptanceUnitCostResolution {
  if (!cost || cost.status !== "available") {
    const issue = cost?.issue ?? "variant_unmapped";
    return {
      ok: false,
      code: "DROPSHIP_ORDER_PRODUCT_COST_UNAVAILABLE",
      message: `Dropship order acceptance requires an available .ops product cost (${issue}).`,
      retryable: issue === "source_read_failed",
      issue,
    };
  }
  const { unitCostCents, planId, source, overrideId } = cost;
  if (typeof unitCostCents !== "number" || !Number.isSafeInteger(unitCostCents) || unitCostCents < 0
    || typeof planId !== "string" || planId.length === 0 || source === null) {
    return {
      ok: false,
      code: "DROPSHIP_ORDER_PRODUCT_COST_INVALID",
      message: "Dropship order acceptance received a product cost without valid cents or provenance.",
      retryable: false,
      issue: null,
    };
  }
  if (unitCostCents === 0) {
    return {
      ok: false,
      code: "DROPSHIP_ORDER_PRODUCT_COST_ZERO",
      message: "Dropship order acceptance refuses a zero product cost; a free-goods debit needs an explicit product decision.",
      retryable: false,
      issue: null,
    };
  }
  return {
    ok: true,
    unitCostCents,
    // The schedule fields are settled once the line is charged (see decideChargedUnitCost).
    evidence: {
      source, planId, overrideId: overrideId ?? null,
      liveUnitCostCents: unitCostCents, scheduleEntryId: null, costPolicyId: null, priceProtected: false,
    },
  };
}

export interface AcceptanceCostEvidenceLine {
  productVariantId: number;
  quantity: number;
  catalogRetailPriceCents: number;
  wholesaleUnitCostCents: number;
  productCostEvidence: DropshipAcceptanceProductCostEvidence;
}

/**
 * Content hash of every cost input that produced the debit. The `.ops` source
 * tables carry no revision column, so this hash is the freezable "revision" of
 * the cost decision (same pattern as listing rule pricing). The live cost and
 * the schedule entry charged are inputs too: a protected debit is only
 * explained by both. Line order does not affect the hash.
 */
export function buildAcceptanceCostEvidenceHash(input: {
  vendorId: number;
  lines: readonly AcceptanceCostEvidenceLine[];
}): string {
  const canonical = {
    authority: ACCEPTANCE_COST_AUTHORITY,
    vendorId: input.vendorId,
    lines: [...input.lines]
      .map((line) => ({
        productVariantId: line.productVariantId,
        quantity: line.quantity,
        catalogRetailPriceCents: line.catalogRetailPriceCents,
        wholesaleUnitCostCents: line.wholesaleUnitCostCents,
        source: line.productCostEvidence.source,
        planId: line.productCostEvidence.planId,
        overrideId: line.productCostEvidence.overrideId,
        liveUnitCostCents: line.productCostEvidence.liveUnitCostCents,
        scheduleEntryId: line.productCostEvidence.scheduleEntryId,
      }))
      .sort((left, right) => left.productVariantId - right.productVariantId || left.quantity - right.quantity),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
