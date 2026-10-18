import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ZodError } from "zod";
import {
  CONVERSION_PAGE_SIZE,
  LISTING_RULES_CONVERSION_ERROR_CODES,
  listingRulesConversionCheckSchema,
  listingRulesConversionNoticeResponseSchema,
  type ListingRuleConversionRecord,
} from "../../../../../shared/dropship/listing-rules-conversion";
import { checkRulesConversion, conversionCheckView, type ConversionInputs } from "../../application/dropship-listing-rules-conversion";
import { buildListingSettingsFacts } from "../../application/dropship-listing-settings-facts";
import {
  CONVERSION_CHECK_RETRY_AFTER_SECONDS,
  DropshipListingSettingsService,
  conversionCostReadFailedError,
  type ListingSettingsConversionLoad,
  type ListingSettingsConversionNoticeRead,
  type ListingSettingsRepository,
} from "../../application/dropship-listing-settings-service";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import { DropshipError } from "../../domain/errors";
import {
  COST_PLUS_10, COST_PLUS_40, STORE, SLEEVES, availableCost, byCategory, candidate, conversionInputs, deepFreeze, inCategory,
  listingInputs, pricingState, storeContext,
} from "../fixtures/listing-rules-conversion.fixture";

/*
 * The rules conversion's dry run in the read service (PR 11, plan 4.B.1,
 * 4.B.4): one load per request through the repository port, the 11a1
 * planner over what it loaded, one page of the answer with the injected
 * clock. The planner's own cases are its tests; these pin what the service
 * adds: the member check, the refusals, the cost read failure, the page and
 * the clock, and that nothing is cached or planned when it need not be.
 */

// The read model's builder, observed: the dry run must build no facts for a store it does not plan.
vi.mock("../../application/dropship-listing-settings-facts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../application/dropship-listing-settings-facts")>();
  return { ...actual, buildListingSettingsFacts: vi.fn(actual.buildListingSettingsFacts) };
});

const T0 = new Date("2026-10-15T09:30:00.000Z");
const MEMBER = "member-1";

/**
 * The Binders shape (plan CMC#1): a product whose copy of the category name
 * is "Binders" and that is in no Card Shellz category, a "Binders" group at
 * cost + 40% and a store default of cost + 10%. No category is called
 * "Binders", so the group writes nothing and every size would follow the
 * store default: one changed row per size, `not_clean`.
 */
function bindersStore(sizes: number): ConversionInputs {
  const candidates = Array.from({ length: sizes }, (_, index) => candidate({
    productVariantId: 1_001 + index, productId: 501, productName: "Binder", variantName: `Size ${String(index).padStart(3, "0")}`,
    category: "Binders" }));
  return conversionInputs(listingInputs(candidates, {
    pricing: pricingState([{ id: "binders", name: "Binders rule", priority: 10, scope: byCategory("Binders"), value: COST_PLUS_40 }],
      COST_PLUS_10),
    costs: new Map(candidates.map((row) => [row.productVariantId, availableCost(800)])),
  }));
}

/** A store with no older rules: one chosen size, no profiles. */
function storeWithoutRules(): ConversionInputs {
  return conversionInputs(listingInputs([inCategory(SLEEVES, { productVariantId: 2_001, productId: 601 })]));
}

/** A load the test settles by hand, to hold a check in flight. */
interface HeldLoad { input: { memberId: string; storeConnectionId: number; now: Date }; settle: (load: ListingSettingsConversionLoad | null) => void;
  fail: (error: unknown) => void }

class FakeRepository implements ListingSettingsRepository {
  next: ListingSettingsConversionLoad | null = { state: "ok", inputs: bindersStore(3), costReadFailure: null };
  conversionLoads: Array<{ memberId: string; storeConnectionId: number; now: Date }> = [];
  /** When set, every load waits in `held` until the test settles it. */
  holdLoads = false;
  held: HeldLoad[] = [];
  async loadConversionInputs(input: { memberId: string; storeConnectionId: number; now: Date }) {
    this.conversionLoads.push(input);
    if (!this.holdLoads) return this.next;
    return new Promise<ListingSettingsConversionLoad | null>((settle, fail) => { this.held.push({ input, settle, fail }); });
  }
  // The dry run reads none of the views' inputs: it is never cached, so it needs no fingerprint either.
  readFingerprint = vi.fn(async (): Promise<string | null> => { throw new Error("The dry run read the views' fingerprint."); });
  load = vi.fn(async (): Promise<never> => { throw new Error("The dry run loaded the views."); });
  readProductOwnSettings = vi.fn(async (): Promise<never> => { throw new Error("The dry run read a product's own settings."); });
  /** The one-time notice's read (11e1): what the next one answers, and every one made. */
  notice: ListingSettingsConversionNoticeRead | null | Error = { state: "ok", conversion: null };
  noticeReads: Array<{ memberId: string; storeConnectionId: number }> = [];
  async readConversionNotice(input: { memberId: string; storeConnectionId: number }) {
    this.noticeReads.push(input);
    if (this.notice instanceof Error) throw this.notice;
    return this.notice;
  }
}

let repository: FakeRepository;
let clockReads: number;
let service: DropshipListingSettingsService;
type LogLine = Mock<(event: DropshipLogEvent) => void>;
let logged: { info: LogLine; warn: LogLine; error: LogLine };

beforeEach(() => {
  vi.mocked(buildListingSettingsFacts).mockClear();
  repository = new FakeRepository();
  clockReads = 0;
  logged = { info: vi.fn<(event: DropshipLogEvent) => void>(), warn: vi.fn<(event: DropshipLogEvent) => void>(),
    error: vi.fn<(event: DropshipLogEvent) => void>() };
  service = new DropshipListingSettingsService({
    repository,
    stock: {
      atp: { getVariantAtp: vi.fn(async () => { throw new Error("The dry run read stock."); }) },
      overrides: { listVariantOverrides: vi.fn(async () => { throw new Error("The dry run read stock caps."); }) },
    },
    clock: { now: () => { clockReads += 1; return T0; } },
    logger: logged,
  });
});

describe("listing settings service: the rules conversion's dry run (PR 11, plan 4.B)", () => {
  it("checks the store from one load stamped with the injected clock, and its answer passes the strict schema", async () => {
    const inputs = bindersStore(3);
    repository.next = { state: "ok", inputs, costReadFailure: null };
    const answer = await service.getConversionForMember(MEMBER, { storeConnectionId: STORE });

    expect(repository.conversionLoads).toEqual([{ memberId: MEMBER, storeConnectionId: STORE, now: T0 }]);
    expect(clockReads).toBe(1);
    expect(answer.generatedAt).toBe(T0.toISOString());
    expect(listingRulesConversionCheckSchema.parse(answer)).toEqual(answer);
    // The 11a1 planner's own answer over the same inputs, page and time: the service adds nothing of its own.
    const { plan, diff } = checkRulesConversion(inputs);
    expect(answer).toEqual(conversionCheckView(plan, diff, 0, T0));
    expect(answer).toMatchObject({ state: "not_clean", changes: { page: 0, pageSize: CONVERSION_PAGE_SIZE, total: 3 } });
    expect(answer.report.unmatched).toEqual({ total: 1, items: [{ ruleName: "Binders rule", categoryName: "Binders", kind: "price" }] });
    // A read: no fingerprint, no views, no stock, no line logged for an answer.
    expect(repository.readFingerprint).not.toHaveBeenCalled();
    expect(repository.load).not.toHaveBeenCalled();
    expect(repository.readProductOwnSettings).not.toHaveBeenCalled();
    expect([...logged.info.mock.calls, ...logged.warn.mock.calls, ...logged.error.mock.calls]).toEqual([]);
  });

  it("computes the check fresh on every request: nothing is kept between two reads", async () => {
    const first = await service.getConversionForMember(MEMBER, { storeConnectionId: STORE });
    repository.next = { state: "ok", inputs: bindersStore(4), costReadFailure: null };
    const second = await service.getConversionForMember(MEMBER, { storeConnectionId: STORE });
    expect(repository.conversionLoads).toHaveLength(2);
    expect([first.changes.total, second.changes.total]).toEqual([3, 4]);
    expect(second.planHash).not.toBe(first.planHash);
  });

  it("gives one page of 50 changed sizes, the same plan on every page, and an empty page past the last row", async () => {
    repository.next = { state: "ok", inputs: bindersStore(60), costReadFailure: null };
    const first = await service.getConversionForMember(MEMBER, { storeConnectionId: STORE });
    const second = await service.getConversionForMember(MEMBER, { storeConnectionId: STORE, page: 1 });
    const past = await service.getConversionForMember(MEMBER, { storeConnectionId: STORE, page: 199 });
    expect([first, second, past].map((answer) => [answer.changes.page, answer.changes.total, answer.changes.rows.length]))
      .toEqual([[0, 60, 50], [1, 60, 10], [199, 60, 0]]);
    expect(first.changes.rows.map((row) => row.productVariantId)).toEqual(Array.from({ length: 50 }, (_, index) => 1_001 + index));
    expect(second.changes.rows.map((row) => row.productVariantId)).toEqual(Array.from({ length: 10 }, (_, index) => 1_051 + index));
    expect(new Set([first, second, past].map((answer) => answer.planHash)).size).toBe(1);
    for (const answer of [first, second, past]) listingRulesConversionCheckSchema.parse(answer);
  });

  it.each([
    ["a page past 199", { storeConnectionId: STORE, page: 200 }],
    ["a negative page", { storeConnectionId: STORE, page: -1 }],
    ["a page that is not a whole number", { storeConnectionId: STORE, page: 1.5 }],
    ["a page sent as text", { storeConnectionId: STORE, page: "1" }],
    ["a store id of 0", { storeConnectionId: 0 }],
    ["a store id past int4", { storeConnectionId: 2_147_483_648 }],
    ["a store id that is not a number", { storeConnectionId: Number.NaN }],
    ["an unknown key", { storeConnectionId: STORE, sizes: [1] }],
  ])("refuses %s before reading anything", async (_case, input) => {
    await expect(service.getConversionForMember(MEMBER, input)).rejects.toBeInstanceOf(ZodError);
    expect(repository.conversionLoads).toEqual([]);
    expect(clockReads).toBe(0);
  });

  it("refuses a blank member before reading, and a store the member's vendor does not own (404's code)", async () => {
    await expect(service.getConversionForMember("  ", { storeConnectionId: STORE })).rejects.toMatchObject({ code: "DROPSHIP_AUTH_REQUIRED" });
    expect(repository.conversionLoads).toEqual([]);
    repository.next = null;
    await expect(service.getConversionForMember("member-2", { storeConnectionId: STORE }))
      .rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED", context: { storeConnectionId: STORE } });
    expect(repository.conversionLoads).toEqual([{ memberId: "member-2", storeConnectionId: STORE, now: T0 }]);
  });

  it("refuses a selection over 10,000 sizes and a store not on eBay with the other reads' 422 codes, planning nothing", async () => {
    repository.next = { state: "too_large", store: storeContext() };
    await expect(service.getConversionForMember(MEMBER, { storeConnectionId: STORE }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", context: { storeConnectionId: STORE } });
    repository.next = { state: "not_ebay", store: { ...storeContext(), platform: "shopify" } };
    await expect(service.getConversionForMember(MEMBER, { storeConnectionId: STORE }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", context: { storeConnectionId: STORE } });
    expect(buildListingSettingsFacts).not.toHaveBeenCalled();
  });

  it("answers a .ops cost read that timed out with the transient check-unavailable refusal, and plans nothing on the missing costs", async () => {
    // Inputs the planner would refuse (a name never looked up): reaching the planner would fail differently.
    const inputs = bindersStore(3);
    const timedOut = { stage: "variant_overrides", sqlState: "57014" };
    repository.next = { state: "ok", inputs: { ...inputs, categoriesByName: new Map() }, costReadFailure: timedOut };
    const failure = await service.getConversionForMember(MEMBER, { storeConnectionId: STORE }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DropshipError);
    expect(failure).toMatchObject({
      code: LISTING_RULES_CONVERSION_ERROR_CODES.checkUnavailable,
      context: { storeConnectionId: STORE, stage: "variant_overrides", sqlState: "57014", classification: "transient", retryable: true,
        retryAfterSeconds: CONVERSION_CHECK_RETRY_AFTER_SECONDS },
    });
    expect(CONVERSION_CHECK_RETRY_AFTER_SECONDS).toBe(60);
    expect(buildListingSettingsFacts).not.toHaveBeenCalled();
    // The same refusal for a store with no older rules: an answer is only ever built from a complete read.
    repository.next = { state: "ok", inputs: storeWithoutRules(), costReadFailure: timedOut };
    await expect(service.getConversionForMember(MEMBER, { storeConnectionId: STORE }))
      .rejects.toMatchObject({ code: LISTING_RULES_CONVERSION_ERROR_CODES.checkUnavailable });
    // The route logs the refusal (WARN); the service adds no line of its own.
    expect([...logged.info.mock.calls, ...logged.warn.mock.calls, ...logged.error.mock.calls]).toEqual([]);
  });

  it("fails as fatal, never as a retry, when the cost read failed in a way a retry cannot clear", async () => {
    repository.next = { state: "ok", inputs: bindersStore(2), costReadFailure: { stage: "variant_overrides", sqlState: "42P01" } };
    const failure = await service.getConversionForMember(MEMBER, { storeConnectionId: STORE }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DropshipError);
    expect(failure).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", context: { storeConnectionId: STORE,
      causeCode: "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE", stage: "variant_overrides", sqlState: "42P01",
      classification: "fatal", retryable: false } });
    expect((failure as DropshipError).context).not.toHaveProperty("retryAfterSeconds");
    expect(buildListingSettingsFacts).not.toHaveBeenCalled();
  });

  it.each([
    ["57014", "a statement timeout"], ["55P03", "a lock timeout"], ["53100", "a full disk"], ["53200", "no memory"],
    ["53300", "too many connections"], ["40001", "a serialization failure"], ["40P01", "a deadlock"],
  ])("classes a cost read failure with SQLSTATE %s (%s) as transient, retried after a minute", (sqlState) => {
    expect(conversionCostReadFailedError(STORE, { stage: "catalog_identity", sqlState })).toMatchObject({
      code: LISTING_RULES_CONVERSION_ERROR_CODES.checkUnavailable, context: { classification: "transient", retryAfterSeconds: 60 } });
  });

  it.each([
    ["42P01", "a missing table"], ["42703", "a missing column"], ["22P02", "bad stored data"], ["25006", "a write in a read-only snapshot"],
    ["XX000", "an internal error"], [null, "no SQLSTATE (the adapter's own refusal, such as ambiguous membership settings)"],
  ] as Array<[string | null, string]>)("classes a cost read failure with SQLSTATE %s (%s) as fatal, never retried", (sqlState) => {
    const error = conversionCostReadFailedError(STORE, { stage: "channel_settings", sqlState });
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      context: { storeConnectionId: STORE, stage: "channel_settings", sqlState, classification: "fatal", retryable: false } });
    expect(error.context).not.toHaveProperty("retryAfterSeconds");
  });

  it("answers a store with no older rules without planning it: no facts are built, no hashes, no rows", async () => {
    repository.next = { state: "ok", inputs: storeWithoutRules(), costReadFailure: null };
    const answer = await service.getConversionForMember(MEMBER, { storeConnectionId: STORE });
    expect(answer).toMatchObject({
      state: "no_older_rules", planHash: null, writesHash: null,
      olderRules: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 },
      changes: { page: 0, pageSize: CONVERSION_PAGE_SIZE, total: 0, rows: [] },
      becomes: { categories: { total: 0, items: [] }, products: { total: 0, items: [] } },
    });
    expect(listingRulesConversionCheckSchema.parse(answer)).toEqual(answer);
    expect(buildListingSettingsFacts).not.toHaveBeenCalled();
    // A store with rules builds the facts of both sides (the control for the line above).
    repository.next = { state: "ok", inputs: bindersStore(1), costReadFailure: null };
    await service.getConversionForMember(MEMBER, { storeConnectionId: STORE });
    expect(vi.mocked(buildListingSettingsFacts).mock.calls).toHaveLength(2);
  });

  it("never changes the inputs it checks", async () => {
    repository.next = deepFreeze({ state: "ok", inputs: bindersStore(5), costReadFailure: null });
    await expect(service.getConversionForMember(MEMBER, { storeConnectionId: STORE })).resolves.toMatchObject({ state: "not_clean" });
  });

  it("fails, never answers, when the loaded inputs break the planner's contract (a category name never looked up)", async () => {
    const inputs = bindersStore(2);
    repository.next = { state: "ok", inputs: { ...inputs, categoriesByName: new Map() }, costReadFailure: null };
    await expect(service.getConversionForMember(MEMBER, { storeConnectionId: STORE }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
  });
});

describe("listing settings service: overlapping dry runs share loads, and every answer is read after its request (review CS-1)", () => {
  const T1 = new Date("2026-10-15T09:30:05.000Z");
  /** Lets every pending promise chain run, so a run that can start has started. */
  const settled = () => new Promise<void>((resolve) => { setImmediate(resolve); });
  const ok = (sizes: number): ListingSettingsConversionLoad => ({ state: "ok", inputs: bindersStore(sizes), costReadFailure: null });
  /**
   * The runs the service keeps, by member and store: its private
   * `conversionChecks`, read through this narrow test-only cast so production
   * gains no getter. Nothing may be left once every run has settled (a kept
   * entry would hold its settled plan and diff for the life of the process).
   */
  const keptRuns = (of: DropshipListingSettingsService): ReadonlyMap<string, unknown> =>
    (of as unknown as { conversionChecks: ReadonlyMap<string, unknown> }).conversionChecks;

  beforeEach(() => {
    repository.holdLoads = true;
  });

  it("runs one load at a time per member and store: checks that arrive during a load share the next one, each on its own page", async () => {
    const first = service.getConversionForMember(MEMBER, { storeConnectionId: STORE });
    await settled();
    expect(repository.held).toHaveLength(1);
    // Three more checks while the first load runs: none starts a load of its own, and none can use the running one,
    // whose snapshot may predate them.
    const during = [0, 1, 0].map((page) => service.getConversionForMember(MEMBER, { storeConnectionId: STORE, page }));
    await settled();
    expect(repository.held).toHaveLength(1);

    repository.held[0].settle(ok(3));
    expect((await first).changes.total).toBe(3);
    await settled();
    // One more load, for all three, and only after the first settled.
    expect(repository.held).toHaveLength(2);
    repository.held[1].settle(ok(60));
    const answers = await Promise.all(during);
    expect(answers.map((answer) => [answer.changes.total, answer.changes.page, answer.changes.rows.length]))
      .toEqual([[60, 0, 50], [60, 1, 10], [60, 0, 50]]);
    expect(new Set(answers.map((answer) => answer.planHash)).size).toBe(1);
    expect(repository.conversionLoads).toHaveLength(2);
    // One clock read per load, when it starts.
    expect(clockReads).toBe(2);
    // Nothing is kept: the next check loads again.
    const after = service.getConversionForMember(MEMBER, { storeConnectionId: STORE });
    await settled();
    expect(repository.held).toHaveLength(3);
    repository.held[2].settle(ok(4));
    expect((await after).changes.total).toBe(4);
    expect(keptRuns(service).size).toBe(0);
  });

  it("keeps the waiting run that took a settled run's place: a check that arrives during the next load waits for it (review verify, coalescing 1)", async () => {
    const first = service.getConversionForMember(MEMBER, { storeConnectionId: STORE });
    await settled();
    // The second check waits behind load 1; load 1 settles, and the second check's run starts load 2.
    const second = service.getConversionForMember(MEMBER, { storeConnectionId: STORE });
    repository.held[0].settle(ok(3));
    expect((await first).changes.total).toBe(3);
    await settled();
    expect(repository.held).toHaveLength(2);
    // The third check arrives while load 2 runs: it makes the one waiting run, and no third load starts beside load 2.
    // The first run, settling, must not have deleted the second run's entry, or this check would load at once.
    const third = service.getConversionForMember(MEMBER, { storeConnectionId: STORE });
    await settled();
    expect(repository.held).toHaveLength(2);
    expect(keptRuns(service).size).toBe(1);
    repository.held[1].settle(ok(4));
    expect((await second).changes.total).toBe(4);
    await settled();
    // Only now, load 2 settled, does the third check's load start.
    expect(repository.held).toHaveLength(3);
    repository.held[2].settle(ok(5));
    expect((await third).changes.total).toBe(5);
    expect(repository.conversionLoads).toHaveLength(3);
    expect(keptRuns(service).size).toBe(0);
  });

  it("stamps each load's answers with the clock read when that load started, not when its first check arrived", async () => {
    const T2 = new Date("2026-10-15T09:30:07.000Z");
    let clockAt = T0;
    service = new DropshipListingSettingsService({ repository,
      stock: { atp: { getVariantAtp: vi.fn() }, overrides: { listVariantOverrides: vi.fn() } },
      clock: { now: () => { clockReads += 1; return clockAt; } }, logger: logged });
    const first = service.getConversionForMember(MEMBER, { storeConnectionId: STORE });
    await settled();
    // The second check arrives at T1, while load 1 runs, and makes the waiting run.
    clockAt = T1;
    const second = service.getConversionForMember(MEMBER, { storeConnectionId: STORE, page: 1 });
    await settled();
    // Load 1 settles at T2; only then does the waiting run's load start, so its answers carry T2, never T1.
    clockAt = T2;
    repository.held[0].settle(ok(3));
    await settled();
    repository.held[1].settle(ok(3));
    expect([(await first).generatedAt, (await second).generatedAt]).toEqual([T0.toISOString(), T2.toISOString()]);
    expect(repository.held.map((load) => load.input.now)).toEqual([T0, T2]);
    expect(clockReads).toBe(2);
    expect(keptRuns(service).size).toBe(0);
  });

  it("gives every check that shares a load that load's failure, and lets a later check load again", async () => {
    const first = service.getConversionForMember(MEMBER, { storeConnectionId: STORE });
    await settled();
    const shared = [service.getConversionForMember(MEMBER, { storeConnectionId: STORE }),
      service.getConversionForMember(MEMBER, { storeConnectionId: STORE, page: 1 })];
    // The running load fails: only its own check fails with it; the waiting run still loads.
    repository.held[0].fail(new Error("connection reset"));
    await expect(first).rejects.toThrow("connection reset");
    await settled();
    expect(repository.held).toHaveLength(2);
    repository.held[1].settle({ state: "ok", inputs: bindersStore(2), costReadFailure: { stage: "variant_overrides", sqlState: "57014" } });
    const failures = await Promise.all(shared.map((check) => check.catch((error: unknown) => error)));
    expect(failures[0]).toBe(failures[1]);
    expect(failures[0]).toMatchObject({ code: LISTING_RULES_CONVERSION_ERROR_CODES.checkUnavailable });

    const later = service.getConversionForMember(MEMBER, { storeConnectionId: STORE });
    await settled();
    expect(repository.held).toHaveLength(3);
    repository.held[2].settle(ok(1));
    await expect(later).resolves.toMatchObject({ changes: { total: 1 } });
    expect(keptRuns(service).size).toBe(0);
  });

  it("never shares a load across members or stores, and refuses a bad page before joining anything", async () => {
    const mine = service.getConversionForMember(MEMBER, { storeConnectionId: STORE });
    const theirs = service.getConversionForMember("member-2", { storeConnectionId: STORE });
    const otherStore = service.getConversionForMember(MEMBER, { storeConnectionId: STORE + 1 });
    await settled();
    expect(repository.held.map((load) => [load.input.memberId, load.input.storeConnectionId]))
      .toEqual([[MEMBER, STORE], ["member-2", STORE], [MEMBER, STORE + 1]]);
    await expect(service.getConversionForMember(MEMBER, { storeConnectionId: STORE, page: 200 })).rejects.toBeInstanceOf(ZodError);
    for (const load of repository.held) load.settle(ok(1));
    await Promise.all([mine, theirs, otherStore]);
    expect(repository.conversionLoads).toHaveLength(3);
    expect(keptRuns(service).size).toBe(0);
  });
});

describe("listing settings service: the one-time notice of a system conversion (11e1, plan 9.2, 9.3, D19)", () => {
  /** The record as the writer reads it back: a system conversion of STORE, unseen. */
  function systemRecord(overrides: Partial<ListingRuleConversionRecord> = {}): ListingRuleConversionRecord {
    return {
      id: 41, vendorId: 7, storeConnectionId: STORE, idempotencyKey: `rules-conversion:${STORE}`, requestHash: "a".repeat(64),
      planHash: "b".repeat(64), writesHash: "c".repeat(64), clean: true, changedSizeCount: 0, categoryCount: 2, productCount: 5,
      pricingGroupsRemoved: 1, contentGroupsRemoved: 0, ebayRulesRemoved: 2, actorType: "system", actorId: `rules-conversion:${STORE}`,
      createdAt: "2026-10-15T08:00:00.000Z", noticeSeenAt: null, noticeSeenBy: null, ...overrides,
    };
  }

  it("answers the store's unseen system conversion as its notice: its id, time and two counts, nothing else of the record", async () => {
    repository.notice = { state: "ok", conversion: systemRecord() };
    const answer = await service.getConversionNoticeForMember(MEMBER, { storeConnectionId: STORE });
    expect(answer).toEqual({ storeConnectionId: STORE,
      notice: { conversionId: 41, convertedAt: "2026-10-15T08:00:00.000Z", categoryCount: 2, productCount: 5 } });
    expect(listingRulesConversionNoticeResponseSchema.parse(answer)).toEqual(answer);
    expect(repository.noticeReads).toEqual([{ memberId: MEMBER, storeConnectionId: STORE }]);
    // One small read: no load, no plan, no clock (nothing is stamped), no view.
    expect(repository.conversionLoads).toEqual([]);
    expect(clockReads).toBe(0);
    expect(vi.mocked(buildListingSettingsFacts)).not.toHaveBeenCalled();
  });

  it("answers notice null when the store has none, and reads again on every request (never cached: a Got it elsewhere shows at once)", async () => {
    await expect(service.getConversionNoticeForMember(MEMBER, { storeConnectionId: STORE })).resolves.toEqual({ storeConnectionId: STORE, notice: null });
    repository.notice = { state: "ok", conversion: systemRecord({ categoryCount: 0, productCount: 0 }) };
    await expect(service.getConversionNoticeForMember(MEMBER, { storeConnectionId: STORE })).resolves.toMatchObject({
      notice: { categoryCount: 0, productCount: 0 } });
    repository.notice = { state: "ok", conversion: null };
    await expect(service.getConversionNoticeForMember(MEMBER, { storeConnectionId: STORE })).resolves.toMatchObject({ notice: null });
    expect(repository.noticeReads).toHaveLength(3);
  });

  it("refuses a bad store id and a blank member before reading, a store the member's vendor does not own (404) and a store not on eBay (422)", async () => {
    await expect(service.getConversionNoticeForMember(MEMBER, { storeConnectionId: 0 })).rejects.toBeInstanceOf(ZodError);
    await expect(service.getConversionNoticeForMember(MEMBER, { storeConnectionId: STORE, page: 0 })).rejects.toBeInstanceOf(ZodError);
    await expect(service.getConversionNoticeForMember("  ", { storeConnectionId: STORE })).rejects.toMatchObject({ code: "DROPSHIP_AUTH_REQUIRED" });
    expect(repository.noticeReads).toEqual([]);
    repository.notice = null;
    await expect(service.getConversionNoticeForMember(MEMBER, { storeConnectionId: STORE }))
      .rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED", context: { storeConnectionId: STORE } });
    repository.notice = { state: "not_ebay" };
    await expect(service.getConversionNoticeForMember(MEMBER, { storeConnectionId: STORE }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", context: { storeConnectionId: STORE } });
  });

  it("never shows a vendor's own conversion, one already seen, or another store's as the notice: a broken contract (fatal)", async () => {
    for (const conversion of [
      systemRecord({ actorType: "vendor", actorId: MEMBER, idempotencyKey: "ls-convert:0b8e7c1d-5f4a-4c3b-9a2e-1d0c9b8a7f6e" }),
      systemRecord({ noticeSeenAt: "2026-10-15T09:00:00.000Z", noticeSeenBy: MEMBER }),
      systemRecord({ storeConnectionId: STORE + 1 }),
    ]) {
      repository.notice = { state: "ok", conversion };
      const error = await service.getConversionNoticeForMember(MEMBER, { storeConnectionId: STORE }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(DropshipError);
      expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", context: { conversionId: 41, classification: "fatal" } });
    }
  });

  it("fails the request when the read fails", async () => {
    repository.notice = new Error("connection reset");
    await expect(service.getConversionNoticeForMember(MEMBER, { storeConnectionId: STORE })).rejects.toThrow("connection reset");
  });
});
