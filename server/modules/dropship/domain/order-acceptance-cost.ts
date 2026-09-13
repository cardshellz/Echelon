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
    evidence: { source, planId, overrideId: overrideId ?? null },
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
 * the cost decision (same pattern as listing rule pricing). Line order does not
 * affect the hash.
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
      }))
      .sort((left, right) => left.productVariantId - right.productVariantId || left.quantity - right.quantity),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
