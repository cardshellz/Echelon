import { describe, expect, it, vi } from "vitest";
import { ShopifyOrderEditProvider } from "../../infrastructure/shopify-order-edit.provider";
import {
  orderEditCatalogProductsInputSchema,
  orderEditCatalogVariantsSchema,
} from "@shared/order-edits/order-edit-catalog";

const productId = "gid://shopify/Product/10";
const pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
  hasNextPage: false,
  endCursor: null,
};
const shop = { currencyCode: "USD" };
const product = (overrides: Record<string, unknown> = {}) => ({
  id: productId,
  title: "35PT 3x4 Premium Toploader",
  productType: "Toploaders",
  status: "ACTIVE",
  isGiftCard: false,
  requiresSellingPlan: false,
  onlineStoreUrl: "https://test.example/products/toploader",
  featuredImage: null,
  ...overrides,
});
const variant = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/ProductVariant/20",
  displayName: "35PT 3x4 Premium Toploader - Pack of 25",
  title: "Pack of 25",
  sku: "SHLZ-TOP-35PT-P25",
  price: "2.79",
  requiresComponents: false,
  availableForSale: true,
  inventoryPolicy: "DENY",
  sellableOnlineQuantity: 10,
  inventoryItem: { requiresShipping: true, tracked: true },
  product: {
    id: productId,
    title: "35PT 3x4 Premium Toploader",
    status: "ACTIVE",
    isGiftCard: false,
    requiresSellingPlan: false,
  },
  membershipVariant: null,
  planPrices: null,
  ...overrides,
});
function harness(response: unknown, credentials: Record<string, unknown> = {}) {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ data: response })));
  const provider = new ShopifyOrderEditProvider({
    clock: () => new Date("2026-10-09T12:00:00.000Z"),
    fetch: request,
    credentials: {
      get: async () => ({
        connectionId: 4,
        channelId: 36,
        shopDomain: "test.myshopify.com",
        accessToken: "synthetic-test-token",
        ...credentials,
      }),
    },
  });
  return {
    provider,
    catalog: provider.catalog,
    request,
    wire: () =>
      JSON.parse(String(request.mock.calls[0][1]?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      },
  };
}
const products = (nodes = [product()], page = pageInfo) => ({
  shop,
  products: { nodes, pageInfo: page },
});
const variants = (
  nodes = [variant()],
  overrides: Record<string, unknown> = {},
  page = pageInfo,
) => ({
  shop,
  product: product({ variants: { nodes, pageInfo: page }, ...overrides }),
});

describe("order edit catalog discovery", () => {
  it("searches the parent product title and SKU, preserving independent pack options", async () => {
    const h = harness(products());
    const result = await h.catalog.products(4, {
      search: "toploader",
      category: null,
      after: null,
    });
    expect(result.products[0]).toMatchObject({
      productId,
      title: "35PT 3x4 Premium Toploader",
      category: "Toploaders",
    });
    expect(h.wire().query).toContain("products(first: $first");
    expect(h.wire().query).not.toContain("productVariants(");
    expect(h.wire().variables).toEqual({
      first: 20,
      after: null,
      query:
        "status:active AND published_status:published AND ((title:toploader*) OR (sku:toploader*))",
    });
    expect(h.wire().query.trim().startsWith("query ")).toBe(true);
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  it("requires all name tokens, supports partial SKU and applies the real product type", async () => {
    const h = harness(products());
    await h.catalog.products(4, {
      search: "premium top",
      category: "Toploaders",
      after: "next-page",
    });
    expect(h.wire().variables).toEqual({
      first: 20,
      after: "next-page",
      query:
        'status:active AND published_status:published AND product_type:"Toploaders" AND ((title:premium* AND title:top*) OR (sku:premium* AND sku:top*))',
    });
    const sku = harness(products());
    await sku.catalog.products(4, {
      search: "SHLZ-TOP-35PT",
      category: null,
      after: null,
    });
    expect(sku.wire().variables.query).toContain("sku:SHLZ-TOP-35PT*");
  });
  it("cannot turn user text into Shopify field filters or remove publication/status guards", async () => {
    const h = harness(products());
    await h.catalog.products(4, {
      search: 'toploader") OR status:draft*',
      category: 'Toploaders" OR (status:draft)',
      after: null,
    });
    const query = String(h.wire().variables.query);
    expect(query).toContain(
      'product_type:"Toploaders\\" OR \\(status\\:draft\\)"',
    );
    expect(query).toContain(
      "title:toploader* AND title:OR* AND title:status* AND title:draft*",
    );
    expect(query).toContain("status:active AND published_status:published");
    expect(query).not.toContain(" OR status:draft");
  });
  it("browses without search and preserves cursors even when a page has no eligible products", async () => {
    const h = harness(
      products([product({ isGiftCard: true })], {
        hasNextPage: true,
        endCursor: "second",
      }),
    );
    const result = await h.catalog.products(4, {
      search: "",
      category: null,
      after: null,
    });
    expect(result.products).toEqual([]);
    expect(result.pageInfo).toEqual({ hasNextPage: true, endCursor: "second" });
    expect(h.wire().variables.query).toBe(
      "status:active AND published_status:published",
    );
  });
  it.each([
    { status: "DRAFT" },
    { status: "ARCHIVED" },
    { onlineStoreUrl: null },
    { isGiftCard: true },
    { requiresSellingPlan: true },
    { productType: "Other" },
  ])(
    "does not surface unpublished or unsupported products or another category: %j",
    async (patch) => {
      const h = harness(products([product(patch)]));
      expect(
        (
          await h.catalog.products(4, {
            search: "",
            category: "Toploaders",
            after: null,
          })
        ).products,
      ).toEqual([]);
    },
  );
  it("reads paginated category names, omits blank types and returns no credentials", async () => {
    const h = harness({
      shop,
      productTypes: {
        edges: [
          { node: "Toploaders" },
          { node: "Binders" },
          { node: "" },
          { node: "Toploaders" },
        ],
        pageInfo: { hasNextPage: true, endCursor: "more-types" },
      },
    });
    const result = await h.catalog.categories(4, { after: "first-types" });
    expect(result).toEqual({
      connectionId: 4,
      input: { after: "first-types" },
      categories: ["Toploaders", "Binders"],
      pageInfo: { hasNextPage: true, endCursor: "more-types" },
    });
    expect(h.wire().variables).toEqual({ first: 250, after: "first-types" });
    expect(JSON.stringify(result)).not.toContain("synthetic-test-token");
  });
  it("groups SKU options by verified parent identity with exact cents and independent availability", async () => {
    const h = harness(
      variants([
        variant(),
        variant({
          id: "gid://shopify/ProductVariant/21",
          title: "Case of 1000",
          sku: "SHLZ-TOP-35PT-C1000",
          price: "119.99",
          sellableOnlineQuantity: 0,
        }),
      ]),
    );
    const result = await h.catalog.productVariants(4, {
      productId,
      after: null,
    });
    expect(result.variants).toEqual([
      {
        variantId: "gid://shopify/ProductVariant/20",
        title: "35PT 3x4 Premium Toploader",
        variantTitle: "Pack of 25",
        sku: "SHLZ-TOP-35PT-P25",
        priceCents: 279,
        available: true,
      },
      {
        variantId: "gid://shopify/ProductVariant/21",
        title: "35PT 3x4 Premium Toploader",
        variantTitle: "Case of 1000",
        sku: "SHLZ-TOP-35PT-C1000",
        priceCents: 11999,
        available: false,
      },
    ]);
    expect(h.wire().variables).toEqual({
      id: productId,
      first: 50,
      after: null,
    });
    expect(orderEditCatalogVariantsSchema.safeParse(result).success).toBe(true);
  });
  it.each([
    { requiresComponents: true },
    { inventoryItem: { requiresShipping: false, tracked: true } },
    { product: { ...variant().product, isGiftCard: true } },
    { product: { ...variant().product, requiresSellingPlan: true } },
    { membershipVariant: { value: "true" } },
  ])(
    "shares quote eligibility rather than offering unsupported SKUs: %j",
    async (patch) => {
      const h = harness(variants([variant(patch)]));
      expect(
        (await h.catalog.productVariants(4, { productId, after: null }))
          .variants,
      ).toEqual([]);
    },
  );
  it.each([
    { availableForSale: false },
    { inventoryPolicy: "CONTINUE" },
    { sellableOnlineQuantity: -1 },
    { inventoryItem: { requiresShipping: true, tracked: false } },
  ])("shares the current stock gate: %j", async (patch) => {
    const h = harness(variants([variant(patch)]));
    expect(
      (await h.catalog.productVariants(4, { productId, after: null }))
        .variants[0].available,
    ).toBe(false);
  });
  it("allows a free SKU and safely represents the maximum integer-cent price", async () => {
    for (const [price, expected] of [
      ["0.00", 0],
      ["90071992547409.91", Number.MAX_SAFE_INTEGER],
    ] as const) {
      const h = harness(
        variants([variant({ price, title: "Default Title", sku: null })]),
      );
      expect(
        (await h.catalog.productVariants(4, { productId, after: null }))
          .variants[0],
      ).toMatchObject({ priceCents: expected, variantTitle: null, sku: null });
    }
  });
  it.each(["1.999", "NaN", "-1.00", "90071992547409.92"])(
    "refuses non-exact or overflowing money: %s",
    async (price) => {
      const h = harness(variants([variant({ price })]));
      await expect(
        h.catalog.productVariants(4, { productId, after: null }),
      ).rejects.toMatchObject({
        code:
          price === "90071992547409.92" ? "MONEY_OVERFLOW" : "MONEY_INVALID",
      });
    },
  );
  it.each([
    variants([], { id: "gid://shopify/Product/999" }),
    variants([
      variant({
        product: { ...variant().product, id: "gid://shopify/Product/999" },
      }),
    ]),
    variants([variant(), variant()]),
    variants([], {}, { hasNextPage: true, endCursor: null }),
    {
      shop: { currencyCode: "CAD" },
      product: product({ variants: { nodes: [], pageInfo } }),
    },
  ])(
    "rejects ambiguous identities, incomplete pages and non-USD responses",
    async (response) => {
      const h = harness(response);
      await expect(
        h.catalog.productVariants(4, { productId, after: null }),
      ).rejects.toMatchObject({
        code: "SHOPIFY_RESPONSE_INVALID",
        outcome: "rejected",
      });
    },
  );
  it("rejects missing, unpublished and foreign-store products", async () => {
    for (const response of [
      { shop, product: null },
      variants([], { onlineStoreUrl: null }),
    ]) {
      const h = harness(response);
      await expect(
        h.catalog.productVariants(4, { productId, after: null }),
      ).rejects.toMatchObject({ code: "CATALOG_PRODUCT_UNAVAILABLE" });
    }
    const h = harness(products(), { connectionId: 999 });
    await expect(
      h.catalog.products(4, {
        search: "toploader",
        category: null,
        after: null,
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
    expect(h.request).not.toHaveBeenCalled();
  });
  it("rejects duplicate product identities and non-advancing pages", async () => {
    const h = harness(products([product(), product()]));
    await expect(
      h.catalog.products(4, { search: "", category: null, after: null }),
    ).rejects.toMatchObject({ code: "SHOPIFY_RESPONSE_INVALID" });
    const samePage = harness(
      products([], { hasNextPage: true, endCursor: "same" }),
    );
    await expect(
      samePage.catalog.products(4, {
        search: "",
        category: null,
        after: "same",
      }),
    ).rejects.toMatchObject({ code: "SHOPIFY_RESPONSE_INVALID" });
  });
  it("validates inputs before querying and fails closed on invalid image URLs", async () => {
    const h = harness(products());
    await expect(
      h.catalog.products(4, { search: "*", category: null, after: null }),
    ).rejects.toThrow();
    await expect(
      h.catalog.productVariants(4, {
        productId: "gid://shopify/Order/10",
        after: null,
      }),
    ).rejects.toThrow();
    expect(h.request).not.toHaveBeenCalled();
    expect(
      orderEditCatalogProductsInputSchema.safeParse({
        search: "toploader",
        price: 1,
      }).success,
    ).toBe(false);
    const badImage = harness(
      products([product({ featuredImage: { url: "javascript:alert(1)" } })]),
    );
    await expect(
      badImage.catalog.products(4, {
        search: "toploader",
        category: null,
        after: null,
      }),
    ).rejects.toMatchObject({ code: "SHOPIFY_RESPONSE_INVALID" });
  });
  it("keeps legacy variant search working with parent product names", async () => {
    const h = harness({
      shop,
      productVariants: { nodes: [] },
      products: { nodes: [product({ variants: { nodes: [variant()] } })] },
    });
    expect((await h.provider.searchVariants(4, "toploader"))[0]).toMatchObject({
      id: "gid://shopify/ProductVariant/20",
      title: "35PT 3x4 Premium Toploader - Pack of 25",
      priceCents: 279,
      available: true,
    });
    expect(h.wire().variables.query).toContain("title:toploader*");
    expect(h.wire().query).toContain("products(first: 5");
  });
  it("legacy SKU search finds options beyond the first five and deduplicates both query roots", async () => {
    const found = variant({
      id: "gid://shopify/ProductVariant/999",
      sku: "EXACT-LATE-SKU",
    });
    const h = harness({
      shop,
      productVariants: {
        nodes: [
          {
            ...found,
            product: {
              ...found.product,
              onlineStoreUrl: "https://test.example/products/toploader",
            },
          },
        ],
      },
      products: { nodes: [product({ variants: { nodes: [found] } })] },
    });
    const results = await h.provider.searchVariants(4, "EXACT-LATE-SKU");
    expect(results).toHaveLength(1);
    expect(results[0].sku).toBe("EXACT-LATE-SKU");
    expect(h.wire().variables.skuQuery).toBe(
      "product_status:active AND published_status:published AND (sku:EXACT-LATE-SKU*)",
    );
  });
  it("rejects a repeated option inside a legacy product instead of hiding inconsistent provider data", async () => {
    const h = harness({
      shop,
      productVariants: { nodes: [] },
      products: {
        nodes: [product({ variants: { nodes: [variant(), variant()] } })],
      },
    });
    await expect(
      h.provider.searchVariants(4, "toploader"),
    ).rejects.toMatchObject({ code: "SHOPIFY_RESPONSE_INVALID" });
  });
});
