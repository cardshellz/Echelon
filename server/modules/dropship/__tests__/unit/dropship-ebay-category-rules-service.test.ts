import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  DropshipEbayCategoryRulesService,
  hashEbayCategoryRulesRequest,
  permissionRequired,
  type EbayCategoryIdentity,
  type EbayCategoryRulesRepository,
  type EbayCategoryRulesTransaction,
  type EbayCategoryTaxonomy,
  type SaveEbayCategoryRulesProfileInput,
} from "../../application/dropship-ebay-category-rules-service";
import type { DropshipListingCatalogCandidate, DropshipListingStoreContext } from "../../application/dropship-listing-preview-service";
import { EMPTY_LISTING_SETTING_LAYERS, type ListingSettingLayers } from "../../application/dropship-listing-setting-layers";
import type { DropshipStoreListingConfig } from "../../application/dropship-marketplace-listing-provider";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import { DropshipError } from "../../domain/errors";
import { EMPTY_CATEGORY_LISTING_SETTING_VALUES, EMPTY_PRODUCT_LISTING_SETTING_VALUES } from "../../domain/listing-setting-values";
import type { CatalogScope } from "../../../../../shared/dropship/catalog-scope";
import type { EbayCategory, EbayCategoryBrowseResult, EbayCategoryOption, EbayCategoryRulesState } from "../../../../../shared/dropship/ebay-category-rules";
import { MAILERS, SLEEVES, TOPLOADERS, categoryCandidate, categoryOption, rulesProfile, rulesState } from "../fixtures/ebay-category-rules.fixture";

const NOW = new Date("2026-09-30T12:00:00.000Z");

class FakeRepository implements EbayCategoryRulesRepository {
  state: EbayCategoryRulesState = rulesState(null);
  context: DropshipListingStoreContext = {
    vendorId: 10, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: 44,
    storeStatus: "connected", setupStatus: "ready", platform: "ebay", storeLaunchReady: true,
  };
  config: DropshipStoreListingConfig | null = null;
  candidates: DropshipListingCatalogCandidate[] = [];
  revisions = new Map<string, { hash: string; storeConnectionId: number }>();
  executions: Array<{ mode: "read" | "write"; idempotencyKey?: string }> = [];
  saves: SaveEbayCategoryRulesProfileInput[] = [];
  layers: ListingSettingLayers = EMPTY_LISTING_SETTING_LAYERS;
  layerReads: Array<Array<{ productId: number; categoryId: number | null }>> = [];

  async execute<T>(
    input: Parameters<EbayCategoryRulesRepository["execute"]>[0],
    operation: (tx: EbayCategoryRulesTransaction) => Promise<T>,
  ): Promise<T> {
    this.executions.push({ mode: input.mode, idempotencyKey: input.idempotencyKey });
    const tx: EbayCategoryRulesTransaction = {
      vendorId: 10,
      catalog: {
        loadStoreContext: async () => this.context,
        listCatalogCandidates: async (ids) => this.candidates.filter((candidate) => ids.includes(candidate.productVariantId)),
        listCatalogExposureRules: async () => [{ id: 1, scopeType: "catalog", action: "include" }],
        listSelectionRules: async () => [{ id: 2, scopeType: "catalog", action: "include", autoConnectNewSkus: true, autoListNewSkus: true, isActive: true }],
        listVariantOverrides: async () => [],
        listExistingListings: async () => [],
      },
      listVariantIds: async (afterId, limit) => this.candidates.map((candidate) => candidate.productVariantId)
        .filter((id) => id > afterId).sort((left, right) => left - right).slice(0, limit),
      listProductLines: async () => [],
      loadState: async () => this.state,
      loadStoreListingConfig: async () => this.config,
      loadListingSettingLayers: async (candidates) => {
        this.layerReads.push(candidates.map(({ productId, categoryId }) => ({ productId, categoryId })));
        return this.layers;
      },
      findReplay: async (key, hash) => {
        const revision = this.revisions.get(key);
        if (!revision) return false;
        if (revision.hash !== hash || revision.storeConnectionId !== input.storeConnectionId) {
          throw new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT", "Key reused.");
        }
        return true;
      },
      saveProfile: async (save) => {
        if (input.mode !== "write") throw new Error("read transaction cannot save");
        this.saves.push(save);
        this.revisions.set(save.idempotencyKey, { hash: save.requestHash, storeConnectionId: input.storeConnectionId });
        this.state = { revisionId: (this.state.revisionId ?? 0) + 1, profile: save.profile, updatedAt: save.now.toISOString() };
      },
    };
    return operation(tx);
  }
}

class FakeTaxonomy implements EbayCategoryTaxonomy {
  options = new Map<string, EbayCategoryOption>([TOPLOADERS, SLEEVES, MAILERS].map((category) => [category.categoryId, categoryOption(category)]));
  calls: string[] = [];
  failure: unknown = null;

  async search(_identity: EbayCategoryIdentity, query: string): Promise<EbayCategoryOption[]> {
    this.calls.push(`search:${query}`);
    if (this.failure) throw this.failure;
    return [...this.options.values()];
  }

  async describe(_identity: EbayCategoryIdentity, categoryIds: readonly string[]): Promise<Map<string, EbayCategoryOption>> {
    this.calls.push(`describe:${categoryIds.join(",")}`);
    if (this.failure) throw this.failure;
    return new Map(categoryIds.flatMap((id) => this.options.has(id) ? [[id, this.options.get(id)!] as const] : []));
  }

  async browse(_identity: EbayCategoryIdentity, parentId: string | null): Promise<EbayCategoryBrowseResult | null> {
    this.calls.push(`browse:${parentId}`);
    if (this.failure) throw this.failure;
    if (parentId === null) return { parent: null, children: [...this.options.values()] };
    const parent = this.options.get(parentId);
    return parent ? { parent, children: [] } : null;
  }
}

function makeFixture() {
  const repository = new FakeRepository();
  const taxonomy = new FakeTaxonomy();
  const logs: Array<DropshipLogEvent & { level: string }> = [];
  const service = new DropshipEbayCategoryRulesService({
    repository,
    taxonomy,
    clock: { now: () => NOW },
    logger: {
      info: (event) => logs.push({ ...event, level: "info" }),
      warn: (event) => logs.push({ ...event, level: "warn" }),
      error: (event) => logs.push({ ...event, level: "error" }),
    },
  });
  return { repository, taxonomy, logs, service };
}

const draft = {
  defaultCategoryId: SLEEVES.categoryId,
  rules: [{ id: "mailers", name: "Mailers", scope: { type: "category" as const, category: "Mailers" }, categoryId: MAILERS.categoryId }],
};

// Two more test categories, outside the shared fixture; the ids are not claimed to match eBay's live tree.
const BOXES: EbayCategory = { categoryId: "900104", categoryName: "Boxes", path: ["Collectibles", "Card Storage", "Boxes"] };
const BINDERS: EbayCategory = { categoryId: "900105", categoryName: "Binders", path: ["Collectibles", "Card Storage", "Binders"] };
/** Ids eBay's tree does not hold in these tests. */
const UNKNOWN_ID = "999001";
const OTHER_UNKNOWN_ID = "999002";

function draftRule(id: string, scope: CatalogScope, categoryId: string) {
  return { id, name: id, scope, categoryId };
}

function storedRule(id: string, scope: CatalogScope, category: EbayCategory) {
  return { id, name: id, scope, category };
}

/** The refusal a save or review answers, in full: code, words and context. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string; context: unknown }> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  if (!(error instanceof DropshipError)) throw new Error(`Expected a DropshipError, got ${String(error)}`);
  return { code: error.code, message: error.message, context: error.context };
}

const NOT_FOUND_WORDS = "That eBay category is not in eBay's current category list. Search again and pick a current category.";
const NOT_LEAF_WORDS = "Pick a more specific eBay category. eBay accepts listings only in the last level of a category path.";

describe("DropshipEbayCategoryRulesService save", () => {
  it("verifies every category at eBay and stores eBay's names and paths", async () => {
    const fixture = makeFixture();
    const input = { expectedRevisionId: null, idempotencyKey: "category-rules:1", draft };

    const result = await fixture.service.saveForMember("member-1", 44, input);

    expect(result.idempotentReplay).toBe(false);
    expect(result.state.profile).toEqual(rulesProfile({
      defaultCategory: SLEEVES,
      rules: [{ id: "mailers", name: "Mailers", scope: { type: "category", category: "Mailers" }, category: MAILERS }],
    }));
    expect(fixture.taxonomy.calls).toEqual([`describe:${SLEEVES.categoryId},${MAILERS.categoryId}`]);
    expect(fixture.repository.saves[0]).toMatchObject({
      expectedRevisionId: null, idempotencyKey: "category-rules:1",
      requestHash: hashEbayCategoryRulesRequest(44, input), now: NOW,
    });
    expect(fixture.repository.executions.at(-1)).toEqual({ mode: "write", idempotencyKey: "category-rules:1" });
    expect(fixture.logs).toContainEqual(expect.objectContaining({
      code: "DROPSHIP_EBAY_CATEGORY_RULES_SAVED", level: "info",
      context: expect.objectContaining({ actorId: "member-1", revisionId: 1, ruleCount: 1, defaultCategoryId: SLEEVES.categoryId }),
    }));
  });

  it.each([
    ["not_leaf", () => new Map([[SLEEVES.categoryId, categoryOption(SLEEVES, false)]])],
    ["not_found", () => new Map<string, EbayCategoryOption>()],
  ])("refuses a %s category before any write", async (reason, options) => {
    const fixture = makeFixture();
    fixture.taxonomy.options = options();

    await expect(fixture.service.saveForMember("member-1", 44, {
      expectedRevisionId: null, idempotencyKey: "category-rules:2", draft: { defaultCategoryId: SLEEVES.categoryId, rules: [] },
    })).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", context: expect.objectContaining({ reason, categoryId: SLEEVES.categoryId }) });
    expect(fixture.repository.saves).toEqual([]);
  });

  it("replays a lost-response retry from the database without asking eBay again", async () => {
    const fixture = makeFixture();
    const input = { expectedRevisionId: null, idempotencyKey: "category-rules:3", draft };
    await fixture.service.saveForMember("member-1", 44, input);
    fixture.taxonomy.calls = [];

    const replay = await fixture.service.saveForMember("member-1", 44, input);

    expect(replay.idempotentReplay).toBe(true);
    expect(fixture.taxonomy.calls).toEqual([]);
    expect(fixture.repository.saves).toHaveLength(1);
    await expect(fixture.service.saveForMember("member-1", 44, { ...input, draft: { ...draft, defaultCategoryId: null } }))
      .rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
  });

  it("refuses a save made against an older revision", async () => {
    const fixture = makeFixture();
    fixture.repository.state = rulesState(rulesProfile(), 5);

    await expect(fixture.service.saveForMember("member-1", 44, { expectedRevisionId: 4, idempotencyKey: "category-rules:4", draft }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT" });
    expect(fixture.repository.saves).toEqual([]);
  });

  it("asks for a reconnect, without calling eBay, when the store needs reauthorization", async () => {
    const fixture = makeFixture();
    fixture.repository.context = { ...fixture.repository.context, storeStatus: "needs_reauth" };

    await expect(fixture.service.saveForMember("member-1", 44, { expectedRevisionId: null, idempotencyKey: "category-rules:5", draft }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED" });
    await expect(fixture.service.searchForMember("member-1", 44, "toploader"))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED" });
    expect(fixture.taxonomy.calls).toEqual([]);
    // The saved rules stay readable while the connection is being fixed.
    await expect(fixture.service.getForMember("member-1", 44)).resolves.toEqual(rulesState(null));
  });
});

/**
 * How a save and a review treat a category the current rules do not hold.
 * Written and run on the code before PR 9b; PR 9b must not change any of it.
 */
describe("DropshipEbayCategoryRulesService new categories (pinned before PR 9b)", () => {
  it("asks eBay once for each category, in draft order, and stores eBay's own name and path", async () => {
    const fixture = makeFixture();
    const renamedSleeves: EbayCategory = { ...SLEEVES, categoryName: "Card Sleeves", path: ["Collectibles", "Card Storage", "Card Sleeves"] };
    fixture.taxonomy.options.set(SLEEVES.categoryId, categoryOption(renamedSleeves));

    const result = await fixture.service.saveForMember("member-1", 44, { expectedRevisionId: null, idempotencyKey: "category-rules:pin-1", draft: {
      defaultCategoryId: MAILERS.categoryId,
      rules: [
        draftRule("sleeves", { type: "category", category: "Sleeves" }, SLEEVES.categoryId),
        draftRule("mailers", { type: "product", productId: 7 }, MAILERS.categoryId),
        draftRule("toploaders", { type: "product", productId: 8 }, TOPLOADERS.categoryId),
      ],
    } });

    expect(fixture.taxonomy.calls).toEqual([`describe:${MAILERS.categoryId},${SLEEVES.categoryId},${TOPLOADERS.categoryId}`]);
    expect(result.state.profile).toEqual(rulesProfile({
      defaultCategory: MAILERS,
      rules: [
        storedRule("sleeves", { type: "category", category: "Sleeves" }, renamedSleeves),
        storedRule("mailers", { type: "product", productId: 7 }, MAILERS),
        storedRule("toploaders", { type: "product", productId: 8 }, TOPLOADERS),
      ],
    }));
  });

  it("refuses the first category eBay does not list, in draft order, naming its rule", async () => {
    const fixture = makeFixture();

    const answer = await refusal(fixture.service.saveForMember("member-1", 44, { expectedRevisionId: null, idempotencyKey: "category-rules:pin-2", draft: {
      defaultCategoryId: SLEEVES.categoryId,
      rules: [
        draftRule("first-unknown", { type: "product", productId: 7 }, UNKNOWN_ID),
        draftRule("second-unknown", { type: "product", productId: 8 }, OTHER_UNKNOWN_ID),
      ],
    } }));

    expect(answer).toEqual({ code: "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", message: NOT_FOUND_WORDS,
      context: { storeConnectionId: 44, categoryId: UNKNOWN_ID, ruleId: "first-unknown", reason: "not_found" } });
    expect(fixture.taxonomy.calls).toEqual([`describe:${SLEEVES.categoryId},${UNKNOWN_ID},${OTHER_UNKNOWN_ID}`]);
    expect(fixture.repository.saves).toEqual([]);
    expect(fixture.repository.executions.map((execution) => execution.mode)).not.toContain("write");
  });

  it("checks the store default before the rules and refuses a category that is not the last level", async () => {
    const fixture = makeFixture();
    fixture.taxonomy.options.set(SLEEVES.categoryId, categoryOption(SLEEVES, false));

    const answer = await refusal(fixture.service.saveForMember("member-1", 44, { expectedRevisionId: null, idempotencyKey: "category-rules:pin-3", draft: {
      defaultCategoryId: SLEEVES.categoryId,
      rules: [draftRule("unknown", { type: "product", productId: 7 }, UNKNOWN_ID)],
    } }));

    expect(answer).toEqual({ code: "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", message: NOT_LEAF_WORDS,
      context: { storeConnectionId: 44, categoryId: SLEEVES.categoryId, ruleId: null, reason: "not_leaf" } });
    expect(fixture.repository.saves).toEqual([]);
  });

  it("refuses a category eBay describes in a shape the rules cannot store", async () => {
    const fixture = makeFixture();
    fixture.taxonomy.options.set(SLEEVES.categoryId, categoryOption({ ...SLEEVES, categoryName: "S".repeat(201) }));

    const answer = await refusal(fixture.service.saveForMember("member-1", 44, {
      expectedRevisionId: null, idempotencyKey: "category-rules:pin-4", draft: { defaultCategoryId: SLEEVES.categoryId, rules: [] },
    }));

    expect(answer).toEqual({ code: "DROPSHIP_EBAY_CATEGORY_RULE_INVALID",
      message: "eBay returned a category these rules cannot store. Pick a different category.",
      context: { storeConnectionId: 44, reason: "invalid_category" } });
    expect(fixture.repository.saves).toEqual([]);
  });

  it("passes on an eBay failure while checking categories, logged as a verify read, and writes nothing", async () => {
    const fixture = makeFixture();
    const failure = new DropshipError("DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", "The eBay token could not be refreshed.", { retryable: true });
    fixture.taxonomy.failure = failure;

    await expect(fixture.service.saveForMember("member-1", 44, { expectedRevisionId: null, idempotencyKey: "category-rules:pin-5", draft }))
      .rejects.toBe(failure);
    await expect(fixture.service.reviewForMember("member-1", 44, { expectedRevisionId: null, draft })).rejects.toBe(failure);

    const readFailed = {
      code: "DROPSHIP_EBAY_CATEGORIES_READ_FAILED", level: "warn",
      message: "eBay categories could not be read with the store's eBay connection.",
      context: { vendorId: 10, storeConnectionId: 44, operation: "verify", errorCode: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", errorName: "DropshipError" },
    };
    expect(fixture.logs.filter((log) => log.code === "DROPSHIP_EBAY_CATEGORIES_READ_FAILED")).toEqual([readFailed, readFailed]);
    expect(fixture.repository.saves).toEqual([]);
    expect(fixture.repository.layerReads).toEqual([]);
  });

  it("checks a review's categories like a save, before reading the selected listings", async () => {
    const fixture = makeFixture();
    fixture.repository.candidates = [categoryCandidate({ productVariantId: 1, category: "Mailers" })];

    const answer = await refusal(fixture.service.reviewForMember("member-1", 44, { expectedRevisionId: null, draft: {
      defaultCategoryId: null, rules: [draftRule("unknown", { type: "category", category: "Mailers" }, UNKNOWN_ID)],
    } }));

    expect(answer).toEqual({ code: "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", message: NOT_FOUND_WORDS,
      context: { storeConnectionId: 44, categoryId: UNKNOWN_ID, ruleId: "unknown", reason: "not_found" } });
    expect(fixture.taxonomy.calls).toEqual([`describe:${UNKNOWN_ID}`]);
    expect(fixture.repository.layerReads).toEqual([]);
  });

  it("asks for a reconnect before eBay is called when a save or review adds a category on a store that needs reauthorization", async () => {
    const fixture = makeFixture();
    fixture.repository.context = { ...fixture.repository.context, storeStatus: "needs_reauth" };
    const reconnect = {
      code: "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED",
      message: "Your eBay connection needs a refresh before eBay categories can be searched or saved. Reconnect the store to continue.",
      context: { storeConnectionId: 44, retryable: false },
    };

    expect(await refusal(fixture.service.saveForMember("member-1", 44, { expectedRevisionId: null, idempotencyKey: "category-rules:pin-7", draft })))
      .toEqual(reconnect);
    expect(await refusal(fixture.service.reviewForMember("member-1", 44, { expectedRevisionId: null, draft }))).toEqual(reconnect);
    expect(fixture.taxonomy.calls).toEqual([]);
    expect(fixture.repository.saves).toEqual([]);
    expect(fixture.repository.layerReads).toEqual([]);
    expect(fixture.repository.executions.every((execution) => execution.mode === "read")).toBe(true);
  });
});

/** The current rules in the P30 cases: Sleeves as the store default, a Mailers rule and a Toploaders rule. */
function storedRules() {
  return rulesProfile({
    defaultCategory: SLEEVES,
    rules: [
      storedRule("mailers", { type: "category", category: "Mailers" }, MAILERS),
      storedRule("toploaders", { type: "product", productId: 7 }, TOPLOADERS),
    ],
  });
}

/** The current rules as a draft: every category in it is one the rules already hold. */
function storedDraft() {
  return {
    defaultCategoryId: SLEEVES.categoryId,
    rules: [
      draftRule("mailers", { type: "category", category: "Mailers" }, MAILERS.categoryId),
      draftRule("toploaders", { type: "product", productId: 7 }, TOPLOADERS.categoryId),
    ],
  };
}

/** A store whose current rules (revision 7) are storedRules(). */
function storedFixture(storeStatus: DropshipListingStoreContext["storeStatus"] = "connected") {
  const fixture = makeFixture();
  fixture.repository.state = rulesState(storedRules(), 7);
  fixture.repository.context = { ...fixture.repository.context, storeStatus };
  return fixture;
}

function renamed(category: EbayCategory, categoryName: string): EbayCategory {
  return { ...category, categoryName, path: [...category.path.slice(0, -1), categoryName] };
}

const RECONNECT = {
  code: "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED",
  message: "Your eBay connection needs a refresh before eBay categories can be searched or saved. Reconnect the store to continue.",
  context: { storeConnectionId: 44, retryable: false },
};

/**
 * Plan P30: a category the current rules already hold keeps its stored value;
 * only new categories go through the sign-in check and eBay.
 */
describe("DropshipEbayCategoryRulesService categories the current rules hold (P30)", () => {
  it("goes back to Card Shellz picks while eBay needs a sign-in", async () => {
    const fixture = storedFixture("needs_reauth");

    const result = await fixture.service.saveForMember("member-1", 44, {
      expectedRevisionId: 7, idempotencyKey: "category-rules:p30-1", draft: { defaultCategoryId: null, rules: [] },
    });

    expect(result).toMatchObject({ idempotentReplay: false, state: { revisionId: 8, profile: rulesProfile() } });
    expect(fixture.taxonomy.calls).toEqual([]);
    expect(fixture.repository.saves).toHaveLength(1);
  });

  it("removes a rule while eBay needs a sign-in, keeping the stored value of every other category", async () => {
    const fixture = storedFixture("needs_reauth");

    const result = await fixture.service.saveForMember("member-1", 44, { expectedRevisionId: 7, idempotencyKey: "category-rules:p30-2", draft: {
      defaultCategoryId: SLEEVES.categoryId,
      rules: [draftRule("mailers", { type: "category", category: "Mailers" }, MAILERS.categoryId)],
    } });

    expect(result.state.profile).toEqual(rulesProfile({
      defaultCategory: SLEEVES, rules: [storedRule("mailers", { type: "category", category: "Mailers" }, MAILERS)],
    }));
    expect(fixture.taxonomy.calls).toEqual([]);
  });

  it("re-saves known categories in another order, under other names and in other places without asking eBay, even while eBay is down", async () => {
    const fixture = storedFixture("refresh_failed");
    fixture.taxonomy.failure = new DropshipError("DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", "down", { retryable: true });

    const result = await fixture.service.saveForMember("member-1", 44, { expectedRevisionId: 7, idempotencyKey: "category-rules:p30-3", draft: {
      defaultCategoryId: TOPLOADERS.categoryId,
      rules: [
        { ...draftRule("toploaders", { type: "product", productId: 7 }, TOPLOADERS.categoryId), name: "Top loaders" },
        { ...draftRule("mailers", { type: "category", category: "Mailers" }, SLEEVES.categoryId), name: "Envelopes" },
      ],
    } });

    expect(result.state.profile).toEqual(rulesProfile({
      defaultCategory: TOPLOADERS,
      rules: [
        { ...storedRule("toploaders", { type: "product", productId: 7 }, TOPLOADERS), name: "Top loaders" },
        { ...storedRule("mailers", { type: "category", category: "Mailers" }, SLEEVES), name: "Envelopes" },
      ],
    }));
    expect(fixture.taxonomy.calls).toEqual([]);
    expect(fixture.logs.filter((log) => log.code === "DROPSHIP_EBAY_CATEGORIES_READ_FAILED")).toEqual([]);
  });

  it("keeps a known category's stored name and path even when eBay renamed it, dropped it or gave it children", async () => {
    const fixture = storedFixture();
    fixture.taxonomy.options.set(SLEEVES.categoryId, categoryOption(renamed(SLEEVES, "Card Sleeves")));
    fixture.taxonomy.options.delete(MAILERS.categoryId);
    // No longer the last level: a new category here would be refused as not_leaf.
    fixture.taxonomy.options.set(TOPLOADERS.categoryId, categoryOption(TOPLOADERS, false));

    const result = await fixture.service.saveForMember("member-1", 44, {
      expectedRevisionId: 7, idempotencyKey: "category-rules:p30-4", draft: storedDraft(),
    });

    expect(result.state.profile).toEqual(storedRules());
    expect(fixture.taxonomy.calls).toEqual([]);
  });

  it("asks eBay only about new categories, each once, in draft order, and keeps the known ones' stored values", async () => {
    const fixture = storedFixture();
    for (const category of [BOXES, BINDERS, renamed(MAILERS, "Shipping mailers")]) {
      fixture.taxonomy.options.set(category.categoryId, categoryOption(category));
    }

    const result = await fixture.service.saveForMember("member-1", 44, { expectedRevisionId: 7, idempotencyKey: "category-rules:p30-5", draft: {
      defaultCategoryId: BOXES.categoryId,
      rules: [
        draftRule("mailers", { type: "category", category: "Mailers" }, MAILERS.categoryId),
        draftRule("binders", { type: "product", productId: 9 }, BINDERS.categoryId),
        draftRule("boxes", { type: "product", productId: 10 }, BOXES.categoryId),
        draftRule("toploaders", { type: "product", productId: 7 }, TOPLOADERS.categoryId),
      ],
    } });

    expect(fixture.taxonomy.calls).toEqual([`describe:${BOXES.categoryId},${BINDERS.categoryId}`]);
    expect(result.state.profile).toEqual(rulesProfile({
      defaultCategory: BOXES,
      rules: [
        storedRule("mailers", { type: "category", category: "Mailers" }, MAILERS),
        storedRule("binders", { type: "product", productId: 9 }, BINDERS),
        storedRule("boxes", { type: "product", productId: 10 }, BOXES),
        storedRule("toploaders", { type: "product", productId: 7 }, TOPLOADERS),
      ],
    }));
  });

  it("still asks for a reconnect, before eBay or any write, when a save adds a category on a store that needs a sign-in", async () => {
    const fixture = storedFixture("needs_reauth");
    const known = storedDraft();

    expect(await refusal(fixture.service.saveForMember("member-1", 44, { expectedRevisionId: 7, idempotencyKey: "category-rules:p30-6", draft: {
      ...known, rules: [...known.rules, draftRule("boxes", { type: "product", productId: 10 }, BOXES.categoryId)],
    } }))).toEqual(RECONNECT);
    expect(fixture.taxonomy.calls).toEqual([]);
    expect(fixture.repository.saves).toEqual([]);
    expect(fixture.repository.executions.every((execution) => execution.mode === "read")).toBe(true);
  });

  it("names the new category eBay refuses, not a known one eBay dropped", async () => {
    const fixture = storedFixture();
    fixture.taxonomy.options.delete(MAILERS.categoryId);
    const known = storedDraft();

    const answer = await refusal(fixture.service.saveForMember("member-1", 44, { expectedRevisionId: 7, idempotencyKey: "category-rules:p30-7", draft: {
      ...known, rules: [...known.rules, draftRule("unknown", { type: "product", productId: 9 }, UNKNOWN_ID)],
    } }));

    expect(answer).toEqual({ code: "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", message: NOT_FOUND_WORDS,
      context: { storeConnectionId: 44, categoryId: UNKNOWN_ID, ruleId: "unknown", reason: "not_found" } });
    expect(fixture.taxonomy.calls).toEqual([`describe:${UNKNOWN_ID}`]);
    expect(fixture.repository.saves).toEqual([]);
  });

  it("refuses a new category eBay does not list, naming it, beside known ones eBay still lists", async () => {
    const fixture = storedFixture();
    const known = storedDraft();

    const answer = await refusal(fixture.service.saveForMember("member-1", 44, { expectedRevisionId: 7, idempotencyKey: "category-rules:p30-8", draft: {
      ...known, rules: [known.rules[0], draftRule("unknown", { type: "product", productId: 9 }, UNKNOWN_ID), known.rules[1]],
    } }));

    expect(answer).toEqual({ code: "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", message: NOT_FOUND_WORDS,
      context: { storeConnectionId: 44, categoryId: UNKNOWN_ID, ruleId: "unknown", reason: "not_found" } });
    expect(fixture.repository.saves).toEqual([]);
  });

  it("reviews a draft of known categories while eBay needs a sign-in, without asking eBay", async () => {
    const fixture = storedFixture("needs_reauth");
    fixture.repository.candidates = [categoryCandidate({ productVariantId: 1, productId: 1, category: "Mailers" })];

    const review = await fixture.service.reviewForMember("member-1", 44, { expectedRevisionId: 7, draft: storedDraft() });

    expect(review).toMatchObject({ expectedRevisionId: 7, selectedCount: 1, changedCount: 0, unchangedCount: 1 });
    expect(fixture.taxonomy.calls).toEqual([]);
    expect(fixture.repository.executions).toEqual([{ mode: "read", idempotencyKey: undefined }, { mode: "read", idempotencyKey: undefined }]);
  });

  it("still asks for a reconnect, before eBay, when a review adds a category on a store that needs a sign-in", async () => {
    const fixture = storedFixture("needs_reauth");
    const known = storedDraft();

    expect(await refusal(fixture.service.reviewForMember("member-1", 44, { expectedRevisionId: 7, draft: {
      ...known, defaultCategoryId: BOXES.categoryId,
    } }))).toEqual(RECONNECT);
    expect(fixture.taxonomy.calls).toEqual([]);
    expect(fixture.repository.layerReads).toEqual([]);
  });

  it("compares a stale draft with the newest rules: a category stored only in an older revision is checked as a new one", async () => {
    const fixture = makeFixture();
    const sleevesOnly = { defaultCategoryId: SLEEVES.categoryId, rules: [] };
    await fixture.service.saveForMember("member-1", 44, { expectedRevisionId: null, idempotencyKey: "category-rules:p30-11a", draft: sleevesOnly });
    await fixture.service.saveForMember("member-1", 44, {
      expectedRevisionId: 1, idempotencyKey: "category-rules:p30-11b", draft: { defaultCategoryId: TOPLOADERS.categoryId, rules: [] },
    });
    fixture.taxonomy.calls = [];
    const stale = { expectedRevisionId: 1, draft: sleevesOnly };

    // Sleeves is stored in revision 1, which the draft names, but not in revision 2, the newest.
    fixture.repository.context = { ...fixture.repository.context, storeStatus: "needs_reauth" };
    expect(await refusal(fixture.service.saveForMember("member-1", 44, { ...stale, idempotencyKey: "category-rules:p30-11c" }))).toEqual(RECONNECT);
    expect(await refusal(fixture.service.reviewForMember("member-1", 44, stale))).toEqual(RECONNECT);
    expect(fixture.taxonomy.calls).toEqual([]);

    fixture.repository.context = { ...fixture.repository.context, storeStatus: "connected" };
    await expect(fixture.service.saveForMember("member-1", 44, { ...stale, idempotencyKey: "category-rules:p30-11d" }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT" });
    await expect(fixture.service.reviewForMember("member-1", 44, stale))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT" });
    expect(fixture.taxonomy.calls).toEqual([`describe:${SLEEVES.categoryId}`, `describe:${SLEEVES.categoryId}`]);

    // eBay no longer listing it is refused first, as before.
    fixture.taxonomy.options.delete(SLEEVES.categoryId);
    await expect(fixture.service.saveForMember("member-1", 44, { ...stale, idempotencyKey: "category-rules:p30-11e" }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", context: expect.objectContaining({ reason: "not_found" }) });
    expect(fixture.repository.saves).toHaveLength(2);
  });

  it("answers a stale draft of stored categories, or an empty one, with the version conflict and no eBay call", async () => {
    const fixture = storedFixture("needs_reauth");
    fixture.repository.state = rulesState(storedRules(), 8);
    const empty = { expectedRevisionId: 7, draft: { defaultCategoryId: null, rules: [] } };
    const known = { expectedRevisionId: 7, draft: storedDraft() };

    await expect(fixture.service.saveForMember("member-1", 44, { ...empty, idempotencyKey: "category-rules:p30-12a" }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT" });
    await expect(fixture.service.reviewForMember("member-1", 44, empty))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT" });
    fixture.repository.context = { ...fixture.repository.context, storeStatus: "connected" };
    await expect(fixture.service.saveForMember("member-1", 44, { ...known, idempotencyKey: "category-rules:p30-12b" }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT" });
    await expect(fixture.service.reviewForMember("member-1", 44, known))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT" });

    expect(fixture.taxonomy.calls).toEqual([]);
    expect(fixture.repository.saves).toEqual([]);
  });

  it("reviews a change of known categories while eBay needs a sign-in, telling the current rules before from the draft after", async () => {
    const fixture = storedFixture("needs_reauth");
    fixture.repository.candidates = [
      categoryCandidate({ productVariantId: 1, productId: 1, category: "Mailers" }),
      categoryCandidate({ productVariantId: 2, productId: 7, category: "Sleeves" }),
      categoryCandidate({ productVariantId: 3, productId: 3, category: "Boxes" }),
    ];

    // The Mailers rule goes; Mailers becomes the store default.
    const review = await fixture.service.reviewForMember("member-1", 44, { expectedRevisionId: 7, draft: {
      defaultCategoryId: MAILERS.categoryId,
      rules: [draftRule("toploaders", { type: "product", productId: 7 }, TOPLOADERS.categoryId)],
    } });

    expect(review).toMatchObject({ selectedCount: 3, changedCount: 1, unchangedCount: 2,
      bySource: { rule: 1, store_default: 2, catalog: 0, none: 0 }, byRule: [{ ruleId: "toploaders", matched: 1 }] });
    expect(review.changes).toEqual([expect.objectContaining({
      productVariantId: 3,
      before: { categoryId: SLEEVES.categoryId, categoryName: SLEEVES.categoryName, source: "store_default", ruleId: null },
      after: { categoryId: MAILERS.categoryId, categoryName: MAILERS.categoryName, source: "store_default", ruleId: null },
    })]);
    expect(fixture.taxonomy.calls).toEqual([]);
  });

  it("checks a category with eBay again once the current rules no longer hold it", async () => {
    const fixture = storedFixture();
    const known = storedDraft();
    const withoutToploaders = { ...known, rules: [known.rules[0]] };
    await fixture.service.saveForMember("member-1", 44, { expectedRevisionId: 7, idempotencyKey: "category-rules:p30-14a", draft: withoutToploaders });
    expect(fixture.taxonomy.calls).toEqual([]);
    const renamedToploaders = renamed(TOPLOADERS, "Top Loaders");
    fixture.taxonomy.options.set(TOPLOADERS.categoryId, categoryOption(renamedToploaders));

    fixture.repository.context = { ...fixture.repository.context, storeStatus: "needs_reauth" };
    expect(await refusal(fixture.service.saveForMember("member-1", 44, {
      expectedRevisionId: 8, idempotencyKey: "category-rules:p30-14b", draft: known,
    }))).toEqual(RECONNECT);
    fixture.repository.context = { ...fixture.repository.context, storeStatus: "connected" };
    const result = await fixture.service.saveForMember("member-1", 44, {
      expectedRevisionId: 8, idempotencyKey: "category-rules:p30-14c", draft: known,
    });

    expect(fixture.taxonomy.calls).toEqual([`describe:${TOPLOADERS.categoryId}`]);
    expect(result.state.profile).toEqual(rulesProfile({
      defaultCategory: SLEEVES,
      rules: [
        storedRule("mailers", { type: "category", category: "Mailers" }, MAILERS),
        storedRule("toploaders", { type: "product", productId: 7 }, renamedToploaders),
      ],
    }));
  });

  it("goes back to Card Shellz picks on a store with no rules yet while eBay needs a sign-in", async () => {
    const fixture = makeFixture();
    fixture.repository.context = { ...fixture.repository.context, storeStatus: "needs_reauth" };
    const empty = { expectedRevisionId: null, draft: { defaultCategoryId: null, rules: [] } };

    const review = await fixture.service.reviewForMember("member-1", 44, empty);
    const result = await fixture.service.saveForMember("member-1", 44, { ...empty, idempotencyKey: "category-rules:p30-15" });

    expect(review).toMatchObject({ expectedRevisionId: null, selectedCount: 0, changedCount: 0 });
    expect(result).toMatchObject({ idempotentReplay: false, state: { revisionId: 1, profile: rulesProfile() } });
    expect(fixture.taxonomy.calls).toEqual([]);
    // Review: the current rules, then the listings. Save: the replay read, then the write.
    expect(fixture.repository.executions.map((execution) => execution.mode)).toEqual(["read", "read", "read", "write"]);
  });

  it("replays a lost-response retry from its first read, after a later save dropped its category and eBay needs a sign-in", async () => {
    const fixture = makeFixture();
    fixture.taxonomy.options.set(BOXES.categoryId, categoryOption(BOXES));
    const boxes = { expectedRevisionId: null, idempotencyKey: "category-rules:p30-16a", draft: { defaultCategoryId: BOXES.categoryId, rules: [] } };
    await fixture.service.saveForMember("member-1", 44, boxes);
    await fixture.service.saveForMember("member-1", 44, {
      expectedRevisionId: 1, idempotencyKey: "category-rules:p30-16b", draft: { defaultCategoryId: SLEEVES.categoryId, rules: [] },
    });
    fixture.repository.context = { ...fixture.repository.context, storeStatus: "needs_reauth" };
    fixture.taxonomy.calls = [];
    fixture.repository.executions = [];

    const replay = await fixture.service.saveForMember("member-1", 44, boxes);

    // Boxes is new to the current rules (revision 2), so only the first read's
    // replay keeps this committed request away from the sign-in check.
    expect(replay).toMatchObject({ idempotentReplay: true, state: { revisionId: 2 } });
    expect(fixture.taxonomy.calls).toEqual([]);
    expect(fixture.repository.executions).toEqual([{ mode: "read", idempotencyKey: undefined }]);
    expect(fixture.repository.saves).toHaveLength(2);
  });

  it.each(["needs_reauth", "connected"] as const)(
    "refuses an unreadable stored profile in the first read, before the sign-in check and eBay (%s store)",
    async (storeStatus) => {
      const fixture = makeFixture();
      fixture.repository.context = { ...fixture.repository.context, storeStatus };
      // The reader throws this plain Error when the stored profile breaks its
      // contract (infrastructure/dropship-ebay-category-rules.reader.ts).
      const contractFailure = "Persisted eBay category rules failed their contract.";
      Object.defineProperty(fixture.repository, "state", { get() { throw new Error(contractFailure); } });
      const request = { expectedRevisionId: null, draft: { defaultCategoryId: SLEEVES.categoryId, rules: [] } };

      for (const run of [
        () => fixture.service.saveForMember("member-1", 44, { ...request, idempotencyKey: `category-rules:p30-17-${storeStatus}` }),
        () => fixture.service.reviewForMember("member-1", 44, request),
      ]) {
        fixture.repository.executions = [];
        const error = await run().then(() => null, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(DropshipError);
        expect((error as Error).message).toBe(contractFailure);
        expect(fixture.repository.executions).toEqual([{ mode: "read", idempotencyKey: undefined }]);
      }
      expect(fixture.taxonomy.calls).toEqual([]);
      expect(fixture.repository.saves).toEqual([]);
    },
  );

  it("refuses a save or review that names a revision saved only after its first read", async () => {
    const fixture = storedFixture();
    // Revision 8 drops the Toploaders rule. The request names it before it
    // exists, and a concurrent save commits it right after the request's first
    // read, which saw revision 7 and its stored Toploaders value.
    const revision8 = rulesState(rulesProfile({
      defaultCategory: SLEEVES, rules: [storedRule("mailers", { type: "category", category: "Mailers" }, MAILERS)],
    }), 8);
    const execute = fixture.repository.execute.bind(fixture.repository);
    fixture.repository.execute = async <T>(
      input: Parameters<EbayCategoryRulesRepository["execute"]>[0],
      operation: (tx: EbayCategoryRulesTransaction) => Promise<T>,
    ): Promise<T> => {
      if (fixture.repository.executions.length === 1) fixture.repository.state = revision8;
      return execute(input, operation);
    };
    const request = { expectedRevisionId: 8, draft: storedDraft() };

    await expect(fixture.service.saveForMember("member-1", 44, { ...request, idempotencyKey: "category-rules:p30-18" }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT", context: { storeConnectionId: 44 } });
    expect(fixture.repository.state).toBe(revision8);
    fixture.repository.state = rulesState(storedRules(), 7);
    fixture.repository.executions = [];
    await expect(fixture.service.reviewForMember("member-1", 44, request))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT", context: { storeConnectionId: 44 } });

    expect(fixture.taxonomy.calls).toEqual([]);
    expect(fixture.repository.saves).toEqual([]);
    expect(fixture.repository.layerReads).toEqual([]);
  });
});

describe("DropshipEbayCategoryRulesService access", () => {
  it.each([
    ["a non-eBay store", { platform: "shopify" as const }, "DROPSHIP_EBAY_STORE_REQUIRED"],
    ["a paused store", { storeStatus: "paused" as const }, "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED"],
    ["an inactive entitlement", { entitlementStatus: "lapsed" }, "DROPSHIP_EBAY_CATEGORY_RULES_NOT_ALLOWED"],
    ["a suspended vendor", { vendorStatus: "suspended" as const }, "DROPSHIP_EBAY_CATEGORY_RULES_NOT_ALLOWED"],
  ])("refuses %s", async (_label, change, code) => {
    const fixture = makeFixture();
    fixture.repository.context = { ...fixture.repository.context, ...change } as DropshipListingStoreContext;

    await expect(fixture.service.getForMember("member-1", 44)).rejects.toMatchObject({ code });
  });

  it("refuses a store listing on a marketplace other than eBay US", async () => {
    const fixture = makeFixture();
    fixture.repository.config = { id: 1, storeConnectionId: 44, platform: "ebay", listingMode: "live", inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined", marketplaceConfig: { marketplaceId: "EBAY_GB" }, requiredConfigKeys: [], requiredProductFields: [], isActive: true } as DropshipStoreListingConfig;

    await expect(fixture.service.getForMember("member-1", 44))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED", context: expect.objectContaining({ marketplaceId: "EBAY_GB" }) });
  });

  it("requires a signed-in member and a valid store id", async () => {
    const fixture = makeFixture();
    await expect(fixture.service.getForMember(" ", 44)).rejects.toMatchObject({ code: "DROPSHIP_AUTH_REQUIRED" });
    await expect(fixture.service.getForMember("member-1", Number.NaN)).rejects.toBeInstanceOf(ZodError);
    expect(fixture.repository.executions).toEqual([]);
  });
});

describe("DropshipEbayCategoryRulesService review", () => {
  it("summarizes what a draft would change and writes nothing", async () => {
    const fixture = makeFixture();
    fixture.repository.candidates = [
      categoryCandidate({ productVariantId: 1, category: "Mailers", ebayBrowseCategoryId: null, ebayBrowseCategoryName: null }),
      categoryCandidate({ productVariantId: 2, category: "Sleeves", ebayBrowseCategoryId: SLEEVES.categoryId }),
    ];

    const review = await fixture.service.reviewForMember("member-1", 44, { expectedRevisionId: null, draft });

    expect(review).toMatchObject({ selectedCount: 2, changedCount: 1, unchangedCount: 1, withoutCategoryBefore: 1, withoutCategoryAfter: 0,
      bySource: { rule: 1, store_default: 1, catalog: 0, none: 0 } });
    expect(fixture.repository.saves).toEqual([]);
    expect(fixture.repository.executions.every((execution) => execution.mode === "read")).toBe(true);
  });

  it("reads the product and category settings once and resolves before and after with them", async () => {
    const fixture = makeFixture();
    fixture.repository.candidates = [
      categoryCandidate({ productVariantId: 1, productId: 7, category: "Mailers", categoryId: null }),
      categoryCandidate({ productVariantId: 2, productId: 8, category: "Boxes", categoryId: 31, ebayBrowseCategoryId: null, ebayBrowseCategoryName: null }),
      categoryCandidate({ productVariantId: 3, productId: 9, category: "Boxes", categoryId: null, ebayBrowseCategoryId: null, ebayBrowseCategoryName: null }),
    ];
    fixture.repository.layers = {
      products: new Map([[7, { storeConnectionId: 44, productId: 7, revisionId: 70, updatedAt: NOW.toISOString(),
        values: { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, ebayCategory: TOPLOADERS } }]]),
      categories: new Map([[31, { storeConnectionId: 44, categoryId: 31, revisionId: 80, updatedAt: NOW.toISOString(),
        values: { ...EMPTY_CATEGORY_LISTING_SETTING_VALUES, ebayCategory: TOPLOADERS } }]]),
    };

    const review = await fixture.service.reviewForMember("member-1", 44, { expectedRevisionId: null, draft });

    expect(fixture.repository.layerReads).toEqual([[
      { productId: 7, categoryId: null }, { productId: 8, categoryId: 31 }, { productId: 9, categoryId: null },
    ]]);
    // The product's own category beats the draft's Mailers rule and the category setting beats its store
    // default, before and after alike, so only the size with neither moves (none → the draft's store default).
    expect(review).toMatchObject({ selectedCount: 3, changedCount: 1, unchangedCount: 2, withoutCategoryBefore: 1, withoutCategoryAfter: 0,
      bySource: { rule: 0, store_default: 1, catalog: 0, none: 0, product: 1, category: 1 },
      byRule: [{ ruleId: "mailers", matched: 0 }] });
    expect(review.changes.map((change) => [change.productVariantId, change.after.source])).toEqual([[3, "store_default"]]);
    expect(fixture.repository.executions.every((execution) => execution.mode === "read")).toBe(true);
  });

  it("keeps today's four counts when no product or category sets an eBay category", async () => {
    const fixture = makeFixture();
    fixture.repository.candidates = [categoryCandidate({ productVariantId: 1, category: "Mailers", categoryId: 31 })];

    const review = await fixture.service.reviewForMember("member-1", 44, { expectedRevisionId: null, draft });

    expect(Object.keys(review.bySource)).toEqual(["rule", "store_default", "catalog", "none"]);
    expect(fixture.repository.layerReads).toHaveLength(1);
  });

  it("refuses to review against rules that changed since they were loaded", async () => {
    const fixture = makeFixture();
    fixture.repository.state = rulesState(rulesProfile(), 3);

    await expect(fixture.service.reviewForMember("member-1", 44, { expectedRevisionId: null, draft }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT" });
  });
});

describe("DropshipEbayCategoryRulesService category lookups", () => {
  it("validates the search query before touching the database or eBay", async () => {
    const fixture = makeFixture();
    await expect(fixture.service.searchForMember("member-1", 44, "a")).rejects.toBeInstanceOf(ZodError);
    await expect(fixture.service.searchForMember("member-1", 44, ["toploader"])).rejects.toBeInstanceOf(ZodError);
    expect(fixture.repository.executions).toEqual([]);
    await expect(fixture.service.searchForMember("member-1", 44, "  toploader ")).resolves.toMatchObject({ categories: expect.any(Array) });
    expect(fixture.taxonomy.calls).toEqual(["search:toploader"]);
  });

  it("browses from the top level and reports unknown categories as not found", async () => {
    const fixture = makeFixture();
    await expect(fixture.service.browseForMember("member-1", 44, undefined)).resolves.toMatchObject({ parent: null });
    await expect(fixture.service.browseForMember("member-1", 44, "999999")).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_NOT_FOUND" });
    await expect(fixture.service.describeForMember("member-1", 44, TOPLOADERS.categoryId)).resolves.toEqual({ category: categoryOption(TOPLOADERS) });
    await expect(fixture.service.describeForMember("member-1", 44, "999999")).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_NOT_FOUND" });
    await expect(fixture.service.describeForMember("member-1", 44, "abc")).rejects.toBeInstanceOf(ZodError);
  });

  it("logs an eBay failure and passes it on; an expired connection is logged as expected", async () => {
    const fixture = makeFixture();
    fixture.taxonomy.failure = new DropshipError("DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", "down", { retryable: true });
    await expect(fixture.service.searchForMember("member-1", 44, "toploader")).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE" });
    fixture.taxonomy.failure = permissionRequired(44);
    await expect(fixture.service.searchForMember("member-1", 44, "toploader")).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED" });
    expect(fixture.logs.filter((log) => log.code === "DROPSHIP_EBAY_CATEGORIES_READ_FAILED").map((log) => [log.level, log.context?.errorCode]))
      .toEqual([["warn", "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE"], ["info", "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED"]]);
  });
});
