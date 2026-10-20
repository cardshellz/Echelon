import { prepareChannelIntent } from "../../../marketplace-listings/prepared-channel-intent";
import { describe, expect, it, vi } from "vitest";
import {
  listingDraftItemSchema,
  listingRequirementsSchema,
  type ListingAccount,
  type ListingCatalogItem,
} from "@shared/types/channel-listing-publication";
import type { WalmartChannelService } from "../../adapters/walmart/walmart-channel.service";
import { WalmartApiError, WalmartClient } from "../../adapters/walmart/walmart-client";
import {
  WalmartListingApi,
  WALMART_LISTING_SPEC,
  listingJsonHash,
} from "../../adapters/walmart/walmart-listing-api";
import { WalmartListingProvider } from "../../adapters/walmart/walmart-listing.provider";
import {
  priceFromWalmart,
  compileListingSchema,
  listingSubmissionSchema,
  jsonObject,
  sameProductIdentifier,
  validProductIdentifier,
} from "../../adapters/walmart/walmart-listing-schema";
import {
  runWithListingSetupAdmission,
  type ListingSetupIntent,
} from "../../../inventory-planning/application/listing-setup-intent";
// Official recommended schemas, 2026-09-27, with documentation annotations removed.
// MP_ITEM is restricted to its real Trading Card Sleeves & Holders branch; its
// validation keywords, enums, required fields and conditionals are unchanged.
// https://developer.walmart.com/file/mp/us/Consolidated_Schema_File_MP_ITEM.zip
// https://developer.walmart.com/file/mp/us/MP_ITEM_MATCH_Consolidated_Schema.zip
import createSchema from "../fixtures/walmart-listing-sleeves.schema.json";
import matchSchema from "../fixtures/walmart-listing-match.schema.json";
import legacyCatalogMatch from "../fixtures/walmart-catalog-match-4.2.response.json";
import { createCatalogPublicImageUrl } from "../../../catalog/catalog-public-image";
import { QuantityProviderEvidenceCollector } from "../../../inventory-planning/application/quantity-provider-request-evidence";

const account: ListingAccount = {
  channelId: 104,
  connectionId: 5,
  provider: "walmart",
  market: "us",
  environment: "production",
  accountId: "12345",
  scopeId: "12345",
  revision: 2,
};
const operationId = "01900000-0000-4000-8000-000000000001";
const correlationId = "01900000-0000-4000-8000-000000000002";
const type = "Trading Card Sleeves & Holders";
const identifier = { type: "UPC" as const, value: "036000291452" };
const catalog: ListingCatalogItem = {
  variantId: 10,
  productId: 20,
  sku: "SLEEVES-100",
  name: "Test sleeves",
  variantName: "100 sleeves",
  unitLabel: "100 count pack",
  productType: null,
  title: "Test brand card sleeves, 100 count",
  description: "Clear protective sleeves for trading cards",
  brand: "Test brand",
  images: ["https://example.com/sleeves.jpg"],
  identifier,
  priceCents: 1299,
  basePriceCents: 999,
  priceSource: "channel",
  appliedRule: null,
  appliedRuleScope: null,
  eligible: true,
  alreadyLinked: false,
  sourceHash: "a".repeat(64),
};
const draft = () =>
  listingDraftItemSchema.parse({
    variantId: 10,
    productType: type,
    attributes: {
      Orderable: {
        ShippingWeight: 0.1,
        country_of_origin_substantial_transformation: "United States",
      },
      Visible: {
        condition: "New",
        keyFeatures: [
          "Clear card protection",
          "One hundred sleeves per pack",
          "For standard trading cards",
        ],
        countPerPack: 100,
        multipackQuantity: 1,
        isProp65WarningRequired: "No",
        has_written_warranty: "No",
        netContent: {
          productNetContentUnit: "Each",
          productNetContentMeasure: 100,
        },
        pieceCount: 100,
      },
    },
  });
const intent = (): ListingSetupIntent => ({
  operationId,
  publicationTargetId: 3,
  expectedTargetRevision: "1",
  channelId: 104,
  channelConnectionId: 5,
  partnerId: "12345",
  environment: "production",
  shipNodeId: "12345",
  items: [{ productVariantId: 10, sku: "SLEEVES-100", quantity: 0 }],
});

function setup() {
  const api = {
    requirements: vi.fn(async (feedType: keyof typeof WALMART_LISTING_SPEC) => {
      const schema = feedType === "MP_ITEM" ? createSchema : matchSchema;
      return {
        version: WALMART_LISTING_SPEC[feedType],
        schema,
        schemaHash: listingJsonHash(schema),
      };
    }),
    observe: vi
      .fn()
      .mockRejectedValue(
        new WalmartApiError("WALMART_HTTP_404", "Missing", false, 404),
      ),
    match: vi.fn().mockResolvedValue({
      feedType: "MP_ITEM_MATCH",
      version: WALMART_LISTING_SPEC.MP_ITEM_MATCH,
      payload: {
        MPItem: [
          {
            Item: {
              productIdentifiers: {
                productIdType: "GTIN",
                productId: "00036000291452",
              },
            },
          },
        ],
      },
    }),
    submitFeed: vi.fn().mockResolvedValue({ feedId: "feed@US" }),
    feedStatus: vi.fn(),
    taxonomy: vi.fn(),
  };
  const channels = {
    assertListingNotStopped: vi.fn(async () => {}),
    withListingWrites: vi.fn(async (_account: unknown, _skus: readonly string[], work: () => Promise<unknown>) => work()),
    connection: vi.fn().mockResolvedValue({
      channel_id: 104,
      connection_id: 5,
      partner_id: "12345",
      ship_node_id: "12345",
      revision: 2,
      environment: "production",
    }),
    listingApi: vi.fn().mockReturnValue(api),
    requireRuntime: vi.fn(),
  };
  return {
    api,
    channels,
    provider: new WalmartListingProvider(
      channels as unknown as WalmartChannelService,
    ),
  };
}

describe("Walmart listing provider", () => {
  it("prepares the full product content and category for a proven recreation despite its retained local link", async () => {
    const { provider, api, channels } = setup();
    const input = { catalog: { ...catalog, alreadyLinked: true }, draft: draft(), priceCents: 1299 };
    expect((await provider.prepare(account, input)).issues).toContainEqual(expect.objectContaining({ code: "WALMART_VARIANT_INELIGIBLE" }));
    await provider.assertCanRecreate(account, catalog.sku);
    const prepared = await provider.prepare(account, { ...input, recreating: true });
    expect(prepared.issues).toEqual([]);
    expect(prepared.feedType).toBe("MP_ITEM");
    expect(prepared.payload).toMatchObject({
      Orderable: { sku: catalog.sku, price: 12.99, ShippingWeight: 0.1 },
      Visible: { [type]: { productName: catalog.title, brand: catalog.brand, mainImageUrl: catalog.images[0], pieceCount: 100 } },
    });
    expect(channels.assertListingNotStopped).toHaveBeenCalledWith(account, catalog.sku);
    expect(api.submitFeed).not.toHaveBeenCalled();
  });
  it("refuses a queued creation after a durable publication stop, without sending a feed", async () => {
    const { provider, api, channels } = setup();
    const item = await provider.prepare(account, { catalog, draft: draft(), priceCents: 1299 });
    channels.withListingWrites.mockRejectedValue(new WalmartApiError("LISTING_PUBLICATION_STOPPED", "Stopped", false));
    await expect(runWithListingSetupAdmission(intent(), () => provider.submit(account, {
      operationId, correlationId, items: [item], stockAdmission: intent(), beforeSubmit: async () => {},
    }))).rejects.toMatchObject({ code: "LISTING_PUBLICATION_STOPPED", effect: "not_sent" });
    expect(channels.withListingWrites).toHaveBeenCalledWith(account, [item.sku], expect.any(Function), intent());
    expect(api.submitFeed).not.toHaveBeenCalled();
  });
  it("includes an uploaded catalog photo as the third secondary image and preserves explicit listing overrides", async () => {
    const { provider } = setup();
    const uploaded = createCatalogPublicImageUrl({ CATALOG_PUBLIC_BASE_URL: "https://catalog.example.com" })(42, "ab".repeat(32), "image/jpeg");
    const images = ["https://cdn.example.com/main.jpg", "https://cdn.example.com/second.jpg", "https://cdn.example.com/third.jpg", uploaded];
    const prepared = await provider.prepare(account, { catalog: { ...catalog, images }, draft: draft(), priceCents: 1299 });
    expect(prepared.issues).toEqual([]);
    expect(prepared.payload.Visible).toMatchObject({ [type]: { mainImageUrl: images[0], productSecondaryImageURL: images.slice(1) } });

    const override = ["https://cdn.example.com/custom.jpg"];
    const custom = await provider.prepare(account, { catalog: { ...catalog, images }, draft: { ...draft(), images: override }, priceCents: 1299 });
    expect(custom.issues).toEqual([]);
    expect(custom.payload.Visible).toMatchObject({ [type]: { mainImageUrl: override[0] } });
    expect(JSON.stringify(custom.payload)).not.toContain(uploaded);
  });
  it("validates a new exact-unit listing against the current real product-type schema", async () => {
    const { provider } = setup();
    const prepared = await provider.prepare(account, {
      catalog,
      draft: draft(),
      priceCents: 1299,
    });
    expect(prepared.issues).toEqual([]);
    expect(prepared.payload.Orderable).toMatchObject({
      sku: "SLEEVES-100",
      price: 12.99,
      inventory: [{ quantity: 0, fulfillmentCenterID: "12345" }],
    });
    expect(prepared.payload.Orderable).not.toHaveProperty("specProductType");
    expect(Object.keys(jsonObject(prepared.payload.Visible))).toEqual([type]);
    expect(prepared.schemaHash).toHaveLength(64);
  });

  it("uses the unmodified provider schema and rejects specProductType from outdated examples", async () => {
    const original = structuredClone(createSchema);
    const { provider } = setup();
    const prepared = await provider.prepare(account, { catalog, draft: draft(), priceCents: 1299 });
    const validate = compileListingSchema(listingSubmissionSchema(createSchema, "MP_ITEM", type));
    const header = { businessUnit: "WALMART_US", locale: "en", version: WALMART_LISTING_SPEC.MP_ITEM };
    const payload = { MPItemFeedHeader: header, MPItem: [prepared.payload] };
    expect(validate(payload)).toBe(true);
    const orderable = prepared.payload.Orderable as Record<string, unknown>;
    const withOffer = (offer: Record<string, unknown>) => ({ ...payload, MPItem: [{ ...prepared.payload, Orderable: offer }] });
    expect(validate(withOffer({ ...orderable, specProductType: type }))).toBe(false);
    expect(validate.errors).toContainEqual(expect.objectContaining({ keyword: "additionalProperties", params: { additionalProperty: "specProductType" } }));
    expect(validate(withOffer({ ...orderable, unknownField: "unexpected" }))).toBe(false);
    expect(validate(withOffer({ ...orderable, ShippingWeight: -1 }))).toBe(false);
    expect(createSchema).toEqual(original);
    expect(listingSubmissionSchema(createSchema, "MP_ITEM", type)).toBe(createSchema);
    expect(listingSubmissionSchema(matchSchema, "MP_ITEM_MATCH", "")).toBe(matchSchema);
    expect(() => listingSubmissionSchema(createSchema, "MP_ITEM", "Unknown type")).toThrow();
    expect(() => listingSubmissionSchema(createSchema, "MP_ITEM", "__proto__")).toThrow();
  });

  it("retains provider-supplied field constraints", async () => {
    const schema = structuredClone(createSchema);
    const orderable = jsonObject(schema.properties.MPItem.items.properties.Orderable);
    orderable.properties = { ...jsonObject(orderable.properties), ShippingWeight: { type: "number", minimum: 1 } };
    const { provider } = setup();
    const item = await provider.prepare(account, { catalog, draft: draft(), priceCents: 1299 });
    const validate = compileListingSchema(listingSubmissionSchema(schema, "MP_ITEM", type));
    expect(validate({ MPItemFeedHeader: { businessUnit: "WALMART_US", locale: "en", version: WALMART_LISTING_SPEC.MP_ITEM }, MPItem: [item.payload] })).toBe(false);
  });

  it.each([type, "default"])("blocks a previously prepared payload containing specProductType (%s) before sending", async (selector) => {
    const { provider, api } = setup();
    const item = await provider.prepare(account, { catalog, draft: draft(), priceCents: 1299 });
    const offer = item.payload.Orderable as Record<string, unknown>;
    offer.specProductType = selector;
    const beforeSubmit = vi.fn();
    await expect(runWithListingSetupAdmission(intent(), () => provider.submit(account, {
      operationId, correlationId, items: [item], stockAdmission: intent(), beforeSubmit,
    }))).rejects.toMatchObject({ code: "WALMART_LISTING_REVIEW_STALE", effect: "not_sent" });
    expect(api.submitFeed).not.toHaveBeenCalled();
  });

  it("sends the selected type and all content through the real API client as an unchanged JSON file", async () => {
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ access_token: "test-token", expires_in: 900, token_type: "Bearer" }))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ schema: createSchema }))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ feedId: "feed@US" }));
    const api = new WalmartListingApi(new WalmartClient({
      clientId: "test-client", clientSecret: "test-secret", environment: "production", market: "us",
    }, { fetch: fetchMock as typeof fetch, now: () => new Date("2026-10-05T12:00:00Z"), correlationId: () => correlationId }));
    const { channels } = setup();
    const provider = new WalmartListingProvider({ ...channels, listingApi: () => api } as unknown as WalmartChannelService);
    const images = Array.from({ length: 5 }, (_, index) => `https://example.com/sleeves-${index}.jpg`);
    const item = await provider.prepare(account, { catalog: { ...catalog, images }, draft: draft(), priceCents: 1299 });
    expect(item.issues).toEqual([]);
    const store = { start: vi.fn().mockResolvedValue("request-1"), finish: vi.fn().mockResolvedValue(undefined) };
    const collector = new QuantityProviderEvidenceCollector(store, () => new Date("2026-10-05T12:00:00Z"));
    await collector.run(() => runWithListingSetupAdmission(intent(), () => provider.submit(account, {
      operationId, correlationId, items: [item], stockAdmission: intent(), beforeSubmit: async () => {},
    })));
    collector.assertSingleCompletedRequest("POST", ["/v3/feeds?feedType=MP_ITEM"]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const [url, request] = fetchMock.mock.calls[4];
    expect(url).toBe("https://marketplace.walmartapis.com/v3/feeds?feedType=MP_ITEM");
    expect(request.body).toBeInstanceOf(FormData);
    const file = (request.body as FormData).get("file");
    expect(file).toBeInstanceOf(Blob);
    const sent = JSON.parse(await (file as Blob).text());
    expect(sent.MPItem).toEqual([item.payload]);
    expect(sent.MPItem[0].Orderable).not.toHaveProperty("specProductType");
    expect(Object.keys(sent.MPItem[0].Visible)).toEqual([type]);
    expect(sent.MPItem[0].Visible[type].productName).toBe(catalog.title);
    expect(sent.MPItem[0].Visible[type]).toMatchObject({ brand: catalog.brand, shortDescription: catalog.description,
      keyFeatures: jsonObject(draft().attributes.Visible).keyFeatures, mainImageUrl: images[0], productSecondaryImageURL: images.slice(1) });
    expect(compileListingSchema(createSchema)(sent)).toBe(true);
    expect(sent.MPItemFeedHeader.version).toBe(WALMART_LISTING_SPEC.MP_ITEM);
    expect(request.headers["Content-Type"]).toBeUndefined();
    expect(fetchMock.mock.calls[2][1].headers["Content-Type"]).toBe("application/json");
  });

  it("recreates an offer from the actual 4.2 catalog match using the same GTIN and a valid 5.x multipart feed", async () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const fetchMock = vi.fn(async (url: string, request: RequestInit) => {
      const target = new URL(url);
      if (target.pathname === "/v3/token") return json({ access_token: "test-token", expires_in: 900 });
      if (target.pathname === `/v3/items/${catalog.sku}`) return json({}, 404);
      if (target.pathname === "/v3/items/walmart/search") {
        expect(target.searchParams.get("gtin")).toBe("00850025354769");
        return json(legacyCatalogMatch);
      }
      if (target.pathname === "/v3/items/spec") {
        expect(JSON.parse(request.body as string)).toEqual({ feedType: "MP_ITEM_MATCH", version: WALMART_LISTING_SPEC.MP_ITEM_MATCH });
        return json({ schema: matchSchema });
      }
      if (target.pathname === "/v3/feeds" && request.method === "POST") return json({ feedId: "matched-feed@US" });
      throw new Error(`Unexpected test request ${request.method} ${target.pathname}`);
    });
    const api = new WalmartListingApi(new WalmartClient({ clientId: "test", clientSecret: "test", environment: "production", market: "us" },
      { fetch: fetchMock as typeof fetch, now: () => new Date("2026-10-14T00:00:00Z"), correlationId: () => correlationId }));
    const { channels } = setup();
    const provider = new WalmartListingProvider({ ...channels, listingApi: () => api } as unknown as WalmartChannelService);
    const identifier = { type: "GTIN" as const, value: "00850025354769" };
    const item = await provider.prepare(account, {
      catalog: { ...catalog, identifier, alreadyLinked: true, images: [], imageIssues: [{ code: "PHOTO_UNAVAILABLE", message: "Missing local photo", field: "images" }] },
      draft: { ...draft(), identifier, method: "match", recreateFromOperationId: operationId,
        attributes: { Orderable: { ShippingWeight: 3, condition: "New" } } },
      priceCents: 2499, recreating: true,
    });
    expect(item.issues).toEqual([]);
    const approved = { ...intent(), items: [{ ...intent().items[0], quantity: 37 }] };
    const original = structuredClone(item);
    const store = { start: vi.fn().mockResolvedValue("request-1"), finish: vi.fn().mockResolvedValue(undefined) };
    const collector = new QuantityProviderEvidenceCollector(store, () => new Date("2026-10-14T00:00:00Z"));
    await collector.run(() => runWithListingSetupAdmission(approved, () => provider.submit(account, {
      operationId, correlationId, items: [item], stockAdmission: approved, beforeSubmit: async () => {},
    })));
    collector.assertSingleCompletedRequest("POST", ["/v3/feeds?feedType=MP_ITEM_MATCH"]);
    const writes = fetchMock.mock.calls.filter(([url]) => new URL(url).pathname === "/v3/feeds");
    expect(writes).toHaveLength(1);
    const sent = JSON.parse(await ((writes[0][1].body as FormData).get("file") as Blob).text());
    expect(sent).toEqual({
      MPItemFeedHeader: { businessUnit: "WALMART_US", locale: "en", version: WALMART_LISTING_SPEC.MP_ITEM_MATCH },
      MPItem: [{ Item: { sku: catalog.sku, productIdentifiers: { productIdType: "GTIN", productId: identifier.value },
        price: 24.99, condition: "New", ShippingWeight: 3, inventory: [{ quantity: 37, fulfillmentCenterID: account.scopeId }] } }],
    });
    expect(compileListingSchema(matchSchema)(sent)).toBe(true);
    expect(item).toEqual(original);
    expect(fetchMock.mock.calls.filter(([url]) => new URL(url).pathname === "/v3/items/walmart/search")).toHaveLength(2);
  });

  it.each(["missing", "different identifier", "wrong feed", "malformed", "rate limited"])("does not send when the reviewed catalog match becomes %s", async failure => {
    const { provider, api, channels } = setup();
    const item = await provider.prepare(account, { catalog, draft: { ...draft(), method: "match", attributes: { Orderable: { ShippingWeight: 1, condition: "New" } } }, priceCents: 1299 });
    expect(item.issues).toEqual([]);
    if (failure === "missing") api.match.mockResolvedValue(null);
    if (failure === "different identifier") api.match.mockResolvedValue({ feedType: "MP_ITEM_MATCH", payload: { MPItem: [{ Item: { productIdentifiers: { productIdType: "GTIN", productId: "00850025354769" } } }] } });
    if (failure === "wrong feed") api.match.mockResolvedValue({ feedType: "MP_ITEM", payload: {} });
    if (failure === "malformed") api.match.mockResolvedValue({ feedType: "MP_ITEM_MATCH", payload: { MPItem: [] } });
    if (failure === "rate limited") api.match.mockRejectedValue(new WalmartApiError("WALMART_HTTP_429", "Retry later", true, 429));
    await expect(runWithListingSetupAdmission(intent(), () => provider.submit(account, {
      operationId, correlationId, items: [item], stockAdmission: intent(), beforeSubmit: async () => {},
    }))).rejects.toMatchObject({ effect: "not_sent" });
    expect(api.submitFeed).not.toHaveBeenCalled();
    expect(channels.withListingWrites).not.toHaveBeenCalled();
  });

  it("retains offer-specific photos when the matched condition requires them", async () => {
    const { provider } = setup();
    const prepared = await provider.prepare(account, {
      catalog,
      draft: { ...draft(), method: "match", attributes: { Orderable: { ShippingWeight: 1, condition: "Pre-Owned: Good" } } },
      priceCents: 1299,
    });
    expect(prepared.issues).toEqual([]);
    expect(prepared.payload.Item).toMatchObject({ condition: "Pre-Owned: Good", mainImageUrl: catalog.images[0] });
  });

  it.each(["missing photo", "failed inherited photo"])("blocks a non-new catalog offer with a %s", async failure => {
    const { provider, api } = setup();
    const photoIssue = { code: "CATALOG_IMAGE_UNAVAILABLE", message: "Missing local photo", field: "images" };
    const prepared = await provider.prepare(account, {
      catalog: { ...catalog, images: [], imageIssues: failure === "failed inherited photo" ? [photoIssue] : [] },
      draft: { ...draft(), method: "match", attributes: { Orderable: { ShippingWeight: 1, condition: "Pre-Owned: Good" } } },
      priceCents: 1299,
    });
    expect(prepared.issues.length).toBeGreaterThan(0);
    if (failure === "failed inherited photo") expect(prepared.issues).toContainEqual(photoIssue);
    expect(api.submitFeed).not.toHaveBeenCalled();
  });

  it("shows writable nested requirements without exposing quantity, identity or price controls", async () => {
    const { provider } = setup();
    const requirements = await provider.requirements(account, type, "create");
    expect(listingRequirementsSchema.safeParse(requirements).success).toBe(
      true,
    );
    const sections = requirements.schema.properties as Record<
      string,
      { properties: Record<string, unknown> }
    >;
    expect(sections.Orderable.properties).toHaveProperty(
      "country_of_origin_substantial_transformation",
    );
    for (const key of [
      "inventory",
      "sku",
      "price",
      "productIdentifiers",
      "specProductType",
      "SkuUpdate",
      "ProductIdUpdate",
      "automate_pricing",
    ])
      expect(sections.Orderable.properties).not.toHaveProperty(key);
    expect(sections.Visible.properties).not.toHaveProperty("productName");
    expect(sections.Visible.properties).toHaveProperty("netContent");
  });

  it("retains conditional requirements and refuses to invent country or compliance answers", async () => {
    const { provider } = setup();
    const item = draft();
    delete (item.attributes.Orderable as Record<string, unknown>)
      .country_of_origin_substantial_transformation;
    (
      item.attributes.Visible as Record<string, unknown>
    ).isProp65WarningRequired = "Yes";
    const prepared = await provider.prepare(account, {
      catalog,
      draft: item,
      priceCents: 1299,
    });
    expect(prepared.issues.map((item) => item.field)).toEqual(
      expect.arrayContaining([
        "/MPItem/0/Orderable/country_of_origin_substantial_transformation",
        "/MPItem/0/Visible/Trading Card Sleeves & Holders/prop65WarningText",
      ]),
    );
  });

  it("rejects a bad check digit before provider calls", async () => {
    const { provider, api } = setup();
    const item = draft();
    item.identifier = { type: "UPC", value: "036000291453" };
    const result = await provider.prepare(account, {
      catalog,
      draft: item,
      priceCents: 1299,
    });
    expect(result.issues[0].code).toBe("WALMART_IDENTIFIER_INVALID");
    expect(api.observe).not.toHaveBeenCalled();
  });

  it.each([
    "inventory",
    "SkuUpdate",
    "ProductIdUpdate",
    "price",
    "automate_pricing",
    "specProductType",
  ])("blocks protected attribute %s", async (key) => {
    const { provider, api } = setup();
    const item = draft();
    (item.attributes.Orderable as Record<string, unknown>)[key] = 1;
    expect(
      (
        await provider.prepare(account, {
          catalog,
          draft: item,
          priceCents: 1299,
        })
      ).issues[0].code,
    ).toBe("WALMART_PROTECTED_ATTRIBUTE");
    expect(api.observe).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing remote seller SKU", async () => {
    const { provider, api } = setup();
    api.observe.mockResolvedValue({ sku: catalog.sku });
    expect(
      (
        await provider.prepare(account, {
          catalog,
          draft: draft(),
          priceCents: 1299,
        })
      ).issues[0].code,
    ).toBe("WALMART_SKU_ALREADY_EXISTS");
  });

  it("matches an exact check-digit-verified identifier and uses the match schema", async () => {
    const { provider, api } = setup();
    const item = draft();
    item.method = "match";
    item.productType = "";
    item.attributes = { Orderable: { ShippingWeight: 0.1, condition: "New" } };
    const prepared = await provider.prepare(account, {
      catalog,
      draft: item,
      priceCents: 1299,
    });
    expect(prepared.issues).toEqual([]);
    expect(prepared.feedType).toBe("MP_ITEM_MATCH");
    expect(prepared.payload.Item).toMatchObject({
      productIdentifiers: { productIdType: "UPC", productId: "036000291452" },
    });
    expect(prepared.payload.Item).not.toHaveProperty("specProductType");
    const approved = { ...intent(), items: [{ ...intent().items[0], quantity: 23 }] };
    await runWithListingSetupAdmission(approved, () => provider.submit(account, {
      operationId, correlationId, items: [prepared], stockAdmission: approved, beforeSubmit: async () => {},
    }));
    expect(api.submitFeed).toHaveBeenCalledWith("MP_ITEM_MATCH", expect.objectContaining({ MPItem: [expect.objectContaining({
      Item: expect.objectContaining({ inventory: [{ quantity: 23, fulfillmentCenterID: account.scopeId }] }),
    })] }), correlationId, approved);
  });

  it("blocks a provider match for another identifier", async () => {
    const { provider, api } = setup();
    const item = draft();
    item.method = "match";
    item.attributes = { Orderable: { ShippingWeight: 0.1, condition: "New" } };
    api.match.mockResolvedValue({
      feedType: "MP_ITEM_MATCH",
      version: WALMART_LISTING_SPEC.MP_ITEM_MATCH,
      payload: {
        MPItem: [
          {
            Item: {
              productIdentifiers: {
                productIdType: "UPC",
                productId: "012345678905",
              },
            },
          },
        ],
      },
    });
    expect(
      (
        await provider.prepare(account, {
          catalog,
          draft: item,
          priceCents: 1299,
        })
      ).issues[0].code,
    ).toBe("WALMART_CATALOG_IDENTIFIER_MISMATCH");
  });

  it("requires runtime inventory-owned admission before submitting even zero", async () => {
    const { provider, api } = setup();
    const item = await provider.prepare(account, {
      catalog,
      draft: draft(),
      priceCents: 1299,
    });
    await expect(
      provider.submit(account, {
        operationId,
        correlationId,
        items: [item],
        stockAdmission: intent(),
        beforeSubmit: async () => {},
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_SETUP_ADMISSION_REQUIRED" });
    expect(api.submitFeed).not.toHaveBeenCalled();
    await expect(
      runWithListingSetupAdmission(intent(), () =>
        provider.submit(account, {
          operationId,
          correlationId,
          items: [item],
          stockAdmission: intent(),
          beforeSubmit: async () => {},
        }),
      ),
    ).resolves.toEqual({ submissionId: "feed@US" });
    expect(api.submitFeed).toHaveBeenCalledTimes(1);
  });

  it("uses the current admitted quantity instead of the saved review quantity without mutating the review", async () => {
    const { provider, api } = setup();
    const item = await provider.prepare(account, {
      catalog,
      draft: draft(),
      priceCents: 1299,
    });
    (item.payload.Orderable as Record<string, unknown>).inventory = [
      { quantity: 1, fulfillmentCenterID: "12345" },
    ];
    const approved = { ...intent(), items: [{ ...intent().items[0], quantity: 17 }] };
    await expect(
      runWithListingSetupAdmission(approved, () =>
        provider.submit(account, {
          operationId,
          correlationId,
          items: [item],
          stockAdmission: approved,
          beforeSubmit: async () => {},
        }),
      ),
    ).resolves.toEqual({ submissionId: "feed@US" });
    expect(api.submitFeed).toHaveBeenCalledWith("MP_ITEM", expect.objectContaining({ MPItem: [expect.objectContaining({
      Orderable: expect.objectContaining({ inventory: [{ quantity: 17, fulfillmentCenterID: account.scopeId }] }),
    })] }), correlationId, approved);
    expect((item.payload.Orderable as Record<string, unknown>).inventory).toEqual([{ quantity: 1, fulfillmentCenterID: account.scopeId }]);
    (item.payload.Orderable as Record<string, unknown>).inventory = [{ quantity: 17, fulfillmentCenterID: "wrong-node" }];
    await expect(runWithListingSetupAdmission(approved, () => provider.submit(account, {
      operationId, correlationId, items: [item], stockAdmission: approved, beforeSubmit: async () => {},
    }))).rejects.toMatchObject({ code: "WALMART_LISTING_STOCK_INVALID" });
    expect(api.submitFeed).toHaveBeenCalledTimes(1);
  });

  it("does not treat processed feeds with pending items as completed listings", async () => {
    const { provider, api } = setup();
    api.feedStatus.mockResolvedValue({
      feedId: "feed@US",
      feedStatus: "PROCESSED",
      itemsReceived: 1,
      itemDetails: {
        itemIngestionStatus: [
          {
            sku: catalog.sku,
            ingestionStatus: "INPROGRESS",
            pendingStatusDescription: "Review",
          },
        ],
      },
    });
    const result = await provider.status(account, "feed@US");
    expect(result.state).toBe("processed");
    expect(result.items[0].state).toBe("processing");
    expect(result.items[0].issues[0].code).toBe("WALMART_REVIEW_PENDING");
    expect(result.items[0].retryable).toBe(false);
  });

  it.each([
    ["PROCESSED", "DATA_ERROR", undefined, true],
    ["ERROR", "SYSTEM_ERROR", undefined, true],
    ["INPROGRESS", "DATA_ERROR", undefined, false],
    ["PROCESSED", "DATA_ERROR", "Pending review", false],
    ["PROCESSED", "SUCCESS", undefined, false],
  ])(
    "permits a fresh review only for proven terminal item rejection (%s/%s)",
    async (
      feedStatus,
      ingestionStatus,
      pendingStatusDescription,
      retryable,
    ) => {
      const { provider, api } = setup();
      api.feedStatus.mockResolvedValue({
        feedId: "feed@US",
        feedStatus,
        itemsReceived: 1,
        itemDetails: {
          itemIngestionStatus: [
            { sku: catalog.sku, ingestionStatus, pendingStatusDescription },
          ],
        },
      });
      const observation = (await provider.status(account, "feed@US")).items[0];
      expect(observation.retryable).toBe(retryable);
      if (pendingStatusDescription)
        expect(observation.state).toBe("processing");
    },
  );

  it("renews the lease during preflight and aborts if ownership is lost immediately before HTTP", async () => {
    const { provider, api } = setup();
    const item = await provider.prepare(account, {
      catalog,
      draft: draft(),
      priceCents: 1299,
    });
    const beforeSubmit = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        Object.assign(new Error("Lease lost"), { code: "LISTING_LEASE_LOST" }),
      );
    await expect(
      runWithListingSetupAdmission(intent(), () =>
        provider.submit(account, {
          operationId,
          correlationId,
          items: [item],
          stockAdmission: intent(),
          beforeSubmit,
        }),
      ),
    ).rejects.toMatchObject({ code: "LISTING_LEASE_LOST", effect: "not_sent" });
    expect(beforeSubmit).toHaveBeenCalledTimes(2);
    expect(api.submitFeed).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429])(
    "marks explicit recorded HTTP %i rejection as requiring a fresh review without replay",
    async (status) => {
      const { provider, api } = setup();
      const item = await provider.prepare(account, {
        catalog,
        draft: draft(),
        priceCents: 1299,
      });
      api.submitFeed.mockRejectedValueOnce(
        new WalmartApiError(
          `WALMART_HTTP_${status}`,
          "Explicit rejection",
          false,
          status,
          {
            status,
            correlationId,
            retryAfterMs: null,
            remainingTokens: null,
            nextReplenishmentAt: null,
            quantityOutcome: "rejected",
          },
        ),
      );
      await expect(
        runWithListingSetupAdmission(intent(), () =>
          provider.submit(account, {
            operationId,
            correlationId,
            items: [item],
            stockAdmission: intent(),
            beforeSubmit: async () => {},
          }),
        ),
      ).rejects.toMatchObject({
        code: `WALMART_HTTP_${status}`,
        effect: "rejected",
      });
      expect(api.submitFeed).toHaveBeenCalledOnce();
    },
  );

  it("quarantines write errors without physical rejection evidence", async () => {
    const { provider, api } = setup();
    const item = await provider.prepare(account, {
      catalog,
      draft: draft(),
      priceCents: 1299,
    });
    api.submitFeed.mockRejectedValueOnce(
      new WalmartApiError("WALMART_HTTP_429", "No recorded receipt", true, 429),
    );
    await expect(
      runWithListingSetupAdmission(intent(), () =>
        provider.submit(account, {
          operationId,
          correlationId,
          items: [item],
          stockAdmission: intent(),
          beforeSubmit: async () => {},
        }),
      ),
    ).rejects.toMatchObject({ effect: "uncertain" });
    expect(api.submitFeed).toHaveBeenCalledOnce();
  });

  it("collects every status page and rejects duplicate SKU observations", async () => {
    const { provider, api } = setup();
    const row = (index: number) => ({
      sku: `SKU-${index}`,
      ingestionStatus: "SUCCESS",
      wpid: `WPID-${index}`,
    });
    api.feedStatus
      .mockResolvedValueOnce({
        feedId: "feed@US",
        feedStatus: "PROCESSED",
        itemsReceived: 51,
        itemDetails: {
          itemIngestionStatus: Array.from({ length: 50 }, (_, index) =>
            row(index),
          ),
        },
      })
      .mockResolvedValueOnce({
        feedId: "feed@US",
        feedStatus: "PROCESSED",
        itemsReceived: 51,
        itemDetails: { itemIngestionStatus: [row(50)] },
      });
    expect((await provider.status(account, "feed@US")).items).toHaveLength(51);
    expect(api.feedStatus).toHaveBeenLastCalledWith("feed@US", 50);
    api.feedStatus.mockResolvedValue({
      feedId: "feed@US",
      feedStatus: "PROCESSED",
      itemsReceived: 2,
      itemDetails: { itemIngestionStatus: [row(1), row(1)] },
    });
    await expect(provider.status(account, "feed@US")).rejects.toMatchObject({
      code: "WALMART_FEED_DUPLICATE_SKU",
    });
  });

  it("rechecks remote absence before sending an approved batch", async () => {
    const { provider, api } = setup();
    const item = await provider.prepare(account, {
      catalog,
      draft: draft(),
      priceCents: 1299,
    });
    api.observe.mockResolvedValue({ sku: catalog.sku });
    await expect(
      runWithListingSetupAdmission(intent(), () =>
        provider.submit(account, {
          operationId,
          correlationId,
          items: [item],
          stockAdmission: intent(),
          beforeSubmit: async () => {},
        }),
      ),
    ).rejects.toMatchObject({ code: "WALMART_SKU_ALREADY_EXISTS" });
    expect(api.submitFeed).not.toHaveBeenCalled();
  });

  it("refuses stale account identity and does not contact the provider", async () => {
    const { provider, api } = setup();
    await expect(
      provider.taxonomy({ ...account, scopeId: "other-node" }),
    ).rejects.toMatchObject({ code: "WALMART_LISTING_ACCOUNT_CHANGED" });
    expect(api.taxonomy).not.toHaveBeenCalled();
  });
});

describe("Walmart listing response validation", () => {
  const metadata = {
    status: 200,
    correlationId,
    retryAfterMs: null,
    remainingTokens: null,
    nextReplenishmentAt: null,
  };
  it("rejects partial requirements rather than validating against an incomplete spec", async () => {
    const requestWithMetadata = vi.fn().mockResolvedValue({
      data: { schema: createSchema, errors: ["invalid type"] },
      metadata: { ...metadata, status: 207 },
    });
    await expect(
      new WalmartListingApi({ requestWithMetadata }).requirements(
        "MP_ITEM",
        type,
      ),
    ).rejects.toMatchObject({ code: "WALMART_PARTIAL_SPEC" });
  });
  it("rejects a response for another feed and encodes IDs", async () => {
    const requestWithMetadata = vi.fn().mockResolvedValue({
      data: { feedId: "another", feedStatus: "PROCESSED", itemsReceived: 0 },
      metadata,
    });
    await expect(
      new WalmartListingApi({ requestWithMetadata }).feedStatus("feed@US"),
    ).rejects.toMatchObject({ code: "WALMART_FEED_MISMATCH" });
    expect(requestWithMetadata.mock.calls[0][1]).toBe(
      "/v3/feeds/feed%40US?includeDetails=true&offset=0&limit=50",
    );
  });
  it("pins the schema version and refuses an incompatible requirements response", async () => {
    const changed = structuredClone(createSchema);
    changed.properties.MPItemFeedHeader.properties.version.enum = [
      "future-version",
    ];
    const requestWithMetadata = vi
      .fn()
      .mockResolvedValue({ data: { schema: changed }, metadata });
    await expect(
      new WalmartListingApi({ requestWithMetadata }).requirements(
        "MP_ITEM",
        type,
      ),
    ).rejects.toMatchObject({ code: "WALMART_SPEC_VERSION_MISMATCH" });
  });
  it("supports both documented taxonomy response envelopes without inferring category names", async () => {
    const category = {
      productTypeGroup: [{ productType: [{ productTypeName: type }] }],
    };
    const requestWithMetadata = vi
      .fn()
      .mockResolvedValueOnce({ data: { itemTaxonomy: [category] }, metadata })
      .mockResolvedValueOnce({ data: { itemTaxonomy: category }, metadata });
    const api = new WalmartListingApi({ requestWithMetadata });
    const expected = { productTypes: [type], entries: [{ productType: type, path: [], description: null }] };
    expect(await api.taxonomy()).toEqual(expected);
    expect(await api.taxonomy()).toEqual(expected);
  });
  it("sends regular prices as exact USD cents and validates the acknowledged SKU", async () => {
    const requestWithMetadata = vi
      .fn()
      .mockResolvedValueOnce({
        data: { ItemPriceResponse: { sku: catalog.sku, mart: "WALMART_US" } },
        metadata,
      })
      .mockResolvedValueOnce({
        data: { sku: "OTHER", mart: "WALMART_US" },
        metadata,
      });
    const api = new WalmartListingApi({ requestWithMetadata });
    await api.updatePrice(catalog.sku, 1299, correlationId);
    expect(requestWithMetadata.mock.calls[0]).toEqual([
      "PUT",
      "/v3/price",
      {
        sku: catalog.sku,
        pricing: [
          {
            currentPriceType: "BASE",
            currentPrice: { currency: "USD", amount: 12.99 },
          },
        ],
      },
      { correlationId },
    ]);
    await expect(
      api.updatePrice(catalog.sku, 1299, correlationId),
    ).rejects.toMatchObject({ code: "WALMART_SKU_MISMATCH" });
  });
  it("preserves exact cents and validates equivalent GTIN identifiers", () => {
    expect(priceFromWalmart("12.99")).toBe(1299);
    expect(() => priceFromWalmart("12.999")).toThrow();
    expect(validProductIdentifier({ type: "ISBN", value: "0306406152" })).toBe(
      true,
    );
    expect(
      sameProductIdentifier(identifier, {
        type: "GTIN",
        value: "00036000291452",
      }),
    ).toBe(true);
  });
  it("serializes the canonical reviewed URL plan and explicit draft price source without Catalog asset claims", async () => {
    const { provider } = setup();
    const edited = { ...draft(), images: ["https://example.com/reviewed.jpg", "https://example.com/reviewed.jpg"], priceOverrideCents: 1500 };
    const prepared = await provider.prepare(account, { catalog, draft: edited, priceCents: 1500 });
    expect(prepared.issues).toEqual([]);
    const intent = prepared.preparedIntent!;
    expect(intent.input).toMatchObject({ account: { owner: { kind: "channel", channelId: 104 }, connectionId: 5,
      accountId: "12345", environment: "production", marketplaceId: "us", inventoryScope: { kind: "location", locationId: "12345" }, configurationRevision: "2" },
      capability: { protocol: "feed", mediaVerification: "unavailable" }, mediaAction: "replace",
      prices: [{ variantId: 10, cents: 1500, currency: "USD", provenance: { kind: "reviewed_draft", variantId: 10 } }] });
    expect(intent.input.mediaPlan!.group).toMatchObject({ expected: 2,
      selected: [{ assetId: null, sourceIndex: 0, url: edited.images[0] }],
      omissions: [{ assetId: null, sourceIndex: 1, reason: "duplicate" }] });
    expect(jsonObject(jsonObject(prepared.payload.Visible)[type]).mainImageUrl).toBe(intent.input.mediaPlan!.group.selected[0].url);
    const again = await provider.prepare(account, { catalog, draft: edited, priceCents: 1500 });
    expect(again.preparedIntent!.intentHash).toBe(intent.intentHash);
  });

  it.each(["account", "connection", "environment", "marketplace", "revision"])("rejects a recomputed prepared %s scope without provider mutation", async scope => {
    const { provider, api } = setup();
    const prepared = await provider.prepare(account, { catalog, draft: draft(), priceCents: 1299 });
    const changed = structuredClone(prepared.preparedIntent!.input);
    if (scope === "account") changed.account.accountId = "another-seller";
    if (scope === "connection") changed.account.connectionId = 6;
    if (scope === "environment") changed.account.environment = "sandbox";
    if (scope === "marketplace") changed.account.marketplaceId = "ca";
    if (scope === "revision") changed.account.configurationRevision = "3";
    prepared.preparedIntent = prepareChannelIntent(changed);
    await expect(runWithListingSetupAdmission(intent(), () => provider.submit(account, {
      operationId, correlationId, items: [prepared], stockAdmission: intent(), beforeSubmit: async () => {},
    }))).rejects.toMatchObject({ code: "WALMART_LISTING_REVIEW_STALE", effect: "not_sent" });
    expect(api.submitFeed).not.toHaveBeenCalled();
  });

  it("keeps an immutable legacy review executable without inventing new source evidence", async () => {
    const { provider, api } = setup();
    const prepared = await provider.prepare(account, { catalog, draft: draft(), priceCents: 1299 });
    delete prepared.preparedIntent;
    await runWithListingSetupAdmission(intent(), () => provider.submit(account, {
      operationId, correlationId, items: [prepared], stockAdmission: intent(), beforeSubmit: async () => {},
    }));
    expect(api.submitFeed).toHaveBeenCalledOnce();
    expect(prepared.preparedIntent).toBeUndefined();
  });

});
