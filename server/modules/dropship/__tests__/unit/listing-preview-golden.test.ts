import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LISTING_SETTINGS_SETTING_KEYS } from "../../../../../shared/dropship/listing-settings";
import { CATEGORY_PRICE_RULE_NAME, PRODUCT_PRICE_RULE_NAME } from "../../../../../shared/dropship/pricing-rules";
import { DropshipEbayCategoryRulesService, type EbayCategoryRulesTransaction } from "../../application/dropship-ebay-category-rules-service";
import { DropshipListingContentService, type ContentTransaction } from "../../application/dropship-listing-content-service";
import type { StoredPricingReview } from "../../application/dropship-pricing-rules-service";
import {
  type DropshipListingPreviewResult,
  type DropshipListingPreviewRow,
} from "../../application/dropship-listing-preview-service";
import {
  buildListingSettingsFacts, buildListingSettingsStoreDefaults, olderGroupRuleCounts,
  type ListingSettingsFacts, type ListingSettingsSizeFacts,
} from "../../application/dropship-listing-settings-facts";
import { readCategoryListingSettings } from "../../infrastructure/dropship-category-listing-settings.repository";
import { readEbayCategoryRules } from "../../infrastructure/dropship-ebay-category-rules.reader";
import { readContentProfile, readListingContentSettings, readResolvedListingContents } from "../../infrastructure/dropship-listing-content.reader";
import { readListingSettingLayers } from "../../infrastructure/dropship-listing-setting-layers.reader";
import { readPricingProfile } from "../../infrastructure/dropship-pricing-profile.reader";
import { readProductListingSettings } from "../../infrastructure/dropship-product-listing-settings.repository";
import { loadListingRulePrices } from "../../infrastructure/dropship-rule-price.loader";
import { categoryValuesToColumns, productValuesToColumns } from "../../infrastructure/dropship-listing-setting-shared.repository";
import type { EbayStoreShelfDefault } from "../../domain/ebay-listing-setup-config";
import { EMPTY_PRODUCT_LISTING_SETTING_VALUES } from "../../domain/listing-setting-values";
import type { CategoryListingSettingValues, ProductListingSettingValues } from "../../../../../shared/dropship/listing-setting-values";
import {
  GOLDEN_CATEGORY_13_SETTINGS,
  GOLDEN_CROSS_PATH_CATEGORIES,
  GOLDEN_CROSS_PATH_PRICED_CATEGORIES,
  GOLDEN_CROSS_PATH_PRICED_PRODUCTS,
  GOLDEN_CROSS_PATH_PRODUCTS,
  GOLDEN_PRODUCT_100_SETTINGS,
  GOLDEN_STORE_SHELF_DEFAULT,
  GOLDEN_PREVIEW_CANDIDATES,
  GOLDEN_PREVIEW_CATEGORY_NAMES,
  GOLDEN_PREVIEW_NOW,
  GOLDEN_PREVIEW_PINS,
  GOLDEN_PREVIEW_NO_RULES_STORE,
  GOLDEN_PREVIEW_RULES_STORE,
  GOLDEN_PREVIEW_STORES,
  GOLDEN_PREVIEW_VENDOR_ID,
  type GoldenFactsSizePin,
  type GoldenPreviewRowPin,
  type GoldenPreviewStore,
  type GoldenPreviewStorePins,
} from "../fixtures/listing-preview-golden.fixture";
import {
  NO_LAYER_ROWS,
  VARIANT_IDS,
  GoldenStoreClient,
  candidateOf,
  expectSheetSaysWhatPreviewSends,
  factsSize,
  goldenClassifyAtCost,
  goldenCostChangeFacts,
  goldenListingInputs,
  goldenPerSizePrice,
  goldenPricingReview,
  goldenSelectedCatalog,
  mockGoldenCostSource,
  runGoldenPreview,
  sha256,
  type GoldenLayerRows,
} from "../fixtures/listing-preview-golden.harness";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));

const stores = GOLDEN_PREVIEW_STORES.map((store, index) => [store.name, store, GOLDEN_PREVIEW_PINS[index]] as const);

/** The listing-settings facts over the same stored rows, read as the listing-settings load reads them (goldenListingInputs). */
async function runGoldenFacts(store: GoldenPreviewStore, layerRows: GoldenLayerRows = NO_LAYER_ROWS): Promise<ListingSettingsFacts> {
  return buildListingSettingsFacts(await goldenListingInputs(store, layerRows));
}

/** JSON with every object's keys sorted, so a digest depends on values, not on the order fields were set. */
function sortedKeyJson(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) => field && typeof field === "object" && !Array.isArray(field)
    ? Object.fromEntries(Object.entries(field as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
    : field);
}

const ROW_PIN_KEYS = [
  "productVariantId", "previewStatus", "blockers", "warnings", "priceCents", "pricingRuleName", "followsStorePricing",
  "priceSettingRevisionId", "rulePriceEvidenceHash", "contentEvidenceHash", "marketplaceQuantity", "marketplaceCategoryId",
  "marketplaceCategoryName", "marketplaceCategorySource", "marketplaceCategoryRuleName", "marketplaceCategoryFallback",
  "storeCategoryNames", "businessPolicySelection", "previewHash",
] as const satisfies readonly (keyof DropshipListingPreviewRow)[];

function rowPin(row: DropshipListingPreviewRow): GoldenPreviewRowPin {
  const pin: Record<string, unknown> = {};
  for (const key of ROW_PIN_KEYS) if (row[key] !== undefined) pin[key] = row[key];
  pin.listingIntentSha256 = row.listingIntent ? sha256(JSON.stringify(row.listingIntent)) : null;
  pin.rowSha256 = sha256(sortedKeyJson(row));
  return pin as GoldenPreviewRowPin;
}

function factsSizePin(size: ListingSettingsSizeFacts): GoldenFactsSizePin {
  return {
    productVariantId: size.price.productVariantId,
    priceCents: size.price.priceCents,
    priceSource: size.price.source,
    ruleKind: size.price.rule?.kind ?? null,
    issue: size.price.issue,
    sources: Object.fromEntries(LISTING_SETTINGS_SETTING_KEYS.map((key) => [key, size.values[key].source])) as GoldenFactsSizePin["sources"],
    fixes: [...size.fixes],
  };
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function rowOf(pins: GoldenPreviewStorePins, productVariantId: number): GoldenPreviewRowPin {
  const row = pins.rows.find((entry) => entry.productVariantId === productVariantId);
  if (!row) throw new Error(`No pinned row for size ${productVariantId}.`);
  return row;
}

function factsOf(pins: GoldenPreviewStorePins, productVariantId: number): GoldenFactsSizePin {
  const size = pins.facts.sizes.find((entry) => entry.productVariantId === productVariantId);
  if (!size) throw new Error(`No pinned facts for size ${productVariantId}.`);
  return size;
}

beforeEach(() => {
  mockGoldenCostSource();
});
afterEach(() => vi.restoreAllMocks());

describe("golden listing previews (no product or category settings, no store shelf default)", () => {
  it("has one pinned entry per store and size, and the sizes reach every branch they are meant to", () => {
    expect(GOLDEN_PREVIEW_PINS.map((pins) => pins.storeConnectionId))
      .toEqual(GOLDEN_PREVIEW_STORES.map((store) => store.context.storeConnectionId));
    for (const pins of GOLDEN_PREVIEW_PINS) {
      expect(pins.rows.map((row) => row.productVariantId)).toEqual(VARIANT_IDS);
      expect(sorted(pins.facts.sizes.map((size) => String(size.productVariantId)))).toEqual(sorted(VARIANT_IDS.map(String)));
    }
    const [rules, noRules] = GOLDEN_PREVIEW_PINS;
    // Price: store default rule, group rule, a tie, an exact price, inherit on a rule and on retail, no rules at all.
    expect(rowOf(rules, 1001).pricingRuleName).toBe("Store default rule");
    expect(rowOf(rules, 2001).pricingRuleName).toBe("Sleeves");
    expect(rowOf(rules, 6001).blockers).toContain("pricing_rule_priority_conflict");
    expect(factsOf(rules, 1002).priceSource).toBe("exact");
    expect(rowOf(rules, 2002)).toMatchObject({ followsStorePricing: true, pricingRuleName: "Sleeves" });
    expect(rowOf(rules, 6002)).toMatchObject({ followsStorePricing: true, priceCents: 8_999 });
    expect(rowOf(rules, 6002)).not.toHaveProperty("rulePriceEvidenceHash");
    expect(factsOf(noRules, 2001).priceSource).toBe("last_published");
    expect(rowOf(noRules, 3001).blockers).toContain("pricing_rules_not_configured");
    // Policies: per-size overrides on two sizes, the store's policies elsewhere.
    expect(rowOf(rules, 1002).businessPolicySelection?.overriddenFields).toEqual(["fulfillmentPolicyId", "paymentPolicyId"]);
    expect(rowOf(rules, 3001).businessPolicySelection?.overriddenFields).toEqual(["returnPolicyId"]);
    expect(rowOf(rules, 1001).businessPolicySelection?.overriddenFields).toEqual([]);
    // Shelves: one, two and none.
    expect([1002, 2001, 1001].map((id) => rowOf(rules, id).storeCategoryNames.length)).toEqual([1, 2, 0]);
    // eBay category: a rule, the store default, the Card Shellz category, and none.
    expect(new Set(GOLDEN_PREVIEW_PINS.flatMap((pins) => pins.rows.map((row) => row.marketplaceCategorySource))))
      .toEqual(new Set(["rule", "store_default", "catalog", "none"]));
    // Description: store template, group template, own text, own text to check, a template tie, no templates.
    expect(new Set(rules.facts.sizes.map((size) => size.sources.descriptionTemplate))).toEqual(new Set(["store_default", "group_rule", "none"]));
    expect(factsOf(rules, 1002).sources.mainText).toBe("size");
    expect(factsOf(rules, 2002).fixes).toContain("own_text_needs_check");
    expect(factsOf(rules, 7001).fixes).toContain("description_group_conflict");
    expect(new Set(noRules.facts.sizes.map((size) => size.sources.descriptionTemplate))).toEqual(new Set(["none"]));
  });

  it.each(stores)("the preview gives every size its pinned values: %s", async (_name, store, pins) => {
    const { preview, checks } = await runGoldenPreview(store);

    expect(preview.summary).toStrictEqual(pins.summary);
    expect(preview.rows.map(rowPin)).toStrictEqual(pins.rows);
    expect(sorted(checks.fulfillmentPolicyIds)).toStrictEqual(pins.preflightedFulfillmentPolicyIds);
    expect(sorted(checks.returnPolicyIds)).toStrictEqual(pins.checkedReturnPolicyIds);
    expect(sorted(checks.paymentPolicyIds)).toStrictEqual(pins.checkedPaymentPolicyIds);
  });

  it.each(stores)("the listing-settings facts give every size its pinned values: %s", async (_name, store, pins) => {
    const facts = await runGoldenFacts(store);

    expect(facts.sizes.map(factsSizePin)).toStrictEqual(pins.facts.sizes);
    expect(sha256(JSON.stringify(facts.sizes))).toBe(pins.facts.sizesSha256);
    // The pin covers each product's row and sizes, as pinned before PR 9 put its
    // category and settings revision beside them (no store here has product rows).
    expect(sha256(JSON.stringify(facts.products.map(({ row, sizes }) => ({ row, sizes }))))).toBe(pins.facts.productsSha256);
    const categories = new Map(GOLDEN_PREVIEW_CANDIDATES.map((candidate) => [candidate.productId, candidate.categoryId]));
    expect(facts.products.map((product) => [product.categoryId, product.settingsRevisionId]))
      .toStrictEqual(facts.products.map((product) => [categories.get(product.row.productId) ?? null, null]));
  });

  it.each(stores)("the writers' older group rule counts are the summary's, read by the same readers (plan 8.2, D16): %s", async (_name, store) => {
    const client = new GoldenStoreClient(store).asPgClient();
    const storeId = store.context.storeConnectionId;
    const pricing = await readPricingProfile(client, storeId, GOLDEN_PREVIEW_VENDOR_ID);
    const content = await readContentProfile(client, GOLDEN_PREVIEW_VENDOR_ID, storeId);
    const ebayCategoryRules = await readEbayCategoryRules(client, GOLDEN_PREVIEW_VENDOR_ID, storeId);

    const counts = olderGroupRuleCounts({ pricing, content, ebayCategoryRules });
    const defaults = buildListingSettingsStoreDefaults({ pricing, content, ebayCategoryRules, listingConfig: structuredClone(store.config) });
    expect(counts).toEqual({ pricingGroups: defaults.price.groupRules, contentGroups: defaults.description.groupRules,
      ebayCategoryRules: defaults.ebayCategory.groupRules });
    // And the facts the pinned summary is built from count the same.
    const facts = await runGoldenFacts(store);
    expect([facts.storeDefaults.price.groupRules, facts.storeDefaults.description.groupRules, facts.storeDefaults.ebayCategory.groupRules])
      .toEqual([counts.pricingGroups, counts.contentGroups, counts.ebayCategoryRules]);
  });

  it("holds older group rules in the rules store and none in the other, so the parity case counts real rules", async () => {
    const [rules, noRules] = await Promise.all(GOLDEN_PREVIEW_STORES.map(async (store) => {
      const client = new GoldenStoreClient(store).asPgClient();
      const storeId = store.context.storeConnectionId;
      return olderGroupRuleCounts({ pricing: await readPricingProfile(client, storeId, GOLDEN_PREVIEW_VENDOR_ID),
        content: await readContentProfile(client, GOLDEN_PREVIEW_VENDOR_ID, storeId),
        ebayCategoryRules: await readEbayCategoryRules(client, GOLDEN_PREVIEW_VENDOR_ID, storeId) });
    }));
    expect(Object.values(rules).some((count) => count > 0)).toBe(true);
    expect(noRules).toEqual({ pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 });
  });

  it.each(stores)("the facts and the preview give each size one price: %s", (_name, _store, pins) => {
    for (const row of pins.rows) expect(factsOf(pins, row.productVariantId).priceCents).toBe(row.priceCents);
  });

  it.each(stores)("answers the product and category settings reads with no rows: %s", async (_name, store) => {
    const client = new GoldenStoreClient(store);
    const scope = { vendorId: GOLDEN_PREVIEW_VENDOR_ID, storeConnectionId: store.context.storeConnectionId };
    const productIds = [...new Set(GOLDEN_PREVIEW_CANDIDATES.map((row) => row.productId))];
    const categoryIds = [...GOLDEN_PREVIEW_CATEGORY_NAMES.keys()];

    await expect(readProductListingSettings(client.asPgClient(), { ...scope, productIds })).resolves.toEqual(new Map());
    await expect(readCategoryListingSettings(client.asPgClient(), { ...scope, categoryIds })).resolves.toEqual(new Map());
    expect(client.statements).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Variants (PR 8b, sub-part 8b-W): the documented changes (plan 4.10, 4.11),
// each asserted against the pinned previews above, field by field.
// ---------------------------------------------------------------------------

const SETTINGS_SAVED_AT = new Date("2026-10-08T09:00:00.000Z");
const PRODUCT_SETTINGS_READ = /FROM dropship\.dropship_product_listing_settings\b/;
const CATEGORY_SETTINGS_READ = /FROM dropship\.dropship_category_listing_settings\b/;

function productSettingsRow(productId: number, values: ProductListingSettingValues) {
  return { product_id: productId, revision_id: 900 + productId, ...productValuesToColumns(values), created_at: SETTINGS_SAVED_AT };
}

function categorySettingsRow(categoryId: number, values: CategoryListingSettingValues) {
  return { category_id: categoryId, revision_id: 800 + categoryId, ...categoryValuesToColumns(values), created_at: SETTINGS_SAVED_AT };
}

function withShelfDefault(store: GoldenPreviewStore, shelfDefault: EbayStoreShelfDefault): GoldenPreviewStore {
  return { ...store, config: { ...store.config,
    marketplaceConfig: { ...store.config.marketplaceConfig, storeShelfDefault: structuredClone(shelfDefault) } } };
}

function previewRow(preview: DropshipListingPreviewResult, productVariantId: number): DropshipListingPreviewRow {
  const row = preview.rows.find((entry) => entry.productVariantId === productVariantId);
  if (!row) throw new Error(`No preview row for size ${productVariantId}.`);
  return row;
}

/** Puts the named fields back to the base row's (absent stays absent): every other field must be the base row's. */
function expectOnlyFieldsChanged(row: DropshipListingPreviewRow, base: DropshipListingPreviewRow,
  fields: readonly (keyof DropshipListingPreviewRow)[]): void {
  const restored: Record<string, unknown> = { ...row };
  for (const field of fields) {
    if (field in base) restored[field] = base[field];
    else delete restored[field];
  }
  expect(restored).toStrictEqual(base);
}

/** Every row of the products not named is exactly the base row. */
function expectOtherProductsUnchanged(variant: DropshipListingPreviewResult, base: DropshipListingPreviewResult,
  changedProductIds: readonly number[]): void {
  for (const row of variant.rows) {
    if (!changedProductIds.includes(row.productId)) expect(row).toStrictEqual(previewRow(base, row.productVariantId));
  }
}

describe("golden listing previews: PR 8b variants (8b-W)", () => {
  it.each(stores)("reads the product and category settings once per preview: %s", async (_name, store) => {
    const { statements } = await runGoldenPreview(store);

    // One read for the whole preview (plan D26), shared by the price, description and eBay category loaders.
    expect(statements.filter((sql) => PRODUCT_SETTINGS_READ.test(sql))).toHaveLength(1);
    expect(statements.filter((sql) => CATEGORY_SETTINGS_READ.test(sql))).toHaveLength(1);
  });

  it.each(stores)("a saved store shelf default changes only the shelves, the intent and the preview hash of sizes with no shelf of their own: %s",
    async (_name, store, pins) => {
      const base = await runGoldenPreview(store);
      const variant = await runGoldenPreview(withShelfDefault(store, GOLDEN_STORE_SHELF_DEFAULT));

      // From the pins: a size with an intent and no shelf row of its own. A blocked size with no intent sends nothing.
      const ownShelf = new Set(store.shelfAssignments.map((row) => row.productVariantId));
      const reached = pins.rows.filter((row) => row.listingIntentSha256 !== null && !ownShelf.has(row.productVariantId))
        .map((row) => row.productVariantId);
      expect(reached.length).toBeGreaterThan(0);
      expect(variant.preview.summary).toStrictEqual(pins.summary);
      expect(variant.checks).toStrictEqual(base.checks);
      for (const row of variant.preview.rows) {
        const before = previewRow(base.preview, row.productVariantId);
        if (!reached.includes(row.productVariantId)) {
          expect(row).toStrictEqual(before);
          continue;
        }
        expect(row.storeCategoryNames).toStrictEqual(GOLDEN_STORE_SHELF_DEFAULT.names);
        // The default reaches the intent only as the size's shelves; the key itself stays out of it.
        expect(row.listingIntent).toStrictEqual({ ...before.listingIntent, storeCategoryNames: GOLDEN_STORE_SHELF_DEFAULT.names });
        expect(row.listingIntent?.marketplaceConfig).not.toHaveProperty("storeShelfDefault");
        expect(row.previewHash).not.toBe(before.previewHash);
        expectOnlyFieldsChanged(row, before, ["storeCategoryNames", "listingIntent", "previewHash"]);
      }
    });

  it("a product's own settings price, categorise, shelve, describe and set the shipping policy of its sizes, and of no other", async () => {
    const store = GOLDEN_PREVIEW_RULES_STORE;
    const base = await runGoldenPreview(store);
    const variant = await runGoldenPreview(store, {
      layerRows: { products: [productSettingsRow(100, GOLDEN_PRODUCT_100_SETTINGS)], categories: [] },
    });

    const size1001 = previewRow(variant.preview, 1001);
    expect(size1001).toMatchObject({
      previewStatus: "ready", priceCents: 999, pricingRuleName: "Product price",
      marketplaceCategoryId: "900300", marketplaceCategoryName: "Bubble mailers", marketplaceCategorySource: "product",
      marketplaceCategoryRuleName: null, storeCategoryNames: ["Mailers > Bubble"],
      businessPolicySelection: { fulfillmentPolicyId: "ship-product", returnPolicyId: "ret-1", paymentPolicyId: "pay-1",
        overriddenFields: ["fulfillmentPolicyId"] },
    });
    // A new level prices with recipe evidence version 2 (plan D14): its evidence is not the store default's.
    expect(size1001.rulePriceEvidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(size1001.rulePriceEvidenceHash).not.toBe(rowOf(GOLDEN_PREVIEW_PINS[0], 1001).rulePriceEvidenceHash);
    expect(size1001.listingIntent?.description).toContain("Packed the same day.");
    expect(size1001.listingIntent?.description).not.toContain("Thanks for shopping with Armalope Cards.");
    expect(size1001.listingIntent?.description).toContain("Orders ship within one business day.");

    // Size 1002 keeps its exact price, its own shelf and its own policies; it takes the product's text and eBay category.
    const size1002 = previewRow(variant.preview, 1002);
    const base1002 = previewRow(base.preview, 1002);
    expect(size1002).toMatchObject({ priceCents: 1_499, priceSettingRevisionId: 301, storeCategoryNames: ["Mailers"],
      marketplaceCategoryId: "900300", marketplaceCategorySource: "product", businessPolicySelection: base1002.businessPolicySelection });
    expect(size1002).not.toHaveProperty("rulePriceEvidenceHash");
    expect(size1002.listingIntent?.description).toContain("Packed the same day.");
    expect(size1002.contentEvidenceHash).not.toBe(base1002.contentEvidenceHash);

    // The product's shipping policy is checked on eBay like a size's own.
    expect(sorted(variant.checks.fulfillmentPolicyIds)).toStrictEqual(["ship-1", "ship-2", "ship-product"]);
    expectOtherProductsUnchanged(variant.preview, base.preview, [100]);
  });

  it.each(stores)("a Card Shellz category's settings apply to its products' sizes, after a size's own and the older rules: %s",
    async (_name, store) => {
      const base = await runGoldenPreview(store);
      const variant = await runGoldenPreview(store, {
        layerRows: { products: [], categories: [categorySettingsRow(13, GOLDEN_CATEGORY_13_SETTINGS)] },
      });
      const hasRules = store === GOLDEN_PREVIEW_RULES_STORE;

      const size3001 = previewRow(variant.preview, 3001);
      // Size 3001 is the store default rule's in the store with rules, unpriced in the other: the category beats both.
      expect(size3001).toMatchObject({ priceCents: 1_499, pricingRuleName: "Category price",
        storeCategoryNames: ["Toploaders shelf"] });
      expect(size3001.blockers).not.toContain("pricing_rules_not_configured");
      // An older eBay category rule still beats the category's eBay category (plan D16).
      expect(size3001).toMatchObject(hasRules
        ? { marketplaceCategoryId: "900101", marketplaceCategorySource: "rule", marketplaceCategoryRuleName: "Toploaders" }
        : { marketplaceCategoryId: "900400", marketplaceCategoryName: "Card holders", marketplaceCategorySource: "category" });
      // The size's own return policy stays; the shipping policy comes from the category.
      expect(size3001.businessPolicySelection).toStrictEqual(hasRules
        ? { fulfillmentPolicyId: "ship-category", returnPolicyId: "ret-2", paymentPolicyId: "pay-1",
          overriddenFields: ["fulfillmentPolicyId", "returnPolicyId"] }
        : { fulfillmentPolicyId: "ship-category", returnPolicyId: "ret-b", paymentPolicyId: "pay-b",
          overriddenFields: ["fulfillmentPolicyId"] });
      expect(size3001.listingIntent?.description).toContain("Ask about bulk pricing.");
      expect(variant.checks.fulfillmentPolicyIds).toContain("ship-category");
      expectOtherProductsUnchanged(variant.preview, base.preview, [300]);
    });

  it.each(stores)("a product with no Card Shellz category ignores every category's settings: %s", async (_name, store) => {
    const base = await runGoldenPreview(store);
    const everyCategory = [...GOLDEN_PREVIEW_CATEGORY_NAMES.keys()].map((categoryId) => categorySettingsRow(categoryId, GOLDEN_CATEGORY_13_SETTINGS));
    const variant = await runGoldenPreview(store, { layerRows: { products: [], categories: everyCategory } });

    for (const productVariantId of [6001, 6002]) {
      expect(previewRow(variant.preview, productVariantId)).toStrictEqual(previewRow(base.preview, productVariantId));
    }
    // The sizes that have a category do follow it.
    expect(previewRow(variant.preview, 7001).storeCategoryNames).toStrictEqual(["Toploaders shelf"]);
  });

  it("checks a product's shipping policy on eBay before the rows, for a size with no policy row of its own (F5)", async () => {
    const store = GOLDEN_PREVIEW_RULES_STORE;
    const base = await runGoldenPreview(store);
    const variant = await runGoldenPreview(store, {
      layerRows: { products: [productSettingsRow(100, { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES,
        shippingPolicy: { id: "ship-product", name: null } })], categories: [] },
      incompatibleFulfillmentPolicyIds: new Set(["ship-product"]),
    });

    expect(sorted(variant.checks.fulfillmentPolicyIds)).toStrictEqual(["ship-1", "ship-2", "ship-product"]);
    const size1001 = previewRow(variant.preview, 1001);
    // Judged by the product policy's own check: a missing preflight would have left the row unchecked.
    expect(size1001.previewStatus).toBe("blocked");
    expect(size1001.blockers).toStrictEqual(["ebay_fulfillment_policy:shipping_service_unsupported:GoldenCourier"]);
    expect(size1001.businessPolicySelection).toStrictEqual({ fulfillmentPolicyId: "ship-product", returnPolicyId: "ret-1",
      paymentPolicyId: "pay-1", overriddenFields: ["fulfillmentPolicyId"] });
    // Size 1002's own shipping policy beats the product's, so nothing about it changes.
    expect(previewRow(variant.preview, 1002)).toStrictEqual(previewRow(base.preview, 1002));
    expectOtherProductsUnchanged(variant.preview, base.preview, [100]);
  });

  it("reads the settings once per preview when a product has settings too", async () => {
    const { statements } = await runGoldenPreview(GOLDEN_PREVIEW_NO_RULES_STORE, {
      layerRows: { products: [productSettingsRow(100, GOLDEN_PRODUCT_100_SETTINGS)], categories: [] },
    });
    expect(statements.filter((sql) => PRODUCT_SETTINGS_READ.test(sql))).toHaveLength(1);
    expect(statements.filter((sql) => CATEGORY_SETTINGS_READ.test(sql))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Every path, one answer (PR 8b, sub-part 8b-G; plan 4.9, 4.13): over the same
// stored rows, each path that resolves a listing setting gives the value the
// preview gives, and the product sheet (the listing-settings facts) says what
// the step 3 preview sends. Run on today's data and on the cross-path scenario.
// The push-time refresh, the stock catch-up and the cost-change reprice reach
// these values through the preview and the queue, so they are covered here.
// ---------------------------------------------------------------------------

interface GoldenScenario {
  name: string;
  store: GoldenPreviewStore;
  products: ReadonlyArray<readonly [productId: number, values: ProductListingSettingValues]>;
  categories: ReadonlyArray<readonly [categoryId: number, values: CategoryListingSettingValues]>;
}

const SCENARIOS: readonly GoldenScenario[] = GOLDEN_PREVIEW_STORES.flatMap((store) => [
  { name: `${store.name}, no product or category settings`, store, products: [], categories: [] },
  { name: `${store.name}, product and category settings and a store shelf default`,
    store: withShelfDefault(store, GOLDEN_STORE_SHELF_DEFAULT), products: GOLDEN_CROSS_PATH_PRODUCTS, categories: GOLDEN_CROSS_PATH_CATEGORIES },
  // The same, plus a price on product 600 and on category 12: `inherit` sizes after a product's and a category's price,
  // a product's price over a tie, and an older group rule over a category's price.
  { name: `${store.name}, the cross-path settings with product 600 and category 12 priced`,
    store: withShelfDefault(store, GOLDEN_STORE_SHELF_DEFAULT), products: GOLDEN_CROSS_PATH_PRICED_PRODUCTS,
    categories: GOLDEN_CROSS_PATH_PRICED_CATEGORIES },
]);
const scenarios = SCENARIOS.map((scenario) => [scenario.name, scenario] as const);
const MEMBER_ID = "member-golden";
const QUIET_LOGGER = { info: () => undefined, warn: () => undefined, error: () => undefined };

function layerRowsOf(scenario: GoldenScenario): GoldenLayerRows {
  return { products: scenario.products.map(([productId, values]) => productSettingsRow(productId, values)),
    categories: scenario.categories.map(([categoryId, values]) => categorySettingsRow(categoryId, values)) };
}

function storeIdOf(scenario: GoldenScenario): number {
  return scenario.store.context.storeConnectionId;
}

/** The catalog, selection and store reads every per-store service makes first, over the scenario's store. */
function selectedCatalogOf(scenario: GoldenScenario, client: GoldenStoreClient) {
  return goldenSelectedCatalog(scenario.store, client);
}

describe("golden listing previews: every path gives the preview's values (8b-G)", () => {
  it("the cross-path scenario reaches every product and category source the paths must agree on", async () => {
    const sources = new Map<string, Set<string>>();
    for (const scenario of SCENARIOS.filter((entry) => entry.products.length > 0)) {
      const facts = await runGoldenFacts(scenario.store, layerRowsOf(scenario));
      for (const size of facts.sizes) {
        for (const key of LISTING_SETTINGS_SETTING_KEYS) {
          sources.set(key, (sources.get(key) ?? new Set()).add(size.values[key].source));
        }
        if (size.price.rule) sources.set("price", (sources.get("price") ?? new Set()).add(size.price.rule.kind));
      }
    }
    const expectReached = (key: string, reached: readonly string[]) => {
      for (const source of reached) expect(sources.get(key), `${key} from ${source}`).toContain(source);
    };
    // No size keeps the store default rule here: each is priced by its product, its category, a group or a typed price.
    expectReached("price", ["product", "category", "group"]);
    expectReached("shippingPolicy", ["product", "category", "size", "store_default"]);
    expectReached("returnPolicy", ["category", "size", "store_default"]);
    expectReached("paymentPolicy", ["product", "size", "store_default"]);
    expectReached("ebayCategory", ["product", "category", "group_rule", "store_default", "catalog"]);
    expectReached("storeShelf", ["product", "category", "size", "store_default"]);
    expectReached("descriptionTemplate", ["product", "category", "group_rule", "store_default"]);
    expectReached("mainText", ["product", "size", "catalog"]);
  });

  it("the priced scenario sends inherit sizes to a product's and a category's price, and keeps a group rule before a category's", async () => {
    const priced = SCENARIOS.filter((entry) => entry.products === GOLDEN_CROSS_PATH_PRICED_PRODUCTS);
    const [rules, noRules] = await Promise.all(GOLDEN_PREVIEW_STORES.map(async (store) => {
      const scenario = priced.find((entry) => storeIdOf(entry) === store.context.storeConnectionId)!;
      return (await runGoldenPreview(scenario.store, { layerRows: layerRowsOf(scenario) })).preview;
    }));

    // Store with rules: product 600's price beats the tie (6001) and is what the `inherit` size follows (6002).
    expect(previewRow(rules, 6001)).toMatchObject({ priceCents: 1_200, pricingRuleName: PRODUCT_PRICE_RULE_NAME });
    expect(previewRow(rules, 6002)).toMatchObject({ priceCents: 4_560, pricingRuleName: PRODUCT_PRICE_RULE_NAME,
      followsStorePricing: true });
    // The older Sleeves group still beats category 12's price, for the `inherit` size too.
    expect(previewRow(rules, 2001)).toMatchObject({ priceCents: 1_499, pricingRuleName: "Sleeves" });
    expect(previewRow(rules, 2002)).toMatchObject({ priceCents: 5_999, pricingRuleName: "Sleeves", followsStorePricing: true });
    // Store without rules: the `inherit` size follows category 12's price.
    expect(previewRow(noRules, 2002)).toMatchObject({ priceCents: 6_049, pricingRuleName: CATEGORY_PRICE_RULE_NAME,
      followsStorePricing: true });
  });

  it.each(scenarios)("the product sheet says what the step 3 preview sends, size by size: %s", async (_name, scenario) => {
    await expectSheetSaysWhatPreviewSends(scenario.store, layerRowsOf(scenario));
  });

  it.each(scenarios)("the queue's re-check reads the layers itself and accepts the preview's price and description evidence: %s",
    async (_name, scenario) => {
      const layerRows = layerRowsOf(scenario);
      const { preview } = await runGoldenPreview(scenario.store, { layerRows });
      const client = new GoldenStoreClient(scenario.store, layerRows);
      const scope = { vendorId: GOLDEN_PREVIEW_VENDOR_ID, storeConnectionId: storeIdOf(scenario) };
      // As createListingPushJob re-checks them under the store lock: no layers given, and each check
      // runs only when some row carries its evidence (a store without rules has no rule evidence).
      const contentRows = preview.rows.filter((row) => row.contentEvidenceHash);
      const ruleRows = preview.rows.filter((row) => row.rulePriceEvidenceHash);
      expect(contentRows).toHaveLength(preview.rows.length);
      const contents = await readResolvedListingContents(client.asPgClient(), { ...scope,
        candidates: contentRows.map((row) => candidateOf(row.productVariantId)) });
      const rules = ruleRows.length === 0 ? new Map() : await loadListingRulePrices(client.asPgClient(), { ...scope,
        candidates: ruleRows.map((row) => candidateOf(row.productVariantId)) });

      for (const row of contentRows) {
        expect(contents.get(row.productVariantId)?.evidenceHash, `size ${row.productVariantId}`).toBe(row.contentEvidenceHash);
      }
      for (const row of ruleRows) {
        expect(rules.get(row.productVariantId)?.evidenceHash, `size ${row.productVariantId}`).toBe(row.rulePriceEvidenceHash);
      }
      // Each check read the layers itself, in its own transaction.
      expect(client.statements.filter((sql) => PRODUCT_SETTINGS_READ.test(sql))).toHaveLength(ruleRows.length === 0 ? 1 : 2);
    });

  it.each(scenarios)("the per-size price (W9) is the preview's price, by rule exactly where the sheet says so: %s", async (_name, scenario) => {
    const layerRows = layerRowsOf(scenario);
    const { preview } = await runGoldenPreview(scenario.store, { layerRows });
    const facts = await runGoldenFacts(scenario.store, layerRows);

    for (const row of preview.rows) {
      // W9's own loader call (dropship-listing-price.repository.ts): one size, no layers given.
      const answer = await goldenPerSizePrice(scenario.store, layerRows, row.productVariantId);

      const where = `size ${row.productVariantId}`;
      expect(answer.effectivePriceCents, where).toBe(row.priceCents);
      const byRule = factsSize(facts, row.productVariantId).price.source === "rules";
      expect(answer.source === "rules", where).toBe(byRule);
      if (byRule) expect(answer.ruleName, where).toBe(row.pricingRuleName);
    }
  });

  it.each(scenarios)("the pricing review (W1) prices each size now as the preview does: %s", async (_name, scenario) => {
    const layerRows = layerRowsOf(scenario);
    const { preview } = await runGoldenPreview(scenario.store, { layerRows });

    // Each store's own rules, proposed again; the store without rules is proposed the rules store's default recipe with no
    // groups for the first time (Listing settings PR 12, D26: W1 refuses a group the store doesn't hold, D9).
    const { current, review } = await goldenPricingReview(scenario.store, layerRows,
      (held) => held.profile ?? { ...GOLDEN_PREVIEW_RULES_STORE.pricingProfile!.profile, groups: [] });

    const rows = new Map(review.rows.map((reviewRow) => [reviewRow.productVariantId, reviewRow]));
    expect(rows.size).toBe(preview.rows.length);
    for (const row of preview.rows) {
      const reviewRow = rows.get(row.productVariantId)!;
      expect(reviewRow.previousPriceCents, `size ${row.productVariantId}`).toBe(row.priceCents);
      // Proposing the rules a store already has changes no price.
      if (current.profile) expect(reviewRow.priceCents, `size ${row.productVariantId}`).toBe(row.priceCents);
    }
  });

  it("the pricing review (W1) refuses the rules store's groups proposed to the store without rules, and stores no review (PR 12, D26)", async () => {
    // What this case proposed before Listing settings PR 12: the rules store's whole profile, groups and all.
    const [, scenario] = scenarios.find(([, entry]) => entry.store === GOLDEN_PREVIEW_NO_RULES_STORE)!;
    const reviews: StoredPricingReview[] = [];

    const error = await goldenPricingReview(scenario.store, layerRowsOf(scenario), () => GOLDEN_PREVIEW_RULES_STORE.pricingProfile!.profile, reviews)
      .then(() => null, (caught: unknown) => caught);

    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_GROUP_RULES_CLOSED", context: { kind: "pricing",
      addedIds: GOLDEN_PREVIEW_RULES_STORE.pricingProfile!.profile.groups.map((group) => group.id), changedIds: [], classification: "permanent" } });
    expect(reviews).toEqual([]);
  });

  it.each(scenarios)("the cost-change classifier prices each size at its .ops cost as the preview does: %s", async (_name, scenario) => {
    const layerRows = layerRowsOf(scenario);
    const { preview } = await runGoldenPreview(scenario.store, { layerRows });
    // As loadVendorFacts reads them: a profile only for a store that has one, layers for every store with listings.
    const facts = await goldenCostChangeFacts(scenario.store, layerRows);

    for (const row of preview.rows) {
      const classification = goldenClassifyAtCost(scenario.store, facts, row.productVariantId);
      expect(classification.priceCents, `size ${row.productVariantId}`).toBe(row.priceCents);
    }
  });

  it.each(scenarios)("the eBay category review (W3) counts the preview's categories, from the same layers: %s", async (_name, scenario) => {
    const layerRows = layerRowsOf(scenario);
    const { preview } = await runGoldenPreview(scenario.store, { layerRows });
    const client = new GoldenStoreClient(scenario.store, layerRows);
    const storeId = storeIdOf(scenario);
    const state = await readEbayCategoryRules(client.asPgClient(), GOLDEN_PREVIEW_VENDOR_ID, storeId);
    const known = new Map([state.profile?.defaultCategory, ...(state.profile?.rules ?? []).map((rule) => rule.category)]
      .flatMap((category) => (category ? [[category.categoryId, category] as const] : [])));
    const tx = { ...selectedCatalogOf(scenario, client),
      loadState: async () => state,
      loadStoreListingConfig: async () => structuredClone(scenario.store.config),
      loadListingSettingLayers: (candidates: readonly { productId: number; categoryId: number | null }[]) =>
        readListingSettingLayers(client.asPgClient(), { vendorId: GOLDEN_PREVIEW_VENDOR_ID, storeConnectionId: storeId, candidates }),
      findReplay: async () => false,
      saveProfile: async () => { throw new Error("The golden review never saves."); },
    } satisfies EbayCategoryRulesTransaction;
    const service = new DropshipEbayCategoryRulesService({
      repository: { execute: async (_input, operation) => operation(tx) },
      // eBay knows every category the store's rules name, each a leaf.
      taxonomy: {
        describe: async (_identity, categoryIds) => new Map(categoryIds.flatMap((categoryId) => {
          const category = known.get(categoryId);
          return category ? [[categoryId, { ...structuredClone(category), leaf: true }] as const] : [];
        })),
        search: async () => { throw new Error("The golden review never searches eBay."); },
        browse: async () => { throw new Error("The golden review never browses eBay."); },
      },
      clock: { now: () => GOLDEN_PREVIEW_NOW }, logger: QUIET_LOGGER,
    });
    const draftOf = (rules: NonNullable<typeof state.profile>["rules"]) => ({
      defaultCategoryId: state.profile?.defaultCategory?.categoryId ?? null,
      rules: rules.map((rule) => ({ id: rule.id, name: rule.name, scope: rule.scope, categoryId: rule.category.categoryId })),
    });

    // The store's current rules, reviewed again: nothing moves, and every count is the preview's.
    const review = await service.reviewForMember(MEMBER_ID, storeId, { expectedRevisionId: state.revisionId,
      draft: draftOf(state.profile?.rules ?? []) });

    const bySource = { rule: 0, store_default: 0, catalog: 0, none: 0, product: 0, category: 0 };
    const byCategory = new Map<string, number>();
    for (const row of preview.rows) {
      bySource[row.marketplaceCategorySource!] += 1;
      if (row.marketplaceCategoryId) byCategory.set(row.marketplaceCategoryId, (byCategory.get(row.marketplaceCategoryId) ?? 0) + 1);
    }
    const { product, category, ...todays } = bySource;
    expect(review).toMatchObject({ selectedCount: preview.rows.length, changedCount: 0, withoutCategoryAfter: bySource.none });
    // Strict: a new source with no size is left out, so a store with no settings gets today's review bytes (plan 4.2).
    expect(review.bySource).toStrictEqual({ ...todays, ...(product > 0 ? { product } : {}), ...(category > 0 ? { category } : {}) });
    expect(new Map(review.byCategory.map((entry) => [entry.categoryId, entry.count]))).toStrictEqual(byCategory);

    // Dropping every older rule: a size the rules categorised moves to what the preview would give it next,
    // which for size 3001 in the scenario is its Card Shellz category's eBay category, read from the same layers.
    if (!state.profile?.rules.length) return;
    const dropped = await service.reviewForMember(MEMBER_ID, storeId, { expectedRevisionId: state.revisionId, draft: draftOf([]) });
    const moved = dropped.changes.find((change) => change.productVariantId === 3001);
    expect(moved?.after.categoryId).toBe(scenario.categories.length > 0 ? GOLDEN_CATEGORY_13_SETTINGS.ebayCategory!.categoryId
      : state.profile.defaultCategory!.categoryId);
  });

  it.each(scenarios)("the per-size description editor resolves the preview's description and evidence: %s", async (_name, scenario) => {
    const layerRows = layerRowsOf(scenario);
    const { preview } = await runGoldenPreview(scenario.store, { layerRows });
    const client = new GoldenStoreClient(scenario.store, layerRows);
    const storeId = storeIdOf(scenario);
    const tx = { ...selectedCatalogOf(scenario, client),
      loadProfile: () => readContentProfile(client.asPgClient(), GOLDEN_PREVIEW_VENDOR_ID, storeId),
      loadSaved: async (variantId: number) => (await readListingContentSettings(client.asPgClient(), GOLDEN_PREVIEW_VENDOR_ID, storeId,
        [variantId])).get(variantId) ?? null,
      loadListingSettingLayers: (candidate: { productId: number; categoryId: number | null }) => readListingSettingLayers(client.asPgClient(),
        { vendorId: GOLDEN_PREVIEW_VENDOR_ID, storeConnectionId: storeId, candidates: [candidate] }),
      findReplay: async () => false,
      saveProfile: async () => { throw new Error("The golden editor never saves."); },
      saveListing: async () => { throw new Error("The golden editor never saves."); },
    } satisfies ContentTransaction;
    const service = new DropshipListingContentService({ repository: { execute: async (_input, operation) => operation(tx) },
      clock: { now: () => GOLDEN_PREVIEW_NOW }, logger: QUIET_LOGGER });

    for (const row of preview.rows) {
      const setting = await service.getForMember(MEMBER_ID, { storeConnectionId: storeId, productVariantId: row.productVariantId });
      expect(setting.resolved.evidenceHash, `size ${row.productVariantId}`).toBe(row.contentEvidenceHash);
      if (row.listingIntent) expect(setting.resolved.descriptionHtml, `size ${row.productVariantId}`).toBe(row.listingIntent.description);
    }
  });
});

// ---------------------------------------------------------------------------
// PR 11c (plan 7.A, D23): the preview reads its four resolver inputs in one
// call (loadResolverInputs, as the PostgreSQL repository answers it). On a
// store that nothing converts, that call reads exactly what the four separate
// reads read, in the same order, and every preview is the same: the push-time
// refresh and the stock catch-up, which build their intent from this
// preview, publish what they published before.
// ---------------------------------------------------------------------------

describe("golden listing previews: one snapshot for the resolver reads (PR 11c, D23)", () => {
  it.each(scenarios)("the one-snapshot read gives the separate reads' preview and statements: %s", async (_name, scenario) => {
    const layerRows = layerRowsOf(scenario);
    const separate = await runGoldenPreview(scenario.store, { layerRows, resolverReads: "separate" });
    const oneSnapshot = await runGoldenPreview(scenario.store, { layerRows });

    expect(oneSnapshot.preview).toStrictEqual(separate.preview);
    expect(oneSnapshot.checks).toStrictEqual(separate.checks);
    expect(oneSnapshot.statements).toEqual(separate.statements);
    expect(oneSnapshot.statements.filter((sql) => PRODUCT_SETTINGS_READ.test(sql))).toHaveLength(1);
  });
});
