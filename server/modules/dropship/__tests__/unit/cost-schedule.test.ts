import { describe, expect, it } from "vitest";
import {
  CostScheduleError,
  announcedEffectiveAt,
  costInForce,
  costScheduleEventType,
  entryInForce,
  isRetailDrivenReading,
  reconcileCostSchedule,
  type CostReadingEvidence,
  type CostScheduleEntry,
  type CostScheduleTiming,
} from "../../domain/cost-schedule";

const NOW = new Date("2026-09-27T16:05:00.000Z");
/** Fourteen full days after NOW, rounded up to midnight UTC. */
const IN_TWO_WEEKS = new Date("2026-10-12T00:00:00.000Z");
const TIMING: CostScheduleTiming = { increaseNoticeDays: 14, decreaseTiming: "immediate", retailChangesGetNotice: true };

function entry(entryId: number, unitCostCents: number, effectiveAt: string): CostScheduleEntry {
  return { entryId, unitCostCents, effectiveAt: new Date(effectiveAt) };
}

function reconcile(entries: CostScheduleEntry[], liveCents: number, options: {
  timing?: Partial<CostScheduleTiming>; retailDriven?: boolean; at?: Date;
} = {}) {
  return reconcileCostSchedule({
    entries,
    reading: { unitCostCents: liveCents, observedAt: options.at ?? NOW, retailDriven: options.retailDriven ?? false },
    timing: { ...TIMING, ...options.timing },
  });
}

const BASELINE = entry(1, 809, "2026-09-01T00:00:00.000Z");

describe("costInForce", () => {
  it("is the latest entry already in effect, and ignores announced ones", () => {
    const entries = [entry(3, 999, "2026-10-12T00:00:00.000Z"), BASELINE, entry(2, 899, "2026-09-20T00:00:00.000Z")];
    expect(costInForce(entries, NOW)).toBe(899);
    expect(costInForce(entries, new Date("2026-10-12T00:00:00.000Z"))).toBe(999);
    expect(costInForce([], NOW)).toBeNull();
  });

  it("uses the first entry for a reading a moment before the schedule began", () => {
    expect(costInForce([BASELINE], new Date("2026-08-31T23:59:59.999Z"))).toBe(809);
  });

  it("returns the entry itself, with whatever the caller stored on it", () => {
    const stored = [{ ...BASELINE, note: "first" }, { ...entry(2, 899, "2026-09-20T00:00:00.000Z"), note: "second" }];
    expect(entryInForce(stored, NOW)?.note).toBe("second");
    expect(entryInForce([], NOW)).toBeNull();
    expect(() => entryInForce(stored, new Date(Number.NaN))).toThrow(CostScheduleError);
  });
});

describe("isRetailDrivenReading", () => {
  const planPercent: CostReadingEvidence = {
    source: "plan_percent", planId: "ops", overrideId: null, retailPriceCents: 899, discountBps: 1000,
  };

  it("is true only when the same retail-based cost moved with the retail price alone", () => {
    expect(isRetailDrivenReading(planPercent, { ...planPercent, retailPriceCents: 999 })).toBe(true);
    expect(isRetailDrivenReading(
      { ...planPercent, source: "variant_percent", overrideId: "o-1" },
      { ...planPercent, source: "variant_percent", overrideId: "o-1", retailPriceCents: 999 },
    )).toBe(true);
    expect(isRetailDrivenReading(
      { ...planPercent, source: "retail", discountBps: 0 },
      { ...planPercent, source: "retail", discountBps: 0, retailPriceCents: 999 },
    )).toBe(true);
  });

  it("is false for a plan switch, a changed discount, a new or changed override, a fixed price, or no retail move", () => {
    expect(isRetailDrivenReading(planPercent, { ...planPercent, retailPriceCents: 999, planId: "ops-plus" })).toBe(false);
    expect(isRetailDrivenReading(planPercent, { ...planPercent, retailPriceCents: 999, discountBps: 1500 })).toBe(false);
    expect(isRetailDrivenReading(planPercent, { ...planPercent, source: "variant_percent", overrideId: "o-1", retailPriceCents: 999 })).toBe(false);
    expect(isRetailDrivenReading(
      { ...planPercent, source: "variant_percent", overrideId: "o-1" },
      { ...planPercent, source: "variant_percent", overrideId: "o-2", retailPriceCents: 999 },
    )).toBe(false);
    const fixed: CostReadingEvidence = { source: "variant_fixed_price", planId: "ops", overrideId: "o-1", retailPriceCents: null, discountBps: null };
    expect(isRetailDrivenReading(fixed, { ...fixed })).toBe(false);
    expect(isRetailDrivenReading(fixed, planPercent)).toBe(false);
    expect(isRetailDrivenReading(planPercent, fixed)).toBe(false);
    expect(isRetailDrivenReading(planPercent, { ...planPercent })).toBe(false);
  });
});

describe("costScheduleEventType", () => {
  it("names each operation for the change log, announced or applied by its date", () => {
    expect(costScheduleEventType({ kind: "baseline", unitCostCents: 809, effectiveAt: NOW }, NOW)).toBe("baseline");
    expect(costScheduleEventType({ kind: "add", direction: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS }, NOW))
      .toBe("increase_announced");
    expect(costScheduleEventType({ kind: "add", direction: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: NOW }, NOW))
      .toBe("increase_applied");
    expect(costScheduleEventType({ kind: "add", direction: "decrease", fromCents: 809, unitCostCents: 699, effectiveAt: IN_TWO_WEEKS }, NOW))
      .toBe("decrease_announced");
    expect(costScheduleEventType({ kind: "add", direction: "decrease", fromCents: 809, unitCostCents: 699, effectiveAt: NOW }, NOW))
      .toBe("decrease_applied");
    expect(costScheduleEventType({ kind: "reduce", entryId: 2, fromCents: 999, unitCostCents: 899, effectiveAt: IN_TWO_WEEKS }, NOW))
      .toBe("increase_reduced");
    expect(costScheduleEventType({ kind: "withdraw", entryId: 2, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS }, NOW))
      .toBe("change_withdrawn");
    expect(() => costScheduleEventType({ kind: "baseline", unitCostCents: 809, effectiveAt: NOW }, new Date(Number.NaN)))
      .toThrow(CostScheduleError);
  });
});

describe("announcedEffectiveAt", () => {
  it("gives the full notice and rounds up to the next midnight UTC", () => {
    expect(announcedEffectiveAt(NOW, 14)).toEqual(IN_TWO_WEEKS);
    expect(announcedEffectiveAt(new Date("2026-09-27T00:00:00.000Z"), 14)).toEqual(new Date("2026-10-11T00:00:00.000Z"));
    expect(announcedEffectiveAt(NOW, 1)).toEqual(new Date("2026-09-29T00:00:00.000Z"));
  });

  it("applies at once with no notice, and refuses a nonsensical notice", () => {
    expect(announcedEffectiveAt(NOW, 0)).toEqual(NOW);
    expect(() => announcedEffectiveAt(NOW, -1)).toThrow(CostScheduleError);
    expect(() => announcedEffectiveAt(NOW, 1.5)).toThrow(CostScheduleError);
  });
});

describe("reconcileCostSchedule", () => {
  it("starts a schedule from the first reading without calling it a change", () => {
    expect(reconcile([], 809)).toEqual({
      operations: [{ kind: "baseline", unitCostCents: 809, effectiveAt: NOW }],
      inForceBeforeCents: null,
      inForceAfterCents: 809,
    });
  });

  it("does nothing when the live cost is the cost in force and nothing is announced", () => {
    expect(reconcile([BASELINE], 809)).toEqual({ operations: [], inForceBeforeCents: 809, inForceAfterCents: 809 });
  });

  it("announces an increase and keeps charging the current cost until its date", () => {
    const result = reconcile([BASELINE], 999);
    expect(result.operations).toEqual([
      { kind: "add", direction: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS },
    ]);
    expect(result.inForceAfterCents).toBe(809);
  });

  it("does not announce the same increase twice", () => {
    const scheduled = [BASELINE, entry(2, 999, IN_TWO_WEEKS.toISOString())];
    expect(reconcile(scheduled, 999).operations).toEqual([]);
  });

  it("charges an increase at once when the policy gives no notice", () => {
    const result = reconcile([BASELINE], 999, { timing: { increaseNoticeDays: 0 } });
    expect(result.operations).toEqual([{ kind: "add", direction: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: NOW }]);
    expect(result.inForceAfterCents).toBe(999);
  });

  it("applies a decrease at once, and it withdraws an increase that was announced", () => {
    const scheduled = [BASELINE, entry(2, 999, IN_TWO_WEEKS.toISOString())];
    const result = reconcile(scheduled, 699);
    expect(result.operations).toEqual([
      { kind: "withdraw", entryId: 2, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS },
      { kind: "add", direction: "decrease", fromCents: 809, unitCostCents: 699, effectiveAt: NOW },
    ]);
    expect(result.inForceAfterCents).toBe(699);
  });

  it("gives a decrease the same notice when the policy says so", () => {
    const result = reconcile([BASELINE], 699, { timing: { decreaseTiming: "after_notice" } });
    expect(result.operations).toEqual([
      { kind: "add", direction: "decrease", fromCents: 809, unitCostCents: 699, effectiveAt: IN_TWO_WEEKS },
    ]);
    expect(result.inForceAfterCents).toBe(809);
  });

  it("withdraws an announced increase when the cost goes back", () => {
    const scheduled = [BASELINE, entry(2, 999, IN_TWO_WEEKS.toISOString())];
    expect(reconcile(scheduled, 809)).toEqual({
      operations: [{ kind: "withdraw", entryId: 2, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS }],
      inForceBeforeCents: 809,
      inForceAfterCents: 809,
    });
  });

  it("lowers an announced increase to the live cost and keeps its date", () => {
    const scheduled = [BASELINE, entry(2, 999, IN_TWO_WEEKS.toISOString())];
    expect(reconcile(scheduled, 899).operations).toEqual([
      { kind: "reduce", entryId: 2, fromCents: 999, unitCostCents: 899, effectiveAt: IN_TWO_WEEKS },
    ]);
  });

  it("keeps an earlier, smaller increase as announced and announces the new one after it", () => {
    const scheduled = [BASELINE, entry(2, 899, "2026-10-05T00:00:00.000Z")];
    expect(reconcile(scheduled, 999).operations).toEqual([
      { kind: "add", direction: "increase", fromCents: 899, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS },
    ]);
  });

  it("reduces the later of two increases, or withdraws it when the earlier one already reaches the live cost", () => {
    const two = [BASELINE, entry(2, 899, "2026-10-05T00:00:00.000Z"), entry(3, 1099, "2026-10-09T00:00:00.000Z")];
    expect(reconcile(two, 999).operations).toEqual([
      { kind: "reduce", entryId: 3, fromCents: 1099, unitCostCents: 999, effectiveAt: new Date("2026-10-09T00:00:00.000Z") },
    ]);
    expect(reconcile(two, 899).operations).toEqual([
      { kind: "withdraw", entryId: 3, unitCostCents: 1099, effectiveAt: new Date("2026-10-09T00:00:00.000Z") },
    ]);
  });

  it("withdraws an announced decrease when the live cost rises instead", () => {
    const scheduled = [BASELINE, entry(2, 699, "2026-10-05T00:00:00.000Z")];
    expect(reconcile(scheduled, 999, { timing: { decreaseTiming: "after_notice" } }).operations).toEqual([
      { kind: "withdraw", entryId: 2, unitCostCents: 699, effectiveAt: new Date("2026-10-05T00:00:00.000Z") },
      { kind: "add", direction: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS },
    ]);
  });

  it("applies a retail-driven increase at once only when the policy says so", () => {
    expect(reconcile([BASELINE], 999, { retailDriven: true }).inForceAfterCents).toBe(809);
    const immediate = reconcile([BASELINE, entry(2, 899, "2026-10-05T00:00:00.000Z")], 999,
      { retailDriven: true, timing: { retailChangesGetNotice: false } });
    expect(immediate.operations).toEqual([
      { kind: "withdraw", entryId: 2, unitCostCents: 899, effectiveAt: new Date("2026-10-05T00:00:00.000Z") },
      { kind: "add", direction: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: NOW },
    ]);
    expect(immediate.inForceAfterCents).toBe(999);
  });

  it("treats an announced increase whose date has passed as the cost in force", () => {
    const passed = [BASELINE, entry(2, 999, "2026-09-20T00:00:00.000Z")];
    expect(reconcile(passed, 999)).toEqual({ operations: [], inForceBeforeCents: 999, inForceAfterCents: 999 });
  });

  it("never withdraws the first entry when the reading is a moment before the schedule began", () => {
    const justAhead = new Date("2026-08-31T23:59:59.999Z");
    expect(reconcile([BASELINE], 809, { at: justAhead })).toEqual({ operations: [], inForceBeforeCents: 809, inForceAfterCents: 809 });
    expect(reconcile([BASELINE], 999, { at: justAhead }).operations).toEqual([
      { kind: "add", direction: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: announcedEffectiveAt(justAhead, 14) },
    ]);
  });

  it("orders unsorted entries by date before deciding", () => {
    const unsorted = [entry(3, 1099, "2026-10-09T00:00:00.000Z"), BASELINE, entry(2, 899, "2026-10-05T00:00:00.000Z")];
    expect(reconcile(unsorted, 999).operations).toEqual([
      { kind: "reduce", entryId: 3, fromCents: 1099, unitCostCents: 999, effectiveAt: new Date("2026-10-09T00:00:00.000Z") },
    ]);
  });

  it("refuses a zero, negative or fractional cost and an invalid time", () => {
    expect(() => reconcile([BASELINE], 0)).toThrow(CostScheduleError);
    expect(() => reconcile([BASELINE], -5)).toThrow(CostScheduleError);
    expect(() => reconcile([BASELINE], 8.5)).toThrow(CostScheduleError);
    expect(() => reconcile([{ ...BASELINE, unitCostCents: 0 }], 809)).toThrow(CostScheduleError);
    expect(() => reconcile([BASELINE], 809, { at: new Date(Number.NaN) })).toThrow(CostScheduleError);
  });
});
