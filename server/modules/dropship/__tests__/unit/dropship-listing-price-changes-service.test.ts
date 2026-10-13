import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SavedListingPriceRevision } from "../../../../../shared/dropship/listing-price";
import type { CategoryListingSettingValues } from "../../../../../shared/dropship/listing-setting-values";
import {
  MAX_BULK_TEXT_BYTES,
  priceChangeReviewResponseSchema,
  priceChangeRowsSchema,
  storedInputSchemaFor,
  type PriceChangeRow,
} from "../../../../../shared/dropship/listing-setting-writes";
import { calculateRulePrice, type PricingProfileState, type PricingRecipe } from "../../../../../shared/dropship/pricing-rules";
import type { DropshipListingCatalogCandidate, DropshipListingStoreContext } from "../../application/dropship-listing-preview-service";
import type { ListingSettingEbayPort } from "../../application/dropship-listing-setting-ebay-values";
import type {
  CategoryListingSettingSaveInput,
  ClearSizeLeftoversInput,
  ListingSettingFacts,
  ListingSettingFactsInput,
  ListingSettingPreflightTransaction,
  ListingSettingReviewTransaction,
  ListingSettingWriteRepository,
  ListingSettingWriteTransaction,
  ListingTextBytes,
  LoadedPriceChangeReview,
  ProductListingSettingsBulkInput,
  ProductSettingFacts,
  StoredPriceChangeReview,
} from "../../application/dropship-listing-setting-writes";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import { pricingHash } from "../../application/dropship-rule-price";
import { DropshipError } from "../../domain/errors";
import type { RequestKeyUse } from "../../domain/listing-setting-request-key-use";
import { listingSettingChildKey, listingSettingRequestHash, type ListingSettingLeftoverField } from "../../domain/listing-setting-values";

/** W9's flow is pinned by its own tests; here it is a recorded stub so each release's outcome can be chosen. */
const w9 = vi.hoisted(() => ({ saveListingPriceInTransaction: vi.fn() }));
vi.mock("../../application/dropship-listing-price-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../application/dropship-listing-price-service")>()),
  saveListingPriceInTransaction: w9.saveListingPriceInTransaction,
}));
// The real chosen check runs; it is wrapped only so its mode ("pricing") can be asserted.
const chosen = vi.hoisted(() => ({ spy: null as Mock | null }));
vi.mock("../../application/dropship-listing-setting-write-support", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../application/dropship-listing-setting-write-support")>();
  chosen.spy = vi.fn(actual.loadChosenSizes);
  return { ...actual, loadChosenSizes: chosen.spy };
});
import { ListingSettingHeavyWriteGate, listingSettingBulkTooLarge } from "../../application/dropship-listing-setting-write-support";
import {
  DropshipListingPriceChangesService,
  priceChangeReviewHash,
  projectPriceChangeReview,
} from "../../application/dropship-listing-price-changes-service";

/**
 * W7 with every port stubbed (plan PR 9, sections 9.5-9.7, 9.13): the
 * review's and the apply's call order, the review row's kind, input and
 * hash, the apply's replay with no writer, every refusal before the first
 * write, the writes' order and inputs, W9's releases after the product rows,
 * the heavy-write gate around both, and the INFO lines. One fake store
 * ("World") answers the review's transaction and the apply's, so an apply
 * recomputes what its review stored. The real builder, chosen check and
 * classifier run. No port that reads product text is ever called (the stubs
 * throw).
 */

const NOW = new Date("2026-10-13T09:00:00.000Z");
const LATER = new Date("2026-10-13T09:05:00.000Z");
const MEMBER = "member-1";
const VENDOR = 10;
const STORE = 22;
const CATEGORY = 3;
const KEY = "price-changes:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const REVIEW_ID = "6f1b1d7e-6d0e-4d43-9a43-2f9d3c0b7c11";
const OTHER_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const RETAIL = 1_199;
const COST = 800;
/** 800 x 1.3 + $1.00 = 1,140. */
const STORE_DEFAULT = { basis: "product_cost", markupBps: 3_000, flatCents: 100, rounding: "cent" } as const;
/** 800 x 1.5 = 1,200. */
const PRODUCT_RECIPE = { basis: "product_cost", markupBps: 5_000, flatCents: 0, rounding: "cent" } as const;
/** 800 x 1.25 = 1,000. */
const CATEGORY_RECIPE = { basis: "product_cost", markupBps: 2_500, flatCents: 0, rounding: "cent" } as const;
const PROFILE: PricingProfileState = { revisionId: 5, profile: { defaultRecipe: STORE_DEFAULT, groups: [] }, updatedAt: "2026-10-01T00:00:00.000Z" };
const NOTHING: RequestKeyUse = { productRevision: null, categoryRevision: null, ledger: null, children: [] };
const NO_TEXT: ListingTextBytes = { storeBytes: 0, keptStoreBytes: 0, targetBytes: 0 };
const storeContext: DropshipListingStoreContext = {
  vendorId: VENDOR, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE, storeStatus: "connected",
  setupStatus: "ready", platform: "ebay", storeLaunchReady: true,
};
const CATEGORY_VALUES: CategoryListingSettingValues = {
  price: null, ebayCategory: null, storeShelf: null, shippingPolicy: { id: "ship-a", name: "Ships in a day" },
  returnPolicy: null, paymentPolicy: null, textAbove: null, textBelow: null,
};
const priceOf = (recipe: PricingRecipe, basisCents: number) => calculateRulePrice(recipe, basisCents).priceCents;

function candidate(productVariantId: number, productId: number, fields: Partial<DropshipListingCatalogCandidate> = {}): DropshipListingCatalogCandidate {
  return {
    productId, productVariantId, productLineIds: [], category: "Toploaders", categoryId: CATEGORY, ebayBrowseCategoryId: null,
    ebayBrowseCategoryName: null, productIsActive: true, variantIsActive: true, variantUomType: "pack", unitsPerVariant: 25,
    defaultRetailPriceCents: RETAIL, sku: `S-${productVariantId}`, productName: "Toploader", variantName: `Size ${productVariantId}`,
    title: "Toploader", description: "Rigid card protection.", brand: "Card Shellz", gtin: null, mpn: null, condition: "new",
    itemSpecifics: { Size: "3x4" }, imageUrls: ["https://example.test/a.jpg"], weightGrams: 100, ...fields,
  };
}

function cost(unitCostCents: number): DropshipProductCost {
  return { status: "available", unitCostCents, planId: "ops", source: "plan_percent", overrideId: null, issue: null,
    retailPriceCents: RETAIL, discountBps: 2_000 };
}

function typedPrice(productVariantId: number, revisionId: number, overridePriceCents: number): SavedListingPriceRevision {
  return { productVariantId, revisionId, overridePriceCents, pricingMode: "fixed", updatedAt: "2026-10-01T00:00:00.000Z" };
}

function facts(revisionId: number, price: PricingRecipe | null, ownFields: string[]): ProductSettingFacts {
  return { revisionId, price, ownFields: new Set(ownFields) as ProductSettingFacts["ownFields"] };
}

/** A stored review as the reviews table holds it: its owner, its row as jsonb gives it back (no key order kept), its rows' size. */
interface StoredRow { vendorId: number; storeConnectionId: number; kind: string; raw: unknown; rowsBytes: number }

/**
 * One store, as both transactions see it. Every port records its name in
 * `calls`; the review's transaction has no lockCatalog, no writer and no
 * probe, and the write transaction no review insert, so a step that reaches
 * the wrong one fails.
 */
class World {
  readonly calls: string[] = [];
  use: RequestKeyUse = NOTHING;
  groups = { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 };
  categoryNames = new Map([[CATEGORY, "Toploaders"]]);
  categoryRevisionId: number | null = 40;
  /** The category's products, by read; the last answer repeats. */
  categoryProducts: number[][] = [[7, 8, 9]];
  categoryReads = 0;
  sizesByProduct = new Map<number, number[]>([[7, [101, 102]], [8, [103]], [9, [104]]]);
  candidates = new Map<number, DropshipListingCatalogCandidate>([
    [101, candidate(101, 7)], [102, candidate(102, 7)], [103, candidate(103, 8)], [104, candidate(104, 9)],
  ]);
  notChosen = new Set<number>();
  productFacts = new Map<number, ProductSettingFacts>();
  categoryFacts = new Map<number, { revisionId: number; price: PricingRecipe | null }>();
  saved: SavedListingPriceRevision[] = [typedPrice(102, 502, 1_499)];
  costs = new Map<number, DropshipProductCost>([[101, cost(COST)], [102, cost(COST)], [103, cost(COST)], [104, cost(COST)]]);
  profile: PricingProfileState = PROFILE;
  leftovers = new Map<number, ListingSettingLeftoverField[]>();
  textBytes: ListingTextBytes = NO_TEXT;
  /** octet_length(rows::text) as PostgreSQL would answer it; by default the rows' JSON length. */
  rowsBytes: number | null = null;
  reviews = new Map<string, StoredRow>();
  applies = new Map<string, { vendorId: number; storeConnectionId: number; requestId: number; idempotencyKey: string }>();
  locked: unknown = null;
  bulkInputs: ProductListingSettingsBulkInput[] = [];
  categoryInputs: CategoryListingSettingSaveInput[] = [];
  leftoverInputs: ClearSizeLeftoversInput[] = [];

  private readonly catalog = {
    loadStoreContext: vi.fn(async () => { this.calls.push("gate"); return storeContext; }),
    listCatalogExposureRules: vi.fn(async () => { this.calls.push("exposureRules"); return [{ id: 1, scopeType: "catalog", action: "include" }]; }),
    listSelectionRules: vi.fn(async () => { this.calls.push("selectionRules"); return [{ id: 2, scopeType: "catalog", action: "include", isActive: true }]; }),
    listCatalogCandidates: vi.fn(async (ids: readonly number[]) => {
      this.calls.push("candidates");
      return ids.flatMap((id) => this.candidates.get(id) ?? []);
    }),
    listVariantOverrides: vi.fn(async (input: { productVariantIds: readonly number[] }) => {
      this.calls.push("overrides");
      return input.productVariantIds.filter((id) => this.notChosen.has(id)).map((productVariantId) => ({ productVariantId, enabledOverride: false }));
    }),
    listSavedListingPrices: vi.fn(async (input: { productVariantIds: readonly number[] }) => {
      this.calls.push("savedPrices");
      return this.saved.filter((row) => input.productVariantIds.includes(row.productVariantId));
    }),
    listExistingListings: vi.fn(async () => { this.calls.push("existingListings"); return []; }),
    listPricingPolicies: vi.fn(async () => { this.calls.push("pricingPolicies"); return []; }),
    getStoreListingConfig: vi.fn(async () => { throw new Error("A W7 transaction never reads the listing config."); }),
  };

  /** The reads both transactions share (plan 9.1). */
  private reads() {
    return {
      vendorId: VENDOR,
      storeConnectionId: STORE,
      catalog: this.catalog,
      loadOlderGroupRuleCounts: vi.fn(async () => { this.calls.push("groups"); return this.groups; }),
      listCategoryProductIds: vi.fn(async () => {
        this.calls.push("categoryProducts");
        this.categoryReads += 1;
        return [...(this.categoryProducts[Math.min(this.categoryReads, this.categoryProducts.length) - 1] ?? [])];
      }),
      listProductSizes: vi.fn(async (productIds: readonly number[]) => {
        this.calls.push("productSizes");
        return productIds.flatMap((id) => this.sizesByProduct.get(id) ?? []).sort((a, b) => a - b);
      }),
      loadSettingFacts: vi.fn(async (input: ListingSettingFactsInput): Promise<ListingSettingFacts> => {
        this.calls.push("settingFacts");
        return {
          products: new Map(input.productIds.flatMap((id) => this.productFacts.has(id) ? [[id, this.productFacts.get(id)!] as const] : [])),
          categories: new Map((input.categoryIds ?? []).flatMap((id) => this.categoryFacts.has(id) ? [[id, this.categoryFacts.get(id)!] as const] : [])),
        };
      }),
      readListingTextBytes: vi.fn(async () => { this.calls.push("textBytes"); return this.textBytes; }),
      loadPricingProfile: vi.fn(async () => { this.calls.push("pricingProfile"); return this.profile; }),
      loadProductCosts: vi.fn(async (ids: readonly number[]) => {
        this.calls.push("costs");
        return new Map(ids.flatMap((id) => this.costs.has(id) ? [[id, this.costs.get(id)!] as const] : []));
      }),
      // No W7 step reads a row with text: both throw if reached (plan 9.13, v3r C-feas-2).
      loadProducts: vi.fn(async () => { throw new Error("W7 reads no product row: it uses the text-free settings facts."); }),
    };
  }

  reviewTransaction(): ListingSettingReviewTransaction {
    return {
      ...this.reads(),
      loadCategories: vi.fn(async (ids: readonly number[]) => {
        this.calls.push("categoryRow");
        return new Map(this.categoryRevisionId === null ? [] : ids.map((id) => [id, { storeConnectionId: STORE, categoryId: id,
          revisionId: this.categoryRevisionId!, updatedAt: NOW.toISOString(), values: CATEGORY_VALUES }]));
      }),
      loadCatalogCategoryNames: vi.fn(async (ids: readonly number[]) => {
        this.calls.push("categoryNames");
        return new Map(ids.flatMap((id) => this.categoryNames.has(id) ? [[id, this.categoryNames.get(id)!] as const] : []));
      }),
      loadLeftoverFields: vi.fn(async () => { this.calls.push("leftovers"); return this.leftovers; }),
      storePriceChangeReview: vi.fn(async (review: StoredPriceChangeReview) => {
        this.calls.push("storeReview");
        // jsonb gives objects back with their keys in another order: reverse every object's keys.
        const rowsBytes = this.rowsBytes ?? Buffer.byteLength(JSON.stringify(review.rows), "utf8");
        this.reviews.set(review.id, { vendorId: VENDOR, storeConnectionId: STORE, kind: review.kind,
          raw: reversedKeys(JSON.parse(JSON.stringify(review))), rowsBytes });
        return { rowsBytes };
      }),
    } as unknown as ListingSettingReviewTransaction;
  }

  writeTransaction(requestKey: string): ListingSettingWriteTransaction {
    return {
      ...this.reads(),
      requestKey,
      actor: { actorType: "vendor", actorId: MEMBER },
      findRequestKeyUse: vi.fn(async () => { this.calls.push("probe"); return this.use; }),
      findPriceChangeApplyByReview: vi.fn(async (reviewId: string) => {
        this.calls.push("byReview");
        const applied = this.applies.get(reviewId);
        // Scoped by vendor and store, as the SQL is (v3r, C-money-4).
        return applied && applied.vendorId === VENDOR && applied.storeConnectionId === STORE
          ? { requestId: applied.requestId, idempotencyKey: applied.idempotencyKey } : null;
      }),
      loadPriceChangeReview: vi.fn(async (reviewId: string) => { this.calls.push("loadReview"); return this.load(reviewId, VENDOR, STORE); }),
      lockCatalog: vi.fn(async (input: { productIds?: readonly number[] }) => {
        this.calls.push("lockCatalog");
        this.locked = input;
        return { lockedProductIds: [...(input.productIds ?? [])].filter((id) => this.sizesByProduct.has(id)).sort((a, b) => a - b) };
      }),
      loadLeftoverFields: vi.fn(async () => { this.calls.push("leftovers"); return this.leftovers; }),
      loadCategories: vi.fn(async () => { throw new Error("W7's apply reads no category row: saveCategory does."); }),
      saveCategory: vi.fn(async (input: CategoryListingSettingSaveInput) => {
        this.calls.push("saveCategory");
        this.categoryInputs.push(input);
        const before = { storeConnectionId: STORE, categoryId: CATEGORY, revisionId: 40, updatedAt: NOW.toISOString(), values: CATEGORY_VALUES };
        return { outcome: "changed", categoryName: "Toploaders", changedFields: ["price"], before,
          row: { ...before, revisionId: 41, values: { ...CATEGORY_VALUES, ...input.patch } } };
      }),
      saveProductsBulk: vi.fn(async (input: ProductListingSettingsBulkInput) => {
        this.calls.push("saveProductsBulk");
        this.bulkInputs.push(input);
        if (input.operation === "price_change_apply") {
          this.applies.set(input.reviewId, { vendorId: VENDOR, storeConnectionId: STORE, requestId: 900, idempotencyKey: requestKey });
        }
        return { outcome: input.products.length === 0 ? "unchanged" : "changed", requestId: 900,
          changed: input.products.map((product) => ({ productId: product.productId, revisionId: 5_000 + product.productId })),
          unchangedProductIds: [] };
      }),
      sizePrice: vi.fn((productVariantId: number) => { this.calls.push(`sizePrice:${productVariantId}`); return { size: productVariantId }; }),
      clearSizeLeftovers: vi.fn(async (input: ClearSizeLeftoversInput) => {
        this.calls.push("clearSizeLeftovers");
        this.leftoverInputs.push(input);
        return { clearedSizeCount: 2, byKind: { policy: 0, shelf: 2, content: 0 }, productVariantIds: [101, 103] };
      }),
      saveProduct: vi.fn(async () => { throw new Error("W7 never saves one product."); }),
    } as unknown as ListingSettingWriteTransaction;
  }

  /** The repository's load: this vendor's and store's review of a W7 kind, parsed back by its schemas, with its rows' size, or null. */
  load(reviewId: string, vendorId: number, storeConnectionId: number): LoadedPriceChangeReview | null {
    const stored = this.reviews.get(reviewId);
    if (!stored || stored.vendorId !== vendorId || stored.storeConnectionId !== storeConnectionId
      || !["product_prices", "category_price"].includes(stored.kind)) return null;
    const raw = stored.raw as { id: string; kind: "product_prices" | "category_price"; input: unknown; rows: unknown; reviewHash: string; createdAt: string };
    return { id: raw.id, kind: raw.kind, input: storedInputSchemaFor(raw.kind).parse(raw.input), rows: priceChangeRowsSchema.parse(raw.rows),
      reviewHash: raw.reviewHash, createdAt: new Date(raw.createdAt), rowsBytes: stored.rowsBytes } as LoadedPriceChangeReview;
  }
}

/** Every object's keys reversed, as a jsonb round trip may give them back. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reversedKeys(entry)]));
}

class FakePreflight {
  readonly calls: string[] = [];
  readonly vendorId = VENDOR;
  readonly storeConnectionId = STORE;
  context: DropshipListingStoreContext = storeContext;
  readonly catalog = {
    loadStoreContext: vi.fn(async () => { this.calls.push("gate"); return this.context; }),
    getStoreListingConfig: vi.fn(async () => {
      this.calls.push("listingConfig");
      return { id: 1, storeConnectionId: STORE, platform: "ebay", listingMode: "live", inventoryMode: "managed_quantity_sync",
        priceMode: "vendor_defined", marketplaceConfig: { marketplaceId: "EBAY_US" }, requiredConfigKeys: [], requiredProductFields: [],
        isActive: true };
    }),
  };
  readonly findRequestKeyUse = vi.fn(async () => { throw new Error("A price check has no key, so its preflight has no probe."); });
  readonly loadProducts = vi.fn(async () => { throw new Error("A price check's preflight reads no product."); });
  readonly loadCategories = vi.fn(async (ids: readonly number[]) => {
    this.calls.push("category");
    return new Map(ids.map((id) => [id, { storeConnectionId: STORE, categoryId: id, revisionId: 40, updatedAt: NOW.toISOString(),
      values: CATEGORY_VALUES }]));
  });
}

class FakeRepository implements ListingSettingWriteRepository {
  readonly order: string[] = [];
  world = new World();
  pre = new FakePreflight();
  pages: Array<{ memberId: string; storeConnectionId: number; reviewId: string }> = [];
  async execute<T>(input: { memberId: string; storeConnectionId: number; idempotencyKey: string },
    operation: (tx: ListingSettingWriteTransaction) => Promise<T>): Promise<T> {
    this.order.push(`execute:${input.idempotencyKey}`);
    return operation(this.world.writeTransaction(input.idempotencyKey));
  }
  async executeReview<T>(input: { memberId: string; storeConnectionId: number },
    operation: (tx: ListingSettingReviewTransaction) => Promise<T>): Promise<T> {
    this.order.push(`executeReview:${input.memberId}:${input.storeConnectionId}`);
    return operation(this.world.reviewTransaction());
  }
  async readPriceChangeReviewForMember(input: { memberId: string; storeConnectionId: number; reviewId: string }) {
    this.order.push("readPage");
    this.pages.push(input);
    // Owner-scoped: member-1 owns vendor 10.
    return input.memberId === MEMBER ? this.world.load(input.reviewId, VENDOR, input.storeConnectionId) : null;
  }
  async executeForSystem(): Promise<never> { throw new Error("W7 never runs as the system."); }
  async preflight<T>(input: { memberId: string; storeConnectionId: number; idempotencyKey: string | null },
    operation: (tx: ListingSettingPreflightTransaction) => Promise<T>): Promise<T> {
    this.order.push(`preflight:${input.idempotencyKey}`);
    return operation(this.pre as unknown as ListingSettingPreflightTransaction);
  }
}

/** The real gate, recording when a write enters and leaves it. */
class RecordingGate extends ListingSettingHeavyWriteGate {
  constructor(private readonly order: string[]) { super(); }
  override async run<T>(work: () => Promise<T>): Promise<T> {
    this.order.push("gate:enter");
    try {
      return await super.run(work);
    } finally {
      this.order.push("gate:leave");
    }
  }
}

function ebayPort() {
  const calls: string[] = [];
  const port: ListingSettingEbayPort = {
    describeCategories: vi.fn(async () => { calls.push("describe"); return new Map(); }),
    discoverPolicies: vi.fn(async () => {
      calls.push("discover");
      return { marketplaceId: "EBAY_US", merchantLocations: [], fulfillmentPolicies: [],
        returnPolicies: [{ id: "return-new", name: "Thirty days" }], paymentPolicies: [] };
    }),
    loadFulfillmentCapability: vi.fn(async () => { calls.push("capability"); throw new Error("not used"); }),
    listStoreShelves: vi.fn(async () => { calls.push("shelves"); return [{ categoryId: "11", categoryName: "Top", path: "Supplies:Top", level: 2 }]; }),
  };
  return { port, calls };
}

let repository: FakeRepository;
let ebay: ReturnType<typeof ebayPort>;
let log: { info: Mock<(action: string, fields: Record<string, unknown>) => void> };
let gate: RecordingGate;
let ids: string[];
let clock: { now: Mock<() => Date> };
let service: DropshipListingPriceChangesService;
let releaseOutcomes: Map<number, { revisionId: number | null; idempotentReplay?: boolean } | DropshipError>;

const productsReview = (fields: Record<string, unknown> = {}) =>
  ({ kind: "product_prices", productIds: [7], price: PRODUCT_RECIPE, releaseExactPrices: true, ...fields });
const categoryReview = (fields: Record<string, unknown> = {}) => ({
  kind: "category_price", categoryId: CATEGORY, expectedRevisionId: 40, patch: { price: CATEGORY_RECIPE, storeShelf: { mode: "none" } },
  clear: { fields: ["storeShelf", "price"], products: [{ productId: 8, expectedRevisionId: 108 }, { productId: 7, expectedRevisionId: 107 }] },
  ...fields,
});
const applyBody = (reviewHash: string, fields: Record<string, unknown> = {}) => ({ reviewId: REVIEW_ID, reviewHash, idempotencyKey: KEY, ...fields });
const applyHash = (reviewHash: string, reviewId = REVIEW_ID) =>
  listingSettingRequestHash({ operation: "price_change_apply_v1", storeConnectionId: STORE, reviewId, reviewHash });

/** The words of plan 9.7's stop-rule refusal: the text and the review's rows together over the budget. */
const PRICE_CHECK_TOO_HEAVY = "This price check covers too many sizes and too much listing text to apply at once. Choose fewer products.";

async function refusal(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

/** No write after a refusal (the review row, the category, the products, a release, a clean-up). */
function expectNothingWritten(world: World) {
  expect(world.calls).not.toContain("storeReview");
  expect(world.calls).not.toContain("saveCategory");
  expect(world.calls).not.toContain("saveProductsBulk");
  expect(world.calls).not.toContain("clearSizeLeftovers");
  expect(w9.saveListingPriceInTransaction).not.toHaveBeenCalled();
}

/** Category kind's world: products 7 (own price and shelf) and 8 (own shelf) hold values the clear resets. */
function categoryWorld(world: World): void {
  world.productFacts = new Map([[7, facts(107, PRODUCT_RECIPE, ["price", "storeShelf"])], [8, facts(108, null, ["storeShelf"])]]);
  world.categoryFacts = new Map([[CATEGORY, { revisionId: 40, price: null }]]);
}

const review = (body: unknown) => service.reviewForMember(MEMBER, STORE, body);
const apply = (body: unknown) => service.applyForMember(MEMBER, STORE, body);
/** A review stored through the service, then the world's log of calls cleared for the apply. */
async function reviewed(body: unknown): Promise<LoadedPriceChangeReview> {
  const answer = await review(body);
  repository.world.calls.length = 0;
  repository.world.categoryReads = 0;
  repository.order.length = 0;
  log.info.mockClear();
  return repository.world.load(answer.reviewId, VENDOR, STORE)!;
}

beforeEach(() => {
  chosen.spy!.mockClear();
  w9.saveListingPriceInTransaction.mockReset();
  repository = new FakeRepository();
  ebay = ebayPort();
  releaseOutcomes = new Map();
  w9.saveListingPriceInTransaction.mockImplementation(async (_tx: unknown, target: { productVariantId: number }) => {
    repository.world.calls.push(`w9:${target.productVariantId}`);
    const outcome = releaseOutcomes.get(target.productVariantId) ?? { revisionId: target.productVariantId + 1_000 };
    if (outcome instanceof DropshipError) throw outcome;
    return { price: { productVariantId: target.productVariantId, revisionId: outcome.revisionId }, idempotentReplay: outcome.idempotentReplay ?? false };
  });
  log = { info: vi.fn() };
  gate = new RecordingGate(repository.order);
  ids = [REVIEW_ID];
  clock = { now: vi.fn(() => NOW) };
  let tick = 100;
  service = new DropshipListingPriceChangesService({
    repository, ebay: ebay.port, heavyWrites: gate, clock, timer: () => { const value = tick; tick += 42; return value; }, log,
    newId: () => ids.shift() ?? OTHER_ID,
  });
});

describe("priceChangeReviewHash (plan P22, C-money-10, 3.7)", () => {
  const input = { productIds: [7, 8], price: PRODUCT_RECIPE };
  const row = (productVariantId: number, fields: Partial<PriceChangeRow> = {}): PriceChangeRow => ({
    productVariantId, title: "Toploader", sku: null, previousPriceCents: 1_140, priceCents: 1_200, productCostCents: COST, ruleName: "Product price",
    preserved: false, issues: [], settingRevisionId: null, evidenceHash: "e".repeat(64), productId: 7, released: false, refusal: null, ...fields,
  });

  it("hashes the kind with the input and rows as their schemas parse them, rows ascending", () => {
    const rows = [row(101), row(102, { released: true })];
    const hash = priceChangeReviewHash("product_prices", input, rows);
    expect(hash).toBe(pricingHash({ kind: "product_prices", input: storedInputSchemaFor("product_prices").parse(input),
      rows: priceChangeRowsSchema.parse(rows) }));
    // Another kind is another hash, so one kind's review cannot satisfy the other's apply.
    expect(hash).not.toBe(pricingHash({ kind: "category_price", input, rows }));
  });

  it("hashes equal after a jsonb round trip (keys in another order), with rows in another order, and with keys set to undefined", () => {
    const rows = [row(101), row(102, { released: true })];
    const hash = priceChangeReviewHash("product_prices", input, rows);
    expect(priceChangeReviewHash("product_prices", reversedKeys(input), reversedKeys(rows) as unknown[])).toBe(hash);
    expect(priceChangeReviewHash("product_prices", input, [rows[1], rows[0]])).toBe(hash);
    expect(priceChangeReviewHash("product_prices", { ...input, releaseExactPrices: undefined },
      rows.map((entry) => ({ ...entry, warnings: undefined, ruleLevel: undefined })))).toBe(hash);
  });

  it("refuses an input or rows out of their contract as a fault, never hashing a guess", () => {
    for (const [badInput, badRows] of [[{ productIds: [8, 7], price: PRODUCT_RECIPE }, [row(101)]], [input, [row(101), row(101)]],
      [input, [{ ...row(101), refusal: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT" }]]] as const) {
      expect(() => priceChangeReviewHash("product_prices", badInput, badRows as unknown as unknown[])).toThrow(expect.objectContaining({
        code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" }));
    }
  });
});

describe("DropshipListingPriceChangesService.reviewForMember (W7 review, plan 9.5)", () => {
  it("checks, scopes and prices the products kind in the gate's one transaction, and stores the review with its kind and hash", async () => {
    const body = Object.freeze(productsReview({ productIds: Object.freeze([9, 7]) }));

    const answer = await review(body);

    expect(repository.order).toEqual(["gate:enter", `executeReview:${MEMBER}:${STORE}`, "gate:leave"]);
    // No request lock, no lockCatalog, no probe, no writer (the review transaction has none of them).
    expect(repository.world.calls).toEqual([
      "gate", "productSizes", "exposureRules", "selectionRules", "candidates", "overrides", "settingFacts",
      "pricingProfile", "savedPrices", "existingListings", "costs", "pricingPolicies", "textBytes", "storeReview",
    ]);
    expect(chosen.spy).toHaveBeenCalledWith(expect.anything(), [101, 102, 104], NOW, { keepCandidates: "pricing", stopAbove: 10_000 });
    const stored = repository.world.load(REVIEW_ID, VENDOR, STORE)!;
    expect(stored.kind).toBe("product_prices");
    // The stored input: no kind, ids ascending (the body was frozen and is unchanged).
    expect(stored.input).toEqual({ productIds: [7, 9], price: PRODUCT_RECIPE, releaseExactPrices: true });
    expect(body.productIds).toEqual([9, 7]);
    expect(stored.reviewHash).toBe(priceChangeReviewHash("product_prices", stored.input, stored.rows));
    expect(stored.createdAt).toEqual(NOW);
    expect(stored.rows.map((row) => [row.productVariantId, row.productId, row.previousPriceCents, row.priceCents, row.released, row.refusal]))
      .toEqual([
        [101, 7, priceOf(STORE_DEFAULT, COST), priceOf(PRODUCT_RECIPE, COST), false, null],
        // 102's typed price is released, so it follows the products' new price (as `inherit`).
        [102, 7, 1_499, priceOf(PRODUCT_RECIPE, COST), true, null],
        [104, 9, priceOf(STORE_DEFAULT, COST), priceOf(PRODUCT_RECIPE, COST), false, null],
      ]);
    expect(stored.rows[0]).toMatchObject({ preserved: false, ruleLevel: "product", settingRevisionId: null, basis: "product_cost",
      basisCents: COST, productCostCents: COST, title: "Toploader", sizeName: "Size 101" });
    expect(stored.rows[1]).toMatchObject({ followsStorePricing: true, settingRevisionId: 502, preserved: false });
    expect(answer).toEqual(projectPriceChangeReview(stored, 0));
    expect(priceChangeReviewResponseSchema.safeParse(answer).success).toBe(true);
    expect(answer.summary).toEqual({ total: 3, changed: 3, released: 1, refused: 0 });
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.price_change_reviewed", expect.objectContaining({
      outcome: "reviewed", vendor_id: VENDOR, store_connection_id: STORE, actor_id: MEMBER, request_key: null, review_id: REVIEW_ID,
      kind: "product_prices", row_count: 3, release_count: 1, refused_count: 0, size_count: 3, changed_count: 3, text_bytes: 0,
      review_rows_bytes: repository.world.reviews.get(REVIEW_ID)!.rowsBytes, elapsed_ms: 42 }));
    expect(log.info.mock.calls[0][1]).not.toHaveProperty("category_id");
  });

  it("keeps a typed price the products kind does not release, and stores a size that would lose its price with its refusal", async () => {
    // 103 has no retail price, so a retail-based product price gives it none: its usable price today would be lost.
    repository.world.candidates.set(103, candidate(103, 8, { defaultRetailPriceCents: null }));
    const retail = { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" } as const;

    const answer = await review(productsReview({ productIds: [7, 8], price: retail, releaseExactPrices: undefined }));

    const stored = repository.world.load(answer.reviewId, VENDOR, STORE)!;
    expect(stored.rows.map((row) => [row.productVariantId, row.priceCents, row.preserved, row.released, row.refusal])).toEqual([
      [101, RETAIL, false, false, null], [102, 1_499, true, false, null], [103, null, false, false, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST"]]);
    expect(stored.rows[1]).toMatchObject({ ruleName: "Fixed override preserved", issues: [], basis: null });
    expect(stored.rows[2].issues).toContain("vendor_retail_price_required");
    // Refused at apply, not here (plan 9.12 #5).
    expect(answer.summary).toEqual({ total: 3, changed: 2, released: 0, refused: 1 });
  });

  it("allows a check with no chosen size: zero rows, nothing priced (P35)", async () => {
    repository.world.notChosen = new Set([101, 102, 104]);
    const answer = await review(productsReview({ productIds: [7, 9] }));
    expect(answer.rows).toEqual([]);
    expect(answer.summary).toEqual({ total: 0, changed: 0, released: 0, refused: 0 });
    expect(repository.world.calls).not.toContain("pricingProfile");
    expect(repository.world.calls).toContain("storeReview");
  });

  it("refuses more than 10,000 chosen sizes with 422 as soon as the 10,001st is found, before any price read or the review row", async () => {
    // 10,600 chosen sizes: the 10,001st is in the 41st batch of 250, so the 42nd and 43rd are never read.
    const many = Array.from({ length: 10_600 }, (_, index) => 200_000 + index);
    repository.world.sizesByProduct.set(7, many);
    for (const id of many) repository.world.candidates.set(id, candidate(id, 7));

    const error = await refusal(review(productsReview()));

    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE",
      message: "This price check covers more than 10,000 sizes. Choose fewer products.",
      context: { storeConnectionId: STORE, classification: "permanent" } });
    // The check stopped early, so it names no count it does not know.
    expect(error.context).not.toHaveProperty("sizeCount");
    expect(repository.world.calls.filter((call) => call === "candidates")).toHaveLength(41);
    const kept = await chosen.spy!.mock.results[0].value as unknown[];
    expect(kept).toHaveLength(10_001);
    expect(repository.world.calls).not.toContain("pricingProfile");
    expectNothingWritten(repository.world);
  });

  it("allows exactly 10,000 chosen sizes; a size in scope that is not chosen does not count", async () => {
    const many = Array.from({ length: 10_001 }, (_, index) => 200_000 + index);
    repository.world.sizesByProduct.set(7, many);
    for (const id of many) repository.world.candidates.set(id, candidate(id, 7));
    repository.world.notChosen = new Set([200_000]);

    const answer = await review(productsReview({ price: undefined }));

    expect(answer.summary.total).toBe(10_000);
    expect(repository.world.calls).toContain("storeReview");
  });

  it("refuses more than 200 releases with 422 naming the count and the bound, before the text budget and the review row", async () => {
    const many = Array.from({ length: 201 }, (_, index) => 300_000 + index);
    repository.world.sizesByProduct.set(7, many);
    for (const id of many) {
      repository.world.candidates.set(id, candidate(id, 7));
      repository.world.costs.set(id, cost(COST));
    }
    repository.world.saved = many.map((id) => typedPrice(id, id + 1, 1_499));

    const error = await refusal(review(productsReview()));

    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT", context: { releaseCount: 201, maxReleases: 200 } });
    expect(repository.world.calls).not.toContain("textBytes");
    expectNothingWritten(repository.world);
    // 200 is allowed.
    repository.world.saved = repository.world.saved.slice(1);
    await expect(review(productsReview())).resolves.toMatchObject({ summary: { released: 200 } });
  });

  it("refuses a check whose products' stored text passes the budget, before the review row (v3r, C-feas-3)", async () => {
    repository.world.textBytes = { storeBytes: 0, keptStoreBytes: 0, targetBytes: MAX_BULK_TEXT_BYTES + 1 };
    const error = await refusal(review(productsReview()));
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", context: { textBytes: MAX_BULK_TEXT_BYTES + 1, productCount: 1 } });
    // The text alone: 9d's words and no reason (the rows are not built yet).
    expect(error.message).toBe(listingSettingBulkTooLarge(STORE, 1, 1, 1).message);
    expect(error.context).not.toHaveProperty("reason");
    expectNothingWritten(repository.world);
    // A release-only check names no product for the bulk call: it reads no text.
    repository.world.calls.length = 0;
    await review(productsReview({ price: undefined }));
    expect(repository.world.calls).not.toContain("textBytes");
  });

  it("counts the review's stored rows toward the budget beside the text (plan 9.7's stop rule): over it, the check is refused", async () => {
    repository.world.textBytes = { ...NO_TEXT, targetBytes: MAX_BULK_TEXT_BYTES - 500 };
    repository.world.rowsBytes = 501;
    const error = await refusal(review(productsReview()));
    // `textBytes` is the text and the rows together, which `reason` says, with words that do not blame the text alone.
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", message: PRICE_CHECK_TOO_HEAVY,
      context: { reason: "price_check_rows", textBytes: MAX_BULK_TEXT_BYTES + 1, maxTextBytes: MAX_BULK_TEXT_BYTES, productCount: 1,
        classification: "permanent" } });
    // Refused right after its insert, inside its transaction: the wrapper's rollback takes the row with it.
    expect(repository.world.calls.slice(-2)).toEqual(["textBytes", "storeReview"]);
    expect(log.info).not.toHaveBeenCalled();
    // At the budget exactly, it is stored.
    repository.world.rowsBytes = 500;
    await expect(review(productsReview())).resolves.toMatchObject({ summary: { total: 2 } });
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.price_change_reviewed", expect.objectContaining({
      text_bytes: MAX_BULK_TEXT_BYTES - 500, review_rows_bytes: 500 }));
  });

  it("checks the category kind: D16, then the category, its revision, the clear set, and prices the category's sizes", async () => {
    categoryWorld(repository.world);

    const answer = await review(categoryReview());

    expect(repository.world.calls).toEqual([
      "gate", "groups", "categoryNames", "categoryRow", "categoryProducts", "productSizes",
      "exposureRules", "selectionRules", "candidates", "overrides", "settingFacts", "leftovers",
      "pricingProfile", "savedPrices", "existingListings", "costs", "pricingPolicies", "textBytes", "storeReview",
    ]);
    const stored = repository.world.load(answer.reviewId, VENDOR, STORE)!;
    // Fields in the stored order, products ascending, the category's values as stored.
    expect(stored.input).toEqual({ categoryId: CATEGORY, expectedRevisionId: 40, patch: { price: CATEGORY_RECIPE, storeShelf: { mode: "none" } },
      clear: { fields: ["price", "storeShelf"], products: [{ productId: 7, expectedRevisionId: 107 }, { productId: 8, expectedRevisionId: 108 }] } });
    // 101: product 7's own price is cleared, so the category's applies; 102 keeps its typed price.
    expect(stored.rows.map((row) => [row.productVariantId, row.previousPriceCents, row.priceCents, row.preserved])).toEqual([
      [101, priceOf(PRODUCT_RECIPE, COST), priceOf(CATEGORY_RECIPE, COST), false], [102, 1_499, 1_499, true],
      [103, priceOf(STORE_DEFAULT, COST), priceOf(CATEGORY_RECIPE, COST), false], [104, priceOf(STORE_DEFAULT, COST), priceOf(CATEGORY_RECIPE, COST), false]]);
    expect(stored.rows[0]).toMatchObject({ ruleLevel: "category" });
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.price_change_reviewed", expect.objectContaining({
      kind: "category_price", category_id: CATEGORY, row_count: 4 }));
  });

  it.each([
    ["older group rules (D16)", (world: World) => { world.groups = { pricingGroups: 1, contentGroups: 0, ebayCategoryRules: 2 }; },
      "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT", 409, ["gate", "groups"]],
    ["a category Card Shellz does not have", (world: World) => { world.categoryNames = new Map(); },
      "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", 404, ["gate", "groups", "categoryNames"]],
    ["a stale category revision", (world: World) => { world.categoryRevisionId = 41; },
      "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", 409, ["gate", "groups", "categoryNames", "categoryRow"]],
  ])("refuses %s before the scope, writing nothing", async (_label, arrange, code, _status, calls) => {
    categoryWorld(repository.world);
    arrange(repository.world);
    const error = await refusal(review(categoryReview()));
    expect(error.code).toBe(code);
    expect(repository.world.calls).toEqual(calls);
    expectNothingWritten(repository.world);
  });

  it("refuses a clear list that is not the derived set (W12's rule), naming the products, before any price read", async () => {
    categoryWorld(repository.world);
    // Size 104 holds its own shelf, so product 9 belongs in the set too.
    repository.world.leftovers = new Map([[104, ["storeShelf"]]]);
    const error = await refusal(review(categoryReview()));
    expect(error).toMatchObject({ code: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT",
      context: { categoryId: CATEGORY, conflicts: [{ productId: 9 }], conflictCount: 1 } });
    expect(error.message).toContain("can take up to 60 seconds to show");
    expect(repository.world.calls).not.toContain("pricingProfile");
    expectNothingWritten(repository.world);
  });

  it("refuses a clear list with a product at another revision than the vendor was shown, naming it, before any price read", async () => {
    categoryWorld(repository.world);
    repository.world.productFacts.set(8, facts(118, null, ["storeShelf"]));
    const error = await refusal(review(categoryReview()));
    expect(error).toMatchObject({ code: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT",
      context: { categoryId: CATEGORY, conflicts: [{ productId: 8, expectedRevisionId: 108, actualRevisionId: 118 }], conflictCount: 1 } });
    expect(repository.world.calls).not.toContain("pricingProfile");
    expectNothingWritten(repository.world);
  });

  it("refuses a new eBay id on a store that needs a sign-in with 403 before any eBay call or the review transaction", async () => {
    repository.pre.context = { ...storeContext, storeStatus: "needs_reauth" };
    const error = await refusal(review(categoryReview({ patch: { price: CATEGORY_RECIPE, returnPolicy: { id: "return-new" } }, clear: undefined })));
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", context: { fields: ["returnPolicy"] } });
    expect(repository.order).toEqual(["preflight:null"]);
    expect(repository.pre.calls).toEqual(["gate", "category", "listingConfig"]);
    expect(ebay.calls).toEqual([]);
  });

  it("stores a known eBay id's saved value with no eBay call, a new one with eBay's, and asks eBay outside the gate", async () => {
    repository.pre.context = { ...storeContext, storeStatus: "needs_reauth" };
    const known = await review(categoryReview({ patch: { price: CATEGORY_RECIPE, shippingPolicy: { id: "ship-a" } }, clear: undefined }));
    expect(ebay.calls).toEqual([]);
    expect(repository.world.load(known.reviewId, VENDOR, STORE)!.input).toMatchObject({
      patch: { price: CATEGORY_RECIPE, shippingPolicy: { id: "ship-a", name: "Ships in a day" } } });

    repository.pre.context = storeContext;
    repository.order.length = 0;
    const fresh = await review(categoryReview({ patch: { price: CATEGORY_RECIPE, returnPolicy: { id: "return-new" } }, clear: undefined }));
    expect(ebay.calls).toEqual(["discover"]);
    expect(repository.order).toEqual(["preflight:null", "gate:enter", `executeReview:${MEMBER}:${STORE}`, "gate:leave"]);
    expect(repository.world.load(fresh.reviewId, VENDOR, STORE)!.input).toMatchObject({
      patch: { price: CATEGORY_RECIPE, returnPolicy: { id: "return-new", name: "Thirty days" } } });
    expect(log.info).toHaveBeenLastCalledWith("dropship.listing_settings.price_change_reviewed", expect.objectContaining({ ebay_ms: 42 }));
  });

  it.each([
    ["no price or release", { kind: "product_prices", productIds: [7] }],
    ["10,001 products", productsReview({ productIds: Array.from({ length: 10_001 }, (_, index) => index + 1) })],
    ["a product twice", productsReview({ productIds: [7, 7] })],
    ["a category change without a price", categoryReview({ patch: { storeShelf: { mode: "none" } } })],
    ["another field on the products kind", productsReview({ storeShelf: { mode: "none" } })],
  ])("answers %s with 400 before any port", async (_label, body) => {
    const error = await refusal(review(body));
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVALID_INPUT");
    expect(repository.order).toEqual([]);
  });

  it("refuses a review id that is not the lowercase uuid the apply takes back as a fault", async () => {
    ids = ["6F1B1D7E-6D0E-4D43-9A43-2F9D3C0B7C11"];
    await expect(review(productsReview())).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
    expect(repository.order).toEqual([]);
  });
});

describe("DropshipListingPriceChangesService.reviewPageForMember (W7 review page, plan 9.6)", () => {
  it("answers a page from the member's stored review with one owner-scoped read: no gate, no transaction", async () => {
    const many = Array.from({ length: 60 }, (_, index) => 400_000 + index);
    repository.world.sizesByProduct.set(7, many);
    for (const id of many) {
      repository.world.candidates.set(id, candidate(id, 7));
      repository.world.costs.set(id, cost(COST));
    }
    await review(productsReview({ releaseExactPrices: undefined }));
    repository.order.length = 0;

    const page = await service.reviewPageForMember(MEMBER, STORE, REVIEW_ID, 1);

    expect(repository.order).toEqual(["readPage"]);
    expect(repository.pages).toEqual([{ memberId: MEMBER, storeConnectionId: STORE, reviewId: REVIEW_ID }]);
    expect(page.rows.map((row) => row.productVariantId)).toEqual(many.slice(50));
    expect(page).toMatchObject({ page: 1, summary: { total: 60 }, kind: "product_prices" });
    expect(priceChangeReviewResponseSchema.safeParse(page).success).toBe(true);
    // A page past the last is empty.
    await expect(service.reviewPageForMember(MEMBER, STORE, REVIEW_ID, 2)).resolves.toMatchObject({ rows: [], page: 2 });
  });

  it("answers another member's, a missing and another store's review with 404, and a bad id or page with 400", async () => {
    await review(productsReview());
    for (const [member, store, id] of [["member-2", STORE, REVIEW_ID], [MEMBER, STORE, OTHER_ID], [MEMBER, 24, REVIEW_ID]] as const) {
      await expect(service.reviewPageForMember(member, store, id, 0)).rejects.toMatchObject({ code: "DROPSHIP_PRICING_REVIEW_NOT_FOUND" });
    }
    for (const [id, page] of [[REVIEW_ID.toUpperCase(), 0], [REVIEW_ID, 201], [REVIEW_ID, Number.NaN], ["not-a-uuid", 0]] as const) {
      await expect(service.reviewPageForMember(MEMBER, STORE, id, page)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT" });
    }
  });
});

describe("DropshipListingPriceChangesService.applyForMember (W7 apply, plan 9.7)", () => {
  it("runs a products apply in order: gate, probe, by-review, review, revisions, lockCatalog, recompute, budget, products, releases", async () => {
    const stored = await reviewed(productsReview({ productIds: [7, 9] }));
    repository.world.productFacts = new Map([[9, facts(109, null, ["storeShelf"])]]);
    clock.now.mockReturnValue(LATER);
    const body = Object.freeze(applyBody(stored.reviewHash));

    const result = await apply(body);

    expect(result).toEqual({ outcome: "changed", reviewId: REVIEW_ID, requestId: 900, changedProductCount: 2, releasedSizeCount: 1,
      categoryRevisionId: null });
    expect(repository.order).toEqual(["gate:enter", `execute:${KEY}`, "gate:leave"]);
    expect(repository.world.calls).toEqual([
      "gate", "probe", "byReview", "loadReview", "settingFacts", "lockCatalog",
      "productSizes", "exposureRules", "selectionRules", "candidates", "overrides", "settingFacts",
      "pricingProfile", "savedPrices", "existingListings", "costs", "pricingPolicies",
      "textBytes", "saveProductsBulk", "sizePrice:102", "w9:102",
    ]);
    expect(repository.world.locked).toEqual({ productIds: [7, 9], productVariantIds: [102] });
    const requestHash = applyHash(stored.reviewHash);
    // Every product in scope at its current revision; the ledger row names the review.
    expect(repository.world.bulkInputs).toEqual([{ operation: "price_change_apply", reviewId: REVIEW_ID,
      products: [{ productId: 7, expectedRevisionId: null }, { productId: 9, expectedRevisionId: 109 }], patch: { price: PRODUCT_RECIPE },
      requestHash, now: LATER }]);
    // The release through W9, after the product rows, at the revision the review showed, under the size child key.
    expect(w9.saveListingPriceInTransaction.mock.calls.map((call) => call.slice(1))).toEqual([[
      { storeConnectionId: STORE, productVariantId: 102 },
      { priceCents: null, pricingMode: "inherit", expectedRevisionId: 502, idempotencyKey: listingSettingChildKey(KEY, "size", 102) },
      requestHash, LATER]]);
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.price_change_applied", {
      outcome: "changed", vendor_id: VENDOR, store_connection_id: STORE, actor_id: MEMBER, request_key: KEY,
      before: [{ product_id: 7, revision_id: null }, { product_id: 9, revision_id: 109 }, { product_variant_id: 102, revision_id: 502 }],
      after: [{ product_id: 7, revision_id: 5_007 }, { product_id: 9, revision_id: 5_009 }, { product_variant_id: 102, revision_id: 1_102 }],
      changed_count: 3, size_count: 1, elapsed_ms: 42, review_id: REVIEW_ID, kind: "product_prices", request_id: 900,
      changed_product_count: 2, released_size_count: 1, cleared_size_count: 0, text_bytes: 0, review_rows_bytes: stored.rowsBytes });
    expect(body.reviewId).toBe(REVIEW_ID);
  });

  it("applies a release-only check with no product and no patch, still writing the ledger row (P23, C-money-4)", async () => {
    const stored = await reviewed(productsReview({ price: undefined }));
    const result = await apply(applyBody(stored.reviewHash));
    expect(repository.world.bulkInputs).toEqual([expect.objectContaining({ operation: "price_change_apply", reviewId: REVIEW_ID,
      products: [], patch: {} })]);
    expect(repository.world.calls).not.toContain("textBytes");
    // No revisions read: no product is written.
    expect(repository.world.calls.filter((call) => call === "settingFacts")).toHaveLength(1);
    expect(result).toMatchObject({ outcome: "changed", changedProductCount: 0, releasedSizeCount: 1 });
  });

  it("applies a category check: D16, the clear set again under the feature locks, then the category, the products and the clean-ups", async () => {
    categoryWorld(repository.world);
    const stored = await reviewed(categoryReview());

    const result = await apply(applyBody(stored.reviewHash));

    expect(result).toEqual({ outcome: "changed", reviewId: REVIEW_ID, requestId: 900, changedProductCount: 2, releasedSizeCount: 0,
      categoryRevisionId: 41 });
    expect(repository.world.calls).toEqual([
      "gate", "probe", "byReview", "loadReview", "groups", "categoryProducts", "lockCatalog",
      "categoryProducts", "productSizes", "exposureRules", "selectionRules", "candidates", "overrides", "settingFacts",
      "pricingProfile", "savedPrices", "existingListings", "costs", "pricingPolicies",
      "leftovers", "textBytes", "saveCategory", "saveProductsBulk", "clearSizeLeftovers",
    ]);
    expect(repository.world.locked).toEqual({ categoryIds: [CATEGORY], productIds: [7, 8, 9], productVariantIds: [] });
    const requestHash = applyHash(stored.reviewHash);
    expect(repository.world.categoryInputs).toEqual([{ categoryId: CATEGORY, expectedRevisionId: 40,
      patch: { price: CATEGORY_RECIPE, storeShelf: { mode: "none" } }, requestHash, now: NOW }]);
    expect(repository.world.bulkInputs).toEqual([{ operation: "price_change_apply", reviewId: REVIEW_ID,
      products: [{ productId: 7, expectedRevisionId: 107 }, { productId: 8, expectedRevisionId: 108 }],
      patch: { price: null, storeShelf: null }, requestHash, now: NOW }]);
    expect(repository.world.leftoverInputs).toEqual([{ productIds: [7, 8], fields: ["storeShelf"], requestHash, now: NOW }]);
    expect(w9.saveListingPriceInTransaction).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.price_change_applied", expect.objectContaining({
      kind: "category_price", category_id: CATEGORY, changed_count: 3, cleared_size_count: 2,
      before: [{ category_id: CATEGORY, revision_id: 40 }, { product_id: 7, revision_id: 107 }, { product_id: 8, revision_id: 108 }] }));
  });

  it("answers a replay from what the key wrote, calling no writer and computing nothing (P16)", async () => {
    const stored = await reviewed(productsReview());
    repository.world.use = { productRevision: null, categoryRevision: null,
      ledger: { requestId: 777, operation: "price_change_apply", storeConnectionId: STORE, requestHash: applyHash(stored.reviewHash) },
      children: [{ kind: "size", revisionId: 1_102, productVariantId: 102, storeConnectionId: STORE, requestHash: applyHash(stored.reviewHash) }] };

    const result = await apply(applyBody(stored.reviewHash));

    expect(result).toEqual({ outcome: "replayed", reviewId: REVIEW_ID, requestId: 777, changedProductCount: null, releasedSizeCount: 1,
      categoryRevisionId: null });
    expect(repository.world.calls).toEqual(["gate", "probe", "loadReview"]);
    expectNothingWritten(repository.world);
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.price_change_applied", expect.objectContaining({
      outcome: "replayed", changed_count: 0, cleared_size_count: null, changed_product_count: null,
      after: [{ product_variant_id: 102, revision_id: 1_102 }] }));
  });

  it("matches a category apply's revision to the review's category on a replay, and answers the revision the first answer named", async () => {
    categoryWorld(repository.world);
    const stored = await reviewed(categoryReview());
    const requestHash = applyHash(stored.reviewHash);
    const ledger = { requestId: 777, operation: "price_change_apply" as const, storeConnectionId: STORE, requestHash };
    repository.world.use = { productRevision: null, ledger, children: [],
      categoryRevision: { revisionId: 41, categoryId: CATEGORY, storeConnectionId: STORE, requestHash } };
    await expect(apply(applyBody(stored.reviewHash))).resolves.toMatchObject({ outcome: "replayed", categoryRevisionId: 41 });
    // The category was unchanged: no revision under the key; 8a answered after its compare-and-set (W12's rule).
    repository.world.use = { productRevision: null, ledger, children: [], categoryRevision: null };
    await expect(apply(applyBody(stored.reviewHash))).resolves.toMatchObject({ outcome: "replayed", categoryRevisionId: 40 });
    // Another category's revision under the key is a reuse.
    repository.world.use = { productRevision: null, ledger, children: [],
      categoryRevision: { revisionId: 51, categoryId: 4, storeConnectionId: STORE, requestHash } };
    await expect(apply(applyBody(stored.reviewHash))).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT",
      context: { mismatched: ["categoryRevision.categoryId"] } });
    expectNothingWritten(repository.world);
  });

  it("answers a key used for another change as a conflict and a partly recorded one as fatal, writing nothing", async () => {
    const stored = await reviewed(productsReview());
    repository.world.use = { ...NOTHING, ledger: { requestId: 5, operation: "product_settings_bulk", storeConnectionId: STORE,
      requestHash: applyHash(stored.reviewHash) } };
    await expect(apply(applyBody(stored.reviewHash))).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT",
      context: { mismatched: ["ledger.operation"] } });
    repository.world.use = { ...NOTHING, children: [{ kind: "size", revisionId: 1, productVariantId: 102, storeConnectionId: STORE,
      requestHash: applyHash(stored.reviewHash) }] };
    await expect(apply(applyBody(stored.reviewHash))).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE" });
    expectNothingWritten(repository.world);
  });

  it("refuses a review applied under another key with 409, before reading the review or locking anything (W1's rule)", async () => {
    const stored = await reviewed(productsReview());
    repository.world.applies.set(REVIEW_ID, { vendorId: VENDOR, storeConnectionId: STORE, requestId: 600, idempotencyKey: "price-changes:other-key" });
    const error = await refusal(apply(applyBody(stored.reviewHash)));
    expect(error).toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT", context: { storeConnectionId: STORE, reviewId: REVIEW_ID } });
    expect(repository.world.calls).toEqual(["gate", "probe", "byReview"]);
    expectNothingWritten(repository.world);
  });

  it("answers another vendor's applied review with 404, not 409: the by-review read is scoped to the vendor and store (v3r, C-money-4)", async () => {
    await reviewed(productsReview());
    repository.world.reviews.set(OTHER_ID, { ...repository.world.reviews.get(REVIEW_ID)!, vendorId: 11, storeConnectionId: 23 });
    repository.world.applies.set(OTHER_ID, { vendorId: 11, storeConnectionId: 23, requestId: 601, idempotencyKey: "price-changes:vendor-11" });
    const error = await refusal(apply(applyBody("a".repeat(64), { reviewId: OTHER_ID })));
    expect(error.code).toBe("DROPSHIP_PRICING_REVIEW_NOT_FOUND");
    expect(repository.world.calls).toEqual(["gate", "probe", "byReview", "loadReview"]);
  });

  it("answers an unknown review, W1's store default review and another store's review with 404", async () => {
    await reviewed(productsReview());
    const raw = repository.world.reviews.get(REVIEW_ID)!;
    for (const [id, entry] of [[OTHER_ID, null], [OTHER_ID, { ...raw, kind: "store_default" }], [OTHER_ID, { ...raw, storeConnectionId: 24 }]] as const) {
      if (entry) repository.world.reviews.set(id, entry);
      await expect(apply(applyBody("a".repeat(64), { reviewId: id }))).rejects.toMatchObject({ code: "DROPSHIP_PRICING_REVIEW_NOT_FOUND",
        context: { reviewId: id } });
    }
    expectNothingWritten(repository.world);
  });

  it("answers a hash that is not the review's with PRICES_MOVED before any lock (P15)", async () => {
    await reviewed(productsReview());
    const error = await refusal(apply(applyBody("a".repeat(64))));
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_PRICES_MOVED", context: { sizes: [], sizeCount: 0 } });
    expect(repository.world.calls).toEqual(["gate", "probe", "byReview", "loadReview"]);
  });

  it("answers a size whose price moved since the review with PRICES_MOVED naming it, writing nothing", async () => {
    const stored = await reviewed(productsReview());
    // 101's .ops cost moved: its rule price differs now.
    repository.world.costs.set(101, cost(900));
    const error = await refusal(apply(applyBody(stored.reviewHash)));
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_PRICES_MOVED", context: { sizeCount: 1,
      sizes: [{ productVariantId: 101, expectedPriceCents: priceOf(PRODUCT_RECIPE, COST), priceCents: priceOf(PRODUCT_RECIPE, 900) }] } });
    expectNothingWritten(repository.world);
    // A size that left the scope, and one that joined it, are named too.
    repository.world.costs.set(101, cost(COST));
    repository.world.notChosen = new Set([101]);
    repository.world.sizesByProduct.set(7, [101, 102, 105]);
    repository.world.candidates.set(105, candidate(105, 7));
    repository.world.costs.set(105, cost(COST));
    const moved = await refusal(apply(applyBody(stored.reviewHash)));
    expect(moved.context).toMatchObject({ sizeCount: 2, sizes: [{ productVariantId: 101, expectedPriceCents: priceOf(PRODUCT_RECIPE, COST) },
      { productVariantId: 105, priceCents: priceOf(PRODUCT_RECIPE, COST) }] });
    expectNothingWritten(repository.world);
  });

  it("refuses a review with a size that would lose its price with 422 naming it, before the budget or any write", async () => {
    repository.world.candidates.set(103, candidate(103, 8, { defaultRetailPriceCents: null }));
    const stored = await reviewed(productsReview({ productIds: [8], price: { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" },
      releaseExactPrices: undefined }));
    const error = await refusal(apply(applyBody(stored.reviewHash)));
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", context: { sizeCount: 1,
      sizes: [{ productVariantId: 103, beforePriceCents: priceOf(STORE_DEFAULT, COST), afterPriceCents: null,
        refusal: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", blockers: ["pricing_basis_unavailable", "vendor_retail_price_required"] }] } });
    expect(repository.world.calls).not.toContain("textBytes");
    expectNothingWritten(repository.world);
  });

  it("refuses a category apply when a leftover added since the review changes the derived set, before any write (v3r, C-money-6)", async () => {
    categoryWorld(repository.world);
    const stored = await reviewed(categoryReview());
    repository.world.leftovers = new Map([[104, ["storeShelf"]]]);
    const error = await refusal(apply(applyBody(stored.reviewHash)));
    expect(error).toMatchObject({ code: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", context: { conflicts: [{ productId: 9 }] } });
    expect(repository.world.calls.slice(-1)).toEqual(["leftovers"]);
    expectNothingWritten(repository.world);
  });

  it.each([
    ["a cleared product saved again since the review", (world: World) => { world.productFacts.set(7, facts(170, PRODUCT_RECIPE, ["price", "storeShelf"])); },
      "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflicts: [{ productId: 7, expectedRevisionId: 107, actualRevisionId: 170 }] }],
    ["the category saved again since the review", (world: World) => { world.categoryFacts.set(CATEGORY, { revisionId: 44, price: null }); },
      "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", { conflicts: [{ categoryId: CATEGORY, expectedRevisionId: 40, actualRevisionId: 44 }] }],
  ])("refuses a category apply with %s before any write, not by the writer's compare-and-set after the category row", async (_label, arrange,
    code, context) => {
    categoryWorld(repository.world);
    const stored = await reviewed(categoryReview());
    arrange(repository.world);
    const error = await refusal(apply(applyBody(stored.reviewHash)));
    expect(error).toMatchObject({ code, context });
    expectNothingWritten(repository.world);
  });

  it("refuses a category apply when the category's products moved under the lock (a product with no chosen size), before the leftovers", async () => {
    categoryWorld(repository.world);
    const stored = await reviewed(categoryReview());
    // Product 10 joins the category between the unlocked read and the recompute; it has no sellable size, so the rows hold.
    repository.world.categoryProducts = [[7, 8, 9], [7, 8, 9, 10]];
    const error = await refusal(apply(applyBody(stored.reviewHash)));
    expect(error).toMatchObject({ code: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", context: { conflicts: [{ productId: 10 }] } });
    expect(repository.world.calls).not.toContain("leftovers");
    expectNothingWritten(repository.world);
  });

  it.each([
    ["older group rules added since the review (D16)", (world: World) => { world.groups = { pricingGroups: 0, contentGroups: 1, ebayCategoryRules: 0 }; },
      "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT"],
    ["stored text past the budget", (world: World) => { world.textBytes = { ...NO_TEXT, targetBytes: MAX_BULK_TEXT_BYTES + 1 }; },
      "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE"],
  ])("refuses %s before any write", async (_label, arrange, code) => {
    categoryWorld(repository.world);
    const stored = await reviewed(categoryReview());
    arrange(repository.world);
    await expect(apply(applyBody(stored.reviewHash))).rejects.toMatchObject({ code });
    expectNothingWritten(repository.world);
  });

  it("refuses a loaded review with no stored size as a fault, never letting it pass the budget", async () => {
    const stored = await reviewed(productsReview());
    repository.world.reviews.get(REVIEW_ID)!.rowsBytes = undefined as unknown as number;
    await expect(apply(applyBody(stored.reviewHash))).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
    expectNothingWritten(repository.world);
  });

  it("counts the review's stored rows toward the budget at apply, as its review did, before any write (plan 9.7's stop rule)", async () => {
    repository.world.rowsBytes = 400;
    const stored = await reviewed(productsReview());
    repository.world.textBytes = { ...NO_TEXT, targetBytes: MAX_BULK_TEXT_BYTES - 399 };
    const error = await refusal(apply(applyBody(stored.reviewHash)));
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", message: PRICE_CHECK_TOO_HEAVY,
      context: { reason: "price_check_rows", textBytes: MAX_BULK_TEXT_BYTES + 1, maxTextBytes: MAX_BULK_TEXT_BYTES, productCount: 1 } });
    expectNothingWritten(repository.world);
    // A release-only apply names no product and reads no text: its rows alone are far under the budget.
    repository.world.calls.length = 0;
    ids = ["0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e"];
    const releaseOnly = await reviewed(productsReview({ price: undefined }));
    await expect(apply(applyBody(releaseOnly.reviewHash, { reviewId: releaseOnly.id, idempotencyKey: `${KEY}-release` })))
      .resolves.toMatchObject({ outcome: "changed", releasedSizeCount: 1 });
  });

  it("refuses a W9 replay inside a new apply as a fault, and stops on a W9 refusal naming the size", async () => {
    const stored = await reviewed(productsReview());
    releaseOutcomes.set(102, { revisionId: 1_102, idempotentReplay: true });
    await expect(apply(applyBody(stored.reviewHash))).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      context: { productVariantId: 102 } });
    repository.world.applies.clear();
    releaseOutcomes.set(102, new DropshipError("DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", "This listing would be left without a usable price."));
    await expect(apply(applyBody(stored.reviewHash))).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST",
      context: { storeConnectionId: STORE, productVariantId: 102, classification: "permanent" } });
  });

  it("answers the gate's refusal with BUSY before its transaction", async () => {
    const stored = await reviewed(productsReview());
    let release!: () => void;
    const held = gate.run(() => new Promise<void>((done) => { release = done; }));
    try {
      await expect(apply(applyBody(stored.reviewHash))).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY",
        context: { reason: "heavy_write_in_progress", retryAfterSeconds: 5 } });
      await expect(review(productsReview())).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY" });
      expect(repository.order.filter((entry) => entry.startsWith("execute"))).toEqual([]);
    } finally {
      release();
      await held;
    }
  });

  it.each([
    ["a 7-character key", { idempotencyKey: "abcdefg" }],
    ["an uppercase review id", { reviewId: REVIEW_ID.toUpperCase() }],
    ["a short hash", { reviewHash: "a".repeat(63) }],
    ["an unknown key", { extra: true }],
  ])("answers %s with 400 before any port", async (_label, fields) => {
    await expect(apply(applyBody("a".repeat(64), fields))).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT" });
    expect(repository.order).toEqual([]);
  });
});
