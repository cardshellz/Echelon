import { describe, expect, it, vi } from "vitest";
import { ShopifyOrderEditProvider } from "../../infrastructure/shopify-order-edit.provider";
import {
  MemberPlanPresentationError,
  type MemberPlanPresentationReader,
} from "../../../membership";
import type { OrderEditCatalogPricingContext } from "../../application/order-edit-catalog";
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
  variants: { nodes: [variant()], pageInfo },
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
function harness(
  response: unknown,
  credentials: Record<string, unknown> = {},
  memberPresentation?: MemberPlanPresentationReader,
) {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ data: response })));
  const provider = new ShopifyOrderEditProvider({
    clock: () => new Date("2026-10-09T12:00:00.000Z"),
    fetch: request,
    memberPresentation,
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
  it("groups available SKU options by verified parent identity and hides unavailable options", async () => {
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
      (await h.catalog.productVariants(4, { productId, after: null })).variants,
    ).toEqual([]);
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

  it("hides fully unavailable products but keeps products with an available supported pack", async () => {
    const soldOut = variant({ sellableOnlineQuantity: 0 });
    const h = harness(
      products([
        product({
          id: "gid://shopify/Product/11",
          variants: { nodes: [soldOut], pageInfo },
        }),
        product({
          variants: {
            nodes: [
              soldOut,
              variant({ id: "gid://shopify/ProductVariant/21" }),
            ],
            pageInfo,
          },
        }),
      ]),
    );
    const result = await h.catalog.products(4, {
      search: "",
      category: null,
      after: null,
    });
    expect(result.products.map((entry) => entry.productId)).toEqual([
      productId,
    ]);
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  it("reads further stock pages rather than hiding a product whose sixth option is available", async () => {
    const probe = {
      nodes: Array.from({ length: 5 }, (_unused, index) =>
        variant({
          id: `gid://shopify/ProductVariant/${20 + index}`,
          sellableOnlineQuantity: 0,
        }),
      ),
      pageInfo: { hasNextPage: true, endCursor: "stock-next" },
    };
    const h = harness(products([product({ variants: probe })]));
    h.request
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: products([product({ variants: probe })]) }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: variants([
              variant({ id: "gid://shopify/ProductVariant/26" }),
            ]),
          }),
        ),
      );
    const result = await h.catalog.products(4, {
      search: "",
      category: null,
      after: null,
    });
    expect(result.products).toHaveLength(1);
    const second = JSON.parse(String(h.request.mock.calls[1][1]?.body));
    expect(second.variables).toEqual({
      id: productId,
      first: 50,
      after: "stock-next",
    });
    expect(second.query.trim().startsWith("query ")).toBe(true);
  });
  it("preserves product pagination after stock filtering removes the whole page", async () => {
    const h = harness(
      products([product({ variants: { nodes: [], pageInfo } })], {
        hasNextPage: true,
        endCursor: "next-product",
      }),
    );
    expect(
      await h.catalog.products(4, { search: "", category: null, after: null }),
    ).toMatchObject({
      products: [],
      pageInfo: { hasNextPage: true, endCursor: "next-product" },
    });
  });
  it.each(["repeat-option", "repeat-cursor", "wrong-parent", "missing-stock"])(
    "rejects inconsistent stock continuation: %s",
    async (failure) => {
      const probe = {
        nodes: [variant({ sellableOnlineQuantity: 0 })],
        pageInfo: { hasNextPage: true, endCursor: "stock-next" },
      };
      const h = harness(products());
      const next = variants(
        failure === "repeat-option"
          ? probe.nodes
          : failure === "missing-stock"
            ? [variant({ availableForSale: undefined })]
            : [],
        failure === "wrong-parent" ? { id: "gid://shopify/Product/999" } : {},
        failure === "repeat-cursor" ? probe.pageInfo : pageInfo,
      );
      h.request
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ data: products([product({ variants: probe })]) }),
          ),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: next })));
      await expect(
        h.catalog.products(4, { search: "", category: null, after: null }),
      ).rejects.toMatchObject({ code: "SHOPIFY_RESPONSE_INVALID" });
    },
  );
  it("does not turn failed stock reads into an empty successful catalog", async () => {
    const probe = {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "stock-next" },
    };
    const h = harness(products());
    h.request
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: products([product({ variants: probe })]) }),
        ),
      )
      .mockRejectedValueOnce(new Error("synthetic network failure"));
    await expect(
      h.catalog.products(4, { search: "", category: null, after: null }),
    ).rejects.toMatchObject({ code: "SHOPIFY_UNAVAILABLE" });
  });
});

const CLUB_PLAN = "5f966934-9ff2-4966-9e8f-d4292ca3290e";
const OTHER_PLAN = "14d8698f-09d8-4dea-8089-fa9a1ec0fb28";
const clubPresentation = {
  planId: CLUB_PLAN,
  name: ".club",
  badgeText: ".club",
  memberPriceColor: "#4A8A3A",
  primaryColor: "#4A8A3A",
  iconUrl: null,
};
const memberContext = (
  overrides: Partial<OrderEditCatalogPricingContext> = {},
): OrderEditCatalogPricingContext => ({
  connectionId: 4,
  customerId: "gid://shopify/Customer/8",
  memberPlan: CLUB_PLAN,
  memberPricingEnabled: true,
  ...overrides,
});
const scopedInput = {
  productId,
  omsOrderId: 1,
  expectedRevision: "baseline",
  after: null,
};
const pricedVariant = (
  prices: unknown = {
    [CLUB_PLAN]: { cents: 233 },
    [OTHER_PLAN]: { cents: 99 },
  },
) => variant({ planPrices: { value: JSON.stringify(prices) } });

describe("order-scoped catalog member pricing", () => {
  it("uses the same exact-cent checkout projection for the verified customer's plan, with storefront display settings", async () => {
    const reader = { read: vi.fn(async () => clubPresentation) };
    const h = harness(variants([pricedVariant()]), {}, reader);
    const result = await h.catalog.productVariants(
      4,
      scopedInput,
      memberContext(),
    );
    expect(result.variants[0]).toMatchObject({
      priceCents: 233,
      retailPriceCents: 279,
      available: true,
    });
    expect(result.memberPlan).toEqual(clubPresentation);
    expect(reader.read).toHaveBeenCalledExactlyOnceWith(CLUB_PLAN);
    expect(h.wire().query).toContain('key: "plan_prices"');
    expect(h.wire().query).not.toContain("mutation");
    expect(h.wire().variables).not.toHaveProperty("customerId");
  });
  it.each([
    { memberPricingEnabled: false },
    { memberPlan: null },
    { memberPlan: OTHER_PLAN },
  ])("does not apply a different/disabled member plan: %j", async (patch) => {
    const reader = { read: vi.fn(async () => clubPresentation) };
    const h = harness(
      variants([pricedVariant({ [CLUB_PLAN]: { cents: 233 } })]),
      {},
      reader,
    );
    const result = await h.catalog.productVariants(
      4,
      scopedInput,
      memberContext(patch),
    );
    expect(result.variants[0]).toMatchObject({
      priceCents: 279,
      retailPriceCents: 279,
    });
    expect(result.memberPlan).toBeNull();
    expect(reader.read).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { [CLUB_PLAN]: { cents: 279 } },
    { [CLUB_PLAN]: { cents: 300 } },
    {},
  ])(
    "keeps retail when the projection has no better member price: %j",
    async (projection) => {
      const reader = { read: vi.fn(async () => clubPresentation) };
      const h = harness(
        variants([projection === null ? variant() : pricedVariant(projection)]),
        {},
        reader,
      );
      const result = await h.catalog.productVariants(
        4,
        scopedInput,
        memberContext(),
      );
      expect(result.variants[0]).toMatchObject({
        priceCents: 279,
        retailPriceCents: 279,
      });
      expect(reader.read).not.toHaveBeenCalled();
    },
  );
  it("supports a zero-cent member price without losing its badge", async () => {
    const h = harness(
      variants([pricedVariant({ [CLUB_PLAN]: { cents: 0 } })]),
      {},
      { read: async () => clubPresentation },
    );
    expect(
      await h.catalog.productVariants(4, scopedInput, memberContext()),
    ).toMatchObject({
      variants: [{ priceCents: 0, retailPriceCents: 279 }],
      memberPlan: clubPresentation,
    });
  });
  it.each([
    "not-json",
    JSON.stringify({ [CLUB_PLAN]: { cents: -1 } }),
    JSON.stringify({ [CLUB_PLAN]: { cents: 2.33 } }),
    JSON.stringify({ [CLUB_PLAN]: { cents: Number.MAX_SAFE_INTEGER + 1 } }),
  ])(
    "rejects malformed member pricing instead of inventing a price: %s",
    async (value) => {
      const h = harness(variants([variant({ planPrices: { value } })]));
      await expect(
        h.catalog.productVariants(4, scopedInput, memberContext()),
      ).rejects.toMatchObject({
        code:
          value === "not-json"
            ? "MEMBER_PRICE_INVALID"
            : "SHOPIFY_RESPONSE_INVALID",
      });
    },
  );
  it("rejects missing order context, foreign-store context and membership without a verified customer", async () => {
    const h = harness(variants());
    await expect(
      h.catalog.productVariants(4, scopedInput),
    ).rejects.toMatchObject({ code: "SHOPIFY_RESPONSE_INVALID" });
    for (const context of [
      memberContext({ connectionId: 99 }),
      memberContext({ customerId: null }),
    ])
      await expect(
        h.catalog.productVariants(4, scopedInput, context),
      ).rejects.toMatchObject({ code: "SHOPIFY_RESPONSE_INVALID" });
    expect(h.request).not.toHaveBeenCalled();
  });
  it("refuses missing, foreign or failed presentation rather than showing another plan's treatment", async () => {
    const readers = [
      undefined,
      { read: async () => ({ ...clubPresentation, planId: OTHER_PLAN }) },
      {
        read: async () => {
          throw new MemberPlanPresentationError("READ_FAILED");
        },
      },
    ];
    for (const reader of readers) {
      const h = harness(variants([pricedVariant()]), {}, reader);
      await expect(
        h.catalog.productVariants(4, scopedInput, memberContext()),
      ).rejects.toMatchObject({ outcome: "rejected" });
    }
  });
});
