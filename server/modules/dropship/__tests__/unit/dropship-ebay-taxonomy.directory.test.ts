import { afterEach, describe, expect, it, vi } from "vitest";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import { DropshipError } from "../../domain/errors";
import type { DropshipEbayRegistrationCredentialProvider } from "../../infrastructure/dropship-ebay-registration-credentials";
import {
  EBAY_CATEGORY_TREE_TIMEOUT_MS,
  EBAY_CATEGORY_TREE_TTL_MS,
  EbayDropshipCategoryTaxonomy,
  parseEbayCategorySuggestionIds,
  parseEbayCategoryTree,
} from "../../infrastructure/dropship-ebay-taxonomy.directory";
import type { DropshipMarketplaceStoreCredentials } from "../../infrastructure/dropship-marketplace-credentials";

const START = new Date("2026-09-30T12:00:00.000Z");
const STORE_A = { vendorId: 10, storeConnectionId: 44 };
const STORE_B = { vendorId: 11, storeConnectionId: 55 };

function node(categoryId: string, categoryName: string, children?: unknown[], extra: Record<string, unknown> = {}) {
  return { category: { categoryId, categoryName }, ...(children ? { childCategoryTreeNodes: children } : {}), ...extra };
}

function tree(children: unknown[], overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    categoryTreeId: "0",
    categoryTreeVersion: "130",
    rootCategoryNode: { category: { categoryId: "0", categoryName: "Root" }, childCategoryTreeNodes: children },
    ...overrides,
  });
}

const US_TREE = tree([
  node("1", "Collectibles", [
    node("10", "Card Storage", [node("100", "Toploaders"), node("101", "Sleeves")]),
    node("11", "Shipping Supplies", [node("110", "Mailers")]),
  ]),
  node("2", "Toys"),
]);

describe("eBay category tree parsing", () => {
  it("indexes the tree with eBay's order, full paths and leaf flags", () => {
    const index = parseEbayCategoryTree(US_TREE, 44);
    expect(index.topLevelIds).toEqual(["1", "2"]);
    expect(index.nodes.get("10")?.childIds).toEqual(["100", "101"]);
    expect(index.nodes.get("100")).toMatchObject({ parentId: "10", leaf: true });
    expect(index.nodes.get("10")?.leaf).toBe(false);
    expect(index.treeVersion).toBe("130");
    expect(index.skippedNodes).toBe(0);
  });

  it("drops invalid and duplicate entries with their subtrees, without making their parent a leaf", () => {
    const index = parseEbayCategoryTree(tree([
      node("1", "Collectibles", [
        node("bad", "Not a number", [node("5", "Orphan")]),
        node("12", ""),
        node("100", "Duplicate one"),
        node("100", "Duplicate two"),
      ]),
      node("3", "Only invalid children", [node("x", "nope")]),
    ]), 44);
    expect(index.nodes.get("1")?.childIds).toEqual(["100"]);
    expect(index.nodes.has("5")).toBe(false);
    expect(index.nodes.get("100")?.categoryName).toBe("Duplicate one");
    expect(index.nodes.get("3")).toMatchObject({ childIds: [], leaf: false });
    expect(index.skippedNodes).toBe(4);
  });

  it("treats a node eBay marks as non-leaf as non-leaf", () => {
    const index = parseEbayCategoryTree(tree([node("7", "Marked", [], { leafCategoryTreeNode: false })]), 44);
    expect(index.nodes.get("7")?.leaf).toBe(false);
  });

  it("refuses a document that is not the eBay US tree", () => {
    for (const text of ["not json", JSON.stringify({ categoryTreeId: "0" }), tree([], { categoryTreeId: "3" }), tree([])]) {
      expect(() => parseEbayCategoryTree(text, 44)).toThrowError(
        expect.objectContaining({ code: "DROPSHIP_EBAY_CATEGORIES_INVALID_RESPONSE" }),
      );
    }
  });

  it("reads suggestion ids in eBay's order without duplicates or malformed entries", () => {
    expect(parseEbayCategorySuggestionIds(JSON.stringify({ categorySuggestions: [
      { category: { categoryId: "101" } }, { category: { categoryId: "100" } }, { category: { categoryId: "101" } },
      { category: { categoryId: "abc" } }, { nope: true }, "text",
    ] }), 44)).toEqual(["101", "100"]);
    expect(parseEbayCategorySuggestionIds("{}", 44)).toEqual([]);
    expect(() => parseEbayCategorySuggestionIds(JSON.stringify({ categorySuggestions: {} }), 44))
      .toThrowError(expect.objectContaining({ code: "DROPSHIP_EBAY_CATEGORIES_INVALID_RESPONSE" }));
  });
});

describe("EbayDropshipCategoryTaxonomy", () => {
  afterEach(() => vi.useRealTimers());

  it("downloads the tree once and answers browse and lookups from it", async () => {
    const fixture = makeFixture();

    await expect(fixture.taxonomy.browse(STORE_A, null)).resolves.toMatchObject({
      parent: null, children: [{ categoryId: "1", path: ["Collectibles"], leaf: false }, { categoryId: "2", path: ["Toys"], leaf: true }],
    });
    await expect(fixture.taxonomy.browse(STORE_A, "10")).resolves.toMatchObject({
      parent: { categoryId: "10", path: ["Collectibles", "Card Storage"] },
      children: [{ categoryId: "100", path: ["Collectibles", "Card Storage", "Toploaders"], leaf: true }, { categoryId: "101" }],
    });
    await expect(fixture.taxonomy.browse(STORE_A, "999")).resolves.toBeNull();
    const found = await fixture.taxonomy.describe(STORE_A, ["110", "999"]);
    expect([...found.keys()]).toEqual(["110"]);
    expect(fixture.treeRequests()).toBe(1);
    expect(fixture.fetchFn).toHaveBeenCalledWith("https://api.ebay.com/commerce/taxonomy/v1/category_tree/0", expect.objectContaining({
      method: "GET", headers: expect.objectContaining({ Authorization: "Bearer token-44", "Accept-Language": "en-US" }),
    }));
    expect(fixture.logs).toContainEqual(expect.objectContaining({ code: "DROPSHIP_EBAY_CATEGORY_TREE_LOADED" }));
  });

  it("refreshes the tree after a day", async () => {
    const fixture = makeFixture();
    await fixture.taxonomy.describe(STORE_A, ["100"]);
    fixture.advance(EBAY_CATEGORY_TREE_TTL_MS - 1);
    await fixture.taxonomy.describe(STORE_A, ["100"]);
    expect(fixture.treeRequests()).toBe(1);
    fixture.advance(1);
    await fixture.taxonomy.describe(STORE_A, ["100"]);
    expect(fixture.treeRequests()).toBe(2);
  });

  it("shares one download between concurrent requests", async () => {
    const fixture = makeFixture();
    await Promise.all([fixture.taxonomy.describe(STORE_A, ["100"]), fixture.taxonomy.browse(STORE_B, null), fixture.taxonomy.describe(STORE_A, ["101"])]);
    expect(fixture.treeRequests()).toBe(1);
  });

  it("maps eBay's suggestions onto the tree and leaves out ids the tree does not have", async () => {
    const fixture = makeFixture({ suggestions: ["101", "555", "100"] });

    await expect(fixture.taxonomy.search(STORE_A, "card sleeves & top")).resolves.toEqual([
      { categoryId: "101", categoryName: "Sleeves", path: ["Collectibles", "Card Storage", "Sleeves"], leaf: true },
      { categoryId: "100", categoryName: "Toploaders", path: ["Collectibles", "Card Storage", "Toploaders"], leaf: true },
    ]);
    expect(fixture.fetchFn).toHaveBeenCalledWith(
      "https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=card%20sleeves%20%26%20top",
      expect.anything(),
    );
    expect(fixture.logs).toContainEqual(expect.objectContaining({ code: "DROPSHIP_EBAY_CATEGORY_SUGGESTIONS_OUTSIDE_TREE", context: expect.objectContaining({ outsideTree: 1 }) }));
  });

  it("returns no suggestions for an empty eBay answer", async () => {
    const fixture = makeFixture({ suggestionsStatus: 204 });
    await expect(fixture.taxonomy.search(STORE_A, "zzz")).resolves.toEqual([]);
  });

  it("uses the sandbox host for a sandbox connection", async () => {
    const fixture = makeFixture({ environment: "sandbox" });
    await fixture.taxonomy.browse(STORE_A, null);
    expect(fixture.fetchFn).toHaveBeenCalledWith("https://api.sandbox.ebay.com/commerce/taxonomy/v1/category_tree/0", expect.anything());
  });

  it("retries once with a refreshed token when eBay rejects the store's token", async () => {
    const fixture = makeFixture({ rejectTokens: ["token-44"] });
    await expect(fixture.taxonomy.describe(STORE_A, ["100"])).resolves.toHaveProperty("size", 1);
    expect(fixture.credentials.loadFreshForStoreConnection).toHaveBeenLastCalledWith(expect.objectContaining({
      storeConnectionId: 44, rejectedAccessTokenRef: "vault://access-44",
    }));
  });

  it("does not let one store's rejected token fail another store's request", async () => {
    const fixture = makeFixture({ rejectTokens: ["token-44", "token-44-refreshed"], suggestions: ["100"] });
    const [, second] = await Promise.allSettled([fixture.taxonomy.browse(STORE_A, null), fixture.taxonomy.browse(STORE_B, null)]);
    expect(second).toMatchObject({ status: "fulfilled" });
    // The shared tree is public data; a live eBay call still needs the store's own working key.
    await expect(fixture.taxonomy.search(STORE_A, "toploader")).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED" });
    await expect(fixture.taxonomy.search(STORE_B, "toploader")).resolves.toHaveLength(1);
  });

  it("serves yesterday's tree when eBay is down, but never hides a credential failure", async () => {
    const fixture = makeFixture();
    await fixture.taxonomy.describe(STORE_A, ["100"]);
    fixture.advance(EBAY_CATEGORY_TREE_TTL_MS);
    fixture.treeStatus = 503;
    await expect(fixture.taxonomy.describe(STORE_A, ["100"])).resolves.toHaveProperty("size", 1);
    expect(fixture.logs).toContainEqual(expect.objectContaining({ code: "DROPSHIP_EBAY_CATEGORY_TREE_STALE" }));
    fixture.treeStatus = 403;
    await expect(fixture.taxonomy.describe(STORE_A, ["100"])).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED" });
  });

  it("reports eBay outages as retryable only when eBay says so", async () => {
    const fixture = makeFixture();
    fixture.treeStatus = 503;
    await expect(fixture.taxonomy.browse(STORE_A, null)).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", context: expect.objectContaining({ status: 503, retryable: true }),
    });
    fixture.treeStatus = 400;
    await expect(fixture.taxonomy.browse(STORE_A, null)).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", context: expect.objectContaining({ status: 400, retryable: false }),
    });
  });

  it("asks for a reconnect when the store's eBay authorization is gone", async () => {
    const fixture = makeFixture();
    fixture.credentials.loadFreshForStoreConnection.mockRejectedValueOnce(
      new DropshipError("DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED", "Refresh token missing."),
    );
    await expect(fixture.taxonomy.browse(STORE_A, null)).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED" });
    expect(fixture.treeRequests()).toBe(0);
  });

  it("refuses an answer larger than its size limit", async () => {
    const fixture = makeFixture({ treeContentLength: String(512 * 1024 * 1024) });
    await expect(fixture.taxonomy.browse(STORE_A, null)).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORIES_INVALID_RESPONSE" });
  });

  it("gives up on a hanging eBay request before the router limit", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture({ hangTree: true });
    const pending = fixture.taxonomy.browse(STORE_A, null);
    const outcome = expect(pending).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", context: expect.objectContaining({ retryable: true }) });
    await vi.advanceTimersByTimeAsync(EBAY_CATEGORY_TREE_TIMEOUT_MS);
    await outcome;
  });
});

function makeFixture(options: {
  suggestions?: string[];
  suggestionsStatus?: number;
  environment?: "sandbox" | "production";
  rejectTokens?: string[];
  treeContentLength?: string;
  hangTree?: boolean;
} = {}) {
  let nowMs = START.getTime();
  const logs: DropshipLogEvent[] = [];
  const state = { treeStatus: 200 };
  const credentials = {
    loadFreshForStoreConnection: vi.fn(async (input: { storeConnectionId: number; rejectedAccessTokenRef?: string }) =>
      credential(input.storeConnectionId, input.rejectedAccessTokenRef ? "refreshed" : null, options.environment ?? "production")),
  };
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).Authorization).replace("Bearer ", "");
    if (options.rejectTokens?.includes(token)) return new Response(JSON.stringify({ errors: [{ errorId: 1001 }] }), { status: 401 });
    if (url.includes("get_category_suggestions")) {
      if (options.suggestionsStatus === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ categorySuggestions: (options.suggestions ?? []).map((categoryId) => ({ category: { categoryId } })) }), { status: 200 });
    }
    if (options.hangTree) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    if (state.treeStatus !== 200) return new Response("{}", { status: state.treeStatus });
    return new Response(US_TREE, { status: 200, headers: options.treeContentLength ? { "content-length": options.treeContentLength } : {} });
  });
  const taxonomy = new EbayDropshipCategoryTaxonomy({
    credentials: credentials as unknown as DropshipEbayRegistrationCredentialProvider,
    clock: { now: () => new Date(nowMs) },
    logger: { info: (event) => logs.push(event), warn: (event) => logs.push(event), error: (event) => logs.push(event) },
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return {
    taxonomy,
    fetchFn,
    credentials,
    logs,
    advance: (ms: number) => { nowMs += ms; },
    treeRequests: () => fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/category_tree/0")).length,
    get treeStatus() { return state.treeStatus; },
    set treeStatus(value: number) { state.treeStatus = value; },
  };
}

function credential(storeConnectionId: number, generation: string | null, environment: string): DropshipMarketplaceStoreCredentials {
  const suffix = generation ? `-${generation}` : "";
  return {
    vendorId: storeConnectionId === 44 ? 10 : 11,
    storeConnectionId,
    platform: "ebay",
    status: "connected",
    shopDomain: null,
    externalAccountId: `seller-${storeConnectionId}`,
    providerEnvironment: environment,
    externalAccountIdentityScheme: "ebay_user_id",
    externalAccountVerifiedAt: START,
    externalDisplayName: `seller ${storeConnectionId}`,
    config: {},
    accessToken: `token-${storeConnectionId}${suffix}`,
    accessTokenRef: `vault://access-${storeConnectionId}${suffix}`,
    accessTokenExpiresAt: null,
    refreshToken: null,
    refreshTokenRef: null,
    refreshTokenExpiresAt: null,
  };
}
