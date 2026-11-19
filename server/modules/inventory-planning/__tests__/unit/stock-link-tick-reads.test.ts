import { describe, expect, it } from "vitest";
import type { StockLinkStoreItem } from "@shared/types/stock-link";
import {
  normalizeStockLinkSku, planStockLinkBatch, planStockLinkReads, type StockLinkHeadFact, type StockLinkSizeFacts,
} from "../../domain/stock-link";
import { stockLinkTickFailureAction, type StockLinkFailureKind } from "../../domain/stock-link-errors";

// Channels PR2 (PLAN-CH2 v4.1 §7.2 step 5, §4.6): the tick's two pure helpers. planStockLinkReads says which store reads
// make each claimed size decidable (by the decision's own rules); stockLinkTickFailureAction says what the tick does
// with a failure outside a command (never a retry of a permanent: B8).

function size(productVariantId: number, overrides: Partial<StockLinkSizeFacts> = {}): StockLinkSizeFacts {
  return { productVariantId, productId: 1, cardShellzSku: `SKU-${productVariantId}`, selection: { action: "publish", blockerCodes: [] },
    head: null, observedSku: null, feedHintItemId: null, ...overrides };
}
const linked = (itemId: string, externalSku: string | null = null): StockLinkHeadFact =>
  ({ revision: "3", active: { mappingId: 9, itemId, externalSku }, draft: null });
const item = (itemId: string, sku: string | null): StockLinkStoreItem => ({ itemId, sku, productId: "77", productStatus: "ACTIVE" });

describe("planStockLinkReads (§7.2 step 5)", () => {
  it("looks up an unlinked size's trimmed SKU and observes its feed hint (decimal form)", () => {
    expect(planStockLinkReads({ sizes: [size(1, { cardShellzSku: "  abc-1 ", feedHintItemId: "gid://shopify/InventoryItem/44" })],
      carriedSkus: [] })).toEqual([{ productVariantId: 1, lookupSku: "abc-1", observeItemIds: ["44"] }]);
  });

  it("observes a linked size's item and looks its SKU up (verify), even when its selection is not linkable", () => {
    const reads = planStockLinkReads({ sizes: [size(2, { head: linked("gid://shopify/InventoryItem/7"), feedHintItemId: "8",
      selection: { action: "read_only", blockerCodes: ["X"] } })], carriedSkus: [] });
    expect(reads).toEqual([{ productVariantId: 2, lookupSku: "SKU-2", observeItemIds: ["7", "8"] }]);
  });

  it("reads nothing for an unlinked size whose decision needs no lookup: blank SKU, shared SKU (N6), blocked selection", () => {
    const reads = planStockLinkReads({ sizes: [
      size(3, { cardShellzSku: "   ", feedHintItemId: "30" }),
      size(4, { cardShellzSku: "DUP", feedHintItemId: "40" }),
      size(5, { selection: { action: "publish", blockerCodes: ["BLOCKED"] }, feedHintItemId: "50" }),
    ], carriedSkus: [{ productVariantId: 99, sku: " dup" }] });
    expect(reads).toEqual([
      { productVariantId: 3, lookupSku: null, observeItemIds: [] },
      { productVariantId: 4, lookupSku: null, observeItemIds: [] },
      { productVariantId: 5, lookupSku: null, observeItemIds: [] },
    ]);
  });

  it("observes a linked size's item but skips the lookup when its SKU is shared; an unparseable stored id is not observed", () => {
    const reads = planStockLinkReads({ sizes: [size(6, { cardShellzSku: "DUP", head: linked("11") }), size(7, { head: linked("bad-id") })],
      carriedSkus: [{ productVariantId: 99, sku: "dup" }] });
    expect(reads).toEqual([
      { productVariantId: 6, lookupSku: null, observeItemIds: ["11"] },
      { productVariantId: 7, lookupSku: "SKU-7", observeItemIds: [] },
    ]);
  });

  it("with exactly the planned reads made, the batch decides every size (nothing is left unread)", () => {
    const sizes = [
      size(10, { feedHintItemId: "100" }),
      size(11, { head: linked("110", "SKU-11") }),
      size(12, { head: linked("120", "SKU-12"), feedHintItemId: "121" }),
      size(13, { cardShellzSku: "" }),
      size(14, { cardShellzSku: "SKU-15" }),
      size(15),
    ];
    const store = new Map([["100", item("100", "SKU-10")], ["110", item("110", "SKU-11")], ["121", item("121", "SKU-12")]]);
    const needs = planStockLinkReads({ sizes, carriedSkus: [] });
    const skus = needs.flatMap(need => need.lookupSku === null ? [] : [need.lookupSku]);
    const keys = new Set(skus.map(sku => normalizeStockLinkSku(sku)).flatMap(sku => sku.kind === "sku" ? [sku.key] : []));
    const observe = [...new Set(needs.flatMap(need => need.observeItemIds))];
    const plan = planStockLinkBatch({
      sizes, carriedSkus: [], recentRetireCount: 0,
      destinationHeads: sizes.filter(row => row.head).map(row => ({ productVariantId: row.productVariantId,
        activeItemId: row.head!.active!.itemId, draftItemId: null })),
      reads: { lookedUpSkus: skus, lookupItems: [...store.values()].filter(candidate => {
        const sku = normalizeStockLinkSku(candidate.sku);
        return sku.kind === "sku" && keys.has(sku.key);
      }), observations: observe.map(itemId => ({ itemId, item: store.get(itemId) ?? null })), controlReadDone: false },
    });
    expect(plan.decisions.map(decision => decision.rule)).not.toContain("unread");
    expect(plan.decisions).toHaveLength(sizes.length);
  });

  it("is deterministic: the same sizes in another order give the same reads, in variant order", () => {
    const sizes = [size(3, { feedHintItemId: "3" }), size(1, { head: linked("1") }), size(2)];
    expect(planStockLinkReads({ sizes, carriedSkus: [] })).toEqual(planStockLinkReads({ sizes: [...sizes].reverse(), carriedSkus: [] }));
    expect(planStockLinkReads({ sizes, carriedSkus: [] }).map(need => need.productVariantId)).toEqual([1, 2, 3]);
  });
});

describe("stockLinkTickFailureAction (§4.6, B8)", () => {
  it.each<[StockLinkFailureKind, string]>([
    ["database_unavailable", "stop_tick"],
    ["pause", "pause"],
    ["busy", "release_busy"],
    ["transient", "release_transient"],
    ["cleanup_uncertain", "release_transient"],
    ["permanent", "halt"],
    ["fatal", "halt"],
  ])("%s → %s", (kind, action) => {
    expect(stockLinkTickFailureAction({ kind })).toBe(action);
  });
});
