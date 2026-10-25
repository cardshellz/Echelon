import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DropshipCatalogExposureRule } from "../../domain/catalog-exposure";
import { DropshipError } from "../../domain/errors";
import {
  decideDropshipStockPublicationSelection,
  type DropshipStockSelectionCandidate,
  type DropshipStockSelectionConfig,
} from "../../domain/stock-publication-selection";
import {
  classifySelectionEffect,
  compareSelectionEffects,
  decideSelectionEffects,
  selectionEffectsHash,
  type DecideSelectionEffectsInput,
  type SelectionEffectEntry,
  type SelectionEffectsListing,
  type SelectionEffectsStore,
} from "../../domain/vendor-selection-effects";

/**
 * What a step 1 save does to the vendor's listings (step 1 plan S2-5, PLAN-B v4.1 §7.5, §7.6, §15.1; V20,
 * V39): counted only where Echelon acts, with #1900's listing states.
 */

const NOW = new Date("2026-10-24T12:00:00.000Z");
const LIVE: DropshipStockSelectionConfig = { listingMode: "live", inventoryMode: "managed_quantity_sync", isActive: true };
const ADMIN_RULES: readonly DropshipCatalogExposureRule[] = [{ id: 1, scopeType: "catalog", action: "include" }];

function candidate(productVariantId: number, patch: Partial<DropshipStockSelectionCandidate> = {}): DropshipStockSelectionCandidate {
  return { productId: 1_000 + Math.floor(productVariantId / 10), productVariantId, productLineIds: [3], category: "Supplies",
    productIsActive: true, variantIsActive: true, variantUomType: "pack", requiresShipping: true, trackInventory: true,
    salesEligibility: "sellable", ...patch };
}

function listing(id: number, productVariantId: number, patch: Partial<SelectionEffectsListing> = {}): SelectionEffectsListing {
  return { id, productVariantId, status: "active", externalListingId: `L-${id}`, externalOfferId: `O-${id}`, livePushItemId: null,
    vendorQuantityLimit: null, marketplaceEndedAt: null, marketplaceIssueCodes: [], ...patch };
}

function store(storeConnectionId: number, listings: SelectionEffectsListing[], patch: Partial<SelectionEffectsStore> = {}): SelectionEffectsStore {
  return { storeConnectionId, storeName: `Store ${storeConnectionId}`, platform: "ebay", config: LIVE, storePaused: false, listings, ...patch };
}

function effects(input: Partial<DecideSelectionEffectsInput> & { stores: SelectionEffectsStore[] }) {
  const touched = [...(input.insertIds ?? []), ...(input.deleteIds ?? [])];
  return decideSelectionEffects({
    now: NOW, insertIds: [], deleteIds: [], adminRules: ADMIN_RULES, overrides: [],
    candidates: touched.map((id) => candidate(id)), ...input,
  });
}

/** One listing on one live store: the effect of removing (pick → no pick) or re-adding (no pick → pick) its size. */
function oneListing(direction: "remove" | "add", patch: Partial<SelectionEffectsListing> = {}, storePatch: Partial<SelectionEffectsStore> = {}) {
  return effects({ [direction === "remove" ? "deleteIds" : "insertIds"]: [11], stores: [store(7, [listing(501, 11, patch)], storePatch)] });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function refusal(run: () => unknown): DropshipError {
  try {
    run();
  } catch (error) {
    if (error instanceof DropshipError) return error;
    throw error;
  }
  throw new Error("expected a DropshipError");
}

/** A seeded generator (mulberry32), so the property case is reproducible. */
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

describe("selection effects: the confirm counts (§7.6)", () => {
  it("removing a selected size with a live listing sets it to quantity 0", () => {
    const result = oneListing("remove");
    expect(result.entries).toEqual([[7, 501, 11, "goesToZero"]]);
    expect(result.stores).toEqual([{ storeConnectionId: 7, storeName: "Store 7", platform: "ebay", goesToZero: 1, startsSelling: 0 }]);
  });

  it("re-adding a zeroed size whose listing is in a live managed store gets its quantity back", () => {
    expect(oneListing("add").entries).toEqual([[7, 501, 11, "startsSelling"]]);
    // A listing a failed push left as failed/queued/blocked still has its eBay identity and duty.
    for (const status of ["queued", "failed", "blocked", "drift_detected", "pushing"]) {
      expect(oneListing("add", { status }).entries, status).toEqual([[7, 501, 11, "startsSelling"]]);
    }
  });

  it.each([
    ["a paused store", {}, { storePaused: true }],
    ["a paused listing", { status: "paused" }, {}],
    ["an inactive listing config", {}, { config: { ...LIVE, isActive: false } }],
    ["a draft-first store", {}, { config: { ...LIVE, listingMode: "draft_first" as const } }],
    ["a manual-quantity store", {}, { config: { ...LIVE, inventoryMode: "manual_quantity" as const } }],
    ["a store without a listing config", {}, { config: null }],
    ["a never-listed size", { status: "not_listed", externalListingId: null, externalOfferId: null }, {}],
    ["a preview-only size", { status: "preview_ready", externalListingId: null, externalOfferId: null }, {}],
  ] as const)("nothing changes for %s, either way", (_label, listingPatch, storePatch) => {
    expect(oneListing("add", listingPatch, storePatch).entries).toEqual([]);
    expect(oneListing("remove", listingPatch, storePatch).entries).toEqual([]);
  });

  it("a size with no listing row on a store, or not touched, has no entry", () => {
    expect(effects({ insertIds: [11], deleteIds: [12], stores: [store(7, [])] }).entries).toEqual([]);
    expect(effects({ insertIds: [11], stores: [store(7, [listing(502, 13)])] }).entries).toEqual([]);
  });

  it("a size Card Shellz does not expose, or the vendor turned off, never starts selling", () => {
    expect(effects({ insertIds: [11], adminRules: [], stores: [store(7, [listing(501, 11)])] }).entries).toEqual([]);
    expect(effects({ insertIds: [11], overrides: [{ productVariantId: 11, enabledOverride: false }], stores: [store(7, [listing(501, 11)])] })
      .entries).toEqual([]);
    expect(effects({ insertIds: [11], candidates: [candidate(11, { salesEligibility: "internal_only" })], stores: [store(7, [listing(501, 11)])] })
      .entries).toEqual([]);
  });

  it("a size missing from the catalog has no effect (retained duty is zero before and after)", () => {
    expect(effects({ deleteIds: [11], candidates: [], stores: [store(7, [listing(501, 11)])] }).entries).toEqual([]);
  });
});

describe("selection effects: #1900 listing states (V20)", () => {
  const ended = new Date("2026-10-20T08:00:00.000Z");

  it("an ended listing re-added is no change, never startsSelling, even with a newer saved live push", () => {
    expect(oneListing("add", { status: "ended", marketplaceEndedAt: ended }).entries).toEqual([]);
    expect(oneListing("add", { status: "ended", marketplaceEndedAt: ended, livePushItemId: 88 }).entries).toEqual([]);
    expect(oneListing("add", { status: "ended" }).entries).toEqual([]);
  });

  it.each(["queued", "failed", "blocked"])("a %s listing with ids and an eBay end time re-added is no change, though the stock decision publishes", (status) => {
    const row = listing(501, 11, { status, marketplaceEndedAt: ended });
    // The stock decision alone would publish it: the end time survives the status overwrite.
    expect(decideDropshipStockPublicationSelection({ productVariantId: 11, candidate: candidate(11), rules: ADMIN_RULES, picked: true,
      override: null, listing: row, config: LIVE, storePaused: false, now: NOW }).action).toBe("publish");
    expect(oneListing("add", { status, marketplaceEndedAt: ended }).entries).toEqual([]);
    expect(oneListing("remove", { status, marketplaceEndedAt: ended }).entries).toEqual([]);
  });

  it("removing a listing that ended on eBay is no change", () => {
    expect(oneListing("remove", { status: "ended", marketplaceEndedAt: ended }).entries).toEqual([]);
    expect(oneListing("remove", { marketplaceEndedAt: ended }).entries).toEqual([]);
  });

  it("an eBay stock-out end (live status, ended_out_of_stock) is no change either way", () => {
    const patch = { marketplaceIssueCodes: ["ended_out_of_stock"] };
    expect(oneListing("add", patch).entries).toEqual([]);
    expect(oneListing("remove", patch).entries).toEqual([]);
    // Other issues do not end a listing.
    expect(oneListing("add", { marketplaceIssueCodes: ["price_outside_card_shellz_limit"] }).entries).toEqual([[7, 501, 11, "startsSelling"]]);
  });

  it("a vendor limit of 0 publishes 0: no change; a limit of 3 sells", () => {
    expect(oneListing("add", { vendorQuantityLimit: 0 }).entries).toEqual([]);
    expect(oneListing("remove", { vendorQuantityLimit: 0 }).entries).toEqual([]);
    expect(oneListing("add", { vendorQuantityLimit: 3 }).entries).toEqual([[7, 501, 11, "startsSelling"]]);
    expect(oneListing("remove", { vendorQuantityLimit: 3 }).entries).toEqual([[7, 501, 11, "goesToZero"]]);
  });

  it("a saved live-push item without eBay ids is no change: nothing is on eBay", () => {
    const patch = { status: "failed", externalListingId: null, externalOfferId: null, livePushItemId: 77 };
    expect(decideDropshipStockPublicationSelection({ productVariantId: 11, candidate: candidate(11), rules: ADMIN_RULES, picked: true,
      override: null, listing: listing(501, 11, patch), config: LIVE, storePaused: false, now: NOW }).action).toBe("publish");
    expect(oneListing("add", patch).entries).toEqual([]);
    expect(oneListing("remove", patch).entries).toEqual([]);
    expect(oneListing("add", { externalListingId: "  ", externalOfferId: "" }).entries).toEqual([]);
  });

  it("one eBay id is identity enough", () => {
    expect(oneListing("add", { externalListingId: null }).entries).toEqual([[7, 501, 11, "startsSelling"]]);
    expect(oneListing("add", { externalOfferId: null }).entries).toEqual([[7, 501, 11, "startsSelling"]]);
  });
});

describe("classifySelectionEffect", () => {
  const live = listing(1, 2);
  const publish = { action: "publish" as const };

  it("classifies by whether each decision sells", () => {
    expect(classifySelectionEffect({ before: publish, after: { action: "zero" }, listing: live })).toBe("goesToZero");
    expect(classifySelectionEffect({ before: { action: "zero" }, after: publish, listing: live })).toBe("startsSelling");
    expect(classifySelectionEffect({ before: { action: "none" }, after: { action: "read_only" }, listing: live })).toBeNull();
    expect(classifySelectionEffect({ before: publish, after: publish, listing: live })).toBeNull();
    expect(classifySelectionEffect({ before: { action: "publish", publishLimitUnits: 0 }, after: publish, listing: live })).toBe("startsSelling");
    expect(classifySelectionEffect({ before: publish, after: { action: "publish", publishLimitUnits: 0 }, listing: live })).toBe("goesToZero");
  });
});

describe("selection effects: stores, order, hash and input safety", () => {
  function twoStores(): DecideSelectionEffectsInput {
    return {
      now: NOW, insertIds: [21, 22], deleteIds: [11, 12], adminRules: ADMIN_RULES, overrides: [],
      candidates: [11, 12, 21, 22].map((id) => candidate(id)),
      stores: [
        store(9, [listing(905, 22), listing(901, 11), listing(903, 21, { status: "ended" })]),
        store(4, [listing(401, 11), listing(402, 12), listing(403, 21)]),
        store(6, [], { storeName: "Empty store" }),
      ],
    };
  }

  it("counts per store, every store listed in id order, entries sorted by store, listing and size", () => {
    const result = decideSelectionEffects(twoStores());
    expect(result.stores).toEqual([
      { storeConnectionId: 4, storeName: "Store 4", platform: "ebay", goesToZero: 2, startsSelling: 1 },
      { storeConnectionId: 6, storeName: "Empty store", platform: "ebay", goesToZero: 0, startsSelling: 0 },
      { storeConnectionId: 9, storeName: "Store 9", platform: "ebay", goesToZero: 1, startsSelling: 1 },
    ]);
    expect(result.entries).toEqual([
      [4, 401, 11, "goesToZero"], [4, 402, 12, "goesToZero"], [4, 403, 21, "startsSelling"],
      [9, 901, 11, "goesToZero"], [9, 905, 22, "startsSelling"],
    ]);
    expect(result.effectsHash).toBe(createHash("sha256").update(JSON.stringify(result.entries)).digest("hex"));
  });

  it("the hash does not depend on read order", () => {
    const input = twoStores();
    const reordered: DecideSelectionEffectsInput = {
      ...input, insertIds: [...input.insertIds].reverse(), deleteIds: [...input.deleteIds].reverse(),
      candidates: [...input.candidates].reverse(),
      stores: [...input.stores].reverse().map((entry) => ({ ...entry, listings: [...entry.listings].reverse() })),
    };
    expect(decideSelectionEffects(reordered)).toEqual(decideSelectionEffects(input));
    const entries = decideSelectionEffects(input).entries;
    expect(selectionEffectsHash([...entries].reverse())).toBe(selectionEffectsHash(entries));
  });

  it("the hash covers each entry's bucket and identity", () => {
    const entries: SelectionEffectEntry[] = [[4, 401, 11, "goesToZero"], [9, 905, 22, "startsSelling"]];
    const base = selectionEffectsHash(entries);
    expect(selectionEffectsHash([[4, 401, 11, "startsSelling"], entries[1]])).not.toBe(base);
    expect(selectionEffectsHash([[4, 402, 11, "goesToZero"], entries[1]])).not.toBe(base);
    expect(selectionEffectsHash([[5, 401, 11, "goesToZero"], entries[1]])).not.toBe(base);
    expect(selectionEffectsHash([entries[0]])).not.toBe(base);
    expect(selectionEffectsHash([])).toBe(createHash("sha256").update("[]").digest("hex"));
  });

  it("an empty change has no entries and the empty hash", () => {
    const result = effects({ stores: [store(7, [listing(501, 11)])] });
    expect(result).toEqual({
      stores: [{ storeConnectionId: 7, storeName: "Store 7", platform: "ebay", goesToZero: 0, startsSelling: 0 }],
      entries: [], effectsHash: selectionEffectsHash([]),
    });
  });

  it("never mutates its inputs", () => {
    const input = deepFreeze(twoStores());
    const before = JSON.stringify(input);
    decideSelectionEffects(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("counts 10,000 removals and 10,001 re-adds on one store", () => {
    const removed = Array.from({ length: 10_000 }, (_, index) => index + 1);
    const added = Array.from({ length: 10_001 }, (_, index) => 20_001 + index);
    const result = decideSelectionEffects({
      now: NOW, insertIds: added, deleteIds: removed, adminRules: ADMIN_RULES, overrides: [],
      candidates: [...removed, ...added].map((id) => candidate(id)),
      stores: [store(7, [...removed, ...added].map((id) => listing(id, id)))],
    });
    expect(result.stores[0]).toMatchObject({ goesToZero: 10_000, startsSelling: 10_001 });
    expect(result.entries).toHaveLength(20_001);
  });

  it("refuses ambiguous facts and a size both inserted and deleted", () => {
    expect(refusal(() => effects({ deleteIds: [11], stores: [store(7, [listing(501, 11), listing(502, 11)])] })).code)
      .toBe("DROPSHIP_STOCK_SELECTION_AMBIGUOUS");
    expect(refusal(() => effects({ deleteIds: [11], stores: [store(7, []), store(7, [])] })).code).toBe("DROPSHIP_STOCK_SELECTION_AMBIGUOUS");
    expect(refusal(() => effects({ deleteIds: [11], candidates: [candidate(11), candidate(11)], stores: [store(7, [])] })).code)
      .toBe("DROPSHIP_STOCK_SELECTION_AMBIGUOUS");
    expect(refusal(() => effects({ deleteIds: [11], overrides: [{ productVariantId: 11 }, { productVariantId: 11 }], stores: [store(7, [])] })).code)
      .toBe("DROPSHIP_STOCK_SELECTION_AMBIGUOUS");
    const conflict = refusal(() => effects({ insertIds: [11], deleteIds: [11], stores: [store(7, [])] }));
    expect(conflict.code).toBe("DROPSHIP_SELECTION_CHANGE_CONFLICTING");
    expect(conflict.context).toMatchObject({ classification: "permanent" });
    expect(refusal(() => effects({ insertIds: [0], stores: [store(7, [])] })).code).toBe("DROPSHIP_SELECTION_CHANGE_INVALID_INPUT");
  });
});

describe("the drift rule (§7.5, V39)", () => {
  const a = selectionEffectsHash([[4, 401, 11, "goesToZero"]]);
  const b = selectionEffectsHash([]);

  it("unchanged effects proceed", () => {
    expect(compareSelectionEffects({ expectedEffectsHash: a, actualEffectsHash: a, addIds: [5] })).toEqual({ outcome: "unchanged", effectsHash: a });
    expect(compareSelectionEffects({ expectedEffectsHash: a, actualEffectsHash: a, addIds: [] })).toEqual({ outcome: "unchanged", effectsHash: a });
  });

  it("no adds and different effects: proceed with both hashes", () => {
    expect(compareSelectionEffects({ expectedEffectsHash: a, actualEffectsHash: b, addIds: [] }))
      .toEqual({ outcome: "drifted", expectedEffectsHash: a, actualEffectsHash: b });
  });

  it("adds and any difference: changed (409, re-confirm)", () => {
    expect(compareSelectionEffects({ expectedEffectsHash: a, actualEffectsHash: b, addIds: [5] }))
      .toEqual({ outcome: "changed", expectedEffectsHash: a, actualEffectsHash: b });
  });

  it("refuses a hash that is not sha256 hex", () => {
    for (const bad of ["", "A".repeat(64), "a".repeat(63), `${"a".repeat(63)}g`]) {
      expect(refusal(() => compareSelectionEffects({ expectedEffectsHash: bad, actualEffectsHash: a, addIds: [] })).code)
        .toBe("DROPSHIP_SELECTION_CHANGE_INVALID_INPUT");
      expect(refusal(() => compareSelectionEffects({ expectedEffectsHash: a, actualEffectsHash: bad, addIds: [] })).code)
        .toBe("DROPSHIP_SELECTION_CHANGE_INVALID_INPUT");
    }
  });

  it("an eBay end between preview and save moves a goesToZero entry to nothing (the drift a removal may see)", () => {
    const preview = oneListing("remove");
    const save = oneListing("remove", { marketplaceEndedAt: new Date("2026-10-24T11:59:00.000Z") });
    expect(preview.entries).toEqual([[7, 501, 11, "goesToZero"]]);
    expect(save.entries).toEqual([]);
    expect(compareSelectionEffects({ expectedEffectsHash: preview.effectsHash, actualEffectsHash: save.effectsHash, addIds: [] }).outcome)
      .toBe("drifted");
  });

  it("property: a change with no adds never produces startsSelling, for any listing state (seeded)", () => {
    const random = seededRandom(20_261_024);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
    const statuses = ["not_listed", "preview_ready", "queued", "pushing", "active", "paused", "ended", "failed", "blocked", "drift_detected"];
    const configs: (DropshipStockSelectionConfig | null)[] = [LIVE, LIVE, LIVE, null, { ...LIVE, isActive: false },
      { ...LIVE, listingMode: "draft_first" }, { ...LIVE, inventoryMode: "disabled" }];
    let goesToZero = 0;
    for (let round = 0; round < 400; round += 1) {
      const sizes = Array.from({ length: 6 }, (_, index) => round * 10 + index + 1);
      const stores = [1, 2, 3].map((storeConnectionId) => store(storeConnectionId, sizes.filter(() => random() < 0.8).map((size, index) =>
        listing(storeConnectionId * 100_000 + size * 10 + index, size, {
          status: pick(statuses),
          externalListingId: pick([null, "", "L", "L", " "]),
          externalOfferId: pick([null, "O"]),
          livePushItemId: pick([null, 9]),
          vendorQuantityLimit: pick([null, 0, 3]),
          marketplaceEndedAt: pick([null, null, null, NOW]),
          marketplaceIssueCodes: pick([[], ["ended_out_of_stock"], ["sku_changed"]]),
        })), { config: pick(configs), storePaused: random() < 0.2 }));
      const result = decideSelectionEffects({
        now: NOW, insertIds: [], deleteIds: sizes.filter(() => random() < 0.7), adminRules: pick([ADMIN_RULES, ADMIN_RULES, []]),
        overrides: sizes.filter(() => random() < 0.2).map((productVariantId) => ({ productVariantId, enabledOverride: pick([false, true, null]) })),
        candidates: sizes.filter(() => random() < 0.9).map((id) => candidate(id, {
          salesEligibility: pick(["sellable", "internal_only"] as const), trackInventory: pick([true, false]) })),
        stores,
      });
      expect(result.entries.filter((entry) => entry[3] === "startsSelling")).toEqual([]);
      expect(result.stores.every((entry) => entry.startsSelling === 0)).toBe(true);
      goesToZero += result.entries.length;
    }
    // Not vacuous: removals did set listings to quantity 0 (the seed fixes the count).
    expect(goesToZero).toBeGreaterThan(30);
  });
});
