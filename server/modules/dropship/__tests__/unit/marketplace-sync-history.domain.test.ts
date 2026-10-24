import { describe, expect, it } from "vitest";
import {
  decideFulfillmentPolicyCheckNotice,
  fulfillmentPolicyVerdictHash,
} from "../../domain/marketplace-sync-decision";
import { sha256Hex } from "../../domain/marketplace-listing-observation";
import {
  marketplaceSyncOursFromHistory,
  marketplaceSyncSentTextFromHistory,
  newestMarketplaceSyncEventId,
  storedIntentFieldValues,
  storedIntentSentText,
  storedIntentSku,
  type MarketplaceSyncEvent,
} from "../../domain/marketplace-sync-history";
import { planMarketplaceSyncNoticeBatches } from "../../domain/marketplace-sync-notice-batches";

const AT = new Date("2026-10-22T12:00:00.000Z");
const event = (id: number, eventType: string, payload: unknown): MarketplaceSyncEvent => ({ id, eventType, payload, createdAt: AT });

describe("marketplaceSyncOursFromHistory (SB3)", () => {
  it("takes B from the newest completed or synced event and the attempts after it", () => {
    const ours = marketplaceSyncOursFromHistory({ storedIntent: null, events: [
      event(1, "listing_push_completed", { priceCents: 900 }),
      event(2, "listing_push_attempted", { priceCents: 950 }),
      event(3, "listing_marketplace_synced", { priceCents: 1100, fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1" }),
      event(5, "listing_push_attempted", { priceCents: 1300, returnPolicyId: "R-2" }),
      event(4, "listing_push_attempted", { priceCents: 1200 }),
      event(6, "listing_push_attempted", { priceCents: 1200 }),
      event(7, "listing_push_failed", { priceCents: 9999 }),
    ] });
    expect(ours).toEqual({
      priceCents: { baseline: 1100, attempted: [1200, 1300] },
      fulfillmentPolicyId: { baseline: "F-1", attempted: [] },
      returnPolicyId: { baseline: "R-1", attempted: ["R-2"] },
      paymentPolicyId: { baseline: "P-1", attempted: [] },
    });
  });

  it("falls back to the stored intent for a field an older event did not record (§4.1 last row)", () => {
    const ours = marketplaceSyncOursFromHistory({
      events: [event(1, "listing_push_completed", { jobId: 1, quantity: 3, priceCents: 1299 })],
      storedIntent: { title: "  Size  101 ", description: null, priceCents: 1000,
        marketplaceConfig: { businessPolicies: { fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1" } } },
    });
    // The event's own price wins over the intent's.
    expect(ours.priceCents).toEqual({ baseline: 1299, attempted: [] });
    expect(ours.paymentPolicyId).toEqual({ baseline: "P-1", attempted: [] });
    // Title and description are never part of Ours (owner rule 2).
    expect(Object.keys(ours).sort()).toEqual(["fulfillmentPolicyId", "paymentPolicyId", "priceCents", "returnPolicyId"]);
  });

  it("has no record at all without events or intent", () => {
    const ours = marketplaceSyncOursFromHistory({ events: [], storedIntent: null });
    for (const field of Object.values(ours)) expect(field).toEqual({ baseline: null, attempted: [] });
  });

  it("ignores a malformed field instead of trusting it", () => {
    const ours = marketplaceSyncOursFromHistory({ storedIntent: { priceCents: 1.5, title: "" }, events: [
      event(1, "listing_marketplace_synced", { priceCents: "1100", fulfillmentPolicyId: "" }),
      event(2, "listing_push_attempted", null),
    ] });
    expect(ours.priceCents).toEqual({ baseline: null, attempted: [] });
    expect(ours.fulfillmentPolicyId.baseline).toBeNull();
    expect(storedIntentFieldValues("not an intent")).toEqual({});
  });

  it("names the newest event for the observation compare-and-set (SB4)", () => {
    expect(newestMarketplaceSyncEventId([event(3, "a", {}), event(9, "b", {}), event(4, "c", {})])).toBe(9);
    expect(newestMarketplaceSyncEventId([])).toBeNull();
  });
});

describe("storedIntentSentText (owner rule 2: what Card Shellz last sent)", () => {
  it("is the stored intent's title and description exactly as the push sends them", () => {
    expect(storedIntentSentText({ title: "  Size  101 ", description: "<p>Words</p>\n" }))
      .toEqual({ title: "  Size  101 ", description: "<p>Words</p>\n" });
  });

  it("is the title for the description when the intent has none (provider: descriptionHtmlOverride = description ?? title)", () => {
    expect(storedIntentSentText({ title: "Size 101", description: null })).toEqual({ title: "Size 101", description: "Size 101" });
    expect(storedIntentSentText({ title: "Size 101" })).toEqual({ title: "Size 101", description: "Size 101" });
  });

  it("has no record without a stored intent, or of a malformed one", () => {
    expect(storedIntentSentText(null)).toEqual({ title: null, description: null });
    expect(storedIntentSentText({ title: 7 })).toEqual({ title: null, description: null });
    expect(storedIntentSentText({ description: "<p>Only words</p>" })).toEqual({ title: null, description: "<p>Only words</p>" });
  });
});

// Review OR-1: what Card Shellz last sent is what each push actually wrote, not the text it was queued with.
describe("marketplaceSyncSentTextFromHistory (owner rule 2: the text fingerprints Card Shellz wrote)", () => {
  const h = (text: string) => sha256Hex(text);
  it("takes the newest completed push's fingerprints and every attempt after it, never the queued intent's text", () => {
    const sent = marketplaceSyncSentTextFromHistory({ storedIntent: { title: "T1 (queued)", description: "<p>D1</p>" }, events: [
      event(1, "listing_push_completed", { titleHash: h("T0"), descriptionHash: h("<p>D0</p>") }),
      event(2, "listing_push_completed", { titleHash: h("T2"), descriptionHash: h("<p>D2</p>") }),
      event(3, "listing_marketplace_synced", { priceCents: 1100 }),
      event(4, "listing_push_attempted", { titleHash: h("T3"), descriptionHash: h("<p>D2</p>") }),
    ] });
    expect(sent).toEqual({ title: { baseline: h("T2"), attempted: [h("T3")] },
      description: { baseline: h("<p>D2</p>"), attempted: [h("<p>D2</p>")] } });
  });

  it("falls back to the stored intent's text only when the newest completed push recorded none (pushes before this release)", () => {
    expect(marketplaceSyncSentTextFromHistory({ storedIntent: { title: "Old", description: null },
      events: [event(1, "listing_push_completed", { priceCents: 1100 }), event(2, "listing_push_attempted", { titleHash: "not a hash" })] }))
      .toEqual({ title: { baseline: h("Old"), attempted: [] }, description: { baseline: h("Old"), attempted: [] } });
    expect(marketplaceSyncSentTextFromHistory({ storedIntent: null, events: [] }))
      .toEqual({ title: { baseline: null, attempted: [] }, description: { baseline: null, attempted: [] } });
  });
});

describe("storedIntentSku (the SKU Card Shellz listed under, which the sweep reads the inventory item by)", () => {
  it("is the stored intent's SKU as the push sends it (trimmed)", () => {
    expect(storedIntentSku({ sku: " CS-TOP-100 ", title: "T" })).toBe("CS-TOP-100");
  });

  it("is null without a SKU, with a blank one, or for a malformed intent", () => {
    expect(storedIntentSku(null)).toBeNull();
    expect(storedIntentSku({ title: "T" })).toBeNull();
    expect(storedIntentSku({ sku: "   " })).toBeNull();
    expect(storedIntentSku({ sku: 42 })).toBeNull();
  });
});

describe("decideFulfillmentPolicyCheckNotice (§6.3, owner rule 7b)", () => {
  const incompatible = fulfillmentPolicyVerdictHash(["local_pickup_unsupported", "international_direct_shipping_unsupported"]);
  it("hashes a verdict independent of order and repeats", () => {
    expect(fulfillmentPolicyVerdictHash(["international_direct_shipping_unsupported", "local_pickup_unsupported", "local_pickup_unsupported"]))
      .toBe(incompatible);
    expect(fulfillmentPolicyVerdictHash([])).toMatch(/^[0-9a-f]{64}$/);
  });
  it("tells a new incompatible verdict once, and again only when the verdict changes", () => {
    expect(decideFulfillmentPolicyCheckNotice({ compatible: false, verdictHash: incompatible, notifiedVerdictHash: null }))
      .toEqual({ kind: "notify_incompatible", notifiedVerdictHash: incompatible });
    expect(decideFulfillmentPolicyCheckNotice({ compatible: false, verdictHash: incompatible, notifiedVerdictHash: incompatible })).toEqual({ kind: "none" });
    const other = fulfillmentPolicyVerdictHash(["local_pickup_unsupported"]);
    expect(decideFulfillmentPolicyCheckNotice({ compatible: false, verdictHash: other, notifiedVerdictHash: incompatible }))
      .toEqual({ kind: "notify_incompatible", notifiedVerdictHash: other });
  });
  it("forgets the told verdict when the policy works again, with no notice, so a later problem is told again", () => {
    const ok = fulfillmentPolicyVerdictHash([]);
    expect(decideFulfillmentPolicyCheckNotice({ compatible: true, verdictHash: ok, notifiedVerdictHash: incompatible }))
      .toEqual({ kind: "forget_notified", notifiedVerdictHash: null });
    expect(decideFulfillmentPolicyCheckNotice({ compatible: true, verdictHash: ok, notifiedVerdictHash: null })).toEqual({ kind: "none" });
  });
});

describe("planMarketplaceSyncNoticeBatches (§6.6: no digest, owner rule 7)", () => {
  it("sends every row at once, one batch per store and kind, keyed by its id range", () => {
    const batches = planMarketplaceSyncNoticeBatches([
      { id: 5, storeConnectionId: 22, kind: "sku_changed" },
      { id: 3, storeConnectionId: 22, kind: "sku_changed" },
      { id: 4, storeConnectionId: 23, kind: "sku_changed" },
      { id: 6, storeConnectionId: 22, kind: "price_below_cost" },
    ]);
    expect(batches).toEqual([
      { batchKey: "ebay-sync:sku_changed:22:3-5", storeConnectionId: 22, kind: "sku_changed", noticeIds: [3, 5] },
      { batchKey: "ebay-sync:sku_changed:23:4-4", storeConnectionId: 23, kind: "sku_changed", noticeIds: [4] },
      { batchKey: "ebay-sync:price_below_cost:22:6-6", storeConnectionId: 22, kind: "price_below_cost", noticeIds: [6] },
    ]);
  });

  it("gives a late row its own batch, never a sent batch's key", () => {
    expect(planMarketplaceSyncNoticeBatches([{ id: 7, storeConnectionId: 22, kind: "sku_changed" }])[0]?.batchKey)
      .toBe("ebay-sync:sku_changed:22:7-7");
    expect(planMarketplaceSyncNoticeBatches([])).toEqual([]);
  });
});
