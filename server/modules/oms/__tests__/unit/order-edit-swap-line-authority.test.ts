import { describe, expect, it } from "vitest";
import { deriveOmsLineAuthority, getOmsLineMaterializableQuantity } from "../../oms-line-authority";

// #64592 (2026-10-21): the merchant swapped SHLZ-TOP-35PT-BLU-C1000 for
// SHLZ-TOP-35PT-CLR-C1000 in Shopify at the same $119. No new payment means no
// orders/paid; the added line arrived only via orders/updated, stayed 'seen'
// with zero authority, never shipped, and the empty order was later cancelled.

const NOW = new Date("2026-10-21T18:01:38.000Z");
const swappedIn = (overrides: Partial<Parameters<typeof deriveOmsLineAuthority>[0]> = {}) => deriveOmsLineAuthority({
  sourceTopic: "orders/updated", sourceEventId: "webhook_inbox:198080", sourceInboxId: 198080,
  financialStatus: "paid", quantity: 1, fulfillableQuantity: 1, now: NOW, ...overrides,
});

describe("a line added by a Shopify order edit", () => {
  it("is authorized from the fully paid update that carries it, with an auditable source event", () => {
    const authority = swappedIn();
    expect(authority).toMatchObject({ paidQuantity: 1, authorityFulfillableQuantity: 1, authorizationStatus: "authorized",
      authorizedByEventId: "webhook_inbox:198080", authoritySourceTopic: "orders/updated", authorizedAt: NOW });
    expect(getOmsLineMaterializableQuantity(authority)).toBe(1);
  });

  it("is authorized when an earlier update already recorded it as seen", () => {
    const seen = swappedIn({ financialStatus: "refunded", sourceEventId: "webhook_inbox:198079" });
    expect(seen.authorizationStatus).toBe("seen");
    expect(swappedIn({ previous: seen })).toMatchObject({ authorizationStatus: "authorized", authorityFulfillableQuantity: 1 });
  });

  it("waits while the edit leaves a balance due", () => {
    expect(swappedIn({ financialStatus: "partially_paid" })).toMatchObject({ paidQuantity: 0, authorizationStatus: "seen" });
  });

  it("gets no shippable authority when Shopify already shows it fulfilled (no duplicate of a manual shipment)", () => {
    const authority = swappedIn({ fulfillableQuantity: 0 });
    expect(authority.authorityFulfillableQuantity).toBe(0);
    expect(getOmsLineMaterializableQuantity(authority)).toBe(0);
  });

  it.each([
    ["refunded", { paidQuantity: 1, authorityFulfillableQuantity: 0, refundedQuantity: 1, authorizationStatus: "refunded" }],
    ["cancelled", { paidQuantity: 1, authorityFulfillableQuantity: 0, cancelledQuantity: 1, authorizationStatus: "cancelled" }],
    ["held for review", { paidQuantity: 0, authorityFulfillableQuantity: 0, authorizationStatus: "review" }],
  ])("does not re-authorize a %s line from an update", (_case, previous) => {
    expect(swappedIn({ previous }).authorizationStatus).not.toBe("authorized");
  });

  it("is not granted first authority by the background Shopify reconcile poll", () => {
    expect(swappedIn({ sourceTopic: "shopify/reconcile" })).toMatchObject({ paidQuantity: 0, authorizationStatus: "seen" });
  });
});
