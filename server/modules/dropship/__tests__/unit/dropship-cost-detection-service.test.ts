import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DROPSHIP_COST_CHANGE_POLICY, type DropshipCostChangePolicySettings } from "../../../../../shared/dropship/cost-change-policy";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  COST_CHANGE_LOG_PAGE_LIMIT,
  COST_DETECTION_PENDING_LIMIT,
  COST_READER_BATCH_SIZE,
  DEFAULT_COST_DETECTION_VENDORS_PER_TICK,
  DropshipCostDetectionService,
  emptyEventCounts,
  isPassDue,
  isPassInProgress,
  type CostDetectionVendorCounts,
  type CostScheduleEventCounts,
  type CostScheduleVendorTransaction,
  type CostScheduleWriteInput,
  type DropshipCostChangeLogView,
  type DropshipCostDetectionState,
  type DropshipCostScheduleChangeView,
  type DropshipCostScheduleRepository,
  type StoredCostScheduleEntry,
} from "../../application/dropship-cost-detection-service";
import type { CostReadingEvidence } from "../../domain/cost-schedule";

const NOW = new Date("2026-09-28T16:05:00.000Z");
/** Fourteen full days after NOW, rounded up to midnight UTC (the default notice). */
const IN_TWO_WEEKS = new Date("2026-10-13T00:00:00.000Z");

const planPercent: CostReadingEvidence = { source: "plan_percent", planId: "ops", overrideId: null, retailPriceCents: 899, discountBps: 1000 };

function available(unitCostCents: number, evidence: CostReadingEvidence = planPercent): DropshipProductCost {
  return {
    status: "available", unitCostCents, planId: evidence.planId, source: evidence.source as DropshipProductCost["source"],
    overrideId: evidence.overrideId, issue: null, retailPriceCents: evidence.retailPriceCents, discountBps: evidence.discountBps,
  };
}

const unavailable = (issue: DropshipProductCost["issue"]): DropshipProductCost => ({
  status: "unavailable", unitCostCents: null, planId: null, source: null, overrideId: null, issue, retailPriceCents: null, discountBps: null,
});

function storedEntry(entryId: number, unitCostCents: number, effectiveAt: Date, patch: Partial<StoredCostScheduleEntry> = {}): StoredCostScheduleEntry {
  return {
    entryId, unitCostCents, effectiveAt, kind: "baseline", fromCents: null, evidence: planPercent,
    observedAt: new Date("2026-09-01T00:00:00.000Z"), policyId: 1, recordedBy: "detection", ...patch,
  };
}

function idleState(patch: Partial<DropshipCostDetectionState> = {}): DropshipCostDetectionState {
  return {
    passNumber: 0, passStartedAt: null, passCompletedAt: null, cursorVendorId: null, policyId: null,
    passVendorsProcessed: 0, passVariantsRead: 0, passUnavailableReadings: 0, passChangesRecorded: 0, lastTickAt: null, ...patch,
  };
}

/**
 * An in-memory repository with the same contract as the PG one: a state row,
 * vendors with tracked variants, entries per vendor and variant, live costs
 * per vendor, and a record of every write and every cursor move.
 */
class FakeRepository implements DropshipCostScheduleRepository {
  state = idleState();
  vendors = new Map<number, { variantIds: number[]; costs: Map<number, DropshipProductCost>; entries: Map<number, StoredCostScheduleEntry[]> }>();
  writes: CostScheduleWriteInput[] = [];
  cursorMoves: Array<{ vendorId: number; counts: CostDetectionVendorCounts; now: Date }> = [];
  readBatches: number[][] = [];
  transactions: Array<{ vendorId: number; committed: boolean }> = [];
  pending: DropshipCostScheduleChangeView[] = [];
  log: DropshipCostChangeLogView[] = [];
  logQueries: Array<{ limit: number; beforeId: number | null }> = [];
  ticks: Date[] = [];
  failWriteFor: number | null = null;

  vendor(vendorId: number, input: { variantIds: number[]; costs?: Record<number, DropshipProductCost>; entries?: Record<number, StoredCostScheduleEntry[]> }) {
    this.vendors.set(vendorId, {
      variantIds: input.variantIds,
      costs: new Map(Object.entries(input.costs ?? {}).map(([id, cost]) => [Number(id), cost])),
      entries: new Map(Object.entries(input.entries ?? {}).map(([id, list]) => [Number(id), list])),
    });
  }

  async readDetectionState() { return { ...this.state }; }
  async startPass(input: { now: Date; policyId: number | null }) {
    this.state = {
      ...this.state, passNumber: this.state.passNumber + 1, passStartedAt: input.now, passCompletedAt: null, cursorVendorId: null,
      policyId: input.policyId, passVendorsProcessed: 0, passVariantsRead: 0, passUnavailableReadings: 0, passChangesRecorded: 0,
    };
    return { ...this.state };
  }
  async completePass(input: { now: Date }) {
    this.state = { ...this.state, passCompletedAt: input.now, cursorVendorId: null };
    return { ...this.state };
  }
  async recordTick(input: { now: Date }) { this.ticks.push(input.now); this.state = { ...this.state, lastTickAt: input.now }; }
  async listVendorsAfter(input: { afterVendorId: number | null; limit: number }) {
    return [...this.vendors.keys()].sort((a, b) => a - b)
      .filter((id) => input.afterVendorId === null || id > input.afterVendorId).slice(0, input.limit);
  }
  async withVendorSchedule<T>(vendorId: number, work: (transaction: CostScheduleVendorTransaction) => Promise<T>): Promise<T> {
    const vendor = this.vendors.get(vendorId);
    if (!vendor) throw new Error(`unknown vendor ${vendorId}`);
    const record = { vendorId, committed: false };
    this.transactions.push(record);
    const repository = this;
    const result = await work({
      async listTrackedVariantIds() { return [...vendor.variantIds]; },
      async loadEntries(ids) { return new Map([...vendor.entries].filter(([id]) => ids.includes(id))); },
      async readLiveCosts(ids) {
        repository.readBatches.push([...ids]);
        return new Map([...ids].flatMap((id) => { const cost = vendor.costs.get(id); return cost ? [[id, cost] as const] : []; }));
      },
      async writeReconciliation(input) {
        if (repository.failWriteFor === vendorId) throw new Error("write failed");
        repository.writes.push(input);
        const entryIdsByVariant = new Map<number, number>();
        const counts: CostScheduleEventCounts = emptyEventCounts();
        for (const variant of input.variants) {
          for (const operation of variant.operations) {
            if (operation.kind === "baseline" || operation.kind === "add") entryIdsByVariant.set(variant.productVariantId, 1000 + variant.productVariantId);
            if (operation.kind === "baseline") counts.baseline += 1;
            else if (operation.kind === "withdraw") counts.change_withdrawn += 1;
            else if (operation.kind === "reduce") counts.increase_reduced += 1;
            else if (operation.effectiveAt.getTime() <= input.observedAt.getTime()) counts[`${operation.direction}_applied`] += 1;
            else counts[`${operation.direction}_announced`] += 1;
          }
        }
        return { counts, entryIdsByVariant };
      },
      async advanceCursor(input) {
        repository.cursorMoves.push(input);
        repository.state = {
          ...repository.state, cursorVendorId: input.vendorId,
          passVendorsProcessed: repository.state.passVendorsProcessed + 1,
          passVariantsRead: repository.state.passVariantsRead + input.counts.variantsRead,
          passUnavailableReadings: repository.state.passUnavailableReadings + input.counts.unavailableReadings,
          passChangesRecorded: repository.state.passChangesRecorded + input.counts.changesRecorded,
        };
      },
    });
    record.committed = true;
    return result;
  }
  async listPendingChanges(input: { now: Date; limit: number }) { return this.pending.slice(0, input.limit); }
  async listChangeLog(input: { limit: number; beforeId: number | null }) {
    this.logQueries.push(input);
    return this.log.filter((row) => input.beforeId === null || row.logId < input.beforeId).slice(0, input.limit);
  }
}

describe("DropshipCostDetectionService", () => {
  let repository: FakeRepository;
  let logs: Array<DropshipLogEvent & { level: string }>;
  let settings: DropshipCostChangePolicySettings;
  let clock: { now: () => Date };
  let service: DropshipCostDetectionService;

  beforeEach(() => {
    repository = new FakeRepository();
    logs = [];
    settings = { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY };
    clock = { now: () => NOW };
    service = new DropshipCostDetectionService({
      repository,
      policy: { resolvePolicy: async () => ({ policyId: 3, settings }) },
      clock,
      logger: {
        info: (event) => logs.push({ ...event, level: "info" }),
        warn: (event) => logs.push({ ...event, level: "warn" }),
        error: (event) => logs.push({ ...event, level: "error" }),
      },
      workerEnabled: true,
    });
  });

  describe("runTick", () => {
    it("starts the first pass, baselines every listed variant of every vendor, and completes in one tick", async () => {
      repository.vendor(5, { variantIds: [66, 67], costs: { 66: available(809), 67: available(1299) } });
      repository.vendor(9, { variantIds: [66], costs: { 66: available(709) } });

      const result = await service.runTick({ workerId: "w-1" });

      expect(result).toEqual({
        outcome: "completed", passNumber: 1, vendorsProcessed: 2, variantsRead: 3, unavailableReadings: 0, changesRecorded: 3,
        events: { ...emptyEventCounts(), baseline: 3 }, sourceReadFailures: 0,
      });
      expect(repository.writes.map((write) => [write.vendorId, write.policyId, write.observedAt, write.recordedBy]))
        .toEqual([[5, 3, NOW, "detection"], [9, 3, NOW, "detection"]]);
      expect(repository.writes[0]?.variants.map((variant) => [variant.productVariantId, variant.retailDriven, variant.operations]))
        .toEqual([
          [66, false, [{ kind: "baseline", unitCostCents: 809, effectiveAt: NOW }]],
          [67, false, [{ kind: "baseline", unitCostCents: 1299, effectiveAt: NOW }]],
        ]);
      expect(repository.writes[0]?.variants[0]?.evidence).toEqual(planPercent);
      expect(repository.cursorMoves.map((move) => [move.vendorId, move.counts])).toEqual([
        [5, { variantsRead: 2, unavailableReadings: 0, changesRecorded: 2 }],
        [9, { variantsRead: 1, unavailableReadings: 0, changesRecorded: 1 }],
      ]);
      expect(repository.state).toMatchObject({ passNumber: 1, passStartedAt: NOW, passCompletedAt: NOW, cursorVendorId: null, policyId: 3 });
      expect(repository.ticks).toEqual([NOW]);
      expect(logs.map((log) => log.code)).toEqual([
        "DROPSHIP_COST_DETECTION_PASS_STARTED",
        "DROPSHIP_COST_DETECTION_VENDOR_RECONCILED",
        "DROPSHIP_COST_DETECTION_VENDOR_RECONCILED",
        "DROPSHIP_COST_DETECTION_PASS_COMPLETED",
      ]);
    });

    it("does nothing between passes until the policy's interval has elapsed since the last one began", async () => {
      repository.vendor(5, { variantIds: [66], costs: { 66: available(809) } });
      repository.state = idleState({ passNumber: 4, passStartedAt: new Date("2026-09-28T15:30:00.000Z"), passCompletedAt: new Date("2026-09-28T15:31:00.000Z") });
      settings.detectionIntervalMinutes = 60;

      const notDue = await service.runTick({ workerId: "w-1" });
      expect(notDue).toMatchObject({ outcome: "not_due", passNumber: 4, vendorsProcessed: 0 });
      expect(repository.writes).toEqual([]);
      expect(repository.ticks).toEqual([NOW]);

      clock.now = () => new Date("2026-09-28T16:30:00.000Z");
      const due = await service.runTick({ workerId: "w-1" });
      expect(due).toMatchObject({ outcome: "completed", passNumber: 5, vendorsProcessed: 1 });
    });

    it("spans ticks with the cursor, so a pass reaches every vendor even when a tick is bounded", async () => {
      for (const vendorId of [2, 4, 6, 8, 10]) repository.vendor(vendorId, { variantIds: [66], costs: { 66: available(809) } });

      const first = await service.runTick({ workerId: "w-1", vendorsPerTick: 2 });
      expect(first).toMatchObject({ outcome: "progressed", passNumber: 1, vendorsProcessed: 2 });
      expect(repository.state.cursorVendorId).toBe(4);

      const second = await service.runTick({ workerId: "w-1", vendorsPerTick: 2 });
      expect(second).toMatchObject({ outcome: "progressed", vendorsProcessed: 2 });
      expect(repository.state.cursorVendorId).toBe(8);

      // A pass under way continues even though the interval has not elapsed.
      const third = await service.runTick({ workerId: "w-1", vendorsPerTick: 2 });
      expect(third).toMatchObject({ outcome: "completed", vendorsProcessed: 1 });
      expect(repository.state).toMatchObject({ passNumber: 1, cursorVendorId: null, passVendorsProcessed: 5 });
      expect(repository.cursorMoves.map((move) => move.vendorId)).toEqual([2, 4, 6, 8, 10]);
    });

    it("announces an increase with the policy's notice and records the reading behind it", async () => {
      repository.vendor(5, {
        variantIds: [66],
        entries: { 66: [storedEntry(1, 809, new Date("2026-09-01T00:00:00.000Z"))] },
        costs: { 66: available(999, { ...planPercent, discountBps: 500 }) },
      });

      const result = await service.runTick({ workerId: "w-1" });

      expect(result.events).toEqual({ ...emptyEventCounts(), increase_announced: 1 });
      expect(repository.writes[0]?.variants).toEqual([{
        productVariantId: 66,
        evidence: { ...planPercent, discountBps: 500 },
        retailDriven: false,
        operations: [{ kind: "add", direction: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS }],
      }]);
    });

    it("applies a retail-only move at once when the policy gives retail moves no notice, judged against the entry in force", async () => {
      settings.retailChangesGetNotice = false;
      repository.vendor(5, {
        variantIds: [66, 67],
        entries: {
          // 66: the same plan percentage, a higher retail price.
          66: [storedEntry(1, 809, new Date("2026-09-01T00:00:00.000Z"))],
          // 67: the retail price moved, but so did the plan percentage: not a retail-only move.
          67: [storedEntry(2, 809, new Date("2026-09-01T00:00:00.000Z"))],
        },
        costs: {
          66: available(899, { ...planPercent, retailPriceCents: 999 }),
          67: available(949, { ...planPercent, retailPriceCents: 999, discountBps: 500 }),
        },
      });

      const result = await service.runTick({ workerId: "w-1" });

      expect(result.events).toEqual({ ...emptyEventCounts(), increase_applied: 1, increase_announced: 1 });
      const [retailMove, planChange] = repository.writes[0]!.variants;
      expect(retailMove).toMatchObject({ productVariantId: 66, retailDriven: true });
      expect(retailMove?.operations).toEqual([{ kind: "add", direction: "increase", fromCents: 809, unitCostCents: 899, effectiveAt: NOW }]);
      expect(planChange).toMatchObject({ productVariantId: 67, retailDriven: false });
      expect(planChange?.operations).toEqual([{ kind: "add", direction: "increase", fromCents: 809, unitCostCents: 949, effectiveAt: IN_TWO_WEEKS }]);
    });

    it("judges a retail move against the entry in force, not against an announced one", async () => {
      settings.retailChangesGetNotice = false;
      const inForce = storedEntry(1, 809, new Date("2026-09-01T00:00:00.000Z"));
      // An announced plan-percentage increase carries the evidence of its own reading.
      const announced = storedEntry(2, 899, IN_TWO_WEEKS, { kind: "increase", fromCents: 809, evidence: { ...planPercent, discountBps: 0 } });
      repository.vendor(5, {
        variantIds: [66],
        entries: { 66: [inForce, announced] },
        // Retail moved under the NEW percentage: compared with the entry in force, the discount differs too.
        costs: { 66: available(999, { ...planPercent, discountBps: 0, retailPriceCents: 999 }) },
      });

      const result = await service.runTick({ workerId: "w-1" });

      expect(result.events).toEqual({ ...emptyEventCounts(), increase_announced: 1 });
      expect(repository.writes[0]?.variants[0]).toMatchObject({ retailDriven: false });
      expect(repository.writes[0]?.variants[0]?.operations).toEqual([
        { kind: "add", direction: "increase", fromCents: 899, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS },
      ]);
    });

    it("writes nothing for a variant whose schedule already matches the live cost", async () => {
      repository.vendor(5, {
        variantIds: [66],
        entries: { 66: [storedEntry(1, 809, new Date("2026-09-01T00:00:00.000Z"))] },
        costs: { 66: available(809) },
      });

      const result = await service.runTick({ workerId: "w-1" });

      expect(result.changesRecorded).toBe(0);
      expect(repository.writes).toEqual([]);
      expect(repository.cursorMoves).toEqual([{ vendorId: 5, counts: { variantsRead: 1, unavailableReadings: 0, changesRecorded: 0 }, now: NOW }]);
      expect(logs.map((log) => log.code)).not.toContain("DROPSHIP_COST_DETECTION_VENDOR_RECONCILED");
    });

    it("records nothing for an unavailable or zero reading, counts it, and warns only when the source itself failed", async () => {
      repository.vendor(5, {
        variantIds: [66, 67, 68, 69],
        costs: { 66: unavailable("entitlement_inactive"), 67: unavailable("source_read_failed"), 68: available(0) },
      });

      const result = await service.runTick({ workerId: "w-1" });

      expect(result).toMatchObject({ vendorsProcessed: 1, variantsRead: 4, unavailableReadings: 4, changesRecorded: 0, sourceReadFailures: 1 });
      expect(repository.writes).toEqual([]);
      const warning = logs.find((log) => log.level === "warn");
      expect(warning).toMatchObject({ code: "DROPSHIP_COST_DETECTION_SOURCE_READ_FAILED", context: { vendorId: 5, classification: "transient" } });
      expect(logs.find((log) => log.code === "DROPSHIP_COST_DETECTION_VENDOR_RECONCILED")?.context).toMatchObject({
        unavailableByIssue: { entitlement_inactive: 1, source_read_failed: 1, missing: 1, zero_cost: 1 },
      });
    });

    it("reads live costs in batches the cost reader accepts", async () => {
      const variantIds = Array.from({ length: COST_READER_BATCH_SIZE + 1 }, (_, index) => index + 1);
      repository.vendor(5, { variantIds, costs: Object.fromEntries(variantIds.map((id) => [id, available(809)])) });

      await service.runTick({ workerId: "w-1" });

      expect(repository.readBatches.map((batch) => batch.length)).toEqual([COST_READER_BATCH_SIZE, 1]);
      expect(repository.writes[0]?.variants).toHaveLength(COST_READER_BATCH_SIZE + 1);
    });

    it("lets a vendor's failure surface, so the tick is retried rather than the vendor skipped", async () => {
      repository.vendor(5, { variantIds: [66], costs: { 66: available(809) } });
      repository.vendor(9, { variantIds: [66], costs: { 66: available(809) } });
      repository.failWriteFor = 5;

      await expect(service.runTick({ workerId: "w-1" })).rejects.toThrow("write failed");
      expect(repository.transactions).toEqual([{ vendorId: 5, committed: false }]);
      expect(repository.cursorMoves).toEqual([]);
    });

    it("refuses an invalid tick input and an out-of-range policy interval", async () => {
      await expect(service.runTick({ workerId: "" })).rejects.toMatchObject({ code: "DROPSHIP_COST_DETECTION_INVALID_INPUT" });
      await expect(service.runTick({ workerId: "w-1", vendorsPerTick: 0 })).rejects.toMatchObject({ code: "DROPSHIP_COST_DETECTION_INVALID_INPUT" });
      await expect(service.runTick({ workerId: "w-1", surprise: true })).rejects.toMatchObject({ code: "DROPSHIP_COST_DETECTION_INVALID_INPUT" });
      settings.detectionIntervalMinutes = 5;
      await expect(service.runTick({ workerId: "w-1" })).rejects.toMatchObject({
        code: "DROPSHIP_COST_DETECTION_INTERVAL_INVALID", context: { classification: "fatal" },
      });
      expect(repository.ticks).toEqual([]);
    });

    it("uses the default vendors per tick when none is given", async () => {
      for (let vendorId = 1; vendorId <= DEFAULT_COST_DETECTION_VENDORS_PER_TICK + 1; vendorId += 1) {
        repository.vendor(vendorId, { variantIds: [], costs: {} });
      }
      const result = await service.runTick({ workerId: "w-1" });
      expect(result).toMatchObject({ outcome: "progressed", vendorsProcessed: DEFAULT_COST_DETECTION_VENDORS_PER_TICK });
    });
  });

  describe("getOverview and listChangeLog", () => {
    it("reports the worker switch, the state and the announced changes, bounded", async () => {
      repository.state = idleState({ passNumber: 2, passStartedAt: NOW, passCompletedAt: NOW });
      repository.pending = Array.from({ length: COST_DETECTION_PENDING_LIMIT + 5 }, (_, index) => pendingView(index + 1));

      const overview = await service.getOverview();

      expect(overview).toMatchObject({ workerEnabled: true, state: { passNumber: 2 }, pendingLimit: COST_DETECTION_PENDING_LIMIT, generatedAt: NOW });
      expect(overview.pending).toHaveLength(COST_DETECTION_PENDING_LIMIT);
    });

    it("pages the change log newest first with a cursor, one row beyond the page deciding whether more exist", async () => {
      repository.log = Array.from({ length: 7 }, (_, index) => logView(7 - index));

      const first = await service.listChangeLog({ limit: 3 });
      expect(first.items.map((row) => row.logId)).toEqual([7, 6, 5]);
      expect(first.nextBeforeId).toBe(5);
      expect(repository.logQueries).toEqual([{ limit: 4, beforeId: null }]);

      const second = await service.listChangeLog({ limit: 3, beforeId: first.nextBeforeId });
      expect(second.items.map((row) => row.logId)).toEqual([4, 3, 2]);
      expect(second.nextBeforeId).toBe(2);

      const last = await service.listChangeLog({ limit: 3, beforeId: second.nextBeforeId });
      expect(last.items.map((row) => row.logId)).toEqual([1]);
      expect(last.nextBeforeId).toBeNull();
    });

    it("bounds the page size to the service's ceiling and refuses a bad cursor", async () => {
      await expect(service.listChangeLog({ limit: COST_CHANGE_LOG_PAGE_LIMIT + 1 })).rejects.toMatchObject({ code: "DROPSHIP_COST_DETECTION_INVALID_INPUT" });
      await expect(service.listChangeLog({ beforeId: 0 })).rejects.toMatchObject({ code: "DROPSHIP_COST_DETECTION_INVALID_INPUT" });
      await expect(service.listChangeLog({ beforeId: "7" })).rejects.toMatchObject({ code: "DROPSHIP_COST_DETECTION_INVALID_INPUT" });
      await service.listChangeLog({});
      expect(repository.logQueries).toEqual([{ limit: COST_CHANGE_LOG_PAGE_LIMIT + 1, beforeId: null }]);
    });
  });

  describe("pass timing rules", () => {
    it("knows when a pass is under way and when the next is due", () => {
      expect(isPassInProgress(idleState())).toBe(false);
      expect(isPassInProgress(idleState({ passStartedAt: NOW }))).toBe(true);
      expect(isPassInProgress(idleState({ passStartedAt: NOW, passCompletedAt: new Date(NOW.getTime() + 1) }))).toBe(false);
      expect(isPassInProgress(idleState({ passStartedAt: NOW, passCompletedAt: new Date(NOW.getTime() - 1) }))).toBe(true);

      expect(isPassDue(idleState(), 60, NOW)).toBe(true);
      expect(isPassDue(idleState({ passStartedAt: new Date(NOW.getTime() - 60 * 60_000) }), 60, NOW)).toBe(true);
      expect(isPassDue(idleState({ passStartedAt: new Date(NOW.getTime() - 60 * 60_000 + 1) }), 60, NOW)).toBe(false);
      expect(() => isPassDue(idleState(), 14, NOW)).toThrow();
    });
  });
});

function pendingView(entryId: number): DropshipCostScheduleChangeView {
  return {
    entryId, vendorId: 5, vendorBusinessName: "Shellz Vendor", productVariantId: 66, variantSku: "ARM-ENV-SGL-P50",
    variantName: "Single pack", productName: "Armor Envelope", kind: "increase", fromCents: 809, unitCostCents: 999,
    effectiveAt: IN_TWO_WEEKS, observedAt: NOW, policyId: 3, costSource: "plan_percent", recordedBy: "detection",
  };
}

function logView(logId: number): DropshipCostChangeLogView {
  return {
    logId, entryId: logId, vendorId: 5, vendorBusinessName: "Shellz Vendor", productVariantId: 66, variantSku: "ARM-ENV-SGL-P50",
    variantName: "Single pack", productName: "Armor Envelope", eventType: "increase_announced", fromCents: 809, toCents: 999,
    effectiveAt: IN_TWO_WEEKS, retailDriven: false, observedAt: NOW, policyId: 3, costSource: "plan_percent", recordedBy: "detection",
    noticeDecision: null, createdAt: NOW,
  };
}
