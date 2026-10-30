import { describe, expect, it } from "vitest";
import type { StockLinkStoreItem } from "@shared/types/stock-link";
import {
  STOCK_LINK_DECISION_CODES as D,
  STOCK_LINK_RETIRE_HOLD,
  STOCK_LINK_RETRY,
  buildCarriedSkuIndex,
  isStockLinkItemOnSale,
  isStockLinkItemEligible,
  normalizeShopifyItemId,
  normalizeStockLinkSku,
  planStockLinkBatch,
  sizesSharingSku,
  stockLinkBusyDelayMs,
  stockLinkFirstVerifyDelayMs,
  stockLinkPauseDelayMs,
  stockLinkRetireWindowStart,
  stockLinkSkusEqual,
  stockLinkTransientDelayMs,
  stockLinkWaitDelayMs,
  type StockLinkBatchInput,
  type StockLinkBatchPlan,
  type StockLinkDestinationHead,
  type StockLinkHeadFact,
  type StockLinkSizeFacts,
} from "../../domain/stock-link";
import { StockLinkError } from "../../domain/stock-link-errors";

// Channels PR2 (PLAN-CH2 v4.1 §4.2, §11.1): every row of the first-link and verify tables, the "changed" outcomes,
// the joint rule, the candidate union, N6, the safety stops and the retry schedule, on pure inputs.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const item = (itemId: string, sku: string | null, productStatus = "ACTIVE"): StockLinkStoreItem =>
  ({ itemId, sku, productId: "77", productStatus });

function size(productVariantId: number, overrides: Partial<StockLinkSizeFacts> = {}): StockLinkSizeFacts {
  return {
    productVariantId, productId: 1, cardShellzSku: `SKU-${productVariantId}`,
    selection: { action: "publish", blockerCodes: [] }, head: null, observedSku: null, feedHintItemId: null,
    ...overrides,
  };
}

const linked = (mappingId: number, itemId: string, externalSku: string | null, revision = "3",
  draft: StockLinkHeadFact["draft"] = null): StockLinkHeadFact =>
  ({ revision, active: { mappingId, itemId, externalSku }, draft });

interface PlanInput {
  sizes: StockLinkSizeFacts[];
  otherHeads?: StockLinkDestinationHead[];
  otherCarried?: { productVariantId: number; sku: string | null }[];
  lookedUp?: string[];
  items?: StockLinkStoreItem[];
  observations?: [string, StockLinkStoreItem | null][];
  controlReadDone?: boolean;
  recentRetireCount?: number;
}

/** The batch's own heads are always part of the destination's heads; looked-up SKUs default to every batch SKU. */
function plan(input: PlanInput): StockLinkBatchPlan {
  const batchHeads = input.sizes.filter(row => row.head).map(row => ({ productVariantId: row.productVariantId,
    activeItemId: row.head!.active?.itemId ?? null, draftItemId: row.head!.draft?.itemId ?? null }));
  const request: StockLinkBatchInput = {
    sizes: input.sizes,
    destinationHeads: [...batchHeads, ...(input.otherHeads ?? [])],
    carriedSkus: input.otherCarried ?? [],
    reads: {
      lookedUpSkus: input.lookedUp ?? input.sizes.map(row => row.cardShellzSku?.trim() ?? "").filter(sku => sku.length > 0),
      lookupItems: input.items ?? [],
      observations: (input.observations ?? []).map(([itemId, observed]) => ({ itemId, item: observed })),
      controlReadDone: input.controlReadDone ?? false,
    },
    recentRetireCount: input.recentRetireCount ?? 0,
  };
  return planStockLinkBatch(request);
}

const decisionOf = (result: StockLinkBatchPlan, productVariantId: number) =>
  result.decisions.find(row => row.productVariantId === productVariantId)!;

describe("stock-link SKU and id rules", () => {
  it("trims, upper-cases and treats blank after trim as blank", () => {
    expect(normalizeStockLinkSku("  ab-c ")).toEqual({ kind: "sku", value: "ab-c", key: "AB-C", storable: true });
    for (const raw of ["", "   ", "\t\n", null, undefined]) expect(normalizeStockLinkSku(raw)).toEqual({ kind: "blank" });
  });

  it("compares case-insensitively and never equals blank to blank", () => {
    expect(stockLinkSkusEqual(normalizeStockLinkSku(" ABC"), normalizeStockLinkSku("abc"))).toBe(true);
    expect(stockLinkSkusEqual(normalizeStockLinkSku("ABC"), normalizeStockLinkSku("ABD"))).toBe(false);
    expect(stockLinkSkusEqual(normalizeStockLinkSku(""), normalizeStockLinkSku(" "))).toBe(false);
  });

  it("counts length in characters: 100 fit, 101 never equal anything, astral characters count once", () => {
    expect(normalizeStockLinkSku("A".repeat(100))).toMatchObject({ storable: true });
    const long = normalizeStockLinkSku("A".repeat(101));
    expect(long).toMatchObject({ kind: "sku", storable: false });
    expect(stockLinkSkusEqual(long, normalizeStockLinkSku("A".repeat(101)))).toBe(false);
    expect(normalizeStockLinkSku("\u{1F600}".repeat(100))).toMatchObject({ storable: true });
    expect(normalizeStockLinkSku("\u{1F600}".repeat(101))).toMatchObject({ storable: false });
  });

  it("keeps decimal ids, converts exactly the InventoryItem gid, and refuses everything else", () => {
    expect(normalizeShopifyItemId("123")).toBe("123");
    expect(normalizeShopifyItemId("gid://shopify/InventoryItem/123")).toBe("123");
    for (const raw of ["gid://shopify/ProductVariant/123", " 123", "123 ", "0123", "0", "-1", "1.0",
      "gid://shopify/InventoryItem/0", "gid://shopify/InventoryItem/123?x=1", "GID://shopify/InventoryItem/1", "", null, undefined]) {
      expect(normalizeShopifyItemId(raw)).toBeNull();
    }
  });

  it("only an ACTIVE product is on sale (archived, draft and unknown statuses are not)", () => {
    expect(isStockLinkItemOnSale({ productStatus: "ACTIVE" })).toBe(true);
    for (const status of ["ARCHIVED", "DRAFT", "UNLISTED", "active"]) expect(isStockLinkItemOnSale({ productStatus: status })).toBe(false);
  });

  it("separates a draft's stock-link eligibility from its sale status", () => {
    expect(isStockLinkItemEligible({ productStatus: "ACTIVE" })).toBe(true);
    expect(isStockLinkItemEligible({ productStatus: "DRAFT" })).toBe(true);
    expect(isStockLinkItemOnSale({ productStatus: "DRAFT" })).toBe(false);
    for (const status of ["ARCHIVED", "UNLISTED", "UNKNOWN", "draft", "active", ""])
      expect(isStockLinkItemEligible({ productStatus: status })).toBe(false);
  });

  it("N6 index groups carried sizes by normalised SKU and skips blanks", () => {
    const index = buildCarriedSkuIndex([{ productVariantId: 3, sku: "abc" }, { productVariantId: 1, sku: " ABC" },
      { productVariantId: 2, sku: "  " }, { productVariantId: 4, sku: "XYZ" }]);
    expect(index.get("ABC")).toEqual([1, 3]);
    expect(index.has("")).toBe(false);
    expect(sizesSharingSku(index, normalizeStockLinkSku("Abc"), 1)).toEqual([3]);
    expect(sizesSharingSku(index, normalizeStockLinkSku("XYZ"), 4)).toEqual([]);
    expect(sizesSharingSku(index, normalizeStockLinkSku(""), 4)).toEqual([]);
  });
});

describe("first link (no active version), §4.2 rows 1-10", () => {
  it("row 1: a blank Card Shellz SKU is flagged F1", () => {
    const result = plan({ sizes: [size(10, { cardShellzSku: "   " })] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "flagged", code: D.skuBlank, rule: "L1" });
    expect(result.commands).toEqual([]);
  });

  it("row 2 (N6, B20): a removed (zero) size and a live size with one SKU are both F4, nothing linked", () => {
    const result = plan({
      sizes: [size(10, { cardShellzSku: "ABC" }), size(11, { cardShellzSku: "abc ", selection: { action: "zero", blockerCodes: [] } })],
      items: [item("500", "ABC")],
    });
    for (const variantId of [10, 11]) {
      expect(decisionOf(result, variantId)).toMatchObject({ change: "none", status: "flagged", code: D.itemShared, rule: "L2",
        detail: { kind: "ECHELON_SKU_SHARED", productVariantIds: [10, 11] } });
    }
    expect(result.commands).toEqual([]);
  });

  it("row 2 (N6): a carried size outside the batch with the same SKU (override collision) flags the claimed size", () => {
    const result = plan({ sizes: [size(10, { cardShellzSku: "OVR-1" })], otherCarried: [{ productVariantId: 99, sku: " ovr-1" }],
      items: [item("500", "OVR-1")] });
    expect(decisionOf(result, 10)).toMatchObject({ code: D.itemShared, detail: { productVariantIds: [10, 99] } });
  });

  it("row 3: selection blockers, or a size that is not carried, wait SELECTION_BLOCKED", () => {
    const result = plan({ sizes: [
      size(10, { selection: { action: "publish", blockerCodes: ["CHANNEL_SELECTION_MAPPING_QUARANTINED"] } }),
      size(11, { selection: { action: "read_only", blockerCodes: [] } }),
    ], items: [item("500", "SKU-10"), item("501", "SKU-11")] });
    expect(decisionOf(result, 10)).toMatchObject({ status: "waiting", code: D.selectionBlocked, retry: null,
      detail: { kind: "SELECTION_BLOCKED", blockerCodes: ["CHANNEL_SELECTION_MAPPING_QUARANTINED"] } });
    expect(decisionOf(result, 11)).toMatchObject({ status: "waiting", code: D.selectionBlocked });
  });

  it("row 4 (B16): no lookup result but the feed-hint item is on sale with the SKU → transient LOOKUP_MISSED, no link", () => {
    const result = plan({ sizes: [size(10, { feedHintItemId: "gid://shopify/InventoryItem/700" })],
      observations: [["700", item("700", "sku-10")]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "waiting", code: D.lookupMissed, retry: "transient", rule: "L4" });
    expect(result.commands).toEqual([]);
  });

  it("row 4: a search that returned only an archived copy while the hint is on sale is also a miss (D-P2-4)", () => {
    const result = plan({ sizes: [size(10, { feedHintItemId: "700" })], items: [item("600", "SKU-10", "ARCHIVED")],
      observations: [["700", item("700", "SKU-10")]] });
    expect(decisionOf(result, 10)).toMatchObject({ code: D.lookupMissed, retry: "transient" });
  });

  it("row 5: no candidate waits NOT_LISTED, or NOT_ON_SALE when only archived or unknown copies exist", () => {
    expect(decisionOf(plan({ sizes: [size(10)] }), 10)).toMatchObject({ status: "waiting", code: D.notListed, retry: null });
    const result = plan({ sizes: [size(10)], items: [item("600", "SKU-10", "ARCHIVED"), item("601", "sku-10", "UNKNOWN")] });
    expect(decisionOf(result, 10)).toMatchObject({ status: "waiting", code: D.notOnSale });
    // An archived hint is not eligible and is not a lookup miss either.
    const hinted = plan({ sizes: [size(10, { feedHintItemId: "700" })], observations: [["700", item("700", "SKU-10", "ARCHIVED")]] });
    expect(decisionOf(hinted, 10)).toMatchObject({ code: D.notOnSale });
  });

  it("row 6 (B17): two on-sale items with the SKU are flagged F3, never linked", () => {
    const result = plan({ sizes: [size(10)], items: [item("501", "SKU-10"), item("500", "sku-10 ")] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "flagged", code: D.skuDuplicate,
      detail: { kind: "SKU_DUPLICATE", itemIds: ["500", "501"] } });
    expect(result.commands).toEqual([]);
  });

  it("row 6 (SAF-10 union): the lookup returns one item and the observed hint is another on-sale copy → F3", () => {
    const result = plan({ sizes: [size(10, { feedHintItemId: "700" })], items: [item("500", "SKU-10")],
      observations: [["700", item("700", "SKU-10")]] });
    expect(decisionOf(result, 10)).toMatchObject({ code: D.skuDuplicate, detail: { itemIds: ["500", "700"] } });
  });

  it("B6: an archived copy does not count; the one Active copy links", () => {
    const result = plan({ sizes: [size(10)], items: [item("600", "SKU-10", "ARCHIVED"), item("500", "SKU-10")] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "link", status: "linked", link: { itemId: "500" } });
  });

  it("row 7: an item held by another head of the destination is F4 ITEM_HELD and wakes the holder (SAF-5)", () => {
    const result = plan({ sizes: [size(10)], items: [item("500", "SKU-10")],
      otherHeads: [{ productVariantId: 44, activeItemId: "500", draftItemId: null }] });
    expect(decisionOf(result, 10)).toMatchObject({ status: "flagged", code: D.itemShared, waitingItemId: "500",
      detail: { kind: "ITEM_HELD", itemId: "500", heldByProductVariantIds: [44] } });
    expect(result.wakeVariantIds).toEqual([44]);
  });

  it("row 7: a gid/decimal pair of one item is the same item (F4), and a pending draft of another size holds it", () => {
    const gid = plan({ sizes: [size(10)], items: [item("500", "SKU-10")],
      otherHeads: [{ productVariantId: 44, activeItemId: "gid://shopify/InventoryItem/500", draftItemId: null }] });
    expect(decisionOf(gid, 10)).toMatchObject({ code: D.itemShared, detail: { heldByProductVariantIds: [44] } });
    const draft = plan({ sizes: [size(10)], items: [item("500", "SKU-10")],
      otherHeads: [{ productVariantId: 45, activeItemId: "900", draftItemId: "500" }] });
    expect(decisionOf(draft, 10)).toMatchObject({ code: D.itemShared, detail: { heldByProductVariantIds: [45] } });
  });

  it("row 8: a pending draft that already names the item and SKU is promoted", () => {
    const head: StockLinkHeadFact = { revision: "1", active: null,
      draft: { mappingId: 7, itemId: "500", externalSku: "sku-10", definitionHash: "a".repeat(64) } };
    const result = plan({ sizes: [size(10, { head })], items: [item("500", "SKU-10")] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "link", rule: "L8", expectedHeadRevision: "1",
      link: { itemId: "500", storeSku: "SKU-10", mappingAction: "promote_draft", draft: { mappingId: 7, definitionHash: "a".repeat(64) } } });
  });

  it("row 9 (V3-7): a pending draft naming another item, or the same item as a gid, is replaced in place", () => {
    for (const draftItem of ["999", "gid://shopify/InventoryItem/500"]) {
      const head: StockLinkHeadFact = { revision: "2", active: null,
        draft: { mappingId: 8, itemId: draftItem, externalSku: "SKU-10", definitionHash: "b".repeat(64) } };
      const result = plan({ sizes: [size(10, { head })], items: [item("500", "SKU-10")] });
      expect(decisionOf(result, 10)).toMatchObject({ change: "link", rule: "L9",
        link: { itemId: "500", mappingAction: "replace_draft", draft: { mappingId: 8 } } });
    }
  });

  it("row 10 (B10): one free on-sale item links by create; SKU match is trimmed and case-insensitive", () => {
    const result = plan({ sizes: [size(10, { cardShellzSku: " abc-1 " })], lookedUp: ["abc-1"], items: [item("500", "ABC-1 ")] });
    const decision = decisionOf(result, 10);
    expect(decision).toMatchObject({ change: "link", status: "linked", code: null, rule: "L10", cardShellzSku: "abc-1",
      expectedHeadRevision: "0", link: { itemId: "500", storeSku: "ABC-1", mappingAction: "create", draft: null } });
    expect(result.commands).toEqual([{ productId: 1, purpose: "publish", members: [decision], freedItemIds: [] }]);
  });

  it("a 100-character SKU links; the same SKU one character longer on the store is another SKU", () => {
    const sku = "M".repeat(100);
    const result = plan({ sizes: [size(10, { cardShellzSku: sku })], items: [item("500", sku.toLowerCase()), item("501", `${sku}M`)] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "link", link: { itemId: "500", storeSku: sku.toLowerCase() } });
  });

  it("a removed (zero) size links for a 0 write: its command's purpose is sync", () => {
    const result = plan({ sizes: [size(10, { selection: { action: "zero", blockerCodes: [] } })], items: [item("500", "SKU-10")] });
    expect(result.commands[0]).toMatchObject({ purpose: "sync", members: [{ productVariantId: 10, change: "link" }] });
  });

  it("ignores a returned item whose SKU was not asked for", () => {
    const result = plan({ sizes: [size(10)], items: [item("500", "SKU-99")] });
    expect(decisionOf(result, 10)).toMatchObject({ code: D.notListed });
  });

  it("a size whose lookup or hint was not read is released busy (call budget), never decided", () => {
    const notLooked = plan({ sizes: [size(10)], lookedUp: ["OTHER"] });
    expect(decisionOf(notLooked, 10)).toMatchObject({ change: "none", status: "unchanged", retry: "busy", code: D.notRead });
    const hintNotSeen = plan({ sizes: [size(10, { feedHintItemId: "700" })], items: [item("500", "SKU-10")] });
    expect(decisionOf(hintNotSeen, 10)).toMatchObject({ status: "unchanged", code: D.notRead });
  });
});

describe("verify (active version exists), §4.2 V1-V10", () => {
  const otherLinked: StockLinkDestinationHead = { productVariantId: 90, activeItemId: "9000", draftItemId: null };
  const controlSeen: [string, StockLinkStoreItem | null] = ["9000", item("9000", "SKU-90")];

  it("V5: the item still carries the recorded SKU (any case), the Card Shellz SKU or the observed SKU → kept", () => {
    for (const [storeSku, externalSku, observedSku] of [["sku-10", "SKU-10", null], ["old", "OLD", null], ["seen", null, "SEEN"],
      ["Card", null, null]] as const) {
      const result = plan({ sizes: [size(10, { cardShellzSku: storeSku === "Card" ? "card" : "SKU-10", head: linked(5, "500", externalSku), observedSku })],
        items: [item("500", storeSku)], observations: [["500", item("500", storeSku)]] });
      // The search also returns the linked item when it carries the Card Shellz SKU; nothing else is reported.
      expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "linked", retry: null });
    }
  });

  it("V1: an unparseable saved id is changed; one candidate relinks to it", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, " 500", "SKU-10") })], items: [item("500", "SKU-10")] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "relink", rule: "V1/L10", replacesMappingId: 5, link: { itemId: "500" } });
  });

  it("V2: the linked item is gone; the re-added copy with the SKU is relinked at once (never held)", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10") })], items: [item("510", "SKU-10")],
      observations: [["500", null]], recentRetireCount: STOCK_LINK_RETIRE_HOLD.limit });
    expect(decisionOf(result, 10)).toMatchObject({ change: "relink", status: "linked", replacesMappingId: 5, link: { itemId: "510" } });
    expect(result.commands[0]).toMatchObject({ freedItemIds: ["500"] });
  });

  it("V2: gone with no replacement → retire + wait (a control was seen)", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10") })], otherHeads: [otherLinked],
      observations: [["500", null], controlSeen] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "retire", status: "waiting", code: D.notListed, replacesMappingId: 5 });
    expect(result.control).toEqual({ status: "present" });
    expect(result.pause).toBe("clear");
  });

  it("V3: the store SKU was erased and nothing replaces it → retire + F2", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10") })], otherHeads: [otherLinked],
      observations: [["500", item("500", "  ")], controlSeen] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "retire", status: "flagged", code: D.storeSkuBlank, rule: "V3/L5" });
  });

  it("V4 (V3-6): the item now carries another carried size's SKU → changed, even if it matches the recorded SKU", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SHARED-OLD") })], otherHeads: [otherLinked],
      otherCarried: [{ productVariantId: 20, sku: "shared-old" }], observations: [["500", item("500", "SHARED-OLD")], controlSeen] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "retire", rule: "V4/L5" });
  });

  it("V6 (V3-6): a link with no recorded SKU is kept once and its store SKU recorded; a later mismatch is changed", () => {
    const first = plan({ sizes: [size(10, { head: linked(5, "500", null) })], observations: [["500", item("500", " LEGACY ")]] });
    expect(decisionOf(first, 10)).toMatchObject({ change: "none", status: "linked", recordObservedSku: "LEGACY", rule: "V6" });
    const later = plan({ sizes: [size(10, { head: linked(5, "500", null), observedSku: "LEGACY" })], otherHeads: [otherLinked],
      observations: [["500", item("500", "RELABELLED")], controlSeen] });
    expect(decisionOf(later, 10)).toMatchObject({ change: "retire", rule: "V6b/L5" });
  });

  it("TST-12: a 101-character store SKU is another SKU: changed, never recorded", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", null) })], otherHeads: [otherLinked],
      observations: [["500", item("500", "Z".repeat(101))], controlSeen] });
    const decision = decisionOf(result, 10);
    expect(decision).toMatchObject({ change: "retire", rule: "V6b/L5", recordObservedSku: null });
    expect(JSON.stringify(decision)).not.toContain("Z".repeat(101));
  });

  it("V7: the linked item is archived and exactly one other on-sale copy exists → relink to it", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10") })], items: [item("510", "SKU-10")],
      observations: [["500", item("500", "SKU-10", "ARCHIVED")]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "relink", rule: "V7", replacesMappingId: 5, link: { itemId: "510" } });
    expect(result.commands[0]!.freedItemIds).toEqual(["500"]);
  });

  it.each([
    { name: "returned only the archived linked item", items: [item("500", "SKU-10", "ARCHIVED")] },
    { name: "returned nothing", items: [] },
  ])("V7b (review LNK-2, B16 for V7): the search $name while the feed-hint copy is on sale → keep the link, transient LOOKUP_MISSED", ({ items }) => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10"), feedHintItemId: "510" })], items,
      observations: [["500", item("500", "SKU-10", "ARCHIVED")], ["510", item("510", "SKU-10")]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "linked", link: null, code: D.lookupMissed,
      retry: "transient", rule: "V7b" });
    expect(result.commands).toEqual([]);
  });

  it("V8 (SAF-10): the linked item and one other on-sale copy → keep the link writing, flag F3", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10") })], items: [item("500", "SKU-10"), item("510", "SKU-10")],
      observations: [["500", item("500", "SKU-10")]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "flagged", code: D.skuDuplicate, rule: "V8" });
    expect(result.commands).toEqual([]);
  });

  it("V8b (SAF-3): another carried size shares this Card Shellz SKU → keep the link, flag F4", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10") })], otherCarried: [{ productVariantId: 20, sku: "sku-10" }],
      observations: [["500", item("500", "SKU-10")]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "flagged", code: D.itemShared, rule: "V8b",
      detail: { kind: "ECHELON_SKU_SHARED", productVariantIds: [10, 20] } });
  });

  it("V9: the linked item is on sale with the SKU but the search did not return it → keep, transient LOOKUP_MISSED", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10") })], observations: [["500", item("500", "SKU-10")]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "linked", code: D.lookupMissed, retry: "transient", rule: "V9" });
  });

  it("V10: a link saved as a gid is re-pointed to the decimal form of the same item; nothing is freed", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, "gid://shopify/InventoryItem/500", "SKU-10") })],
      items: [item("500", "SKU-10")], observations: [["500", item("500", "SKU-10")]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "relink", rule: "V10", replacesMappingId: 5, link: { itemId: "500" } });
    expect(result.commands[0]!.freedItemIds).toEqual([]);
  });

  it("a correct link whose Card Shellz SKU was blanked keeps writing and is flagged F1 (D-P2-5)", () => {
    const result = plan({ sizes: [size(10, { cardShellzSku: null, head: linked(5, "500", "SKU-10") })],
      observations: [["500", item("500", "SKU-10")]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "flagged", code: D.skuBlank });
  });

  it("a linked item that was not observed is released busy", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10") })] });
    expect(decisionOf(result, 10)).toMatchObject({ status: "unchanged", retry: "busy", code: D.notRead });
  });
});

describe("Shopify draft stock identity", () => {
  it("links a unique DRAFT item without making it on sale; archived and unknown copies do not compete", () => {
    const draft = item("500", "SKU-10", "DRAFT");
    const result = plan({ sizes: [size(10)], items: [draft, item("600", "SKU-10", "ARCHIVED"), item("601", "SKU-10", "UNKNOWN")] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "link", status: "linked", code: null,
      link: { itemId: "500", storeSku: "SKU-10", mappingAction: "create" } });
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ purpose: "publish", freedItemIds: [] });
    expect(draft.productStatus).toBe("DRAFT");
    expect(isStockLinkItemOnSale(draft)).toBe(false);
  });

  it.each([
    { name: "empty", items: [] },
    { name: "archived-only", items: [item("600", "SKU-10", "ARCHIVED")] },
  ])("requires complete lookup proof for a DRAFT feed hint with an $name result", ({ items }) => {
    const result = plan({ sizes: [size(10, { feedHintItemId: "500" })], items,
      observations: [["500", item("500", "SKU-10", "DRAFT")]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "waiting", code: D.lookupMissed, retry: "transient" });
    expect(result.commands).toEqual([]);
  });

  it.each(["ACTIVE", "DRAFT"])("refuses first-link ambiguity between DRAFT and %s copies", status => {
    const result = plan({ sizes: [size(10)], items: [item("500", "SKU-10", "DRAFT"), item("510", "SKU-10", status)] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "flagged", code: D.skuDuplicate,
      detail: { kind: "SKU_DUPLICATE", itemIds: ["500", "510"] } });
    expect(result.commands).toEqual([]);
  });

  it("counts a different DRAFT feed hint toward ambiguity with the lookup's ACTIVE item", () => {
    const result = plan({ sizes: [size(10, { feedHintItemId: "510" })], items: [item("500", "SKU-10")],
      observations: [["510", item("510", "SKU-10", "DRAFT")]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", code: D.skuDuplicate,
      detail: { itemIds: ["500", "510"] } });
    expect(result.commands).toEqual([]);
  });

  it("preserves selection and ownership safeguards for a unique DRAFT item", () => {
    const draft = item("500", "SKU-10", "DRAFT");
    const blocked = plan({ sizes: [size(10, { selection: { action: "publish", blockerCodes: ["CHANNEL_SELECTION_MAPPING_QUARANTINED"] } })],
      items: [draft] });
    expect(decisionOf(blocked, 10)).toMatchObject({ change: "none", code: D.selectionBlocked });
    expect(blocked.commands).toEqual([]);
    const held = plan({ sizes: [size(10)], items: [draft],
      otherHeads: [{ productVariantId: 44, activeItemId: "500", draftItemId: null }] });
    expect(decisionOf(held, 10)).toMatchObject({ change: "none", code: D.itemShared,
      detail: { heldByProductVariantIds: [44] } });
    expect(held.commands).toEqual([]);
  });

  it.each([null, item("500", "OTHER-SKU", "DRAFT")])("replaces a missing or SKU-changed old identity with the unique verified DRAFT", observed => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10") })],
      items: [item("510", "SKU-10", "DRAFT")], observations: [["500", observed]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "relink", status: "linked", replacesMappingId: 5,
      link: { itemId: "510" } });
    expect(result.commands[0]).toMatchObject({ freedItemIds: ["500"] });
  });

  it("keeps the same correct stock link through DRAFT and ACTIVE observations", () => {
    for (const productStatus of ["DRAFT", "ACTIVE", "DRAFT"]) {
      const current = item("500", "SKU-10", productStatus);
      const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10") })], items: [current], observations: [["500", current]] });
      expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "linked", code: null, link: null });
      expect(result.commands).toEqual([]);
    }
  });

  it.each([
    { linkedStatus: "DRAFT", otherStatus: "ACTIVE" },
    { linkedStatus: "DRAFT", otherStatus: "DRAFT" },
    { linkedStatus: "ACTIVE", otherStatus: "DRAFT" },
  ])("retains a correct $linkedStatus link and flags its $otherStatus duplicate", ({ linkedStatus, otherStatus }) => {
    const current = item("500", "SKU-10", linkedStatus);
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10") })],
      items: [current, item("510", "SKU-10", otherStatus)], observations: [["500", current]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "flagged", code: D.skuDuplicate, rule: "V8", link: null,
      detail: { kind: "SKU_DUPLICATE", itemIds: ["500", "510"] } });
    expect(result.commands).toEqual([]);
  });

  it("does not move a correct archived link to another DRAFT copy merely because it is eligible for first-link", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10") })], items: [item("510", "SKU-10", "DRAFT")],
      observations: [["500", item("500", "SKU-10", "ARCHIVED")]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "linked", code: null, link: null });
    expect(result.commands).toEqual([]);
  });

  it("does not choose the ACTIVE replacement when an archived link has both ACTIVE and DRAFT candidates", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10") })],
      items: [item("510", "SKU-10"), item("520", "SKU-10", "DRAFT")],
      observations: [["500", item("500", "SKU-10", "ARCHIVED")]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "flagged", code: D.skuDuplicate,
      detail: { itemIds: ["510", "520"] } });
    expect(result.commands).toEqual([]);
  });

  it("retains a correct DRAFT link missing from the lookup and retries the incomplete evidence", () => {
    const result = plan({ sizes: [size(10, { head: linked(5, "500", "SKU-10") })], observations: [["500", item("500", "SKU-10", "DRAFT")]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", status: "linked", code: D.lookupMissed, retry: "transient", rule: "V9" });
    expect(result.commands).toEqual([]);
  });
});

describe("changed links: replacement from the same tick's candidates", () => {
  const gone = (variantId: number, mappingId: number, itemId: string, extra: Partial<StockLinkSizeFacts> = {}) =>
    size(variantId, { head: linked(mappingId, itemId, `SKU-${variantId}`), ...extra });
  const control = { otherHeads: [{ productVariantId: 90, activeItemId: "9000", draftItemId: null }],
    controlObservation: ["9000", item("9000", "SKU-90")] as [string, StockLinkStoreItem] };

  it("two candidates → retire + F3; a held candidate → retire + F4; a blank Card Shellz SKU → retire + F1", () => {
    const duplicate = plan({ sizes: [gone(10, 5, "500")], items: [item("510", "SKU-10"), item("511", "SKU-10")],
      observations: [["500", null]] });
    expect(decisionOf(duplicate, 10)).toMatchObject({ change: "retire", status: "flagged", code: D.skuDuplicate });
    const held = plan({ sizes: [gone(10, 5, "500")], items: [item("510", "SKU-10")], observations: [["500", null]],
      otherHeads: [{ productVariantId: 44, activeItemId: "510", draftItemId: null }] });
    expect(decisionOf(held, 10)).toMatchObject({ change: "retire", code: D.itemShared, waitingItemId: "510" });
    expect(held.wakeVariantIds).toEqual([44]);
    const blank = plan({ sizes: [gone(10, 5, "500", { cardShellzSku: "" })], otherHeads: control.otherHeads,
      observations: [["500", null], control.controlObservation] });
    expect(decisionOf(blank, 10)).toMatchObject({ change: "retire", code: D.skuBlank });
  });

  it("a changed link whose size is no longer selectable is retired and waits SELECTION_BLOCKED (D-P2-2)", () => {
    const result = plan({ sizes: [gone(10, 5, "500", { selection: { action: "none", blockerCodes: [] } })],
      items: [item("510", "SKU-10")], observations: [["500", null]] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "retire", status: "waiting", code: D.selectionBlocked });
  });
});

describe("joint rule (V3-8)", () => {
  it("a swap inside one product is one command: both relink, both old items freed", () => {
    // A (10) was on X=500 and B (11) on Y=501; the store moved the SKUs: X now carries B's SKU, Y carries A's.
    const result = plan({
      sizes: [size(10, { head: linked(5, "500", "SKU-10") }), size(11, { head: linked(6, "501", "SKU-11") })],
      items: [item("501", "SKU-10"), item("500", "SKU-11")],
      observations: [["500", item("500", "SKU-11")], ["501", item("501", "SKU-10")]],
    });
    expect(decisionOf(result, 10)).toMatchObject({ change: "relink", rule: "V4/L10", link: { itemId: "501" } });
    expect(decisionOf(result, 11)).toMatchObject({ change: "relink", rule: "V4/L10", link: { itemId: "500" } });
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ productId: 1, freedItemIds: ["500", "501"] });
    expect(result.commands[0]!.members.map(member => member.productVariantId)).toEqual([10, 11]);
  });

  it("a swap across products: each side retires and waits for the freed item, due next tick", () => {
    const result = plan({
      sizes: [size(10, { productId: 1, head: linked(5, "500", "SKU-10") }), size(11, { productId: 2, head: linked(6, "501", "SKU-11") })],
      items: [item("501", "SKU-10"), item("500", "SKU-11")],
      observations: [["500", item("500", "SKU-11")], ["501", item("501", "SKU-10")]],
    });
    expect(decisionOf(result, 10)).toMatchObject({ change: "retire", status: "waiting", code: D.waitingForFreedItem,
      waitingItemId: "501", dueNextTick: true, detail: { kind: "WAITING_FOR_FREED_ITEM", freedByProductVariantIds: [11] } });
    expect(decisionOf(result, 11)).toMatchObject({ change: "retire", code: D.waitingForFreedItem, waitingItemId: "500" });
    expect(result.commands.map(command => command.productId)).toEqual([1, 2]);
    expect(result.wakeVariantIds).toEqual([]);
  });

  it("a first link takes an item a changed size of the same product frees, in the same command", () => {
    const result = plan({
      sizes: [size(10, { head: linked(5, "500", "SKU-10") }), size(11)],
      items: [item("500", "SKU-11"), item("510", "SKU-10")],
      observations: [["500", item("500", "SKU-11")]],
    });
    expect(decisionOf(result, 10)).toMatchObject({ change: "relink", link: { itemId: "510" } });
    expect(decisionOf(result, 11)).toMatchObject({ change: "link", link: { itemId: "500" } });
    expect(result.commands).toHaveLength(1);
  });

  it("a command that replaces a draft wakes rows waiting on the draft's old item", () => {
    const head: StockLinkHeadFact = { revision: "2", active: null,
      draft: { mappingId: 8, itemId: "999", externalSku: "SKU-10", definitionHash: "b".repeat(64) } };
    const result = plan({ sizes: [size(10, { head })], items: [item("500", "SKU-10")] });
    expect(result.commands[0]!.freedItemIds).toEqual(["999"]);
  });

  it("refuses a batch that names a size twice", () => {
    expect(() => plan({ sizes: [size(10), size(10)] })).toThrow(StockLinkError);
  });
});

describe("safety stops (V3-5, SAF-7)", () => {
  const gone = (variantId: number, itemId: string) => size(variantId, { head: linked(variantId, itemId, `SKU-${variantId}`) });

  it("one due row, one retire, no control possible (no other link, empty lookups) → the retire proceeds", () => {
    const result = plan({ sizes: [gone(10, "500")], observations: [["500", null]] });
    expect(result.control).toEqual({ status: "impossible" });
    expect(decisionOf(result, 10)).toMatchObject({ change: "retire" });
    expect(result.pause).toBeNull();
  });

  it("two retires with no control possible → none is made; the destination pauses STORE_NOT_ANSWERING", () => {
    const result = plan({ sizes: [gone(10, "500"), gone(11, "501")], observations: [["500", null], ["501", null]] });
    for (const variantId of [10, 11]) {
      expect(decisionOf(result, variantId)).toMatchObject({ change: "none", status: "unchanged", code: D.storeNotAnswering,
        retry: "busy" });
    }
    expect(result.commands).toEqual([]);
    expect(result.pause).toBe("set");
  });

  it("a control was not read yet → ask for up to 3 linked items outside the retiring set; retire nothing meanwhile", () => {
    const otherHeads = [91, 92, 93, 94].map(id => ({ productVariantId: id, activeItemId: `${id}00`, draftItemId: null }));
    const result = plan({ sizes: [gone(10, "500")], otherHeads, observations: [["500", null]] });
    expect(result.control).toEqual({ status: "needs_read", itemIds: ["9100", "9200", "9300"] });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", code: D.storeNotAnswering });
    expect(result.pause).toBe("set");
  });

  it("after the control read: a present item lets the retire proceed and clears the pause; a gone one keeps the pause", () => {
    const otherHeads = [{ productVariantId: 91, activeItemId: "9100", draftItemId: null }];
    const present = plan({ sizes: [gone(10, "500")], otherHeads, controlReadDone: true,
      observations: [["500", null], ["9100", item("9100", "SKU-91")]] });
    expect(present.control).toEqual({ status: "present" });
    expect(decisionOf(present, 10)).toMatchObject({ change: "retire" });
    expect(present.pause).toBe("clear");
    const absent = plan({ sizes: [gone(10, "500")], otherHeads, controlReadDone: true, observations: [["500", null], ["9100", null]] });
    expect(absent.control).toEqual({ status: "absent" });
    expect(decisionOf(absent, 10)).toMatchObject({ change: "none", code: D.storeNotAnswering });
    expect(absent.pause).toBe("set");
  });

  it("a lookup that returned any item is a control", () => {
    const result = plan({ sizes: [gone(10, "500"), gone(11, "501"), size(12)], items: [item("520", "SKU-12")],
      observations: [["500", null], ["501", null]] });
    expect(result.control).toEqual({ status: "present" });
    expect(result.commands.flatMap(command => command.members.map(member => member.change))).toEqual(["retire", "retire", "link"]);
  });

  it("RETIRES_HELD: the window allows 25 retires in all; the rest keep their links; relinks are never held", () => {
    const result = plan({ sizes: [gone(10, "500"), gone(11, "501"), size(12, { head: linked(12, "502", "SKU-12") })],
      items: [item("512", "SKU-12")], observations: [["500", null], ["501", null], ["502", null]],
      recentRetireCount: STOCK_LINK_RETIRE_HOLD.limit - 1 });
    expect(decisionOf(result, 10)).toMatchObject({ change: "retire" });
    expect(decisionOf(result, 11)).toMatchObject({ change: "none", status: "unchanged", code: D.retiresHeld, retry: null });
    expect(decisionOf(result, 12)).toMatchObject({ change: "relink", link: { itemId: "512" } });
    expect(result.retiresHeld).toBe(1);
    const full = plan({ sizes: [gone(10, "500")], items: [item("999", "SKU-99")], lookedUp: ["SKU-10", "SKU-99"],
      observations: [["500", null]], recentRetireCount: STOCK_LINK_RETIRE_HOLD.limit });
    expect(decisionOf(full, 10)).toMatchObject({ code: D.retiresHeld });
  });

  it("a held retire frees nothing: a size that wanted its item is re-decided as held", () => {
    // 10's item 500 is gone from 10's view (now carries 11's SKU); 11 wants 500. Retires are held, so 500 stays 10's.
    const result = plan({
      sizes: [size(10, { productId: 1, head: linked(5, "500", "SKU-10") }), size(11, { productId: 1 })],
      items: [item("500", "SKU-11")], observations: [["500", item("500", "SKU-11")]],
      recentRetireCount: STOCK_LINK_RETIRE_HOLD.limit,
    });
    expect(decisionOf(result, 10)).toMatchObject({ change: "none", code: D.retiresHeld });
    expect(decisionOf(result, 11)).toMatchObject({ change: "none", status: "flagged", code: D.itemShared, waitingItemId: "500" });
    expect(result.commands).toEqual([]);
  });

  it("the retire window starts at max(now − 24 h, released)", () => {
    const now = new Date("2026-10-27T12:00:00.000Z");
    expect(stockLinkRetireWindowStart(now, null).toISOString()).toBe("2026-10-26T12:00:00.000Z");
    expect(stockLinkRetireWindowStart(now, new Date("2026-10-27T01:00:00.000Z")).toISOString()).toBe("2026-10-27T01:00:00.000Z");
    expect(stockLinkRetireWindowStart(now, new Date("2026-10-20T01:00:00.000Z")).toISOString()).toBe("2026-10-26T12:00:00.000Z");
    expect(STOCK_LINK_RETIRE_HOLD).toEqual({ windowHours: 24, limit: 25 });
  });
});

describe("retry schedule (§4.6, injected random)", () => {
  it("busy is 60-180 s from the injected random and counts no attempt", () => {
    expect(stockLinkBusyDelayMs(() => 0)).toBe(60_000);
    expect(stockLinkBusyDelayMs(() => 0.5)).toBe(120_000);
    expect(stockLinkBusyDelayMs(() => 0.999_999_999)).toBe(180_000);
    for (const bad of [1, -0.1, Number.NaN]) expect(() => stockLinkBusyDelayMs(() => bad)).toThrow(StockLinkError);
  });

  it("transient is max(min(10 min × 2^(n−1), 24 h), Retry-After)", () => {
    expect(stockLinkTransientDelayMs(1)).toBe(10 * MINUTE);
    expect(stockLinkTransientDelayMs(2)).toBe(20 * MINUTE);
    expect(stockLinkTransientDelayMs(8)).toBe(1_280 * MINUTE);
    expect(stockLinkTransientDelayMs(9)).toBe(24 * HOUR);
    expect(stockLinkTransientDelayMs(10_000)).toBe(24 * HOUR);
    expect(stockLinkTransientDelayMs(1, 30 * MINUTE)).toBe(30 * MINUTE);
    expect(stockLinkTransientDelayMs(3, MINUTE)).toBe(40 * MINUTE);
    for (const bad of [0, -1, 1.5]) expect(() => stockLinkTransientDelayMs(bad)).toThrow(StockLinkError);
  });

  it("waits start at 15 min and double to 24 h; an early wake starts again", () => {
    expect(stockLinkWaitDelayMs(null)).toBe(15 * MINUTE);
    expect(stockLinkWaitDelayMs(15 * MINUTE)).toBe(30 * MINUTE);
    expect(stockLinkWaitDelayMs(16 * HOUR)).toBe(24 * HOUR);
    expect(stockLinkWaitDelayMs(MINUTE)).toBe(15 * MINUTE);
  });

  it("a pause lasts as long as it has lasted, 15 min to 24 h", () => {
    const now = new Date("2026-10-27T12:00:00.000Z");
    expect(stockLinkPauseDelayMs(null, now)).toBe(15 * MINUTE);
    expect(stockLinkPauseDelayMs(new Date(now.getTime() - 10 * MINUTE), now)).toBe(15 * MINUTE);
    expect(stockLinkPauseDelayMs(new Date(now.getTime() - HOUR), now)).toBe(HOUR);
    expect(stockLinkPauseDelayMs(new Date(now.getTime() - 30 * HOUR), now)).toBe(24 * HOUR);
  });

  it("first verifies of newly found links are spread over 24 h", () => {
    expect(stockLinkFirstVerifyDelayMs(() => 0)).toBe(0);
    expect(stockLinkFirstVerifyDelayMs(() => 0.5)).toBe(12 * HOUR);
    expect(STOCK_LINK_RETRY.verifyIntervalMs).toBe(24 * HOUR);
  });

  it("the same facts always give the same plan, and inputs are not mutated", () => {
    const sizes = [size(11, { head: linked(6, "501", "SKU-11") }), size(10)];
    const frozen = JSON.stringify(sizes);
    const first = plan({ sizes, items: [item("500", "SKU-10")], observations: [["501", item("501", "SKU-11")]] });
    const again = plan({ sizes, items: [item("500", "SKU-10")], observations: [["501", item("501", "SKU-11")]] });
    expect(again).toEqual(first);
    expect(JSON.stringify(sizes)).toBe(frozen);
    expect(first.decisions.map(row => row.productVariantId)).toEqual([10, 11]);
  });
});
