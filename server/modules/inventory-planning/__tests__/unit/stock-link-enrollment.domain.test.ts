import { describe, expect, it } from "vitest";
import type { StockLinkOfferLookup } from "@shared/types/stock-link";
import { dropshipEbayStockCommandKey, normalizeDropshipEbayStockInput } from "../../domain/dropship-ebay-stock-readiness";
import {
  STOCK_LINK_ENROLLMENT_ACTOR, STOCK_LINK_ENROLLMENT_CODES as E, buildEnrollmentSkuIndex, decideEnrollmentBeforeLookup,
  decideEnrollmentFromOffers, enrollmentBlockedOutcome, enrollmentEvidenceHash, enrollmentLinkInput, stockLinkCheckAfterEnrollment,
  type StockLinkEnrollmentListing, type StockLinkEnrollmentSize,
} from "../../domain/stock-link-enrollment";
import { STOCK_LINK_DECISION_CODES as D, STOCK_LINK_RETRY } from "../../domain/stock-link";
import type { StockLinkCheckFacts } from "../../domain/stock-link-check-outcome";
import { DROPSHIP_EBAY_STOCK_ACTORS } from "@shared/types/dropship-ebay-stock-readiness";

// Channels PR3: the pure rules that link an already-live Dropship eBay listing by its SKU (PLAN-CH-v3 §1, §4, §9 PR3).

const STORE = 22;
const NOW = new Date("2026-10-28T12:00:00.000Z");
const listing = (overrides: Partial<StockLinkEnrollmentListing> = {}): StockLinkEnrollmentListing => ({ productVariantId: 101,
  productId: 20, listingId: 7, vendorId: 10, cardShellzSku: "P5", recordedOfferId: "5001", environment: "production",
  managed: true, skipReason: null, ...overrides });
const size = (overrides: Partial<StockLinkEnrollmentSize> = {}): StockLinkEnrollmentSize => ({ productVariantId: 101,
  listing: listing(), selection: { action: "publish", blockerCodes: [] }, linked: false, headRevision: "0", ...overrides });
const lookup = (offers: StockLinkOfferLookup["offers"], sku = "P5"): StockLinkOfferLookup =>
  ({ observedAt: NOW.toISOString(), sku, marketplaceId: "EBAY_US", offers });
const offer = (offerId: string, status: "PUBLISHED" | "UNPUBLISHED" = "PUBLISHED", listingId: string | null = "3990") =>
  ({ offerId, sku: "P5", status, listingId });
const noIndex = buildEnrollmentSkuIndex([{ productVariantId: 101, sku: "P5" }]);

describe("before the lookup", () => {
  it("keeps a linked size without reading eBay (eBay links are the SKU; a relist needs nothing)", () => {
    expect(decideEnrollmentBeforeLookup(size({ linked: true, listing: listing({ skipReason: "push_open" }) }), noIndex))
      .toEqual({ kind: "linked" });
  });

  it("waits while the listing is under change: an open push job, a processing publish run (incl. an unexpanded chunk), an open end", () => {
    expect(decideEnrollmentBeforeLookup(size({ listing: listing({ skipReason: "push_open" }) }), noIndex))
      .toMatchObject({ kind: "wait", code: E.listingBusy });
    expect(decideEnrollmentBeforeLookup(size({ listing: listing({ skipReason: "publish_run_open" }) }), noIndex))
      .toMatchObject({ kind: "wait", code: E.listingBusy });
    expect(decideEnrollmentBeforeLookup(size({ listing: listing({ skipReason: "end_open" }) }), noIndex))
      .toMatchObject({ kind: "wait", code: E.listingEnding });
  });

  it("does not look after an ended, missing or uncarried listing", () => {
    expect(decideEnrollmentBeforeLookup(size({ listing: listing({ skipReason: "ended" }) }), noIndex)).toEqual({ kind: "uncarried" });
    expect(decideEnrollmentBeforeLookup(size({ listing: null }), noIndex)).toEqual({ kind: "uncarried" });
    for (const action of ["read_only", "none"] as const) {
      expect(decideEnrollmentBeforeLookup(size({ selection: { action, blockerCodes: [] } }), noIndex)).toEqual({ kind: "uncarried" });
    }
    expect(decideEnrollmentBeforeLookup(size({ selection: null }), noIndex)).toEqual({ kind: "uncarried" });
    // A store that left managed live mode keeps the vendor's own quantity: its listing is never newly linked (at 0).
    expect(decideEnrollmentBeforeLookup(size({ listing: listing({ managed: false }), selection: { action: "zero", blockerCodes: [] } }), noIndex))
      .toEqual({ kind: "uncarried" });
  });

  it("flags a blank SKU (F1) and a SKU two carried sizes share (F4), never linking by guess", () => {
    expect(decideEnrollmentBeforeLookup(size({ listing: listing({ cardShellzSku: "  " }) }), noIndex))
      .toMatchObject({ kind: "flag", code: D.skuBlank });
    const shared = buildEnrollmentSkuIndex([{ productVariantId: 101, sku: "P5" }, { productVariantId: 102, sku: " P5 " }]);
    expect(decideEnrollmentBeforeLookup(size(), shared))
      .toEqual({ kind: "flag", code: D.itemShared, message: "ECHELON_SKU_SHARED: sizes 101, 102" });
    // eBay compares exactly: another case is another SKU.
    expect(decideEnrollmentBeforeLookup(size(), buildEnrollmentSkuIndex([{ productVariantId: 102, sku: "p5" }])))
      .toEqual({ kind: "lookup", sku: "P5" });
  });

  it("waits on selection blockers and looks up a publish or a removed (zero) size", () => {
    expect(decideEnrollmentBeforeLookup(size({ selection: { action: "publish", blockerCodes: ["DROPSHIP_STOCK_X"] } }), noIndex))
      .toMatchObject({ kind: "wait", code: D.selectionBlocked });
    expect(decideEnrollmentBeforeLookup(size(), noIndex)).toEqual({ kind: "lookup", sku: "P5" });
    expect(decideEnrollmentBeforeLookup(size({ selection: { action: "zero", blockerCodes: [] } }), noIndex))
      .toEqual({ kind: "lookup", sku: "P5" });
  });
});

describe("from the SKU's offers", () => {
  it("waits when nothing is listed or nothing is on sale", () => {
    expect(decideEnrollmentFromOffers(size(), "P5", lookup([]), STORE)).toEqual({ kind: "wait", code: D.notListed, message: null });
    expect(decideEnrollmentFromOffers(size(), "P5", lookup([offer("5001", "UNPUBLISHED")]), STORE))
      .toEqual({ kind: "wait", code: D.notOnSale, message: null });
  });

  it("flags two PUBLISHED offers (F3) whatever the recorded one is", () => {
    expect(decideEnrollmentFromOffers(size(), "P5", lookup([offer("5001"), offer("5002")]), STORE))
      .toEqual({ kind: "flag", code: D.skuDuplicate, message: "SKU_DUPLICATE: published offers 5001, 5002" });
  });

  it("waits when the one PUBLISHED offer is not the listing's recorded offer (the transport writes only to that one)", () => {
    expect(decideEnrollmentFromOffers(size(), "P5", lookup([offer("5009")]), STORE)).toMatchObject({ kind: "wait", code: E.offerNotRecorded });
    expect(decideEnrollmentFromOffers(size({ listing: listing({ recordedOfferId: null }) }), "P5", lookup([offer("5001")]), STORE))
      .toMatchObject({ kind: "wait", code: E.offerNotRecorded });
  });

  it("links exactly the recorded PUBLISHED offer; an unpublished copy beside it does not count", () => {
    const decided = decideEnrollmentFromOffers(size(), "P5", lookup([offer("5001"), offer("4000", "UNPUBLISHED", null)]), STORE);
    expect(decided).toEqual({ kind: "link", link: { sku: "P5", offerId: "5001", evidenceHash: enrollmentEvidenceHash({
      storeConnectionId: STORE, listingId: 7, productVariantId: 101, sku: "P5", offerId: "5001", ebayListingId: "3990", headRevision: "0" }) } });
  });

  it("changes the evidence with a new offer or a new head state, and keeps it for a replay", () => {
    const base = { storeConnectionId: STORE, listingId: 7, productVariantId: 101, sku: "P5", offerId: "5001", ebayListingId: "3990", headRevision: "0" };
    expect(enrollmentEvidenceHash(base)).toBe(enrollmentEvidenceHash({ ...base }));
    expect(enrollmentEvidenceHash({ ...base, offerId: "5002" })).not.toBe(enrollmentEvidenceHash(base));
    expect(enrollmentEvidenceHash({ ...base, headRevision: "3" })).not.toBe(enrollmentEvidenceHash(base));
    expect(enrollmentEvidenceHash(base)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("the writer's input and command key (golden)", () => {
  const link = { sku: "P5", offerId: "5001", evidenceHash: "c".repeat(64) };

  it("is origin live_listing_enrollment {listingId, evidenceHash}, purpose sync, the destination's account", () => {
    const input = enrollmentLinkInput({ storeConnectionId: STORE, accountId: "dropship-seller", listing: listing(), productVariantId: 101, link });
    expect(input).toEqual({ vendorId: 10, storeConnectionId: STORE, accountId: "dropship-seller", environment: "production",
      productId: 20, purpose: "sync", variants: [{ productVariantId: 101, sku: "P5" }],
      origin: { kind: "live_listing_enrollment", listingId: 7, evidenceHash: "c".repeat(64) } });
    // The writer's own contract accepts it unchanged, with the one background actor of its allow-list.
    expect(normalizeDropshipEbayStockInput(input)).toEqual(input);
    expect(DROPSHIP_EBAY_STOCK_ACTORS).toContain(STOCK_LINK_ENROLLMENT_ACTOR);
    expect(STOCK_LINK_ENROLLMENT_ACTOR).toBe("system:dropship-stock-enrollment");
  });

  it("gives the command key dropshipEbayStockCommandKey(store, {kind:'live_listing_enrollment', ...}) byte for byte", () => {
    const input = enrollmentLinkInput({ storeConnectionId: STORE, accountId: "dropship-seller", listing: listing(), productVariantId: 101, link })!;
    // Literal: UUIDv5 of `live_listing_enrollment:22:7:cccc…` under the Dropship namespace (domain/dropship-ebay-stock-readiness.ts).
    expect(dropshipEbayStockCommandKey(STORE, input.origin)).toBe("1abdad3c-415f-5c1b-bb41-83ea5e2ba6fd");
    expect(dropshipEbayStockCommandKey(STORE, input.origin))
      .toBe(dropshipEbayStockCommandKey(STORE, { kind: "live_listing_enrollment", listingId: 7, evidenceHash: "c".repeat(64) }));
  });

  it("refuses to build an input without the store's provider environment", () => {
    expect(enrollmentLinkInput({ storeConnectionId: STORE, accountId: "a", listing: listing({ environment: null }), productVariantId: 101, link }))
      .toBeNull();
  });
});

describe("a blocked writer result", () => {
  it("flags a mapping conflict, retries races, and waits on the rest", () => {
    expect(enrollmentBlockedOutcome(["STOCK_LISTING_MAPPING_REVIEW_REQUIRED"])).toMatchObject({ kind: "flag", code: E.mappingReview });
    expect(enrollmentBlockedOutcome(["STOCK_LISTING_MAPPING_CONFLICT", "STOCK_LISTING_GLOBAL_STOP"])).toMatchObject({ kind: "flag" });
    expect(enrollmentBlockedOutcome(["INVENTORY_PUBLICATION_TARGET_BUSY"])).toEqual({ kind: "busy", code: "INVENTORY_PUBLICATION_TARGET_BUSY" });
    expect(enrollmentBlockedOutcome(["STOCK_MAPPING_TARGET_CHANGED"])).toEqual({ kind: "transient", code: "STOCK_MAPPING_TARGET_CHANGED" });
    expect(enrollmentBlockedOutcome(["STOCK_LISTING_NOT_SELECTED"]))
      .toEqual({ kind: "wait", code: E.enrollmentBlocked, message: "ENROLLMENT_BLOCKED: STOCK_LISTING_NOT_SELECTED" });
  });
});

describe("the check row after an outcome", () => {
  const previous: StockLinkCheckFacts = { status: "waiting", reasonCode: null, attemptCount: 2, firstFailureAt: NOW, busySince: null,
    nextCheckAt: NOW, updatedAt: NOW, waitingItemId: null, observedSku: null };
  const random = () => 0.5;

  it("linked: re-checked daily, streaks reset", () => {
    expect(stockLinkCheckAfterEnrollment(101, { kind: "linked" }, previous, NOW, random)).toMatchObject({ status: "linked",
      reasonCode: null, attemptCount: 0, firstFailureAt: null, nextCheckAt: new Date(NOW.getTime() + STOCK_LINK_RETRY.verifyIntervalMs) });
  });

  it("wait backs off from 15 minutes; flag is daily; both keep their message", () => {
    expect(stockLinkCheckAfterEnrollment(101, { kind: "wait", code: D.notListed, message: "m" }, previous, NOW, random)).toMatchObject({
      status: "waiting", reasonCode: D.notListed, message: "m", nextCheckAt: new Date(NOW.getTime() + STOCK_LINK_RETRY.waitBaseMs) });
    expect(stockLinkCheckAfterEnrollment(101, { kind: "flag", code: D.skuDuplicate, message: "two" }, previous, NOW, random)).toMatchObject({
      status: "flagged", reasonCode: D.skuDuplicate, message: "two" });
  });

  it("a permanent failure stops the row; busy counts no attempt; transient counts one", () => {
    expect(stockLinkCheckAfterEnrollment(101, { kind: "failure", failure: { kind: "permanent", code: "STOCK_LINK_LOOKUP_REJECTED",
      retryAfterMs: null }, message: "400" }, previous, NOW, random)).toMatchObject({ status: "error", errorClass: "permanent", nextCheckAt: null });
    expect(stockLinkCheckAfterEnrollment(101, { kind: "failure", failure: { kind: "busy", code: "STOCK_LINK_CALL_BUDGET_USED",
      retryAfterMs: null }, message: null }, previous, NOW, random)).toMatchObject({ status: "waiting", attemptCount: 2 });
    expect(stockLinkCheckAfterEnrollment(101, { kind: "failure", failure: { kind: "transient", code: "STOCK_LINK_PROVIDER_UNAVAILABLE",
      retryAfterMs: null }, message: null }, previous, NOW, random)).toMatchObject({ attemptCount: 3 });
  });
});
