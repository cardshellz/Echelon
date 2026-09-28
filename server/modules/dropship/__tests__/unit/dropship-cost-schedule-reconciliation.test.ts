import { describe, expect, it } from "vitest";
import { DEFAULT_DROPSHIP_COST_CHANGE_POLICY } from "../../../../../shared/dropship/cost-change-policy";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import type { StoredCostScheduleEntry } from "../../application/dropship-cost-detection-service";
import { costScheduleTimingFromPolicy, planCostScheduleReconciliation } from "../../application/dropship-cost-schedule-reconciliation";
import type { CostReadingEvidence } from "../../domain/cost-schedule";

const NOW = new Date("2026-09-28T16:05:00.000Z");
const IN_TWO_WEEKS = new Date("2026-10-13T00:00:00.000Z");
const planPercent: CostReadingEvidence = { source: "plan_percent", planId: "ops", overrideId: null, retailPriceCents: 899, discountBps: 1000 };
const timing = costScheduleTimingFromPolicy(DEFAULT_DROPSHIP_COST_CHANGE_POLICY);

function available(unitCostCents: number, evidence: CostReadingEvidence = planPercent): DropshipProductCost {
  return {
    status: "available", unitCostCents, planId: evidence.planId, source: evidence.source as DropshipProductCost["source"],
    overrideId: evidence.overrideId, issue: null, retailPriceCents: evidence.retailPriceCents, discountBps: evidence.discountBps,
  };
}

function entry(entryId: number, unitCostCents: number, effectiveAt: Date, patch: Partial<StoredCostScheduleEntry> = {}): StoredCostScheduleEntry {
  return {
    entryId, unitCostCents, effectiveAt, kind: "baseline", fromCents: null, evidence: planPercent,
    observedAt: new Date("2026-09-01T00:00:00.000Z"), policyId: 1, recordedBy: "detection", ...patch,
  };
}

const baseline = entry(41, 809, new Date("2026-09-01T00:00:00.000Z"));

describe("planCostScheduleReconciliation", () => {
  it("takes the timing the policy sets", () => {
    expect(timing).toEqual({ increaseNoticeDays: 14, decreaseTiming: "immediate", retailChangesGetNotice: true });
  });

  it("starts a schedule from a first reading, charging the live cost from a new entry", () => {
    const plan = planCostScheduleReconciliation({
      productVariantIds: [66], entriesByVariant: new Map(), costs: new Map([[66, available(809)]]), timing, observedAt: NOW,
    });
    expect(plan.writes).toEqual([{ productVariantId: 66, evidence: planPercent, retailDriven: false,
      operations: [{ kind: "baseline", unitCostCents: 809, effectiveAt: NOW }] }]);
    expect(plan.outcomes.get(66)).toEqual({
      productVariantId: 66, liveUnitCostCents: 809, inForceAfterCents: 809, inForceEntry: { kind: "new" }, retailDriven: false,
    });
    expect(plan.unavailableByIssue.size).toBe(0);
  });

  it("keeps the entry in force while a higher live cost is announced, so an order is charged the old cost", () => {
    const plan = planCostScheduleReconciliation({
      productVariantIds: [66], entriesByVariant: new Map([[66, [baseline]]]),
      costs: new Map([[66, available(999, { ...planPercent, discountBps: 500 })]]), timing, observedAt: NOW,
    });
    expect(plan.writes[0]?.operations).toEqual([{ kind: "add", direction: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS }]);
    expect(plan.outcomes.get(66)).toMatchObject({ liveUnitCostCents: 999, inForceAfterCents: 809, inForceEntry: { kind: "existing", entryId: 41 }, retailDriven: false });
  });

  it("applies an immediate change at once from the new entry", () => {
    const plan = planCostScheduleReconciliation({
      productVariantIds: [66], entriesByVariant: new Map([[66, [baseline]]]),
      costs: new Map([[66, available(699)]]), timing, observedAt: NOW,
    });
    expect(plan.writes[0]?.operations).toEqual([{ kind: "add", direction: "decrease", fromCents: 809, unitCostCents: 699, effectiveAt: NOW }]);
    expect(plan.outcomes.get(66)).toMatchObject({ inForceAfterCents: 699, inForceEntry: { kind: "new" } });
  });

  it("writes nothing and charges the entry in force when the schedule already matches", () => {
    const plan = planCostScheduleReconciliation({
      productVariantIds: [66], entriesByVariant: new Map([[66, [baseline]]]), costs: new Map([[66, available(809)]]), timing, observedAt: NOW,
    });
    expect(plan.writes).toEqual([]);
    expect(plan.outcomes.get(66)).toMatchObject({ inForceAfterCents: 809, inForceEntry: { kind: "existing", entryId: 41 } });
  });

  it("judges a retail move against the entry in force, applying it at once only when the policy says so", () => {
    const retailMove = new Map([[66, available(899, { ...planPercent, retailPriceCents: 999 })]]);
    const withNotice = planCostScheduleReconciliation({
      productVariantIds: [66], entriesByVariant: new Map([[66, [baseline]]]), costs: retailMove, timing, observedAt: NOW,
    });
    expect(withNotice.outcomes.get(66)).toMatchObject({ retailDriven: true, inForceAfterCents: 809 });
    const atOnce = planCostScheduleReconciliation({
      productVariantIds: [66], entriesByVariant: new Map([[66, [baseline]]]), costs: retailMove,
      timing: { ...timing, retailChangesGetNotice: false }, observedAt: NOW,
    });
    expect(atOnce.outcomes.get(66)).toMatchObject({ retailDriven: true, inForceAfterCents: 899, inForceEntry: { kind: "new" } });
  });

  it("records nothing for unavailable, missing or zero readings and counts them by issue", () => {
    const plan = planCostScheduleReconciliation({
      productVariantIds: [1, 2, 3, 4],
      entriesByVariant: new Map(),
      costs: new Map<number, DropshipProductCost>([
        [1, { ...available(0), unitCostCents: 0 }],
        [2, { status: "unavailable", unitCostCents: null, planId: null, source: null, overrideId: null, issue: "source_read_failed", retailPriceCents: null, discountBps: null }],
        [4, available(809)],
      ]),
      timing, observedAt: NOW,
    });
    expect(plan.writes.map((write) => write.productVariantId)).toEqual([4]);
    expect([...plan.outcomes.keys()]).toEqual([4]);
    expect(Object.fromEntries(plan.unavailableByIssue)).toEqual({ zero_cost: 1, source_read_failed: 1, missing: 1 });
  });

  it("refuses an available reading that lacks its provenance", () => {
    expect(() => planCostScheduleReconciliation({
      productVariantIds: [66], entriesByVariant: new Map(),
      costs: new Map([[66, { ...available(809), planId: null }]]), timing, observedAt: NOW,
    })).toThrow(expect.objectContaining({ code: "DROPSHIP_COST_DETECTION_READING_INVALID" }));
  });
});
