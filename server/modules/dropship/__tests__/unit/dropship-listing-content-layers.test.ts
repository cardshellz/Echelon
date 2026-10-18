import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ContentProfileState, SavedListingContent } from "../../../../../shared/dropship/listing-content";
import {
  categoryListingSettingRowSchema,
  productListingSettingRowSchema,
  type CategoryListingSettingRow,
  type CategoryListingSettingValues,
  type ProductListingSettingRow,
  type ProductListingSettingValues,
} from "../../../../../shared/dropship/listing-setting-values";
import {
  contentHash,
  listingCatalogHash,
  needsProductCatalogReview,
  prepareContentProfile,
  productCatalogHash,
  resolveContentTemplate,
  resolveListingContent,
} from "../../application/dropship-listing-content-resolver";
import { DropshipListingContentService, type ContentTransaction } from "../../application/dropship-listing-content-service";
import type { DropshipListingCatalogCandidate } from "../../application/dropship-listing-preview-service";
import { EMPTY_LISTING_SETTING_LAYERS, type ListingSettingLayers } from "../../application/dropship-listing-setting-layers";
import { EMPTY_CATEGORY_LISTING_SETTING_VALUES, EMPTY_PRODUCT_LISTING_SETTING_VALUES } from "../../domain/listing-setting-values";
import { readResolvedListingContents } from "../../infrastructure/dropship-listing-content.reader";
import { productValuesToColumns } from "../../infrastructure/dropship-listing-setting-shared.repository";
import { contentCandidate, noContentProfile } from "../fixtures/listing-content.fixture";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));

/*
 * Product and category settings in the description (plan PR 8b, 4.7): text
 * above and text below each from the product, an older group, the Card
 * Shellz category or the store template; the product's own main text, checked
 * against the product-level catalog hash (D17); and, with no product or
 * category part, exactly today's result and evidence (D1). The preview golden
 * (listing-preview-golden.test.ts) pins today's evidence hashes end to end.
 */

const NOW = new Date("2026-10-11T09:00:00.000Z");
const STORE = 22;
const VENDOR = 10;
const CATEGORY = 5;

function productRow(values: Partial<ProductListingSettingValues>, productId = 7): ProductListingSettingRow {
  return productListingSettingRowSchema.parse({ storeConnectionId: STORE, productId, revisionId: 900 + productId,
    updatedAt: NOW.toISOString(), values: { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, ...values } });
}
function categoryRow(values: Partial<CategoryListingSettingValues>, categoryId = CATEGORY): CategoryListingSettingRow {
  return categoryListingSettingRowSchema.parse({ storeConnectionId: STORE, categoryId, revisionId: 800 + categoryId,
    updatedAt: NOW.toISOString(), values: { ...EMPTY_CATEGORY_LISTING_SETTING_VALUES, ...values } });
}
function layersOf(products: readonly ProductListingSettingRow[], categories: readonly CategoryListingSettingRow[] = []): ListingSettingLayers {
  return { products: new Map(products.map((row) => [row.productId, row])), categories: new Map(categories.map((row) => [row.categoryId, row])) };
}
function inCategory(categoryId: number | null = CATEGORY): DropshipListingCatalogCandidate {
  return { ...contentCandidate(), categoryId };
}
const own = (text: string) => ({ mode: "own" as const, text });
const none = { mode: "none" as const };

/** A store template plus, optionally, older groups that match product 7. */
function profileWith(groups: Array<{ id: string; priority: number; introduction: string; footer: string }> = []): ContentProfileState {
  return { revisionId: 3, updatedAt: NOW.toISOString(), profile: {
    defaultTemplate: { introduction: "Store above", footer: "Store below" },
    groups: groups.map((group) => ({ id: group.id, name: `Group ${group.id}`, priority: group.priority,
      scope: { type: "product" as const, productId: 7 }, template: { introduction: group.introduction, footer: group.footer } })),
  } };
}

/** Today's evidence object, rebuilt from a result: the formula PR 8b must keep for a size no layer touches. */
function todaysEvidenceHash(input: { profile: ContentProfileState; saved: SavedListingContent | null },
  result: ReturnType<typeof resolveListingContent>): string {
  return contentHash({ renderer: 2, catalogHash: result.catalogHash, profileRevisionId: input.profile.revisionId,
    profileHash: prepareContentProfile(input.profile).hash, saved: input.saved, descriptionHtml: result.descriptionHtml, issues: result.issues });
}

describe("description with no product or category part (plan D1)", () => {
  const savedText: SavedListingContent = { revisionId: 4, customText: "Size words", catalogHash: listingCatalogHash(contentCandidate()),
    updatedAt: NOW.toISOString() };
  const cases: Array<[string, ContentProfileState, SavedListingContent | null]> = [
    ["no templates, Card Shellz text", noContentProfile, null],
    ["store template, Card Shellz text", profileWith(), null],
    ["a group, the size's own text", profileWith([{ id: "a", priority: 1, introduction: "Group above", footer: "" }]), savedText],
    ["two tied groups", profileWith([{ id: "a", priority: 1, introduction: "A", footer: "" }, { id: "b", priority: 1, introduction: "B", footer: "" }]), null],
  ];
  // Rows for another product, a category on a product with none, and a product
  // row that sets nothing the description uses: none of them may move a byte.
  const unrelated = layersOf([productRow({ textAbove: own("Elsewhere"), mainText: { text: "Other", catalogHash: "0".repeat(64) } }, 8),
    productRow({ storeShelf: none, shippingPolicy: { id: "ship-1", name: null } })], [categoryRow({ textAbove: own("Category above") })]);

  it.each(cases)("%s: every field and the evidence are today's", (_name, profile, saved) => {
    const today = resolveListingContent({ candidate: contentCandidate(), profile, saved });
    expect(today.evidenceHash).toBe(todaysEvidenceHash({ profile, saved }, today));
    for (const layers of [EMPTY_LISTING_SETTING_LAYERS, unrelated]) {
      expect(resolveListingContent({ candidate: contentCandidate(), profile, saved, layers })).toEqual(today);
    }
  });

  it("keeps the group's or the store's own template object and today's labels", () => {
    for (const [, profile] of cases) {
      const prepared = prepareContentProfile(profile);
      const today = resolveContentTemplate(prepared, contentCandidate());
      const withRows = resolveContentTemplate(prepared, contentCandidate(), unrelated);
      expect(withRows).toEqual(today);
      expect(withRows.template).toBe(today.template);
    }
    const prepared = prepareContentProfile(profileWith([{ id: "a", priority: 1, introduction: "Group above", footer: "" }]));
    const grouped = resolveContentTemplate(prepared, contentCandidate());
    expect(grouped.template).toBe(prepared.groups[0].group.template);
    expect(grouped).toMatchObject({ templateName: "Group a", groupName: "Group a", conflict: false,
      parts: { textAbove: { text: "Group above", source: "group_rule" }, textBelow: { text: "", source: "group_rule" } } });
    const store = resolveContentTemplate(prepareContentProfile(profileWith()), contentCandidate());
    expect(store).toMatchObject({ templateName: "Store template", groupName: null,
      parts: { textAbove: { source: "store_default" }, textBelow: { source: "store_default" } } });
    expect(resolveContentTemplate(prepareContentProfile(noContentProfile), contentCandidate())).toEqual({ template: null,
      templateName: null, groupName: null, conflict: false,
      parts: { textAbove: { text: "", source: "none" }, textBelow: { text: "", source: "none" } } });
  });
});

describe("text above and text below, closest first", () => {
  const resolve = (profile: ContentProfileState, layers: ListingSettingLayers, candidate = inCategory()) =>
    resolveListingContent({ candidate, profile, saved: null, layers });
  const template = (profile: ContentProfileState, layers: ListingSettingLayers, candidate = inCategory()) =>
    resolveContentTemplate(prepareContentProfile(profile), candidate, layers);

  it("takes each part from the product, else the category, else the store template", () => {
    const layers = layersOf([productRow({ textAbove: own("Product above") })], [categoryRow({ textBelow: own("Category below") })]);
    const result = resolve(profileWith(), layers);
    expect(result.descriptionHtml).toBe(`<p>Product above</p>${contentCandidate().description}<p>Category below</p>`);
    expect(template(profileWith(), layers)).toEqual({ template: { introduction: "Product above", footer: "Category below" },
      templateName: "This product", groupName: null, conflict: false,
      parts: { textAbove: { text: "Product above", source: "product" }, textBelow: { text: "Category below", source: "category" } } });
    const categoryOnly = template(profileWith(), layersOf([], [categoryRow({ textAbove: own("Category above") })]));
    expect(categoryOnly).toMatchObject({ templateName: "Category settings",
      parts: { textAbove: { text: "Category above", source: "category" }, textBelow: { text: "Store below", source: "store_default" } } });
  });

  it("puts an older group after the product and before the category", () => {
    const profile = profileWith([{ id: "a", priority: 1, introduction: "Group above", footer: "Group below" }]);
    const layers = layersOf([productRow({ textAbove: own("Product above") })],
      [categoryRow({ textAbove: own("Category above"), textBelow: own("Category below") })]);
    expect(template(profile, layers)).toMatchObject({ templateName: "This product", groupName: "Group a", conflict: false,
      parts: { textAbove: { text: "Product above", source: "product" }, textBelow: { text: "Group below", source: "group_rule" } } });
    expect(resolve(profile, layers).descriptionText).not.toContain("Category");
  });

  it("an explicit None stops the fall through with no text", () => {
    const productNone = template(profileWith([{ id: "a", priority: 1, introduction: "Group above", footer: "Group below" }]),
      layersOf([productRow({ textAbove: none, textBelow: none })]));
    expect(productNone).toMatchObject({ template: { introduction: "", footer: "" }, groupName: null,
      parts: { textAbove: { text: "", source: "product" }, textBelow: { text: "", source: "product" } } });
    const categoryNone = resolve(profileWith(), layersOf([], [categoryRow({ textAbove: none })]));
    expect(categoryNone.descriptionHtml).toBe(`${contentCandidate().description}<p>Store below</p>`);
  });

  it("works without a store template, and a product with no category ignores every category row", () => {
    const categoryLayers = layersOf([], [categoryRow({ textAbove: own("Category above") })]);
    expect(resolve(noContentProfile, categoryLayers).descriptionHtml).toBe(`<p>Category above</p>${contentCandidate().description}`);
    const noCategory = inCategory(null);
    expect(resolve(noContentProfile, categoryLayers, noCategory)).toEqual(resolveListingContent({ candidate: noCategory,
      profile: noContentProfile, saved: null }));
    expect(resolve(noContentProfile, categoryLayers, inCategory(CATEGORY + 1)).descriptionHtml).toBe(contentCandidate().description);
  });

  it("a tie between older groups is a conflict only for a part that reaches them", () => {
    const tied = profileWith([{ id: "a", priority: 1, introduction: "A", footer: "A" }, { id: "b", priority: 1, introduction: "B", footer: "B" }]);
    const both = resolve(tied, layersOf([productRow({ textAbove: own("Product above"), textBelow: none })]));
    expect(both.issues).toEqual([]);
    expect(both.descriptionHtml).toBe(`<p>Product above</p>${contentCandidate().description}`);
    const onlyAbove = layersOf([productRow({ textAbove: own("Product above") })]);
    expect(resolve(tied, onlyAbove).issues).toEqual(["listing_content_template_conflict"]);
    expect(template(tied, onlyAbove)).toEqual({ template: null, templateName: null, groupName: null, conflict: true,
      parts: { textAbove: { text: "Product above", source: "product" }, textBelow: { text: "", source: "none" } } });
    // A category below the tie never breaks it.
    expect(resolve(tied, layersOf([], [categoryRow({ textAbove: own("C"), textBelow: own("C") })])).issues)
      .toEqual(["listing_content_template_conflict"]);
  });

  it("never mutates its inputs", () => {
    const layers = layersOf([productRow({ textAbove: own("Product above"), mainText: { text: "Mine", catalogHash: productCatalogHash(contentCandidate()) } })],
      [categoryRow({ textBelow: own("Category below") })]);
    const candidate = inCategory();
    const profile = profileWith([{ id: "a", priority: 1, introduction: "G", footer: "G" }]);
    const before = structuredClone({ candidate, profile, products: [...layers.products.values()], categories: [...layers.categories.values()] });
    resolve(profile, layers, candidate);
    expect({ candidate, profile, products: [...layers.products.values()], categories: [...layers.categories.values()] }).toEqual(before);
  });
});

describe("the product's own main text", () => {
  const candidate = contentCandidate();
  const mainText = (text: string, catalogHash = productCatalogHash(candidate)) => ({ text, catalogHash });

  it("replaces the Card Shellz text for a size without its own, and counts as own text", () => {
    const result = resolveListingContent({ candidate, profile: profileWith(), saved: null,
      layers: layersOf([productRow({ mainText: mainText("Product words") })]) });
    expect(result.descriptionHtml).toBe("<p>Store above</p><p>Product words</p><p>Store below</p>");
    expect(result).toMatchObject({ source: "custom", revisionId: null, needsCatalogReview: false, issues: [],
      catalogHash: listingCatalogHash(candidate), catalogHtml: candidate.description });
  });

  it("gives way to a size's own text, whose check stays the per-size one", () => {
    const saved: SavedListingContent = { revisionId: 4, customText: "Size words", catalogHash: listingCatalogHash(candidate), updatedAt: NOW.toISOString() };
    const layers = layersOf([productRow({ mainText: mainText("Product words", "0".repeat(64)) })]);
    const result = resolveListingContent({ candidate, profile: noContentProfile, saved, layers });
    expect(result.descriptionHtml).toBe("<p>Size words</p>");
    expect(result).toMatchObject({ needsCatalogReview: false, issues: [], revisionId: 4 });
    expect(result).toEqual(resolveListingContent({ candidate, profile: noContentProfile, saved }));
  });

  it("asks for a check when the product's catalog facts changed, and keeps the text", () => {
    const written = productCatalogHash(candidate);
    const layers = layersOf([productRow({ mainText: mainText("Product words", written) })]);
    const changed = { ...candidate, description: "<p>New catalog words.</p>" };
    const result = resolveListingContent({ candidate: changed, profile: noContentProfile, saved: null, layers });
    expect(result).toMatchObject({ needsCatalogReview: true, issues: ["listing_content_catalog_review_required"], source: "custom" });
    expect(result.descriptionHtml).toBe("<p>Product words</p>");
    expect(needsProductCatalogReview({ catalogHash: written }, productCatalogHash(changed))).toBe(true);
    expect(needsProductCatalogReview({ catalogHash: written }, written)).toBe(false);
    expect(needsProductCatalogReview(null, written)).toBe(false);
  });

  it("a size-only catalog change does not ask the vendor to re-check product text (design record 8.3)", () => {
    const layers = layersOf([productRow({ mainText: mainText("Product words") })]);
    const sizeOnly = { ...candidate, productVariantId: 102, variantName: "Pack of 100", sku: "ARM-100", gtin: "012345678905",
      mpn: "ARM-100", unitsPerVariant: 100, catalogUnitsPerVariant: 100 };
    expect(listingCatalogHash(sizeOnly)).not.toBe(listingCatalogHash(candidate));
    expect(resolveListingContent({ candidate: sizeOnly, profile: noContentProfile, saved: null, layers }))
      .toMatchObject({ needsCatalogReview: false, issues: [] });
  });
});

describe("productCatalogHash (plan D17)", () => {
  const candidate = contentCandidate();
  const base = productCatalogHash(candidate);

  it("is the product's description, brand, condition and item specifics, tagged and keyed by product", () => {
    expect(base).toBe(contentHash({ kind: "product_catalog_v1", productId: 7, description: candidate.description,
      brand: "Card Shellz", condition: "NEW", itemSpecifics: [["Color", ["White"]]] }));
    expect(base).not.toBe(listingCatalogHash(candidate));
  });

  it.each([
    ["productVariantId", 999], ["variantName", "Pack of 100"], ["sku", "OTHER"], ["gtin", "012345678905"], ["mpn", "OTHER"],
    ["unitsPerVariant", 100], ["catalogUnitsPerVariant", 100], ["productName", "Renamed"], ["title", "Other title"],
  ] as const)("ignores %s", (field, value) => {
    expect(productCatalogHash({ ...candidate, [field]: value })).toBe(base);
  });

  it.each([
    ["description", "<p>Other</p>"], ["brand", "Other brand"], ["condition", "USED"], ["itemSpecifics", { Color: ["Blue"] }],
    ["productId", 8],
  ] as const)("changes with %s", (field, value) => {
    expect(productCatalogHash({ ...candidate, [field]: value })).not.toBe(base);
  });

  it("does not depend on the order item specifics were written in", () => {
    const specifics = { Size: ["Large"], Color: ["White"], brand: ["x"] };
    const reordered = { brand: ["x"], Color: ["White"], Size: ["Large"] };
    expect(productCatalogHash({ ...candidate, itemSpecifics: specifics })).toBe(productCatalogHash({ ...candidate, itemSpecifics: reordered }));
    expect(productCatalogHash({ ...candidate, itemSpecifics: null })).toBe(productCatalogHash({ ...candidate, itemSpecifics: {} }));
  });
});

describe("description evidence with product or category parts", () => {
  const candidate = inCategory();
  const profile = profileWith();
  const result = (layers: ListingSettingLayers) => resolveListingContent({ candidate, profile, saved: null, layers });

  it("is today's object plus a last `layers` key holding only the values used", () => {
    const written = productCatalogHash(candidate);
    const layers = layersOf([productRow({ textAbove: own("Product above"), mainText: { text: "Mine", catalogHash: written } })],
      [categoryRow({ textAbove: own("Category above"), textBelow: none })]);
    const resolved = result(layers);
    expect(resolved.evidenceHash).toBe(contentHash({ renderer: 2, catalogHash: resolved.catalogHash, profileRevisionId: 3,
      profileHash: prepareContentProfile(profile).hash, saved: null, descriptionHtml: resolved.descriptionHtml, issues: [],
      layers: { v: 2, textAbove: { text: "Product above", source: "product" }, textBelow: { text: "", source: "category" },
        mainText: { text: "Mine", catalogHash: written } } }));
    expect(resolved.evidenceHash).not.toBe(resolveListingContent({ candidate, profile, saved: null }).evidenceHash);
  });

  it("changes when the same text moves from the category to the product", () => {
    const fromCategory = result(layersOf([], [categoryRow({ textAbove: own("Same words") })]));
    const fromProduct = result(layersOf([productRow({ textAbove: own("Same words") })]));
    expect(fromProduct.descriptionHtml).toBe(fromCategory.descriptionHtml);
    expect(fromProduct.evidenceHash).not.toBe(fromCategory.evidenceHash);
  });

  it("ignores the rows' revisions and every other setting, so a shelf-only save leaves it alone", () => {
    const first = result(layersOf([productRow({ textAbove: own("Product above") })]));
    const shelfChanged = productListingSettingRowSchema.parse({ ...productRow({ textAbove: own("Product above"),
      storeShelf: { mode: "own", shelves: [{ id: "301", name: "Mailers" }] } }), revisionId: 5_000 });
    expect(result(layersOf([shelfChanged])).evidenceHash).toBe(first.evidenceHash);
    expect(result(layersOf([productRow({ textAbove: own("Product above, edited") })])).evidenceHash).not.toBe(first.evidenceHash);
  });

  it("one product's change leaves another product's evidence alone", () => {
    const other = { ...candidate, productVariantId: 201, productId: 8 };
    const before = resolveListingContent({ candidate: other, profile, saved: null, layers: layersOf([productRow({ textAbove: own("A") })]) });
    const after = resolveListingContent({ candidate: other, profile, saved: null, layers: layersOf([productRow({ textAbove: own("B") })]) });
    expect(after.evidenceHash).toBe(before.evidenceHash);
    expect(after.evidenceHash).toBe(resolveListingContent({ candidate: other, profile, saved: null }).evidenceHash);
  });
});

/** Answers the reader's statements: today's two content reads and the layer reads. Fails on anything else. */
class ScriptedClient {
  sql: string[] = [];
  params: unknown[][] = [];
  products: Record<string, unknown>[] = [];

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.sql.push(sql);
    this.params.push(params);
    if (/FOR (UPDATE|SHARE)\b|^(INSERT|UPDATE|DELETE|LOCK)\b/.test(sql)) throw new Error(`A read sent a write or a lock: ${sql}`);
    if (sql.includes("FROM dropship.dropship_content_profiles p")) return { rows: [] };
    if (sql.includes("FROM dropship.dropship_listing_content_settings s")) return { rows: [] };
    if (sql.includes("FROM dropship.dropship_product_listing_settings s")) return { rows: this.products as T[] };
    if (sql.includes("FROM dropship.dropship_category_listing_settings s")) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  }
}
const kindOf = (sql: string) => sql.includes("dropship_content_profiles") ? "profile" : sql.includes("dropship_listing_content_settings") ? "sizes"
  : sql.includes("dropship_product_listing_settings") ? "products" : "categories";

describe("readResolvedListingContents", () => {
  const read = (client: ScriptedClient, candidates: DropshipListingCatalogCandidate[], layers?: ListingSettingLayers) =>
    readResolvedListingContents(client as unknown as Pick<PoolClient, "query">, { vendorId: VENDOR, storeConnectionId: STORE, candidates, layers });

  it("without layers, reads them after today's two reads on the caller's client, and skips the category read when no size has one", async () => {
    const client = new ScriptedClient();
    const result = await read(client, [contentCandidate()]);
    expect(client.sql.map(kindOf)).toEqual(["profile", "sizes", "products"]);
    expect(client.params[2]).toEqual([VENDOR, STORE, [7]]);
    expect(result.get(101)).toEqual(resolveListingContent({ candidate: contentCandidate(), profile: noContentProfile, saved: null }));

    const withCategory = new ScriptedClient();
    await read(withCategory, [inCategory()]);
    expect(withCategory.sql.map(kindOf)).toEqual(["profile", "sizes", "products", "categories"]);
    expect(withCategory.params[3]).toEqual([VENDOR, STORE, [CATEGORY]]);
  });

  it("resolves a product row it read from the database", async () => {
    const client = new ScriptedClient();
    const values = { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, textBelow: own("Stored below") };
    client.products = [{ product_id: 7, revision_id: 41, ...(JSON.parse(JSON.stringify(productValuesToColumns(values))) as Record<string, unknown>),
      created_at: NOW }];
    const result = await read(client, [contentCandidate()]);
    expect(result.get(101)?.descriptionHtml).toBe(`${contentCandidate().description}<p>Stored below</p>`);
  });

  it("with the preview's layers, sends no layer read and uses them", async () => {
    const client = new ScriptedClient();
    const result = await read(client, [inCategory()], layersOf([productRow({ textAbove: own("Given above") })]));
    expect(client.sql.map(kindOf)).toEqual(["profile", "sizes"]);
    expect(result.get(101)?.descriptionHtml).toBe(`<p>Given above</p>${contentCandidate().description}`);
  });
});

describe("the per-size description editor follows the same settings as the preview", () => {
  function setup(layers: ListingSettingLayers) {
    let saved: SavedListingContent | null = null;
    const tx: ContentTransaction = { vendorId: VENDOR, catalog: {
      loadStoreContext: vi.fn(async () => ({ vendorId: VENDOR, storeConnectionId: STORE, platform: "ebay" as const, vendorStatus: "active" as const,
        entitlementStatus: "active", storeStatus: "connected" as const, setupStatus: "ready", storeLaunchReady: true })),
      listCatalogCandidates: vi.fn(async () => [inCategory()]),
      listCatalogExposureRules: vi.fn(async () => [{ id: 1, scopeType: "catalog" as const, action: "include" as const }]),
      listSelectionRules: vi.fn(async () => [{ id: 1, scopeType: "catalog" as const, action: "include" as const }]),
      listVariantOverrides: vi.fn(async () => []), listExistingListings: vi.fn(async () => []),
    },
    loadProfile: vi.fn(async () => noContentProfile), loadSaved: vi.fn(async () => saved), findReplay: vi.fn(async () => false),
    loadListingSettingLayers: vi.fn(async () => layers), saveProfile: vi.fn(async () => undefined),
    saveListing: vi.fn(async (_variant, input) => { saved = { revisionId: 1, customText: input.customText, catalogHash: input.expectedCatalogHash,
      updatedAt: NOW.toISOString() }; }) };
    const service = new DropshipListingContentService({ repository: { execute: async (_input, operation) => operation(tx) },
      clock: { now: () => NOW }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    return { tx, service };
  }
  const target = { storeConnectionId: STORE, productVariantId: 101 };
  const layers = layersOf([productRow({ textAbove: own("Product above"), mainText: { text: "Product words", catalogHash: productCatalogHash(inCategory()) } })],
    [categoryRow({ textBelow: own("Category below") })]);

  it("shows the preview's description and keeps the size's own text and revision", async () => {
    const { tx, service } = setup(layers);
    const content = await service.getForMember("member-1", target);
    expect(tx.loadListingSettingLayers).toHaveBeenCalledExactlyOnceWith(inCategory());
    expect(content).toMatchObject({ customText: null, revisionId: null });
    expect(content.resolved).toEqual(resolveListingContent({ candidate: inCategory(), profile: noContentProfile, saved: null, layers }));
    expect(content.resolved.descriptionHtml).toBe("<p>Product above</p><p>Product words</p><p>Category below</p>");
  });

  it("saves the size's own text against the per-size catalog hash, over the product's text", async () => {
    const { tx, service } = setup(layers);
    const result = await service.saveForMember("member-1", target, { customText: "Size words", expectedRevisionId: null,
      expectedProfileRevisionId: null, expectedCatalogHash: listingCatalogHash(inCategory()), idempotencyKey: "content:size-1" });
    expect(tx.saveListing).toHaveBeenCalledOnce();
    expect(tx.loadListingSettingLayers).toHaveBeenCalledOnce();
    expect(result.content.resolved.descriptionHtml).toBe("<p>Product above</p><p>Size words</p><p>Category below</p>");
    await expect(service.saveForMember("member-1", target, { customText: "Other", expectedRevisionId: 1, expectedProfileRevisionId: null,
      expectedCatalogHash: productCatalogHash(inCategory()), idempotencyKey: "content:size-2" }))
      .rejects.toMatchObject({ code: "DROPSHIP_CONTENT_VERSION_CONFLICT" });
  });

  it("previews a reset to catalog text as the product's main text", async () => {
    const { service } = setup(layers);
    const preview = await service.previewForMember("member-1", target, { customText: null, expectedRevisionId: null,
      expectedProfileRevisionId: null, expectedCatalogHash: listingCatalogHash(inCategory()) });
    expect(preview.resolved).toMatchObject({ source: "custom", descriptionText: expect.stringContaining("Product words") });
  });
});
