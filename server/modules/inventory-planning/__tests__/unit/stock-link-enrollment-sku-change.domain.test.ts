import { describe, expect, it } from "vitest";
import type { StockLinkOfferLookup } from "@shared/types/stock-link";
import { STOCK_LINK_DECISION_CODES as D } from "../../domain/stock-link";
import {
  STOCK_LINK_ENROLLMENT_CODES as E, buildEnrollmentSkuIndex, decideEnrollmentBeforeLookup, decideEnrollmentFromOffers,
  enrollmentBlockedOutcome, type StockLinkEnrollmentSize,
} from "../../domain/stock-link-enrollment";

// Channels PR4: the enrollment rules Walmart and Card Shellz eBay add (owner transport writes by SKU; Walmart follows a
// Card Shellz SKU change, PLAN-CH-v3 §3.5). Dropship's rules are pinned by stock-link-enrollment.domain.test.ts.

const size = (overrides: Partial<StockLinkEnrollmentSize> = {}, sku = "NEW"): StockLinkEnrollmentSize => ({ productVariantId: 101,
  listing: { productVariantId: 101, productId: 20, listingId: 1010, vendorId: null, cardShellzSku: sku, recordedOfferId: null,
    environment: "production", managed: true, skipReason: null, requireRecordedOffer: false },
  selection: { action: "publish", blockerCodes: [] }, linked: false, headRevision: "0", ...overrides });
const lookup = (sku: string, ...statuses: ("PUBLISHED" | "UNPUBLISHED")[]): StockLinkOfferLookup => ({ observedAt: "2026-10-28T12:00:00.000Z",
  sku, marketplaceId: "WALMART_US", offers: statuses.map((status, index) => ({ offerId: index === 0 ? sku : `${sku}-${index}`, sku, status,
    listingId: `WPID-${index}` })) });
const linkedOn = (linkedSku: string) => size({ linked: true, headRevision: "2", linkedSku });

describe("owner transports that write by SKU (requireRecordedOffer: false)", () => {
  it("links exactly one on-sale offer without a recorded offer, with its listing id as evidence", () => {
    const decision = decideEnrollmentFromOffers(size(), "NEW", lookup("NEW", "PUBLISHED"), 8);
    expect(decision).toMatchObject({ kind: "link", link: { sku: "NEW", offerId: "NEW", listingId: "WPID-0" } });
    expect(decision.kind === "link" && decision.link.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("still waits on none / not on sale and flags two on-sale items", () => {
    expect(decideEnrollmentFromOffers(size(), "NEW", lookup("NEW"), 8)).toMatchObject({ kind: "wait", code: D.notListed });
    expect(decideEnrollmentFromOffers(size(), "NEW", lookup("NEW", "UNPUBLISHED"), 8)).toMatchObject({ kind: "wait", code: D.notOnSale });
    expect(decideEnrollmentFromOffers(size(), "NEW", lookup("NEW", "PUBLISHED", "PUBLISHED"), 8)).toMatchObject({ kind: "flag", code: D.skuDuplicate });
  });
});

describe("Card Shellz SKU changed on a linked size (§3.5)", () => {
  const index = buildEnrollmentSkuIndex([{ productVariantId: 101, sku: "NEW" }]);
  it("is a database-only compare: the same SKU keeps the link with no lookup", () => {
    expect(decideEnrollmentBeforeLookup(linkedOn("NEW"), index)).toEqual({ kind: "linked" });
  });
  it("a binding that does not follow SKU changes (no linkedSku) keeps the link", () => {
    expect(decideEnrollmentBeforeLookup(size({ linked: true }), index)).toEqual({ kind: "linked" });
  });
  it("a changed SKU is looked up, naming the SKU it replaces", () => {
    expect(decideEnrollmentBeforeLookup(linkedOn("OLD"), index)).toEqual({ kind: "lookup", sku: "NEW", replacesSku: "OLD" });
  });
  it.each([
    ["listing under change", { listing: { ...size().listing!, skipReason: "push_open" as const } }],
    ["blank current SKU", { listing: { ...size().listing!, cardShellzSku: "  " } }],
    ["selection blocked", { selection: { action: "publish" as const, blockerCodes: ["X"] } }],
    ["not carried", { selection: { action: "none" as const, blockerCodes: [] } }],
  ])("keeps the link while %s (nothing moved on a guess)", (_label, overrides) => {
    expect(decideEnrollmentBeforeLookup({ ...linkedOn("OLD"), ...overrides }, index)).toEqual({ kind: "linked" });
  });
  it("keeps the link when another size carries the new SKU", () => {
    const shared = buildEnrollmentSkuIndex([{ productVariantId: 101, sku: "NEW" }, { productVariantId: 102, sku: "NEW" }]);
    expect(decideEnrollmentBeforeLookup(linkedOn("OLD"), shared)).toEqual({ kind: "linked" });
  });
  it("one published item with the new SKU → relink", () => {
    expect(decideEnrollmentFromOffers(linkedOn("OLD"), "NEW", lookup("NEW", "PUBLISHED"), 8, "OLD"))
      .toMatchObject({ kind: "link", link: { sku: "NEW", replacesSku: "OLD" } });
  });
  it.each([[[]], [["UNPUBLISHED"]]] as const)("none on sale (%j) → the old link is kept, recorded SKU_CHANGED", statuses => {
    expect(decideEnrollmentFromOffers(linkedOn("OLD"), "NEW", lookup("NEW", ...statuses), 8, "OLD"))
      .toMatchObject({ kind: "linked", code: E.skuChanged });
  });
  it("two published items with the new SKU → the link is kept and the size flagged F3", () => {
    expect(decideEnrollmentFromOffers(linkedOn("OLD"), "NEW", lookup("NEW", "PUBLISHED", "PUBLISHED"), 8, "OLD"))
      .toMatchObject({ kind: "flag", code: D.skuDuplicate });
  });
});

describe("owner writer refusals", () => {
  it.each(["LISTING_LIFECYCLE_BUSY", "PUBLICATION_RECREATION_WAITING_FOR_ITEM", E.listingBusy])("%s is busy (no attempt)", code => {
    expect(enrollmentBlockedOutcome([code])).toEqual({ kind: "busy", code });
  });
  it("a mapping conflict still flags first; a stopped listing waits", () => {
    expect(enrollmentBlockedOutcome(["LISTING_LIFECYCLE_BUSY", "STOCK_LISTING_MAPPING_REVIEW_REQUIRED"])).toMatchObject({ kind: "flag" });
    expect(enrollmentBlockedOutcome(["LISTING_PUBLICATION_STOPPED"])).toMatchObject({ kind: "wait", code: E.enrollmentBlocked });
  });
});
