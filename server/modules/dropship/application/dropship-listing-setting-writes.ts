import type { SaveListingContentInput } from "../../../../shared/dropship/listing-content";
import type {
  CategoryListingSettingField,
  CategoryListingSettingPatch,
  CategoryListingSettingRow,
  ListingSettingActorType,
  ProductCategoryMark,
  ProductListingSettingBulkPatch,
  ProductListingSettingField,
  ProductListingSettingPatch,
  ProductListingSettingRow,
} from "../../../../shared/dropship/listing-setting-values";
import type { PricingProfileState } from "../../../../shared/dropship/pricing-rules";
import type { RequestKeyUse } from "../domain/listing-setting-request-key-use";
import type { ListingSettingLeftoverField } from "../domain/listing-setting-values";
import type { SaveEbayCategoryRulesProfileInput } from "./dropship-ebay-category-rules-service";
import type { ListingPriceCatalogReader, ListingPriceTransaction } from "./dropship-listing-price-service";
import type { DropshipListingPreviewRepository } from "./dropship-listing-preview-service";
import type { DropshipProductCost } from "./dropship-product-cost";
import type { SelectedCatalogReader } from "./dropship-selected-catalog";

/**
 * The write port for product and category listing settings (plan PR 8a,
 * section 3.7). PR 8 builds the repository behind it; PR 9's services (W5,
 * W6, W7, W8, W12, W13) are its only callers. Types only.
 */

export type { RequestKeyUse };

export type ListingSettingActor = { actorType: ListingSettingActorType; actorId: string };
/** `unchanged`: the change sets what is already stored, so nothing is written (plan D12). `replayed`: the request key already wrote it. */
export type ListingSettingSaveOutcome = "changed" | "unchanged" | "replayed";

/** One product (W5). The request key is the transaction's own key. */
export interface ProductListingSettingSaveInput {
  productId: number;
  /** The revision the vendor saw; null when the product had no row yet. */
  expectedRevisionId: number | null;
  patch: ProductListingSettingPatch;
  requestHash: string;
  now: Date;
}
export interface ProductListingSettingSaveResult {
  outcome: ListingSettingSaveOutcome;
  /** The row after the save, the stored revision on a replay; null only when nothing is stored and nothing changed. */
  row: ProductListingSettingRow | null;
  before: ProductListingSettingRow | null;
  changedFields: ProductListingSettingField[];
}

/** Many products, set-based (W6, and W12's "Also clear theirs"). W7's price apply operation is PR 9 (plan D5, D28). */
export interface ProductListingSettingsBulkInput {
  operation: "product_settings_bulk" | "category_settings_clear";
  /** 1 to 10,000 distinct products, each with the revision the vendor saw. */
  products: ReadonlyArray<{ productId: number; expectedRevisionId: number | null }>;
  patch: ProductListingSettingBulkPatch;
  requestHash: string;
  now: Date;
}
export interface ProductListingSettingsBulkResult {
  outcome: ListingSettingSaveOutcome;
  /** The ledger row; a bulk request always writes one, even when no product changed (plan D12). */
  requestId: number;
  changed: Array<{ productId: number; revisionId: number }>;
  unchangedProductIds: number[];
}

/** One Card Shellz category (W12), keyed by catalog.product_categories.id. */
export interface CategoryListingSettingSaveInput {
  categoryId: number;
  expectedRevisionId: number | null;
  patch: CategoryListingSettingPatch;
  requestHash: string;
  now: Date;
}
export interface CategoryListingSettingSaveResult {
  outcome: ListingSettingSaveOutcome;
  row: CategoryListingSettingRow | null;
  before: CategoryListingSettingRow | null;
  changedFields: CategoryListingSettingField[];
  /** The category's name as read at save; the revision keeps it for the audit trail, readers show the live name. */
  categoryName: string;
}

/** "Got it" for products Card Shellz moved (W13): each product once, with the category the vendor was shown. */
export interface CategoryMovesAcknowledgeInput {
  items: ReadonlyArray<{ productId: number; shownCategoryId: number | null }>;
  requestHash: string;
  now: Date;
}
export interface CategoryMovesAcknowledgeResult {
  /** A replay answers with empty lists: the page re-reads after any save (PR 7 D9). */
  outcome: "acknowledged" | "replayed";
  acknowledgedProductIds: number[];
  /** Products whose category moved again since the vendor was shown it; their marks are kept, so they stay listed. */
  movedAgainProductIds: number[];
}

/**
 * The catalog reads a listing-settings transaction may make on its own
 * client (plan PR 9, 6.2 #2): the price writer's, plus saved prices, Card
 * Shellz price limits and the listing config, AND NOTHING ELSE. The runtime
 * object is the preview repository bound to the transaction's client, and
 * five of its methods (loadListingSettingLayers, loadRulePrices,
 * loadListingContents, loadEbayCategories, createListingPushJob) run their
 * own BEGIN ... COMMIT on that client, which would commit the transaction
 * mid-flight. This type is the only guard; a type test pins its keys.
 */
export type ListingSettingCatalogReader = ListingPriceCatalogReader
  & Pick<DropshipListingPreviewRepository, "listSavedListingPrices" | "listPricingPolicies" | "getStoreListingConfig">;

export type { ListingSettingLeftoverField };

export interface ClearSizeLeftoversInput {
  /** Products lockCatalog locked in this transaction (its `lockedProductIds`); every size of each is cleared, chosen or not. */
  productIds: readonly number[];
  /** At least one; each clears its per-size rows. */
  fields: readonly ListingSettingLeftoverField[];
  /** The parent request's hash, stored on every child revision (plan D10). */
  requestHash: string;
  now: Date;
}
export interface ClearSizeLeftoversResult {
  /** Distinct sizes any row was cleared for. */
  clearedSizeCount: number;
  /** Rows cleared per table. */
  byKind: { policy: number; shelf: number; content: number };
  /** At most 100 of the cleared sizes, ascending. */
  productVariantIds: number[];
}

/** Which stored texts a write replaces on its products, to count the store's text after it (plan 6.2 #6). */
export interface ListingTextBytesInput {
  productIds: readonly number[];
  replacedFields: { textAbove: boolean; textBelow: boolean; mainText: boolean };
}
/** UTF-8 bytes of the store's saved product text (text above, text below, main text over every product row). */
export interface ListingTextBytes {
  /** Every product row of the store, as stored. */
  storeBytes: number;
  /** The same, without the replaced fields of `productIds`. */
  keptStoreBytes: number;
  /** The stored text of `productIds` (9d's bulk text budget). */
  targetBytes: number;
}

export interface ListingSettingReadTransaction {
  readonly vendorId: number;
  readonly storeConnectionId: number;
  /** Current rows by product id; a product with no row is absent. `forUpdate` locks the rows found. */
  loadProducts(productIds: readonly number[], options?: { forUpdate?: boolean }): Promise<Map<number, ProductListingSettingRow>>;
  loadCategories(categoryIds: readonly number[], options?: { forUpdate?: boolean }): Promise<Map<number, CategoryListingSettingRow>>;
  loadCategoryMarks(productIds: readonly number[]): Promise<Map<number, ProductCategoryMark>>;
}

/**
 * WHAT THESE WRITERS DO NOT DO; PR 9's services must (plan D29):
 * - Authorize. Store, vendor and entitlement status (pattern:
 *   dropship-listing-price-service.ts authorize, dropship-listing-content-service.ts
 *   authorizeListing); the product has a chosen and shown size (W5); the
 *   category exists and has a chosen product (W12).
 * - Check prices. A `price` patch on saveProduct (W5) or saveCategory (W7
 *   apply) must follow PR 9's never-lose-a-price and limit check for every
 *   affected size (R:§8.6 rules 1, 4, 6). Size prices are written only through
 *   saveListingPriceInTransaction(tx.sizePrice(id), …), which runs W9's checks.
 *   Note for PR 9: W9's check resolves "before" from the transaction's current
 *   state, so W5 must run its per-size checks before it writes the product row
 *   (or compute the before prices up front).
 * - Ask eBay anything.
 * - Run twice: saveProduct, saveCategory, saveProductsBulk and
 *   acknowledgeCategoryMoves each run at most once per transaction (plan D30);
 *   a second call is DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED before any SQL.
 *   One ledger row per request key: W7 (PR 9) folds its product rows into one
 *   bulk call.
 */
export interface ListingSettingWriteTransaction extends ListingSettingReadTransaction, SelectedCatalogReader {
  readonly vendorId: number;
  readonly actor: ListingSettingActor;
  readonly requestKey: string;
  /** Authorization and price reads (PR 9) on this transaction's client; never a reader that commits (ListingSettingCatalogReader). */
  readonly catalog: ListingSettingCatalogReader;
  /**
   * Every row this request key wrote (plan PR 9, P16): the product and
   * category revision and the ledger row under the key, and every size,
   * policy, shelf and content child under its prefixes, all of this vendor.
   * One statement, no lock; under the request lock it cannot change, so a
   * service runs it right after the gate and answers a replay from it,
   * calling no writer. A stored row that breaks its contract is
   * DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED.
   */
  findRequestKeyUse(): Promise<RequestKeyUse>;
  /**
   * Selection SHARE locks, then categories, products and sizes FOR SHARE, in
   * ascending ids. Only before any write; a call after a write is
   * DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED.
   */
  lockCatalog(input: { categoryIds?: readonly number[]; productIds?: readonly number[]; productVariantIds?: readonly number[] }): Promise<{
    /** The products the lock found, ascending: a product Card Shellz deleted is not among them. */
    lockedProductIds: number[];
  }>;
  /** The products' sizes a vendor could choose (sellable, shipped, stock-tracked), ascending; the selected-catalog scan's filter (plan P12). */
  listProductSizes(productIds: readonly number[]): Promise<number[]>;
  /** The store's pricing profile, read on this client (readPricingProfile). */
  loadPricingProfile(): Promise<PricingProfileState>;
  /** The vendor's .ops cost per size, read on this client in a savepoint; a failed read gives "unavailable" costs, as W9's does. */
  loadProductCosts(productVariantIds: readonly number[]): Promise<ReadonlyMap<number, DropshipProductCost>>;
  /** The store's saved product text in UTF-8 bytes, one statement, no text read (plan 6.2 #6). */
  readListingTextBytes(input: ListingTextBytesInput): Promise<ListingTextBytes>;
  saveProduct(input: ProductListingSettingSaveInput): Promise<ProductListingSettingSaveResult>;
  saveProductsBulk(input: ProductListingSettingsBulkInput): Promise<ProductListingSettingsBulkResult>;
  saveCategory(input: CategoryListingSettingSaveInput): Promise<CategoryListingSettingSaveResult>;
  acknowledgeCategoryMoves(input: CategoryMovesAcknowledgeInput): Promise<CategoryMovesAcknowledgeResult>;
  /**
   * W9's price transaction for one size (plan D29), on this transaction's
   * client, locks and actor. Its key is listingSettingChildKey(requestKey,
   * "size", productVariantId); the size must have been locked by lockCatalog in
   * this transaction, else DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED. Write
   * through saveListingPriceInTransaction.
   */
  sizePrice(productVariantId: number): ListingPriceTransaction;
  /** Today's eBay category rules writer, with its own revision check. Its key must be the "ebay_rules" child (id = the store). */
  saveEbayCategoryRulesProfile(save: SaveEbayCategoryRulesProfileInput): Promise<{ revisionId: number }>;
  /** Today's per-size content writer with a revision check. Its key must be the "content" child; the size must be locked by lockCatalog. */
  saveListingContent(productVariantId: number, save: SaveListingContentInput, hash: string, now: Date): Promise<void>;
  /**
   * Clears the per-size leftovers that would beat a product value (plan
   * P17): for every size of the products, the vendor's own policy ids of the
   * cleared policy fields, its shelf rows and its own main text, each with a
   * revision under the request's policy, shelf or content child key, and an
   * audit row with ids, a text length and a digest only. Set-based, vendor-
   * and store-scoped, after the parent writer and the size prices, at most
   * once per transaction. Takes the old per-size writers' feature locks
   * (policy, then shelf) first. Every product must have been locked by
   * lockCatalog (`lockedProductIds`), and `fields` must not be empty;
   * otherwise DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED.
   */
  clearSizeLeftovers(input: ClearSizeLeftoversInput): Promise<ClearSizeLeftoversResult>;
}

/**
 * The read-only preflight (plan PR 9, 6.2 #4): a snapshot before any eBay
 * call, with no lock, so a write knows which eBay ids are new and whether its
 * key was used before asking eBay. Writes nothing.
 */
export interface ListingSettingPreflightTransaction {
  readonly vendorId: number;
  readonly storeConnectionId: number;
  readonly catalog: Pick<DropshipListingPreviewRepository, "loadStoreContext" | "getStoreListingConfig">;
  /** The replay probe without the request lock; DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED when the preflight has no key. */
  findRequestKeyUse(): Promise<RequestKeyUse>;
  loadProducts(productIds: readonly number[]): Promise<Map<number, ProductListingSettingRow>>;
  loadCategories(categoryIds: readonly number[]): Promise<Map<number, CategoryListingSettingRow>>;
}

/** The first-mark job (W13, PR 9). It has no price, rules or content delegates: those audit as `vendor`. */
export interface ListingSettingSystemTransaction extends ListingSettingReadTransaction {
  /** Inserts a mark only for products that have none, so it never hides a move. */
  insertFirstCategoryMarks(input: { productIds: readonly number[]; jobKey: string; now: Date }): Promise<{ insertedProductIds: number[] }>;
}

export interface ListingSettingWriteRepository {
  /** READ COMMITTED (plan D11): request lock, store lock, owner rows, then the operation. */
  execute<T>(input: { memberId: string; storeConnectionId: number; idempotencyKey: string },
    operation: (tx: ListingSettingWriteTransaction) => Promise<T>): Promise<T>;
  executeForSystem<T>(input: { storeConnectionId: number; jobKey: string },
    operation: (tx: ListingSettingSystemTransaction) => Promise<T>): Promise<T>;
  /** REPEATABLE READ READ ONLY: owner rows without a row lock, no advisory lock, no write (plan 6.2 #4). */
  preflight<T>(input: { memberId: string; storeConnectionId: number; idempotencyKey: string | null },
    operation: (tx: ListingSettingPreflightTransaction) => Promise<T>): Promise<T>;
}
