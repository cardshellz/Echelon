import { describe, expect, it, vi } from "vitest";
import { shopifyProductConnectionRequestSchema } from "@shared/catalog/shopify-product-connection";
import { buildShopifyConnectionCreateSpec } from "../../shopify-product-connection.domain";
import { connectionOwnership, createShopifyProductConnectionProvider } from "../../shopify-product-connection.provider";
import { createProductConnectionApi } from "../support/shopify-product-connection.api";
import { CONNECTION_COMMAND_KEY, connectionSource } from "../support/shopify-product-connection.fixture";

const credentials = { connectionId: 9, shopDomain: "test-store.myshopify.com", apiVersion: "2026-01", accessToken: "private-token" };
function setup() {
  const api = createProductConnectionApi();
  const provider = createShopifyProductConnectionProvider({ fetchImpl: api.fetchImpl, sleep: vi.fn(async () => undefined) });
  const source = connectionSource();
  const request = shopifyProductConnectionRequestSchema.parse({ channelId: 7, currency: "USD", mode: "create" });
  const spec = buildShopifyConnectionCreateSpec(source, request);
  return { api, provider, spec };
}

describe("Shopify product connection native boundary", () => {
  it.each([
    new Response(JSON.stringify({ data: null, errors: [{ message: "Internal failure", extensions: { code: "INTERNAL_SERVER_ERROR" } }] }), { status: 200 }),
    new Response("Request timeout", { status: 408 }),
  ])("retains ambiguous writes even when no GraphQL result was returned", async response => {
    const { spec } = setup(); const fetchImpl = vi.fn(async () => response.clone());
    const provider = createShopifyProductConnectionProvider({ fetchImpl });
    await expect(provider.create(credentials, { spec, ownership: connectionOwnership(7,41,CONNECTION_COMMAND_KEY), commandKey: CONNECTION_COMMAND_KEY, handle: "binder" }))
      .rejects.toMatchObject({ writeOutcome: "unknown", retryable: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("reads complete paginated variant identities and exact integer prices", async () => {
    const { api, provider } = setup();
    api.seed({ productId: "123", variants: Array.from({ length: 205 }, (_, index) => ({ sku: `SKU-${index}`, priceCents: 1234 })) });
    const product = await provider.product(credentials, "123");
    expect(product.variants).toHaveLength(205); expect(new Set(product.variants.map(row => row.id)).size).toBe(205);
    expect(product.variants.every(row => row.priceCents === 1234)).toBe(true);
    expect(api.operations.filter(operation => operation.operation === "EchelonConnectionProduct")).toHaveLength(3);
  });
  it("uses the pinned store, supported API version, credentials, and redirect refusal", async () => {
    const { api, provider } = setup(); await provider.capabilities(credentials);
    const [url, init] = api.fetchImpl.mock.calls[0];
    expect(url).toBe("https://test-store.myshopify.com/admin/api/2026-01/graphql.json");
    expect(init.redirect).toBe("error"); expect(init.headers).toMatchObject({ "X-Shopify-Access-Token": "private-token" });
    await expect(provider.capabilities({ ...credentials, shopDomain: "test-store.myshopify.com.evil.com" })).rejects.toMatchObject({ code: "SHOPIFY_CONNECTION_INVALID" });
    expect(api.fetchImpl).toHaveBeenCalledOnce();
  });
  it("never retries product creation blindly after a response was lost", async () => {
    const { api, provider, spec } = setup(); api.failAfter.add("EchelonConnectionCreate");
    const ownership = connectionOwnership(7, 41, CONNECTION_COMMAND_KEY);
    await expect(provider.create(credentials, { spec, ownership, commandKey: CONNECTION_COMMAND_KEY, handle: "binder" }))
      .rejects.toMatchObject({ code: "SHOPIFY_REQUEST_UNCERTAIN", writeOutcome: "unknown" });
    expect(api.operations.filter(operation => operation.operation === "EchelonConnectionCreate")).toHaveLength(1);
    expect((await provider.owned(credentials, CONNECTION_COMMAND_KEY, ownership))?.ownership).toBe(ownership);
  });
  it("creates only a draft, sanitizes untrusted HTML, and configures money/policies without quantity writes", async () => {
    const { api, provider, spec } = setup(); spec.descriptionHtml = '<p onclick="bad()">Safe</p><script>bad()</script>';
    const ownership = connectionOwnership(7, 41, CONNECTION_COMMAND_KEY);
    const id = await provider.create(credentials, { spec, ownership, commandKey: CONNECTION_COMMAND_KEY, handle: "binder" });
    await provider.createVariants(credentials, { productId: id, variants: spec.variants, ownership, removePlaceholder: true });
    const product = await provider.product(credentials, id);
    expect(product.status).toBe("DRAFT"); expect(product.variants.map(variant => variant.trackInventory)).toEqual([true,false]);
    const creation = api.operations.find(operation => operation.operation === "EchelonConnectionCreate")!;
    expect(creation.variables.product).toMatchObject({ status: "DRAFT", descriptionHtml: "<p>Safe</p>" });
    const batch = api.operations.find(operation => operation.operation === "EchelonConnectionVariants")!;
    expect((batch.variables.variants as Array<Record<string, unknown>>)[0].price).toBe("19.99");
    for (const variant of batch.variables.variants as Array<Record<string, unknown>>) {
      expect(variant).not.toHaveProperty("inventoryQuantities"); expect(variant).not.toHaveProperty("quantityAdjustments");
    }
  });
  it("waits for every photo to be ready and refuses failed photos before publication", async () => {
    const { api, provider, spec } = setup(); spec.images = [{ url: "https://cdn.example.com/binder.png", alt: "Binder" }];
    const id = await provider.create(credentials, { spec, ownership: connectionOwnership(7,41,CONNECTION_COMMAND_KEY), commandKey: CONNECTION_COMMAND_KEY, handle: "binder" });
    const native = [...api.products.values()][0]; native.media[0].status = "PROCESSING";
    await expect(provider.verifyMedia(credentials,id,1)).rejects.toMatchObject({ code: "SHOPIFY_MEDIA_PROCESSING", retryable: true });
    native.media[0].status = "READY"; await expect(provider.verifyMedia(credentials,id,1)).resolves.toBeUndefined();
    native.media[0].status = "FAILED"; native.media[0].mediaErrors = [{ code: "IMAGE_DOWNLOAD_FAILURE" }];
    await expect(provider.verifyMedia(credentials,id,1)).rejects.toMatchObject({ code: "SHOPIFY_MEDIA_REJECTED", retryable: false });
    expect(api.operations.filter(operation => operation.operation === "EchelonConnectionCreate")).toHaveLength(1);
  });
  it("retries bounded reads on 429 and never exposes private error text", async () => {
    const api = createProductConnectionApi();
    const fetch = vi.fn<typeof api.fetchImpl>().mockResolvedValueOnce(new Response("private diagnostic", { status: 429 }))
      .mockImplementation(api.fetchImpl);
    const sleep = vi.fn(async () => undefined);
    const provider = createShopifyProductConnectionProvider({ fetchImpl: fetch, sleep });
    expect((await provider.capabilities(credentials)).currency).toBe("USD"); expect(fetch).toHaveBeenCalledTimes(2); expect(sleep).toHaveBeenCalledOnce();
    const failed = createShopifyProductConnectionProvider({ fetchImpl: vi.fn(async () => new Response("private-token", { status: 500 })), sleep });
    await expect(failed.capabilities(credentials)).rejects.toThrow("HTTP 500");
    await expect(failed.capabilities(credentials)).rejects.not.toThrow("private-token");
  });
  it("classifies a definite create refusal separately from an unknown outcome", async () => {
    const { spec } = setup();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { productCreate: { product: null, userErrors: [{ message: "Invalid product" }] } } }), { status: 200 }));
    const provider = createShopifyProductConnectionProvider({ fetchImpl });
    await expect(provider.create(credentials, { spec, ownership: "proof", commandKey: CONNECTION_COMMAND_KEY, handle: "binder" }))
      .rejects.toMatchObject({ code: "SHOPIFY_CREATE_REJECTED", writeOutcome: "not_applied", retryable: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("returns only exact SKU evidence and never mistakes a missing product for an empty one", async () => {
    const { api, provider } = setup();
    api.seed({ productId: "123", variants: [{ sku: "OTHER" }] });
    expect(await provider.matches(credentials, ["MISSING"])).toEqual([]);
    await expect(provider.product(credentials, "999")).rejects.toMatchObject({ code: "SHOPIFY_PRODUCT_NOT_FOUND" });
  });
});
