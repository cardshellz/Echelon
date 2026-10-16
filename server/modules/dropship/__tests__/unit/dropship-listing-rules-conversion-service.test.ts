import { describe, expect, it, vi } from "vitest";
import {
  listingRuleConversionRecordSchema,
  listingRulesConversionApplyResponseSchema,
  type ListingRuleConversionRecord,
} from "../../../../../shared/dropship/listing-rules-conversion";
import { MAX_STORE_LISTING_TEXT_BYTES } from "../../../../../shared/dropship/listing-setting-writes";
import { checkRulesConversion, type ConversionInputs } from "../../application/dropship-listing-rules-conversion";
import {
  RULES_CONVERSION_APPLIED_ACTION,
  RULES_CONVERSION_COST_READ_FAILED_ACTION,
  convertInTransaction,
  DropshipListingRulesConversionService,
  rulesConversionAppliedLogFields,
  rulesConversionCostReadReporter,
  rulesConversionRequestHash,
  rulesConversionSystemKey,
  type ConversionMode,
  type ListingRulesConversionExecuteInput,
  type ListingRulesConversionRepository,
  type ListingRulesConversionTransaction,
} from "../../application/dropship-listing-rules-conversion-service";
import { ListingSettingHeavyWriteGate } from "../../application/dropship-listing-setting-write-support";
import type { ListingSettingsInputs } from "../../application/dropship-listing-settings-facts";
import type { ListingSettingsConversionLoad } from "../../application/dropship-listing-settings-service";
import type { DropshipListingCatalogCandidate } from "../../application/dropship-listing-preview-service";
import { DropshipError } from "../../domain/errors";
import {
  COST_PLUS_10, COST_PLUS_40, EBAY_SLEEVES, EBAY_TOPLOADERS, MAILERS, RETAIL_PLUS_20, SLEEVES, STORE, TOPLOADERS, VENDOR,
  availableCost, byCategory, byProductLine, candidate, contentState, conversionInputs, deepFreeze, ebayRulesState, inCategory,
  listingInputs, pricingState, savedPrice, storeContext,
} from "../fixtures/listing-rules-conversion.fixture";

/*
 * The conversion's transaction body and the vendor's apply (plan 7.B.3,
 * 7.B.4 "Service DI"), over a fake transaction object that records every
 * call and answers from real planner inputs, so the plan, its hashes and its
 * blocks are the planner's own. The step order for both actors, a replay
 * that runs no writer, each refusal before any write and in the plan's order,
 * the cost read failure, nothing to convert, the system's outcomes, the
 * heavy-write gate, the INFO line and frozen inputs.
 */

const NOW = new Date("2026-10-15T09:00:00.000Z");
const MEMBER = "member-1";
const KEY = "ls-convert:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const JOB = "rules-conversion:2026-10-15T09";

const costs = (entries: Array<[number, number]>) => new Map(entries.map(([id, cents]) => [id, availableCost(cents)]));

/** The read model's inputs rebuilt with a patch (and other sizes), eBay categories resolved again as the load resolves them. */
function rebuilt(listing: ListingSettingsInputs, patch: Partial<Omit<ListingSettingsInputs, "candidates" | "ebayCategories">> = {},
  candidates: readonly DropshipListingCatalogCandidate[] = listing.candidates): ListingSettingsInputs {
  const { candidates: _candidates, ebayCategories: _ebayCategories, ...rest } = listing;
  return listingInputs(candidates, { ...rest, ...patch });
}

/**
 * Clean, with every write kind: a Sleeves price group (a category rule on a
 * chosen category), a Toploaders eBay rule (a category with no chosen
 * product), a product-line description group (product 2's own text), and
 * two products with no category mark (their first marks).
 */
function cleanStore(): ListingSettingsInputs {
  return listingInputs([
    inCategory(SLEEVES, { productVariantId: 101, productId: 1, productName: "Alpha sleeves" }),
    inCategory(MAILERS, { productVariantId: 201, productId: 2, productName: "Beta mailer", productLineIds: [9] }),
  ], {
    pricing: pricingState([{ id: "sleeves", name: "Sleeves price", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 }]),
    content: contentState([{ id: "line", name: "Line text", priority: 1, scope: byProductLine(9),
      value: { introduction: "Line above", footer: "Line below" } }]),
    ebayCategoryRules: ebayRulesState([{ id: "e-top", name: "Toploaders eBay", scope: byCategory("Toploaders"), category: EBAY_TOPLOADERS }]),
    costs: costs([[101, 800], [201, 600]]),
  });
}

/** Not clean and not blocked: a group no category has, under a size with no cost (its rule changes, its cents do not). */
function bindersStore(): ListingSettingsInputs {
  return listingInputs([candidate({ productVariantId: 101, productId: 1, productName: "Binder", category: "Binders" })], {
    pricing: pricingState([{ id: "binders", name: "Binders rule", priority: 10, scope: byCategory("Binders"), value: COST_PLUS_40 }], COST_PLUS_10),
    savedPrices: new Map([[101, savedPrice(101, { pricingMode: "inherit" })]]),
  });
}

/** D9a: a size priced today only by a group no category has, which the store default cannot price. */
function losesPriceStore(): ListingSettingsInputs {
  return listingInputs([candidate({ productVariantId: 101, productId: 1, productName: "Folder", category: "Folders" })], {
    pricing: pricingState([{ id: "folders", priority: 10, scope: byCategory("Folders"), value: RETAIL_PLUS_20 }], COST_PLUS_10),
    savedPrices: new Map([[101, savedPrice(101, { pricingMode: "rules" })]]),
  });
}

/** D9b: a listed size whose eBay category comes only from a rule no category has. */
function blocksListingStore(): ListingSettingsInputs {
  return listingInputs([candidate({ productVariantId: 101, productId: 1, productName: "Folder", category: "Folders",
    ebayBrowseCategoryId: null, ebayBrowseCategoryName: null })], {
    ebayCategoryRules: ebayRulesState([{ id: "folders", scope: byCategory("Folders"), category: EBAY_SLEEVES }], null),
    existingListings: new Map([[101, { listingId: 9_101, productVariantId: 101, status: "active", vendorRetailPriceCents: null,
      quantityCap: null, externalListingId: "v1|101|0" }]]),
  });
}

/** D9c: a line text that becomes product 1's own, 11 bytes, into a store at the cap's edge. */
function textStore(): ListingSettingsInputs {
  return listingInputs([candidate({ productVariantId: 101, productId: 1, productLineIds: [9] })], {
    content: contentState([{ id: "line", priority: 1, scope: byProductLine(9), value: { introduction: "Eleven char", footer: "" } }]),
  });
}

/** Every refusal at once: a lost price (101), a blocked listing (102) and too much text, in one store. */
function everythingBlockedStore(): ConversionInputs {
  const listing = listingInputs([
    candidate({ productVariantId: 101, productId: 1, productName: "Folder", category: "Folders" }),
    candidate({ productVariantId: 102, productId: 2, productName: "Binder", category: "Binders", ebayBrowseCategoryId: null,
      ebayBrowseCategoryName: null, productLineIds: [9] }),
  ], {
    pricing: pricingState([{ id: "folders", priority: 10, scope: byCategory("Folders"), value: RETAIL_PLUS_20 }], COST_PLUS_10),
    ebayCategoryRules: ebayRulesState([{ id: "binders", scope: byCategory("Binders"), category: EBAY_SLEEVES }], null),
    content: contentState([{ id: "line", priority: 1, scope: byProductLine(9), value: { introduction: "Eleven char", footer: "" } }]),
    // 102 owns its price, so only its eBay category can block it.
    savedPrices: new Map([[101, savedPrice(101, { pricingMode: "rules" })],
      [102, savedPrice(102, { pricingMode: "fixed", overridePriceCents: 1_500 })]]),
    existingListings: new Map([[102, { listingId: 9_102, productVariantId: 102, status: "active", vendorRetailPriceCents: null,
      quantityCap: null, externalListingId: "v1|102|0" }]]),
  });
  return conversionInputs(listing, { storeTextBytes: MAX_STORE_LISTING_TEXT_BYTES });
}

/** The vendor's mode for these inputs: the hashes the dry run would show. */
function shownMode(inputs: ConversionInputs): Extract<ConversionMode, { kind: "vendor" }> {
  const { diff } = checkRulesConversion(inputs);
  if (diff.hashes === null) throw new Error("The fixture has no older rules.");
  return { kind: "vendor", expectedPlanHash: diff.hashes.planHash, expectedWritesHash: diff.hashes.writesHash };
}

const WRITERS = ["insertConversion", "saveCategories", "saveProducts", "savePricingProfile", "saveContentProfile",
  "saveEbayCategoryRules", "insertFirstCategoryMarks", "insertStoreAudit"] as const;

interface FakeOptions {
  actor?: "vendor" | "system";
  store?: ReturnType<typeof storeContext> | null;
  earlier?: ListingRuleConversionRecord | null;
  hasAny?: boolean;
  counts?: { pricingGroups: number; contentGroups: number; ebayCategoryRules: number };
  tooLarge?: boolean;
  /** What lockCatalog finds: every asked row unless it drops some. */
  dropLocked?: { categoryIds?: number[]; productIds?: number[]; productVariantIds?: number[] };
  load?: ListingSettingsConversionLoad;
  /** Replace a writer's answer. */
  answers?: Partial<Record<(typeof WRITERS)[number], unknown>>;
  failAt?: { call: string; error: unknown };
}

/** A transaction object over `inputs` that records every call; each answers as the repository would. */
class FakeTransaction implements ListingRulesConversionTransaction {
  readonly vendorId = VENDOR;
  readonly storeConnectionId = STORE;
  readonly actor: { actorType: "vendor" | "system"; actorId: string };
  readonly requestKey: string;
  readonly calls: Array<{ call: string; input?: unknown }> = [];

  constructor(private readonly inputs: ConversionInputs, private readonly options: FakeOptions = {}) {
    const system = options.actor === "system";
    this.actor = system ? { actorType: "system", actorId: JOB } : { actorType: "vendor", actorId: MEMBER };
    this.requestKey = system ? rulesConversionSystemKey(STORE) : KEY;
  }

  get names(): string[] {
    return this.calls.map((entry) => entry.call);
  }

  input<T>(call: string): T {
    return this.calls.find((entry) => entry.call === call)?.input as T;
  }

  private record(call: string, input?: unknown): void {
    this.calls.push({ call, ...(input === undefined ? {} : { input }) });
    if (this.options.failAt?.call === call) throw this.options.failAt.error;
  }

  async authorize() {
    this.record("authorize");
    return this.options.store === undefined ? storeContext() : this.options.store;
  }
  async findConversionByKey() {
    this.record("findConversionByKey");
    return this.options.earlier ?? null;
  }
  async hasAnyConversion() {
    this.record("hasAnyConversion");
    return this.options.hasAny ?? false;
  }
  async loadOlderGroupRuleCounts() {
    this.record("loadOlderGroupRuleCounts");
    const { pricing, content, ebayCategoryRules } = this.inputs.listing;
    return this.options.counts ?? { pricingGroups: pricing.profile?.groups.length ?? 0, contentGroups: content.profile?.groups.length ?? 0,
      ebayCategoryRules: ebayCategoryRules.profile?.rules.length ?? 0 };
  }
  async lockSelection() {
    this.record("lockSelection");
  }
  async listChosenIds(now: Date) {
    this.record("listChosenIds", now);
    if (this.options.tooLarge) return { state: "too_large" as const };
    const { candidates } = this.inputs.listing;
    const ascending = (ids: number[]) => [...new Set(ids)].sort((a, b) => a - b);
    return {
      state: "ok" as const,
      productVariantIds: ascending(candidates.map((row) => row.productVariantId)),
      productIds: ascending(candidates.map((row) => row.productId)),
      categoryIds: ascending([...candidates.flatMap((row) => row.categoryId === null ? [] : [row.categoryId]),
        ...[...this.inputs.categoriesByName.values()].flatMap((categories) => categories.map((category) => category.id))]),
    };
  }
  async lockCatalog(input: { categoryIds: readonly number[]; productIds: readonly number[]; productVariantIds: readonly number[] }) {
    this.record("lockCatalog", input);
    const drop = this.options.dropLocked ?? {};
    const keep = (ids: readonly number[], dropped: number[] = []) => ids.filter((id) => !dropped.includes(id));
    return { categoryIds: keep(input.categoryIds, drop.categoryIds), productIds: keep(input.productIds, drop.productIds),
      productVariantIds: keep(input.productVariantIds, drop.productVariantIds) };
  }
  async loadInputs(now: Date) {
    this.record("loadInputs", now);
    return this.options.load ?? { state: "ok" as const, inputs: this.inputs, costReadFailure: null };
  }
  async insertConversion(input: Parameters<ListingRulesConversionTransaction["insertConversion"]>[0]) {
    this.record("insertConversion", input);
    if (this.options.answers?.insertConversion !== undefined) return this.options.answers.insertConversion as ListingRuleConversionRecord;
    const { now, ...values } = input;
    return listingRuleConversionRecordSchema.parse({ id: 9_001, vendorId: VENDOR, storeConnectionId: STORE, idempotencyKey: this.requestKey,
      ...values, actorType: this.actor.actorType, actorId: this.actor.actorId, createdAt: now.toISOString(), noticeSeenAt: null,
      noticeSeenBy: null });
  }
  async saveCategories(input: Parameters<ListingRulesConversionTransaction["saveCategories"]>[0]) {
    this.record("saveCategories", input);
    if (this.options.answers?.saveCategories !== undefined) return this.options.answers.saveCategories as never;
    return input.categories.map((category) => ({ outcome: "changed" as const, row: null, before: null, changedFields: [],
      categoryName: `Category ${category.categoryId}` }));
  }
  async saveProducts(input: Parameters<ListingRulesConversionTransaction["saveProducts"]>[0]) {
    this.record("saveProducts", input);
    if (this.options.answers?.saveProducts !== undefined) return this.options.answers.saveProducts as never;
    return { changed: input.products.map((product, index) => ({ productId: product.productId, revisionId: 3_000 + index })),
      unchangedProductIds: [] };
  }
  async savePricingProfile(input: Parameters<ListingRulesConversionTransaction["savePricingProfile"]>[0]) {
    this.record("savePricingProfile", input);
    return { revisionId: 4_001, previousRevisionId: input.expectedRevisionId };
  }
  async saveContentProfile(input: Parameters<ListingRulesConversionTransaction["saveContentProfile"]>[0]) {
    this.record("saveContentProfile", input);
    return { revisionId: 4_501 };
  }
  async saveEbayCategoryRules(input: Parameters<ListingRulesConversionTransaction["saveEbayCategoryRules"]>[0]) {
    this.record("saveEbayCategoryRules", input);
    return { revisionId: 5_001 };
  }
  async insertFirstCategoryMarks(input: { productIds: readonly number[]; now: Date }) {
    this.record("insertFirstCategoryMarks", input);
    return { insertedProductIds: [...input.productIds] };
  }
  async insertStoreAudit(input: Parameters<ListingRulesConversionTransaction["insertStoreAudit"]>[0]) {
    this.record("insertStoreAudit", input);
  }
}

const READS_TO_LOAD = ["authorize", "findConversionByKey", "loadOlderGroupRuleCounts", "lockSelection", "listChosenIds", "lockCatalog",
  "loadInputs"];
const SYSTEM_READS_TO_LOAD = ["authorize", "hasAnyConversion", "loadOlderGroupRuleCounts", "lockSelection", "listChosenIds", "lockCatalog",
  "loadInputs"];

async function failure(promise: Promise<unknown>): Promise<DropshipError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DropshipError);
    return error as DropshipError;
  }
  throw new Error("Expected a refusal.");
}

function storedRecord(patch: Partial<ListingRuleConversionRecord> = {}): ListingRuleConversionRecord {
  return listingRuleConversionRecordSchema.parse({ id: 8_001, vendorId: VENDOR, storeConnectionId: STORE, idempotencyKey: KEY,
    requestHash: rulesConversionRequestHash(STORE, "c".repeat(64)), planHash: "c".repeat(64), writesHash: "d".repeat(64), clean: true,
    changedSizeCount: 0, categoryCount: 2, productCount: 1, pricingGroupsRemoved: 1, contentGroupsRemoved: 0, ebayRulesRemoved: 1,
    actorType: "vendor", actorId: MEMBER, createdAt: "2026-10-14T09:00:00.000Z", noticeSeenAt: null, noticeSeenBy: null, ...patch });
}

describe("convertInTransaction, the vendor (plan 7.B.3)", () => {
  it("runs plan 7.B.3's steps in order and writes the clean plan, each profile emptied with its default kept", async () => {
    const inputs = conversionInputs(cleanStore());
    const { plan, diff } = checkRulesConversion(inputs);
    expect(diff.state).toBe("clean");
    const tx = new FakeTransaction(inputs);
    const result = await convertInTransaction(tx, shownMode(inputs), NOW);

    expect(tx.names).toEqual([...READS_TO_LOAD, ...WRITERS]);
    expect(result).toMatchObject({ outcome: "converted", marksInserted: 2, record: { id: 9_001, clean: true, changedSizeCount: 0 } });
    const requestHash = rulesConversionRequestHash(STORE, diff.hashes!.planHash);
    expect(tx.input("insertConversion")).toEqual({ requestHash, planHash: diff.hashes!.planHash, writesHash: diff.hashes!.writesHash,
      clean: true, changedSizeCount: 0, categoryCount: 2, productCount: 1, pricingGroupsRemoved: 1, contentGroupsRemoved: 1,
      ebayRulesRemoved: 1, now: NOW });
    // Sleeves gets the price, Toploaders (no chosen product) the eBay category: ascending ids, each at the revision read.
    expect(tx.input("saveCategories")).toEqual({ requestHash, now: NOW, categories: [
      { categoryId: SLEEVES.id, expectedRevisionId: null, patch: { price: COST_PLUS_40 } },
      { categoryId: TOPLOADERS.id, expectedRevisionId: null, patch: { ebayCategory: EBAY_TOPLOADERS } },
    ] });
    expect(tx.input("saveProducts")).toEqual({ requestHash, now: NOW, products: [{ productId: 2, expectedRevisionId: null,
      patch: plan.products[0].patch }] });
    expect(plan.products[0].patch).toEqual({ textAbove: { mode: "own", text: "Line above" }, textBelow: { mode: "own", text: "Line below" } });
    expect(tx.input("savePricingProfile")).toEqual({ expectedRevisionId: 41, now: NOW, profile: { defaultRecipe: COST_PLUS_10, groups: [] } });
    expect(tx.input("saveContentProfile")).toEqual({ expectedRevisionId: 51, requestHash, now: NOW,
      profile: { defaultTemplate: inputs.listing.content.profile!.defaultTemplate, groups: [] } });
    expect(tx.input("saveEbayCategoryRules")).toEqual({ expectedRevisionId: 61, requestHash, now: NOW,
      profile: { version: 1, defaultCategory: inputs.listing.ebayCategoryRules.profile!.defaultCategory, rules: [] } });
    expect(tx.input("insertFirstCategoryMarks")).toEqual({ productIds: [1, 2], now: NOW });
    expect(tx.input("insertStoreAudit")).toEqual({ now: NOW, payload: {
      conversionId: 9_001, requestKey: KEY, planHash: diff.hashes!.planHash, writesHash: diff.hashes!.writesHash, clean: true,
      counts: { categories: 2, products: 1, changedSizes: 0, firstMarks: 2 },
      removed: {
        pricingGroups: [{ id: "sleeves", name: "Sleeves price", scopeType: "category" }],
        contentGroups: [{ id: "line", name: "Line text", scopeType: "product_line" }],
        ebayRules: [{ id: "e-top", name: "Toploaders eBay", scopeType: "category" }],
      },
      categoryIds: [SLEEVES.id, TOPLOADERS.id], productIds: [2],
      // The three profile revisions the move wrote: the index from this row to their audit rows.
      revisions: { pricing: 4_001, content: 4_501, ebayRules: 5_001 },
    } });
    // The clock is the caller's one reading, everywhere.
    expect(tx.input("listChosenIds")).toBe(NOW);
    expect(tx.input("loadInputs")).toBe(NOW);
  });

  it("applies a plan that is not clean but blocks nothing, recording it as not clean with its changed sizes", async () => {
    const inputs = conversionInputs(bindersStore());
    expect(checkRulesConversion(inputs).diff).toMatchObject({ state: "not_clean", rows: [{ productVariantId: 101 }] });
    const tx = new FakeTransaction(inputs);
    const result = await convertInTransaction(tx, shownMode(inputs), NOW);
    expect(result).toMatchObject({ outcome: "converted", record: { clean: false, changedSizeCount: 1 } });
    expect(tx.input("insertConversion")).toMatchObject({ clean: false, changedSizeCount: 1, categoryCount: 0, productCount: 0 });
    // Nothing to write on a category or product: only the emptied profile, the first mark and the audit row.
    expect(tx.names).toEqual([...READS_TO_LOAD, "insertConversion", "savePricingProfile", "insertFirstCategoryMarks", "insertStoreAudit"]);
  });

  it("answers a replay from the record under its key: same store and plan, no lock past the gate, no writer", async () => {
    const inputs = conversionInputs(cleanStore());
    const mode = shownMode(inputs);
    const earlier = storedRecord({ planHash: mode.expectedPlanHash, requestHash: rulesConversionRequestHash(STORE, mode.expectedPlanHash) });
    const tx = new FakeTransaction(inputs, { earlier });
    await expect(convertInTransaction(tx, mode, NOW)).resolves.toEqual({ outcome: "replayed", record: earlier });
    expect(tx.names).toEqual(["authorize", "findConversionByKey"]);
  });

  it.each([
    ["another plan", { requestHash: rulesConversionRequestHash(STORE, "e".repeat(64)) }, ["requestHash"]],
    ["another store", { storeConnectionId: 23 }, ["storeConnectionId"]],
  ])("refuses the key used for %s with DROPSHIP_IDEMPOTENCY_CONFLICT, writing nothing", async (_label, patch, mismatched) => {
    const inputs = conversionInputs(cleanStore());
    const mode = shownMode(inputs);
    const earlier = storedRecord({ planHash: mode.expectedPlanHash, requestHash: rulesConversionRequestHash(STORE, mode.expectedPlanHash),
      ...patch });
    const tx = new FakeTransaction(inputs, { earlier });
    const refused = await failure(convertInTransaction(tx, mode, NOW));
    expect(refused).toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT", context: { storeConnectionId: STORE, mismatched,
      retryable: false, classification: "permanent" } });
    expect(tx.names).toEqual(["authorize", "findConversionByKey"]);
  });

  it.each([
    ["the vendor", { vendorStatus: "suspended" }, "DROPSHIP_LISTING_VENDOR_BLOCKED"],
    ["the entitlement", { entitlementStatus: "lapsed" }, "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED"],
    ["the store", { storeStatus: "paused" }, "DROPSHIP_LISTING_STORE_BLOCKED"],
    ["the platform", { platform: "shopify" }, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY"],
  ])("refuses at the gate when %s may not change listing settings, before the replay read", async (_label, patch, code) => {
    const tx = new FakeTransaction(conversionInputs(cleanStore()), { store: { ...storeContext(), ...patch } as ReturnType<typeof storeContext> });
    expect((await failure(convertInTransaction(tx, shownMode(conversionInputs(cleanStore())), NOW))).code).toBe(code);
    expect(tx.names).toEqual(["authorize"]);
  });

  it("answers nothing to convert when the store holds no older rule now, taking no selection lock and writing nothing", async () => {
    const inputs = conversionInputs(cleanStore());
    const tx = new FakeTransaction(inputs, { counts: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 } });
    await expect(convertInTransaction(tx, shownMode(inputs), NOW)).resolves.toEqual({ outcome: "nothing_to_convert" });
    expect(tx.names).toEqual(["authorize", "findConversionByKey", "loadOlderGroupRuleCounts"]);
  });

  it("refuses more than 10,000 chosen sizes with the permanent 422 TOO_LARGE, before the catalog lock", async () => {
    const tx = new FakeTransaction(conversionInputs(cleanStore()), { tooLarge: true });
    const refused = await failure(convertInTransaction(tx, shownMode(conversionInputs(cleanStore())), NOW));
    expect(refused).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", context: { storeConnectionId: STORE,
      classification: "permanent" } });
    expect(refused.context).not.toHaveProperty("reason");
    expect(tx.names).toEqual(["authorize", "findConversionByKey", "loadOlderGroupRuleCounts", "lockSelection", "listChosenIds"]);
  });

  it("refuses CHANGED settings_changed when the writes differ, before comparing the plan hash", async () => {
    const inputs = conversionInputs(cleanStore());
    const mode = shownMode(inputs);
    for (const shown of [{ ...mode, expectedWritesHash: "0".repeat(64) }, { ...mode, expectedWritesHash: "0".repeat(64), expectedPlanHash: "1".repeat(64) }]) {
      const tx = new FakeTransaction(inputs);
      const refused = await failure(convertInTransaction(tx, shown, NOW));
      expect(refused).toMatchObject({ code: "DROPSHIP_LISTING_CONVERSION_CHANGED", context: { storeConnectionId: STORE,
        reason: "settings_changed", retryable: false, classification: "permanent" } });
      expect(tx.names).toEqual(READS_TO_LOAD);
    }
  });

  it("refuses CHANGED listed_changes_moved when only the plan hash differs: a cost arrived, the writes are the same", async () => {
    const shown = shownMode(conversionInputs(bindersStore()));
    // The Binders size gets a cost: its row now moves cents too, while the move writes exactly the same.
    const costed = conversionInputs(rebuilt(bindersStore(), { costs: costs([[101, 800]]) }));
    const now = shownMode(costed);
    expect(now.expectedWritesHash).toBe(shown.expectedWritesHash);
    expect(now.expectedPlanHash).not.toBe(shown.expectedPlanHash);
    const tx = new FakeTransaction(costed);
    const refused = await failure(convertInTransaction(tx, shown, NOW));
    expect(refused).toMatchObject({ code: "DROPSHIP_LISTING_CONVERSION_CHANGED", context: { storeConnectionId: STORE,
      reason: "listed_changes_moved", retryable: false, classification: "permanent" } });
    expect(tx.names).toEqual(READS_TO_LOAD);
  });

  it("refuses CHANGED for a shown plan that was clean when a size's rule changed since (the recomputed plan)", async () => {
    // The vendor saw the clean store; under the lock the Sleeves group's recipe has changed since, so the category write differs.
    const shown = shownMode(conversionInputs(cleanStore()));
    const later = conversionInputs(rebuilt(cleanStore(), {
      pricing: pricingState([{ id: "sleeves", name: "Sleeves price", priority: 10, scope: byCategory("Sleeves"), value: RETAIL_PLUS_20 }]) }));
    const tx = new FakeTransaction(later);
    const refused = await failure(convertInTransaction(tx, shown, NOW));
    expect(refused).toMatchObject({ code: "DROPSHIP_LISTING_CONVERSION_CHANGED", context: { reason: "settings_changed" } });
    expect(tx.names.some((name) => (WRITERS as readonly string[]).includes(name))).toBe(false);
  });

  it.each([
    ["D9a, a size that would lose its price", () => conversionInputs(losesPriceStore()), "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST",
      { sizeCount: 1, sizes: [{ productVariantId: 101, priceCents: 1_200 }] }],
    ["D9b, a listed size that would be blocked", () => conversionInputs(blocksListingStore()), "DROPSHIP_LISTING_CONVERSION_WOULD_BLOCK_LISTING",
      { sizeCount: 1, sizes: [{ productVariantId: 101, blockers: ["no_ebay_category"] }] }],
    ["D9c, product text past the store's cap", () => conversionInputs(textStore(), { storeTextBytes: MAX_STORE_LISTING_TEXT_BYTES - 10 }),
      "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { reason: "store_text_limit", textBytes: MAX_STORE_LISTING_TEXT_BYTES + 1,
        maxTextBytes: MAX_STORE_LISTING_TEXT_BYTES }],
  ])("refuses %s with its permanent 422, before any write, even with the shown hashes", async (_label, build, code, context) => {
    const inputs = build();
    const tx = new FakeTransaction(inputs);
    const refused = await failure(convertInTransaction(tx, shownMode(inputs), NOW));
    expect(refused).toMatchObject({ code, context: { storeConnectionId: STORE, ...context, retryable: false, classification: "permanent" } });
    expect(tx.names).toEqual(READS_TO_LOAD);
  });

  it("refuses in plan 7.B.3's order: a lost price first, then a blocked listing, then the text cap", async () => {
    const all = everythingBlockedStore();
    const { diff } = checkRulesConversion(all);
    expect([diff.blocked.wouldLosePrice.length, diff.blocked.wouldBlockListing.length, diff.blocked.tooMuchText]).toEqual([1, 1, true]);
    expect((await failure(convertInTransaction(new FakeTransaction(all), shownMode(all), NOW))).code).toBe("DROPSHIP_LISTING_PRICE_WOULD_BE_LOST");
    // Without the lost price (101 gets an exact price), the blocked listing is next; without both, the text.
    const priced = conversionInputs(rebuilt(all.listing,
      { savedPrices: new Map([...all.listing.savedPrices, [101, savedPrice(101, { pricingMode: "fixed", overridePriceCents: 1_200 })]]) }),
    { storeTextBytes: MAX_STORE_LISTING_TEXT_BYTES });
    expect((await failure(convertInTransaction(new FakeTransaction(priced), shownMode(priced), NOW))).code)
      .toBe("DROPSHIP_LISTING_CONVERSION_WOULD_BLOCK_LISTING");
    const unlisted = conversionInputs(rebuilt(priced.listing, { existingListings: new Map() }), { storeTextBytes: MAX_STORE_LISTING_TEXT_BYTES });
    expect((await failure(convertInTransaction(new FakeTransaction(unlisted), shownMode(unlisted), NOW))).code)
      .toBe("DROPSHIP_LISTING_SETTINGS_TOO_LARGE");
  });

  it("refuses a failed .ops cost read as the transient 503 with a minute's wait, before planning, writing nothing", async () => {
    const inputs = conversionInputs(cleanStore());
    const tx = new FakeTransaction(inputs, { load: { state: "ok", inputs, costReadFailure: { stage: "load_costs", sqlState: "57014" } } });
    const refused = await failure(convertInTransaction(tx, shownMode(inputs), NOW));
    expect(refused).toMatchObject({ code: "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE", context: { storeConnectionId: STORE,
      classification: "transient", retryable: true, retryAfterSeconds: 60, sqlState: "57014" } });
    expect(tx.names).toEqual(READS_TO_LOAD);
  });

  it("refuses a cost read that no retry clears as the fatal invariant (causeCode), never a 503 retried forever", async () => {
    const inputs = conversionInputs(cleanStore());
    const tx = new FakeTransaction(inputs, { load: { state: "ok", inputs, costReadFailure: { stage: "load_costs", sqlState: "42P01" } } });
    expect(await failure(convertInTransaction(tx, shownMode(inputs), NOW))).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      context: { causeCode: "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE", classification: "fatal" } });
  });

  it.each([
    ["a chosen size deleted before its lock", { dropLocked: { productVariantIds: [201] } }],
    ["a product deleted before its lock", { dropLocked: { productIds: [2] } }],
    ["a category deleted before its lock", { dropLocked: { categoryIds: [TOPLOADERS.id] } }],
  ])("answers %s with the transient BUSY catalog_changed, before loading", async (_label, options) => {
    const inputs = conversionInputs(cleanStore());
    const tx = new FakeTransaction(inputs, options);
    expect(await failure(convertInTransaction(tx, shownMode(inputs), NOW))).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY",
      context: { reason: "catalog_changed", retryAfterSeconds: 5, retryable: true, classification: "transient" } });
    expect(tx.names).toEqual(READS_TO_LOAD.slice(0, -1));
  });

  it("answers a size Card Shellz added between the chosen read and the load with BUSY catalog_changed, writing nothing", async () => {
    const inputs = conversionInputs(cleanStore());
    const grown = conversionInputs(rebuilt(inputs.listing, {}, [...inputs.listing.candidates,
      inCategory(SLEEVES, { productVariantId: 102, productId: 1, productName: "Alpha sleeves" })]));
    const tx = new FakeTransaction(inputs, { load: { state: "ok", inputs: grown, costReadFailure: null } });
    expect((await failure(convertInTransaction(tx, shownMode(inputs), NOW))).context).toMatchObject({ reason: "catalog_changed" });
    const over = new FakeTransaction(inputs, { load: { state: "too_large", store: storeContext() } });
    expect((await failure(convertInTransaction(over, shownMode(inputs), NOW))).context).toMatchObject({ reason: "catalog_changed" });
    expect([...tx.names, ...over.names].some((name) => (WRITERS as readonly string[]).includes(name))).toBe(false);
  });

  it.each([
    // Size 201 moved from product 2 to product 3, or product 2 from Mailers to a new category 14, after step 7 read it:
    // step 8 locked product 2 and Mailers, so the moved-to row is not held (FOR SHARE holds only what it finds).
    ["a size moved to another product", (candidate: DropshipListingCatalogCandidate) => ({ ...candidate, productId: 3 })],
    ["a product moved to another category", (candidate: DropshipListingCatalogCandidate) => ({ ...candidate, categoryId: 14,
      category: "Binders" })],
  ])("answers %s between the chosen read and the load (not locked) with BUSY catalog_changed, writing nothing", async (_label, move) => {
    const inputs = conversionInputs(cleanStore());
    const moved = conversionInputs(rebuilt(inputs.listing, {}, inputs.listing.candidates.map((candidate) =>
      candidate.productVariantId === 201 ? move(candidate) : candidate)), { catalog: [MAILERS, SLEEVES, TOPLOADERS, { id: 14, name: "Binders" }] });
    const tx = new FakeTransaction(inputs, { load: { state: "ok", inputs: moved, costReadFailure: null } });
    expect(await failure(convertInTransaction(tx, shownMode(inputs), NOW))).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY",
      context: { reason: "catalog_changed", retryAfterSeconds: 5, retryable: true, classification: "transient" } });
    expect(tx.names).toEqual(READS_TO_LOAD);
    // The system's clean store answers the same transient refusal, never the fatal invariant a dead letter would follow.
    const system = new FakeTransaction(inputs, { actor: "system", load: { state: "ok", inputs: moved, costReadFailure: null } });
    expect((await failure(convertInTransaction(system, { kind: "system" }, NOW))).context).toMatchObject({ reason: "catalog_changed",
      classification: "transient" });
  });

  it("answers a category renamed to a rule's name since the chosen read (not locked) with BUSY catalog_changed", async () => {
    const inputs = conversionInputs(cleanStore());
    const renamed = conversionInputs(inputs.listing, { catalog: [MAILERS, SLEEVES, TOPLOADERS, { id: 14, name: "Toploaders" }] });
    const tx = new FakeTransaction(inputs, { load: { state: "ok", inputs: renamed, costReadFailure: null } });
    expect((await failure(convertInTransaction(tx, shownMode(inputs), NOW))).context).toMatchObject({ reason: "catalog_changed" });
  });

  it.each([
    ["the older rules' counts", { counts: { pricingGroups: 2, contentGroups: 1, ebayCategoryRules: 1 } }],
    ["a store that left eBay", { load: { state: "not_ebay" as const, store: storeContext() } }],
  ])("refuses a load that disagrees with %s under the locks as the fatal invariant", async (_label, options) => {
    const inputs = conversionInputs(cleanStore());
    const tx = new FakeTransaction(inputs, options);
    expect((await failure(convertInTransaction(tx, shownMode(inputs), NOW))).code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(tx.names.some((name) => (WRITERS as readonly string[]).includes(name))).toBe(false);
  });

  it.each([
    ["a category save that replayed", { saveCategories: [{ outcome: "replayed" }, { outcome: "changed" }] }],
    ["a category save that changed nothing", { saveCategories: [{ outcome: "changed" }, { outcome: "unchanged" }] }],
    ["a product left unchanged", { saveProducts: { changed: [], unchangedProductIds: [2] } }],
    ["a product the plan did not name", { saveProducts: { changed: [{ productId: 3, revisionId: 1 }], unchangedProductIds: [] } }],
  ])("refuses %s as the fatal invariant, before the profiles and the audit row", async (_label, answers) => {
    const inputs = conversionInputs(cleanStore());
    const tx = new FakeTransaction(inputs, { answers });
    expect((await failure(convertInTransaction(tx, shownMode(inputs), NOW))).code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(tx.names).not.toContain("insertStoreAudit");
    expect(tx.names).not.toContain("savePricingProfile");
  });

  it("passes a writer's failure through as it is (the repository rolls back and maps it)", async () => {
    const inputs = conversionInputs(cleanStore());
    const error = new DropshipError("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "conflict under the lock", { causeCode: "DROPSHIP_CONTENT_VERSION_CONFLICT" });
    const tx = new FakeTransaction(inputs, { failAt: { call: "saveContentProfile", error } });
    await expect(convertInTransaction(tx, shownMode(inputs), NOW)).rejects.toBe(error);
    expect(tx.names.at(-1)).toBe("saveContentProfile");
  });

  it("refuses a mode that is not its transaction's actor, and a clock that is not one, before any read", async () => {
    const inputs = conversionInputs(cleanStore());
    const system = new FakeTransaction(inputs, { actor: "system" });
    expect((await failure(convertInTransaction(system, shownMode(inputs), NOW))).code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    const vendor = new FakeTransaction(inputs);
    expect((await failure(convertInTransaction(vendor, shownMode(inputs), new Date(Number.NaN)))).code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect([...system.names, ...vendor.names]).toEqual([]);
  });

  it("changes no input: a frozen store converts exactly as a fresh one", async () => {
    const fresh = new FakeTransaction(conversionInputs(cleanStore()));
    const frozenInputs = deepFreeze(conversionInputs(cleanStore()));
    const frozen = new FakeTransaction(frozenInputs);
    const mode = shownMode(conversionInputs(cleanStore()));
    const [left, right] = [await convertInTransaction(fresh, mode, NOW), await convertInTransaction(frozen, mode, NOW)];
    expect(right).toEqual(left);
    expect(frozen.calls).toEqual(fresh.calls);
  });
});

describe("convertInTransaction, the system (plan 7.B.3's system column, shared with 11e2)", () => {
  const system = { kind: "system" } as const;

  it("checks every store again and writes a clean one, recorded clean, as the system, with no request lock or replay read", async () => {
    const inputs = conversionInputs(cleanStore());
    const tx = new FakeTransaction(inputs, { actor: "system" });
    const result = await convertInTransaction(tx, system, NOW);
    expect(tx.names).toEqual([...SYSTEM_READS_TO_LOAD, ...WRITERS]);
    expect(result).toMatchObject({ outcome: "converted", record: { clean: true, changedSizeCount: 0, actorType: "system", actorId: JOB,
      idempotencyKey: "rules-conversion:5" } });
    expect(tx.input("insertStoreAudit")).toMatchObject({ payload: { requestKey: "rules-conversion:5", clean: true } });
  });

  it("writes the same plan as the vendor's for the same store", async () => {
    const inputs = conversionInputs(cleanStore());
    const vendor = new FakeTransaction(inputs);
    const job = new FakeTransaction(inputs, { actor: "system" });
    await convertInTransaction(vendor, shownMode(inputs), NOW);
    await convertInTransaction(job, system, NOW);
    for (const writer of WRITERS.filter((name) => name !== "insertStoreAudit")) expect(job.input(writer)).toEqual(vendor.input(writer));
  });

  it.each([
    ["not clean (a changed size)", () => conversionInputs(bindersStore()), { changedSizeCount: 1, wouldLosePriceCount: 0,
      wouldBlockListingCount: 0, tooMuchText: false }],
    ["blocked (a lost price)", () => conversionInputs(losesPriceStore()), { changedSizeCount: 1, wouldLosePriceCount: 1,
      wouldBlockListingCount: 0, tooMuchText: false }],
    ["blocked by the text cap alone", () => conversionInputs(textStore(), { storeTextBytes: MAX_STORE_LISTING_TEXT_BYTES - 10 }),
      { changedSizeCount: 0, wouldLosePriceCount: 0, wouldBlockListingCount: 0, tooMuchText: true }],
  ])("answers not_clean for a store %s and writes nothing (plan D1)", async (_label, build, counts) => {
    const tx = new FakeTransaction(build(), { actor: "system" });
    await expect(convertInTransaction(tx, system, NOW)).resolves.toEqual({ outcome: "not_clean", ...counts });
    expect(tx.names).toEqual(SYSTEM_READS_TO_LOAD);
  });

  it.each([
    ["no store context", null, "store_not_found"],
    ["a store not on eBay", { ...storeContext(), platform: "shopify" as const }, "not_ebay"],
    ["a suspended vendor", { ...storeContext(), vendorStatus: "suspended" as const }, "vendor_not_eligible"],
    ["a paused store", { ...storeContext(), storeStatus: "paused" as const }, "store_not_eligible"],
  ])("skips %s at the gate (plan 13.2), reading nothing more", async (_label, store, reason) => {
    const tx = new FakeTransaction(conversionInputs(cleanStore()), { actor: "system", store: store as ReturnType<typeof storeContext> | null });
    await expect(convertInTransaction(tx, system, NOW)).resolves.toEqual({ outcome: "skipped", reason });
    expect(tx.names).toEqual(["authorize"]);
  });

  it.each(["onboarding", "active"])("converts for a vendor that is %s, and a store that needs a sign-in", async (vendorStatus) => {
    for (const storeStatus of ["connected", "needs_reauth", "refresh_failed"]) {
      const tx = new FakeTransaction(conversionInputs(cleanStore()), { actor: "system",
        store: { ...storeContext(), vendorStatus, storeStatus } as ReturnType<typeof storeContext> });
      await expect(convertInTransaction(tx, system, NOW)).resolves.toMatchObject({ outcome: "converted" });
    }
  });

  it("never converts a store a second time: any record of it answers already_converted (plan D20)", async () => {
    const tx = new FakeTransaction(conversionInputs(cleanStore()), { actor: "system", hasAny: true });
    await expect(convertInTransaction(tx, system, NOW)).resolves.toEqual({ outcome: "already_converted" });
    expect(tx.names).toEqual(["authorize", "hasAnyConversion"]);
  });

  it("answers too_large and nothing_to_convert as outcomes, writing nothing", async () => {
    const large = new FakeTransaction(conversionInputs(cleanStore()), { actor: "system", tooLarge: true });
    await expect(convertInTransaction(large, system, NOW)).resolves.toEqual({ outcome: "too_large" });
    const none = new FakeTransaction(conversionInputs(cleanStore()), { actor: "system",
      counts: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 } });
    await expect(convertInTransaction(none, system, NOW)).resolves.toEqual({ outcome: "nothing_to_convert" });
  });

  it("refuses a cost read failure for the system too (the job defers it)", async () => {
    const inputs = conversionInputs(cleanStore());
    const tx = new FakeTransaction(inputs, { actor: "system", load: { state: "ok", inputs, costReadFailure: { stage: "load", sqlState: "55P03" } } });
    expect((await failure(convertInTransaction(tx, system, NOW))).code).toBe("DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE");
  });
});

/** A repository whose transaction is a FakeTransaction; `hold` keeps the transaction open until released. */
class FakeRepository implements ListingRulesConversionRepository {
  readonly opened: ListingRulesConversionExecuteInput[] = [];
  tx: FakeTransaction;
  hold: Promise<void> | null = null;
  constructor(inputs: ConversionInputs, options: FakeOptions = {}) {
    this.tx = new FakeTransaction(inputs, options);
  }
  async executeConversion<T>(input: ListingRulesConversionExecuteInput, operation: (tx: ListingRulesConversionTransaction) => Promise<T>): Promise<T> {
    this.opened.push(input);
    if (this.hold) await this.hold;
    return operation(this.tx);
  }
}

function service(repository: ListingRulesConversionRepository, overrides: { heavyWrites?: ListingSettingHeavyWriteGate; ticks?: number[] } = {}) {
  const lines: Array<{ action: string; fields: Record<string, unknown> }> = [];
  const ticks = [...(overrides.ticks ?? [1_000, 1_250])];
  const clockReads: Date[] = [];
  const subject = new DropshipListingRulesConversionService({
    repository,
    clock: { now: () => { clockReads.push(NOW); return NOW; } },
    timer: () => ticks.shift() ?? 9_999,
    log: { info: (action, fields) => lines.push({ action, fields }) },
    heavyWrites: overrides.heavyWrites ?? new ListingSettingHeavyWriteGate(),
  });
  return { subject, lines, clockReads };
}

describe("DropshipListingRulesConversionService.applyForMember (plan 7.B.2)", () => {
  const body = (inputs: ConversionInputs, patch: Record<string, unknown> = {}) => {
    const mode = shownMode(inputs);
    return { idempotencyKey: KEY, planHash: mode.expectedPlanHash, writesHash: mode.expectedWritesHash, ...patch };
  };

  it("opens the vendor's transaction, converts, answers the record, and logs one INFO line with elapsed_ms from the timer", async () => {
    const inputs = conversionInputs(cleanStore());
    const repository = new FakeRepository(inputs);
    const { subject, lines, clockReads } = service(repository);
    const answer = await subject.applyForMember(MEMBER, STORE, body(inputs));
    expect(answer).toEqual({ outcome: "converted", conversionId: 9_001, categoryCount: 2, productCount: 1 });
    expect(listingRulesConversionApplyResponseSchema.parse(answer)).toEqual(answer);
    expect(repository.opened).toEqual([{ actorType: "vendor", memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: KEY }]);
    expect(clockReads).toHaveLength(1);
    const { diff } = checkRulesConversion(inputs);
    expect(lines).toEqual([{ action: RULES_CONVERSION_APPLIED_ACTION, fields: {
      outcome: "converted", vendor_id: VENDOR, store_connection_id: STORE, actor_type: "vendor", actor_id: MEMBER, request_key: KEY,
      conversion_id: 9_001, plan_hash: diff.hashes!.planHash, clean: true, category_count: 2, product_count: 1,
      pricing_groups_removed: 1, content_groups_removed: 1, ebay_rules_removed: 1, changed_size_count: 0, marks_inserted: 2,
      before: { pricing_groups: 1, content_groups: 1, ebay_rules: 1 }, after: { pricing_groups: 0, content_groups: 0, ebay_rules: 0 },
      elapsed_ms: 250,
    } }]);
    // Ids and counts only: no rule, product or category name, and no text.
    expect(JSON.stringify(lines)).not.toMatch(/Sleeves|Line above|Alpha|Toploaders/);
  });

  it("answers a replay from its record and logs it as replayed, with what it does not know as null", async () => {
    const inputs = conversionInputs(cleanStore());
    const shown = body(inputs);
    const earlier = storedRecord({ planHash: shown.planHash as string, requestHash: rulesConversionRequestHash(STORE, shown.planHash as string) });
    const repository = new FakeRepository(inputs, { earlier });
    const { subject, lines } = service(repository);
    await expect(subject.applyForMember(MEMBER, STORE, shown)).resolves.toEqual({ outcome: "replayed", conversionId: 8_001,
      categoryCount: 2, productCount: 1 });
    expect(lines[0].fields).toMatchObject({ outcome: "replayed", conversion_id: 8_001, marks_inserted: null, before: null, after: null });
    expect(repository.tx.names).toEqual(["authorize", "findConversionByKey"]);
  });

  it("answers nothing to convert with no record and both counts 0", async () => {
    const inputs = conversionInputs(cleanStore());
    const repository = new FakeRepository(inputs, { counts: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 } });
    const { subject, lines } = service(repository);
    const answer = await subject.applyForMember(MEMBER, STORE, body(inputs));
    expect(answer).toEqual({ outcome: "nothing_to_convert", conversionId: null, categoryCount: 0, productCount: 0 });
    expect(listingRulesConversionApplyResponseSchema.parse(answer)).toEqual(answer);
    expect(lines[0].fields).toMatchObject({ outcome: "nothing_to_convert", conversion_id: null, marks_inserted: 0 });
  });

  it.each([
    ["a key of 7 characters", { idempotencyKey: "abcdefg" }],
    ["a plan hash in capitals", { planHash: "A".repeat(64) }],
    ["a short writes hash", { writesHash: "a".repeat(63) }],
    ["an unknown field", { storeConnectionId: STORE }],
  ])("refuses %s with the permanent 400 before any transaction", async (_label, patch) => {
    const repository = new FakeRepository(conversionInputs(cleanStore()));
    const { subject, lines } = service(repository);
    const refused = await failure(subject.applyForMember(MEMBER, STORE, body(conversionInputs(cleanStore()), patch)));
    expect(refused).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", context: { classification: "permanent" } });
    expect(repository.opened).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("refuses a missing member and a bad store id before any transaction", async () => {
    const repository = new FakeRepository(conversionInputs(cleanStore()));
    const { subject } = service(repository);
    expect((await failure(subject.applyForMember(" ", STORE, body(conversionInputs(cleanStore()))))).code).toBe("DROPSHIP_AUTH_REQUIRED");
    expect((await failure(subject.applyForMember(MEMBER, 0, body(conversionInputs(cleanStore()))))).code).toBe("DROPSHIP_LISTING_SETTINGS_INVALID_INPUT");
    expect(repository.opened).toEqual([]);
  });

  it("refuses while another heavy write holds the factory's gate, before opening its transaction (plan 3.10 (a))", async () => {
    const gate = new ListingSettingHeavyWriteGate();
    let release!: () => void;
    const held = gate.run(() => new Promise<void>((done) => { release = done; }));
    const repository = new FakeRepository(conversionInputs(cleanStore()));
    const { subject } = service(repository, { heavyWrites: gate });
    expect(await failure(subject.applyForMember(MEMBER, STORE, body(conversionInputs(cleanStore()))))).toMatchObject({
      code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: { reason: "heavy_write_in_progress", classification: "transient" } });
    expect(repository.opened).toEqual([]);
    release();
    await held;
    await expect(subject.applyForMember(MEMBER, STORE, body(conversionInputs(cleanStore())))).resolves.toMatchObject({ outcome: "converted" });
  });

  it("holds the gate for its own transaction: a second heavy write waits it out with BUSY", async () => {
    const gate = new ListingSettingHeavyWriteGate();
    const repository = new FakeRepository(conversionInputs(cleanStore()));
    let release!: () => void;
    repository.hold = new Promise<void>((done) => { release = done; });
    const { subject } = service(repository, { heavyWrites: gate });
    const applying = subject.applyForMember(MEMBER, STORE, body(conversionInputs(cleanStore())));
    await new Promise((resolve) => setImmediate(resolve));
    expect((await failure(gate.run(async () => "other heavy write"))).context).toMatchObject({ reason: "heavy_write_in_progress" });
    release();
    await expect(applying).resolves.toMatchObject({ outcome: "converted" });
    await expect(gate.run(async () => "after")).resolves.toBe("after");
  });

  it("logs nothing for a refusal (the route logs it once, by class)", async () => {
    const inputs = conversionInputs(cleanStore());
    const repository = new FakeRepository(inputs);
    const { subject, lines } = service(repository);
    expect((await failure(subject.applyForMember(MEMBER, STORE, body(inputs, { planHash: "1".repeat(64) })))).code)
      .toBe("DROPSHIP_LISTING_CONVERSION_CHANGED");
    expect(lines).toEqual([]);
  });

  it("refuses a system outcome reaching a vendor as the fatal invariant", async () => {
    const inputs = conversionInputs(cleanStore());
    const repository: ListingRulesConversionRepository = {
      executeConversion: async () => ({ result: { outcome: "already_converted" }, vendorId: VENDOR }) as never,
    };
    const { subject } = service(repository);
    expect((await failure(subject.applyForMember(MEMBER, STORE, body(inputs)))).code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
  });
});

describe("the conversion's keys and hashes (plan 3.3, D12)", () => {
  it("gives the system one key per store, ever, and refuses a store id that is not one", () => {
    expect(rulesConversionSystemKey(22)).toBe("rules-conversion:22");
    expect(() => rulesConversionSystemKey(0)).toThrow(DropshipError);
  });

  it("hashes the request by operation, store and plan hash only", () => {
    const hash = rulesConversionRequestHash(STORE, "a".repeat(64));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(rulesConversionRequestHash(STORE, "a".repeat(64))).toBe(hash);
    expect(rulesConversionRequestHash(STORE + 1, "a".repeat(64))).not.toBe(hash);
    expect(rulesConversionRequestHash(STORE, "b".repeat(64))).not.toBe(hash);
  });
});

describe("the lines both actors share (plan 3.5, D14)", () => {
  it("gives the system's converted transaction the vendor's 17 success fields, with the system as the actor", () => {
    const record = storedRecord({ actorType: "system", actorId: JOB, idempotencyKey: rulesConversionSystemKey(STORE) });
    expect(rulesConversionAppliedLogFields({ result: { outcome: "converted", record, marksInserted: 3 }, vendorId: VENDOR,
      storeConnectionId: STORE, actor: { actorType: "system", actorId: JOB }, requestKey: rulesConversionSystemKey(STORE), elapsedMs: 12 }))
      .toEqual({ outcome: "converted", vendor_id: VENDOR, store_connection_id: STORE, actor_type: "system", actor_id: JOB,
        request_key: rulesConversionSystemKey(STORE), conversion_id: 8_001, plan_hash: "c".repeat(64), clean: true, category_count: 2,
        product_count: 1, pricing_groups_removed: 1, content_groups_removed: 0, ebay_rules_removed: 1, changed_size_count: 0,
        marks_inserted: 3, before: { pricing_groups: 1, content_groups: 0, ebay_rules: 1 },
        after: { pricing_groups: 0, content_groups: 0, ebay_rules: 0 }, elapsed_ms: 12 });
  });

  it.each([
    ["a statement timeout (57014)", "57014", "warn", { outcome: "deferred", error_class: "transient" }],
    ["too many connections (53300)", "53300", "warn", { outcome: "deferred", error_class: "transient" }],
    ["a missing table (42P01)", "42P01", "debug", { outcome: "failed", error_class: "fatal" }],
    ["the adapter's own refusal (no SQLSTATE)", null, "debug", { outcome: "failed", error_class: "fatal" }],
  ] as const)("reports a failed cost read for %s at the level of the refusal it becomes", (_label, sqlState, level, verdict) => {
    const log = { warn: vi.fn(), debug: vi.fn() };
    rulesConversionCostReadReporter(log)({ vendorId: VENDOR, storeConnectionId: STORE, variantCount: 2, stage: "load_costs", sqlState });
    const other = level === "warn" ? log.debug : log.warn;
    expect(other).not.toHaveBeenCalled();
    // One line, ids and counts only: the stage and SQLSTATE the refusal's answer does not carry.
    expect(log[level]).toHaveBeenCalledTimes(1);
    expect(log[level]).toHaveBeenCalledWith(RULES_CONVERSION_COST_READ_FAILED_ACTION, { ...verdict,
      error_code: "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE", vendor_id: VENDOR, store_connection_id: STORE, variant_count: 2,
      stage: "load_costs", sql_state: sqlState });
  });
});
