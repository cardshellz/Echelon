import { describe, expect, it } from "vitest";
import {
  listListingEndsInputSchema,
  resolveListingEndInputSchema,
  retryListingEndInputSchema,
} from "../../application/dropship-listing-end-ops-dtos";
import {
  listingEndOpsActionAnswerSchema,
  listingEndOpsListAnswerSchema,
} from "../../../../../shared/dropship/listing-end-ops";

const ACTOR = { actorType: "admin", actorId: "staff-1" } as const;

describe("listing end staff DTOs (PLAN-C v4.1 §10; TST-7)", () => {
  it("lists failed ends 50 at a time by default", () => {
    expect(listListingEndsInputSchema.parse({})).toEqual({ state: "failed", page: 1, limit: 50 });
  });

  it("takes every state and bounds page (10,000) and limit (200)", () => {
    for (const state of ["pending", "ending", "ended", "failed", "superseded", "resolved"]) {
      expect(listListingEndsInputSchema.parse({ state }).state).toBe(state);
    }
    expect(listListingEndsInputSchema.parse({ page: 10_000, limit: 200, vendorId: 4, storeConnectionId: 5 }))
      .toEqual({ state: "failed", page: 10_000, limit: 200, vendorId: 4, storeConnectionId: 5 });
    for (const bad of [{ page: 10_001 }, { page: 0 }, { limit: 201 }, { limit: 0 }, { page: Number.NaN }, { vendorId: 0 },
      { storeConnectionId: -1 }, { state: "open" }, { search: "x" }]) {
      expect(listListingEndsInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("Retry: a key of 8-200 characters, an optional reason of 1-500, a staff actor; nothing else", () => {
    expect(retryListingEndInputSchema.parse({ endRequestId: 9, idempotencyKey: "  staff-key-1 ", actor: ACTOR }))
      .toEqual({ endRequestId: 9, idempotencyKey: "staff-key-1", actor: ACTOR });
    expect(retryListingEndInputSchema.parse({ endRequestId: 9, idempotencyKey: "staff-key-1", reason: " settled ", actor: ACTOR }).reason)
      .toBe("settled");
    for (const bad of [
      { endRequestId: 9, actor: ACTOR },
      { endRequestId: 9, idempotencyKey: "short", actor: ACTOR },
      { endRequestId: 9, idempotencyKey: "k".repeat(201), actor: ACTOR },
      { endRequestId: 9, idempotencyKey: "staff-key-1", reason: "r".repeat(501), actor: ACTOR },
      { endRequestId: 9, idempotencyKey: "staff-key-1", reason: "   ", actor: ACTOR },
      { endRequestId: 0, idempotencyKey: "staff-key-1", actor: ACTOR },
      { endRequestId: undefined, idempotencyKey: "staff-key-1", actor: ACTOR },
      { endRequestId: 9, idempotencyKey: "staff-key-1", actor: { actorType: "admin" } },
      { endRequestId: 9, idempotencyKey: "staff-key-1", actor: { actorType: "system", actorId: "worker" } },
      { endRequestId: 9, idempotencyKey: "staff-key-1", actor: ACTOR, outcome: "ended_on_ebay" },
    ]) {
      expect(retryListingEndInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("Resolve: an outcome and a reason are both required (SAF-8)", () => {
    expect(resolveListingEndInputSchema.parse({ endRequestId: 9, outcome: "left_on_sale", reason: "Kept it.", idempotencyKey: "staff-key-1",
      actor: ACTOR })).toMatchObject({ outcome: "left_on_sale", reason: "Kept it." });
    expect(resolveListingEndInputSchema.parse({ endRequestId: 9, outcome: "ended_on_ebay", reason: "r".repeat(500),
      idempotencyKey: "staff-key-1", actor: ACTOR }).reason).toHaveLength(500);
    for (const bad of [
      { endRequestId: 9, reason: "Ended it.", idempotencyKey: "staff-key-1", actor: ACTOR },
      { endRequestId: 9, outcome: "ended", reason: "Ended it.", idempotencyKey: "staff-key-1", actor: ACTOR },
      { endRequestId: 9, outcome: "ended_on_ebay", idempotencyKey: "staff-key-1", actor: ACTOR },
      { endRequestId: 9, outcome: "ended_on_ebay", reason: "", idempotencyKey: "staff-key-1", actor: ACTOR },
      { endRequestId: 9, outcome: "ended_on_ebay", reason: "r".repeat(501), idempotencyKey: "staff-key-1", actor: ACTOR },
      { endRequestId: 9, outcome: "ended_on_ebay", reason: "Ended it.", actor: ACTOR },
    ]) {
      expect(resolveListingEndInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("answers drop fields a later release adds, and refuse an answer missing a field the page needs", () => {
    const row = listAnswerRow();
    expect(listingEndOpsListAnswerSchema.parse({ items: [{ ...row, later: true }], total: 1, page: 1, limit: 50, state: "failed", extra: 1 }))
      .toEqual({ items: [row], total: 1, page: 1, limit: 50, state: "failed" });
    const { context: _context, ...withoutContext } = row;
    expect(listingEndOpsListAnswerSchema.safeParse({ items: [withoutContext], total: 1, page: 1, limit: 50, state: "failed" }).success)
      .toBe(false);
    expect(listingEndOpsActionAnswerSchema.safeParse({ endRequest: row, action: "retry" }).success).toBe(false);
  });
});

function listAnswerRow() {
  return {
    endRequestId: 9,
    vendor: { vendorId: 70, memberId: "member-70", businessName: null, email: null },
    store: { storeConnectionId: 801, platform: "ebay", status: "connected", displayName: "Store 801" },
    listing: { listingId: 5, status: "active", externalListingId: "L-1", externalOfferId: "O-1" },
    productId: 7001, productVariantId: 70011, sku: "S-70011", reason: "size_removed", state: "failed",
    code: "DROPSHIP_LISTING_END_WITHDRAW_UNCERTAIN", message: "m",
    context: { lastCode: "DROPSHIP_LISTING_END_WITHDRAW_UNCERTAIN", attemptIds: ["11"], evidence: "published", requiresReview: true },
    attemptCount: 1, deferralCount: 0,
    withdraw: { callCount: 1, requestedAt: "2026-10-26T09:00:00.000Z", returnedAt: null, outcome: null },
    staffAction: null, decidedAt: "2026-10-26T09:00:00.000Z", createdAt: "2026-10-25T12:00:00.000Z", updatedAt: "2026-10-26T09:00:00.000Z",
  };
}
