import { describe, expect, it, vi } from "vitest";
import type { StockLinkDestination } from "@shared/types/stock-link";
import { isStockLinkItemOnSale } from "../../../inventory-planning/domain/stock-link";
import { classifyStockLinkFailure } from "../../../inventory-planning/domain/stock-link-errors";
import { ChannelIdentityError } from "../../channel-identity.domain";
import type { ShopifyIdentityConnection } from "../../adapters/shopify-identity.reader";
import {
  SHOPIFY_STOCK_LINK_API_VERSION, SHOPIFY_STOCK_LINK_LOOKUP_PAGES_MAX, ShopifyStockLinkProviderError,
  createShopifyStockLinkAdapter, parseShopifyGid, shopifyStockLinkFingerprint, shopifyStockLinkSkuQuery,
} from "../../adapters/shopify-stock-link.adapter";

/**
 * The stock-link engine's Shopify adapter with a mocked fetch (PLAN-CH2 v4.1 §6.1, §11.2): query building and
 * escaping, the pinned version, no redirects, first: 100, the paging bound, the exact filter, raw product statuses,
 * blank SKUs, `nodes` null, count and id contracts, every provider refusal's class and scope, Retry-After, THROTTLED,
 * the cost floor, invalid answers and the fingerprint. No network.
 */

const TOKEN = "test-only-stock-link-token";
const NOW = new Date("2026-10-27T12:00:00.000Z");
const destination: StockLinkDestination = {
  publicationTargetId: 41, destinationKind: "channel_connection", providerKey: "shopify", channelId: 35,
  channelConnectionId: 7, dropshipStoreConnectionId: null, providerScopeType: "location", externalScopeId: "98765",
  targetRevision: "3",
};
const login: ShopifyIdentityConnection = {
  id: 7, channelId: 35, shopDomain: "card-shellz.myshopify.com", accessToken: TOKEN,
  // The connection's own saved version is never used: the adapter pins SHOPIFY_STOCK_LINK_API_VERSION.
  apiVersion: "2024-01", shopifyLocationId: "98765",
};

interface Answer { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }

function answer({ status = 200, body, text, headers = {} }: Answer): Response {
  return new Response(text ?? JSON.stringify(body), { status,
    headers: { "Content-Type": "application/json", "X-Shopify-API-Version": SHOPIFY_STOCK_LINK_API_VERSION, ...headers } });
}

function setup(answers: Answer[], options: { connection?: () => Promise<ShopifyIdentityConnection> } = {}) {
  const request = vi.fn<typeof fetch>(async () => {
    const next = answers.shift();
    if (!next) throw new Error("No more mocked Shopify answers");
    return answer(next);
  });
  const shopifyConnection = vi.fn(options.connection ?? (async () => login));
  const adapter = createShopifyStockLinkAdapter({ connections: { shopifyConnection }, clock: () => NOW, request });
  const sent = (call = 0) => {
    const [url, init] = request.mock.calls[call]!;
    return { url, init: init!, body: JSON.parse(String(init!.body)) as { query: string; variables: Record<string, unknown> } };
  };
  return { adapter, request, shopifyConnection, sent };
}

const signal = () => ({ signal: new AbortController().signal });
const variant = (itemId: string, sku: string | null, status = "ACTIVE", productId = "500") => ({
  sku, inventoryItem: { id: `gid://shopify/InventoryItem/${itemId}` }, product: { id: `gid://shopify/Product/${productId}`, status },
});
const page = (nodes: unknown[], next: string | null = null, extensions?: unknown) => ({
  body: { data: { productVariants: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } },
    ...(extensions === undefined ? {} : { extensions }) },
});
const itemNode = (itemId: string, sku: string | null, status = "ACTIVE", productId = "500") => ({
  id: `gid://shopify/InventoryItem/${itemId}`, sku, variant: { product: { id: `gid://shopify/Product/${productId}`, status } },
});
const graphqlErrors = (...codes: (string | null)[]) => ({
  body: { errors: codes.map(code => ({ message: `private provider detail ${TOKEN}`, ...(code === null ? {} : { extensions: { code } }) })) },
});

async function refusal(promise: Promise<unknown>): Promise<ShopifyStockLinkProviderError> {
  const error = await promise.then(() => { throw new Error("Expected the read to be refused"); }, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ShopifyStockLinkProviderError);
  const refused = error as ShopifyStockLinkProviderError;
  expect(refused.scope).toBe("destination");
  // Never a credential or provider text, whatever the refusal.
  expect(JSON.stringify({ ...refused, message: refused.message })).not.toContain(TOKEN);
  expect(String(refused)).not.toContain("private provider detail");
  return refused;
}

describe("Shopify stock-link adapter: findItemsBySku", () => {
  it("builds one exact, escaped SKU search against the pinned version, never following redirects", async () => {
    const { adapter, request, sent } = setup([page([variant("111", 'A"B\\C')])]);
    const result = await adapter.findItemsBySku(destination, ['A"B\\C', "PLAIN-1"], signal());

    expect(shopifyStockLinkSkuQuery(['A"B\\C', "PLAIN-1"])).toBe('sku:"A\\"B\\\\C" OR sku:"PLAIN-1"');
    expect(request).toHaveBeenCalledTimes(1);
    const { url, init, body } = sent();
    expect(url).toBe("https://card-shellz.myshopify.com/admin/api/2026-10/graphql.json");
    expect(init).toMatchObject({ method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(body.variables).toEqual({ query: 'sku:"A\\"B\\\\C" OR sku:"PLAIN-1"', after: null });
    expect(body.query).toContain("productVariants(first: 100, query: $query, after: $after)");
    expect(body.query).toContain("nodes { sku inventoryItem { id } product { id status } }");
    expect(body.query).toContain("pageInfo { hasNextPage endCursor }");
    expect(result).toEqual({ observedAt: NOW.toISOString(), readFingerprint: shopifyStockLinkFingerprint(login),
      skus: ['A"B\\C', "PLAIN-1"], items: [{ itemId: "111", sku: 'A"B\\C', productId: "500", productStatus: "ACTIVE" }] });
  });

  it("keeps only items whose SKU equals an asked one (trimmed, case-insensitive); never blank, longer or prefix matches", async () => {
    const { adapter } = setup([page([
      variant("101", "ABC-1"), variant("102", " abc-1 "), variant("103", "ABC-10"), variant("104", null),
      variant("105", ""), variant("106", "   "), variant("107", `ABC-1${"X".repeat(100)}`), variant("108", "XYZ"),
    ])]);
    const result = await adapter.findItemsBySku(destination, ["ABC-1"], signal());
    expect(result.items.map(item => [item.itemId, item.sku])).toEqual([["101", "ABC-1"], ["102", " abc-1 "]]);
  });

  it("returns archived and draft copies with their raw status: only the engine decides what is on sale (C10)", async () => {
    const { adapter } = setup([page([variant("201", "P5", "ARCHIVED"), variant("202", "P5", "DRAFT"),
      variant("203", "P5", "ACTIVE"), variant("204", "P5", "UNLISTED")])]);
    const result = await adapter.findItemsBySku(destination, ["P5"], signal());
    expect(result.items.map(item => [item.itemId, item.productStatus])).toEqual([
      ["201", "ARCHIVED"], ["202", "DRAFT"], ["203", "ACTIVE"], ["204", "UNLISTED"]]);
    expect(result.items.filter(isStockLinkItemOnSale).map(item => item.itemId)).toEqual(["203"]);
  });

  it("reads every page up to the bound, passing each cursor once, and merges the answer in id order", async () => {
    const { adapter, request, sent } = setup([
      page([variant("9000", "P5")], "cursor-1"), page([variant("12", "P5")], "cursor-2"),
      page([variant("12", "P5"), variant("700", "P5")]),
    ]);
    const result = await adapter.findItemsBySku(destination, ["P5"], signal());
    expect(request).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map(call => sent(call).body.variables.after)).toEqual([null, "cursor-1", "cursor-2"]);
    expect(result.items.map(item => item.itemId)).toEqual(["12", "700", "9000"]);
  });

  it(`stops at ${SHOPIFY_STOCK_LINK_LOOKUP_PAGES_MAX} pages: a longer search is incomplete and nothing is returned`, async () => {
    const pages = Array.from({ length: SHOPIFY_STOCK_LINK_LOOKUP_PAGES_MAX + 1 }, (_, index) => page([variant(String(index + 1), "P5")], `cursor-${index}`));
    const { adapter, request } = setup(pages);
    const error = await refusal(adapter.findItemsBySku(destination, ["P5"], signal()));
    expect(request).toHaveBeenCalledTimes(SHOPIFY_STOCK_LINK_LOOKUP_PAGES_MAX);
    expect(error).toMatchObject({ code: "STOCK_LINK_LOOKUP_INCOMPLETE", errorClass: "transient" });
    expect(classifyStockLinkFailure(error)).toMatchObject({ kind: "transient", scope: "destination" });
  });

  it.each([
    { name: "a repeated cursor", pages: [page([variant("1", "P5")], "same"), page([variant("2", "P5")], "same")] },
    { name: "a missing cursor", pages: [page([variant("1", "P5")], "")] },
    { name: "an item answered twice differently", pages: [page([variant("1", "P5")], "c1"), page([variant("1", "P5", "ARCHIVED")])] },
    { name: "more than 100 nodes", pages: [page(Array.from({ length: 101 }, (_, index) => variant(String(index + 1), "P5")))] },
    { name: "an unexpected node shape", pages: [page([{ ...variant("1", "P5"), extra: true }])] },
  ])("treats $name as an unreadable answer (transient)", async ({ pages }) => {
    const { adapter } = setup(pages);
    expect(await refusal(adapter.findItemsBySku(destination, ["P5"], signal())))
      .toMatchObject({ code: "STOCK_LINK_PROVIDER_RESPONSE_INVALID", errorClass: "transient" });
  });

  it.each([
    { name: "a variant id where an inventory item id belongs", node: { ...variant("1", "P5"), inventoryItem: { id: "gid://shopify/ProductVariant/1" } } },
    { name: "a decimal id", node: { ...variant("1", "P5"), inventoryItem: { id: "1" } } },
    { name: "a padded gid", node: { ...variant("1", "P5"), inventoryItem: { id: " gid://shopify/InventoryItem/1" } } },
    { name: "a leading zero", node: { ...variant("1", "P5"), inventoryItem: { id: "gid://shopify/InventoryItem/01" } } },
    { name: "an id past the stock writer's safe range", node: variant("9007199254740993", "P5") },
    { name: "a malformed product id", node: { ...variant("1", "P5"), product: { id: "gid://shopify/Product/x", status: "ACTIVE" } } },
  ])("halts on $name: a malformed gid is fatal (STOCK_LINK_ID_INVALID)", async ({ node }) => {
    const { adapter } = setup([page([node])]);
    const error = await refusal(adapter.findItemsBySku(destination, ["P5"], signal()));
    expect(error).toMatchObject({ code: "STOCK_LINK_ID_INVALID", errorClass: "fatal" });
    expect(classifyStockLinkFailure(error)).toMatchObject({ kind: "fatal", scope: "destination" });
  });

  it.each([
    { name: "no SKU", skus: [] },
    { name: "51 SKUs", skus: Array.from({ length: 51 }, (_, index) => `SKU-${index}`) },
    { name: "an untrimmed SKU", skus: [" P5"] },
    { name: "a blank SKU", skus: [""] },
    { name: "a repeated SKU", skus: ["P5", "P5"] },
    { name: "a 101-character SKU", skus: ["X".repeat(101)] },
  ])("refuses $name before any HTTP: the engine broke the port's contract (fatal)", async ({ skus }) => {
    const { adapter, request, shopifyConnection } = setup([]);
    expect(await refusal(adapter.findItemsBySku(destination, skus, signal())))
      .toMatchObject({ code: "STOCK_LINK_ADAPTER_CONTRACT", errorClass: "fatal" });
    expect(request).not.toHaveBeenCalled();
    expect(shopifyConnection).not.toHaveBeenCalled();
  });

  it("accepts exactly 50 SKUs and 100-character SKUs", async () => {
    const skus = [...Array.from({ length: 49 }, (_, index) => `SKU-${index}`), "Y".repeat(100)];
    const { adapter, sent } = setup([page([variant("1", "Y".repeat(100))])]);
    const result = await adapter.findItemsBySku(destination, skus, signal());
    expect(result.items).toHaveLength(1);
    expect(String(sent().body.variables.query).split(" OR ")).toHaveLength(50);
  });
});

describe("Shopify stock-link adapter: observeItems", () => {
  it("reads saved items by id in the asked order; a deleted item is null; SKUs are raw (blank included)", async () => {
    const { adapter, sent } = setup([{ body: { data: { nodes: [itemNode("301", "P5"), null, itemNode("303", null, "ARCHIVED"),
      itemNode("304", "  ")] } } }]);
    const result = await adapter.observeItems(destination, ["301", "302", "303", "304"], signal());
    expect(sent().body.variables).toEqual({ ids: ["gid://shopify/InventoryItem/301", "gid://shopify/InventoryItem/302",
      "gid://shopify/InventoryItem/303", "gid://shopify/InventoryItem/304"] });
    expect(sent().body.query).toContain("nodes(ids: $ids)");
    expect(sent().body.query).toContain("... on InventoryItem { id sku variant { product { id status } } }");
    expect(sent().url).toBe("https://card-shellz.myshopify.com/admin/api/2026-10/graphql.json");
    expect(result).toEqual({ observedAt: NOW.toISOString(), readFingerprint: shopifyStockLinkFingerprint(login), observations: [
      { itemId: "301", item: { itemId: "301", sku: "P5", productId: "500", productStatus: "ACTIVE" } },
      { itemId: "302", item: null },
      { itemId: "303", item: { itemId: "303", sku: null, productId: "500", productStatus: "ARCHIVED" } },
      { itemId: "304", item: { itemId: "304", sku: "  ", productId: "500", productStatus: "ACTIVE" } },
    ] });
  });

  it.each([
    { name: "fewer nodes than ids", nodes: [itemNode("301", "P5")], ids: ["301", "302"], code: "STOCK_LINK_ADAPTER_CONTRACT" },
    { name: "more nodes than ids", nodes: [itemNode("301", "P5"), null], ids: ["301"], code: "STOCK_LINK_ADAPTER_CONTRACT" },
    { name: "another item at a position", nodes: [itemNode("999", "P5")], ids: ["301"], code: "STOCK_LINK_ADAPTER_CONTRACT" },
    { name: "a malformed item gid", nodes: [{ ...itemNode("301", "P5"), id: "gid://shopify/InventoryItem/abc" }], ids: ["301"], code: "STOCK_LINK_ID_INVALID" },
    { name: "a malformed product gid", nodes: [{ ...itemNode("301", "P5"), variant: { product: { id: "301", status: "ACTIVE" } } }], ids: ["301"], code: "STOCK_LINK_ID_INVALID" },
  ])("halts on $name (fatal)", async ({ nodes, ids, code }) => {
    const { adapter } = setup([{ body: { data: { nodes } } }]);
    const error = await refusal(adapter.observeItems(destination, ids, signal()));
    expect(error).toMatchObject({ code, errorClass: "fatal" });
    expect(classifyStockLinkFailure(error)).toMatchObject({ kind: "fatal", scope: "destination" });
  });

  it.each([
    { name: "no nodes list", data: { items: [] } },
    { name: "an item without a variant", data: { nodes: [{ id: "gid://shopify/InventoryItem/301", sku: "P5", variant: null }] } },
    { name: "a lower-case status", data: { nodes: [itemNode("301", "P5", "active")] } },
  ])("treats $name as an unreadable answer (transient)", async ({ data }) => {
    const { adapter } = setup([{ body: { data } }]);
    expect(await refusal(adapter.observeItems(destination, ["301"], signal())))
      .toMatchObject({ code: "STOCK_LINK_PROVIDER_RESPONSE_INVALID", errorClass: "transient" });
  });

  it.each([
    { name: "no id", ids: [] },
    { name: "101 ids", ids: Array.from({ length: 101 }, (_, index) => String(index + 1)) },
    { name: "a gid", ids: ["gid://shopify/InventoryItem/1"] },
    { name: "a repeated id", ids: ["1", "1"] },
  ])("refuses $name before any HTTP (fatal contract)", async ({ ids }) => {
    const { adapter, request } = setup([]);
    expect(await refusal(adapter.observeItems(destination, ids, signal()))).toMatchObject({ code: "STOCK_LINK_ADAPTER_CONTRACT" });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Shopify stock-link adapter: refusals (SAF-9, §4.6)", () => {
  const read = (adapter: ReturnType<typeof setup>["adapter"]) => adapter.findItemsBySku(destination, ["P5"], signal());

  it.each([
    { status: 401, code: "STOCK_LINK_STORE_AUTH_REFUSED", kind: "pause" },
    { status: 403, code: "STOCK_LINK_STORE_AUTH_REFUSED", kind: "pause" },
    { status: 402, code: "STOCK_LINK_STORE_UNAVAILABLE", kind: "pause" },
    { status: 423, code: "STOCK_LINK_STORE_UNAVAILABLE", kind: "pause" },
    { status: 408, code: "STOCK_LINK_PROVIDER_UNAVAILABLE", kind: "transient" },
    { status: 429, code: "STOCK_LINK_PROVIDER_THROTTLED", kind: "transient" },
    { status: 500, code: "STOCK_LINK_PROVIDER_UNAVAILABLE", kind: "transient" },
    { status: 503, code: "STOCK_LINK_PROVIDER_UNAVAILABLE", kind: "transient" },
    { status: 404, code: "STOCK_LINK_PROVIDER_REJECTED", kind: "fatal" },
    { status: 400, code: "STOCK_LINK_PROVIDER_REJECTED", kind: "fatal" },
    { status: 422, code: "STOCK_LINK_PROVIDER_REJECTED", kind: "fatal" },
    { status: 302, code: "STOCK_LINK_PROVIDER_REJECTED", kind: "fatal" },
  ])("HTTP $status → $code ($kind, destination), one request, body never read", async ({ status, code, kind }) => {
    const { adapter, request } = setup([{ status, text: `private provider detail ${TOKEN}`, headers: { Location: "https://attacker.example/" } }]);
    const error = await refusal(read(adapter));
    expect(error).toMatchObject({ code, context: expect.objectContaining({ httpStatus: status, publicationTargetId: 41 }) });
    expect(classifyStockLinkFailure(error)).toMatchObject({ kind, scope: "destination", code });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]?.redirect).toBe("error");
  });

  it.each<{ headers: Record<string, string>; retryAfterMs: number | null }>([
    { headers: { "Retry-After": "3" }, retryAfterMs: 3_000 },
    { headers: { "Retry-After": "999" }, retryAfterMs: 15_000 },
    { headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }, retryAfterMs: 15_000 },
    { headers: {}, retryAfterMs: null },
  ])("429 keeps the store's Retry-After (bounded): $headers", async ({ headers, retryAfterMs }) => {
    const { adapter } = setup([{ status: 429, text: "slow down", headers }]);
    const error = await refusal(read(adapter));
    expect(error).toMatchObject({ code: "STOCK_LINK_PROVIDER_THROTTLED", retryAfterMs });
    expect(classifyStockLinkFailure(error).retryAfterMs).toBe(retryAfterMs);
  });

  it("503 keeps a Retry-After too", async () => {
    const { adapter } = setup([{ status: 503, text: "maintenance", headers: { "Retry-After": "7" } }]);
    expect(await refusal(read(adapter))).toMatchObject({ code: "STOCK_LINK_PROVIDER_UNAVAILABLE", retryAfterMs: 7_000 });
  });

  it.each([
    { codes: ["THROTTLED"], code: "STOCK_LINK_PROVIDER_THROTTLED", kind: "transient" },
    { codes: ["THROTTLED", "INTERNAL_SERVER_ERROR"], code: "STOCK_LINK_PROVIDER_THROTTLED", kind: "transient" },
    { codes: ["INTERNAL_SERVER_ERROR"], code: "STOCK_LINK_PROVIDER_UNAVAILABLE", kind: "transient" },
    { codes: ["internal_error", "SERVICE_UNAVAILABLE"], code: "STOCK_LINK_PROVIDER_UNAVAILABLE", kind: "transient" },
    { codes: ["ACCESS_DENIED"], code: "STOCK_LINK_PROVIDER_REJECTED", kind: "fatal" },
    { codes: ["undefinedField"], code: "STOCK_LINK_PROVIDER_REJECTED", kind: "fatal" },
    { codes: ["GRAPHQL_VALIDATION_FAILED"], code: "STOCK_LINK_PROVIDER_REJECTED", kind: "fatal" },
    { codes: ["THROTTLED", "ACCESS_DENIED"], code: "STOCK_LINK_PROVIDER_REJECTED", kind: "fatal" },
    { codes: [null], code: "STOCK_LINK_PROVIDER_REJECTED", kind: "fatal" },
  ])("GraphQL $codes → $code ($kind), one request and one error, partial data unused", async ({ codes, code, kind }) => {
    const errors = graphqlErrors(...codes);
    const { adapter, request } = setup([{ body: { ...errors.body, data: { productVariants: { nodes: [variant("1", "P5")],
      pageInfo: { hasNextPage: false, endCursor: null } } } } }]);
    const error = await refusal(read(adapter));
    expect(error).toMatchObject({ code });
    expect(classifyStockLinkFailure(error)).toMatchObject({ kind, scope: "destination" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(error.context.graphqlCodes).toEqual(codes.map(value => value === null ? "OTHER" : value.toUpperCase()));
  });

  it("rejects errors that are not a list (fatal) and copies no provider prose into the context", async () => {
    const { adapter } = setup([{ body: { errors: `private provider detail ${TOKEN}` } }]);
    const error = await refusal(read(adapter));
    expect(error).toMatchObject({ code: "STOCK_LINK_PROVIDER_REJECTED", context: expect.objectContaining({ graphqlCodes: null }) });
  });

  it.each([
    { name: "invalid JSON", answer: { text: `private provider detail ${TOKEN}` } },
    { name: "a list envelope", answer: { body: [] } },
    { name: "no data", answer: { body: {} } },
    { name: "a data string", answer: { body: { data: "nope" } } },
  ])("$name is an unreadable answer (transient)", async ({ answer: reply }) => {
    const { adapter } = setup([reply]);
    const error = await refusal(read(adapter));
    expect(error).toMatchObject({ code: "STOCK_LINK_PROVIDER_RESPONSE_INVALID", errorClass: "transient" });
    expect(classifyStockLinkFailure(error)).toMatchObject({ kind: "transient", scope: "destination" });
  });

  it("a transport failure is transient and never quotes the failure", async () => {
    const request = vi.fn<typeof fetch>(async () => { throw new Error(`redirect https://attacker.example/ ${TOKEN}`); });
    const adapter = createShopifyStockLinkAdapter({ connections: { shopifyConnection: async () => login }, clock: () => NOW, request });
    const error = await refusal(adapter.observeItems(destination, ["1"], signal()));
    expect(error).toMatchObject({ code: "STOCK_LINK_PROVIDER_UNAVAILABLE", errorClass: "transient" });
    expect(String(error)).not.toContain("attacker.example");
  });

  it("the tick's own stop is busy, not a provider fault: no request once stopped, and a stop mid-request", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const { adapter, request } = setup([page([])]);
    const before = await refusal(adapter.findItemsBySku(destination, ["P5"], { signal: stopped.signal }));
    expect(before).toMatchObject({ code: "STOCK_LINK_CALL_BUDGET_USED" });
    expect(classifyStockLinkFailure(before)).toMatchObject({ kind: "busy", countsAttempt: false, scope: "destination" });
    expect(request).not.toHaveBeenCalled();

    const tick = new AbortController();
    const hanging = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const slow = createShopifyStockLinkAdapter({ connections: { shopifyConnection: async () => login }, clock: () => NOW, request: hanging });
    const pending = slow.observeItems(destination, ["1"], { signal: tick.signal });
    await vi.waitFor(() => expect(hanging).toHaveBeenCalledTimes(1));
    tick.abort();
    expect(await refusal(pending)).toMatchObject({ code: "STOCK_LINK_CALL_BUDGET_USED" });
  });

  it.each([
    { name: "another served version", headers: { "X-Shopify-API-Version": "2027-01" }, served: "2027-01" },
    { name: "a malformed served version", headers: { "X-Shopify-API-Version": "unstable; drop" }, served: null },
  ])("halts on $name: the pinned version's fields are the only ones it reads", async ({ headers, served }) => {
    const { adapter } = setup([{ ...page([variant("1", "P5")]), headers }]);
    const error = await refusal(read(adapter));
    expect(error).toMatchObject({ code: "STOCK_LINK_PROVIDER_REJECTED", errorClass: "fatal",
      context: expect.objectContaining({ servedApiVersion: served }) });
  });

  it("halts when the served version is not named at all", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(page([]).body), { status: 200 }));
    const adapter = createShopifyStockLinkAdapter({ connections: { shopifyConnection: async () => login }, clock: () => NOW, request });
    expect(await refusal(adapter.findItemsBySku(destination, ["P5"], signal()))).toMatchObject({ code: "STOCK_LINK_PROVIDER_REJECTED" });
  });
});

describe("Shopify stock-link adapter: the shared cost budget (SAF-14)", () => {
  const throttle = (currentlyAvailable: number, maximumAvailable = 2_000) => ({ cost: { requestedQueryCost: 112, actualQueryCost: 12,
    throttleStatus: { maximumAvailable, currentlyAvailable, restoreRate: 100 } } });

  it("stops reading below half the bucket: busy (no attempt) for the destination, the answer unused", async () => {
    const { adapter } = setup([page([variant("1", "P5")], null, throttle(999.5))]);
    const error = await refusal(adapter.findItemsBySku(destination, ["P5"], signal()));
    expect(error).toMatchObject({ code: "STOCK_LINK_PROVIDER_COST_FLOOR",
      context: expect.objectContaining({ currentlyAvailable: 999.5, maximumAvailable: 2_000 }) });
    expect(classifyStockLinkFailure(error)).toMatchObject({ kind: "busy", countsAttempt: false, scope: "destination" });
  });

  it("reads on at exactly half, and stops the next page as soon as the bucket drops", async () => {
    const { adapter, request } = setup([page([variant("1", "P5")], null, throttle(1_000))]);
    expect((await adapter.findItemsBySku(destination, ["P5"], signal())).items).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);

    const paging = setup([page([variant("1", "P5")], "c1", throttle(1_500)), page([variant("2", "P5")], "c2", throttle(400)),
      page([variant("3", "P5")])]);
    expect(await refusal(paging.adapter.findItemsBySku(destination, ["P5"], signal()))).toMatchObject({ code: "STOCK_LINK_PROVIDER_COST_FLOOR" });
    expect(paging.request).toHaveBeenCalledTimes(2);
  });

  it("an answer without a cost report reads on; a malformed cost report is unreadable (transient)", async () => {
    const plain = setup([page([variant("1", "P5")], null, { cost: { requestedQueryCost: 1 } })]);
    expect((await plain.adapter.findItemsBySku(destination, ["P5"], signal())).items).toHaveLength(1);
    const broken = setup([page([variant("1", "P5")], null, { cost: { throttleStatus: { currentlyAvailable: "lots" } } })]);
    expect(await refusal(broken.adapter.findItemsBySku(destination, ["P5"], signal())))
      .toMatchObject({ code: "STOCK_LINK_PROVIDER_RESPONSE_INVALID" });
  });
});

describe("Shopify stock-link adapter: the destination's own login", () => {
  it("resolves the destination's exact connection fresh for every call", async () => {
    const { adapter, shopifyConnection } = setup([page([]), { body: { data: { nodes: [null] } } }]);
    await adapter.findItemsBySku(destination, ["P5"], signal());
    await adapter.observeItems(destination, ["1"], signal());
    expect(shopifyConnection.mock.calls).toEqual([[35, 7], [35, 7]]);
  });

  it("a login that cannot be resolved pauses the destination (login refused); a database failure is the engine's", async () => {
    const unresolved = setup([], { connection: async () => {
      throw new ChannelIdentityError("CHANNEL_CONNECTION_UNRESOLVED", "Select exactly one configured Shopify account for this channel");
    } });
    const error = await refusal(unresolved.adapter.findItemsBySku(destination, ["P5"], signal()));
    expect(error).toMatchObject({ code: "STOCK_LINK_STORE_AUTH_REFUSED", context: expect.objectContaining({ causeCode: "CHANNEL_CONNECTION_UNRESOLVED" }) });
    expect(classifyStockLinkFailure(error)).toMatchObject({ kind: "pause", scope: "destination" });
    expect(unresolved.request).not.toHaveBeenCalled();

    const lost = Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P01" });
    const database = setup([], { connection: async () => { throw lost; } });
    await expect(database.adapter.findItemsBySku(destination, ["P5"], signal())).rejects.toBe(lost);
  });

  it.each([
    { name: "a domain outside myshopify.com", override: { shopDomain: "card-shellz.myshopify.com.attacker.example" } },
    { name: "a blank token", override: { accessToken: "  " } },
  ])("$name pauses the destination before any HTTP", async ({ override }) => {
    const { adapter, request } = setup([], { connection: async () => ({ ...login, ...override }) });
    expect(await refusal(adapter.findItemsBySku(destination, ["P5"], signal()))).toMatchObject({ code: "STOCK_LINK_STORE_AUTH_REFUSED" });
    expect(request).not.toHaveBeenCalled();
  });

  it("a connection of another destination is a broken contract (fatal), never read with", async () => {
    const { adapter, request } = setup([], { connection: async () => ({ ...login, channelId: 36 }) });
    expect(await refusal(adapter.findItemsBySku(destination, ["P5"], signal()))).toMatchObject({ code: "STOCK_LINK_ADAPTER_CONTRACT" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a Dropship destination", value: { ...destination, destinationKind: "dropship_store_connection", channelConnectionId: null, dropshipStoreConnectionId: 4 } },
    { name: "another provider", value: { ...destination, providerKey: "walmart" } },
  ])("refuses $name (fatal contract)", async ({ value }) => {
    const { adapter, request } = setup([]);
    expect(await refusal(adapter.findItemsBySku(value as StockLinkDestination, ["P5"], signal())))
      .toMatchObject({ code: "STOCK_LINK_ADAPTER_CONTRACT" });
    expect(request).not.toHaveBeenCalled();
  });

  it("stamps evidence with the injected clock before the first request, and refuses an invalid clock", async () => {
    const times = [new Date("2026-10-27T12:00:00.000Z"), new Date("2026-10-27T12:09:00.000Z")];
    const clock = vi.fn(() => times.shift()!);
    const request = vi.fn<typeof fetch>(async () => answer(page([variant("1", "P5")])));
    const adapter = createShopifyStockLinkAdapter({ connections: { shopifyConnection: async () => login }, clock, request });
    expect((await adapter.findItemsBySku(destination, ["P5"], signal())).observedAt).toBe("2026-10-27T12:00:00.000Z");
    expect(clock).toHaveBeenCalledTimes(1);

    const broken = createShopifyStockLinkAdapter({ connections: { shopifyConnection: async () => login }, clock: () => new Date(Number.NaN), request });
    expect(await refusal(broken.findItemsBySku(destination, ["P5"], signal()))).toMatchObject({ code: "STOCK_LINK_ADAPTER_CONTRACT" });
  });
});

describe("Shopify stock-link fingerprint and ids", () => {
  it("is a sha256 of the login that never contains the token, and changes with store, token, location or connection", () => {
    const base = shopifyStockLinkFingerprint(login);
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(base).not.toContain(TOKEN);
    for (const change of [{ accessToken: `${TOKEN}-rotated` }, { shopDomain: "other.myshopify.com" }, { shopifyLocationId: "11111" },
      { shopifyLocationId: null }, { id: 8 }]) {
      expect(shopifyStockLinkFingerprint({ ...login, ...change })).not.toBe(base);
    }
    // The pinned version is the adapter's own; a saved version change is not a login change.
    expect(shopifyStockLinkFingerprint({ ...login, apiVersion: "2025-07" } as ShopifyIdentityConnection)).toBe(base);
    expect(shopifyStockLinkFingerprint({ id: 7, shopDomain: null, accessToken: null, shopifyLocationId: null })).not.toBe(base);
  });

  it.each([
    ["gid://shopify/InventoryItem/42", "InventoryItem", "42"],
    ["gid://shopify/Product/42", "Product", "42"],
    ["gid://shopify/Product/42", "InventoryItem", null],
    ["gid://shopify/InventoryItem/0", "InventoryItem", null],
    ["gid://shopify/InventoryItem/42?x=1", "InventoryItem", null],
    ["gid://shopify/InventoryItem/9007199254740991", "InventoryItem", "9007199254740991"],
    ["gid://shopify/InventoryItem/9007199254740992", "InventoryItem", null],
  ] as const)("parses %s as a %s id: %s", (value, type, expected) => {
    expect(parseShopifyGid(type, value)).toBe(expected);
  });
});
