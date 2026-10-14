import {
  productListingSettingBulkPatchSchema,
  type ProductListingSettingBulkPatch,
} from "../../../../shared/dropship/listing-setting-values";
import {
  MAX_BULK_TEXT_BYTES,
  MAX_STORE_LISTING_TEXT_BYTES,
  patchTextBytes,
  saveProductsBulkInputSchema,
  type ProductsBulkPatchInput,
  type SaveProductsBulkInput,
  type SaveProductsBulkResponse,
} from "../../../../shared/dropship/listing-setting-writes";
import { classifyRequestKeyUse } from "../domain/listing-setting-request-key-use";
import { LISTING_SETTING_LEFTOVER_FIELDS, listingSettingsInvariantFailed } from "../domain/listing-setting-values";
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
  listingSettingRequestKeyChanged,
  listingSettingStoreIdSchema,
  listingSettingStoreTextLimit,
  listingSettingWriteHash,
  parseListingSettingInput,
  requestKeyUsePath,
  type ListingSettingHeavyWriteGate,
  type ListingSettingWriteLog,
} from "./dropship-listing-setting-write-support";
import type {
  ListingSettingPreflightTransaction,
  ListingSettingWriteRepository,
  ListingSettingWriteTransaction,
} from "./dropship-listing-setting-writes";
import type { DropshipClock } from "./dropship-ports";

/**
 * W6, one change for many products, no price (Listing settings design 8.5;
 * plan PR 9, section 7.5): "Set for selected" or "Use default" over up to
 * 10,000 products, all or nothing, in one transaction with one ledger row.
 *
 * 1. Parse and hash the route body (ids only), with one clock reading. A
 *    pure lower bound on the text it carries (products x the patch's text) is
 *    refused before any connection.
 * 2. When the patch sets an eBay id: a read-only preflight (the gate, the
 *    replay probe, the marketplace), then eBay for every set id: none is
 *    "known" for many products (plan 7.11 #1). Resets never ask eBay.
 * 3. The write transaction, inside the heavy-write gate (one per process; a
 *    refused write never opens this transaction): the gate, the replay
 *    probe (a replay is answered from the ledger row, with no writer), the
 *    stored text and the store's text cap, lockCatalog, the bulk writer (its
 *    own version check), then the per-size leftover clean-ups of the fields
 *    the patch touches, even when no product changed (plan P18).
 * 4. One INFO line after commit.
 *
 * No chosen check (plan P11): settings on a product the vendor has not chosen
 * are kept and apply when it is chosen. A product Card Shellz deleted is not
 * locked: a reset leaves it out of the write and the clean-up, a value is the
 * writer's foreign key 404.
 */

export interface DropshipListingProductsBulkServiceDependencies {
  repository: ListingSettingWriteRepository;
  ebay: ListingSettingEbayPort;
  /** The process's one heavy-write gate (plan 3.10 (a)), shared with every heavy writer. */
  heavyWrites: ListingSettingHeavyWriteGate;
  clock: DropshipClock;
  /** Monotonic milliseconds, for `elapsed_ms` and `ebay_ms` only; the write's time is `clock`, read once. */
  timer: () => number;
  log: ListingSettingWriteLog;
}

/** The writer's versioned operation in the request hash (plan 3.7). */
const PRODUCTS_BULK_OPERATION = "product_settings_bulk_v1";

type BulkProduct = SaveProductsBulkInput["products"][number];

/** What the transaction did, for the answer and the log line. */
interface ProductsBulkWrite {
  response: SaveProductsBulkResponse;
  vendorId: number;
  changed: Array<{ productId: number; revisionId: number }>;
  /** The text the write carried (the bulk budget's count); null on a replay. */
  textBytes: number | null;
  /** The store's saved product text after the write; null when the cap was not checked. */
  storeTextBytes: number | null;
}

export class DropshipListingProductsBulkService {
  constructor(private readonly deps: DropshipListingProductsBulkServiceDependencies) {}

  async saveBulkForMember(memberId: string, storeId: unknown, body: unknown): Promise<SaveProductsBulkResponse> {
    assertListingSettingMember(memberId);
    const storeConnectionId = parseListingSettingInput(listingSettingStoreIdSchema, storeId);
    const parsed = parseListingSettingInput(saveProductsBulkInputSchema, body);
    const started = this.deps.timer();
    const now = this.deps.clock.now();
    // Ascending ids: the hash does not depend on the order sent, and rows are locked and written in one order.
    const products = [...parsed.products].sort((left, right) => left.productId - right.productId);
    const { patch } = parsed;
    const requestHash = listingSettingWriteHash(PRODUCTS_BULK_OPERATION, { storeConnectionId, products, patch });

    // The patch's own text, counted once per product: a lower bound of what the write carries, before any connection.
    const patchBytes = patchTextBytes(patch);
    const patchTotal = products.length * patchBytes;
    if (patchTotal > MAX_BULK_TEXT_BYTES) {
      throw listingSettingBulkTooLarge(storeConnectionId, patchTotal, MAX_BULK_TEXT_BYTES, products.length);
    }
    const request = { memberId, storeConnectionId, idempotencyKey: parsed.idempotencyKey };

    // eBay is asked outside any transaction and outside the gate, so an eBay timeout never holds either.
    let ebay: ListingSettingEbayResolution | null = null;
    let ebayMs: number | null = null;
    if (setsListingSettingEbayId(patch)) {
      const preflight = await this.deps.repository.preflight(request, (tx) => readPreflight(tx, { storeConnectionId, requestHash }));
      const ebayStarted = this.deps.timer();
      ebay = await resolveListingSettingEbayValues(this.deps.ebay, { vendorId: preflight.vendorId, storeConnectionId, patch, preflight });
      if (ebay.status === "resolved" && ebay.askedEbay) ebayMs = elapsedMs(this.deps.timer, ebayStarted);
    }

    const write = await this.deps.heavyWrites.run(() => this.deps.repository.execute(request, (tx) => this.write(tx, {
      storeConnectionId, requestHash, now, products, patch, patchBytes, ebay,
    })));

    this.log(write, { memberId, storeConnectionId, requestKey: parsed.idempotencyKey, products, patch,
      elapsedMs: elapsedMs(this.deps.timer, started), ebayMs });
    return write.response;
  }

  private async write(tx: ListingSettingWriteTransaction, input: {
    storeConnectionId: number; requestHash: string; now: Date; products: readonly BulkProduct[];
    patch: ProductsBulkPatchInput; patchBytes: number; ebay: ListingSettingEbayResolution | null;
  }): Promise<ProductsBulkWrite> {
    const { storeConnectionId, products, patch, patchBytes } = input;
    await authorizeListingSettingWrite(tx);
    // Replay before re-reading anything (plan P16): a retry of a committed save is answered from its ledger row.
    const use = await tx.findRequestKeyUse();
    const decision = classifyRequestKeyUse(use, { writer: "product_settings_bulk", storeConnectionId, requestHash: input.requestHash });
    if (requestKeyUsePath(decision, { storeConnectionId }) === "replay") {
      // The classifier answers a bulk replay only from its ledger row (`replayWhen: "ledger"`).
      if (!use.ledger) throw listingSettingsInvariantFailed("A bulk product replay has no ledger row.");
      return {
        response: { outcome: "replayed", requestId: use.ledger.requestId, productCount: products.length,
          changedProductCount: null, clearedSizeCount: null },
        vendorId: tx.vendorId, changed: [], textBytes: null, storeTextBytes: null,
      };
    }
    // The preflight saw this key used and asked eBay nothing; its eBay values are not known, so they are never written.
    if (input.ebay?.status === "skipped") throw listingSettingRequestKeyChanged(storeConnectionId);

    const productIds = products.map((product) => product.productId);
    // Nothing is locked or written before both text checks (plan 7.5 step 4.3). `n` counts every named product,
    // a missing one too, so both are conservative.
    const bytes = await tx.readListingTextBytes({ productIds, replacedFields: {
      textAbove: patch.textAbove !== undefined, textBelow: patch.textBelow !== undefined, mainText: patch.mainText !== undefined,
    } });
    const textBytes = bytes.targetBytes + products.length * patchBytes;
    if (textBytes > MAX_BULK_TEXT_BYTES) {
      throw listingSettingBulkTooLarge(storeConnectionId, textBytes, MAX_BULK_TEXT_BYTES, products.length);
    }
    let storeTextBytes: number | null = null;
    if (patchBytes > 0) {
      // The store cap (plan 3.10 (e)): refused only when the write raises the store's text past it.
      const after = bytes.keptStoreBytes + products.length * patchBytes;
      if (after > bytes.storeBytes && after > MAX_STORE_LISTING_TEXT_BYTES) {
        throw listingSettingStoreTextLimit(storeConnectionId, after, MAX_STORE_LISTING_TEXT_BYTES);
      }
      storeTextBytes = after;
    }

    // Product rows FOR SHARE, which the clean-ups rely on (plan P17); only products that exist are locked.
    const { lockedProductIds } = await tx.lockCatalog({ productIds });
    const saved = await tx.saveProductsBulk({
      operation: "product_settings_bulk", products, patch: storedBulkPatch(patch, input.ebay), requestHash: input.requestHash, now: input.now,
    });
    if (saved.outcome === "replayed") {
      throw listingSettingsInvariantFailed("A bulk product save in a new listing settings request replayed.", { requestId: saved.requestId });
    }
    // "Set" clears a winning per-size leftover as "Use default" does (plan P18), even when no product changed. Only
    // locked products: a deleted one is not, and the clean-up refuses an unlocked product as a fault (plan 6.2 #3).
    const fields = LISTING_SETTING_LEFTOVER_FIELDS.filter((field) => patch[field] !== undefined);
    const cleared = fields.length > 0 && lockedProductIds.length > 0
      ? await tx.clearSizeLeftovers({ productIds: lockedProductIds, fields, requestHash: input.requestHash, now: input.now })
      : null;

    const clearedSizeCount = cleared?.clearedSizeCount ?? 0;
    return {
      response: {
        outcome: saved.changed.length > 0 || clearedSizeCount > 0 ? "changed" : "unchanged",
        requestId: saved.requestId, productCount: products.length, changedProductCount: saved.changed.length, clearedSizeCount,
      },
      vendorId: tx.vendorId, changed: saved.changed, textBytes, storeTextBytes,
    };
  }

  private log(write: ProductsBulkWrite, context: {
    memberId: string; storeConnectionId: number; requestKey: string; products: readonly BulkProduct[];
    patch: ProductsBulkPatchInput; elapsedMs: number; ebayMs: number | null;
  }): void {
    const { response } = write;
    // Compare-and-set wrote each changed product over the revision the vendor sent, so that is its before.
    const expected = new Map(context.products.map((product) => [product.productId, product.expectedRevisionId]));
    const listed = write.changed.slice(0, MAX_LISTED_SIZES);
    this.deps.log.info("dropship.listing_settings.products_bulk_saved", {
      outcome: response.outcome,
      vendor_id: write.vendorId,
      store_connection_id: context.storeConnectionId,
      actor_id: context.memberId,
      request_key: context.requestKey,
      before: listed.map((entry) => ({ product_id: entry.productId, revision_id: expected.get(entry.productId) ?? null })),
      after: listed.map((entry) => ({ product_id: entry.productId, revision_id: entry.revisionId })),
      changed_count: write.changed.length,
      // W6 writes no size price.
      size_count: 0,
      elapsed_ms: context.elapsedMs,
      request_id: response.requestId,
      product_count: response.productCount,
      // The patch's keys in its parsed (stored shape) order; never a value.
      changed_fields: Object.keys(context.patch),
      cleared_size_count: response.clearedSizeCount,
      text_bytes: write.textBytes,
      ...(context.ebayMs === null ? {} : { ebay_ms: context.ebayMs }),
      ...(write.storeTextBytes === null ? {} : { store_text_bytes: write.storeTextBytes }),
    });
  }
}

/**
 * The preflight (plan 7.4): the gate, then the replay probe. A key already
 * used ends it, so eBay is not asked (plan P13, C-money-2). Else the
 * marketplace the eBay checks need. No product row is read: for many
 * products every set eBay id is new (plan 7.11 #1), so `known` is null.
 */
async function readPreflight(tx: ListingSettingPreflightTransaction, input: {
  storeConnectionId: number; requestHash: string;
}): Promise<ListingSettingEbayPreflight & { vendorId: number }> {
  const context = await authorizeListingSettingWrite(tx);
  const decision = classifyRequestKeyUse(await tx.findRequestKeyUse(), {
    writer: "product_settings_bulk", storeConnectionId: input.storeConnectionId, requestHash: input.requestHash,
  });
  if (decision.kind !== "new") {
    return { vendorId: tx.vendorId, keyIsNew: false, storeStatus: context.storeStatus, marketplaceId: "", known: null };
  }
  const marketplaceId = resolveMarketplaceId(await tx.catalog.getStoreListingConfig(input.storeConnectionId));
  return { vendorId: tx.vendorId, keyIsNew: true, storeStatus: context.storeStatus, marketplaceId, known: null };
}

/**
 * The patch as the settings store it (plan 7.4): eBay fields from the eBay
 * step (or their reset), everything else as sent; no price, and the main text
 * only as a reset (the route refused anything else). Parsed with the stored
 * bulk contract before the writer: every bound was checked before, so a
 * failure is a fault.
 */
function storedBulkPatch(patch: ProductsBulkPatchInput, ebay: ListingSettingEbayResolution | null): ProductListingSettingBulkPatch {
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
  if (patch.mainText !== undefined) stored.mainText = patch.mainText;
  const parsed = productListingSettingBulkPatchSchema.safeParse(stored);
  if (!parsed.success) {
    throw listingSettingsInvariantFailed("A bulk product listing settings change failed the stored contract after its checks.", {
      issues: parsed.error.issues.slice(0, MAX_LISTED_SIZES).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    });
  }
  return parsed.data;
}

/** An eBay value the eBay step must have built for a set id; missing means the steps ran out of order. */
function ebayValue<T>(value: T | null | undefined, field: string): T {
  if (value === undefined || value === null) {
    throw listingSettingsInvariantFailed("A bulk product listing settings change set an eBay value the eBay step did not build.", { field });
  }
  return value;
}

function elapsedMs(timer: () => number, started: number): number {
  return Math.max(0, Math.round(timer() - started));
}
