import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { linkEbayListingStockBeforeChange, type EbayListingStockLinkHookInput } from "../../infrastructure/ebay-listing-stock-link-hook";
import { EbayListingSyncError } from "../../ebay-listing-sync.domain";

// Channels PR4 (PLAN-CH-v3 §5 "Edit / rebuild / relist"): the Card Shellz eBay update and rebuild hooks link the
// sizes that would get a positive quantity before the first eBay mutation; a refusal stops the change before eBay.

const input = (overrides: Partial<EbayListingStockLinkHookInput> = {}): EbayListingStockLinkHookInput => ({ kind: "listing_update",
  channelId: 1, connectionId: 3, accountId: "seller", environment: "production", productId: 20, listingId: "110",
  reviewToken: "token-1", actor: "system:ebay-listing-change",
  variants: [{ productVariantId: 101, sku: "A", atpUnits: 4 }, { productVariantId: 102, sku: "B", atpUnits: 0 },
    { productVariantId: 103, sku: "C", atpUnits: 2 }], ...overrides });

/** An eBay client stand-in that records every call; the listing change runs only after the hook resolves. */
function listingChange(hookDeps: Parameters<typeof linkEbayListingStockBeforeChange>[1], hookInput = input()) {
  const ebayCalls: string[] = [];
  const run = async (change: () => Promise<void>) => {
    await linkEbayListingStockBeforeChange(hookInput, hookDeps);
    await change();
  };
  return { ebayCalls, run };
}

describe("eBay listing update / rebuild stock-link hook", () => {
  it("links only unlinked sizes with ATP > 0, once, before the change", async () => {
    const readGaps = vi.fn(async () => ({ publicationTargetId: 7, productVariantIds: [101, 102] }));
    const link = vi.fn(async () => ({ status: "ready" as const, commandKey: "k", alreadyLinked: false, fenceHoldMs: 5 }));
    await linkEbayListingStockBeforeChange(input(), { readGaps, link });
    expect(readGaps).toHaveBeenCalledExactlyOnceWith({ channelId: 1, connectionId: 3, accountId: "seller",
      variants: [{ productVariantId: 101, sku: "A" }, { productVariantId: 103, sku: "C" }] });
    expect(link).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ publicationTargetId: 7, purpose: "publish",
      variants: [{ productVariantId: 101, sku: "A" }], origin: { kind: "listing_update", key: expect.stringMatching(/^[a-f0-9]{64}$/) },
      actor: "system:ebay-listing-change" }));
  });

  it("the same review replays one command key; another review is a new command", async () => {
    const keys: string[] = [];
    const deps = { readGaps: async () => ({ publicationTargetId: 7, productVariantIds: [101] }),
      link: async (request: { origin: { key: string } }) => { keys.push(request.origin.key); return { status: "ready" as const, commandKey: "k", alreadyLinked: false, fenceHoldMs: 1 }; } };
    await linkEbayListingStockBeforeChange(input(), deps);
    await linkEbayListingStockBeforeChange(input(), deps);
    await linkEbayListingStockBeforeChange(input({ reviewToken: "token-2" }), deps);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it.each(["listing_update", "listing_rebuild"] as const)("a refused %s hook makes zero eBay mutations", async kind => {
    const link = vi.fn(async () => ({ status: "blocked" as const, commandKey: "k",
      blockers: [{ code: "STOCK_LISTING_GLOBAL_STOP", message: "Automatic stock publication is paused globally." }] }));
    const change = listingChange({ readGaps: async () => ({ publicationTargetId: 7, productVariantIds: [101] }), link }, input({ kind }));
    await expect(change.run(async () => { change.ebayCalls.push("createOrReplaceInventoryItem"); }))
      .rejects.toMatchObject({ code: "STOCK_LISTING_GLOBAL_STOP" });
    expect(change.ebayCalls).toEqual([]);
    await expect(linkEbayListingStockBeforeChange(input({ kind }), { readGaps: async () => ({ publicationTargetId: 7, productVariantIds: [101] }), link }))
      .rejects.toBeInstanceOf(EbayListingSyncError);
  });

  it("rebuild: the sizes are linked before the rebuild runs, including its early return for an already-published group", async () => {
    const order: string[] = [];
    const change = listingChange({ readGaps: async () => ({ publicationTargetId: 7, productVariantIds: [101] }),
      link: async request => { order.push(`link:${request.origin.kind}`); return { status: "ready", commandKey: "k", alreadyLinked: false, fenceHoldMs: 1 }; } },
    input({ kind: "listing_rebuild" }));
    await change.run(async () => { order.push("rebuild:early_return"); });
    expect(order).toEqual(["link:listing_rebuild", "rebuild:early_return"]);
  });

  it("a price update with a held size succeeds: a held (or already linked, or zero) size never asks for a link", async () => {
    const link = vi.fn();
    // readEbayStockLinkGaps leaves held sizes out (IP SQL, PG suite); here every positive size is held or linked.
    await linkEbayListingStockBeforeChange(input(), { readGaps: async () => ({ publicationTargetId: 7, productVariantIds: [] }), link });
    await linkEbayListingStockBeforeChange(input({ variants: [{ productVariantId: 102, sku: "B", atpUnits: 0 }] }),
      { readGaps: async () => { throw new Error("not read"); }, link });
    expect(link).not.toHaveBeenCalled();
  });

  it("an account without a live eBay stock destination links nothing", async () => {
    const link = vi.fn();
    await linkEbayListingStockBeforeChange(input(), { readGaps: async () => ({ publicationTargetId: null, productVariantIds: [] }), link });
    expect(link).not.toHaveBeenCalled();
  });

  it("is called before any draft preparation or connector call in the reviewed update / rebuild path", () => {
    const text = readFileSync(resolve("server/modules/channels/infrastructure/ebay-listing-push.ts"), "utf8");
    const body = text.slice(text.indexOf("async function executeProduct("));
    const hook = body.indexOf("linkEbayListingStockBeforeChange(");
    expect(hook).toBeGreaterThan(0);
    for (const later of ["preparePushDraft(", "connector.updateExistingListing(", "connector.executeListingRebuild(", "createEbayRouteListingLifecycleClient("])
      expect(body.indexOf(later)).toBeGreaterThan(hook);
  });
});
