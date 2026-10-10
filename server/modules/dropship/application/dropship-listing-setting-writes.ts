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
import type { SaveEbayCategoryRulesProfileInput } from "./dropship-ebay-category-rules-service";
import type { ListingPriceCatalogReader, ListingPriceTransaction } from "./dropship-listing-price-service";
import type { SelectedCatalogReader } from "./dropship-selected-catalog";

/**
 * The write port for product and category listing settings (plan PR 8a,
 * section 3.7). PR 8 builds the repository behind it; PR 9's services (W5,
 * W6, W7, W12, W13) are its only callers. Types only.
 */

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
  /** Authorization reads (PR 9), as the content and price transactions have. */
  readonly catalog: ListingPriceCatalogReader;
  /**
   * Selection SHARE locks, then categories, products and sizes FOR SHARE, in
   * ascending ids. Only before any write; a call after a write is
   * DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED.
   */
  lockCatalog(input: { categoryIds?: readonly number[]; productIds?: readonly number[]; productVariantIds?: readonly number[] }): Promise<void>;
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
}
