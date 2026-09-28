import type { DropshipCostChangePolicySettings } from "../../../../shared/dropship/cost-change-policy";
import {
  entryInForce,
  isRetailDrivenReading,
  reconcileCostSchedule,
  type CostReadingEvidence,
  type CostScheduleTiming,
} from "../domain/cost-schedule";
import { DropshipError } from "../domain/errors";
import type { DropshipProductCost } from "./dropship-product-cost";
import type { CostScheduleVariantReconciliation, StoredCostScheduleEntry } from "./dropship-cost-detection-service";

/**
 * One reconciliation of live cost readings against stored schedules, shared
 * by the detection worker and order acceptance so both apply the same rules
 * to the same evidence. Pure: every input is given, nothing is read or written.
 */

export interface CostScheduleVariantOutcome {
  productVariantId: number;
  liveUnitCostCents: number;
  /** What an order accepted at `observedAt` is charged under price protection. */
  inForceAfterCents: number;
  /**
   * The entry that cost comes from: an existing entry's id, or "new" when the
   * reconciliation adds an entry that takes effect at once (a baseline, or an
   * immediate change). The writer resolves "new" to the inserted id.
   */
  inForceEntry: { kind: "existing"; entryId: number } | { kind: "new" };
  retailDriven: boolean;
}

export interface CostScheduleReconciliationPlan {
  /** Variants with at least one operation to write, in reading order. */
  writes: CostScheduleVariantReconciliation[];
  outcomes: ReadonlyMap<number, CostScheduleVariantOutcome>;
  /** Readings that recorded nothing, by issue ("missing" when the reader returned no entry, "zero_cost" for a zero cost). */
  unavailableByIssue: ReadonlyMap<string, number>;
}

export function costScheduleTimingFromPolicy(settings: DropshipCostChangePolicySettings): CostScheduleTiming {
  return {
    increaseNoticeDays: settings.increaseNoticeDays,
    decreaseTiming: settings.decreaseTiming,
    retailChangesGetNotice: settings.retailChangesGetNotice,
  };
}

export function planCostScheduleReconciliation(input: {
  productVariantIds: readonly number[];
  entriesByVariant: ReadonlyMap<number, readonly StoredCostScheduleEntry[]>;
  costs: ReadonlyMap<number, DropshipProductCost>;
  timing: CostScheduleTiming;
  observedAt: Date;
}): CostScheduleReconciliationPlan {
  const writes: CostScheduleVariantReconciliation[] = [];
  const outcomes = new Map<number, CostScheduleVariantOutcome>();
  const unavailableByIssue = new Map<string, number>();
  const countUnavailable = (issue: string) => unavailableByIssue.set(issue, (unavailableByIssue.get(issue) ?? 0) + 1);

  for (const productVariantId of input.productVariantIds) {
    const cost = input.costs.get(productVariantId);
    if (!cost || cost.status !== "available") {
      countUnavailable(cost?.issue ?? "missing");
      continue;
    }
    const { unitCostCents, evidence } = readingEvidence(cost, productVariantId);
    if (unitCostCents <= 0) {
      // A zero .ops cost is refused at acceptance (resolveAcceptanceUnitCost); the schedule never records it.
      countUnavailable("zero_cost");
      continue;
    }
    const entries = input.entriesByVariant.get(productVariantId) ?? [];
    const inForce = entryInForce(entries, input.observedAt);
    const retailDriven = inForce ? isRetailDrivenReading(inForce.evidence, evidence) : false;
    const reconciliation = reconcileCostSchedule({
      entries,
      reading: { unitCostCents, observedAt: input.observedAt, retailDriven },
      timing: input.timing,
    });
    if (reconciliation.operations.length > 0) {
      writes.push({ productVariantId, evidence, retailDriven, operations: reconciliation.operations });
    }
    const addsEntryEffectiveNow = reconciliation.operations.some((operation) =>
      (operation.kind === "baseline" || operation.kind === "add") && operation.effectiveAt.getTime() <= input.observedAt.getTime());
    if (!addsEntryEffectiveNow && !inForce) {
      // Unreachable by the domain's rules (an empty schedule always gets a baseline); refused rather than guessed.
      throw new DropshipError("DROPSHIP_COST_SCHEDULE_IN_FORCE_UNRESOLVED", "A reconciled schedule has no entry in force.",
        { classification: "fatal", productVariantId });
    }
    outcomes.set(productVariantId, {
      productVariantId,
      liveUnitCostCents: unitCostCents,
      inForceAfterCents: reconciliation.inForceAfterCents,
      inForceEntry: addsEntryEffectiveNow ? { kind: "new" } : { kind: "existing", entryId: inForce!.entryId },
      retailDriven,
    });
  }
  return { writes, outcomes, unavailableByIssue };
}

function readingEvidence(cost: DropshipProductCost, productVariantId: number): { unitCostCents: number; evidence: CostReadingEvidence } {
  if (cost.unitCostCents === null || cost.source === null || cost.planId === null) {
    throw new DropshipError("DROPSHIP_COST_DETECTION_READING_INVALID", "An available cost reading lacked its cost, source or plan.",
      { classification: "permanent", productVariantId });
  }
  return {
    unitCostCents: cost.unitCostCents,
    evidence: {
      source: cost.source,
      planId: cost.planId,
      overrideId: cost.overrideId,
      retailPriceCents: cost.retailPriceCents,
      discountBps: cost.discountBps,
    },
  };
}
