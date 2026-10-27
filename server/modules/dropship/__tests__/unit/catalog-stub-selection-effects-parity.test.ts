import { describe, expect, it } from "vitest";
import {
  STAMP,
  stubListingEndFacts,
  stubSelectionEffects,
  type ChooseRowFact,
  type StoreFixture,
  type StubListingEnd,
  type StubListingEndState,
  type StubState,
} from "../../../../../test/browser/dropship-policy-catalog-stubs";
import type { DropshipStockSelectionCandidate } from "../../domain/stock-publication-selection";
import { planSelectionChange } from "../../domain/vendor-selection-change";
import { decideSelectionEffects, type SelectionEffectsStore } from "../../domain/vendor-selection-effects";
import { decideListingEnds } from "../../domain/vendor-selection-ends";

/**
 * The step 1 browser stubs call the server's own end decision and hashes (PLAN-C v4.1 §13.4, TST-10), but not the
 * effects decision: it reaches the stock decision, whose imports load the listing lifecycle repositories. So the
 * stubs keep a copy of B's quantity rule for their listing model, and this pins the copy to the domain over a seeded
 * table of stub states (§13.4's fallback): the same counts per store, the same ends and the same hashes.
 */

const RULES = [{ id: 1, scopeType: "catalog" as const, action: "include" as const }];
const LIVE = { listingMode: "live" as const, inventoryMode: "managed_quantity_sync" as const, isActive: true };
const STORES: StoreFixture[] = [
  { storeConnectionId: 3, platform: "shopify", name: "Test Shop" },
  { storeConnectionId: 5, platform: "ebay", name: "Marz Cards" },
  { storeConnectionId: 9, platform: "ebay", name: "Marz Cards Outlet" },
];

/** A seeded generator (mulberry32), so the table is reproducible. */
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

function row(productId: number, productVariantId: number, enabledOverride?: boolean): ChooseRowFact {
  return { productId, productVariantId, productSku: null, productName: `Product ${productId}`, variantSku: null, variantName: "Size",
    category: "Supplies", categoryId: 30, productLineIds: [], productLineNames: [], unitsPerVariant: 1, stock: 5,
    ...(enabledOverride === undefined ? {} : { enabledOverride }),
    listingTier: { tier: "pack", eligible: true, reason: null, policyMinimumCents: 10_000, reserveShortfallCents: 0, balanceShortfallCents: 0 } };
}

/** The stub's own offer rule (stubPlanChange): a touched size in the catalog not turned off for the vendor. */
function offeredOf(state: StubState, ids: readonly number[]): Set<number> {
  const facts = new Map(state.chooseRows.map((fact) => [fact.productVariantId, fact]));
  return new Set(ids.filter((id) => facts.has(id) && facts.get(id)!.enabledOverride !== false));
}

/** The same stub state as the server's effects facts: the pending ends of the added sizes' products, as the service reads them. */
function domainEffects(state: StubState, plan: { insertIds: number[]; deleteIds: number[] }) {
  const ends = stubListingEndFacts(state);
  const candidates: DropshipStockSelectionCandidate[] = ends.candidates.map((candidate) => ({ ...candidate, variantUomType: "pack" }));
  const productOf = new Map(candidates.map((candidate) => [candidate.productVariantId, candidate.productId]));
  const addedProducts = new Set(plan.insertIds.map((id) => productOf.get(id)).filter((id): id is number => id !== undefined));
  const pendingEnds = state.listingEnds.filter((end) => end.state === "pending" && addedProducts.has(end.productId)).map((end) => ({
    id: end.id, listingId: end.storeConnectionId * 1_000_000 + end.productVariantId, productId: end.productId,
    productVariantId: end.productVariantId, reason: end.reason }));
  const decision = decideListingEnds({ now: new Date(STAMP), removedNow: plan.deleteIds, added: plan.insertIds, pickedBefore: state.picks,
    candidates, archivedIds: [], rules: RULES, stores: ends.stores, pendingEnds });
  const stores: SelectionEffectsStore[] = ends.stores.map((store) => ({
    storeConnectionId: store.storeConnectionId, storeName: STORES.find((entry) => entry.storeConnectionId === store.storeConnectionId)!.name,
    platform: store.platform, status: state.storeStatuses[store.storeConnectionId] ?? "connected", externalAccountId: store.externalAccountId,
    providerEnvironment: store.providerEnvironment, config: LIVE, storePaused: false,
    listings: store.listings.map((listing) => ({ ...listing, livePushItemId: null, vendorQuantityLimit: null, marketplaceIssueCodes: [] })),
  }));
  return decideSelectionEffects({ now: new Date(STAMP), insertIds: plan.insertIds, deleteIds: [...plan.deleteIds, ...decision.hiddenRemovedIds],
    candidates, adminRules: RULES, stores, ends: decision,
    overrides: state.chooseRows.filter((fact) => fact.enabledOverride === false)
      .map((fact) => ({ productVariantId: fact.productVariantId, enabledOverride: false })) });
}

describe("the browser stubs' selection effects equal the server's (TST-10 fallback)", () => {
  it("over 500 seeded stub states: counts per store, ends, and both hashes", () => {
    const random = seededRandom(20_261_026);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
    const totals = { ends: 0, quantityEffects: 0, hidden: 0, superseded: 0, reported: 0, waiting: 0 };
    for (let round = 0; round < 500; round += 1) {
      const sizes = Array.from({ length: 12 }, (_, index) => 1_000 + round * 20 + index);
      const listed = sizes.filter(() => random() < 0.9);
      const chooseRows = listed.map((size) => row(Math.floor(size / 4), size, random() < 0.15 ? false : undefined));
      // PR C (C6): some sizes Card Shellz isn't offering now, which step 1 does not list (hidden picks, §4.4 rule 2).
      const hiddenRows = sizes.filter((size) => !listed.includes(size) && random() < 0.7).map((size) => row(Math.floor(size / 4), size));
      const picks = new Set(sizes.filter(() => random() < 0.5));
      const liveVariantIds: Record<number, number[]> = {};
      const endedVariantIds: Record<number, number[]> = {};
      const listingEnds: StubListingEnd[] = [];
      for (const store of STORES) {
        liveVariantIds[store.storeConnectionId] = sizes.filter(() => random() < 0.5);
        endedVariantIds[store.storeConnectionId] = sizes.filter(() => random() < 0.15);
        // End requests on some unpicked live eBay sizes: open (pending, ending, failed) or closed (Card Shellz's end).
        if (store.platform !== "ebay") continue;
        for (const size of liveVariantIds[store.storeConnectionId]!) {
          if (picks.has(size) || endedVariantIds[store.storeConnectionId]!.includes(size) || random() >= 0.35) continue;
          const state: StubListingEndState = pick(["pending", "pending", "ending", "failed", "ended", "superseded"]);
          listingEnds.push({ id: 10_000 + round * 100 + listingEnds.length, storeConnectionId: store.storeConnectionId, productVariantId: size,
            productId: Math.floor(size / 4), reason: pick(["size_removed", "product_removed"]), state });
        }
      }
      const storeStatuses: Record<number, string> = random() < 0.2 ? { 5: "needs_reauth" } : {};
      const state = { stores: STORES, chooseRows, hiddenRows, picks, liveVariantIds, endedVariantIds, listingEnds, storeStatuses } as unknown as StubState;
      const add = listed.filter((size) => !picks.has(size) && random() < 0.4);
      const remove = listed.filter((size) => picks.has(size) && random() < 0.5);
      const offered = offeredOf(state, [...add, ...remove]);
      const plan = planSelectionChange({ pickedBefore: picks, add, remove, offered });
      const stub = stubSelectionEffects(state, plan, offered);
      const domain = domainEffects(state, plan);
      expect(stub.stores, `round ${round}`).toEqual(domain.stores);
      expect(stub.ends, `round ${round}`).toEqual(domain.ends);
      expect(stub.otherEntriesHash, `round ${round}`).toBe(domain.otherEntriesHash);
      expect(stub.effectsHash, `round ${round}`).toBe(domain.effectsHash);
      totals.ends += domain.ends.listingIds.length;
      totals.quantityEffects += domain.stores.reduce((sum, store) => sum + store.goesToZero + store.startsSelling, 0);
      totals.hidden += domain.ends.hiddenRemovedIds.length;
      totals.superseded += stub.decision.supersedeIds.length;
      totals.reported += domain.ends.stillEnding + domain.ends.endReview + domain.ends.endedReAdd;
      totals.waiting += domain.stores.filter((store) => store.ends > 0 && !store.storeConnected).length;
    }
    // Not vacuous: the table planned ends, quantity effects, hidden removals, supersedes, re-add reports and ends that
    // wait for a store (the seed fixes the counts).
    expect(totals.ends).toBeGreaterThan(300);
    expect(totals.quantityEffects).toBeGreaterThan(300);
    for (const key of ["hidden", "superseded", "reported", "waiting"] as const) expect(totals[key], key).toBeGreaterThan(10);
  });
});
