import {
  categoryListingSettingPatchSchema,
  type CategoryListingSettingPatch,
} from "../../../../shared/dropship/listing-setting-values";
import {
  CATEGORY_CLEAR_FIELDS,
  MAX_BULK_TEXT_BYTES,
  saveCategorySettingsInputSchema,
  type CategoryClearField,
  type CategorySettingsPatchInput,
  type SaveCategorySettingsResponse,
} from "../../../../shared/dropship/listing-setting-writes";
import { DropshipError } from "../domain/errors";
import { classifyRequestKeyUse, type RequestKeyUse } from "../domain/listing-setting-request-key-use";
import { LISTING_SETTING_LEFTOVER_FIELDS, listingSettingsInvariantFailed, type ListingSettingLeftoverField } from "../domain/listing-setting-values";
import { resolveMarketplaceId } from "./dropship-ebay-listing-setup-service";
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
  listingSettingRequestKeyChanged,
  listingSettingStoreIdSchema,
  listingSettingWriteHash,
  loadChosenSizes,
  parseListingSettingInput,
  requestKeyUsePath,
  type ListingSettingHeavyWriteGate,
  type ListingSettingWriteLog,
} from "./dropship-listing-setting-write-support";
import type {
  ClearSizeLeftoversResult,
  ListingSettingPreflightTransaction,
  ListingSettingWriteRepository,
  ListingSettingWriteTransaction,
  ProductListingSettingsBulkResult,
} from "./dropship-listing-setting-writes";
import { ownCategoryFields } from "./dropship-listing-settings-facts";
import { LISTING_SETTINGS_CACHE_TTL_MS } from "./dropship-listing-settings-service";
import type { DropshipClock } from "./dropship-ports";

/**
 * W12, one Card Shellz category's settings (Listing settings design 8.5;
 * plan PR 9, section 8.5), with "Also clear theirs": the category's products
 * that hold their own value in a cleared setting lose it, so every one of them
 * follows the category. All or nothing, in one transaction.
 *
 * 1. Parse and hash the route body (ids only), with one clock reading.
 * 2. When the change sets an eBay id: a read-only preflight (the gate, the
 *    replay probe, the category's stored eBay values, the marketplace), then
 *    eBay for ids the category does not store yet ("known" = the category
 *    row's, plan 8.4); "Use store default" never asks eBay.
 * 3. The write transaction, inside the heavy-write gate when it clears (plan
 *    3.10: it copies every cleared product's stored texts into new revisions):
 *    the gate, the replay probe (a replay is answered from it, with no writer),
 *    D16 (no older group rules), the category's products unlocked, then
 *    lockCatalog, then the chosen check. When clearing: the category's
 *    products read again under the locks, the per-size leftovers under the old
 *    writers' feature locks, the text-free settings facts, the derived set
 *    (which must be the one the vendor was shown) and the text budget. Then
 *    the category row, the products' clear (one bulk call) and the per-size
 *    clean-ups.
 * 4. One INFO line after commit.
 *
 * READ COMMITTED like every PR 9 writer (plan P3, overriding R:§8.5 W12's
 * "SERIALIZABLE"). No price: a category price goes through the price check,
 * W7 (plan P34); the route schema has no `price`, and the stored patch copies
 * only the eBay fields and the texts (storedCategoryPatch).
 */

export interface DropshipListingCategorySettingsServiceDependencies {
  repository: ListingSettingWriteRepository;
  ebay: ListingSettingEbayPort;
  /** The process's one heavy-write gate (plan 3.10 (a)), shared with every heavy writer; taken only when clearing. */
  heavyWrites: ListingSettingHeavyWriteGate;
  clock: DropshipClock;
  /** Monotonic milliseconds, for `elapsed_ms` and `ebay_ms` only; the write's time is `clock`, read once. */
  timer: () => number;
  log: ListingSettingWriteLog;
}

/** The writer's versioned operation in the request hash (plan 3.7). */
const CATEGORY_SETTINGS_OPERATION = "category_settings_v1";
const PRODUCT_VERSION_CONFLICT = "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT";
/**
 * The set conflicts' second sentence. The category view is cached for up to
 * LISTING_SETTINGS_CACHE_TTL_MS, and its key does not cover what Card Shellz
 * owns (a product's category, sizes' sellability, exposure windows; Listing
 * settings design 8.4), so after a Card Shellz change a reload can show the
 * same set, and so the same 409, until the cached view expires.
 */
const CATALOG_DELAY_NOTE = `A change Card Shellz made can take up to ${Math.ceil(LISTING_SETTINGS_CACHE_TTL_MS / 1_000)} seconds to show.`;

type ClearProduct = { productId: number; expectedRevisionId: number | null };
/** The parsed "Also clear theirs": fields in the stored shape's order, products ascending. */
interface CategoryClear {
  fields: CategoryClearField[];
  products: ClearProduct[];
}

/** What the transaction did, for the answer and the log line. */
interface CategorySettingsWrite {
  response: SaveCategorySettingsResponse;
  vendorId: number;
  /** The category's revision before the save: null when it had no row, and on a replay. */
  categoryBefore: number | null;
  categoryChanged: boolean;
  /** The category revision the key wrote: the new one when the save changed it, the key's own on a replay; else null. */
  categoryWritten: number | null;
  changedFields: string[];
  /** The clear's ledger row; null when nothing was cleared, and the probe's on a replay. */
  requestId: number | null;
  cleared: ProductListingSettingsBulkResult["changed"];
  leftovers: ClearSizeLeftoversResult | null;
}

export class DropshipListingCategorySettingsService {
  constructor(private readonly deps: DropshipListingCategorySettingsServiceDependencies) {}

  async saveForMember(memberId: string, storeId: unknown, categoryIdInput: unknown, body: unknown): Promise<SaveCategorySettingsResponse> {
    assertListingSettingMember(memberId);
    const storeConnectionId = parseListingSettingInput(listingSettingStoreIdSchema, storeId);
    const categoryId = parseListingSettingInput(listingSettingStoreIdSchema, categoryIdInput);
    const parsed = parseListingSettingInput(saveCategorySettingsInputSchema, body);
    const started = this.deps.timer();
    const now = this.deps.clock.now();
    // Fields in the stored shape's order and products ascending: the hash does not depend on the order sent.
    const clear: CategoryClear | null = parsed.clear === undefined ? null : {
      fields: CATEGORY_CLEAR_FIELDS.filter((field) => parsed.clear!.fields.includes(field)),
      products: [...parsed.clear.products].sort((left, right) => left.productId - right.productId),
    };
    const { patch } = parsed;
    const requestHash = listingSettingWriteHash(CATEGORY_SETTINGS_OPERATION, {
      storeConnectionId, categoryId, expectedRevisionId: parsed.expectedRevisionId, patch, clear,
    });
    const request = { memberId, storeConnectionId, idempotencyKey: parsed.idempotencyKey };

    // eBay is asked only for ids the category does not store yet, outside any transaction and the gate.
    let ebay: ListingSettingEbayResolution | null = null;
    let ebayMs: number | null = null;
    if (setsListingSettingEbayId(patch)) {
      const preflight = await this.deps.repository.preflight(request,
        (tx) => readPreflight(tx, { storeConnectionId, categoryId, requestHash }));
      const ebayStarted = this.deps.timer();
      ebay = await resolveListingSettingEbayValues(this.deps.ebay, { vendorId: preflight.vendorId, storeConnectionId, patch, preflight });
      if (ebay.status === "resolved" && ebay.askedEbay) ebayMs = elapsedMs(this.deps.timer, ebayStarted);
    }

    const write = () => this.deps.repository.execute(request, (tx) => this.write(tx, {
      storeConnectionId, categoryId, requestHash, now, expectedRevisionId: parsed.expectedRevisionId, patch, clear, ebay,
    }));
    // Heavy only when it clears (plan 3.10): the bulk clear copies each cleared product's stored texts.
    const result = clear === null ? await write() : await this.deps.heavyWrites.run(write);

    this.log(result, { memberId, storeConnectionId, categoryId, requestKey: parsed.idempotencyKey, clear,
      elapsedMs: elapsedMs(this.deps.timer, started), ebayMs });
    return result.response;
  }

  private async write(tx: ListingSettingWriteTransaction, input: {
    storeConnectionId: number; categoryId: number; requestHash: string; now: Date; expectedRevisionId: number | null;
    patch: CategorySettingsPatchInput; clear: CategoryClear | null; ebay: ListingSettingEbayResolution | null;
  }): Promise<CategorySettingsWrite> {
    const { storeConnectionId, categoryId, clear } = input;
    await authorizeListingSettingWrite(tx);
    // Replay before re-reading anything (plan P16): a retry of a committed save is answered from what it wrote.
    const use = await tx.findRequestKeyUse();
    const decision = classifyRequestKeyUse(use, { writer: "category_settings", storeConnectionId, requestHash: input.requestHash, categoryId });
    if (requestKeyUsePath(decision, { storeConnectionId }) === "replay") return replayed(use, tx.vendorId, categoryId, input.expectedRevisionId);
    // The preflight saw this key used and asked eBay nothing; its eBay values are not known, so they are never written.
    if (input.ebay?.status === "skipped") throw listingSettingRequestKeyChanged(storeConnectionId);

    // D16 after the probe, so a committed save still replays after a group rule is added (plan 8.5 step 3).
    const groups = await tx.loadOlderGroupRuleCounts();
    if (groups.pricingGroups > 0 || groups.contentGroups > 0 || groups.ebayCategoryRules > 0) {
      throw listingSettingOlderRulesPresent(storeConnectionId, groups);
    }

    // The locks before the chosen check (v3r, C-money-6): membership needs no chosen check to be read, and the
    // category row, its products and the products the vendor was shown are held FOR SHARE from here.
    const products = await tx.listCategoryProductIds(categoryId);
    const { lockedProductIds } = await tx.lockCatalog({ categoryIds: [categoryId],
      productIds: [...new Set([...products, ...(clear?.products.map((product) => product.productId) ?? [])])] });
    // Ids only (v3r, C-money-8, C-feas-14); one chosen size is all a save without a clear asks.
    const chosen = await loadChosenSizes(tx, await tx.listProductSizes(products), input.now, { keepCandidates: false, firstOnly: clear === null });
    if (chosen.length === 0) {
      throw new DropshipError("DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", "This category has no chosen product in this store. Reload the page.", {
        storeConnectionId, categoryId, retryable: false, classification: "permanent",
      });
    }

    const cleared = clear === null ? null : await this.deriveClearSet(tx, {
      storeConnectionId, categoryId, clear, products, lockedProductIds, chosen,
    });

    const saved = await tx.saveCategory({ categoryId, expectedRevisionId: input.expectedRevisionId,
      patch: storedCategoryPatch(input.patch, input.ebay), requestHash: input.requestHash, now: input.now });
    if (saved.outcome === "replayed") {
      throw listingSettingsInvariantFailed("A category save in a new listing settings request replayed.", { categoryId });
    }

    let bulk: ProductListingSettingsBulkResult | null = null;
    let leftovers: ClearSizeLeftoversResult | null = null;
    if (clear !== null && cleared !== null && cleared.length > 0) {
      // One call over the vendor's set: clearing a setting a product does not hold is a no-op merge (plan P20).
      bulk = await tx.saveProductsBulk({ operation: "category_settings_clear", products: clear.products,
        patch: clearedPatch(clear.fields), requestHash: input.requestHash, now: input.now });
      if (bulk.outcome === "replayed") {
        throw listingSettingsInvariantFailed("A category clear in a new listing settings request replayed.", { requestId: bulk.requestId });
      }
      // The leftovers of the cleared policies and shelf, on every size of the set (plan P17); the set is locked products only.
      const leftoverFields = LISTING_SETTING_LEFTOVER_FIELDS.filter((field): field is CategoryClearField & ListingSettingLeftoverField =>
        (clear.fields as readonly string[]).includes(field));
      if (leftoverFields.length > 0) {
        leftovers = await tx.clearSizeLeftovers({ productIds: cleared, fields: leftoverFields, requestHash: input.requestHash, now: input.now });
      }
    }

    const categoryChanged = saved.outcome === "changed";
    // Every product of the set held an own value in a cleared setting, now removed (its row or its sizes' leftovers).
    const clearedProductCount = cleared?.length ?? 0;
    return {
      response: {
        outcome: categoryChanged || clearedProductCount > 0 ? "changed" : "unchanged",
        categoryId,
        revisionId: saved.row?.revisionId ?? null,
        clearedProductCount,
      },
      vendorId: tx.vendorId,
      categoryBefore: saved.before?.revisionId ?? null,
      categoryChanged,
      categoryWritten: categoryChanged ? saved.row?.revisionId ?? null : null,
      changedFields: saved.changedFields,
      requestId: bulk?.requestId ?? null,
      cleared: bulk?.changed ?? [],
      leftovers,
    };
  }

  /**
   * The set "Also clear theirs" clears (plan P20, 8.5 step 6), derived under
   * the locks: the category's products read again (a product moved in or out
   * since the first read is a version conflict), the leftovers under the old
   * writers' feature locks, the text-free settings facts, then the chosen,
   * locked products with an own value in a cleared setting (ownCategoryFields,
   * the read's own rule). It must be the set the vendor was shown. Then the
   * text budget over the set's stored text (patch bytes 0: the clear sets only
   * nulls). Returns the set, ascending; nothing is written here.
   */
  private async deriveClearSet(tx: ListingSettingWriteTransaction, input: {
    storeConnectionId: number; categoryId: number; clear: CategoryClear; products: readonly number[];
    lockedProductIds: readonly number[]; chosen: ReadonlyArray<{ productVariantId: number; productId: number }>;
  }): Promise<number[]> {
    const { storeConnectionId, categoryId, clear } = input;
    const moved = symmetricDifference(input.products, await tx.listCategoryProductIds(categoryId));
    if (moved.length > 0) {
      throw productSetConflict(storeConnectionId, categoryId, moved,
        `The products in this category changed after you opened it. Reload it before saving again. ${CATALOG_DELAY_NOTE}`);
    }
    const leftovers = await tx.loadLeftoverFields(input.chosen.map((size) => size.productVariantId));
    const facts = await tx.loadSettingFacts({ productIds: input.products });

    const sizesByProduct = new Map<number, number[]>();
    for (const size of input.chosen) sizesByProduct.set(size.productId, [...(sizesByProduct.get(size.productId) ?? []), size.productVariantId]);
    const locked = new Set(input.lockedProductIds);
    const fields = new Set<string>(clear.fields);
    const derived = [...sizesByProduct.keys()].filter((productId) => locked.has(productId)
      && ownCategoryFields({
        productOwnFields: facts.products.get(productId)?.ownFields,
        sizeLeftovers: (sizesByProduct.get(productId) ?? []).map((sizeId) => leftovers.get(sizeId) ?? []),
      }).some((field) => fields.has(field)))
      .sort((left, right) => left - right);
    const differ = symmetricDifference(derived, clear.products.map((product) => product.productId));
    if (differ.length > 0) {
      throw productSetConflict(storeConnectionId, categoryId, differ,
        `Which products have their own values in this category changed after you opened it. Reload it before saving again. ${CATALOG_DELAY_NOTE}`);
    }

    const bytes = await tx.readListingTextBytes({ productIds: derived, replacedFields: { textAbove: false, textBelow: false, mainText: false } });
    if (bytes.targetBytes > MAX_BULK_TEXT_BYTES) {
      throw listingSettingBulkTooLarge(storeConnectionId, bytes.targetBytes, MAX_BULK_TEXT_BYTES, derived.length);
    }
    return derived;
  }

  private log(write: CategorySettingsWrite, context: {
    memberId: string; storeConnectionId: number; categoryId: number; requestKey: string; clear: CategoryClear | null;
    elapsedMs: number; ebayMs: number | null;
  }): void {
    const { response } = write;
    const replayedSave = response.outcome === "replayed";
    // Compare-and-set wrote each cleared product over the revision the vendor sent, so that is its before.
    const expected = new Map((context.clear?.products ?? []).map((product) => [product.productId, product.expectedRevisionId]));
    const before = [
      ...(write.categoryChanged ? [{ category_id: context.categoryId, revision_id: write.categoryBefore }] : []),
      ...write.cleared.map((entry) => ({ product_id: entry.productId, revision_id: expected.get(entry.productId) ?? null })),
    ];
    // What the key wrote: a clear-only replay answers the category's revision, but the key wrote none for it.
    const after = [
      ...(write.categoryWritten === null ? [] : [{ category_id: context.categoryId, revision_id: write.categoryWritten }]),
      ...write.cleared.map((entry) => ({ product_id: entry.productId, revision_id: entry.revisionId })),
    ];
    this.deps.log.info("dropship.listing_settings.category_saved", {
      outcome: response.outcome,
      vendor_id: write.vendorId,
      store_connection_id: context.storeConnectionId,
      actor_id: context.memberId,
      request_key: context.requestKey,
      before: before.slice(0, MAX_LISTED_SIZES),
      after: after.slice(0, MAX_LISTED_SIZES),
      changed_count: (write.categoryChanged ? 1 : 0) + write.cleared.length,
      // W12 writes no size price.
      size_count: 0,
      elapsed_ms: context.elapsedMs,
      category_id: context.categoryId,
      changed_fields: write.changedFields,
      cleared_fields: context.clear?.fields ?? [],
      request_id: write.requestId,
      cleared_product_count: response.clearedProductCount,
      cleared_size_count: replayedSave ? null : write.leftovers?.clearedSizeCount ?? 0,
      ...(context.ebayMs === null ? {} : { ebay_ms: context.ebayMs }),
    });
  }
}

/**
 * The preflight (plan 8.4, 8.5 step 2): the gate, then the replay probe. A
 * key already used ends it, so eBay is not asked (plan P13, C-money-2). Else
 * the category's stored values (an id the category already stores keeps its
 * stored name, with no eBay call) and the marketplace the eBay checks need.
 */
async function readPreflight(tx: ListingSettingPreflightTransaction, input: {
  storeConnectionId: number; categoryId: number; requestHash: string;
}): Promise<ListingSettingEbayPreflight & { vendorId: number }> {
  const context = await authorizeListingSettingWrite(tx);
  const decision = classifyRequestKeyUse(await tx.findRequestKeyUse(), {
    writer: "category_settings", storeConnectionId: input.storeConnectionId, requestHash: input.requestHash, categoryId: input.categoryId,
  });
  if (decision.kind !== "new") {
    return { vendorId: tx.vendorId, keyIsNew: false, storeStatus: context.storeStatus, marketplaceId: "", known: null };
  }
  const known = (await tx.loadCategories([input.categoryId])).get(input.categoryId)?.values ?? null;
  const marketplaceId = resolveMarketplaceId(await tx.catalog.getStoreListingConfig(input.storeConnectionId));
  return { vendorId: tx.vendorId, keyIsNew: true, storeStatus: context.storeStatus, marketplaceId, known };
}

/**
 * A replay calls no writer (plan P16, P36): it answers from the category
 * revision and the clear's ledger row the key already wrote, with the
 * revision the first answer named. When the key wrote a category revision,
 * that is it. When it wrote only the clear's ledger row, the category save
 * was unchanged, which 8a answers only after its compare-and-set found the
 * revision the request expected (`row: before`,
 * dropship-category-listing-settings.repository.ts); that revision is in the
 * request hash, so it is the first answer's, with no read. A replay counts
 * nothing.
 */
function replayed(use: RequestKeyUse, vendorId: number, categoryId: number, expectedRevisionId: number | null): CategorySettingsWrite {
  const written = use.categoryRevision?.revisionId ?? null;
  const revisionId = written ?? (use.ledger === null ? null : expectedRevisionId);
  return {
    response: { outcome: "replayed", categoryId, revisionId, clearedProductCount: null },
    vendorId, categoryBefore: null, categoryChanged: false, categoryWritten: written, changedFields: [],
    requestId: use.ledger?.requestId ?? null, cleared: [], leftovers: null,
  };
}

/**
 * The patch as the settings store it: eBay fields from the eBay step (or
 * their reset), the texts as sent, and nothing else. So never a price (plan
 * P34): the stored category contract would accept one, and the route schema
 * refuses it, but only the fields below are ever copied. Parsed with the
 * stored category contract: every bound was checked before, so a failure is
 * a fault.
 */
function storedCategoryPatch(patch: CategorySettingsPatchInput, ebay: ListingSettingEbayResolution | null): CategoryListingSettingPatch {
  const values = ebay?.status === "resolved" ? ebay.values : {};
  const stored: Record<string, unknown> = {};
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
  const parsed = categoryListingSettingPatchSchema.safeParse(stored);
  if (!parsed.success) {
    throw listingSettingsInvariantFailed("A category listing settings change failed the stored contract after its checks.", {
      issues: parsed.error.issues.slice(0, MAX_LISTED_SIZES).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    });
  }
  return parsed.data;
}

/** "Also clear theirs" as the products' patch: each cleared setting reset to the default (null). */
function clearedPatch(fields: readonly CategoryClearField[]): Partial<Record<CategoryClearField, null>> {
  return Object.fromEntries(fields.map((field) => [field, null])) as Partial<Record<CategoryClearField, null>>;
}

/** An eBay value the eBay step must have built for a set id; missing means the steps ran out of order. */
function ebayValue<T>(value: T | null | undefined, field: string): T {
  if (value === undefined || value === null) {
    throw listingSettingsInvariantFailed("A category listing settings change set an eBay value the eBay step did not build.", { field });
  }
  return value;
}

/** 8a's product version conflict, naming the products whose membership or own values moved (plan P20). */
function productSetConflict(storeConnectionId: number, categoryId: number, productIds: readonly number[], message: string): DropshipError {
  return new DropshipError(PRODUCT_VERSION_CONFLICT, message, {
    storeConnectionId, categoryId, conflicts: productIds.slice(0, MAX_LISTED_SIZES).map((productId) => ({ productId })),
    conflictCount: productIds.length, retryable: false, classification: "permanent",
  });
}

function symmetricDifference(left: readonly number[], right: readonly number[]): number[] {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return [...new Set([...left.filter((id) => !rightSet.has(id)), ...right.filter((id) => !leftSet.has(id))])].sort((a, b) => a - b);
}

function elapsedMs(timer: () => number, started: number): number {
  return Math.max(0, Math.round(timer() - started));
}
