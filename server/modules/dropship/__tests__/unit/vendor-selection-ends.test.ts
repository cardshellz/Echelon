import { describe, expect, it } from "vitest";
import { MAX_SELECTION_END_LISTINGS } from "../../../../../shared/dropship/vendor-selection-changes";
import type { DropshipCatalogExposureRule } from "../../domain/catalog-exposure";
import { DropshipError } from "../../domain/errors";
import {
  decideListingEnds,
  hasSomethingOnEbay,
  isVisibleInStep1,
  type DecideListingEndsInput,
  type ListingEndCandidate,
  type ListingEndListingFacts,
  type ListingEndStoreFacts,
  type PendingListingEnd,
} from "../../domain/vendor-selection-ends";

/**
 * Which eBay listings a step 1 save ends (PR C, PLAN-C v4.1 §4.3, §4.4, §13.1; owner decisions D18, D20, D43, QC1 a).
 * Products are `size / 10` (sizes 11, 12 are product 1; 21, 22 product 2 …); store 7 is eBay, store 8 Shopify.
 */

const NOW = new Date("2026-10-25T12:00:00.000Z");
const RULES: readonly DropshipCatalogExposureRule[] = [{ id: 1, scopeType: "catalog", action: "include" }];

function candidate(productVariantId: number, patch: Partial<ListingEndCandidate> = {}): ListingEndCandidate {
  return { productId: Math.floor(productVariantId / 10), productVariantId, productLineIds: [3], category: "Supplies",
    productIsActive: true, variantIsActive: true, requiresShipping: true, trackInventory: true, salesEligibility: "sellable", ...patch };
}

/** Listing ids are `store * 1000 + size`. */
function listing(store: number, productVariantId: number, patch: Partial<ListingEndListingFacts> = {}): ListingEndListingFacts {
  const id = store * 1000 + productVariantId;
  return { id, productVariantId, status: "active", externalListingId: `L-${id}`, externalOfferId: `O-${id}`, marketplaceEndedAt: null,
    openEndId: null, openEndState: null, pushInFlight: false, ...patch };
}

function store(storeConnectionId: number, listings: ListingEndListingFacts[], patch: Partial<ListingEndStoreFacts> = {}): ListingEndStoreFacts {
  return { storeConnectionId, platform: "ebay", externalAccountId: `seller-${storeConnectionId}`, providerEnvironment: "production",
    listings, ...patch };
}

function decide(input: Partial<DecideListingEndsInput> & { stores: ListingEndStoreFacts[] }) {
  const sizes = new Set<number>([...(input.removedNow ?? []), ...(input.added ?? []),
    ...[...(input.pickedBefore ?? [])], ...input.stores.flatMap((entry) => entry.listings.map((row) => row.productVariantId))]);
  return decideListingEnds({
    now: NOW, removedNow: [], added: [], pickedBefore: [], candidates: [...sizes].map((id) => candidate(id)), archivedIds: [],
    rules: RULES, pendingEnds: [], ...input,
  });
}

const reasons = (result: ReturnType<typeof decide>) => result.endPlans.map((end) => [end.listingId, end.reason]);

function refusal(run: () => unknown): DropshipError {
  try {
    run();
  } catch (error) {
    if (error instanceof DropshipError) return error;
    throw error;
  }
  throw new Error("expected a DropshipError");
}

/** A seeded generator (mulberry32), so the generated table is reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("rule 1: a removed size ends its own listing (D18)", () => {
  it("ends only the removed size's listing when another size of the product stays picked", () => {
    const result = decide({ removedNow: [11], pickedBefore: [11, 12], stores: [store(7, [listing(7, 11), listing(7, 12)])] });
    expect(result.endPlans).toEqual([{ storeConnectionId: 7, listingId: 7011, productId: 1, productVariantId: 11, reason: "size_removed",
      requestedIdentity: { externalListingId: "L-7011", externalOfferId: "O-7011", externalAccountId: "seller-7",
        providerEnvironment: "production" } }]);
    expect(result.hiddenRemovedIds).toEqual([]);
  });

  it("ends a single-size product's listing, and both sizes removed in one save end both (size_removed)", () => {
    expect(reasons(decide({ removedNow: [31], pickedBefore: [31], stores: [store(7, [listing(7, 31)])] }))).toEqual([[7031, "size_removed"]]);
    expect(reasons(decide({ removedNow: [11, 12], pickedBefore: [11, 12], stores: [store(7, [listing(7, 12), listing(7, 11)])] })))
      .toEqual([[7011, "size_removed"], [7012, "size_removed"]]);
  });

  it("ends the listing on every eBay store, and never on a Shopify store (rule 4)", () => {
    const result = decide({ removedNow: [11], pickedBefore: [11, 12], stores: [
      store(9, [listing(9, 11)]), store(7, [listing(7, 11)]), store(8, [listing(8, 11)], { platform: "shopify" }),
    ] });
    expect(result.endPlans.map((end) => [end.storeConnectionId, end.listingId])).toEqual([[7, 7011], [9, 9011]]);
  });

  it("an empty identity is recorded as read: the store's account and environment may be null", () => {
    const result = decide({ removedNow: [11], pickedBefore: [11], stores: [store(7, [listing(7, 11, { externalListingId: null })],
      { externalAccountId: null, providerEnvironment: null })] });
    expect(result.endPlans[0]!.requestedIdentity).toEqual({ externalListingId: null, externalOfferId: "O-7011", externalAccountId: null,
      providerEnvironment: null });
  });
});

describe("rule 2: a wholly removed product (D18)", () => {
  it("removing the last visible pick ends the earlier-removed sibling's listing (product_removed)", () => {
    // 12 was removed in an earlier save (not picked now), its listing still at quantity 0.
    const result = decide({ removedNow: [11], pickedBefore: [11], stores: [store(7, [listing(7, 11), listing(7, 12)])] });
    expect(reasons(result)).toEqual([[7011, "size_removed"], [7012, "product_removed"]]);
    expect(result.hiddenRemovedIds).toEqual([]);
  });

  it("removes a hidden sibling pick with the product and ends its listing", () => {
    const result = decide({ removedNow: [11], pickedBefore: [11, 12], candidates: [candidate(11), candidate(12, { salesEligibility: "internal_only" })],
      stores: [store(7, [listing(7, 11), listing(7, 12)])] });
    expect(result.hiddenRemovedIds).toEqual([12]);
    expect(reasons(result)).toEqual([[7011, "size_removed"], [7012, "product_removed"]]);
  });

  it("never plans an archived sibling's listing (retirement owns it, DC31), though its hidden pick is removed", () => {
    const result = decide({ removedNow: [11], pickedBefore: [11, 12], archivedIds: [12],
      candidates: [candidate(11), candidate(12, { variantIsActive: false })], stores: [store(7, [listing(7, 11), listing(7, 12)])] });
    expect(reasons(result)).toEqual([[7011, "size_removed"]]);
    expect(result.hiddenRemovedIds).toEqual([12]);
    // Rule 1 never plans an archived removed size either.
    expect(decide({ removedNow: [11], pickedBefore: [11], archivedIds: [11], stores: [store(7, [listing(7, 11)])] }).endPlans).toEqual([]);
  });

  it("an override-off sibling is visible: the product is not wholly removed, while the removed size still ends", () => {
    // The vendor's override is not an input at all: "Turned off for you" is listed in step 1 (DC1).
    const result = decide({ removedNow: [11], pickedBefore: [11, 12], stores: [store(7, [listing(7, 11), listing(7, 12), listing(7, 13)])] });
    expect(reasons(result)).toEqual([[7011, "size_removed"]]);
    expect(result.hiddenRemovedIds).toEqual([]);
  });

  it("adding another size of the product keeps it, and a product with no visible pick before is not wholly removed", () => {
    expect(reasons(decide({ removedNow: [11], added: [12], pickedBefore: [11], stores: [store(7, [listing(7, 11), listing(7, 12), listing(7, 13)])] })))
      .toEqual([[7011, "size_removed"]]);
    // Its only pick was hidden: removing it is rule 1 alone.
    const hidden = decide({ removedNow: [11], pickedBefore: [11], candidates: [candidate(11, { requiresShipping: false }), candidate(12)],
      stores: [store(7, [listing(7, 11), listing(7, 12)])] });
    expect(reasons(hidden)).toEqual([[7011, "size_removed"]]);
  });

  it("ends a wholly removed product's other sizes on every eBay store, and on no Shopify store", () => {
    const result = decide({ removedNow: [11], pickedBefore: [11], stores: [store(7, [listing(7, 11), listing(7, 12)]),
      store(8, [listing(8, 12)], { platform: "shopify" }), store(9, [listing(9, 12)])] });
    expect(result.endPlans.map((end) => [end.storeConnectionId, end.listingId, end.reason])).toEqual([
      [7, 7011, "size_removed"], [7, 7012, "product_removed"], [9, 9012, "product_removed"]]);
  });
});

describe("what has something on eBay (§4.4)", () => {
  it.each([
    ["ended by status", { status: "ended" }],
    ["ended on eBay (sync-back's end time)", { marketplaceEndedAt: NOW }],
    ["no ids and no push in flight (a plain queued item or none)", { externalListingId: null, externalOfferId: null }],
    ["blank ids", { externalListingId: " ", externalOfferId: "" }],
  ])("plans no end for a listing %s", (_label, patch) => {
    expect(decide({ removedNow: [11], pickedBefore: [11], stores: [store(7, [listing(7, 11, patch)])] }).endPlans).toEqual([]);
  });

  it("ends an eBay stock-out end (live status, ids kept; QC1 default a) and a no-id listing with a push in flight", () => {
    // The facts reader's pushInFlight is a processing item or a stale-recovered queued one (FID-5, SAF-7).
    expect(decide({ removedNow: [11], pickedBefore: [11], stores: [store(7, [listing(7, 11)])] }).endPlans).toHaveLength(1);
    expect(decide({ removedNow: [11], pickedBefore: [11], stores: [store(7, [listing(7, 11, { externalListingId: null, externalOfferId: null,
      pushInFlight: true })])] }).endPlans).toHaveLength(1);
    expect(hasSomethingOnEbay({ platform: "ebay" }, listing(7, 11))).toBe(true);
    expect(hasSomethingOnEbay({ platform: "shopify" }, listing(7, 11))).toBe(false);
    expect(hasSomethingOnEbay({ platform: "ebay" }, listing(7, 11, { externalOfferId: null }))).toBe(true);
  });
});

describe("open ends (rules 5, 6, 8; D20)", () => {
  const pending = (id: number, productVariantId: number, reason: PendingListingEnd["reason"]): PendingListingEnd =>
    ({ id, listingId: 7000 + productVariantId, productId: Math.floor(productVariantId / 10), productVariantId, reason });

  it.each(["pending", "ending", "failed"] as const)("never requests a listing with an open %s end again", (state) => {
    const result = decide({ removedNow: [11], pickedBefore: [11, 12],
      stores: [store(7, [listing(7, 11, { openEndId: 5, openEndState: state })])] });
    expect(result.endPlans).toEqual([]);
  });

  it("supersedes a pending size_removed end whose size is added, and reports nothing for it", () => {
    const result = decide({ added: [11], pickedBefore: [], pendingEnds: [pending(5, 11, "size_removed"), pending(6, 12, "size_removed")],
      stores: [store(7, [listing(7, 11, { openEndId: 5, openEndState: "pending" }), listing(7, 12, { openEndId: 6, openEndState: "pending" })])] });
    expect(result.supersedeIds).toEqual([5]);
    expect(result).toMatchObject({ stillEnding: [], endReview: [], endedReAdd: [], endPlans: [] });
  });

  it("supersedes every pending product_removed end of a product a size of which is added", () => {
    const result = decide({ added: [11], pendingEnds: [pending(5, 12, "product_removed"), pending(6, 13, "product_removed"),
      pending(7, 21, "product_removed")], stores: [store(7, [listing(7, 11)])] });
    expect(result.supersedeIds).toEqual([5, 6]);
  });

  it("never supersedes an ending or failed end: an added size reports stillEnding or endReview", () => {
    const result = decide({ added: [11, 12], stores: [store(7, [listing(7, 11, { openEndId: 5, openEndState: "ending" }),
      listing(7, 12, { openEndId: 6, openEndState: "failed" })])] });
    expect(result.supersedeIds).toEqual([]);
    expect(result.stillEnding).toEqual([{ storeConnectionId: 7, listingId: 7011, productVariantId: 11 }]);
    expect(result.endReview).toEqual([{ storeConnectionId: 7, listingId: 7012, productVariantId: 12 }]);
  });

  it("reports an added size whose listing Card Shellz ended (ended, no eBay end time) as endedReAdd; a vendor end is not", () => {
    const result = decide({ added: [11, 12], stores: [store(7, [listing(7, 11, { status: "ended" }),
      listing(7, 12, { status: "ended", marketplaceEndedAt: NOW })])] });
    expect(result.endedReAdd).toEqual([{ storeConnectionId: 7, listingId: 7011, productVariantId: 11 }]);
  });

  it("a removal in the same save as a supersede of its product's pending end plans its own end (the superseded end is closed)", () => {
    // 11 was re-picked without a C save (its end stays pending, §4.9); the vendor now removes 11 and adds 12.
    const result = decide({ removedNow: [11], added: [12], pickedBefore: [11], pendingEnds: [pending(5, 11, "product_removed")],
      stores: [store(7, [listing(7, 11, { openEndId: 5, openEndState: "pending" }), listing(7, 12)])] });
    expect(result.supersedeIds).toEqual([5]);
    expect(reasons(result)).toEqual([[7011, "size_removed"]]);
  });
});

describe("isVisibleInStep1 (§4.3; DC1)", () => {
  it.each([
    ["an inactive product", { productIsActive: false }],
    ["an inactive size", { variantIsActive: false }],
    ["a size that does not ship", { requiresShipping: false }],
    ["a size that does not track inventory", { trackInventory: false }],
    ["an internal-only size", { salesEligibility: "internal_only" as const }],
  ])("hides %s", (_label, patch) => {
    expect(isVisibleInStep1(candidate(11, patch), RULES, NOW)).toBe(false);
  });

  it("hides a size no admin rule exposes, and lists a sellable exposed one (track inventory unset counts as tracked)", () => {
    expect(isVisibleInStep1(candidate(11), [], NOW)).toBe(false);
    expect(isVisibleInStep1(candidate(11), [...RULES, { id: 2, scopeType: "variant", action: "exclude", productVariantId: 11 }], NOW)).toBe(false);
    expect(isVisibleInStep1(candidate(11), RULES, NOW)).toBe(true);
    expect(isVisibleInStep1(candidate(11, { trackInventory: null, salesEligibility: null }), RULES, NOW)).toBe(true);
  });
});

describe("zero cases and bounds", () => {
  it("ends nothing for a Shopify-only vendor, an adds-only save or an empty removal", () => {
    expect(decide({ removedNow: [11], pickedBefore: [11], stores: [store(8, [listing(8, 11), listing(8, 12)], { platform: "shopify" })] }))
      .toMatchObject({ endPlans: [], hiddenRemovedIds: [] });
    expect(decide({ added: [11], stores: [store(7, [listing(7, 11), listing(7, 12)])] }).endPlans).toEqual([]);
    expect(decide({ pickedBefore: [11, 12], stores: [store(7, [listing(7, 11)])] })).toEqual({ endPlans: [], hiddenRemovedIds: [],
      supersedeIds: [], stillEnding: [], endReview: [], endedReAdd: [] });
  });

  it("refuses more than 30,000 ends with REMOVAL_TOO_LARGE (422, permanent), and plans exactly 30,000", () => {
    const removed = Array.from({ length: 15_000 }, (_, index) => 100_000 + index * 10);
    // Listing ids unique across the two stores at these size ids.
    const listed = (id: number, size: number) => listing(id, size, { id: id * 10_000_000 + size });
    const stores = [7, 9].map((id) => store(id, removed.map((size) => listed(id, size))));
    expect(decide({ removedNow: removed, pickedBefore: removed, stores }).endPlans).toHaveLength(MAX_SELECTION_END_LISTINGS);
    const over = [...removed, 999_990];
    const error = refusal(() => decide({ removedNow: over, pickedBefore: over,
      stores: [7, 9].map((id) => store(id, over.map((size) => listed(id, size)))) }));
    expect(error).toMatchObject({ code: "DROPSHIP_SELECTION_REMOVAL_TOO_LARGE",
      context: { endListings: 30_002, limit: MAX_SELECTION_END_LISTINGS, classification: "permanent", retryable: false } });
  });

  it("refuses a size both removed and added, an invalid id and ambiguous catalog facts", () => {
    expect(refusal(() => decide({ removedNow: [11], added: [11], stores: [] })).code).toBe("DROPSHIP_SELECTION_CHANGE_CONFLICTING");
    expect(refusal(() => decide({ removedNow: [0], stores: [] })).code).toBe("DROPSHIP_SELECTION_CHANGE_INVALID_INPUT");
    expect(refusal(() => decide({ removedNow: [11], candidates: [candidate(11), candidate(11)], stores: [] })).code)
      .toBe("DROPSHIP_STOCK_SELECTION_AMBIGUOUS");
  });

  it("never mutates its inputs and returns ascending lists whatever the read order", () => {
    const input: DecideListingEndsInput = Object.freeze({
      now: NOW, removedNow: Object.freeze([22, 11]), added: Object.freeze([]), pickedBefore: Object.freeze([22, 11]),
      candidates: Object.freeze([candidate(22), candidate(21), candidate(11), candidate(12)]), archivedIds: Object.freeze([]), rules: RULES,
      pendingEnds: Object.freeze([]),
      stores: Object.freeze([store(9, [listing(9, 22), listing(9, 21)]), store(7, [listing(7, 12), listing(7, 11)])]),
    });
    const before = JSON.stringify(input);
    const result = decideListingEnds(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.endPlans.map((end) => end.listingId)).toEqual([7011, 7012, 9021, 9022]);
  });
});

describe("generated cases (seeded; §13.1): nothing but a vendor's removal ends a listing", () => {
  const statuses = ["active", "paused", "queued", "failed", "blocked", "ended", "not_listed", "preview_ready"];

  function generated(random: () => number, withRemoval: boolean): DecideListingEndsInput {
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
    const products = [1, 2, 3].map((product) => product + Math.floor(random() * 50) * 10);
    const sizes = products.flatMap((product) => [product * 10 + 1, product * 10 + 2, product * 10 + 3]);
    const picked = sizes.filter(() => random() < 0.6);
    const unpicked = sizes.filter((size) => !picked.includes(size));
    const removedNow = withRemoval ? picked.filter(() => random() < 0.5) : [];
    const added = unpicked.filter(() => random() < 0.3);
    // ATP 0, a cost pause, an exposure change or an override never reach this decision except as these facts: an
    // unexposed or unsellable size, a paused or failed listing, a store of either platform.
    const candidates = sizes.filter(() => random() < 0.95).map((size) => candidate(size, {
      salesEligibility: pick(["sellable", "sellable", "internal_only"] as const), requiresShipping: pick([true, true, false]),
      variantIsActive: pick([true, true, true, false]),
    }));
    const stores = [7, 8, 9].map((id) => store(id, sizes.filter(() => random() < 0.8).map((size) => listing(id, size, {
      status: pick(statuses), externalListingId: pick([null, "L"]), externalOfferId: pick([null, "O", " "]),
      marketplaceEndedAt: pick([null, null, NOW]), pushInFlight: random() < 0.2,
      ...(random() < 0.15 ? { openEndId: id * 100 + size, openEndState: pick(["pending", "ending", "failed"] as const) } : {}),
    })), { platform: pick(["ebay", "ebay", "shopify"]) }));
    return { now: NOW, removedNow, added, pickedBefore: picked, candidates, rules: pick([RULES, RULES, []]),
      archivedIds: candidates.filter((row) => !row.variantIsActive).map((row) => row.productVariantId), stores, pendingEnds: [] };
  }

  it("2,000 inputs: no removal, no end and no hidden removal; with removals, every end is an eBay listing of a removed size's product", () => {
    const random = seededRandom(20_261_025);
    let planned = 0;
    for (let round = 0; round < 2_000; round += 1) {
      const withRemoval = round % 2 === 1;
      const input = generated(random, withRemoval);
      const result = decideListingEnds(input);
      if (!withRemoval) {
        expect(result.endPlans).toEqual([]);
        expect(result.hiddenRemovedIds).toEqual([]);
        continue;
      }
      const removedProducts = new Set(input.removedNow.map((size) => Math.floor(size / 10)));
      const archived = new Set(input.archivedIds as readonly number[]);
      for (const end of result.endPlans) {
        const owner = input.stores.find((entry) => entry.storeConnectionId === end.storeConnectionId)!;
        const row = owner.listings.find((entry) => entry.id === end.listingId)!;
        expect(owner.platform).toBe("ebay");
        expect(removedProducts.has(end.productId)).toBe(true);
        expect(archived.has(end.productVariantId)).toBe(false);
        expect(row.status === "ended" || row.marketplaceEndedAt !== null || row.openEndState !== null).toBe(false);
        expect(end.reason).toBe((input.removedNow as readonly number[]).includes(end.productVariantId) ? "size_removed" : "product_removed");
        expect(input.added as readonly number[]).not.toContain(end.productVariantId);
      }
      for (const size of result.hiddenRemovedIds) expect(removedProducts.has(Math.floor(size / 10))).toBe(true);
      planned += result.endPlans.length;
    }
    // Not vacuous: the removals did plan ends (the seed fixes the count).
    expect(planned).toBeGreaterThan(300);
  });
});
