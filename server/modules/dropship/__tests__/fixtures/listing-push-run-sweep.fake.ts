import { vi } from "vitest";
import { emptyListingPushRunCounts } from "../../../../../shared/dropship/listing-push-runs";
import type { DropshipCostChangePolicyInForce } from "../../application/dropship-cost-change-policy-service";
import type { DropshipListingPushRunRecord } from "../../application/dropship-listing-push-run-service";
import {
  DropshipListingPushRunSweepService,
  type DropshipListingPushRunSweepRepository,
  type ListingPushRunChunkFacts,
  type ListingPushRunChunkFailure,
  type ListingPushRunFinished,
} from "../../application/dropship-listing-push-run-sweep";
import type { DropshipLogEvent, DropshipNotificationSenderInput } from "../../application/dropship-ports";
import type { CreateListingPushJobInput } from "../../application/dropship-use-case-dtos";
import { decideChunkFailure } from "../../infrastructure/dropship-listing-push-run-sweep.repository";

export const SWEEP_NOW = new Date("2026-10-20T13:00:00.000Z");
export const RUN_PRESS = new Date("2026-10-20T12:00:00.000Z");

export function sweepRunRecord(overrides: Partial<DropshipListingPushRunRecord> = {}): DropshipListingPushRunRecord {
  return {
    runId: 4, vendorId: 10, storeConnectionId: 22, scope: "all", status: "processing", stopReason: null, selectionRevisionId: 7,
    idempotencyKey: "publish-0001", requestHash: "a".repeat(64), targetCount: 3, chunkSize: 500, chunkCount: 1,
    nextChunkIndex: 0, chunkAttempts: 0, actorType: "vendor", actorId: "member-10", cancelRequestedAt: null,
    createdAt: RUN_PRESS, updatedAt: RUN_PRESS, completedAt: null, ...overrides,
  };
}

interface FakeTarget { productVariantId: number; chunkIndex: number; outcome: string; code: string | null; productId?: number }

/**
 * The sweep repository in memory: runs with chunked targets, chunk jobs by
 * (run, chunk), facts per size, and every call recorded. Chunk failures are
 * decided by the real decideChunkFailure, so the service's classification
 * and the repository's decision are tested together.
 */
export class FakeListingPushRunSweepRepository implements DropshipListingPushRunSweepRepository {
  runs: DropshipListingPushRunRecord[] = [sweepRunRecord()];
  targets = new Map<number, FakeTarget[]>([[4, [101, 102, 103].map((id) => ({ productVariantId: id, chunkIndex: 0, outcome: "pending", code: null }))]]);
  chunkJobs = new Map<string, number>();
  facts = new Map<number, Omit<ListingPushRunChunkFacts, "productVariantId" | "onMarketplace"> & { onMarketplace?: boolean }>();
  openForQueue = true;
  stopRacesQueue = false;
  finished: ListingPushRunFinished[] = [];
  /** Finished runs whose notice step never completed (verify V9); markRunNotified removes them. */
  awaitingNotice: ListingPushRunFinished[] = [];
  notified: number[] = [];
  failMarkRunNotified: Error | null = null;
  reconcileResult = { changed: 0, finishedRunChanges: 0 };
  failRecordChunkFailure: Error | null = null;
  /** recordChunkQueued throws this (a record step that fails every time, review round 2 MC3). */
  failRecordChunkQueued: Error | null = null;
  calls: Array<{ method: string; input: unknown }> = [];
  attempts = new Map<number, number>();

  private log(method: string, input: unknown) { this.calls.push({ method, input }); }
  callsOf(method: string) { return this.calls.filter((call) => call.method === method).map((call) => call.input); }

  async reconcileTargets(input: { now: Date; activityWindowMs: number }) { this.log("reconcileTargets", input); return this.reconcileResult; }
  async finishRuns(input: { now: Date; problemLimit: number }) { this.log("finishRuns", input); return this.finished; }
  async listRunsAwaitingNotice(input: { now: Date; windowMs: number; limit: number; problemLimit: number }) {
    this.log("listRunsAwaitingNotice", input);
    return this.awaitingNotice.filter((row) => !this.notified.includes(row.run.runId)).slice(0, input.limit);
  }
  async markRunNotified(input: { runId: number; now: Date }) {
    this.log("markRunNotified", input);
    if (this.failMarkRunNotified) throw this.failMarkRunNotified;
    if (!this.notified.includes(input.runId)) this.notified.push(input.runId);
  }
  async listExpandableRuns(input: { limit: number }) {
    this.log("listExpandableRuns", input);
    return this.runs.filter((run) => run.status === "processing" && !run.cancelRequestedAt
      && (this.targets.get(run.runId) ?? []).some((target) => target.outcome === "pending")).slice(0, input.limit);
  }
  async nextPendingChunk(input: { runId: number }) {
    this.log("nextPendingChunk", input);
    const pending = (this.targets.get(input.runId) ?? []).filter((target) => target.outcome === "pending");
    if (pending.length === 0) return null;
    const chunkIndex = Math.min(...pending.map((target) => target.chunkIndex));
    return { chunkIndex, productVariantIds: pending.filter((target) => target.chunkIndex === chunkIndex).map((target) => target.productVariantId) };
  }
  async findChunkJob(input: { runId: number; chunkIndex: number }) {
    this.log("findChunkJob", input);
    const jobId = this.chunkJobs.get(`${input.runId}:${input.chunkIndex}`);
    return jobId === undefined ? null : { jobId };
  }
  async readChunkFacts(input: { run: DropshipListingPushRunRecord; productVariantIds: readonly number[]; now: Date }) {
    this.log("readChunkFacts", { runId: input.run.runId, productVariantIds: [...input.productVariantIds], now: input.now });
    return input.productVariantIds.map((productVariantId) => ({
      productVariantId, selected: true, live: false, priceInputsMoved: false, ...this.facts.get(productVariantId),
      // A live size is listed on eBay; a test names a re-sent listed one with onMarketplace alone.
      onMarketplace: this.facts.get(productVariantId)?.onMarketplace ?? this.facts.get(productVariantId)?.live ?? false }));
  }
  async recordPrefilter(input: { run: DropshipListingPushRunRecord; chunkIndex: number; outcomes: ReadonlyArray<{ productVariantId: number; outcome: string; code: string }>; now: Date }) {
    this.log("recordPrefilter", { runId: input.run.runId, chunkIndex: input.chunkIndex, outcomes: [...input.outcomes] });
    for (const outcome of input.outcomes) {
      const target = this.target(input.run.runId, outcome.productVariantId);
      if (target.outcome === "pending") Object.assign(target, { outcome: outcome.outcome, code: outcome.code });
    }
    return { applied: input.outcomes.length };
  }
  async isRunOpenForQueue(input: { runId: number }) { this.log("isRunOpenForQueue", input); return this.openForQueue; }
  async recordChunkQueued(input: { run: DropshipListingPushRunRecord; chunkIndex: number; jobId: number; now: Date }) {
    this.log("recordChunkQueued", { runId: input.run.runId, chunkIndex: input.chunkIndex, jobId: input.jobId });
    if (this.failRecordChunkQueued) throw this.failRecordChunkQueued;
    this.attempts.set(input.run.runId, 0);
    const pending = (this.targets.get(input.run.runId) ?? []).filter((target) => target.chunkIndex === input.chunkIndex && target.outcome === "pending");
    for (const target of pending) target.outcome = this.stopRacesQueue ? "cancelled" : "queued";
    return { stopped: this.stopRacesQueue, queued: this.stopRacesQueue ? 0 : pending.length, decided: 0, notQueued: 0 };
  }
  async recordChunkFailure(input: { run: DropshipListingPushRunRecord; chunkIndex: number; failure: ListingPushRunChunkFailure; message: string; now: Date }) {
    this.log("recordChunkFailure", { runId: input.run.runId, chunkIndex: input.chunkIndex, failure: input.failure, message: input.message });
    if (this.failRecordChunkFailure) throw this.failRecordChunkFailure;
    const attempts = (this.attempts.get(input.run.runId) ?? 0) + 1;
    this.attempts.set(input.run.runId, attempts);
    // As the repository: a chunk a job already carries is never decided here (review MC5).
    const chunkJobExists = this.chunkJobs.has(`${input.run.runId}:${input.chunkIndex}`);
    const decide = chunkJobExists ? null : decideChunkFailure(input.failure, attempts);
    let decided = 0;
    if (decide) {
      for (const target of this.targets.get(input.run.runId) ?? []) {
        if (target.chunkIndex === input.chunkIndex && target.outcome === "pending") {
          Object.assign(target, { outcome: decide.outcome, code: input.failure.code });
          decided += 1;
        }
      }
      this.attempts.set(input.run.runId, 0);
    }
    return { attempts, decided, chunkJobExists };
  }

  async recordChunkProductFailure(input: { run: DropshipListingPushRunRecord; chunkIndex: number; productId: number; code: string; message: string; now: Date }) {
    this.log("recordChunkProductFailure", { runId: input.run.runId, chunkIndex: input.chunkIndex, productId: input.productId, code: input.code });
    if (this.chunkJobs.has(`${input.run.runId}:${input.chunkIndex}`)) return { decided: 0, chunkJobExists: true };
    let decided = 0;
    for (const target of this.targets.get(input.run.runId) ?? []) {
      if (target.chunkIndex === input.chunkIndex && target.outcome === "pending" && target.productId === input.productId) {
        Object.assign(target, { outcome: "failed", code: input.code });
        decided += 1;
      }
    }
    return { decided, chunkJobExists: false };
  }

  target(runId: number, productVariantId: number): FakeTarget {
    const found = (this.targets.get(runId) ?? []).find((target) => target.productVariantId === productVariantId);
    if (!found) throw new Error(`No target ${runId}/${productVariantId}`);
    return found;
  }
  outcomes(runId = 4): Array<[number, string, string | null]> {
    return (this.targets.get(runId) ?? []).map((target) => [target.productVariantId, target.outcome, target.code]);
  }
}

export function makeSweepHarness(options: { policy?: DropshipCostChangePolicyInForce["settings"]["rulePricedListings"] } = {}) {
  const repository = new FakeListingPushRunSweepRepository();
  const logs: Array<DropshipLogEvent & { level: string }> = [];
  const notices: DropshipNotificationSenderInput[] = [];
  const order: string[] = [];
  const createChunkJob = vi.fn(async (input: CreateListingPushJobInput) => {
    order.push("createChunkJob");
    void input;
    return { job: { jobId: 900 } };
  });
  const rulePriced = new Set<number>();
  const priceCheck = vi.fn(async (input: { productVariantIds: readonly number[] }) =>
    input.productVariantIds.map((productVariantId) => ({ productVariantId, rulePriced: rulePriced.has(productVariantId) })));
  let time = 0;
  const timer = { advanceEachCall: 1, now: () => (time += timer.advanceEachCall) };
  const notificationSender = {
    error: null as Error | null,
    send: vi.fn(async (input: DropshipNotificationSenderInput) => {
      order.push("notify");
      notices.push(input);
      if (notificationSender.error) throw notificationSender.error;
    }),
  };
  const policy = { value: options.policy ?? "reprice_automatically" };
  const service = new DropshipListingPushRunSweepService({
    repository,
    createChunkJob,
    priceCheck,
    resolveCostChangePolicy: async () => ({ policyId: 1, settings: { rulePricedListings: policy.value } as DropshipCostChangePolicyInForce["settings"] }),
    notificationSender,
    clock: { now: () => SWEEP_NOW },
    timer: () => timer.now(),
    logger: {
      info: (event) => logs.push({ ...event, level: "info" }),
      warn: (event) => logs.push({ ...event, level: "warn" }),
      error: (event) => logs.push({ ...event, level: "error" }),
    },
  });
  return { repository, service, logs, notices, order, createChunkJob, priceCheck, rulePriced, timer, notificationSender, policy };
}

export function finishedRun(overrides: Partial<ListingPushRunFinished> = {}): ListingPushRunFinished {
  return {
    run: sweepRunRecord({ status: "partial", completedAt: SWEEP_NOW }),
    counts: { ...emptyListingPushRunCounts(), completed: 1, failed: 2 },
    problems: [],
    storeName: null,
    stockLinkFailuresNotRequeued: [],
    ...overrides,
  };
}
