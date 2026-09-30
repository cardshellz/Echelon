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
import type { DropshipStoreListingConfig } from "../../application/dropship-marketplace-listing-provider";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import { DropshipError } from "../../domain/errors";
import type { EbayCategoryBrowseResult, EbayCategoryOption, EbayCategoryRulesState } from "../../../../../shared/dropship/ebay-category-rules";
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
