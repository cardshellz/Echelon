import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import { STOCK_LINK_SKU_MAX_LENGTH, type StockLinkOfferLookup } from "@shared/types/stock-link";
import type { DropshipEbayStockActor, DropshipEbayStockReadinessInput } from "@shared/types/dropship-ebay-stock-readiness";
import { STOCK_LINK_DECISION_CODES, type StockLinkRandom, type StockLinkSelectionAction, type StockLinkSizeDecision } from "./stock-link";
import {
  boundedStockLinkMessage, stockLinkCheckAfterDecision, stockLinkCheckAfterFailure, type StockLinkCheckFacts, type StockLinkCheckWrite,
} from "./stock-link-check-outcome";
import { STOCK_LINK_BUSY_CODES, STOCK_LINK_TRANSIENT_CODES, type StockLinkFailureClassification } from "./stock-link-errors";

/**
 * Listing enrollment (channels PR3, PLAN-CH-v3 §1, §4, §5 "Already live", §9 PR3): a Dropship eBay listing that was
 * live before stock links existed is linked by its SKU, so Card Shellz stock reaches it. Pure: the tick passes what it
 * read; the same facts always give the same outcome. The link itself is the existing Dropship writer
 * (ensureDropshipEbayStockReady) with origin live_listing_enrollment and actor system:dropship-stock-enrollment, so
 * its command key is dropshipEbayStockCommandKey(store, origin) byte for byte (it is computed by the writer).
 *
 * Rule per size, in order (eBay: the link is the SKU; SKU equality is exact after trimming, as eBay discovery
 * compares, ebay-inventory-quantity.ts):
 * 1. already linked → kept (eBay links are never moved here: a relist keeps the SKU, §1 rule 5; §3.5 out of scope);
 * 2. no listing, a listing not in managed live mode (or without a recorded offer), an ended listing, or a size the
 *    selection does not carry (read_only / none) → not the engine's: the row is removed;
 * 3. listing under change (open push job, processing publish run incl. an unexpanded chunk, open end request) → wait;
 * 4. blank SKU → F1; another carried size of the store has the same SKU → F4 (never linked by guess);
 * 5. selection with blockers → wait;
 * 6. the SKU's offers: none → wait NOT_LISTED; none PUBLISHED → wait NOT_ON_SALE; two or more PUBLISHED → F3; one
 *    PUBLISHED that is not the offer the listing's push recorded → wait (the transport writes only to the recorded
 *    offer, dropship-ebay-inventory-publication.adapter.ts assertRecordedOffer, so a link would only dead-letter);
 *    exactly the recorded offer → link (purpose sync: a removed size links at 0, allowRetainedZero).
 *    Channels PR4: a listing whose owner's transport writes by SKU (Walmart, Card Shellz eBay) sets
 *    `requireRecordedOffer: false`; then exactly one on-sale offer links.
 *
 * Card Shellz SKU changed on a linked size (channels PR4, PLAN-CH-v3 §3.5; Walmart only, the binding's
 * `followsSkuChange`): the size's sealed SKU (`linkedSku`) differs from its current SKU, a database-only compare made
 * on every re-check of the linked row (daily) and on every Walmart scan nudge. Only then is the new SKU looked up:
 * exactly one on-sale item → relink (the writer retires the old SKU version and links the new one in one audited
 * transaction); none → the old link is kept and stays writing (the item that still carries the old SKU is still this
 * size's listing), the row records STOCK_LINK_SKU_CHANGED; two or more → the link is kept and the size is flagged F3.
 */

/**
 * Why a listing is under change right now (a wait, never an error; PLAN-CH-v3 §4 "listing under change"):
 * push_open = a queued or processing push job item of the size on this store; publish_run_open = the size is a
 * pending (chunk not yet expanded into a job) or queued target of a processing publish run; end_open = an end request
 * in pending, ending or failed; ended = the vendor or eBay ended the listing (status ended, or sync-back saw it end).
 */
export type StockLinkEnrollmentSkip = "push_open" | "publish_run_open" | "end_open" | "ended";

/** One store size's listing as its owner (Dropship) reads it for enrollment. */
export interface StockLinkEnrollmentListing {
  readonly productVariantId: number;
  readonly productId: number;
  /** The owner's listing row id (Dropship: the vendor listing; Walmart: the channel feed; Card Shellz eBay: the
   * channel listing). Part of the evidence hash only. */
  readonly listingId: number;
  /** The Dropship vendor; null for Card Shellz's own channels. */
  readonly vendorId: number | null;
  /** The SKU the owner writes to the store: COALESCE(v.sku, p.sku), as stored. */
  readonly cardShellzSku: string | null;
  /** The offer the listing's own completed push recorded (the only offer the Dropship transport writes to). */
  readonly recordedOfferId: string | null;
  /** The store connection's provider environment, as the link's account check reads it. */
  readonly environment: "production" | "sandbox" | null;
  /** The listing is one the engine enrolls: a recorded offer on a connected, verified store in managed live mode. A
   * listing that is not is never newly linked (its link would zero a quantity the vendor manages). */
  readonly managed: boolean;
  readonly skipReason: StockLinkEnrollmentSkip | null;
  /** False when the owner's transport writes by SKU, not to one recorded offer (Walmart, Card Shellz eBay): then
   * exactly one on-sale offer links. Absent = true (Dropship). */
  readonly requireRecordedOffer?: boolean;
}

/** The only actor of a background Dropship link (the writer's allow-list, shared/types/dropship-ebay-stock-readiness.ts). */
export const STOCK_LINK_ENROLLMENT_ACTOR = "system:dropship-stock-enrollment" satisfies DropshipEbayStockActor;

/** Row outcomes of enrollment beyond the engine's own (domain/stock-link.ts STOCK_LINK_DECISION_CODES). */
export const STOCK_LINK_ENROLLMENT_CODES = Object.freeze({
  /** An open push job item or a processing publish run (incl. an unexpanded chunk) holds the size. */
  listingBusy: "STOCK_LINK_LISTING_BUSY",
  /** An end request is pending, ending or failed: the end flow zeroes the listing, nothing links it meanwhile. */
  listingEnding: "STOCK_LINK_LISTING_ENDING",
  /** eBay's one PUBLISHED offer for the SKU is not the offer the listing's push recorded. */
  offerNotRecorded: "STOCK_LINK_OFFER_NOT_RECORDED",
  /** The writer refused for a reason that may clear (selection, destination, global stop): re-checked with backoff. */
  enrollmentBlocked: "STOCK_LINK_ENROLLMENT_BLOCKED",
  /** The writer found the SKU or the size already mapped another way: a person reviews it. */
  mappingReview: "STOCK_LINK_MAPPING_REVIEW_REQUIRED",
  /** Channels PR4 (§3.5): the size's Card Shellz SKU changed, no on-sale item carries the new SKU yet; the old link is
   * kept (it still writes to the item that carries the old SKU). Recorded on a `linked` row. */
  skuChanged: "STOCK_LINK_SKU_CHANGED",
  /** Channels PR4: an owner listing (a Walmart feed, a Card Shellz eBay listing) of a size its channel selection does
   * not carry: re-checked with backoff, never linked (Dropship removes such rows instead). */
  notCarried: "STOCK_LINK_NOT_CARRIED",
});

const D = STOCK_LINK_DECISION_CODES;
const E = STOCK_LINK_ENROLLMENT_CODES;

/** One claimed size as the tick read it. */
export interface StockLinkEnrollmentSize {
  readonly productVariantId: number;
  readonly listing: StockLinkEnrollmentListing | null;
  /** The listing owner's selection; null when the size has no catalog facts any more. */
  readonly selection: { readonly action: StockLinkSelectionAction; readonly blockerCodes: readonly string[] } | null;
  /** The head has an active (sealed) mapping on this destination. */
  readonly linked: boolean;
  /** The head's revision ("0" = no head): part of the evidence, so a re-link after a retire is a new command (SAF-2). */
  readonly headRevision: string;
  /** The SKU the active link writes to, read only for a binding that follows a Card Shellz SKU change (§3.5). */
  readonly linkedSku?: string | null;
}

export type StockLinkEnrollmentOutcome =
  | { readonly kind: "linked"; readonly code?: string; readonly message?: string | null }
  | { readonly kind: "uncarried" }
  | { readonly kind: "wait"; readonly code: string; readonly message: string | null }
  | { readonly kind: "flag"; readonly code: string; readonly message: string }
  | { readonly kind: "lookup"; readonly sku: string; readonly replacesSku?: string };

const SKU_CODE_SKIP: Readonly<Record<StockLinkEnrollmentSkip, string | null>> = Object.freeze({
  push_open: E.listingBusy, publish_run_open: E.listingBusy, end_open: E.listingEnding, ended: null,
});

/** A Card Shellz SKU as eBay compares it: trimmed, exact; blank → null. */
export function enrollmentSku(raw: string | null | undefined): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value.length === 0 ? null : value;
}

/** Trimmed SKU → every carried size of the store that has it (sizes in id order). */
export function buildEnrollmentSkuIndex(carried: readonly { productVariantId: number; sku: string | null }[]):
  ReadonlyMap<string, readonly number[]> {
  const index = new Map<string, number[]>();
  for (const row of carried) {
    const sku = enrollmentSku(row.sku);
    if (sku === null) continue;
    const sizes = index.get(sku) ?? [];
    if (!sizes.includes(row.productVariantId)) sizes.push(row.productVariantId);
    index.set(sku, sizes);
  }
  for (const sizes of index.values()) sizes.sort((a, b) => a - b);
  return index;
}

/** Steps 1-5: what the database alone decides, or the SKU whose offers decide it. */
export function decideEnrollmentBeforeLookup(size: StockLinkEnrollmentSize, skuIndex: ReadonlyMap<string, readonly number[]>):
  StockLinkEnrollmentOutcome {
  if (size.linked) return decideLinkedSize(size, skuIndex);
  const listing = size.listing;
  const action = size.selection?.action ?? "none";
  if (listing === null || !listing.managed || listing.skipReason === "ended" || (action !== "publish" && action !== "zero"))
    return { kind: "uncarried" };
  const skipCode = listing.skipReason === null ? null : SKU_CODE_SKIP[listing.skipReason];
  if (skipCode !== null) return { kind: "wait", code: skipCode, message: `LISTING_UNDER_CHANGE: ${listing.skipReason}` };
  const sku = enrollmentSku(listing.cardShellzSku);
  if (sku === null) return { kind: "flag", code: D.skuBlank, message: "SKU_BLANK: the Card Shellz size has no SKU" };
  if (Array.from(sku).length > STOCK_LINK_SKU_MAX_LENGTH) {
    // Impossible by schema (both SKU columns are varchar(100)); never sent to eBay or the writer.
    return { kind: "flag", code: D.skuBlank, message: "SKU_INVALID: the Card Shellz SKU is longer than 100 characters" };
  }
  const shared = (skuIndex.get(sku) ?? []).filter(id => id !== size.productVariantId);
  if (shared.length > 0) {
    return { kind: "flag", code: D.itemShared,
      message: `ECHELON_SKU_SHARED: sizes ${[size.productVariantId, ...shared].sort((a, b) => a - b).join(", ")}` };
  }
  if ((size.selection?.blockerCodes.length ?? 0) > 0) {
    return { kind: "wait", code: D.selectionBlocked, message: `SELECTION_BLOCKED: ${action} (${size.selection!.blockerCodes.join(", ")})` };
  }
  return { kind: "lookup", sku };
}

/**
 * A linked size: kept, unless its binding follows a Card Shellz SKU change and the current SKU differs from the
 * linked one (§3.5), a database-only compare. A size whose listing is under change, not carried, blank or shared waits
 * for that to clear with its link kept (nothing is moved on a guess).
 */
function decideLinkedSize(size: StockLinkEnrollmentSize, skuIndex: ReadonlyMap<string, readonly number[]>): StockLinkEnrollmentOutcome {
  const linkedSku = enrollmentSku(size.linkedSku ?? null);
  const listing = size.listing;
  if (linkedSku === null || listing === null || !listing.managed || listing.skipReason !== null) return { kind: "linked" };
  const sku = enrollmentSku(listing.cardShellzSku);
  if (sku === null || sku === linkedSku || Array.from(sku).length > STOCK_LINK_SKU_MAX_LENGTH) return { kind: "linked" };
  const action = size.selection?.action ?? "none";
  if ((action !== "publish" && action !== "zero") || (size.selection?.blockerCodes.length ?? 0) > 0) return { kind: "linked" };
  if ((skuIndex.get(sku) ?? []).some(id => id !== size.productVariantId)) return { kind: "linked" };
  return { kind: "lookup", sku, replacesSku: linkedSku };
}

/** What the link command is built from (step 6, exactly the recorded PUBLISHED offer). */
export interface StockLinkEnrollmentLink {
  readonly sku: string;
  readonly offerId: string;
  readonly evidenceHash: string;
  /** The store's listing id of the offer (WPID / eBay listing id), evidence only. */
  readonly listingId?: string | null;
  /** §3.5 relink: the SKU of the sealed link this one replaces. */
  readonly replacesSku?: string;
}

export type StockLinkEnrollmentDecision =
  | Exclude<StockLinkEnrollmentOutcome, { kind: "lookup" }>
  | { readonly kind: "link"; readonly link: StockLinkEnrollmentLink };

/**
 * The enrollment evidence (PLAN-CH-v3 3.4 Keys: evidenceHash = lookupHash): what the store showed and what the command
 * writes. A new offer or a new head state is a new command; a replay of the same evidence reuses its command and
 * receipt (the writer's recorded preparation).
 */
export function enrollmentEvidenceHash(input: { storeConnectionId: number; listingId: number; productVariantId: number;
  sku: string; offerId: string; ebayListingId: string | null; headRevision: string }): string {
  return createHash("sha256").update(canonicalJson({ storeConnectionId: input.storeConnectionId, listingId: input.listingId,
    productVariantId: input.productVariantId, sku: input.sku, offerId: input.offerId, ebayListingId: input.ebayListingId,
    headRevision: input.headRevision })).digest("hex");
}

/** Step 6 from one complete lookup of the size's SKU. */
export function decideEnrollmentFromOffers(size: StockLinkEnrollmentSize, sku: string, lookup: StockLinkOfferLookup,
  storeConnectionId: number, replacesSku?: string): StockLinkEnrollmentDecision {
  const listing = size.listing!;
  if (lookup.sku !== sku) throw new Error("An enrollment decision was given another SKU's offers.");
  const offers = lookup.offers.filter(offer => offer.sku === sku);
  const published = offers.filter(offer => offer.status === "PUBLISHED");
  if (replacesSku !== undefined && published.length === 0) {
    // §3.5: nothing on sale carries the new SKU yet; the old link keeps writing to the item with the old SKU.
    return { kind: "linked", code: E.skuChanged,
      message: `SKU_CHANGED: linked ${replacesSku}, current ${sku}, no published item with the current SKU` };
  }
  if (offers.length === 0) return { kind: "wait", code: D.notListed, message: null };
  if (published.length === 0) return { kind: "wait", code: D.notOnSale, message: null };
  if (published.length >= 2) {
    return { kind: "flag", code: D.skuDuplicate,
      message: `SKU_DUPLICATE: published offers ${published.map(offer => offer.offerId).sort().join(", ")}` };
  }
  const offer = published[0]!;
  if (listing.requireRecordedOffer === false) {
    return { kind: "link", link: { sku, offerId: offer.offerId, listingId: offer.listingId,
      ...(replacesSku !== undefined ? { replacesSku } : {}),
      evidenceHash: enrollmentEvidenceHash({ storeConnectionId, listingId: listing.listingId, productVariantId: size.productVariantId,
        sku, offerId: offer.offerId, ebayListingId: offer.listingId, headRevision: size.headRevision }) } };
  }
  if (listing.recordedOfferId === null || offer.offerId !== listing.recordedOfferId) {
    return { kind: "wait", code: E.offerNotRecorded,
      message: `OFFER_NOT_RECORDED: published offer ${offer.offerId}, recorded ${listing.recordedOfferId ?? "none"}` };
  }
  return { kind: "link", link: { sku, offerId: offer.offerId, evidenceHash: enrollmentEvidenceHash({ storeConnectionId,
    listingId: listing.listingId, productVariantId: size.productVariantId, sku, offerId: offer.offerId,
    ebayListingId: offer.listingId, headRevision: size.headRevision }) } };
}

/** The writer's input for one enrollment (purpose sync: the size may be a removed one that links at 0). */
export function enrollmentLinkInput(input: { storeConnectionId: number; accountId: string; listing: StockLinkEnrollmentListing;
  productVariantId: number; link: StockLinkEnrollmentLink }): DropshipEbayStockReadinessInput | null {
  const { listing } = input;
  if (listing.environment === null || listing.vendorId === null) return null;
  return {
    vendorId: listing.vendorId, storeConnectionId: input.storeConnectionId, accountId: input.accountId,
    environment: listing.environment, productId: listing.productId, purpose: "sync",
    variants: [{ productVariantId: input.productVariantId, sku: input.link.sku }],
    origin: { kind: "live_listing_enrollment", listingId: listing.listingId, evidenceHash: input.link.evidenceHash },
  };
}

/** Inventory blocker codes that mean the SKU or the size is already mapped another way (a person reviews it). */
const MAPPING_REVIEW_BLOCKERS: ReadonlySet<string> = new Set(["STOCK_LISTING_MAPPING_CONFLICT",
  "INVENTORY_PUBLICATION_VARIANT_MAPPING_IDENTITY_CONFLICT", "STOCK_LISTING_MAPPING_REVIEW_REQUIRED"]);

/**
 * Channels PR4: an owner's listing guard is held, or the listing is between two steps the link must not cut into.
 * Busy (released, no attempt, due again in 1-3 min), never linked meanwhile:
 * LISTING_LIFECYCLE_BUSY = another Walmart listing request holds the SKU (an exclusive retirement among them);
 * PUBLICATION_RECREATION_WAITING_FOR_ITEM = a recreated Walmart item has no stock receipt yet (its saved job links it);
 * STOCK_LINK_LISTING_BUSY = the owner's own "listing under change" refusal (Card Shellz eBay outstanding listing work).
 */
export const STOCK_LINK_LISTING_BUSY_CODES: ReadonlySet<string> = new Set(["LISTING_LIFECYCLE_BUSY",
  "PUBLICATION_RECREATION_WAITING_FOR_ITEM", E.listingBusy]);

/** A `blocked` writer result as a row outcome: a race is busy or transient, a mapping conflict is flagged, the rest wait. */
export function enrollmentBlockedOutcome(blockerCodes: readonly string[]):
  | { kind: "busy"; code: string } | { kind: "transient"; code: string }
  | { kind: "flag"; code: string; message: string } | { kind: "wait"; code: string; message: string } {
  const message = `ENROLLMENT_BLOCKED: ${[...new Set(blockerCodes)].join(", ")}`;
  if (blockerCodes.some(code => MAPPING_REVIEW_BLOCKERS.has(code))) return { kind: "flag", code: E.mappingReview, message };
  const listingBusy = blockerCodes.find(code => STOCK_LINK_LISTING_BUSY_CODES.has(code));
  if (listingBusy !== undefined) return { kind: "busy", code: listingBusy };
  if (blockerCodes.length > 0 && blockerCodes.every(code => STOCK_LINK_BUSY_CODES.has(code))) return { kind: "busy", code: blockerCodes[0]! };
  if (blockerCodes.length > 0 && blockerCodes.every(code => STOCK_LINK_BUSY_CODES.has(code) || STOCK_LINK_TRANSIENT_CODES.has(code)))
    return { kind: "transient", code: blockerCodes.find(code => STOCK_LINK_TRANSIENT_CODES.has(code))! };
  return { kind: "wait", code: E.enrollmentBlocked, message };
}

/** What a claimed row became this tick (every claimed row except a removed one gets exactly one). */
export type StockLinkEnrollmentRowResult =
  | { readonly kind: "linked"; readonly code?: string; readonly message?: string | null }
  | { readonly kind: "wait" | "flag"; readonly code: string; readonly message: string | null }
  | { readonly kind: "failure"; readonly failure: Pick<StockLinkFailureClassification, "kind" | "code" | "retryAfterMs">;
      readonly message: string | null };

/**
 * The check row after an enrollment outcome, by the engine's own rules (stock-link-check-outcome.ts): linked and
 * flagged rows are looked at again in 24 h, waits back off 15 min doubling to 24 h, busy counts no attempt, transient
 * counts one, permanent stops the row (`error`) until Check again.
 */
export function stockLinkCheckAfterEnrollment(productVariantId: number, result: StockLinkEnrollmentRowResult,
  previous: StockLinkCheckFacts, now: Date, random: StockLinkRandom): StockLinkCheckWrite {
  if (result.kind === "failure") return stockLinkCheckAfterFailure(result.failure, result.message, previous, now, random);
  const status = result.kind === "linked" ? "linked" as const : result.kind === "flag" ? "flagged" as const : "waiting" as const;
  const decision: StockLinkSizeDecision = { productVariantId, productId: 0, change: "none", status,
    code: result.kind === "linked" ? result.code ?? null : result.code, retry: null, link: null, replacesMappingId: null,
    expectedHeadRevision: "0", cardShellzSku: null, selectionAction: "none", waitingItemId: null, dueNextTick: false,
    recordObservedSku: null, detail: null, rule: `enrollment/${result.kind}` };
  const write = stockLinkCheckAfterDecision(decision, previous, now, random);
  return result.kind === "linked" && result.code === undefined ? write
    : { ...write, message: boundedStockLinkMessage(result.message ?? null) };
}
