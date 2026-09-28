import { z } from "zod";
import {
  MAX_DETECTION_INTERVAL_MINUTES,
  MIN_DETECTION_INTERVAL_MINUTES,
  type DropshipCostChangePolicySettings,
} from "../../../../shared/dropship/cost-change-policy";
import {
  entryInForce,
  isRetailDrivenReading,
  reconcileCostSchedule,
  type CostReadingEvidence,
  type CostScheduleEntry,
  type CostScheduleEventType,
  type CostScheduleOperation,
} from "../domain/cost-schedule";
import { DropshipError } from "../domain/errors";
import type { DropshipProductCost } from "./dropship-product-cost";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";

/**
 * Dropship .ops cost detection (docs/DROPSHIP-COST-CHANGE-CONTROLS.md, C2).
 *
 * A pass walks every active or paused vendor in id order. For each vendor,
 * inside one transaction under the vendor's schedule lock, the live cost of
 * every listed variant is read and reconciled with the vendor's cost schedule
 * (domain/cost-schedule.ts); every resulting operation is written to the
 * schedule and the change log. The pass keeps a cursor so it can span ticks
 * and resume after a restart, and a new pass starts once the policy's
 * detection interval has elapsed since the last one began.
 *
 * Nothing here decides money on its own: the rules live in the domain, the
 * dates come from the active policy, and the reading comes from the same
 * cost reader acceptance uses.
 */

/** Vendors processed per tick. Keeps a tick short so the worker lock and the log stay responsive. */
export const DEFAULT_COST_DETECTION_VENDORS_PER_TICK = 25;
/** The cost reader accepts at most this many variants per call (PgShellzClubProductCostAdapter). */
export const COST_READER_BATCH_SIZE = 10_000;
/** How many announced changes the admin view lists. */
export const COST_DETECTION_PENDING_LIMIT = 200;
/** How many change log rows one admin page lists. */
export const COST_CHANGE_LOG_PAGE_LIMIT = 50;

const MILLISECONDS_PER_MINUTE = 60_000;

/** Listings a vendor can be charged for, or is about to list. Never listed, or ended, carries no exposure. */
export const COST_TRACKED_LISTING_STATUSES: readonly string[] = Object.freeze([
  "preview_ready", "queued", "pushing", "active", "paused", "failed", "blocked", "drift_detected",
]);

/** Vendors whose costs are watched; the same set the listing tier reconcile reviews. */
export const COST_TRACKED_VENDOR_STATUSES: readonly string[] = Object.freeze(["active", "paused"]);

export interface StoredCostScheduleEntry extends CostScheduleEntry {
  kind: "baseline" | "increase" | "decrease";
  fromCents: number | null;
  evidence: CostReadingEvidence;
  observedAt: Date;
  policyId: number | null;
}

export interface DropshipCostDetectionState {
  passNumber: number;
  passStartedAt: Date | null;
  passCompletedAt: Date | null;
  cursorVendorId: number | null;
  policyId: number | null;
  passVendorsProcessed: number;
  passVariantsRead: number;
  passUnavailableReadings: number;
  passChangesRecorded: number;
  lastTickAt: Date | null;
}

export interface CostScheduleVariantReconciliation {
  productVariantId: number;
  evidence: CostReadingEvidence;
  retailDriven: boolean;
  operations: readonly CostScheduleOperation[];
}

export interface CostScheduleWriteInput {
  vendorId: number;
  observedAt: Date;
  policyId: number | null;
  variants: readonly CostScheduleVariantReconciliation[];
}

export type CostScheduleEventCounts = Record<CostScheduleEventType, number>;

export interface CostDetectionVendorCounts {
  variantsRead: number;
  unavailableReadings: number;
  changesRecorded: number;
}

/** What one vendor's reconciliation may do inside its transaction. */
export interface CostScheduleVendorTransaction {
  /** Distinct variants the vendor is listing, in id order. */
  listTrackedVariantIds(): Promise<number[]>;
  /** Non-withdrawn entries per variant. */
  loadEntries(productVariantIds: readonly number[]): Promise<ReadonlyMap<number, StoredCostScheduleEntry[]>>;
  /** Live costs through the shared cost reader, at most COST_READER_BATCH_SIZE at a time. */
  readLiveCosts(productVariantIds: readonly number[]): Promise<ReadonlyMap<number, DropshipProductCost>>;
  writeReconciliation(input: CostScheduleWriteInput): Promise<CostScheduleEventCounts>;
  /** Moves the pass cursor past this vendor and adds its counts, in the same transaction as its writes. */
  advanceCursor(input: { vendorId: number; counts: CostDetectionVendorCounts; now: Date }): Promise<void>;
}

export interface DropshipCostScheduleRepository {
  readDetectionState(): Promise<DropshipCostDetectionState>;
  startPass(input: { now: Date; policyId: number | null }): Promise<DropshipCostDetectionState>;
  completePass(input: { now: Date }): Promise<DropshipCostDetectionState>;
  recordTick(input: { now: Date }): Promise<void>;
  /** Vendors after the cursor in id order, at most `limit`. */
  listVendorsAfter(input: { afterVendorId: number | null; limit: number }): Promise<number[]>;
  /** Runs `work` in one transaction that holds the vendor's schedule lock. */
  withVendorSchedule<T>(vendorId: number, work: (transaction: CostScheduleVendorTransaction) => Promise<T>): Promise<T>;
  listPendingChanges(input: { now: Date; limit: number }): Promise<DropshipCostScheduleChangeView[]>;
  listChangeLog(input: { limit: number; beforeId: number | null }): Promise<DropshipCostChangeLogView[]>;
}

export interface DropshipCostChangePolicyReader {
  resolvePolicy(): Promise<{ policyId: number | null; settings: DropshipCostChangePolicySettings }>;
}

export interface DropshipCostScheduleChangeView {
  entryId: number;
  vendorId: number;
  vendorBusinessName: string | null;
  productVariantId: number;
  variantSku: string | null;
  variantName: string;
  productName: string;
  kind: "baseline" | "increase" | "decrease";
  fromCents: number | null;
  unitCostCents: number;
  effectiveAt: Date;
  observedAt: Date;
  policyId: number | null;
  costSource: string;
}

export interface DropshipCostChangeLogView {
  logId: number;
  entryId: number;
  vendorId: number;
  vendorBusinessName: string | null;
  productVariantId: number;
  variantSku: string | null;
  variantName: string;
  productName: string;
  eventType: CostScheduleEventType;
  fromCents: number | null;
  toCents: number | null;
  effectiveAt: Date;
  retailDriven: boolean;
  observedAt: Date;
  policyId: number | null;
  costSource: string;
  createdAt: Date;
}

export type DropshipCostDetectionTickOutcome = "not_due" | "progressed" | "completed";

export interface DropshipCostDetectionTickResult {
  outcome: DropshipCostDetectionTickOutcome;
  passNumber: number;
  vendorsProcessed: number;
  variantsRead: number;
  unavailableReadings: number;
  changesRecorded: number;
  events: CostScheduleEventCounts;
  /** Vendors whose cost source could not be read this tick; each is retried on the next pass. */
  sourceReadFailures: number;
}

export interface DropshipCostDetectionOverview {
  /** Whether this process runs the detection worker (its environment switch). */
  workerEnabled: boolean;
  state: DropshipCostDetectionState;
  /** Announced changes whose date is still ahead, soonest first. */
  pending: DropshipCostScheduleChangeView[];
  pendingLimit: number;
  generatedAt: Date;
}

export interface DropshipCostChangeLogPage {
  items: DropshipCostChangeLogView[];
  /** Pass as `beforeId` for the next page; null when this page is the last. */
  nextBeforeId: number | null;
  generatedAt: Date;
}

export const runDropshipCostDetectionTickInputSchema = z.object({
  workerId: z.string().trim().min(1).max(200),
  vendorsPerTick: z.number().int().min(1).max(1_000).optional(),
}).strict();

export const listDropshipCostChangeLogInputSchema = z.object({
  limit: z.number().int().min(1).max(COST_CHANGE_LOG_PAGE_LIMIT).optional(),
  beforeId: z.number().int().positive().nullable().optional(),
}).strict();

export class DropshipCostDetectionService {
  constructor(
    private readonly deps: {
      repository: DropshipCostScheduleRepository;
      policy: DropshipCostChangePolicyReader;
      clock: DropshipClock;
      logger: DropshipLogger;
      workerEnabled: boolean;
    },
  ) {}

  async runTick(input: unknown): Promise<DropshipCostDetectionTickResult> {
    const parsed = parseInput(runDropshipCostDetectionTickInputSchema, input);
    const vendorsPerTick = parsed.vendorsPerTick ?? DEFAULT_COST_DETECTION_VENDORS_PER_TICK;
    const { repository } = this.deps;
    const now = this.deps.clock.now();
    const policy = await this.deps.policy.resolvePolicy();
    assertDetectionInterval(policy.settings.detectionIntervalMinutes);
    await repository.recordTick({ now });

    let state = await repository.readDetectionState();
    if (!isPassInProgress(state)) {
      if (!isPassDue(state, policy.settings.detectionIntervalMinutes, now)) {
        return emptyTickResult("not_due", state.passNumber);
      }
      state = await repository.startPass({ now, policyId: policy.policyId });
      this.deps.logger.info({
        code: "DROPSHIP_COST_DETECTION_PASS_STARTED",
        message: "Dropship cost detection pass started.",
        context: { action: "cost_detection_pass", outcome: "started", passNumber: state.passNumber,
          policyId: policy.policyId, workerId: parsed.workerId },
      });
    }

    const vendorIds = await repository.listVendorsAfter({ afterVendorId: state.cursorVendorId, limit: vendorsPerTick });
    const totals = emptyTickResult("progressed", state.passNumber);
    for (const vendorId of vendorIds) {
      const vendor = await this.reconcileVendor({ vendorId, policy, workerId: parsed.workerId });
      totals.vendorsProcessed += 1;
      totals.variantsRead += vendor.variantsRead;
      totals.unavailableReadings += vendor.unavailableReadings;
      totals.changesRecorded += vendor.changesRecorded;
      totals.sourceReadFailures += vendor.sourceReadFailed ? 1 : 0;
      for (const key of Object.keys(totals.events) as CostScheduleEventType[]) totals.events[key] += vendor.events[key];
    }

    if (vendorIds.length < vendorsPerTick) {
      // The cursor passed the last vendor: the pass is complete.
      const completed = await repository.completePass({ now: this.deps.clock.now() });
      totals.outcome = "completed";
      this.deps.logger.info({
        code: "DROPSHIP_COST_DETECTION_PASS_COMPLETED",
        message: "Dropship cost detection pass completed.",
        context: { action: "cost_detection_pass", outcome: "completed", passNumber: completed.passNumber,
          policyId: policy.policyId, workerId: parsed.workerId,
          vendorsProcessed: completed.passVendorsProcessed, variantsRead: completed.passVariantsRead,
          unavailableReadings: completed.passUnavailableReadings, changesRecorded: completed.passChangesRecorded },
      });
    }
    return totals;
  }

  async getOverview(): Promise<DropshipCostDetectionOverview> {
    const now = this.deps.clock.now();
    const [state, pending] = await Promise.all([
      this.deps.repository.readDetectionState(),
      this.deps.repository.listPendingChanges({ now, limit: COST_DETECTION_PENDING_LIMIT }),
    ]);
    return { workerEnabled: this.deps.workerEnabled, state, pending, pendingLimit: COST_DETECTION_PENDING_LIMIT, generatedAt: now };
  }

  async listChangeLog(input: unknown): Promise<DropshipCostChangeLogPage> {
    const parsed = parseInput(listDropshipCostChangeLogInputSchema, input);
    const limit = parsed.limit ?? COST_CHANGE_LOG_PAGE_LIMIT;
    // One more than the page says whether a next page exists, without a count.
    const rows = await this.deps.repository.listChangeLog({ limit: limit + 1, beforeId: parsed.beforeId ?? null });
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      nextBeforeId: rows.length > limit && last ? last.logId : null,
      generatedAt: this.deps.clock.now(),
    };
  }

  private async reconcileVendor(input: {
    vendorId: number;
    policy: { policyId: number | null; settings: DropshipCostChangePolicySettings };
    workerId: string;
  }): Promise<CostDetectionVendorCounts & { events: CostScheduleEventCounts; sourceReadFailed: boolean }> {
    const { vendorId, policy } = input;
    const timing = {
      increaseNoticeDays: policy.settings.increaseNoticeDays,
      decreaseTiming: policy.settings.decreaseTiming,
      retailChangesGetNotice: policy.settings.retailChangesGetNotice,
    };
    return this.deps.repository.withVendorSchedule(vendorId, async (transaction) => {
      // One reading time per vendor, taken inside the lock, so every entry
      // this transaction writes agrees on when the live costs were seen.
      const observedAt = this.deps.clock.now();
      const variantIds = await transaction.listTrackedVariantIds();
      const entriesByVariant = await transaction.loadEntries(variantIds);
      const unavailableByIssue = new Map<string, number>();
      const reconciliations: CostScheduleVariantReconciliation[] = [];
      let sourceReadFailed = false;

      for (let offset = 0; offset < variantIds.length; offset += COST_READER_BATCH_SIZE) {
        const batch = variantIds.slice(offset, offset + COST_READER_BATCH_SIZE);
        const costs = await transaction.readLiveCosts(batch);
        for (const productVariantId of batch) {
          const cost = costs.get(productVariantId);
          if (!cost || cost.status !== "available") {
            const issue = cost?.issue ?? "missing";
            unavailableByIssue.set(issue, (unavailableByIssue.get(issue) ?? 0) + 1);
            if (issue === "source_read_failed") sourceReadFailed = true;
            continue;
          }
          const { unitCostCents, evidence } = readingEvidence(cost, productVariantId);
          if (unitCostCents <= 0) {
            // A zero .ops cost is refused at acceptance (resolveAcceptanceUnitCost); the schedule never records it.
            unavailableByIssue.set("zero_cost", (unavailableByIssue.get("zero_cost") ?? 0) + 1);
            continue;
          }
          const entries = entriesByVariant.get(productVariantId) ?? [];
          const inForce = entryInForce(entries, observedAt);
          const retailDriven = inForce ? isRetailDrivenReading(inForce.evidence, evidence) : false;
          const reconciliation = reconcileCostSchedule({
            entries,
            reading: { unitCostCents, observedAt, retailDriven },
            timing,
          });
          if (reconciliation.operations.length > 0) {
            reconciliations.push({ productVariantId, evidence, retailDriven, operations: reconciliation.operations });
          }
        }
      }

      const events = reconciliations.length > 0
        ? await transaction.writeReconciliation({ vendorId, observedAt, policyId: policy.policyId, variants: reconciliations })
        : emptyEventCounts();
      const unavailableReadings = [...unavailableByIssue.values()].reduce((sum, count) => sum + count, 0);
      const changesRecorded = Object.values(events).reduce((sum, count) => sum + count, 0);
      const counts = { variantsRead: variantIds.length, unavailableReadings, changesRecorded };
      await transaction.advanceCursor({ vendorId, counts, now: observedAt });

      if (sourceReadFailed) {
        // The cost source itself could not be read: nothing was recorded for
        // those variants, and the next pass retries. A human should look if it persists.
        this.deps.logger.warn({
          code: "DROPSHIP_COST_DETECTION_SOURCE_READ_FAILED",
          message: "Dropship cost detection could not read the cost source for a vendor; retried on the next pass.",
          context: { action: "cost_detection_vendor", outcome: "source_read_failed", vendorId, workerId: input.workerId,
            classification: "transient" },
        });
      }
      if (changesRecorded > 0 || unavailableReadings > 0) {
        this.deps.logger.info({
          code: "DROPSHIP_COST_DETECTION_VENDOR_RECONCILED",
          message: "Dropship cost detection reconciled a vendor's cost schedule.",
          context: { action: "cost_detection_vendor", outcome: "reconciled", vendorId, workerId: input.workerId,
            policyId: policy.policyId, observedAt: observedAt.toISOString(), ...counts,
            events, unavailableByIssue: Object.fromEntries(unavailableByIssue) },
        });
      }
      return { ...counts, events, sourceReadFailed };
    });
  }
}

export function emptyEventCounts(): CostScheduleEventCounts {
  return {
    baseline: 0,
    increase_announced: 0,
    increase_applied: 0,
    decrease_announced: 0,
    decrease_applied: 0,
    increase_reduced: 0,
    change_withdrawn: 0,
  };
}

/** A pass is under way once started and not yet completed. */
export function isPassInProgress(state: Pick<DropshipCostDetectionState, "passStartedAt" | "passCompletedAt">): boolean {
  if (!state.passStartedAt) return false;
  return !state.passCompletedAt || state.passCompletedAt.getTime() < state.passStartedAt.getTime();
}

/** A new pass is due when none has run, or the interval has elapsed since the last one began. */
export function isPassDue(
  state: Pick<DropshipCostDetectionState, "passStartedAt">,
  detectionIntervalMinutes: number,
  now: Date,
): boolean {
  assertDetectionInterval(detectionIntervalMinutes);
  if (!state.passStartedAt) return true;
  return now.getTime() - state.passStartedAt.getTime() >= detectionIntervalMinutes * MILLISECONDS_PER_MINUTE;
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

function emptyTickResult(outcome: DropshipCostDetectionTickOutcome, passNumber: number): DropshipCostDetectionTickResult {
  return {
    outcome, passNumber, vendorsProcessed: 0, variantsRead: 0, unavailableReadings: 0, changesRecorded: 0,
    events: emptyEventCounts(), sourceReadFailures: 0,
  };
}

function assertDetectionInterval(minutes: number): void {
  if (!Number.isSafeInteger(minutes) || minutes < MIN_DETECTION_INTERVAL_MINUTES || minutes > MAX_DETECTION_INTERVAL_MINUTES) {
    throw new DropshipError("DROPSHIP_COST_DETECTION_INTERVAL_INVALID", "The policy's detection interval is outside its range.",
      { classification: "fatal", minutes });
  }
}

function parseInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DropshipError("DROPSHIP_COST_DETECTION_INVALID_INPUT", "Dropship cost detection input failed validation.", {
      classification: "permanent",
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })),
    });
  }
  return result.data;
}
