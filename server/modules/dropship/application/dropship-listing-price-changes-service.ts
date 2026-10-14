import { isTypedListingPrice, listingPriceFollowsRules, RULE_PRICE_OUTSIDE_LIMIT_ISSUE, type SavedListingPriceRevision }
  from "../../../../shared/dropship/listing-price";
import {
  CATEGORY_LISTING_SETTING_FIELDS,
  categoryListingSettingPatchSchema,
  type CategoryListingSettingPatch,
  type ProductListingSettingPriceApplyPatch,
} from "../../../../shared/dropship/listing-setting-values";
import {
  MAX_BULK_TEXT_BYTES,
  MAX_PRICE_RELEASES_PER_APPLY,
  PRICE_CHANGE_CLEAR_FIELDS,
  applyPriceChangesInputSchema,
  priceChangeReviewIdSchema,
  priceChangeReviewPageInputSchema,
  priceChangeRowSchema,
  priceChangeRowsSchema,
  reviewPriceChangesInputSchema,
  storedInputSchemaFor,
  type ApplyPriceChangesResponse,
  type PriceChangeClearField,
  type PriceChangeReviewKind,
  type PriceChangeReviewResponse,
  type PriceChangeRow,
  type ReviewPriceChangesInput,
  type StoredCategoryPriceInput,
  type StoredProductPricesInput,
} from "../../../../shared/dropship/listing-setting-writes";
import {
  MAX_PRICING_REVIEW_ITEMS,
  PRICING_REVIEW_PAGE_SIZE,
  RETAIL_FALLBACK_RULE_NAME,
  pricingAmountCentsSchema,
  pricingBasisCents,
  type PricingProfileState,
  type PricingRecipe,
  type RulePriceBasis,
} from "../../../../shared/dropship/pricing-rules";
import { DropshipError } from "../domain/errors";
import { evaluateListingPriceAgainstCost } from "../domain/listing-price-cost";
import { classifyRequestKeyUse, type RequestKeyUse } from "../domain/listing-setting-request-key-use";
import {
  LISTING_SETTING_LEFTOVER_FIELDS,
  listingSettingChildKey,
  listingSettingsInvariantFailed,
  type ListingSettingLeftoverField,
} from "../domain/listing-setting-values";
import { resolveMarketplaceId } from "./dropship-ebay-listing-setup-service";
import { buildListingPriceChanges, type ListingPriceChange, type TypedInRequestPrice } from "./dropship-listing-price-change-builder";
import { saveListingPriceInTransaction } from "./dropship-listing-price-service";
import { evaluateListingPricingPolicy, type DropshipPricingPolicyRecord } from "./dropship-listing-preview-service";
import {
  LISTING_SETTING_POLICY_FIELDS,
  resolveListingSettingEbayValues,
  setsListingSettingEbayId,
  type ListingSettingEbayPort,
  type ListingSettingEbayPreflight,
  type ListingSettingEbayResolution,
} from "./dropship-listing-setting-ebay-values";
import {
  MAX_LISTED_SIZES,
  assertListingSettingMember,
  authorizeListingSettingWrite,
  listingSettingBulkTooLarge,
  listingSettingOlderRulesPresent,
  listingSettingPricesMoved,
  listingSettingStoreIdSchema,
  listingSettingWriteHash,
  loadChosenSizes,
  parseListingSettingInput,
  requestKeyUsePath,
  type ChosenSize,
  type ListingSettingHeavyWriteGate,
  type ListingSettingWriteLog,
  type PricingCatalogCandidate,
} from "./dropship-listing-setting-write-support";
import type {
  ClearSizeLeftoversResult,
  ListingSettingFacts,
  ListingSettingPreflightTransaction,
  ListingSettingReviewTransaction,
  ListingSettingWriteRepository,
  ListingSettingWriteTransaction,
  LoadedPriceChangeReview,
  ProductListingSettingsBulkResult,
  StoredPriceChangeReview,
} from "./dropship-listing-setting-writes";
import { ownCategoryFields } from "./dropship-listing-settings-facts";
import { LISTING_SETTINGS_CACHE_TTL_MS } from "./dropship-listing-settings-service";
import type { DropshipClock } from "./dropship-ports";
import type { DropshipProductCost } from "./dropship-product-cost";
import {
  NO_PRICING_PROFILE_STATE,
  createRulePriceResolver,
  pricingHash,
  rulePriceContextFromFacts,
  withRecipes,
  type RulePriceContext,
} from "./dropship-rule-price";

/**
 * W7, the price check and its apply (Listing settings design 8.5; plan PR 9,
 * section 9): a price change for many products (their price, and the release
 * of their sizes' exact prices), or for one Card Shellz category (its price
 * with its editor's other settings and "Also clear theirs"), first shown as
 * a stored review of every chosen size's price before and after, then
 * applied only if the server computes the same review again.
 *
 * Review (plan 9.5): parse; for a category change that names new eBay ids,
 * a read-only preflight and eBay for those ids only; then, inside the
 * process's one heavy-write gate, a transaction with the store lock and the
 * owner rows and no other lock (a review takes no selection or catalog lock,
 * P37): the gate, D16 and the category's checks, the chosen sizes in scope,
 * the releases, the text budget, the rows (9c's pure builder over the
 * text-free settings facts) and one immutable review row with its hash.
 *
 * Apply (plan 9.7): inside the same gate, the request lock, the store lock
 * and the owner rows; the gate, the replay probe (a replay is answered from
 * what the key wrote, calling no writer), the review's earlier apply (the
 * same review under another key is a conflict), the review and its hash,
 * D16, lockCatalog, the rows computed again from the stored input and their
 * hash compared, the category's clear set derived again under the feature
 * locks, every refusal, the text budget; then the writes, in the wrapper's
 * order: the category row, the products' rows with the ledger row naming the
 * review (one bulk call, even when no product changes), the releases through
 * W9's own flow (after the product rows, so W9 judges each against the new
 * recipe, P24), and the per-size clean-ups. Refusals all come before the
 * first write.
 *
 * Money is integer cents throughout, and no price is typed here: a W7 row is
 * never `typed`, so its only refusal is a price that would be lost (P14).
 * READ COMMITTED like every PR 9 writer (P3): every statement after the store
 * lock sees every committed listing write, and none can commit before this
 * one ends.
 */

export interface DropshipListingPriceChangesServiceDependencies {
  repository: ListingSettingWriteRepository;
  ebay: ListingSettingEbayPort;
  /** The process's one heavy-write gate (plan 3.10 (a)): a review and an apply are always heavy. */
  heavyWrites: ListingSettingHeavyWriteGate;
  clock: DropshipClock;
  /** Monotonic milliseconds, for `elapsed_ms` and `ebay_ms` only; the write's time is `clock`, read once. */
  timer: () => number;
  log: ListingSettingWriteLog;
  /** A new review id (randomUUID in production, W1's pattern); checked as the lowercase uuid the apply takes back. */
  newId: () => string;
}

/** The apply's versioned operation in the request hash (plan 3.7). */
const PRICE_CHANGE_APPLY_OPERATION = "price_change_apply_v1";
const WOULD_BE_LOST = "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST";
/** W1's rule name for a typed price the change keeps (dropship-pricing-rules-service.ts). */
const PRESERVED_RULE_NAME = "Fixed override preserved";
/** W9's refusals of one size, named with the size the apply stopped on (W8's rule, plan P19). */
const SIZE_REFUSALS: ReadonlySet<string> = new Set([
  "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", WOULD_BE_LOST, "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT",
  "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", "DROPSHIP_PRICING_RULES_NOT_CONFIGURED",
]);
/**
 * The set conflicts' second sentence (W12's): the category view is cached
 * for up to LISTING_SETTINGS_CACHE_TTL_MS and its key does not cover what
 * Card Shellz owns, so after a Card Shellz change a reload can show the same
 * set until the cached view expires.
 */
const CATALOG_DELAY_NOTE = `A change Card Shellz made can take up to ${Math.ceil(LISTING_SETTINGS_CACHE_TTL_MS / 1_000)} seconds to show.`;

/** A stored input with its kind; the kind is never inside the input (plan D6, P22). */
type PriceChangeSubject =
  | { kind: "product_prices"; input: StoredProductPricesInput }
  | { kind: "category_price"; input: StoredCategoryPriceInput };

/** The reads a review and an apply build their rows from: the same ones, so an apply computes exactly what its review did. */
type PriceChangeReader = Pick<ListingSettingReviewTransaction, "vendorId" | "storeConnectionId" | "catalog"
  | "listCategoryProductIds" | "listProductSizes" | "loadSettingFacts" | "loadPricingProfile" | "loadProductCosts">;

/** A chosen size in scope, with the candidate a price is resolved from (no listing content, plan P12). */
type PricedSize = ChosenSize & { candidate: PricingCatalogCandidate };

/** What a change covers (plan 9.5 step 3.3): the category's products, the chosen sizes, and the products' and categories' facts. */
interface PriceChangeScope {
  /** The category's Card Shellz products, as read (category kind); empty for the products kind. */
  membership: number[];
  chosen: PricedSize[];
  facts: ListingSettingFacts;
}

/** Everything else a row's price is resolved from, by size, as read in the transaction. */
interface PriceChangeInputs {
  profile: PricingProfileState;
  saved: ReadonlyMap<number, SavedListingPriceRevision>;
  existing: ReadonlyMap<number, number | null>;
  costs: ReadonlyMap<number, DropshipProductCost>;
  policies: readonly DropshipPricingPolicyRecord[];
  /** The sizes whose typed price the change releases, ascending (products kind with releaseExactPrices only). */
  releases: number[];
}

/** What a review transaction did, for the answer and the log line. */
interface ReviewWrite {
  review: StoredPriceChangeReview;
  vendorId: number;
  /** The stored text of the products the apply's bulk call will name. */
  textBytes: number;
  /** The review's rows as PostgreSQL stores them; they count toward the budget too (plan 9.7's stop rule). */
  rowsBytes: number;
}

/** What an apply transaction did, for the answer and the log line. */
interface ApplyWrite {
  response: ApplyPriceChangesResponse;
  vendorId: number;
  kind: PriceChangeReviewKind | null;
  categoryId: number | null;
  /** Entries `{ <target>_id, revision_id }` as plan 3.4's common log shape has them. */
  before: Array<Record<string, number | null>>;
  after: Array<Record<string, number | null>>;
  changedCount: number;
  leftovers: ClearSizeLeftoversResult | null;
  textBytes: number | null;
  rowsBytes: number | null;
}

export class DropshipListingPriceChangesService {
  constructor(private readonly deps: DropshipListingPriceChangesServiceDependencies) {}

  /** "Check prices" (plan 9.5): the stored review's first page. Unkeyed: a retried check is a second immutable review (P22). */
  async reviewForMember(memberId: string, storeId: unknown, body: unknown): Promise<PriceChangeReviewResponse> {
    assertListingSettingMember(memberId);
    const storeConnectionId = parseListingSettingInput(listingSettingStoreIdSchema, storeId);
    const parsed = parseListingSettingInput(reviewPriceChangesInputSchema, body);
    const started = this.deps.timer();
    const now = this.deps.clock.now();
    const reviewId = issuedReviewId(this.deps.newId());

    // eBay is asked only for ids the category does not store yet, outside any transaction and the gate (plan P13, P25).
    let ebay: ListingSettingEbayResolution | null = null;
    let ebayMs: number | null = null;
    if (parsed.kind === "category_price" && setsListingSettingEbayId(parsed.patch)) {
      const preflight = await this.deps.repository.preflight({ memberId, storeConnectionId, idempotencyKey: null },
        (tx) => readReviewPreflight(tx, { categoryId: parsed.categoryId }));
      const ebayStarted = this.deps.timer();
      ebay = await resolveListingSettingEbayValues(this.deps.ebay, { vendorId: preflight.vendorId, storeConnectionId, patch: parsed.patch, preflight });
      if (ebay.status === "resolved" && ebay.askedEbay) ebayMs = elapsedMs(this.deps.timer, ebayStarted);
    }
    const subject = storedSubject(parsed, ebay);

    const write = await this.deps.heavyWrites.run(() => this.deps.repository.executeReview({ memberId, storeConnectionId },
      (tx) => this.review(tx, { storeConnectionId, subject, reviewId, now })));

    const { review } = write;
    const summary = reviewSummary(review.rows);
    this.deps.log.info("dropship.listing_settings.price_change_reviewed", {
      outcome: "reviewed",
      vendor_id: write.vendorId,
      store_connection_id: storeConnectionId,
      actor_id: memberId,
      // A review is unkeyed and writes no settings revision: its one row is the review.
      request_key: null,
      before: [],
      after: [],
      changed_count: summary.changed,
      size_count: summary.total,
      elapsed_ms: elapsedMs(this.deps.timer, started),
      review_id: review.id,
      kind: review.kind,
      ...(review.kind === "category_price" ? { category_id: review.input.categoryId } : {}),
      row_count: summary.total,
      release_count: summary.released,
      refused_count: summary.refused,
      text_bytes: write.textBytes,
      review_rows_bytes: write.rowsBytes,
      ...(ebayMs === null ? {} : { ebay_ms: ebayMs }),
    });
    return projectPriceChangeReview(review, 0);
  }

  /**
   * One page of a stored review (plan 9.6): the member's own review on this
   * store, read by one owner-scoped statement with no lock, no transaction
   * and no gate (reads are not gated, plan 3.8).
   */
  async reviewPageForMember(memberId: string, storeId: unknown, reviewId: unknown, page: unknown): Promise<PriceChangeReviewResponse> {
    assertListingSettingMember(memberId);
    const storeConnectionId = parseListingSettingInput(listingSettingStoreIdSchema, storeId);
    const parsed = parseListingSettingInput(priceChangeReviewPageInputSchema, { reviewId, page });
    const review = await this.deps.repository.readPriceChangeReviewForMember({ memberId, storeConnectionId, reviewId: parsed.reviewId });
    if (!review) throw reviewNotFound(storeConnectionId, parsed.reviewId);
    return projectPriceChangeReview(review, parsed.page);
  }

  /** "Apply" (plan 9.7): the review the vendor saw, applied only if the server computes the same review now. */
  async applyForMember(memberId: string, storeId: unknown, body: unknown): Promise<ApplyPriceChangesResponse> {
    assertListingSettingMember(memberId);
    const storeConnectionId = parseListingSettingInput(listingSettingStoreIdSchema, storeId);
    const parsed = parseListingSettingInput(applyPriceChangesInputSchema, body);
    const started = this.deps.timer();
    const now = this.deps.clock.now();
    // Ids only (plan 3.7): every row this apply writes carries this hash, so a retry is answered by the probe.
    const requestHash = listingSettingWriteHash(PRICE_CHANGE_APPLY_OPERATION, {
      storeConnectionId, reviewId: parsed.reviewId, reviewHash: parsed.reviewHash,
    });
    const request = { memberId, storeConnectionId, idempotencyKey: parsed.idempotencyKey };

    const write = await this.deps.heavyWrites.run(() => this.deps.repository.execute(request, (tx) => this.apply(tx, {
      storeConnectionId, reviewId: parsed.reviewId, reviewHash: parsed.reviewHash, requestHash, now,
    })));

    const { response } = write;
    this.deps.log.info("dropship.listing_settings.price_change_applied", {
      outcome: response.outcome,
      vendor_id: write.vendorId,
      store_connection_id: storeConnectionId,
      actor_id: memberId,
      request_key: parsed.idempotencyKey,
      before: write.before.slice(0, MAX_LISTED_SIZES),
      after: write.after.slice(0, MAX_LISTED_SIZES),
      changed_count: write.changedCount,
      size_count: response.releasedSizeCount,
      elapsed_ms: elapsedMs(this.deps.timer, started),
      // Correlation (plan 9.7, C-money-5): the review, the ledger row and the key find every row this apply wrote.
      review_id: response.reviewId,
      kind: write.kind,
      ...(write.categoryId === null ? {} : { category_id: write.categoryId }),
      request_id: response.requestId,
      changed_product_count: response.changedProductCount,
      released_size_count: response.releasedSizeCount,
      cleared_size_count: response.outcome === "replayed" ? null : write.leftovers?.clearedSizeCount ?? 0,
      text_bytes: write.textBytes,
      review_rows_bytes: write.rowsBytes,
    });
    return response;
  }

  /** The review's transaction (plan 9.5 step 3): checks, scope, releases, budget, rows, then the one review row. */
  private async review(tx: ListingSettingReviewTransaction, input: {
    storeConnectionId: number; subject: PriceChangeSubject; reviewId: string; now: Date;
  }): Promise<ReviewWrite> {
    const { storeConnectionId, subject } = input;
    await authorizeListingSettingWrite(tx);
    if (subject.kind === "category_price") {
      const { categoryId, expectedRevisionId } = subject.input;
      await assertNoOlderGroupRules(tx, storeConnectionId);
      if (!(await tx.loadCatalogCategoryNames([categoryId])).has(categoryId)) throw categoryNotFound(storeConnectionId, categoryId);
      const actualRevisionId = (await tx.loadCategories([categoryId])).get(categoryId)?.revisionId ?? null;
      if (actualRevisionId !== expectedRevisionId) {
        throw categoryVersionConflict(storeConnectionId, categoryId, expectedRevisionId, actualRevisionId);
      }
    }

    const scope = await loadPriceChangeScope(tx, subject, input.now);
    if (subject.kind === "category_price" && subject.input.clear) {
      // The set the vendor was shown, derived as W12 derives it (plan P20), without the feature locks: a review
      // takes no lock, and the apply derives it again under them (plan 9.7 step 8a).
      const leftovers = await tx.loadLeftoverFields(scope.chosen.map((size) => size.productVariantId));
      assertClearSet(storeConnectionId, subject.input, derivedClearSet({ scope, leftovers, fields: subject.input.clear.fields, locked: null }));
      assertClearedRevisions(storeConnectionId, subject.input, scope.facts);
    }
    const prices = await loadPriceChangeInputs(tx, subject, scope);
    // The text budget before the rows are built: the products' stored text alone already refuses a check that cannot apply.
    const products = bulkProductIds(subject);
    const textBytes = await storedTextBytes(tx, products);
    assertWithinBudget(storeConnectionId, { textBytes, rowsBytes: null }, products.length);
    const rows = buildPriceChangeRows({ subject, scope, prices });
    const review = { id: input.reviewId, ...subject, rows, reviewHash: priceChangeReviewHash(subject.kind, subject.input, rows),
      createdAt: input.now } as StoredPriceChangeReview;
    // Plan 9.7's memory stop rule (in force, PR 9f): the rows count too, measured as PostgreSQL stores them, which is
    // what the apply's load reads, so a check that passes here passes there. Over it, the refusal rolls the row back.
    const { rowsBytes } = await tx.storePriceChangeReview(review);
    assertWithinBudget(storeConnectionId, { textBytes, rowsBytes }, products.length);
    return { review, vendorId: tx.vendorId, textBytes, rowsBytes };
  }

  /** The apply's transaction (plan 9.7 step 2): every check and refusal, then the writes in the wrapper's order. */
  private async apply(tx: ListingSettingWriteTransaction, input: {
    storeConnectionId: number; reviewId: string; reviewHash: string; requestHash: string; now: Date;
  }): Promise<ApplyWrite> {
    const { storeConnectionId, reviewId, requestHash, now } = input;
    // 2.1 The gate.
    await authorizeListingSettingWrite(tx);

    // 2.2 Replay before re-reading anything (plan P16). A category apply's revision is matched to its category, which
    // only the review names: when the key wrote anything, the review is read first (lock-free, as at step 4).
    const use = await tx.findRequestKeyUse();
    const expectation = { writer: "price_change_apply" as const, storeConnectionId, requestHash };
    if (classifyRequestKeyUse(use, expectation).kind !== "new") {
      const known = await tx.loadPriceChangeReview(reviewId);
      const categoryId = known?.kind === "category_price" ? known.input.categoryId : undefined;
      const decision = classifyRequestKeyUse(use, { ...expectation, categoryId });
      if (requestKeyUsePath(decision, { storeConnectionId }) === "replay") return replayed(use, tx.vendorId, reviewId, known);
      // requestKeyUsePath throws for a conflict and an incomplete use; "new" cannot follow a use that wrote rows.
      throw listingSettingsInvariantFailed("A price apply's request key wrote rows the probe classified as new.", { reviewId });
    }

    // 2.3 The review applied under another key (W1's rule): scoped to this vendor and store (v3r, C-money-4).
    const earlier = await tx.findPriceChangeApplyByReview(reviewId);
    if (earlier !== null) {
      // Under its own key the probe would have answered it as a replay.
      if (earlier.idempotencyKey === tx.requestKey) {
        throw listingSettingsInvariantFailed("A price apply under this key was not found by the replay probe.", { reviewId });
      }
      throw reviewAlreadyApplied(storeConnectionId, reviewId);
    }

    // 2.4 The review the vendor saw (W7's two kinds, this vendor and store), and the hash it was shown with.
    const review = await tx.loadPriceChangeReview(reviewId);
    if (!review) throw reviewNotFound(storeConnectionId, reviewId);
    if (review.reviewHash !== input.reviewHash) throw listingSettingPricesMoved(storeConnectionId, []);
    const subject = subjectOf(review);

    // 2.5 D16 again (plan P21): a group rule added since the review would win over the category's price.
    if (subject.kind === "category_price") await assertNoOlderGroupRules(tx, storeConnectionId);

    // 2.6 The products' current revisions for the bulk call (no lock, no text; plan 9.12 #2): every listing writer
    // holds the store lock, so they cannot change before the writer's FOR UPDATE.
    const revisions = subject.kind === "product_prices" && subject.input.price !== undefined
      ? await tx.loadSettingFacts({ productIds: subject.input.productIds }) : null;

    // 2.7 The selection SHARE locks and the rows, sizes and category the apply depends on (P37).
    const membership = subject.kind === "category_price" ? await tx.listCategoryProductIds(subject.input.categoryId) : [];
    const { lockedProductIds } = await tx.lockCatalog({
      ...(subject.kind === "category_price" ? { categoryIds: [subject.input.categoryId] } : {}),
      productIds: uniqueAscending([...review.rows.map((row) => row.productId), ...inputProductIds(subject), ...membership]),
      productVariantIds: review.rows.filter((row) => row.released).map((row) => row.productVariantId),
    });
    const locked = new Set(lockedProductIds);

    // 2.8 The rows computed again from the stored input, exactly as at review; any difference is PRICES_MOVED.
    const scope = await loadPriceChangeScope(tx, subject, now);
    const prices = await loadPriceChangeInputs(tx, subject, scope);
    const rows = buildPriceChangeRows({ subject, scope, prices });
    if (priceChangeReviewHash(subject.kind, subject.input, rows) !== review.reviewHash) {
      throw listingSettingPricesMoved(storeConnectionId, movedSizes(review.rows, rows));
    }

    // 2.8a The clear set derived again under the feature locks (v3r, C-money-6; W12's parity): the products moved in
    // or out under the locks, the leftovers (loadLeftoverFields takes the two feature locks), then the set.
    let cleared: number[] = [];
    if (subject.kind === "category_price" && subject.input.clear) {
      const moved = symmetricDifference(membership, scope.membership);
      if (moved.length > 0) {
        throw productSetConflict(storeConnectionId, subject.input.categoryId, moved,
          `The products in this category changed after you checked prices. Check prices again before applying. ${CATALOG_DELAY_NOTE}`);
      }
      const leftovers = await tx.loadLeftoverFields(scope.chosen.map((size) => size.productVariantId));
      cleared = assertClearSet(storeConnectionId, subject.input,
        derivedClearSet({ scope, leftovers, fields: subject.input.clear.fields, locked }));
      assertClearedRevisions(storeConnectionId, subject.input, scope.facts);
    }
    // The writers compare and set each revision too; read here under the store lock, a stale one is refused before any
    // write instead of after the category row (the review checked both against the same facts).
    if (subject.kind === "category_price") {
      const { categoryId, expectedRevisionId } = subject.input;
      const actualRevisionId = scope.facts.categories.get(categoryId)?.revisionId ?? null;
      if (actualRevisionId !== expectedRevisionId) {
        throw categoryVersionConflict(storeConnectionId, categoryId, expectedRevisionId, actualRevisionId);
      }
    }

    // 2.9 A size that would lose its usable price (stored at review, refused here; R:§8.6 rule 1), before any write.
    const refused = rows.filter((row) => row.refusal !== null);
    if (refused.length > 0) throw wouldBeLost(storeConnectionId, refused);

    // 2.10 The text budget again: the stored text of the products the bulk call names (patch bytes 0, plan 3.10 (b)),
    // and the review's rows as stored (plan 9.7's memory stop rule, read by the review's load at step 2.4).
    const bulk = bulkRequest(subject, { revisions, locked, cleared });
    const textBytes = await storedTextBytes(tx, bulk.products.map((product) => product.productId));
    assertWithinBudget(storeConnectionId, { textBytes, rowsBytes: review.rowsBytes }, bulk.products.length);

    // 2.11 The writes: categories → products → sizes → leftovers (the wrapper's order).
    const category = subject.kind === "category_price" ? await tx.saveCategory({ categoryId: subject.input.categoryId,
      expectedRevisionId: subject.input.expectedRevisionId, patch: storedCategoryPatch(subject.input), requestHash, now }) : null;
    if (category?.outcome === "replayed") {
      throw listingSettingsInvariantFailed("A category save in a new price apply replayed.", { reviewId });
    }
    // Always: the ledger row names the review even when no product changes (P23; v2, C-money-4).
    const saved = await tx.saveProductsBulk({ operation: "price_change_apply", reviewId, products: bulk.products, patch: bulk.patch,
      requestHash, now });
    if (saved.outcome === "replayed") {
      throw listingSettingsInvariantFailed("A product save in a new price apply replayed.", { reviewId, requestId: saved.requestId });
    }
    const releases = await releaseExactPrices(tx, { storeConnectionId, requestHash, now, rows: rows.filter((row) => row.released) });
    // The cleared policies and shelf leave per-size leftovers on every size of the set (plan P17); the set is locked products only.
    const clearedFields: readonly string[] = subject.kind === "category_price" ? subject.input.clear?.fields ?? [] : [];
    const leftoverFields = LISTING_SETTING_LEFTOVER_FIELDS.filter((field) => clearedFields.includes(field));
    const leftovers = leftoverFields.length > 0 && cleared.length > 0
      ? await tx.clearSizeLeftovers({ productIds: cleared, fields: leftoverFields, requestHash, now }) : null;

    return appliedWrite({ subject, reviewId, vendorId: tx.vendorId, category, saved, expected: bulk.products, releases, leftovers, textBytes,
      rowsBytes: review.rowsBytes });
  }
}

// ---------------------------------------------------------------------------
// The review hash, the rows and the page (pure)
// ---------------------------------------------------------------------------

/**
 * The review hash (plan P22, C-money-10, 3.7): pricingHash({ kind, input,
 * rows }) over the stored input as its kind's schema parses it and the rows
 * ascending by size as priceChangeRowsSchema parses them. jsonb keeps no key
 * order and Zod rebuilds objects in shape order, so a stored review hashes
 * the same after a round trip; rows in another order and keys set to
 * undefined hash the same; the kind keeps one kind's review from satisfying
 * another's apply. An input or rows outside their contract are a fault.
 */
export function priceChangeReviewHash(kind: PriceChangeReviewKind, input: unknown, rows: readonly unknown[]): string {
  const parsedInput = storedInputSchemaFor(kind).safeParse(input);
  if (!parsedInput.success) {
    throw listingSettingsInvariantFailed("A price change review's input failed its contract.", { kind, issues: issueCodes(parsedInput.error.issues) });
  }
  const ascending = [...rows].sort((left, right) => sizeIdOf(left) - sizeIdOf(right));
  const parsedRows = priceChangeRowsSchema.safeParse(ascending);
  if (!parsedRows.success) {
    throw listingSettingsInvariantFailed("A price change review's rows failed their contract.", { kind, issues: issueCodes(parsedRows.error.issues) });
  }
  return pricingHash({ kind, input: parsedInput.data, rows: parsedRows.data });
}

/** Every page of a review has its summary; page 0 comes with the review, later pages from the GET (W1's shape). */
export function projectPriceChangeReview(review: StoredPriceChangeReview, page: number): PriceChangeReviewResponse {
  return {
    reviewId: review.id,
    reviewHash: review.reviewHash,
    createdAt: review.createdAt.toISOString(),
    kind: review.kind,
    summary: reviewSummary(review.rows),
    rows: review.rows.slice(page * PRICING_REVIEW_PAGE_SIZE, (page + 1) * PRICING_REVIEW_PAGE_SIZE),
    page,
  };
}

/** `changed`: another price; `released`: an exact price released; `refused`: a price that would be lost. */
function reviewSummary(rows: readonly PriceChangeRow[]): PriceChangeReviewResponse["summary"] {
  return {
    total: rows.length,
    changed: rows.filter((row) => row.previousPriceCents !== row.priceCents).length,
    released: rows.filter((row) => row.released).length,
    refused: rows.filter((row) => row.refusal !== null).length,
  };
}

/**
 * Every chosen size's review row (plan 9.5 step 3.6), ascending by size.
 * Before is the store as it prices today (rulePriceContextFromFacts over the
 * text-free facts); after has the change's recipes (withRecipes): the
 * products' price for every product in scope (products kind), or the
 * category's price and, when "Also clear theirs" clears the price, no own
 * price on the cleared products (category kind). A released size resolves
 * after as `inherit`; no size is typed. The prices are 9c's builder's (the
 * read model's own per-size function), and each row carries W1's per-row
 * fields (dropship-pricing-rules-service.ts buildImpact) as they describe the
 * after side. Pure: no I/O, no clock, inputs not mutated.
 */
function buildPriceChangeRows(input: { subject: PriceChangeSubject; scope: PriceChangeScope; prices: PriceChangeInputs }): PriceChangeRow[] {
  const { subject, scope, prices } = input;
  if (scope.chosen.length === 0) return [];
  const before = rulePriceContextFromFacts(prices.profile, scope.facts);
  const after = afterContext(before, subject);
  const released = new Set(prices.releases);
  const typedInRequest = new Map<number, TypedInRequestPrice>(prices.releases.map((id) => [id, { pricingMode: "inherit" }]));
  const changes = buildListingPriceChanges({
    before, after, policies: prices.policies, typedInRequest,
    sizes: scope.chosen.map((size) => ({
      candidate: size.candidate,
      saved: prices.saved.get(size.productVariantId) ?? null,
      existingListingPriceCents: prices.existing.get(size.productVariantId) ?? null,
      cost: prices.costs.get(size.productVariantId) ?? null,
    })),
  });
  // Evidence (W1's per-row hash): the rule prices each side resolves, with their own evidence, and every other input.
  const beforeRules = createRulePriceResolver(before);
  const afterRules = createRulePriceResolver(after);
  const guardrails = pricingHash(prices.policies);
  return changes.map((change, index) => {
    const size = scope.chosen[index];
    if (size.productVariantId !== change.productVariantId) {
      throw listingSettingsInvariantFailed("The price check's rows came back out of order.", { productVariantId: size.productVariantId });
    }
    const saved = prices.saved.get(size.productVariantId) ?? null;
    const cost = prices.costs.get(size.productVariantId) ?? null;
    return priceChangeRow({
      size, change, saved, cost, released: released.has(size.productVariantId), policies: prices.policies,
      evidenceHash: pricingHash({
        rule: afterRules.covers(size.candidate) ? afterRules.price(size.candidate, cost).evidenceHash : null,
        oldRule: beforeRules.covers(size.candidate) ? beforeRules.price(size.candidate, cost).evidenceHash : null,
        setting: saved, existing: prices.existing.get(size.productVariantId) ?? null, guardrails,
        released: released.has(size.productVariantId),
      }),
    });
  });
}

/** The after side's recipes (plan 9.5 step 3.6): a new, frozen context; `before` is not changed. */
function afterContext(before: RulePriceContext, subject: PriceChangeSubject): RulePriceContext {
  if (subject.kind === "product_prices") {
    const { price } = subject.input;
    return price === undefined ? before
      : withRecipes(before, { products: new Map(subject.input.productIds.map((id) => [id, price])) });
  }
  const { input } = subject;
  const clearsPrice = input.clear?.fields.includes("price") === true;
  return withRecipes(before, {
    categories: new Map([[input.categoryId, input.patch.price]]),
    ...(clearsPrice ? { products: new Map<number, PricingRecipe | null>(input.clear!.products.map((product) => [product.productId, null])) } : {}),
  });
}

/**
 * One review row from the builder's change, in W1's terms for the after side:
 * a typed price the change keeps is `preserved`; an `inherit` size the rules
 * give no usable price is on its retail price (`RETAIL_FALLBACK_RULE_NAME`,
 * with why); otherwise the rule that owns the price names it. Issues and
 * warnings describe only a price the change sets, as W1's do.
 */
function priceChangeRow(input: {
  size: PricedSize; change: ListingPriceChange; saved: SavedListingPriceRevision | null; cost: DropshipProductCost | null;
  released: boolean; policies: readonly DropshipPricingPolicyRecord[]; evidenceHash: string;
}): PriceChangeRow {
  const { size, change, saved, released } = input;
  const { candidate } = size;
  if (change.refusal !== null && change.refusal !== WOULD_BE_LOST) {
    // A W7 row is never typed, so the guard cannot answer "outside a limit" (plan P14).
    throw listingSettingsInvariantFailed("A price check row was refused as a typed price.", { productVariantId: size.productVariantId });
  }
  const afterSaved = released ? { overridePriceCents: null, pricingMode: "inherit" as const } : saved;
  const rule = change.afterRule;
  const preserved = isTypedListingPrice(afterSaved);
  const ruleOwned = listingPriceFollowsRules({ saved: afterSaved, rulePrice: rule });
  const followsStorePricing = afterSaved?.pricingMode === "inherit";
  const onRetail = followsStorePricing && !ruleOwned && change.after.priceCents !== null;
  const productCostCents = availableCostCents(input.cost);
  const basis: RulePriceBasis | null = preserved ? null : onRetail ? "catalog_retail" : ruleOwned ? rule?.basis ?? null : null;
  const issues = preserved ? [] : [ruleOwned && !onRetail ? rule?.issue ?? null : null, ...change.after.blockers]
    .filter((issue): issue is string => issue !== null);
  const warnings = preserved ? [] : [
    ...evaluateListingPricingPolicy(candidate, input.policies, change.after.priceCents).warnings,
    ...evaluateListingPriceAgainstCost({ priceCents: change.after.priceCents, unitCostCents: productCostCents }).warnings,
  ];
  const retailFallbackIssue = onRetail ? rule?.issue ?? (rule?.blockedByLimit ? RULE_PRICE_OUTSIDE_LIMIT_ISSUE : null) : null;
  const ruleLevel = !preserved && !onRetail && ruleOwned ? rule?.ruleLevel : undefined;
  return {
    productVariantId: size.productVariantId,
    title: candidate.title?.trim() || candidate.productName,
    sku: candidate.sku,
    previousPriceCents: change.before.priceCents,
    priceCents: change.after.priceCents,
    productCostCents,
    ruleName: preserved ? PRESERVED_RULE_NAME : onRetail ? RETAIL_FALLBACK_RULE_NAME : ruleOwned ? rule?.ruleName ?? null : null,
    preserved,
    issues,
    settingRevisionId: saved?.revisionId ?? null,
    evidenceHash: input.evidenceHash,
    sizeName: candidate.variantName,
    basis,
    basisCents: basisAmountCents(basis, { productCostCents, catalogRetailCents: candidate.defaultRetailPriceCents }),
    warnings,
    ...(followsStorePricing ? { followsStorePricing: true as const } : {}),
    ...(retailFallbackIssue ? { retailFallbackIssue } : {}),
    ...(ruleLevel ? { ruleLevel } : {}),
    productId: size.productId,
    released,
    refusal: change.refusal === WOULD_BE_LOST ? WOULD_BE_LOST : null,
  };
}

// ---------------------------------------------------------------------------
// The reads both steps share
// ---------------------------------------------------------------------------

/**
 * The chosen sizes a change covers (plan 9.5 step 3.3, P12): the products
 * kind's products, or the category's products with the products "Also clear
 * theirs" names; their sellable sizes; the chosen ones with their pricing
 * candidates, in batches of 250. More than 10,000 is refused (P35), as soon
 * as the check finds the 10,001st; none is allowed. Then the text-free facts of those products and of the categories
 * their sizes price from.
 */
async function loadPriceChangeScope(tx: PriceChangeReader, subject: PriceChangeSubject, now: Date): Promise<PriceChangeScope> {
  const membership = subject.kind === "category_price" ? await tx.listCategoryProductIds(subject.input.categoryId) : [];
  const productIds = subject.kind === "product_prices" ? [...subject.input.productIds]
    : uniqueAscending([...membership, ...(subject.input.clear?.products.map((product) => product.productId) ?? [])]);
  // The check stops at the first chosen size over the bound, so a scope of any size holds at most 10,001 candidates.
  const chosen = await loadChosenSizes(tx, await tx.listProductSizes(productIds), now,
    { keepCandidates: "pricing", stopAbove: MAX_PRICING_REVIEW_ITEMS });
  if (chosen.length > MAX_PRICING_REVIEW_ITEMS) throw priceCheckTooLarge(tx.storeConnectionId);
  const categoryIds = uniqueAscending([
    ...chosen.map((size) => size.candidate.categoryId).filter((id): id is number => id !== null),
    ...(subject.kind === "category_price" ? [subject.input.categoryId] : []),
  ]);
  const facts = await tx.loadSettingFacts({ productIds, categoryIds });
  return { membership, chosen, facts };
}

/**
 * The price inputs of the chosen sizes, read on the transaction's client:
 * the store's pricing profile, the saved size prices, the prices earlier
 * pushes saved, the .ops costs and Card Shellz's price limits. Then the
 * releases (products kind with releaseExactPrices): every chosen size with a
 * typed price, at most MAX_PRICE_RELEASES_PER_APPLY (P24).
 */
async function loadPriceChangeInputs(tx: PriceChangeReader, subject: PriceChangeSubject, scope: PriceChangeScope): Promise<PriceChangeInputs> {
  const sizeIds = scope.chosen.map((size) => size.productVariantId);
  if (sizeIds.length === 0) {
    return { profile: NO_PRICING_PROFILE_STATE, saved: new Map(), existing: new Map(), costs: new Map(), policies: [], releases: [] };
  }
  const profile = await tx.loadPricingProfile();
  const saved = await tx.catalog.listSavedListingPrices({ vendorId: tx.vendorId, storeConnectionId: tx.storeConnectionId, productVariantIds: sizeIds });
  const existing = await tx.catalog.listExistingListings({ storeConnectionId: tx.storeConnectionId, productVariantIds: sizeIds });
  const costs = await tx.loadProductCosts(sizeIds);
  const policies = await tx.catalog.listPricingPolicies();
  const savedById = new Map(saved.map((row) => [row.productVariantId, row]));
  const releases = subject.kind === "product_prices" && subject.input.releaseExactPrices === true
    ? sizeIds.filter((id) => isTypedListingPrice(savedById.get(id) ?? null)) : [];
  if (releases.length > MAX_PRICE_RELEASES_PER_APPLY) throw releaseLimit(tx.storeConnectionId, releases.length);
  return {
    profile,
    saved: savedById,
    existing: new Map(existing.map((row) => [row.productVariantId, row.vendorRetailPriceCents])),
    costs,
    policies,
    releases,
  };
}

/** D16 (plan P21): a store with older group rules takes no category price; they would win over it. */
async function assertNoOlderGroupRules(tx: Pick<ListingSettingReviewTransaction, "loadOlderGroupRuleCounts">,
  storeConnectionId: number): Promise<void> {
  const groups = await tx.loadOlderGroupRuleCounts();
  if (groups.pricingGroups > 0 || groups.contentGroups > 0 || groups.ebayCategoryRules > 0) {
    throw listingSettingOlderRulesPresent(storeConnectionId, groups);
  }
}

/**
 * The stored text of the products the apply's bulk call names (plan 3.10
 * (b), 9.5 step 3.5, 9.7 step 10), with patch bytes 0: the patch holds only
 * a price or resets. None named reads nothing.
 */
async function storedTextBytes(tx: Pick<ListingSettingReviewTransaction, "readListingTextBytes">, productIds: readonly number[]): Promise<number> {
  if (productIds.length === 0) return 0;
  const bytes = await tx.readListingTextBytes({ productIds, replacedFields: { textAbove: false, textBelow: false, mainText: false } });
  return bytes.targetBytes;
}

/**
 * The heavy-write budget (plan P9 (b)): what a W7 step holds, the stored text
 * and, with plan 9.7's memory stop rule in force, the review's rows (null
 * before they are built), at most MAX_BULK_TEXT_BYTES. Permanent 422: fewer
 * products fit.
 */
function assertWithinBudget(storeConnectionId: number, counted: { textBytes: number; rowsBytes: number | null },
  productCount: number): void {
  // Only null means "not counted yet"; a missing size (undefined) must fail the check below, never count as 0.
  const rowsBytes = counted.rowsBytes === null ? 0 : counted.rowsBytes;
  const countedBytes = counted.textBytes + rowsBytes;
  // A count that is not a whole number (a missing size, say) would pass every comparison: a fault, never a pass.
  if (![counted.textBytes, rowsBytes, countedBytes].every((bytes) => Number.isSafeInteger(bytes) && bytes >= 0)) {
    throw listingSettingsInvariantFailed("A price check's budget count is not a whole number of bytes.", { storeConnectionId });
  }
  if (countedBytes <= MAX_BULK_TEXT_BYTES) return;
  throw counted.rowsBytes === null ? listingSettingBulkTooLarge(storeConnectionId, countedBytes, MAX_BULK_TEXT_BYTES, productCount)
    : priceCheckTooHeavy(storeConnectionId, countedBytes, productCount);
}

/**
 * "Also clear theirs"'s set (plan P20, W12's rule): the chosen products of the
 * category (by membership) that hold their own value in a cleared setting,
 * from their own row's flags and their chosen sizes' leftovers
 * (ownCategoryFields, the read's own rule), ascending. At apply only locked
 * products count (v3r, C-money-2).
 */
function derivedClearSet(input: {
  scope: PriceChangeScope; leftovers: ReadonlyMap<number, readonly ListingSettingLeftoverField[]>;
  fields: readonly PriceChangeClearField[]; locked: ReadonlySet<number> | null;
}): number[] {
  const inCategory = new Set(input.scope.membership);
  const sizesByProduct = new Map<number, number[]>();
  for (const size of input.scope.chosen) {
    if (inCategory.has(size.productId)) sizesByProduct.set(size.productId, [...(sizesByProduct.get(size.productId) ?? []), size.productVariantId]);
  }
  const fields = new Set<string>(input.fields);
  return [...sizesByProduct.keys()].filter((productId) => (input.locked === null || input.locked.has(productId))
    && ownCategoryFields({
      productOwnFields: input.scope.facts.products.get(productId)?.ownFields,
      sizeLeftovers: (sizesByProduct.get(productId) ?? []).map((sizeId) => input.leftovers.get(sizeId) ?? []),
    }).some((field) => fields.has(field)))
    .sort((left, right) => left - right);
}

/** The derived set must be the one the vendor was shown (plan P20); returns it. */
function assertClearSet(storeConnectionId: number, input: StoredCategoryPriceInput, derived: number[]): number[] {
  const differ = symmetricDifference(derived, input.clear?.products.map((product) => product.productId) ?? []);
  if (differ.length > 0) {
    throw productSetConflict(storeConnectionId, input.categoryId, differ,
      `Which products have their own values in this category changed after you opened it. Reload it before checking prices again. ${CATALOG_DELAY_NOTE}`);
  }
  return derived;
}

/**
 * Each cleared product at the revision the vendor was shown (plan P20), from
 * the text-free facts, so a stale one is refused before any write: 8a's
 * product version conflict, in its shape. The bulk writer's compare-and-set
 * stays the backstop.
 */
function assertClearedRevisions(storeConnectionId: number, input: StoredCategoryPriceInput, facts: ListingSettingFacts): void {
  const conflicts = (input.clear?.products ?? []).flatMap((product) => {
    const actualRevisionId = facts.products.get(product.productId)?.revisionId ?? null;
    return actualRevisionId === product.expectedRevisionId ? []
      : [{ productId: product.productId, expectedRevisionId: product.expectedRevisionId, actualRevisionId }];
  });
  if (conflicts.length > 0) {
    throw permanent("DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT",
      "Listing settings of products in this category changed after you opened them. Reload them before checking prices again.", {
        storeConnectionId, categoryId: input.categoryId, conflicts: conflicts.slice(0, MAX_LISTED_SIZES), conflictCount: conflicts.length,
      });
  }
}

// ---------------------------------------------------------------------------
// The apply's writes
// ---------------------------------------------------------------------------

/**
 * The products and patch of the apply's one bulk call (plan 9.7 step 11 (b)):
 * the products kind's price on every product in scope that exists (the
 * locked ones), each at its current revision; a release-only apply names
 * none; a category apply names the derived clear set, each at the revision
 * the vendor was shown, with every cleared setting reset. Nothing named,
 * nothing patched (the ledger row is still written).
 */
function bulkRequest(subject: PriceChangeSubject, input: {
  revisions: ListingSettingFacts | null; locked: ReadonlySet<number>; cleared: readonly number[];
}): { products: Array<{ productId: number; expectedRevisionId: number | null }>; patch: ProductListingSettingPriceApplyPatch } {
  if (subject.kind === "product_prices") {
    const { price } = subject.input;
    if (price === undefined) return { products: [], patch: {} };
    if (input.revisions === null) throw listingSettingsInvariantFailed("A price apply's products were not read before the bulk write.");
    const products = subject.input.productIds.filter((id) => input.locked.has(id))
      .map((productId) => ({ productId, expectedRevisionId: input.revisions!.products.get(productId)?.revisionId ?? null }));
    return { products, patch: products.length === 0 ? {} : { price } };
  }
  const { clear } = subject.input;
  if (!clear || input.cleared.length === 0) return { products: [], patch: {} };
  // The set equals the stored clear list (assertClearSet), so each product keeps the revision the vendor saw.
  return {
    products: clear.products.map((product) => ({ productId: product.productId, expectedRevisionId: product.expectedRevisionId })),
    patch: Object.fromEntries(clear.fields.map((field) => [field, null])) as ProductListingSettingPriceApplyPatch,
  };
}

/** The bulk call's products before any lock (review): every product it can name. */
function bulkProductIds(subject: PriceChangeSubject): number[] {
  if (subject.kind === "product_prices") return subject.input.price === undefined ? [] : [...subject.input.productIds];
  return subject.input.clear?.products.map((product) => product.productId) ?? [];
}

/** The products the stored input names, for lockCatalog. */
function inputProductIds(subject: PriceChangeSubject): number[] {
  return subject.kind === "product_prices" ? [...subject.input.productIds]
    : subject.input.clear?.products.map((product) => product.productId) ?? [];
}

interface ReleasedSize { productVariantId: number; beforeRevisionId: number; afterRevisionId: number }

/**
 * Each released size through W9's own flow, ascending (plan 9.7 step 11 (c),
 * D29): `inherit`, at the revision the review showed, under the size child
 * key, after the product rows, so W9 judges it against the new recipe (P24).
 * Every refusal stops the apply and rolls it back: after the hash compare
 * none is expected (HYPOTHESIS, pinned by a test). A replay or a missing
 * revision in a new request is a fault.
 */
async function releaseExactPrices(tx: ListingSettingWriteTransaction, input: {
  storeConnectionId: number; requestHash: string; now: Date; rows: readonly PriceChangeRow[];
}): Promise<ReleasedSize[]> {
  const released: ReleasedSize[] = [];
  for (const row of input.rows) {
    const expectedRevisionId = row.settingRevisionId;
    if (expectedRevisionId === null) {
      throw listingSettingsInvariantFailed("A released size has no saved price revision.", { productVariantId: row.productVariantId });
    }
    let result: Awaited<ReturnType<typeof saveListingPriceInTransaction>>;
    try {
      result = await saveListingPriceInTransaction(tx.sizePrice(row.productVariantId),
        { storeConnectionId: input.storeConnectionId, productVariantId: row.productVariantId },
        { priceCents: null, pricingMode: "inherit", expectedRevisionId,
          idempotencyKey: listingSettingChildKey(tx.requestKey, "size", row.productVariantId) },
        input.requestHash, input.now);
    } catch (error) {
      throw namingSize(error, input.storeConnectionId, row.productVariantId);
    }
    if (result.idempotentReplay || result.price.revisionId === null) {
      throw listingSettingsInvariantFailed("A released size in a new price apply replayed or saved no revision.", {
        productVariantId: row.productVariantId,
      });
    }
    released.push({ productVariantId: row.productVariantId, beforeRevisionId: expectedRevisionId, afterRevisionId: result.price.revisionId });
  }
  return released;
}

/** The answer and the log line's revisions of an apply that wrote. */
function appliedWrite(input: {
  subject: PriceChangeSubject; reviewId: string; vendorId: number;
  category: Awaited<ReturnType<ListingSettingWriteTransaction["saveCategory"]>> | null;
  saved: ProductListingSettingsBulkResult; expected: ReadonlyArray<{ productId: number; expectedRevisionId: number | null }>;
  releases: readonly ReleasedSize[]; leftovers: ClearSizeLeftoversResult | null; textBytes: number; rowsBytes: number;
}): ApplyWrite {
  const { subject, category, saved, releases } = input;
  const categoryId = subject.kind === "category_price" ? subject.input.categoryId : null;
  const categoryChanged = category?.outcome === "changed";
  const expected = new Map(input.expected.map((product) => [product.productId, product.expectedRevisionId]));
  const clearedSizeCount = input.leftovers?.clearedSizeCount ?? 0;
  const changed = categoryChanged || saved.changed.length > 0 || releases.length > 0 || clearedSizeCount > 0;
  return {
    response: {
      outcome: changed ? "changed" : "unchanged",
      reviewId: input.reviewId,
      requestId: saved.requestId,
      changedProductCount: saved.changed.length,
      releasedSizeCount: releases.length,
      categoryRevisionId: categoryId === null ? null : category?.row?.revisionId ?? null,
    },
    vendorId: input.vendorId,
    kind: subject.kind,
    categoryId,
    // Compare-and-set wrote each over the revision it expected, so that is its before.
    before: [
      ...(categoryChanged ? [{ category_id: categoryId, revision_id: category?.before?.revisionId ?? null }] : []),
      ...saved.changed.map((entry) => ({ product_id: entry.productId, revision_id: expected.get(entry.productId) ?? null })),
      ...releases.map((size) => ({ product_variant_id: size.productVariantId, revision_id: size.beforeRevisionId })),
    ],
    after: [
      ...(categoryChanged ? [{ category_id: categoryId, revision_id: category?.row?.revisionId ?? null }] : []),
      ...saved.changed.map((entry) => ({ product_id: entry.productId, revision_id: entry.revisionId })),
      ...releases.map((size) => ({ product_variant_id: size.productVariantId, revision_id: size.afterRevisionId })),
    ],
    changedCount: (categoryChanged ? 1 : 0) + saved.changed.length + releases.length,
    leftovers: input.leftovers,
    textBytes: input.textBytes,
    rowsBytes: input.rowsBytes,
  };
}

/**
 * A replay calls no writer (plan P16, P36): the ledger row, the category
 * revision and the released sizes the key wrote. A category apply that left
 * its category unchanged wrote no category revision; 8a answered it only
 * after its compare-and-set found the revision the review expected, so that
 * is the first answer's (W12's rule, with no read beyond the review the
 * classifier needed). Nothing is counted but the releases.
 */
function replayed(use: RequestKeyUse, vendorId: number, reviewId: string, known: LoadedPriceChangeReview | null): ApplyWrite {
  if (!use.ledger) throw listingSettingsInvariantFailed("A price apply replay has no ledger row.", { reviewId });
  const categoryId = known?.kind === "category_price" ? known.input.categoryId : null;
  const sizes = use.children.filter((child) => child.kind === "size")
    .sort((left, right) => left.productVariantId - right.productVariantId);
  const categoryRevisionId = use.categoryRevision?.revisionId ?? (known?.kind === "category_price" ? known.input.expectedRevisionId : null);
  return {
    response: { outcome: "replayed", reviewId, requestId: use.ledger.requestId, changedProductCount: null,
      releasedSizeCount: sizes.length, categoryRevisionId },
    vendorId,
    kind: known?.kind ?? null,
    categoryId,
    before: [],
    after: [
      ...(use.categoryRevision ? [{ category_id: use.categoryRevision.categoryId, revision_id: use.categoryRevision.revisionId }] : []),
      ...sizes.map((size) => ({ product_variant_id: size.productVariantId, revision_id: size.revisionId })),
    ],
    changedCount: 0,
    leftovers: null,
    textBytes: null,
    rowsBytes: null,
  };
}

/** The category's change as the settings store it: the price and the resolved values, as stored at review. A fault if not. */
function storedCategoryPatch(input: StoredCategoryPriceInput): CategoryListingSettingPatch {
  const parsed = categoryListingSettingPatchSchema.safeParse(input.patch);
  if (!parsed.success) {
    throw listingSettingsInvariantFailed("A stored category price change failed the category contract.", {
      categoryId: input.categoryId, issues: issueCodes(parsed.error.issues),
    });
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * The stored input (plan P22, 9.4): the route input without its kind, every
 * list in one order (ids ascending, cleared settings in the stored shape's
 * order), the category's eBay values resolved. Parsed with the stored schema:
 * every bound was checked before, so a failure is a fault.
 */
function storedSubject(parsed: ReviewPriceChangesInput, ebay: ListingSettingEbayResolution | null): PriceChangeSubject {
  if (parsed.kind === "product_prices") {
    const input = {
      productIds: [...parsed.productIds].sort((left, right) => left - right),
      ...(parsed.price === undefined ? {} : { price: parsed.price }),
      ...(parsed.releaseExactPrices === undefined ? {} : { releaseExactPrices: parsed.releaseExactPrices }),
    };
    return { kind: "product_prices", input: storedInput("product_prices", input) };
  }
  if (ebay?.status === "skipped") {
    // The review's preflight has no key, so it never skips eBay.
    throw listingSettingsInvariantFailed("A price check's eBay step was skipped.", { categoryId: parsed.categoryId });
  }
  const values = ebay?.status === "resolved" ? ebay.values : {};
  const { patch } = parsed;
  const stored: Record<string, unknown> = { price: patch.price };
  if (patch.ebayCategory !== undefined) stored.ebayCategory = patch.ebayCategory === null ? null : ebayValue(values.ebayCategory, "ebayCategory");
  if (patch.storeShelf !== undefined) {
    stored.storeShelf = patch.storeShelf === null ? null : patch.storeShelf.mode === "none" ? { mode: "none" }
      : ebayValue(values.storeShelf, "storeShelf");
  }
  for (const field of LISTING_SETTING_POLICY_FIELDS) {
    const sent = patch[field];
    if (sent !== undefined) stored[field] = sent === null ? null : ebayValue(values[field], field);
  }
  if (patch.textAbove !== undefined) stored.textAbove = patch.textAbove;
  if (patch.textBelow !== undefined) stored.textBelow = patch.textBelow;
  const ordered = Object.fromEntries(CATEGORY_LISTING_SETTING_FIELDS.filter((field) => field in stored).map((field) => [field, stored[field]]));
  const input = {
    categoryId: parsed.categoryId,
    expectedRevisionId: parsed.expectedRevisionId,
    patch: ordered,
    ...(parsed.clear === undefined ? {} : { clear: {
      fields: PRICE_CHANGE_CLEAR_FIELDS.filter((field) => parsed.clear!.fields.includes(field)),
      products: [...parsed.clear.products].sort((left, right) => left.productId - right.productId),
    } }),
  };
  return { kind: "category_price", input: storedInput("category_price", input) };
}

function storedInput<K extends PriceChangeReviewKind>(kind: K, input: unknown): K extends "product_prices" ? StoredProductPricesInput
  : StoredCategoryPriceInput {
  const parsed = storedInputSchemaFor(kind).safeParse(input);
  if (!parsed.success) {
    throw listingSettingsInvariantFailed("A price check's input failed the stored contract after its checks.", {
      kind, issues: issueCodes(parsed.error.issues),
    });
  }
  return parsed.data as K extends "product_prices" ? StoredProductPricesInput : StoredCategoryPriceInput;
}

function subjectOf(review: StoredPriceChangeReview): PriceChangeSubject {
  return review.kind === "product_prices" ? { kind: review.kind, input: review.input } : { kind: review.kind, input: review.input };
}

/**
 * The review preflight (plan 9.5 step 2): the gate, then the category's
 * stored eBay values (an id the category already stores keeps its stored
 * value, with no eBay call) and the marketplace. A review has no key, so
 * there is no probe and no skip.
 */
async function readReviewPreflight(tx: ListingSettingPreflightTransaction, input: { categoryId: number }):
  Promise<ListingSettingEbayPreflight & { vendorId: number }> {
  const context = await authorizeListingSettingWrite(tx);
  const known = (await tx.loadCategories([input.categoryId])).get(input.categoryId)?.values ?? null;
  const marketplaceId = resolveMarketplaceId(await tx.catalog.getStoreListingConfig(tx.storeConnectionId));
  return { vendorId: tx.vendorId, keyIsNew: true, storeStatus: context.storeStatus, marketplaceId, known };
}

/** The server's review id, as the apply takes it back: anything else from `newId` is a fault. */
function issuedReviewId(value: string): string {
  if (!priceChangeReviewIdSchema.safeParse(value).success) {
    throw listingSettingsInvariantFailed("A new price check id is not a lowercase uuid.");
  }
  return value;
}

/** An eBay value the eBay step must have built for a set id; missing means the steps ran out of order. */
function ebayValue<T>(value: T | null | undefined, field: string): T {
  if (value === undefined || value === null) {
    throw listingSettingsInvariantFailed("A price check set an eBay value the eBay step did not build.", { field });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Errors (each with its class, CLAUDE.md §6; every code is in the write table, plan 9.9)
// ---------------------------------------------------------------------------

function permanent(code: string, message: string, context: Record<string, unknown>): DropshipError {
  return new DropshipError(code, message, { ...context, retryable: false, classification: "permanent" });
}

function reviewNotFound(storeConnectionId: number, reviewId: string): DropshipError {
  return permanent("DROPSHIP_PRICING_REVIEW_NOT_FOUND", "This price check was not found for this store. Check prices again.",
    { storeConnectionId, reviewId });
}

/** The review was applied under another request key (W1's rule): applying it again would apply one check twice. */
function reviewAlreadyApplied(storeConnectionId: number, reviewId: string): DropshipError {
  return permanent("DROPSHIP_IDEMPOTENCY_CONFLICT", "This price check was already applied. Check prices again to make another change.",
    { storeConnectionId, reviewId });
}

function categoryNotFound(storeConnectionId: number, categoryId: number): DropshipError {
  return permanent("DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", "This Card Shellz category was not found. Reload the page.",
    { storeConnectionId, categoryId });
}

function categoryVersionConflict(storeConnectionId: number, categoryId: number, expectedRevisionId: number | null,
  actualRevisionId: number | null): DropshipError {
  return permanent("DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT",
    "This category's listing settings changed after you opened them. Reload them before checking prices again.", {
      storeConnectionId, categoryId, conflicts: [{ categoryId, expectedRevisionId, actualRevisionId }], conflictCount: 1,
    });
}

/** 8a's product version conflict, naming the products whose membership or own values moved (plan P20). */
function productSetConflict(storeConnectionId: number, categoryId: number, productIds: readonly number[], message: string): DropshipError {
  return permanent("DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", message, {
    storeConnectionId, categoryId, conflicts: productIds.slice(0, MAX_LISTED_SIZES).map((productId) => ({ productId })),
    conflictCount: productIds.length,
  });
}

/**
 * P35: the review's rows are at most 10,000 (the reviews table's rows CHECK,
 * 0659). No `sizeCount`: the chosen check stops at the first size over the
 * bound, so the scope's full count is never known (the store-wide scan's
 * same refusal names none either, dropship-selected-catalog.ts).
 */
function priceCheckTooLarge(storeConnectionId: number): DropshipError {
  return permanent("DROPSHIP_LISTING_SETTINGS_TOO_LARGE", "This price check covers more than 10,000 sizes. Choose fewer products.",
    { storeConnectionId });
}

/**
 * Plan 9.7's memory stop rule: the stored text and the review's rows together
 * pass MAX_BULK_TEXT_BYTES. Same code as the text-only refusal, but its own
 * words, and `reason: "price_check_rows"` says that `textBytes` is the text
 * and the rows together: the text alone can be under the budget, so
 * "shorten the text" would be the wrong advice. Fewer products fit.
 */
function priceCheckTooHeavy(storeConnectionId: number, countedBytes: number, productCount: number): DropshipError {
  return permanent("DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE",
    "This price check covers too many sizes and too much listing text to apply at once. Choose fewer products.", {
      storeConnectionId, reason: "price_check_rows", textBytes: countedBytes, maxTextBytes: MAX_BULK_TEXT_BYTES, productCount,
    });
}

/** P24: each release is one W9 flow, so one apply releases at most MAX_PRICE_RELEASES_PER_APPLY. */
function releaseLimit(storeConnectionId: number, releaseCount: number): DropshipError {
  return permanent("DROPSHIP_LISTING_PRICE_RELEASE_LIMIT",
    `This price check would release ${releaseCount} exact prices; at most ${MAX_PRICE_RELEASES_PER_APPLY} can be released at once. Choose fewer products.`,
    { storeConnectionId, releaseCount, maxReleases: MAX_PRICE_RELEASES_PER_APPLY });
}

/**
 * R:§8.6 rule 1: a size with a usable price keeps one; every refused size
 * named, with the row's issues as its `blockers` (the codes of why the after
 * price is missing or blocked: the rule's issue and the Card Shellz limits).
 */
function wouldBeLost(storeConnectionId: number, refused: readonly PriceChangeRow[]): DropshipError {
  const sizes = refused.map((row) => ({ productVariantId: row.productVariantId, beforePriceCents: row.previousPriceCents,
    afterPriceCents: row.priceCents, refusal: row.refusal, blockers: row.issues }));
  const one = sizes.length === 1;
  return permanent(WOULD_BE_LOST, `${one ? "1 size" : `${sizes.length} sizes`} would be left without a price it can be listed at. `
    + `Change the price check, or type an exact price for ${one ? "it" : "them"} first.`,
  { storeConnectionId, sizes: sizes.slice(0, MAX_LISTED_SIZES), sizeCount: sizes.length });
}

/** A W9 size refusal that names no size, rethrown with the same code and words and the size; anything else unchanged. */
function namingSize(error: unknown, storeConnectionId: number, productVariantId: number): unknown {
  if (!(error instanceof DropshipError) || !SIZE_REFUSALS.has(error.code)) return error;
  if (typeof error.context?.productVariantId === "number") return error;
  return new DropshipError(error.code, error.message, {
    ...error.context, storeConnectionId, productVariantId, retryable: false, classification: "permanent",
  });
}

/**
 * The sizes whose recomputed row is not the stored one: missing, extra or
 * differing, ascending. Both sides are compared as the row schema parses
 * them, so key order never makes two equal rows differ.
 */
function movedSizes(stored: readonly PriceChangeRow[], current: readonly PriceChangeRow[]): Array<Record<string, number | null>> {
  const canonical = (row: PriceChangeRow) => JSON.stringify(priceChangeRowSchema.parse(row));
  const now = new Map(current.map((row) => [row.productVariantId, canonical(row)]));
  const then = new Map(stored.map((row) => [row.productVariantId, canonical(row)]));
  const priceOf = (rows: readonly PriceChangeRow[]) => new Map(rows.map((row) => [row.productVariantId, row.priceCents]));
  const nowPrices = priceOf(current);
  const thenPrices = priceOf(stored);
  const moved: Array<Record<string, number | null>> = [];
  for (const id of uniqueAscending([...then.keys(), ...now.keys()])) {
    const before = then.get(id);
    const after = now.get(id);
    if (before !== undefined && before === after) continue;
    moved.push({
      productVariantId: id,
      ...(before === undefined ? {} : { expectedPriceCents: thenPrices.get(id) ?? null }),
      ...(after === undefined ? {} : { priceCents: nowPrices.get(id) ?? null }),
    });
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The .ops cost as a money amount, or null when it is unavailable or out of contract. */
function availableCostCents(cost: DropshipProductCost | null): number | null {
  if (cost?.status !== "available") return null;
  const parsed = pricingAmountCentsSchema.safeParse(cost.unitCostCents);
  return parsed.success ? parsed.data : null;
}

/** W1's basis amount: null when no recipe chose the price or the amount is missing. */
function basisAmountCents(basis: RulePriceBasis | null, amounts: { productCostCents: number | null; catalogRetailCents: number | null }): number | null {
  if (basis === null) return null;
  const amount = pricingAmountCentsSchema.safeParse(pricingBasisCents(basis, amounts));
  return amount.success ? amount.data : null;
}

function sizeIdOf(row: unknown): number {
  const id = row !== null && typeof row === "object" ? (row as { productVariantId?: unknown }).productVariantId : undefined;
  return typeof id === "number" ? id : Number.NaN;
}

function issueCodes(issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; code: string }>): Array<{ path: string; code: string }> {
  return issues.slice(0, MAX_LISTED_SIZES).map((issue) => ({ path: issue.path.join("."), code: issue.code }));
}

function uniqueAscending(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((left, right) => left - right);
}

function symmetricDifference(left: readonly number[], right: readonly number[]): number[] {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return uniqueAscending([...left.filter((id) => !rightSet.has(id)), ...right.filter((id) => !leftSet.has(id))]);
}

function elapsedMs(timer: () => number, started: number): number {
  return Math.max(0, Math.round(timer() - started));
}
