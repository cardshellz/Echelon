import type { SavedListingPriceRevision } from "../../../../shared/dropship/listing-price";
import {
  productListingSettingPatchSchema,
  type CategoryListingSettingRow,
  type ListingSettingTemplateText,
  type ProductListingSettingPatch,
  type ProductListingSettingRow,
} from "../../../../shared/dropship/listing-setting-values";
import {
  MAX_STORE_LISTING_TEXT_BYTES,
  patchTextBytes,
  saveProductSettingsInputSchema,
  type ProductSettingsPatchInput,
  type SaveProductSettingsInput,
  type SaveProductSettingsResponse,
} from "../../../../shared/dropship/listing-setting-writes";
import { DropshipError } from "../domain/errors";
import { classifyRequestKeyUse, type RequestKeyUse } from "../domain/listing-setting-request-key-use";
import {
  LISTING_SETTING_LEFTOVER_FIELDS,
  listingSettingChildKey,
  listingSettingsInvariantFailed,
} from "../domain/listing-setting-values";
import { resolveMarketplaceId } from "./dropship-ebay-listing-setup-service";
import { productCatalogHash } from "./dropship-listing-content-resolver";
import {
  buildListingPriceChanges,
  compareExpectedPrices,
  type ListingPriceChange,
  type TypedInRequestPrice,
} from "./dropship-listing-price-change-builder";
import { saveListingPriceInTransaction } from "./dropship-listing-price-service";
import type { DropshipListingCatalogCandidate } from "./dropship-listing-preview-service";
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
  listingSettingPricesMoved,
  listingSettingRequestKeyChanged,
  listingSettingStoreIdSchema,
  listingSettingStoreTextLimit,
  listingSettingWriteHash,
  loadChosenSizes,
  parseListingSettingInput,
  requestKeyUsePath,
  type ListingSettingWriteLog,
} from "./dropship-listing-setting-write-support";
import type {
  ClearSizeLeftoversResult,
  ListingSettingPreflightTransaction,
  ListingSettingWriteRepository,
  ListingSettingWriteTransaction,
} from "./dropship-listing-setting-writes";
import type { DropshipClock } from "./dropship-ports";
import { rulePriceContextOf, withRecipes } from "./dropship-rule-price";

/**
 * W5, one product's settings (Listing settings design 8.5; plan PR 9,
 * section 6.5): the product's own values and the prices of the sizes the
 * vendor typed or released, in one transaction, all or nothing.
 *
 * 1. Parse and hash the route body (ids only), with one clock reading.
 * 2. When the change sets an eBay id: a read-only preflight (the gate, the
 *    replay probe, the product's stored eBay values, the marketplace), then
 *    eBay for new ids only, before any write transaction.
 * 3. The write transaction: the gate, the replay probe (a replay is answered
 *    from it, with no writer), the product's sizes and lockCatalog, the
 *    chosen check, the version checks, the price check over every chosen
 *    size (the pure builder), the store text cap; then the product row, the
 *    size prices through W9's own flow, and the per-size leftover clean-ups.
 * 4. One INFO line after commit.
 *
 * Refusals in their documented precedence (plan 6.13 #4): not found (the
 * product, then a size), the product's version, the sizes' versions, prices
 * moved (the size set, then the prices), then a price that would be lost or
 * break a limit. Each "reload" answer comes before any "fix a price" answer.
 */

export interface DropshipListingProductSettingsServiceDependencies {
  repository: ListingSettingWriteRepository;
  ebay: ListingSettingEbayPort;
  clock: DropshipClock;
  /** Monotonic milliseconds, for `elapsed_ms` and `ebay_ms` only; the write's time is `clock`, read once. */
  timer: () => number;
  log: ListingSettingWriteLog;
}

/** The writer's versioned operation in the request hash (plan 3.7). */
const PRODUCT_SETTINGS_OPERATION = "product_settings_v1";
const VERSION_CONFLICT = "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT";
const OUTSIDE_LIMIT = "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT";
const WOULD_BE_LOST = "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST";
const PRICE_NOT_AVAILABLE = "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE";
/** W9's refusals of one size that stop the request at once; W5 names the size it stopped on (W8's rule, plan P19). */
const SIZE_REFUSALS: ReadonlySet<string> = new Set([PRICE_NOT_AVAILABLE, WOULD_BE_LOST, "DROPSHIP_PRICING_RULES_NOT_CONFIGURED"]);

type SizePriceRow = SaveProductSettingsInput["sizePrices"][number];
type ExpectedPriceRow = NonNullable<SaveProductSettingsInput["expectedPrices"]>[number];
type ChosenProductSize = { productVariantId: number; productId: number; candidate: DropshipListingCatalogCandidate };
interface SavedSize { productVariantId: number; beforeRevisionId: number | null; afterRevisionId: number }

/** What the transaction did, for the answer and the log line. */
interface ProductSettingsWrite {
  response: SaveProductSettingsResponse;
  vendorId: number;
  /** The product's revision before the save: null when it had no row, and on a replay. */
  productBefore: number | null;
  productChanged: boolean;
  changedFields: string[];
  saved: SavedSize[];
  cleared: ClearSizeLeftoversResult | null;
  storeTextBytes: number | null;
}

export class DropshipListingProductSettingsService {
  constructor(private readonly deps: DropshipListingProductSettingsServiceDependencies) {}

  async saveForMember(memberId: string, storeId: unknown, productIdInput: unknown, body: unknown): Promise<SaveProductSettingsResponse> {
    assertListingSettingMember(memberId);
    const storeConnectionId = parseListingSettingInput(listingSettingStoreIdSchema, storeId);
    const productId = parseListingSettingInput(listingSettingStoreIdSchema, productIdInput);
    const parsed = parseListingSettingInput(saveProductSettingsInputSchema, body);
    const started = this.deps.timer();
    const now = this.deps.clock.now();
    // Ascending ids: the hash does not depend on the order sent, and sizes are written in lock order.
    const sizePrices = [...parsed.sizePrices].sort(byVariant);
    const expectedPrices = parsed.expectedPrices === undefined ? null : [...parsed.expectedPrices].sort(byVariant);
    const { patch } = parsed;
    const requestHash = listingSettingWriteHash(PRODUCT_SETTINGS_OPERATION, {
      storeConnectionId, productId, expectedRevisionId: parsed.expectedRevisionId, patch, sizePrices, expectedPrices,
    });
    const request = { memberId, storeConnectionId, idempotencyKey: parsed.idempotencyKey };

    // eBay is asked only for new ids, outside any transaction (W9's rule: no remote work under the locks).
    let ebay: ListingSettingEbayResolution | null = null;
    let ebayMs: number | null = null;
    if (setsListingSettingEbayId(patch)) {
      const preflight = await this.deps.repository.preflight(request,
        (tx) => readPreflight(tx, { storeConnectionId, productId, requestHash }));
      const ebayStarted = this.deps.timer();
      ebay = await resolveListingSettingEbayValues(this.deps.ebay, { vendorId: preflight.vendorId, storeConnectionId, patch, preflight });
      if (ebay.status === "resolved" && ebay.askedEbay) ebayMs = elapsedMs(this.deps.timer, ebayStarted);
    }

    const write = await this.deps.repository.execute(request, (tx) => this.write(tx, {
      storeConnectionId, productId, requestKey: parsed.idempotencyKey, requestHash, now,
      expectedRevisionId: parsed.expectedRevisionId, patch, sizePrices, expectedPrices, ebay,
    }));

    this.log(write, { memberId, storeConnectionId, productId, requestKey: parsed.idempotencyKey,
      elapsedMs: elapsedMs(this.deps.timer, started), ebayMs });
    return write.response;
  }

  private async write(tx: ListingSettingWriteTransaction, input: {
    storeConnectionId: number; productId: number; requestKey: string; requestHash: string; now: Date;
    expectedRevisionId: number | null; patch: ProductSettingsPatchInput; sizePrices: readonly SizePriceRow[];
    expectedPrices: readonly ExpectedPriceRow[] | null; ebay: ListingSettingEbayResolution | null;
  }): Promise<ProductSettingsWrite> {
    const { storeConnectionId, productId, patch, sizePrices } = input;
    await authorizeListingSettingWrite(tx);
    // Replay before re-reading anything (plan P16): a retry of a committed save is answered from what it wrote.
    const use = await tx.findRequestKeyUse();
    const decision = classifyRequestKeyUse(use, { writer: "product_settings", storeConnectionId, requestHash: input.requestHash, productId });
    if (requestKeyUsePath(decision, { storeConnectionId }) === "replay") return replayed(use, tx.vendorId, productId);
    // The preflight saw this key used and asked eBay nothing; its eBay values are not known, so they are never written.
    if (input.ebay?.status === "skipped") throw listingSettingRequestKeyChanged(storeConnectionId);

    const sizesBefore = await tx.listProductSizes([productId]);
    const { lockedProductIds } = await tx.lockCatalog({
      productIds: [productId], productVariantIds: [...new Set([...sizesBefore, ...sizePrices.map((row) => row.productVariantId)])],
    });
    const checksPrices = input.expectedPrices !== null;
    // Read again under the product's lock. A size added in between is recorded and answered with the price
    // check (plan 6.5 step 4.4); this narrows the gap, it does not close it (rule 2 keeps the rest price-safe).
    const sizesMoved = checksPrices ? symmetricDifference(sizesBefore, await tx.listProductSizes([productId])) : [];

    const chosen = (await loadChosenSizes(tx, sizesBefore, input.now))
      .filter((size) => size.productId === productId);
    if (chosen.length === 0) {
      throw new DropshipError("DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", "This product has no chosen size in this store. Reload the page.", {
        storeConnectionId, productId, retryable: false, classification: "permanent",
      });
    }
    const chosenIds = new Set(chosen.map((size) => size.productVariantId));
    const foreign = sizePrices.find((row) => !chosenIds.has(row.productVariantId));
    if (foreign) {
      throw new DropshipError(PRICE_NOT_AVAILABLE, "This size is not a chosen size of this product. Reload the page.", {
        storeConnectionId, productId, productVariantId: foreign.productVariantId, retryable: false, classification: "permanent",
      });
    }

    const current = (await tx.loadProducts([productId])).get(productId) ?? null;
    if ((current?.revisionId ?? null) !== input.expectedRevisionId) {
      throw productVersionConflict(storeConnectionId, productId, input.expectedRevisionId, current?.revisionId ?? null);
    }
    const savedPrices = checksPrices ? await tx.catalog.listSavedListingPrices({ vendorId: tx.vendorId, storeConnectionId,
      productVariantIds: [...chosenIds] }) : [];
    assertSizeVersions(storeConnectionId, sizePrices, savedPrices);

    if (checksPrices) {
      if (sizesMoved.length > 0) throw listingSettingPricesMoved(storeConnectionId, sizesMoved.map((id) => ({ productVariantId: id })));
      await this.checkPrices(tx, { storeConnectionId, productId, patch, sizePrices, expectedPrices: input.expectedPrices!,
        chosen, current, savedPrices });
    }

    const storedPatch = storedProductPatch(patch, input.ebay, chosen[0].candidate);
    const storeTextBytes = await checkStoreText(tx, storeConnectionId, productId, storedPatch);

    // The product row first, then the size prices: W9 judges an `inherit` size against the new recipe (plan P14).
    const product = Object.keys(storedPatch).length === 0 ? null
      : await tx.saveProduct({ productId, expectedRevisionId: input.expectedRevisionId, patch: storedPatch,
        requestHash: input.requestHash, now: input.now });
    if (product?.outcome === "replayed") {
      throw listingSettingsInvariantFailed("A product save in a new listing settings request replayed.", { productId });
    }
    const saved = await saveSizePrices(tx, { storeConnectionId, productId, requestKey: input.requestKey,
      requestHash: input.requestHash, now: input.now, rows: sizePrices });
    const fields = LISTING_SETTING_LEFTOVER_FIELDS.filter((field) => patch[field] !== undefined);
    const cleanProducts = lockedProductIds.filter((id) => id === productId);
    const cleared = fields.length > 0 && cleanProducts.length > 0
      ? await tx.clearSizeLeftovers({ productIds: cleanProducts, fields, requestHash: input.requestHash, now: input.now })
      : null;

    const productChanged = product?.outcome === "changed";
    const clearedSizeCount = cleared?.clearedSizeCount ?? 0;
    const outcome = productChanged || saved.length > 0 || clearedSizeCount > 0 ? "changed" : "unchanged";
    return {
      response: {
        outcome, productId,
        revisionId: product?.row?.revisionId ?? current?.revisionId ?? null,
        sizes: saved.map((size) => ({ productVariantId: size.productVariantId, revisionId: size.afterRevisionId })),
        clearedSizeCount,
      },
      vendorId: tx.vendorId,
      productBefore: current?.revisionId ?? null,
      productChanged,
      changedFields: product?.changedFields ?? [],
      saved,
      cleared,
      storeTextBytes,
    };
  }

  /**
   * The price check over every chosen size (plan P14, 6.5 step 9): before is
   * the store as it is, after has the new product recipe and this request's
   * size prices. Any missing, extra or differing shown price is PRICES_MOVED;
   * else a size that would lose its usable price, or a typed price outside a
   * limit, is refused, all sizes named. Nothing is written yet.
   */
  private async checkPrices(tx: ListingSettingWriteTransaction, input: {
    storeConnectionId: number; productId: number; patch: ProductSettingsPatchInput; sizePrices: readonly SizePriceRow[];
    expectedPrices: readonly ExpectedPriceRow[]; chosen: readonly ChosenProductSize[];
    current: ProductListingSettingRow | null; savedPrices: readonly SavedListingPriceRevision[];
  }): Promise<void> {
    const { storeConnectionId, productId, chosen } = input;
    const sizeIds = chosen.map((size) => size.productVariantId);
    const categoryId = chosen[0].candidate.categoryId;
    const profile = await tx.loadPricingProfile();
    const categories = categoryId === null ? new Map<number, CategoryListingSettingRow>() : await tx.loadCategories([categoryId]);
    const existing = await tx.catalog.listExistingListings({ storeConnectionId, productVariantIds: sizeIds });
    const costs = await tx.loadProductCosts(sizeIds);
    const policies = await tx.catalog.listPricingPolicies();

    const before = rulePriceContextOf(profile, {
      products: new Map<number, ProductListingSettingRow>(input.current ? [[productId, input.current]] : []), categories,
    });
    const after = input.patch.price === undefined ? before
      : withRecipes(before, { products: new Map([[productId, input.patch.price]]) });
    const savedById = new Map(input.savedPrices.map((row) => [row.productVariantId, row]));
    const existingById = new Map(existing.map((row) => [row.productVariantId, row.vendorRetailPriceCents]));
    const typedInRequest = new Map<number, TypedInRequestPrice>(input.sizePrices.map((row) => [row.productVariantId,
      row.pricingMode === "fixed" ? { pricingMode: "fixed", priceCents: row.priceCents } : { pricingMode: "inherit" }]));
    const changes = buildListingPriceChanges({
      before, after, policies, typedInRequest,
      sizes: chosen.map((size) => ({
        candidate: size.candidate,
        saved: savedById.get(size.productVariantId) ?? null,
        existingListingPriceCents: existingById.get(size.productVariantId) ?? null,
        cost: costs.get(size.productVariantId) ?? null,
      })),
    });

    const comparison = compareExpectedPrices(changes, input.expectedPrices);
    const moved = [...comparison.missing, ...comparison.extra, ...comparison.differing].sort(byVariant);
    if (moved.length > 0) throw listingSettingPricesMoved(storeConnectionId, moved);
    const refused = changes.filter((change) => change.refusal !== null);
    if (refused.length > 0) throw priceRefusals(storeConnectionId, refused);
  }

  private log(write: ProductSettingsWrite, context: {
    memberId: string; storeConnectionId: number; productId: number; requestKey: string; elapsedMs: number; ebayMs: number | null;
  }): void {
    const { response } = write;
    const productAfter = response.revisionId;
    const before = [
      ...(write.productChanged ? [{ product_id: context.productId, revision_id: write.productBefore }] : []),
      ...write.saved.map((size) => ({ product_variant_id: size.productVariantId, revision_id: size.beforeRevisionId })),
    ];
    const after = response.outcome === "replayed"
      ? [...(productAfter === null ? [] : [{ product_id: context.productId, revision_id: productAfter }]),
        ...response.sizes.map((size) => ({ product_variant_id: size.productVariantId, revision_id: size.revisionId }))]
      : [
        ...(write.productChanged ? [{ product_id: context.productId, revision_id: productAfter }] : []),
        ...write.saved.map((size) => ({ product_variant_id: size.productVariantId, revision_id: size.afterRevisionId })),
      ];
    this.deps.log.info("dropship.listing_settings.product_saved", {
      outcome: response.outcome,
      vendor_id: write.vendorId,
      store_connection_id: context.storeConnectionId,
      actor_id: context.memberId,
      request_key: context.requestKey,
      before: before.slice(0, MAX_LISTED_SIZES),
      after: after.slice(0, MAX_LISTED_SIZES),
      changed_count: (write.productChanged ? 1 : 0) + write.saved.length,
      size_count: response.sizes.length,
      elapsed_ms: context.elapsedMs,
      product_id: context.productId,
      changed_fields: write.changedFields,
      cleared_size_count: response.clearedSizeCount,
      cleared_by_kind: write.cleared?.byKind ?? (response.outcome === "replayed" ? null : { policy: 0, shelf: 0, content: 0 }),
      ...(context.ebayMs === null ? {} : { ebay_ms: context.ebayMs }),
      ...(write.storeTextBytes === null ? {} : { store_text_bytes: write.storeTextBytes }),
    });
  }
}

/**
 * The preflight (plan 6.5 step 2): the gate, then the replay probe. A key
 * already used ends it, so eBay is not asked (plan P13, C-money-2). Else the
 * product's stored values (known eBay ids keep their stored names) and the
 * marketplace the eBay checks need.
 */
async function readPreflight(tx: ListingSettingPreflightTransaction, input: {
  storeConnectionId: number; productId: number; requestHash: string;
}): Promise<ListingSettingEbayPreflight & { vendorId: number }> {
  const context = await authorizeListingSettingWrite(tx);
  const decision = classifyRequestKeyUse(await tx.findRequestKeyUse(), {
    writer: "product_settings", storeConnectionId: input.storeConnectionId, requestHash: input.requestHash, productId: input.productId,
  });
  if (decision.kind !== "new") {
    return { vendorId: tx.vendorId, keyIsNew: false, storeStatus: context.storeStatus, marketplaceId: "", known: null };
  }
  const known = (await tx.loadProducts([input.productId])).get(input.productId)?.values ?? null;
  const marketplaceId = resolveMarketplaceId(await tx.catalog.getStoreListingConfig(input.storeConnectionId));
  return { vendorId: tx.vendorId, keyIsNew: true, storeStatus: context.storeStatus, marketplaceId, known };
}

/** A replay calls no writer: the product revision and the size prices the key already wrote (plan P16, P36). */
function replayed(use: RequestKeyUse, vendorId: number, productId: number): ProductSettingsWrite {
  return {
    response: {
      outcome: "replayed", productId, revisionId: use.productRevision?.revisionId ?? null,
      sizes: use.children.filter((child) => child.kind === "size")
        .map((child) => ({ productVariantId: child.productVariantId, revisionId: child.revisionId })).sort(byVariant),
      clearedSizeCount: null,
    },
    vendorId, productBefore: null, productChanged: false, changedFields: [], saved: [], cleared: null, storeTextBytes: null,
  };
}

/**
 * The patch as the settings store it (plan 6.5 step 10): eBay fields from the
 * eBay step (or their reset), the main text with the product's catalog hash
 * stamped by the server (plan 6.13 #5; every chosen size of a product gives
 * the same product-level hash), everything else as sent. Parsed with the
 * stored contract: every bound was checked before, so a failure is a fault.
 */
function storedProductPatch(patch: ProductSettingsPatchInput, ebay: ListingSettingEbayResolution | null,
  candidate: DropshipListingCatalogCandidate): ProductListingSettingPatch {
  const values = ebay?.status === "resolved" ? ebay.values : {};
  const stored: Record<string, unknown> = {};
  if (patch.price !== undefined) stored.price = patch.price;
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
  if (patch.mainText !== undefined) {
    stored.mainText = patch.mainText === null ? null : { text: patch.mainText.text, catalogHash: productCatalogHash(candidate) };
  }
  if (Object.keys(stored).length === 0) return {};
  const parsed = productListingSettingPatchSchema.safeParse(stored);
  if (!parsed.success) {
    throw listingSettingsInvariantFailed("A product listing settings change failed the stored contract after its checks.", {
      productId: candidate.productId,
      issues: parsed.error.issues.slice(0, MAX_LISTED_SIZES).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    });
  }
  return parsed.data;
}

/** An eBay value the eBay step must have built for a set id; missing means the steps ran out of order. */
function ebayValue<T>(value: T | null | undefined, field: string): T {
  if (value === undefined || value === null) {
    throw listingSettingsInvariantFailed("A product listing settings change set an eBay value the eBay step did not build.", { field });
  }
  return value;
}

/**
 * The store text cap (plan 3.10 (e), 6.5 step 10a), only for a change that
 * sets product text: refused when it raises the store's saved text and the
 * result passes the cap, so a store over it can always shorten. Returns the
 * store's text after the write, for the log line; null when not checked.
 */
async function checkStoreText(tx: ListingSettingWriteTransaction, storeConnectionId: number, productId: number,
  patch: ProductListingSettingPatch): Promise<number | null> {
  const setsText = isOwnText(patch.textAbove) || isOwnText(patch.textBelow) || patch.mainText != null;
  if (!setsText) return null;
  const bytes = await tx.readListingTextBytes({ productIds: [productId], replacedFields: {
    textAbove: patch.textAbove !== undefined, textBelow: patch.textBelow !== undefined, mainText: patch.mainText !== undefined,
  } });
  const after = bytes.keptStoreBytes + patchTextBytes(patch);
  if (after > bytes.storeBytes && after > MAX_STORE_LISTING_TEXT_BYTES) {
    throw listingSettingStoreTextLimit(storeConnectionId, after, MAX_STORE_LISTING_TEXT_BYTES);
  }
  return after;
}

function isOwnText(value: ListingSettingTemplateText | null | undefined): boolean {
  return value != null && value.mode === "own";
}

/**
 * W9's flow per size, ascending (W8's loop shape, plan 6.5 step 12): version
 * conflicts and limits gathered, every other refusal stops at once naming its
 * size, and a W9 replay in a new request is a fault. Each refusal is thrown
 * before that size's first write, so the transaction stays usable.
 */
async function saveSizePrices(tx: ListingSettingWriteTransaction, input: {
  storeConnectionId: number; productId: number; requestKey: string; requestHash: string; now: Date; rows: readonly SizePriceRow[];
}): Promise<SavedSize[]> {
  const saved: SavedSize[] = [];
  const conflicts: Array<{ productVariantId: number; expectedRevisionId: number | null; actualRevisionId: number | null }> = [];
  const limits: Array<{ productVariantId: number; priceCents: number | null; blockers: string[] }> = [];
  for (const row of input.rows) {
    const priceCents = row.pricingMode === "fixed" ? row.priceCents : null;
    try {
      const result = await saveListingPriceInTransaction(tx.sizePrice(row.productVariantId),
        { storeConnectionId: input.storeConnectionId, productVariantId: row.productVariantId },
        { priceCents, pricingMode: row.pricingMode, expectedRevisionId: row.expectedRevisionId,
          idempotencyKey: listingSettingChildKey(input.requestKey, "size", row.productVariantId) },
        input.requestHash, input.now);
      if (result.idempotentReplay || result.price.revisionId === null) {
        throw listingSettingsInvariantFailed("A size price in a new listing settings request replayed or saved no revision.", {
          productVariantId: String(row.productVariantId),
        });
      }
      saved.push({ productVariantId: row.productVariantId, beforeRevisionId: row.expectedRevisionId, afterRevisionId: result.price.revisionId });
    } catch (error) {
      if (error instanceof DropshipError && error.code === VERSION_CONFLICT) {
        conflicts.push({ productVariantId: row.productVariantId, expectedRevisionId: row.expectedRevisionId,
          actualRevisionId: revisionIdOf(error.context?.actualRevisionId) });
        continue;
      }
      if (error instanceof DropshipError && error.code === OUTSIDE_LIMIT) {
        limits.push({ productVariantId: row.productVariantId, priceCents, blockers: blockersOf(error.context?.blockers) });
        continue;
      }
      throw namingSize(error, input.storeConnectionId, row.productVariantId);
    }
  }
  if (conflicts.length > 0) throw sizeVersionConflicts(input.storeConnectionId, conflicts);
  if (limits.length > 0) {
    throw new DropshipError(OUTSIDE_LIMIT, `${sizeCount(limits.length)} would be outside what Card Shellz allows. Enter prices Card Shellz allows.`, {
      storeConnectionId: input.storeConnectionId, sizes: limits.slice(0, MAX_LISTED_SIZES), sizeCount: limits.length,
      retryable: false, classification: "permanent",
    });
  }
  return saved;
}

/** The size prices' revisions the vendor saw, against the saved ones, before any write: a stale size is never reported as moved. */
function assertSizeVersions(storeConnectionId: number, rows: readonly SizePriceRow[], saved: readonly SavedListingPriceRevision[]): void {
  const actual = new Map(saved.map((row) => [row.productVariantId, row.revisionId]));
  const conflicts = rows.flatMap((row) => {
    const actualRevisionId = actual.get(row.productVariantId) ?? null;
    return actualRevisionId === row.expectedRevisionId ? []
      : [{ productVariantId: row.productVariantId, expectedRevisionId: row.expectedRevisionId, actualRevisionId }];
  });
  if (conflicts.length > 0) throw sizeVersionConflicts(storeConnectionId, conflicts);
}

/** W8's one 409 for every stale size price. */
function sizeVersionConflicts(storeConnectionId: number,
  conflicts: ReadonlyArray<{ productVariantId: number; expectedRevisionId: number | null; actualRevisionId: number | null }>): DropshipError {
  return new DropshipError(VERSION_CONFLICT,
    `${sizeCount(conflicts.length)} changed after you opened ${conflicts.length === 1 ? "it" : "them"}. Reload before saving again.`, {
      storeConnectionId, conflicts: conflicts.slice(0, MAX_LISTED_SIZES), conflictCount: conflicts.length,
      retryable: false, classification: "permanent",
    });
}

/** 8a's product version conflict, in its shape (dropship-product-listing-settings.repository.ts assertExpectedRevisions). */
function productVersionConflict(storeConnectionId: number, productId: number, expectedRevisionId: number | null,
  actualRevisionId: number | null): DropshipError {
  return new DropshipError("DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT",
    "Listing settings changed after you opened them. Reload them before saving again.", {
      storeConnectionId, conflicts: [{ productId, expectedRevisionId, actualRevisionId }], conflictCount: 1,
      retryable: false, classification: "permanent",
    });
}

/**
 * The builder's refusals, every size named (plan P14): OUTSIDE_LIMIT when
 * every refusal is a price typed in this request, else WOULD_BE_LOST.
 */
function priceRefusals(storeConnectionId: number, refused: readonly ListingPriceChange[]): DropshipError {
  const allTyped = refused.every((change) => change.refusal === OUTSIDE_LIMIT);
  const sizes = refused.map((change) => ({
    productVariantId: change.productVariantId, beforePriceCents: change.before.priceCents, afterPriceCents: change.after.priceCents,
    refusal: change.refusal, blockers: change.after.blockers,
  }));
  const message = allTyped
    ? `${sizeCount(refused.length)} would be outside what Card Shellz allows. Enter prices Card Shellz allows.`
    : `${refused.length === 1 ? "1 size" : `${refused.length} sizes`} would be left without a price it can be listed at. Type an exact price, or keep the price it has.`;
  return new DropshipError(allTyped ? OUTSIDE_LIMIT : WOULD_BE_LOST, message, {
    storeConnectionId, sizes: sizes.slice(0, MAX_LISTED_SIZES), sizeCount: sizes.length, retryable: false, classification: "permanent",
  });
}

/** A size refusal that names no size, rethrown with the same code and words and the size; anything else unchanged. */
function namingSize(error: unknown, storeConnectionId: number, productVariantId: number): unknown {
  if (!(error instanceof DropshipError) || !SIZE_REFUSALS.has(error.code)) return error;
  if (typeof error.context?.productVariantId === "number") return error;
  return new DropshipError(error.code, error.message, {
    ...error.context, storeConnectionId, productVariantId, retryable: false, classification: "permanent",
  });
}

function symmetricDifference(left: readonly number[], right: readonly number[]): number[] {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return [...left.filter((id) => !rightSet.has(id)), ...right.filter((id) => !leftSet.has(id))].sort((a, b) => a - b);
}

function revisionIdOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** W9's blocker codes (`pricing:below_floor:policy_<id>`); never vendor text. */
function blockersOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((blocker): blocker is string => typeof blocker === "string") : [];
}

function sizeCount(count: number): string {
  return count === 1 ? "1 size's price" : `${count} sizes' prices`;
}

function byVariant<T extends { productVariantId: number }>(left: T, right: T): number {
  return left.productVariantId - right.productVariantId;
}

function elapsedMs(timer: () => number, started: number): number {
  return Math.max(0, Math.round(timer() - started));
}
