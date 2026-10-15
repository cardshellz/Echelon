/**
 * The rules conversion's golden (Listing settings PR 11a2, plan 4.B.4 "Golden",
 * REC:931): the dry run over the preview golden's stores (G2F), read by the
 * same real readers over the same stored rows as the preview golden (the
 * harness), and the store after the move written back as stored rows and read
 * again by every price path.
 *
 * Store 22 holds category rules of all three kinds (pricing "Sleeves",
 * description "Sleeve buyers" with an empty footer, eBay "Toploaders"), a
 * price tie on product 600 (the category group "Binders A", whose only
 * product has no Card Shellz category id, and the product-line group
 * "Binders B") and a description tie on product 700. Store 23 has no rules.
 *
 * The planner's names and text inputs are built from the fixture, never
 * through the golden client: its category read takes ids (params[0]), not
 * names, and the text-bytes statement would reach its product-settings
 * branch. "The check writes nothing" is proven on PostgreSQL (RSU), since the
 * golden client refuses BEGIN and so never runs the check's snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listingRulesConversionCheckSchema } from "../../../../../shared/dropship/listing-rules-conversion";
import type { CategoryListingSettingValues, ProductListingSettingValues } from "../../../../../shared/dropship/listing-setting-values";
import type { DropshipListingPreviewRow } from "../../application/dropship-listing-preview-service";
import {
  checkRulesConversion,
  conversionAfterInputs,
  conversionCategoryNamesToRead,
  conversionCheckView,
  PLANNED_ROW_REVISION_ID,
  PLANNED_ROW_UPDATED_AT,
  type ConversionInputs,
  type PlannedProfileWrite,
  type RulesConversionCheck,
} from "../../application/dropship-listing-rules-conversion";
import { buildListingSettingsFacts } from "../../application/dropship-listing-settings-facts";
import { applyListingSettingPatch, EMPTY_CATEGORY_LISTING_SETTING_VALUES, EMPTY_PRODUCT_LISTING_SETTING_VALUES } from "../../domain/listing-setting-values";
import { readCategoryListingSettings } from "../../infrastructure/dropship-category-listing-settings.repository";
import {
  categoryColumnsToValues, categoryValuesToColumns, productColumnsToValues, productValuesToColumns,
} from "../../infrastructure/dropship-listing-setting-shared.repository";
import { loadListingRulePrices } from "../../infrastructure/dropship-rule-price.loader";
import {
  GOLDEN_CROSS_PATH_CATEGORIES,
  GOLDEN_CROSS_PATH_PRODUCTS,
  GOLDEN_PREVIEW_CATEGORY_NAMES,
  GOLDEN_PREVIEW_NO_RULES_STORE,
  GOLDEN_PREVIEW_NOW,
  GOLDEN_PREVIEW_RULES_STORE,
  GOLDEN_PREVIEW_VENDOR_ID,
  type GoldenPreviewStore,
} from "../fixtures/listing-preview-golden.fixture";
import {
  GoldenStoreClient,
  NO_LAYER_ROWS,
  VARIANT_IDS,
  candidateOf,
  expectSheetSaysWhatPreviewSends,
  goldenClassifyAtCost,
  goldenCostChangeFacts,
  goldenListingInputs,
  goldenPerSizePrice,
  goldenPricingReview,
  mockGoldenCostSource,
  runGoldenPreview,
  type GoldenLayerRows,
} from "../fixtures/listing-preview-golden.harness";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));

/** When a cross-path scenario's settings rows were saved (as the preview golden's variants save theirs). */
const SETTINGS_SAVED_AT = new Date("2026-10-08T09:00:00.000Z");

function productSettingsRow(productId: number, values: ProductListingSettingValues) {
  return { product_id: productId, revision_id: 900 + productId, ...productValuesToColumns(values), created_at: SETTINGS_SAVED_AT };
}
function categorySettingsRow(categoryId: number, values: CategoryListingSettingValues) {
  return { category_id: categoryId, revision_id: 800 + categoryId, ...categoryValuesToColumns(values), created_at: SETTINGS_SAVED_AT };
}

/** The store with only the named pricing and description groups taken out (eBay rules are kept). */
function withoutGroups(store: GoldenPreviewStore, name: string, pricingIds: readonly string[], contentIds: readonly string[]): GoldenPreviewStore {
  const pricing = store.pricingProfile!;
  const content = store.contentProfile!;
  return { ...store, name,
    pricingProfile: { ...pricing, profile: { ...pricing.profile, groups: pricing.profile.groups.filter((group) => !pricingIds.includes(group.id)) } },
    contentProfile: { ...content, profile: { ...content.profile, groups: content.profile.groups.filter((group) => !contentIds.includes(group.id)) } } };
}

/** Plan 4.B.4 (a): store 22 without the price tie (both Binders groups) and the description tie (both Storage groups). */
const CATEGORY_RULES_STORE = withoutGroups(GOLDEN_PREVIEW_RULES_STORE, "store 22 with category rules only",
  ["binders-a", "binders-b"], ["storage-a", "storage-b"]);
/**
 * Store 22 without each tie's category half (Binders A, Storage boxes): the
 * product-line groups then win alone and become products 600's and 700's own
 * values, beside the three category rules.
 */
const PRODUCT_LINE_RULES_STORE = withoutGroups(GOLDEN_PREVIEW_RULES_STORE, "store 22 with category and product-line rules",
  ["binders-a"], ["storage-a"]);

/**
 * The cross-path settings (G2F, PR 8b-G) as stored rows: products 100 and
 * 200 and categories 13 and 14 set values of their own. Category 13 already
 * sets an eBay category, so the "Toploaders" rule cannot move into it.
 */
const CROSS_PATH_ROWS: GoldenLayerRows = {
  products: GOLDEN_CROSS_PATH_PRODUCTS.map(([productId, values]) => productSettingsRow(productId, values)),
  categories: GOLDEN_CROSS_PATH_CATEGORIES.map(([categoryId, values]) => categorySettingsRow(categoryId, values)),
};

interface ConversionScenario { name: string; store: GoldenPreviewStore; layerRows: GoldenLayerRows }
const CLEAN_SCENARIOS: readonly ConversionScenario[] = [
  { name: CATEGORY_RULES_STORE.name, store: CATEGORY_RULES_STORE, layerRows: NO_LAYER_ROWS },
  { name: PRODUCT_LINE_RULES_STORE.name, store: PRODUCT_LINE_RULES_STORE, layerRows: NO_LAYER_ROWS },
];
const NOT_CLEAN_SCENARIOS: readonly ConversionScenario[] = [
  { name: "store 22 as it is", store: GOLDEN_PREVIEW_RULES_STORE, layerRows: NO_LAYER_ROWS },
  { name: `${CATEGORY_RULES_STORE.name}, with the cross-path settings`, store: CATEGORY_RULES_STORE, layerRows: CROSS_PATH_ROWS },
  { name: `${PRODUCT_LINE_RULES_STORE.name}, with the cross-path settings`, store: PRODUCT_LINE_RULES_STORE, layerRows: CROSS_PATH_ROWS },
];
const named = (scenarios: readonly ConversionScenario[]) => scenarios.map((scenario) => [scenario.name, scenario] as const);

/** The store's saved product text in UTF-8 bytes: LISTING_TEXT_BYTES_SQL's `store_bytes` over these rows (text above, below and main). */
function storedProductTextBytes(layerRows: GoldenLayerRows): number {
  let bytes = 0;
  for (const row of layerRows.products) {
    for (const column of ["text_above", "text_below", "body_text"] as const) {
      const text = row[column] ?? null;
      if (text === null) continue;
      if (typeof text !== "string") throw new Error(`Product ${row.product_id}'s stored ${column} is not text.`);
      bytes += Buffer.byteLength(text, "utf8");
    }
  }
  return bytes;
}

/**
 * The planner's inputs as the loader reads them (loadConversionInputs, plan
 * 4.B.1): the read model's inputs, then a key for every category name the
 * store's category rules target, holding every Card Shellz category with
 * exactly that name (from the fixture's catalog), each such category's
 * settings row or null (the loader's own row read, over the store's client),
 * and the store's saved product text in bytes.
 */
async function goldenConversionInputs(store: GoldenPreviewStore, layerRows: GoldenLayerRows): Promise<ConversionInputs> {
  const listing = await goldenListingInputs(store, layerRows);
  const categoriesByName = new Map(conversionCategoryNamesToRead(listing).map((name) => [name,
    [...GOLDEN_PREVIEW_CATEGORY_NAMES].filter(([, categoryName]) => categoryName === name).map(([id, categoryName]) => ({ id, name: categoryName }))]));
  const categoryIds = [...categoriesByName.values()].flat().map((category) => category.id);
  const rows = await readCategoryListingSettings(new GoldenStoreClient(store, layerRows).asPgClient(),
    { vendorId: GOLDEN_PREVIEW_VENDOR_ID, storeConnectionId: store.context.storeConnectionId, categoryIds });
  return { listing, categoriesByName, categoryRows: new Map(categoryIds.map((id) => [id, rows.get(id) ?? null] as const)),
    storeTextBytes: storedProductTextBytes(layerRows) };
}

async function checkOf(scenario: ConversionScenario): Promise<RulesConversionCheck & { inputs: ConversionInputs }> {
  const inputs = await goldenConversionInputs(scenario.store, scenario.layerRows);
  return { inputs, ...checkRulesConversion(inputs) };
}

/** A profile row with the group list the plan empties emptied; the plan must expect the stored revision. */
function emptied<P>(row: { id: number; profile: P; created_at: Date } | null, write: PlannedProfileWrite | null, empty: (profile: P) => P) {
  if (write === null) return row;
  expect(row?.id).toBe(write.expectedRevisionId);
  return { ...row!, profile: empty(row!.profile) };
}

/**
 * The store as the move would leave it, as stored rows (plan 4.B.4 (b)):
 * every group list the plan empties, emptied with its default kept, and each
 * planned product and category row merged over the stored row it replaces
 * (or over "follow the default") with the writers' own merge,
 * applyListingSettingPatch. The profiles keep their revision ids and the
 * planned rows take the planner's stand-in revision, so the read-back can be
 * compared with the planner's after inputs; a revision id moves only evidence
 * hashes, which the conversion never compares (plan D3).
 */
function storedAfterMove(scenario: ConversionScenario, { plan }: RulesConversionCheck): ConversionScenario {
  const { store, layerRows } = scenario;
  const products = new Map(layerRows.products.map((row) => [row.product_id, row] as const));
  for (const write of plan.products) {
    const stored = products.get(write.productId) ?? null;
    expect(stored?.revision_id ?? null).toBe(write.expectedRevisionId);
    const before = stored ? productColumnsToValues(stored as unknown as Parameters<typeof productColumnsToValues>[0]) : EMPTY_PRODUCT_LISTING_SETTING_VALUES;
    products.set(write.productId, { product_id: write.productId, revision_id: PLANNED_ROW_REVISION_ID,
      ...productValuesToColumns(applyListingSettingPatch(before, write.patch)), created_at: new Date(PLANNED_ROW_UPDATED_AT) });
  }
  const categories = new Map(layerRows.categories.map((row) => [row.category_id, row] as const));
  for (const write of plan.categories) {
    const stored = categories.get(write.categoryId) ?? null;
    expect(stored?.revision_id ?? null).toBe(write.expectedRevisionId);
    const before = stored ? categoryColumnsToValues(stored as unknown as Parameters<typeof categoryColumnsToValues>[0]) : EMPTY_CATEGORY_LISTING_SETTING_VALUES;
    categories.set(write.categoryId, { category_id: write.categoryId, revision_id: PLANNED_ROW_REVISION_ID,
      ...categoryValuesToColumns(applyListingSettingPatch(before, write.patch)), created_at: new Date(PLANNED_ROW_UPDATED_AT) });
  }
  return {
    name: `${scenario.name}, after the move`,
    store: { ...store,
      pricingProfile: emptied(store.pricingProfile, plan.profiles.pricing, (profile) => ({ ...profile, groups: [] })),
      contentProfile: emptied(store.contentProfile, plan.profiles.content, (profile) => ({ ...profile, groups: [] })),
      ebayCategoryRules: emptied(store.ebayCategoryRules, plan.profiles.ebayRules, (profile) => ({ ...profile, rules: [] })) },
    layerRows: { products: [...products.values()], categories: [...categories.values()] },
  };
}

// ---------------------------------------------------------------------------
// Every price path (the rule-price golden's "every path" pattern, plan 4.B.4 (b)):
// the queue's loader, the preview with its layers, W9, the W1 review, the
// cost-change classifier and the listing-settings facts, each over one store's
// stored rows. Each gives a size's price and its class; the preview also gives
// the values it sends.
// ---------------------------------------------------------------------------

type PathName = "facts" | "preview" | "queue" | "perSize" | "review" | "costChange";
type PathAnswers = Record<PathName, ReadonlyMap<number, unknown>>;

/** The read model's price and its class (plan 3.2: a rule price names its basis). */
async function factsPrices(scenario: ConversionScenario): Promise<Map<number, unknown>> {
  const facts = buildListingSettingsFacts(await goldenListingInputs(scenario.store, scenario.layerRows));
  return new Map(facts.sizes.map(({ price }) => [price.productVariantId, { priceCents: price.priceCents,
    source: price.source === "rules" ? `rules_${price.basis}` : price.source }]));
}

/** What the step 3 preview sends for a size, without labels and evidence (which move with any revision, plan D3). */
function previewValues(row: DropshipListingPreviewRow) {
  return { priceCents: row.priceCents, byRule: row.rulePriceEvidenceHash !== undefined, followsStorePricing: row.followsStorePricing ?? false,
    priceSettingRevisionId: row.priceSettingRevisionId, previewStatus: row.previewStatus, blockers: row.blockers, warnings: row.warnings,
    ebayCategoryId: row.marketplaceCategoryId, shelves: row.storeCategoryNames, policies: row.businessPolicySelection,
    description: row.listingIntent?.description ?? null };
}

/** The queue's re-check (createListingPushJob): the loader with no layers given, over the sizes the rules price. */
async function queuePrices(scenario: ConversionScenario, productVariantIds: readonly number[]): Promise<Map<number, unknown>> {
  const client = new GoldenStoreClient(scenario.store, scenario.layerRows);
  const prices = await loadListingRulePrices(client.asPgClient(), { vendorId: GOLDEN_PREVIEW_VENDOR_ID,
    storeConnectionId: scenario.store.context.storeConnectionId, candidates: productVariantIds.map(candidateOf) });
  return new Map(productVariantIds.map((id) => {
    const price = prices.get(id);
    if (!price) throw new Error(`The queue's loader did not price size ${id}.`);
    return [id, { priceCents: price.priceCents, basis: price.basis, issue: price.issue }];
  }));
}

/** W9's GET for each size, through W9's own loader call (one size, no layers given): the harness's driver, as G2 runs it. */
async function perSizePrices(scenario: ConversionScenario): Promise<Map<number, unknown>> {
  const answers = new Map<number, unknown>();
  for (const productVariantId of VARIANT_IDS) {
    const answer = await goldenPerSizePrice(scenario.store, scenario.layerRows, productVariantId);
    answers.set(productVariantId, { priceCents: answer.effectivePriceCents, source: answer.source,
      basis: answer.source === "rules" ? answer.ruleBasis ?? null : null });
  }
  return answers;
}

/** The pricing review (W1) of the store's rules as they stand, proposed again: each size's price now and under them. */
async function reviewPrices(scenario: ConversionScenario): Promise<Map<number, unknown>> {
  const { review } = await goldenPricingReview(scenario.store, scenario.layerRows, (current) => current.profile!);
  return new Map(review.rows.map((row) => [row.productVariantId, { previousPriceCents: row.previousPriceCents,
    priceCents: row.priceCents, basis: row.basis ?? null, preserved: row.preserved, followsStorePricing: row.followsStorePricing ?? false }]));
}

/** The cost-change classifier at each size's .ops cost, over the facts loadVendorFacts reads. */
async function costChangePrices(scenario: ConversionScenario): Promise<Map<number, unknown>> {
  const facts = await goldenCostChangeFacts(scenario.store, scenario.layerRows);
  return new Map(VARIANT_IDS.map((productVariantId) => [productVariantId, goldenClassifyAtCost(scenario.store, facts, productVariantId)]));
}

/** Every path's answer per size; the queue's over `ruleSizeIds`, the sizes the preview prices by rule before the move. */
async function pricePaths(scenario: ConversionScenario, ruleSizeIds: readonly number[]): Promise<PathAnswers> {
  const { preview } = await runGoldenPreview(scenario.store, { layerRows: scenario.layerRows });
  return {
    facts: await factsPrices(scenario),
    preview: new Map(preview.rows.map((row) => [row.productVariantId, previewValues(row)])),
    queue: await queuePrices(scenario, ruleSizeIds),
    perSize: await perSizePrices(scenario),
    review: await reviewPrices(scenario),
    costChange: await costChangePrices(scenario),
  };
}

/**
 * Every path gives every size the diff does not list what it gives it
 * today, and returns how many sizes it compared. The sizes the rules price
 * before the move are the ones the queue re-checks.
 */
async function expectUnlistedSizesKeepEveryPath(scenario: ConversionScenario, check: RulesConversionCheck): Promise<number> {
  const listed = new Set(check.diff.rows.map((row) => row.productVariantId));
  const { preview } = await runGoldenPreview(scenario.store, { layerRows: scenario.layerRows });
  const ruleSizeIds = preview.rows.filter((row) => row.rulePriceEvidenceHash !== undefined).map((row) => row.productVariantId);
  expect(ruleSizeIds.length).toBeGreaterThan(0);
  const before = await pricePaths(scenario, ruleSizeIds);
  const after = await pricePaths(storedAfterMove(scenario, check), ruleSizeIds);
  const compared = VARIANT_IDS.filter((id) => !listed.has(id));
  for (const path of Object.keys(before) as PathName[]) {
    // The queue re-checks only the sizes the rules price; every other path answers for every chosen size.
    for (const id of path === "queue" ? compared.filter((size) => ruleSizeIds.includes(size)) : compared) {
      expect(before[path].has(id) && after[path].has(id), `${path} answers for size ${id}`).toBe(true);
      expect(after[path].get(id), `${path}, size ${id}`).toEqual(before[path].get(id));
    }
  }
  return compared.length;
}

beforeEach(() => mockGoldenCostSource());
afterEach(() => vi.restoreAllMocks());

describe("rules conversion golden: clean stores (plan 4.B.4 (a)-(c), REC:931)", () => {
  it("(a) store 22 without its ties: an empty diff, with category rules of all three kinds, the empty footer becoming none", async () => {
    const { inputs, plan, diff } = await checkOf(CLEAN_SCENARIOS[0]);

    expect(diff).toMatchObject({ rows: [], state: "clean",
      blocked: { wouldLosePrice: [], wouldBlockListing: [], tooMuchText: false, addedProductTextBytes: 0 } });
    expect(diff.hashes?.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(diff.hashes?.writesHash).toMatch(/^[a-f0-9]{64}$/);
    // The names read: one key per category name the rules target, from the fixture's catalog.
    expect(inputs.categoriesByName).toEqual(new Map([["Sleeves", [{ id: 12, name: "Sleeves" }]], ["Toploaders", [{ id: 13, name: "Toploaders" }]]]));
    expect(inputs.categoryRows).toEqual(new Map([[12, null], [13, null]]));
    // Pricing "Sleeves", description "Sleeve buyers" (its empty footer is "none", not the store's) and eBay "Toploaders".
    expect(plan.categories).toEqual([
      { categoryId: 12, categoryName: "Sleeves", expectedRevisionId: null, settings: ["price", "textAbove", "textBelow"], patch: {
        price: { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" },
        textAbove: { mode: "own", text: "Every sleeve is acid free." }, textBelow: { mode: "none" } } },
      { categoryId: 13, categoryName: "Toploaders", expectedRevisionId: null, settings: ["ebayCategory"], patch: {
        ebayCategory: { categoryId: "900101", categoryName: "Toploaders", path: ["Collectibles", "Card Storage", "Toploaders"] } } },
    ]);
    expect(plan.products).toEqual([]);
    expect(plan.profiles).toEqual({ pricing: { expectedRevisionId: 41, removedIds: ["sleeves"] },
      content: { expectedRevisionId: 12, removedIds: ["sleeves-text"] }, ebayRules: { expectedRevisionId: 7, removedIds: ["toploaders"] } });
    expect(plan.firstMarks).toEqual([100, 200, 300, 600, 700]);
    // Product 600 keeps its copy "Binders" with no Card Shellz category: listed, and given nothing.
    expect(plan.report).toEqual({ unmatched: [], shared: [], neverApplies: [], ties: [], someSizesOnly: [], mixed: [],
      nameMismatches: [{ productId: 600, productName: "Nine-pocket binder", listedAs: "Binders", categoryName: null }] });
  });

  it("(a) store 22 without each tie's category half: the product-line rules become the products' own values, still an empty diff", async () => {
    const { plan, diff } = await checkOf(CLEAN_SCENARIOS[1]);

    expect(diff).toMatchObject({ rows: [], state: "clean", blocked: { wouldLosePrice: [], wouldBlockListing: [], tooMuchText: false } });
    expect(plan.categories.map((write) => [write.categoryId, write.settings])).toEqual([[12, ["price", "textAbove", "textBelow"]], [13, ["ebayCategory"]]]);
    // "Binders B" (product line 9) prices product 600; "Storage line" (product line 12) has no text above, only below.
    expect(plan.products).toEqual([
      { productId: 600, productName: "Nine-pocket binder", expectedRevisionId: null, settings: ["price"],
        patch: { price: { basis: "product_cost", markupBps: 5_000, flatCents: 0, rounding: "cent" } } },
      { productId: 700, productName: "Card storage box", expectedRevisionId: null, settings: ["textAbove", "textBelow"],
        patch: { textAbove: { mode: "none" }, textBelow: { mode: "own", text: "Lids sold separately." } } },
    ]);
    // Only product text counts toward the store's cap (plan D9c): the 21 bytes of "Lids sold separately.".
    expect(diff.blocked.addedProductTextBytes).toBe(Buffer.byteLength("Lids sold separately.", "utf8"));
  });

  it.each(named(CLEAN_SCENARIOS))("(a) the answer passes its strict schema, clean, with nothing to page through: %s", async (_name, scenario) => {
    const { plan, diff } = await checkOf(scenario);

    const answer = listingRulesConversionCheckSchema.parse(conversionCheckView(plan, diff, 0, GOLDEN_PREVIEW_NOW));

    expect(answer).toMatchObject({ storeConnectionId: 22, generatedAt: GOLDEN_PREVIEW_NOW.toISOString(), state: "clean",
      planHash: diff.hashes!.planHash, writesHash: diff.hashes!.writesHash,
      blocked: { wouldLosePrice: { total: 0, items: [] }, wouldBlockListing: { total: 0, items: [] }, tooMuchText: false },
      changes: { page: 0, pageSize: 50, total: 0, rows: [] } });
    expect(answer.becomes.categories.items.map((item) => item.categoryName)).toEqual(["Sleeves", "Toploaders"]);
  });

  it.each(named([...CLEAN_SCENARIOS, ...NOT_CLEAN_SCENARIOS]))("reads the planned rows back, through the real readers, as the planner's after inputs: %s",
    async (_name, scenario) => {
      const check = await checkOf(scenario);
      const after = storedAfterMove(scenario, check);

      expect(await goldenListingInputs(after.store, after.layerRows)).toEqual(conversionAfterInputs(check.inputs, check.plan));
      // What the writers' text cap would count after the move: today's bytes plus the bytes the plan adds (plan D9c).
      expect(storedProductTextBytes(after.layerRows)).toBe(check.inputs.storeTextBytes + check.diff.blocked.addedProductTextBytes);
    });

  it("counts the store's saved product text in UTF-8 bytes, as the store text cap does: text above, below and main, of product rows only", async () => {
    const { inputs } = await checkOf(NOT_CLEAN_SCENARIOS[2]);

    // Product 100's text above and product 200's main text; category 13's and 14's rows never count (plan D9c).
    const product100 = GOLDEN_CROSS_PATH_PRODUCTS.find(([productId]) => productId === 100)![1];
    const product200 = GOLDEN_CROSS_PATH_PRODUCTS.find(([productId]) => productId === 200)![1];
    const texts = [product100.textAbove?.mode === "own" ? product100.textAbove.text : "", product200.mainText?.text ?? ""];
    expect(texts.every((text) => text.length > 0)).toBe(true);
    expect(inputs.storeTextBytes).toBe(texts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0));
    expect(CROSS_PATH_ROWS.categories.some((row) => row.text_below !== null)).toBe(true);
  });

  it.each(named(CLEAN_SCENARIOS))("(b) after the move every price path gives every size the price and class it has today: %s", async (_name, scenario) => {
    const check = await checkOf(scenario);
    expect(check.diff.rows).toEqual([]);

    expect(await expectUnlistedSizesKeepEveryPath(scenario, check)).toBe(VARIANT_IDS.length);
  });

  it.each(named(CLEAN_SCENARIOS))("(b) the move is real: a category or a product decides where an older group rule did: %s", async (_name, scenario) => {
    const after = storedAfterMove(scenario, await checkOf(scenario));
    const before = (await runGoldenPreview(scenario.store)).preview;
    const moved = (await runGoldenPreview(after.store, { layerRows: after.layerRows })).preview;
    const row = (preview: typeof before, id: number) => preview.rows.find((entry) => entry.productVariantId === id)!;

    expect([after.store.pricingProfile!.profile.groups, after.store.contentProfile!.profile.groups, after.store.ebayCategoryRules!.profile.rules])
      .toEqual([[], [], []]);
    // Team bags: the "Sleeves" group's price is category 12's now, at the same cents.
    expect(row(before, 2001)).toMatchObject({ pricingRuleName: "Sleeves", priceCents: 1_499 });
    expect(row(moved, 2001)).toMatchObject({ pricingRuleName: "Category price", priceCents: 1_499 });
    // Toploaders: the eBay rule's category is category 13's now.
    expect(row(before, 3001)).toMatchObject({ marketplaceCategorySource: "rule", marketplaceCategoryId: "900101" });
    expect(row(moved, 3001)).toMatchObject({ marketplaceCategorySource: "category", marketplaceCategoryId: "900101" });
    // Evidence follows the level a value comes from (plan D3: never compared), so it moves while the value does not.
    expect(row(moved, 2001).rulePriceEvidenceHash).not.toBe(row(before, 2001).rulePriceEvidenceHash);
    expect(row(moved, 2001).contentEvidenceHash).not.toBe(row(before, 2001).contentEvidenceHash);
    expect(row(moved, 2001).listingIntent?.description).toBe(row(before, 2001).listingIntent?.description);
  });

  it.each(named(CLEAN_SCENARIOS))("(c) after the move the product sheet says what the step 3 preview sends, size by size: %s", async (_name, scenario) => {
    const after = storedAfterMove(scenario, await checkOf(scenario));

    // The after store has no pins, so the comparison must have covered every chosen size (none can pass by being absent).
    expect(await expectSheetSaysWhatPreviewSends(after.store, after.layerRows)).toEqual(VARIANT_IDS);
  });
});

describe("rules conversion golden: stores that are not clean (plan 4.B.4 (d))", () => {
  it("(d) store 22 as it is: not clean, the ties and Binders listed with their settings, their sizes in the rows", async () => {
    const { plan, diff } = await checkOf(NOT_CLEAN_SCENARIOS[0]);

    expect(diff.state).toBe("not_clean");
    expect(plan.report).toEqual({
      // "Binders A" names a category no Card Shellz category has: product 600 has the copy and no id.
      unmatched: [{ ruleName: "Binders A", categoryName: "Binders", kind: "price" }],
      shared: [],
      nameMismatches: [{ productId: 600, productName: "Nine-pocket binder", listedAs: "Binders", categoryName: null }],
      // Each tie's product-line half writes nothing and wins nowhere.
      neverApplies: [{ ruleName: "Binders B", kind: "price" }, { ruleName: "Storage line", kind: "description" }],
      ties: [{ productId: 700, productName: "Card storage box", setting: "description" },
        { productId: 600, productName: "Nine-pocket binder", setting: "price" }],
      someSizesOnly: [], mixed: [],
    });
    // A tie gives no product value; the tied category half "Storage boxes" still becomes category 14's text.
    expect(plan.products).toEqual([]);
    expect(plan.categories.map((write) => [write.categoryId, write.settings])).toEqual([
      [12, ["price", "textAbove", "textBelow"]], [13, ["ebayCategory"]], [14, ["textAbove", "textBelow"]]]);
    // The tied sizes are the rows (by product name, then size name): the price tie's sizes gain the store default rule,
    // and the description tie's size takes category 14's text instead of a conflict.
    expect(diff.rows.map((row) => [row.productVariantId, row.changed])).toEqual([
      [7001, ["description", "listable"]],
      [6002, ["price", "priceSource", "pricingRule"]],
      [6001, ["price", "priceSource", "pricingRule", "listable"]],
    ]);
    const rows = new Map(diff.rows.map((row) => [row.productVariantId, row]));
    expect(rows.get(6001)).toMatchObject({ before: { pricingRule: { kind: "tie" }, price: { priceCents: null, source: "none" } },
      after: { pricingRule: { kind: "store_default" }, price: { source: "rules", basis: "product_cost" }, blockers: [] } });
    expect(rows.get(6001)!.before.blockers).toContain("size_cannot_be_priced");
    expect(rows.get(7001)!.before.blockers).toContain("description_group_conflict");
    expect(rows.get(7001)!.after.blockers).toEqual([]);
    // The one listed size (1001) is not touched, and no size loses its price: nothing blocks the move.
    expect(diff.blocked).toEqual({ wouldLosePrice: [], wouldBlockListing: [], tooMuchText: false, addedProductTextBytes: 0 });

    const answer = listingRulesConversionCheckSchema.parse(conversionCheckView(plan, diff, 0, GOLDEN_PREVIEW_NOW));
    expect(answer).toMatchObject({ state: "not_clean", olderRules: { pricingGroups: 3, contentGroups: 3, ebayCategoryRules: 1 },
      changes: { total: 3 } });
    expect(answer.changes.rows.map((row) => row.productVariantId)).toEqual([7001, 6002, 6001]);
    expect(answer.report.ties.items.map((item) => item.setting)).toEqual(["description", "price"]);
  });

  it("(d) a target category that already sets the field keeps its own value, and the size that then moves is a row", async () => {
    const { plan, diff } = await checkOf(NOT_CLEAN_SCENARIOS[1]);

    // Category 13 sets its own eBay category (900400), so the "Toploaders" rule's (900101) is not written to it.
    expect(plan.categories.map((write) => write.categoryId)).toEqual([12]);
    expect(diff.state).toBe("not_clean");
    expect(diff.rows.map((row) => [row.productVariantId, row.changed])).toEqual([[3001, ["ebayCategory"]]]);
    expect(diff.rows[0]).toMatchObject({ before: { ebayCategory: { id: "900101" } }, after: { ebayCategory: { id: "900400" } } });
  });

  it.each(named(NOT_CLEAN_SCENARIOS))("(d) every size the rows do not list keeps its price and class on every path after the move: %s",
    async (_name, scenario) => {
      const check = await checkOf(scenario);
      expect(check.diff.rows.length).toBeGreaterThan(0);

      expect(await expectUnlistedSizesKeepEveryPath(scenario, check)).toBe(VARIANT_IDS.length - check.diff.rows.length);
    });

  it.each(named(NOT_CLEAN_SCENARIOS))("(d) after the move the product sheet still says what the step 3 preview sends: %s", async (_name, scenario) => {
    const after = storedAfterMove(scenario, await checkOf(scenario));

    expect(await expectSheetSaysWhatPreviewSends(after.store, after.layerRows)).toEqual(VARIANT_IDS);
  });
});

describe("rules conversion golden: a store with no older rules (plan 4.B.4 (e))", () => {
  it("(e) store 23: no_older_rules, nothing to write, no hashes and no rows", async () => {
    const scenario = { name: "store 23", store: GOLDEN_PREVIEW_NO_RULES_STORE, layerRows: NO_LAYER_ROWS };
    const { inputs, plan, diff } = await checkOf(scenario);

    expect(inputs.categoriesByName).toEqual(new Map());
    expect(diff).toEqual({ rows: [], state: "no_older_rules", hashes: null,
      blocked: { wouldLosePrice: [], wouldBlockListing: [], tooMuchText: false, addedProductTextBytes: 0 } });
    expect(plan).toMatchObject({ olderRules: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 },
      profiles: { pricing: null, content: null, ebayRules: null }, categories: [], products: [], firstMarks: [] });
    const answer = listingRulesConversionCheckSchema.parse(conversionCheckView(plan, diff, 0, GOLDEN_PREVIEW_NOW));
    expect(answer).toMatchObject({ state: "no_older_rules", planHash: null, writesHash: null,
      becomes: { categories: { total: 0 }, products: { total: 0 } }, changes: { total: 0, rows: [] } });
  });
});
