import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ListingRuleConversionRecord } from "../../../../../shared/dropship/listing-rules-conversion";
import type {
  ConversionTransactionResult,
  ListingRulesConversionExecuteInput,
  ListingRulesConversionTransaction,
} from "../../application/dropship-listing-rules-conversion-service";
import type { ListingSettingsConversionLoad } from "../../application/dropship-listing-settings-service";
import { DropshipError } from "../../domain/errors";

/**
 * The rules conversion job, DI (PR 11e2, plan 9.4 11e2, 13; the first-mark
 * job's pattern, dropship-category-marks-job-service.test.ts). The source,
 * the repository, the clock, the timer and the log are fakes; the planner's
 * check and the conversion's transaction body are spies with scripted
 * answers, so what the job does with each answer is visible, and so is that
 * the transaction body is convertInTransaction in system mode with the
 * tick's one clock reading. The fake source leaves out what the SQL leaves
 * out (a store with a conversion row; an eligible store whose failure names
 * its current head revisions and the planner version, D20), so the next
 * tick's behavior is visible too; the SQL itself is pinned on PostgreSQL.
 */

const mocks = vi.hoisted(() => ({
  checkRulesConversion: vi.fn(),
  convertInTransaction: vi.fn(),
}));
vi.mock("../../application/dropship-listing-rules-conversion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../application/dropship-listing-rules-conversion")>()),
  checkRulesConversion: mocks.checkRulesConversion,
}));
vi.mock("../../application/dropship-listing-rules-conversion-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../application/dropship-listing-rules-conversion-service")>()),
  convertInTransaction: mocks.convertInTransaction,
}));

import { RULES_CONVERSION_PLANNER_VERSION } from "../../application/dropship-listing-rules-conversion";
import {
  RULES_CONVERSION_APPLIED_ACTION,
  RULES_CONVERSION_COST_READ_FAILED_ACTION,
  rulesConversionCostReadReporter,
} from "../../application/dropship-listing-rules-conversion-service";
import {
  DAILY_TICK_REPORT_UTC_HOUR,
  DropshipRulesConversionJobService,
  RULES_CONVERSION_DEFERRED_ACTION,
  RULES_CONVERSION_FAILED_ACTION,
  RULES_CONVERSION_SKIPPED_ACTION,
  RULES_CONVERSION_TICK_ACTION,
  rulesConversionJobCostReadLog,
  rulesConversionJobKey,
  type RulesConversionFailureAudit,
  type RulesConversionFailureRecordOutcome,
  type RulesConversionHeadRevisions,
  type RulesConversionJobRepository,
  type RulesConversionJobSource,
  type RulesConversionJobStores,
  type RulesConversionStoreLoad,
} from "../../application/dropship-rules-conversion-job-service";

const NOW = new Date("2026-10-16T09:15:00.000Z");
const JOB_KEY = "rules-conversion-job:2026-10-16T09";
const HEADS: RulesConversionHeadRevisions = Object.freeze({ pricing: 31, content: 41, ebayRules: 51 });

type LogMock = Mock<(action: string, fields: Record<string, unknown>) => void>;

interface SourceStore {
  vendorId: number;
  storeConnectionId: number;
  eligible: boolean;
  revisions: RulesConversionHeadRevisions;
}

/**
 * The store list, as the SQL decides it (plan 13.2): every store with older
 * rules and no conversion row, the ineligible ones reported only, and an
 * eligible store whose recorded failure names its current revisions and this
 * planner version dead-lettered. Reads the fake repository's conversions and
 * failure rows, as the SQL reads the tables.
 */
class FakeSource implements RulesConversionJobSource {
  stores: SourceStore[] = [];
  calls: Array<{ plannerVersion: number }> = [];
  failure: Error | null = null;
  constructor(private readonly repository: FakeRepository) {}
  async listStores(input: { plannerVersion: number }): Promise<RulesConversionJobStores> {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    const listed: RulesConversionJobStores = { eligible: [], notEligibleStoreIds: [], deadLetteredStoreIds: [] };
    for (const store of this.stores) {
      if (this.repository.converted.has(store.storeConnectionId)) continue;
      const deadLettered = this.repository.failureRows.some((row) => row.storeConnectionId === store.storeConnectionId
        && row.payload.plannerVersion === input.plannerVersion && JSON.stringify(row.payload.revisions) === JSON.stringify(store.revisions));
      if (!store.eligible) listed.notEligibleStoreIds.push(store.storeConnectionId);
      else if (deadLettered) listed.deadLetteredStoreIds.push(store.storeConnectionId);
      else listed.eligible.push(Object.freeze({ vendorId: store.vendorId, storeConnectionId: store.storeConnectionId,
        revisions: Object.freeze({ ...store.revisions }) }));
    }
    return Object.freeze(listed) as RulesConversionJobStores;
  }
}

class FakeRepository implements RulesConversionJobRepository {
  /** Each store's check load, or its failure; a store with none loads as a clean eBay store. */
  loads = new Map<number, RulesConversionStoreLoad | null | Error>();
  checks: Array<{ storeConnectionId: number; now: Date }> = [];
  executions: ListingRulesConversionExecuteInput[] = [];
  /** Each store's transaction answer, or its failure (convertInTransaction's spy reads it); default: converted. */
  applies = new Map<number, ConversionTransactionResult | Error>();
  /** Stores with a conversion row (the source skips them). */
  converted = new Set<number>();
  records: Array<{ storeConnectionId: number; expectedVendorId: number; payload: RulesConversionFailureAudit; now: Date }> = [];
  /** The failure rows written (the source's exclusion reads them). */
  failureRows: Array<{ storeConnectionId: number; payload: RulesConversionFailureAudit }> = [];
  recordAnswers = new Map<number, RulesConversionFailureRecordOutcome | Error>();

  async loadConversionInputsForStore(input: { storeConnectionId: number; now: Date }): Promise<RulesConversionStoreLoad | null> {
    this.checks.push(input);
    const load = this.loads.has(input.storeConnectionId) ? this.loads.get(input.storeConnectionId)! : okLoad(VENDOR_OF(input.storeConnectionId));
    if (load instanceof Error) throw load;
    return load;
  }

  async executeConversion<T>(input: ListingRulesConversionExecuteInput, operation: (tx: ListingRulesConversionTransaction) => Promise<T>): Promise<T> {
    this.executions.push(input);
    const tx = Object.freeze({ vendorId: VENDOR_OF(input.storeConnectionId), storeConnectionId: input.storeConnectionId,
      actor: { actorType: "system", actorId: input.actorType === "system" ? input.jobKey : "" }, requestKey: `rules-conversion:${input.storeConnectionId}` });
    const result = await operation(tx as unknown as ListingRulesConversionTransaction);
    const answer = result as { result?: ConversionTransactionResult };
    if (answer.result?.outcome === "converted") this.converted.add(input.storeConnectionId);
    return result;
  }

  async recordFailure(input: { storeConnectionId: number; expectedVendorId: number; payload: RulesConversionFailureAudit; now: Date }):
    Promise<RulesConversionFailureRecordOutcome> {
    this.records.push(input);
    const answer = this.recordAnswers.get(input.storeConnectionId) ?? "recorded";
    if (answer instanceof Error) throw answer;
    if (answer === "recorded") this.failureRows.push({ storeConnectionId: input.storeConnectionId, payload: input.payload });
    return answer;
  }
}

/** Stores 22-25 are vendor 10's; 30+ vendor 11's. */
const VENDOR_OF = (storeConnectionId: number) => (storeConnectionId >= 30 ? 11 : 10);
const INPUTS = (storeConnectionId: number) => Object.freeze({ sentinel: "the planner's inputs", storeConnectionId });
const okLoad = (vendorId: number, storeConnectionId = 0): RulesConversionStoreLoad => ({ vendorId,
  load: { state: "ok", inputs: INPUTS(storeConnectionId) as never, costReadFailure: null } });
const loadOf = (storeConnectionId: number, load: ListingSettingsConversionLoad): RulesConversionStoreLoad =>
  ({ vendorId: VENDOR_OF(storeConnectionId), load });

/** The planner's diff for a store (only the fields the job reads). */
const cleanDiff = { state: "clean", rows: [], blocked: { wouldLosePrice: [], wouldBlockListing: [], tooMuchText: false } };
const notCleanDiff = (rows: number, lose = 0, block = 0, tooMuchText = false) => ({ state: "not_clean",
  rows: Array.from({ length: rows }, (_, index) => ({ productVariantId: 1_000 + index })),
  blocked: { wouldLosePrice: Array.from({ length: lose }, () => ({})), wouldBlockListing: Array.from({ length: block }, () => ({})), tooMuchText } });

const record = (storeConnectionId: number, id = 9_000 + storeConnectionId): ListingRuleConversionRecord => ({
  id, vendorId: VENDOR_OF(storeConnectionId), storeConnectionId, idempotencyKey: `rules-conversion:${storeConnectionId}`,
  requestHash: "a".repeat(64), planHash: "b".repeat(64), writesHash: "c".repeat(64), clean: true, changedSizeCount: 0,
  categoryCount: 2, productCount: 5, pricingGroupsRemoved: 1, contentGroupsRemoved: 2, ebayRulesRemoved: 0,
  actorType: "system", actorId: JOB_KEY, createdAt: NOW.toISOString(), noticeSeenAt: null, noticeSeenBy: null,
});
const converted = (storeConnectionId: number): ConversionTransactionResult => ({ outcome: "converted", record: record(storeConnectionId),
  marksInserted: 3 });

const busy = (reason = "catalog_changed") => new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "Card Shellz products changed while this was being saved.",
  { storeConnectionId: 22, reason, retryAfterSeconds: 5, retryable: true, classification: "transient" });
const storeGone = () => new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.",
  { storeConnectionId: 22, retryable: false, classification: "permanent" });
const invariant = (causeCode?: string) => new DropshipError("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "A rules conversion broke a contract.",
  { storeConnectionId: 22, ...(causeCode ? { causeCode } : {}), retryable: false, classification: "fatal" });
/** A server error as node-postgres raises it: its SQLSTATE in `code`. */
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
/**
 * Raw database faults a retry can clear, as they reach the job: the listing-settings mapper hands them back unchanged
 * (mapListingSettingWriteError). node-postgres' own connection losses carry no code at all (pg 8.20, lib/client.js).
 */
const RAW_RETRYABLE: ReadonlyArray<readonly [label: string, error: () => Error, failure: string, causeCode: string | null]> = [
  ["a connection that ended with no server error", () => new Error("Connection terminated unexpectedly"), "connection_terminated", null],
  ["a statement on a client whose connection is gone", () => new Error("Client has encountered a connection error and is not queryable"),
    "client_not_queryable", null],
  ["a statement cancelled or timed out (57014)", () => pgError("57014", "canceling statement due to statement timeout"), "57014", "57014"],
  ["a lock timeout (55P03)", () => pgError("55P03", "canceling statement due to lock timeout"), "55P03", "55P03"],
  ["a serialization failure (40001)", () => pgError("40001", "could not serialize access"), "40001", "40001"],
  ["a deadlock (40P01)", () => pgError("40P01", "deadlock detected"), "40P01", "40P01"],
  ["a connection exception of class 08 (08P01)", () => pgError("08P01", "protocol violation"), "08P01", "08P01"],
  ["the server out of memory, class 53 (53200)", () => pgError("53200", "out of memory"), "53200", "53200"],
  ["the server's disk full, class 53 (53100)", () => pgError("53100", "could not extend file"), "53100", "53100"],
  ["a socket error the mapper leaves raw (EHOSTUNREACH)", () => pgError("EHOSTUNREACH", "connect EHOSTUNREACH"), "EHOSTUNREACH", "EHOSTUNREACH"],
];

let repository: FakeRepository;
let source: FakeSource;
let log: { debug: LogMock; info: LogMock; warn: LogMock; error: LogMock };
let clock: { now: Mock<() => Date> };
let timer: Mock<() => number>;
let failureContext: Mock<(error: unknown) => Record<string, unknown>>;
let service: DropshipRulesConversionJobService;

/** Each store's diff by its inputs' store id; default clean. */
const diffs = new Map<number, unknown>();

beforeEach(() => {
  vi.clearAllMocks();
  diffs.clear();
  repository = new FakeRepository();
  source = new FakeSource(repository);
  log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  clock = { now: vi.fn(() => NOW) };
  let tick = 1_000;
  timer = vi.fn(() => { const value = tick; tick += 250; return value; });
  failureContext = vi.fn((error: unknown) => ({ error: error instanceof Error ? error.message : String(error), databasePool: "snapshot" }));
  service = new DropshipRulesConversionJobService({ source, repository, clock, timer, log, failureContext });
  // The check's load carries its store id in the inputs, so the planner spy answers per store.
  repository.loads = new Map();
  mocks.checkRulesConversion.mockImplementation((inputs: { storeConnectionId: number }) => {
    const diff = diffs.get(inputs.storeConnectionId) ?? cleanDiff;
    if (diff instanceof Error) throw diff;
    return { plan: { sentinel: "plan" }, diff };
  });
  mocks.convertInTransaction.mockImplementation(async (tx: ListingRulesConversionTransaction) => {
    const answer = repository.applies.get(tx.storeConnectionId) ?? converted(tx.storeConnectionId);
    if (answer instanceof Error) throw answer;
    return answer;
  });
});

/** Eligible stores of the default revisions; each check loads as a clean eBay store with its own inputs. */
function eligible(...storeConnectionIds: number[]): void {
  for (const storeConnectionId of storeConnectionIds) {
    source.stores.push({ vendorId: VENDOR_OF(storeConnectionId), storeConnectionId, eligible: true, revisions: { ...HEADS } });
    repository.loads.set(storeConnectionId, okLoad(VENDOR_OF(storeConnectionId), storeConnectionId));
  }
}

const tickLine = () => {
  const calls = [...log.info.mock.calls, ...log.debug.mock.calls].filter(([action]) => action === RULES_CONVERSION_TICK_ACTION);
  expect(calls).toHaveLength(1);
  return calls[0][1];
};

describe("rulesConversionJobKey (plan 13.3 step 1)", () => {
  it.each([
    ["the last millisecond of an hour", "2026-10-16T21:59:59.999Z", "rules-conversion-job:2026-10-16T21"],
    ["the first of the next", "2026-10-16T22:00:00.000Z", "rules-conversion-job:2026-10-16T22"],
    ["a time with an offset, by its UTC hour", "2026-10-16T23:30:00.000-05:00", "rules-conversion-job:2026-10-17T04"],
  ])("names %s", (_label, time, key) => {
    expect(rulesConversionJobKey(new Date(time))).toBe(key);
    // Not the conversion's own key (`rules-conversion:<store>`), and within the actor id's varchar(255).
    expect(key.startsWith("rules-conversion:")).toBe(false);
  });

  it.each([["an invalid Date", new Date(Number.NaN)], ["a year after 9999", new Date("+010000-01-01T00:00:00.000Z")],
    ["something that is not a Date", "2026-10-16" as unknown as Date]])("refuses %s as a fatal broken contract", (_label, now) => {
    expect(() => rulesConversionJobKey(now)).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      context: expect.objectContaining({ classification: "fatal" }) }));
  });
});

describe("DropshipRulesConversionJobService.runOnce (plan 9.4 11e2, 13.3)", () => {
  it("reads the clock once per tick: one job key, the same time for every check, apply and record", async () => {
    eligible(22, 23, 30);
    diffs.set(23, notCleanDiff(2));
    repository.applies.set(30, invariant());

    const result = await service.runOnce();

    expect(clock.now).toHaveBeenCalledOnce();
    expect(source.calls).toEqual([{ plannerVersion: RULES_CONVERSION_PLANNER_VERSION }]);
    expect(repository.checks.map((check) => check.now)).toEqual([NOW, NOW, NOW]);
    expect(mocks.convertInTransaction.mock.calls.map((call) => call[2])).toEqual([NOW, NOW]);
    expect(repository.records.map((entry) => [entry.now, entry.payload.jobKey])).toEqual([[NOW, JOB_KEY]]);
    expect(result).toMatchObject({ jobKey: JOB_KEY, plannerVersion: 1, storesChecked: 3, converted: 1, notClean: 1, failed: 1 });
  });

  it("applies a clean store once, as the system, through convertInTransaction's system mode, and says so at INFO after the commit", async () => {
    eligible(22);

    const result = await service.runOnce();

    expect(repository.executions).toEqual([{ actorType: "system", jobKey: JOB_KEY, storeConnectionId: 22 }]);
    expect(mocks.convertInTransaction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ storeConnectionId: 22 }), { kind: "system" }, NOW);
    expect(mocks.checkRulesConversion).toHaveBeenCalledExactlyOnceWith(INPUTS(22));
    expect(result).toMatchObject({ converted: 1, notClean: 0, failed: 0, deferred: 0 });
    // The vendor's own success line and fields (one query on the action returns every conversion), as the system with the store key.
    expect(log.info).toHaveBeenCalledWith(RULES_CONVERSION_APPLIED_ACTION, {
      outcome: "converted", vendor_id: 10, store_connection_id: 22, actor_type: "system", actor_id: JOB_KEY,
      request_key: "rules-conversion:22", conversion_id: 9_022, plan_hash: "b".repeat(64), clean: true, category_count: 2,
      product_count: 5, pricing_groups_removed: 1, content_groups_removed: 2, ebay_rules_removed: 0, changed_size_count: 0,
      marks_inserted: 3, before: { pricing_groups: 1, content_groups: 2, ebay_rules: 0 },
      after: { pricing_groups: 0, content_groups: 0, ebay_rules: 0 }, elapsed_ms: 250,
    });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("checks a store that is not clean and writes nothing: no transaction, counted with its sizes in the INFO tick line", async () => {
    eligible(22, 23);
    diffs.set(22, notCleanDiff(3, 1, 1, true));
    diffs.set(23, notCleanDiff(60));

    const result = await service.runOnce();

    expect(repository.executions).toEqual([]);
    expect(mocks.convertInTransaction).not.toHaveBeenCalled();
    expect(repository.records).toEqual([]);
    expect(result).toMatchObject({ notClean: 2, converted: 0 });
    expect(log.info).toHaveBeenCalledOnce();
    expect(tickLine()).toMatchObject({ outcome: "completed", stores_left: 2, not_clean_count: 2, not_clean_stores: [
      { store_connection_id: 22, changed_size_count: 3, would_lose_price_count: 1, would_block_listing_count: 1, too_much_text: true },
      { store_connection_id: 23, changed_size_count: 60, would_lose_price_count: 0, would_block_listing_count: 0, too_much_text: false },
    ] });
  });

  it("counts a store the apply finds not clean under the store lock (it changed after the check): nothing written", async () => {
    eligible(22);
    repository.applies.set(22, { outcome: "not_clean", changedSizeCount: 4, wouldLosePriceCount: 0, wouldBlockListingCount: 2, tooMuchText: false });

    const result = await service.runOnce();

    expect(repository.executions).toHaveLength(1);
    expect(repository.converted.size).toBe(0);
    expect(result).toMatchObject({ notClean: 1, converted: 0 });
    expect(tickLine().not_clean_stores).toEqual([{ store_connection_id: 22, changed_size_count: 4, would_lose_price_count: 0,
      would_block_listing_count: 2, too_much_text: false }]);
    expect(log.info.mock.calls.map(([action]) => action)).toEqual([RULES_CONVERSION_TICK_ACTION]);
  });

  it("counts too large, from the check's load and from the apply, and moves neither", async () => {
    eligible(22, 23);
    repository.loads.set(22, loadOf(22, { state: "too_large", store: {} as never }));
    repository.applies.set(23, { outcome: "too_large" });

    const result = await service.runOnce();

    expect(repository.executions.map((execution) => execution.storeConnectionId)).toEqual([23]);
    expect(result).toMatchObject({ tooLarge: 2, converted: 0 });
    expect(tickLine()).toMatchObject({ too_large_count: 2, too_large_store_ids: [22, 23], stores_left: 2 });
  });

  it("never touches a store with any conversion row: the source leaves it out, and the transaction answers already_converted", async () => {
    eligible(22, 23);
    repository.converted.add(22);
    repository.applies.set(23, { outcome: "already_converted" });

    const result = await service.runOnce();

    expect(repository.checks.map((check) => check.storeConnectionId)).toEqual([23]);
    expect(result).toMatchObject({ storesChecked: 1, alreadyConverted: 1, converted: 0 });
    expect(log.debug).toHaveBeenCalledWith(RULES_CONVERSION_SKIPPED_ACTION, { job_key: JOB_KEY, vendor_id: 10, store_connection_id: 23,
      outcome: "already_converted" });
    // Nothing moved and nothing is left: a quiet tick.
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(RULES_CONVERSION_TICK_ACTION, expect.objectContaining({ already_converted_count: 1, stores_left: 0 }));
  });

  it("writes nothing on a second tick for a store it applied (the source leaves converted stores out)", async () => {
    eligible(22);
    await service.runOnce();
    expect(repository.executions).toHaveLength(1);
    log.info.mockClear();
    log.debug.mockClear();

    const second = await service.runOnce();

    expect(repository.executions).toHaveLength(1);
    expect(repository.checks).toHaveLength(1);
    expect(second).toMatchObject({ storesChecked: 0, converted: 0 });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(RULES_CONVERSION_TICK_ACTION, expect.objectContaining({ stores_checked: 0, stores_left: 0 }));
  });

  it("defers a store whose .ops cost read timed out: WARN deferred with its stage and SQLSTATE, no apply, no record, checked next tick", async () => {
    eligible(22);
    repository.loads.set(22, loadOf(22, { state: "ok", inputs: INPUTS(22) as never, costReadFailure: { stage: "load_costs", sqlState: "57014" } }));

    const result = await service.runOnce();

    expect(mocks.checkRulesConversion).not.toHaveBeenCalled();
    expect(repository.executions).toEqual([]);
    expect(repository.records).toEqual([]);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(RULES_CONVERSION_DEFERRED_ACTION, { job_key: JOB_KEY, vendor_id: 10,
      store_connection_id: 22, outcome: "deferred", stage: "check", error_code: "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE",
      error_class: "transient", cause_code: "57014", cost_read_stage: "load_costs" });
    expect(log.error).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deferred: 1, failed: 0 });
    expect(tickLine()).toMatchObject({ outcome: "partial", deferred_count: 1, deferred_store_ids: [22], stores_left: 1 });

    // The cost read answers next hour: the same store is checked and moved.
    repository.loads.set(22, okLoad(10, 22));
    await expect(service.runOnce()).resolves.toMatchObject({ converted: 1 });
  });

  it("never dead-letters a store the .ops cost source fails for good (no SQLSTATE a retry clears): no record, one ERROR for the tick, all checked again next tick", async () => {
    eligible(22, 23, 24);
    const sourceFault = (storeConnectionId: number, stage: string) => loadOf(storeConnectionId, { state: "ok",
      inputs: INPUTS(storeConnectionId) as never, costReadFailure: { stage, sqlState: "42P01" } });
    repository.loads.set(22, sourceFault(22, "vendor_plan"));
    // The apply's own load under the lock meets the same fault (conversionCostReadFailedError's fatal form).
    repository.applies.set(23, invariant("DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE"));

    const first = await service.runOnce();

    // It is the shared source, not the store's rules: no failure row (D20's skip would never re-arm once the source is fixed),
    // and the store after them still runs (a failing store never stops the others, plan 13.7).
    expect(repository.records).toEqual([]);
    expect(first).toMatchObject({ costSourceFailed: 2, converted: 1, failed: 0, deferred: 0, deadLettered: 0 });
    expect(log.error).toHaveBeenCalledExactlyOnceWith(RULES_CONVERSION_FAILED_ACTION, {
      job_key: JOB_KEY, outcome: "deferred", reason: "cost_source_unavailable", stage: "check",
      error_code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", error_class: "fatal", cause_code: "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE",
      cost_read_stage: "vendor_plan", sql_state: "42P01", store_count: 2, store_connection_ids: [22, 23],
      vendor_count: 1, vendor_ids: [10],
      cause_count: 2, causes: [{ stage: "check", cost_read_stage: "vendor_plan", sql_state: "42P01" },
        { stage: "apply", cost_read_stage: null, sql_state: null }],
      dead_lettered: false,
      error_message: "Prices from cost can't be read for this store, so its older rules can't be checked.",
      error_context: expect.objectContaining({ causeCode: "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE", stage: "vendor_plan" }),
      context: expect.objectContaining({ databasePool: "snapshot" }),
    });
    expect(failureContext).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
    expect(tickLine()).toMatchObject({ outcome: "partial", cost_source_failed_count: 2, cost_source_failed_store_ids: [22, 23],
      converted_store_ids: [24], stores_left: 2, dead_lettered_count: 0 });

    // Still broken next hour: both checked again, one ERROR again, still nothing recorded.
    log.error.mockClear();
    await expect(service.runOnce()).resolves.toMatchObject({ storesChecked: 2, costSourceFailed: 2, deadLettered: 0 });
    expect(log.error).toHaveBeenCalledOnce();
    expect(repository.records).toEqual([]);

    // Fixed: the next tick moves both by itself, with no rule edit or planner bump.
    repository.loads.set(22, okLoad(10, 22));
    repository.applies.delete(23);
    log.error.mockClear();
    await expect(service.runOnce()).resolves.toMatchObject({ storesChecked: 2, converted: 2, costSourceFailed: 0 });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("names every vendor and every distinct cause the cost source stopped in the tick's one ERROR, beside the stores", async () => {
    eligible(22, 23, 24, 30, 31);
    const sourceFault = (storeConnectionId: number, stage: string, sqlState: string | null) => loadOf(storeConnectionId, { state: "ok",
      inputs: INPUTS(storeConnectionId) as never, costReadFailure: { stage, sqlState } });
    repository.loads.set(22, sourceFault(22, "vendor_plan", "42P01"));
    // The same cause again: named once.
    repository.loads.set(23, sourceFault(23, "vendor_plan", "42P01"));
    // Vendor 11: the adapter's own refusal (no SQLSTATE), then a fault in the apply's own load.
    repository.loads.set(30, sourceFault(30, "channel_settings", null));
    repository.applies.set(31, invariant("DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE"));

    await expect(service.runOnce()).resolves.toMatchObject({ costSourceFailed: 4, converted: 1, failed: 0, deadLettered: 0 });

    expect(repository.records).toEqual([]);
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error.mock.calls[0]).toEqual([RULES_CONVERSION_FAILED_ACTION, expect.objectContaining({
      // The first failure's own fields, as before.
      stage: "check", cost_read_stage: "vendor_plan", sql_state: "42P01",
      store_count: 4, store_connection_ids: [22, 23, 30, 31],
      vendor_count: 2, vendor_ids: [10, 11],
      cause_count: 3, causes: [
        { stage: "check", cost_read_stage: "vendor_plan", sql_state: "42P01" },
        { stage: "check", cost_read_stage: "channel_settings", sql_state: null },
        { stage: "apply", cost_read_stage: null, sql_state: null },
      ],
    })]);
  });

  it("caps the cost-source ERROR's stores, vendors and causes at 100 each, with their full counts, still one line a tick", async () => {
    const many = Array.from({ length: 150 }, (_, index) => ({ storeConnectionId: 30 + index, vendorId: 1_000 + index,
      sqlState: `42${String(index).padStart(3, "0")}` }));
    for (const { storeConnectionId, vendorId, sqlState } of many) {
      source.stores.push({ vendorId, storeConnectionId, eligible: true, revisions: { ...HEADS } });
      repository.loads.set(storeConnectionId, { vendorId, load: { state: "ok", inputs: INPUTS(storeConnectionId) as never,
        costReadFailure: { stage: "vendor_plan", sqlState } } });
    }

    await expect(service.runOnce()).resolves.toMatchObject({ costSourceFailed: 150 });

    expect(log.error).toHaveBeenCalledOnce();
    const fields = log.error.mock.calls[0][1];
    expect(fields).toMatchObject({ store_count: 150, vendor_count: 150, cause_count: 150 });
    expect(fields.store_connection_ids).toEqual(many.slice(0, 100).map((store) => store.storeConnectionId));
    expect(fields.vendor_ids).toEqual(many.slice(0, 100).map((store) => store.vendorId));
    expect(fields.causes).toEqual(many.slice(0, 100).map((store) => ({ stage: "check", cost_read_stage: "vendor_plan", sql_state: store.sqlState })));
  });

  it("logs a transient cost read once, at WARN, with the job's real cost-read reporter (the reporter's own line is DEBUG in the job)", async () => {
    eligible(22);
    const reporter = rulesConversionCostReadReporter(rulesConversionJobCostReadLog(log));
    // The repository's load calls the reporter, as loadListingSettingsInputsWithClient does, then answers the failure.
    repository.loadConversionInputsForStore = async (input) => {
      repository.checks.push(input);
      reporter({ vendorId: 10, storeConnectionId: 22, variantCount: 4, stage: "vendor_plan", sqlState: "57014" });
      return loadOf(22, { state: "ok", inputs: INPUTS(22) as never, costReadFailure: { stage: "vendor_plan", sqlState: "57014" } });
    };

    await expect(service.runOnce()).resolves.toMatchObject({ deferred: 1 });

    expect(log.warn).toHaveBeenCalledExactlyOnceWith(RULES_CONVERSION_DEFERRED_ACTION, expect.objectContaining({ job_key: JOB_KEY,
      store_connection_id: 22, cause_code: "57014", cost_read_stage: "vendor_plan" }));
    expect(log.debug).toHaveBeenCalledWith(RULES_CONVERSION_COST_READ_FAILED_ACTION, expect.objectContaining({ outcome: "deferred",
      store_connection_id: 22, stage: "vendor_plan", sql_state: "57014" }));
    expect(log.error).not.toHaveBeenCalled();
  });

  it("wires the job's repository with the DEBUG-only cost-read log (the factory)", () => {
    const factory = readFileSync(resolve(process.cwd(), "server/modules/dropship/infrastructure/dropship-rules-conversion.factory.ts"), "utf8");
    expect(factory).toMatch(/rulesConversionCostReadReporter\(rulesConversionJobCostReadLog\(platformJobLog\)\)/);
    expect(factory).not.toMatch(/rulesConversionCostReadReporter\(platformJobLog\)/);
  });

  it.each([
    ["a BUSY catalog_changed (Card Shellz moved a row under the locks)", busy("catalog_changed")],
    ["a deadlock mapped to BUSY", new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "busy", { sqlState: "40P01", retryable: true,
      classification: "transient" })],
    ["the apply's own cost read 503", new DropshipError("DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE", "later", { stage: "load_costs",
      sqlState: "55P03", retryable: true, classification: "transient", retryAfterSeconds: 60 })],
  ])("defers %s from the apply: WARN, never recorded, never ERROR", async (_label, error) => {
    eligible(22);
    repository.applies.set(22, error);

    await expect(service.runOnce()).resolves.toMatchObject({ deferred: 1, failed: 0 });
    expect(repository.records).toEqual([]);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(RULES_CONVERSION_DEFERRED_ACTION, expect.objectContaining({ stage: "apply",
      error_code: error.code, error_class: "transient" }));
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each(RAW_RETRYABLE.flatMap(([label, error, failure, causeCode]) => (["check", "apply"] as const)
    .map((stage) => [`${label}, in the ${stage}`, stage, error, failure, causeCode] as const)))(
    "defers %s: WARN deferred, never recorded, never ERROR, and converts the store next tick", async (_label, stage, error, failure, causeCode) => {
      eligible(22);
      if (stage === "check") repository.loads.set(22, error());
      else repository.applies.set(22, error());

      const first = await service.runOnce();

      expect(first).toMatchObject({ deferred: 1, failed: 0, converted: 0, deadLettered: 0 });
      expect(repository.executions).toHaveLength(stage === "check" ? 0 : 1);
      expect(repository.records).toEqual([]);
      expect(log.error).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(RULES_CONVERSION_DEFERRED_ACTION, { job_key: JOB_KEY, vendor_id: 10,
        store_connection_id: 22, outcome: "deferred", stage, error_code: "DROPSHIP_RULES_CONVERSION_DATABASE_BUSY", error_class: "transient",
        ...(causeCode === null ? {} : { cause_code: causeCode }), failure });
      expect(tickLine()).toMatchObject({ outcome: "partial", deferred_count: 1, deferred_store_ids: [22], failed_count: 0, stores_left: 1 });

      // The database answers next hour: the same store is checked and moved, with nothing recorded and no ERROR.
      repository.loads.set(22, okLoad(10, 22));
      repository.applies.delete(22);
      log.warn.mockClear();
      log.info.mockClear();
      log.debug.mockClear();
      await expect(service.runOnce()).resolves.toMatchObject({ storesChecked: 1, converted: 1, deferred: 0, deadLettered: 0 });
      expect(repository.records).toEqual([]);
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    });

  it.each([
    ["an undefined table (42P01)", () => pgError("42P01", "relation does not exist")],
    ["an internal error (XX000)", () => pgError("XX000", "internal error")],
    ["a coded error whose words read like a lost connection (a coded error is judged by its code)",
      () => pgError("42501", "Connection terminated by a permission check")],
    ["a raw error that is not node-postgres' words", () => new Error("snapshot lost")],
    ["a raw value that is not an Error", () => "Connection terminated unexpectedly" as unknown as Error],
    ["a DropshipError worded like a lost connection (its own class stands)", () => new DropshipError("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      "Connection terminated unexpectedly", { retryable: false, classification: "fatal" })],
  ])("keeps %s fatal: recorded once, one ERROR, dead-lettered", async (_label, error) => {
    eligible(22);
    repository.applies.set(22, error());

    await expect(service.runOnce()).resolves.toMatchObject({ failed: 1, deferred: 0 });
    expect(repository.records).toEqual([expect.objectContaining({ payload: expect.objectContaining({ stage: "apply", errorClass: "fatal" }) })]);
    expect(log.error).toHaveBeenCalledExactlyOnceWith(RULES_CONVERSION_FAILED_ACTION, expect.objectContaining({ record_outcome: "recorded",
      dead_lettered: true }));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("skips a store gone since the list at DEBUG, from the check (no owner) and from the apply (no owner rows)", async () => {
    eligible(22, 23);
    repository.loads.set(22, null);
    repository.applies.set(23, storeGone());

    const result = await service.runOnce();

    expect(result).toMatchObject({ skipped: 2, failed: 0, deferred: 0 });
    expect(repository.records).toEqual([]);
    expect(log.debug.mock.calls.filter(([action]) => action === RULES_CONVERSION_SKIPPED_ACTION).map(([, fields]) => fields)).toEqual([
      { job_key: JOB_KEY, vendor_id: 10, store_connection_id: 22, outcome: "skipped", reason: "store_not_found" },
      { job_key: JOB_KEY, vendor_id: 10, store_connection_id: 23, outcome: "skipped", reason: "store_not_found", stage: "apply" },
    ]);
    expect([log.warn, log.error, log.info].every((level) => level.mock.calls.length === 0)).toBe(true);
  });

  it.each([
    ["no older rules left at the check", () => { diffs.set(22, { ...cleanDiff, state: "no_older_rules" }); }, "nothing_to_convert"],
    ["a store no longer on eBay", () => { repository.loads.set(22, loadOf(22, { state: "not_ebay", store: {} as never })); }, "not_ebay"],
    ["nothing to convert under the lock", () => { repository.applies.set(22, { outcome: "nothing_to_convert" }); }, "nothing_to_convert"],
    ["a store the gate leaves alone under the lock", () => { repository.applies.set(22, { outcome: "skipped", reason: "store_not_eligible" }); },
      "store_not_eligible"],
    ["a store whose vendor's .ops entitlement is no longer active under the lock",
      () => { repository.applies.set(22, { outcome: "skipped", reason: "vendor_not_entitled" }); }, "vendor_not_entitled"],
  ])("skips %s at DEBUG, writing and recording nothing", async (_label, arrange, reason) => {
    eligible(22);
    arrange();

    await expect(service.runOnce()).resolves.toMatchObject({ skipped: 1, converted: 0, failed: 0 });
    // Counted on the tick line as a skip, never as a failure.
    expect(tickLine()).toMatchObject({ skipped_count: 1, failed_count: 0, deferred_count: 0 });
    expect(repository.records).toEqual([]);
    expect(log.debug).toHaveBeenCalledWith(RULES_CONVERSION_SKIPPED_ACTION, expect.objectContaining({ store_connection_id: 22, outcome: "skipped",
      reason }));
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("records a fatal store once with one ERROR, skips it on later ticks without checking it, and checks it again after a rule revision moves", async () => {
    eligible(22, 23);
    repository.applies.set(22, invariant("DROPSHIP_PRICING_REVIEW_STALE"));

    const first = await service.runOnce();

    expect(first).toMatchObject({ failed: 1, converted: 1, deadLettered: 0 });
    expect(repository.records).toEqual([{ storeConnectionId: 22, expectedVendorId: 10, now: NOW, payload: { plannerVersion: 1,
      revisions: HEADS, stage: "apply", errorCode: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", errorClass: "fatal",
      causeCode: "DROPSHIP_PRICING_REVIEW_STALE", jobKey: JOB_KEY } }]);
    expect(log.error).toHaveBeenCalledExactlyOnceWith(RULES_CONVERSION_FAILED_ACTION, {
      job_key: JOB_KEY, vendor_id: 10, store_connection_id: 22, outcome: "failed", stage: "apply",
      error_code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", error_class: "fatal", cause_code: "DROPSHIP_PRICING_REVIEW_STALE",
      planner_version: 1, revisions: HEADS, record_outcome: "recorded", dead_lettered: true,
      error_message: "A rules conversion broke a contract.", error_context: expect.objectContaining({ causeCode: "DROPSHIP_PRICING_REVIEW_STALE" }),
      context: { error: "A rules conversion broke a contract.", databasePool: "snapshot" },
    });
    expect(failureContext).toHaveBeenCalledOnce();
    expect(tickLine()).toMatchObject({ outcome: "partial", failed_count: 1, failed_store_ids: [22], converted_store_ids: [23] });

    // The next hours: the source leaves it out, so it is not checked, planned or applied, and no second ERROR is logged.
    for (let hour = 0; hour < 3; hour += 1) {
      log.error.mockClear();
      log.info.mockClear();
      const later = await service.runOnce();
      expect(later).toMatchObject({ storesChecked: 0, deadLettered: 1, failed: 0 });
      expect(log.error).not.toHaveBeenCalled();
      expect(tickLine()).toMatchObject({ dead_lettered_count: 1, dead_lettered_store_ids: [22], stores_left: 1 });
    }
    expect(repository.checks.filter((check) => check.storeConnectionId === 22)).toHaveLength(1);
    expect(repository.records).toHaveLength(1);

    // A pricing save moves the store's pricing head: it is re-armed, checked and (fixed) moved.
    source.stores[0].revisions = { ...HEADS, pricing: 32 };
    repository.applies.delete(22);
    await expect(service.runOnce()).resolves.toMatchObject({ storesChecked: 1, converted: 1, deadLettered: 0 });
  });

  it("checks a store again whose failure was recorded under another planner version (a deploy that bumps it re-arms the store)", async () => {
    eligible(22);
    repository.failureRows.push({ storeConnectionId: 22, payload: { plannerVersion: RULES_CONVERSION_PLANNER_VERSION + 1, revisions: { ...HEADS },
      stage: "apply", errorCode: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", errorClass: "fatal", causeCode: null, jobKey: "older-run" } });

    await expect(service.runOnce()).resolves.toMatchObject({ storesChecked: 1, converted: 1, deadLettered: 0 });
  });

  it("dead-letters an unexpected permanent code (the key conflict of an older row holding the store's lc: key)", async () => {
    eligible(22);
    repository.applies.set(22, new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT", "That key was used for another request.",
      { constraint: "dropship_content_profile_revision_vendor_id_idempotency_key_key", retryable: false, classification: "permanent" }));

    await service.runOnce();

    expect(repository.records.map((entry) => [entry.payload.errorCode, entry.payload.errorClass, entry.payload.causeCode])).toEqual([
      ["DROPSHIP_IDEMPOTENCY_CONFLICT", "permanent", null]]);
    expect(log.error).toHaveBeenCalledWith(RULES_CONVERSION_FAILED_ACTION, expect.objectContaining({ error_class: "permanent", dead_lettered: true }));
  });

  it.each([
    ["a raw error from the check (a stored profile that no longer parses)", "check", () => {
      repository.loads.set(22, new Error("Persisted pricing profile failed its contract."));
    }],
    ["the planner's own invariant", "check", () => { diffs.set(22, invariant()); }],
    ["a transaction answering a vendor's outcome (replayed)", "apply", () => {
      repository.applies.set(22, { outcome: "replayed", record: record(22) });
    }],
    ["a check that names another vendor than the list", "check", () => { repository.loads.set(22, okLoad(11, 22)); }],
  ])("dead-letters %s as fatal", async (_label, stage, arrange) => {
    eligible(22);
    arrange();

    await expect(service.runOnce()).resolves.toMatchObject({ failed: 1 });
    expect(repository.records).toEqual([expect.objectContaining({ payload: expect.objectContaining({ stage, errorClass: "fatal" }) })]);
    expect(log.error).toHaveBeenCalledOnce();
    expect(repository.converted.size).toBe(0);
  });

  it("names a raw error by the job's own code and its SQLSTATE as the cause", async () => {
    eligible(22);
    repository.applies.set(22, Object.assign(new Error("relation does not exist"), { code: "42P01" }));

    await service.runOnce();

    expect(repository.records[0].payload).toMatchObject({ errorCode: "DROPSHIP_RULES_CONVERSION_STORE_FAILED", errorClass: "fatal",
      causeCode: "42P01" });
  });

  it("leaves a fatal store to the next tick when its failure row can't be written for a transient reason: WARN deferred, no ERROR", async () => {
    eligible(22);
    repository.applies.set(22, invariant());
    repository.recordAnswers.set(22, busy("pool_acquire_timeout"));

    await expect(service.runOnce()).resolves.toMatchObject({ deferred: 1, failed: 0 });
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(RULES_CONVERSION_DEFERRED_ACTION, expect.objectContaining({ outcome: "deferred",
      error_code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", record_error_code: "DROPSHIP_LISTING_SETTINGS_BUSY", dead_lettered: false }));
    expect(log.error).not.toHaveBeenCalled();
    // Not dead-lettered: the next tick tries it again (and records it).
    repository.recordAnswers.delete(22);
    await service.runOnce();
    expect(repository.records).toHaveLength(2);
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("leaves a fatal store to the next tick when its failure row's write loses its connection (no SQLSTATE): WARN deferred, no ERROR", async () => {
    eligible(22);
    repository.applies.set(22, invariant());
    repository.recordAnswers.set(22, new Error("Connection terminated unexpectedly"));

    await expect(service.runOnce()).resolves.toMatchObject({ deferred: 1, failed: 0 });
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(RULES_CONVERSION_DEFERRED_ACTION, expect.objectContaining({ outcome: "deferred",
      error_code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", record_error_code: "DROPSHIP_RULES_CONVERSION_DATABASE_BUSY",
      record_error_class: "transient", record_failure: "connection_terminated", dead_lettered: false }));
    expect(log.error).not.toHaveBeenCalled();
    // Not dead-lettered: the next tick tries it again and records it once.
    repository.recordAnswers.delete(22);
    await service.runOnce();
    expect(repository.records).toHaveLength(2);
    expect(repository.failureRows).toHaveLength(1);
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("logs ERROR, not dead-lettered, when the failure row can't be written for good", async () => {
    eligible(22);
    repository.applies.set(22, invariant());
    repository.recordAnswers.set(22, new Error("permission denied for table dropship_audit_events"));

    await expect(service.runOnce()).resolves.toMatchObject({ failed: 1, deferred: 0 });
    expect(log.error).toHaveBeenCalledExactlyOnceWith(RULES_CONVERSION_FAILED_ACTION, expect.objectContaining({ dead_lettered: false,
      record_error_code: "DROPSHIP_RULES_CONVERSION_STORE_FAILED", record_error_message: "permission denied for table dropship_audit_events" }));
  });

  it("logs ERROR without dead-lettering when the store's rules moved since the list (the record compares the heads)", async () => {
    eligible(22);
    repository.applies.set(22, invariant());
    repository.recordAnswers.set(22, "rules_changed");

    await service.runOnce();

    expect(log.error).toHaveBeenCalledWith(RULES_CONVERSION_FAILED_ACTION, expect.objectContaining({ record_outcome: "rules_changed",
      dead_lettered: false }));
    // Nothing was written, so the store is checked again next tick.
    await service.runOnce();
    expect(repository.checks).toHaveLength(2);
  });

  it("never lets a failing store stop the others, in the source's order", async () => {
    eligible(22, 23, 24, 30);
    repository.loads.set(22, new Error("snapshot lost"));
    repository.applies.set(23, busy());
    diffs.set(24, notCleanDiff(1));

    const result = await service.runOnce();

    expect(repository.checks.map((check) => check.storeConnectionId)).toEqual([22, 23, 24, 30]);
    expect(result).toMatchObject({ failed: 1, deferred: 1, notClean: 1, converted: 1 });
    expect(tickLine()).toMatchObject({ failed_store_ids: [22], deferred_store_ids: [23], not_clean_count: 1, converted_store_ids: [30] });
  });

  it("writes one INFO tick line naming the stores still left (D15): every outcome, counts and ids, ids and counts only", async () => {
    eligible(22, 23, 24, 30);
    source.stores.push({ vendorId: 11, storeConnectionId: 31, eligible: false, revisions: { ...HEADS } },
      { vendorId: 11, storeConnectionId: 32, eligible: false, revisions: { ...HEADS } });
    diffs.set(22, notCleanDiff(5));
    repository.loads.set(23, loadOf(23, { state: "too_large", store: {} as never }));
    repository.applies.set(24, invariant());

    const result = await service.runOnce();

    expect(result).toEqual({ jobKey: JOB_KEY, plannerVersion: 1, storesChecked: 4, converted: 1, notClean: 1, tooLarge: 1, notEligible: 2,
      failed: 1, deferred: 0, costSourceFailed: 0, deadLettered: 0, alreadyConverted: 0, skipped: 0, elapsedMs: 1_000 });
    expect(log.info).toHaveBeenCalledWith(RULES_CONVERSION_TICK_ACTION, {
      outcome: "partial", job_key: JOB_KEY, planner_version: 1, stores_checked: 4, stores_left: 5,
      converted_count: 1, converted_store_ids: [30],
      not_clean_count: 1, not_clean_stores: [{ store_connection_id: 22, changed_size_count: 5, would_lose_price_count: 0,
        would_block_listing_count: 0, too_much_text: false }],
      too_large_count: 1, too_large_store_ids: [23],
      not_eligible_count: 2, not_eligible_store_ids: [31, 32],
      failed_count: 1, failed_store_ids: [24],
      deferred_count: 0, deferred_store_ids: [],
      cost_source_failed_count: 0, cost_source_failed_store_ids: [],
      dead_lettered_count: 0, dead_lettered_store_ids: [],
      already_converted_count: 0, skipped_count: 0, elapsed_ms: 1_000,
    });
    // Never a name or a text value in a job line (plan 3.5).
    const lines = JSON.stringify([...log.info.mock.calls, ...log.debug.mock.calls, ...log.warn.mock.calls]);
    expect(lines).not.toMatch(/sentinel|planner's inputs/);
  });

  it("reports a store that is only not eligible at INFO every tick (it is left), and never checks it", async () => {
    source.stores.push({ vendorId: 10, storeConnectionId: 22, eligible: false, revisions: { ...HEADS } });

    await expect(service.runOnce()).resolves.toMatchObject({ storesChecked: 0, notEligible: 1 });
    expect(repository.checks).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(RULES_CONVERSION_TICK_ACTION, expect.objectContaining({ outcome: "completed",
      not_eligible_count: 1, not_eligible_store_ids: [22], stores_left: 1 }));
  });

  it("logs a quiet tick (no store with older rules) at DEBUG outside the day's report hour", async () => {
    await expect(service.runOnce()).resolves.toMatchObject({ storesChecked: 0, converted: 0 });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledExactlyOnceWith(RULES_CONVERSION_TICK_ACTION, expect.objectContaining({ outcome: "completed",
      stores_left: 0, converted_count: 0 }));
  });

  it("logs the day's first quiet tick (UTC hour 0) at INFO, so the latest INFO line never keeps naming a store moved by hand (D15)", async () => {
    expect(DAILY_TICK_REPORT_UTC_HOUR).toBe(0);
    // 09:15: a store left (not eligible), INFO; then the vendor moves it himself and the source lists nothing.
    source.stores.push({ vendorId: 10, storeConnectionId: 22, eligible: false, revisions: { ...HEADS } });
    await service.runOnce();
    expect(log.info).toHaveBeenCalledExactlyOnceWith(RULES_CONVERSION_TICK_ACTION, expect.objectContaining({ stores_left: 1,
      not_eligible_store_ids: [22] }));
    repository.converted.add(22);
    const infoTicks = () => log.info.mock.calls.filter(([action]) => action === RULES_CONVERSION_TICK_ACTION).map(([, fields]) => fields);
    const debugTicks = () => log.debug.mock.calls.filter(([action]) => action === RULES_CONVERSION_TICK_ACTION);

    for (const [time, level] of [["2026-10-16T10:15:00.000Z", "debug"], ["2026-10-16T23:59:59.999Z", "debug"],
      ["2026-10-17T00:00:00.000Z", "info"], ["2026-10-17T00:59:59.999Z", "info"], ["2026-10-17T01:00:00.000Z", "debug"]] as const) {
      const [infoBefore, debugBefore] = [infoTicks().length, debugTicks().length];
      clock.now.mockReturnValue(new Date(time));
      await service.runOnce();
      expect([infoTicks().length - infoBefore, debugTicks().length - debugBefore]).toEqual(level === "info" ? [1, 0] : [0, 1]);
    }
    // The latest INFO line now says nothing is left, with the hour's own job key.
    expect(infoTicks().at(-1)).toMatchObject({ job_key: "rules-conversion-job:2026-10-17T00", stores_left: 0, stores_checked: 0,
      not_eligible_store_ids: [], planner_version: 1 });
  });

  it.each([
    ["converted", "converted_store_ids", "converted_count", (id: number) => { eligible(id); }],
    ["not clean", "not_clean_stores", "not_clean_count", (id: number) => { eligible(id); diffs.set(id, notCleanDiff(1)); }],
    ["too large", "too_large_store_ids", "too_large_count", (id: number) => {
      eligible(id); repository.loads.set(id, loadOf(id, { state: "too_large", store: {} as never }));
    }],
    ["failed", "failed_store_ids", "failed_count", (id: number) => { eligible(id); repository.applies.set(id, invariant()); }],
    ["deferred", "deferred_store_ids", "deferred_count", (id: number) => { eligible(id); repository.applies.set(id, busy()); }],
    ["stopped by the cost source", "cost_source_failed_store_ids", "cost_source_failed_count", (id: number) => {
      eligible(id); repository.applies.set(id, invariant("DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE"));
    }],
    ["not eligible", "not_eligible_store_ids", "not_eligible_count", (id: number) => {
      source.stores.push({ vendorId: 11, storeConnectionId: id, eligible: false, revisions: { ...HEADS } });
    }],
    ["dead-lettered", "dead_lettered_store_ids", "dead_lettered_count", (id: number) => {
      eligible(id);
      repository.failureRows.push({ storeConnectionId: id, payload: { plannerVersion: RULES_CONVERSION_PLANNER_VERSION, revisions: { ...HEADS },
        stage: "apply", errorCode: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", errorClass: "fatal", causeCode: null, jobKey: "older-run" } });
    }],
  ] as const)("caps the %s ids at 100 with the full count beside them", async (_label, list, count, arrange) => {
    const many = Array.from({ length: 150 }, (_, index) => 30 + index);
    for (const storeConnectionId of many) arrange(storeConnectionId);

    await service.runOnce();

    const line = tickLine();
    expect(line[count]).toBe(150);
    const listed = line[list] as Array<number | { store_connection_id: number }>;
    expect(listed).toHaveLength(100);
    expect(listed.map((entry) => typeof entry === "number" ? entry : entry.store_connection_id)).toEqual(many.slice(0, 100));
  });

  it("fails the tick when the stores can't be listed (the runner logs it), having checked nothing", async () => {
    source.failure = busy("pool_acquire_timeout");
    await expect(service.runOnce()).rejects.toBe(source.failure);
    expect(repository.checks).toEqual([]);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("logs through the platform logger only: no console call in the runner, its factory, the source or the job service", () => {
    for (const file of [
      "server/modules/dropship/infrastructure/dropship-rules-conversion-runner.ts",
      "server/modules/dropship/infrastructure/dropship-rules-conversion.factory.ts",
      "server/modules/dropship/infrastructure/dropship-rules-conversion-job.source.ts",
      "server/modules/dropship/application/dropship-rules-conversion-job-service.ts",
    ]) {
      const text = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(text).not.toMatch(/\bconsole\./);
      // Never a session advisory lock on the pooled handle (CLAUDE.md §9).
      expect(text).not.toMatch(/pg_advisory_lock\(/);
    }
  });
});
