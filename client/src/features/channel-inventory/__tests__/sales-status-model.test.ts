import { describe, expect, it } from "vitest";
import { salesStatusScopeKey } from "@shared/inventory/sales-status-resolution";
import type { SalesStatusChangeResult, SalesStatusEntry, SalesStatusProductView, SalesStatusScope } from "@shared/types/inventory-sales-status";

import {
  STOPPED_BY_PRODUCT,
  allChannelsChanges,
  allChannelsStatus,
  bulkChanges,
  channelChanges,
  channelsStoppedByProduct,
  describeChangeResult,
  describeChannelStatus,
  entryAt,
  hasOwnStop,
  otherHoldsFor,
  productStatuses,
  resumeEverywhereChanges,
  skuStatuses,
  stopEverywhereChanges,
  summarizeItem,
  summaryChannels,
} from "../sales-status-model";

const AT = "2026-11-07T15:00:00.000Z";
const SHOPIFY = 3;
const EBAY = 4;
const AMAZON = 6;

function entry(scope: Omit<SalesStatusScope, "productId">, status: "selling" | "stopped", revision: string): SalesStatusEntry {
  const full = { ...scope, productId: 10 };
  return { scopeKey: salesStatusScopeKey(full), scope: full, status, note: null, revision, updatedBy: "admin", updatedAt: AT };
}

function view(entries: SalesStatusEntry[] = [], overrides: Partial<SalesStatusProductView> = {}): SalesStatusProductView {
  return {
    runtimeAuthority: "canonical",
    product: { id: 10, sku: "CARD", name: "Card Shell" },
    variants: [
      { id: 101, sku: "CARD-P5", name: "Pack of 5", unitsPerVariant: 5, sellable: true },
      { id: 102, sku: "CARD-EA", name: "Single", unitsPerVariant: 1, sellable: true },
      { id: 103, sku: "CARD-CMP", name: "Component", unitsPerVariant: 1, sellable: false },
    ],
    channels: [
      { id: SHOPIFY, name: "Shopify US", provider: "shopify", status: "active", publishesStock: true },
      { id: EBAY, name: "eBay", provider: "ebay", status: "active", publishesStock: true },
      { id: AMAZON, name: "Amazon", provider: "amazon", status: "active", publishesStock: false },
    ],
    entries,
    otherHolds: [],
    ...overrides,
  };
}

const product = { productVariantId: null };
const pack = { productVariantId: 101 };
const productStoppedEverywhere = () => entry({ channelId: null, productVariantId: null }, "stopped", "1");

describe("sales status summaries", () => {
  it("speaks only for channels Echelon sends stock to, unless none does", () => {
    expect(summaryChannels(view()).map((channel) => channel.id)).toEqual([SHOPIFY, EBAY]);
    const none = view([], { channels: view().channels.map((channel) => ({ ...channel, publishesStock: false })) });
    expect(summaryChannels(none)).toHaveLength(3);
  });

  it("summarizes selling, stopped and each mixed direction the way it was set up", () => {
    expect(summarizeItem(view(), product)).toEqual({ tone: "selling", text: "Selling everywhere" });
    expect(summarizeItem(view([productStoppedEverywhere()]), product)).toEqual({ tone: "stopped", text: "Stopped everywhere" });
    expect(summarizeItem(view([productStoppedEverywhere(), entry({ channelId: SHOPIFY, productVariantId: null }, "selling", "2")]), product))
      .toEqual({ tone: "mixed", text: "Stopped everywhere except Shopify US" });
    expect(summarizeItem(view([entry({ channelId: EBAY, productVariantId: 101 }, "stopped", "3")]), pack))
      .toEqual({ tone: "mixed", text: "Selling everywhere except eBay" });
  });

  it("stops every SKU of a stopped product, whatever the SKU says", () => {
    const settings = view([productStoppedEverywhere(), entry({ channelId: SHOPIFY, productVariantId: 101 }, "selling", "4")]);
    expect(summarizeItem(settings, pack)).toEqual({ tone: "stopped", text: "Stopped everywhere" });
    expect(skuStatuses(settings, 101).map(({ channel, status, stoppedByProduct }) => [channel.id, status, stoppedByProduct]))
      .toEqual([[SHOPIFY, "stopped", true], [EBAY, "stopped", true], [AMAZON, "stopped", true]]);
  });

  it("resolves a SKU from both levels exactly as the planner does", () => {
    const settings = view([productStoppedEverywhere(),
      entry({ channelId: SHOPIFY, productVariantId: null }, "selling", "2"),
      entry({ channelId: null, productVariantId: 101 }, "stopped", "3")]);
    expect(skuStatuses(settings, 101).map(({ channel, status, stoppedByProduct }) => [channel.id, status, stoppedByProduct]))
      .toEqual([[SHOPIFY, "stopped", false], [EBAY, "stopped", true], [AMAZON, "stopped", true]]);
    expect(skuStatuses(settings, 102).map(({ channel, status }) => [channel.id, status]))
      .toEqual([[SHOPIFY, "selling"], [EBAY, "stopped"], [AMAZON, "stopped"]]);
    expect(productStatuses(settings).map(({ status }) => status)).toEqual(["selling", "stopped", "stopped"]);
    expect(channelsStoppedByProduct(settings, 102).map((channel) => channel.id)).toEqual([EBAY, AMAZON]);
  });

  it("takes an item's all-channels status from a stop on it or, for a SKU, on its product", () => {
    expect(allChannelsStatus(view([productStoppedEverywhere()]), pack)).toBe("stopped");
    expect(allChannelsStatus(view([entry({ channelId: null, productVariantId: 101 }, "stopped", "2")]), pack)).toBe("stopped");
    expect(allChannelsStatus(view([entry({ channelId: null, productVariantId: 101 }, "stopped", "2")]), product)).toBe("selling");
    expect(allChannelsStatus(view(), product)).toBe("selling");
  });

  it("explains each channel, saying so when the product is the reason", () => {
    const settings = view([productStoppedEverywhere(), entry({ channelId: SHOPIFY, productVariantId: null }, "selling", "2"),
      entry({ channelId: SHOPIFY, productVariantId: 101 }, "stopped", "5")]);
    const [shopify, ebay] = skuStatuses(settings, 101);
    expect(describeChannelStatus(settings, ebay!)).toBe(STOPPED_BY_PRODUCT);
    expect(STOPPED_BY_PRODUCT).toBe("Stopped because the product is stopped");
    expect(describeChannelStatus(settings, shopify!)).toBe("Stopped · SKU setting, Shopify US only");
    expect(describeChannelStatus(settings, skuStatuses(settings, 102)[0]!)).toBe("Selling · Product setting, Shopify US only");
    expect(describeChannelStatus(view(), skuStatuses(view(), 102)[0]!)).toBe("Selling · Default");
  });
});

describe("sales status commands", () => {
  it("stops an item everywhere and removes its own channel exceptions, pinned to their revisions", () => {
    const settings = view([entry({ channelId: SHOPIFY, productVariantId: null }, "selling", "7"),
      entry({ channelId: null, productVariantId: 101 }, "stopped", "8")]);
    expect(stopEverywhereChanges(settings, product)).toEqual([
      { scope: { channelId: null, productId: 10, productVariantId: null }, status: "stopped", expectedRevision: null },
      { scope: { channelId: SHOPIFY, productId: 10, productVariantId: null }, status: "inherit", expectedRevision: "7" },
    ]);
  });

  it("resumes an item by removing only its own settings; a SKU under a stopped product stays stopped", () => {
    const settings = view([productStoppedEverywhere(), entry({ channelId: EBAY, productVariantId: 101 }, "stopped", "2")]);
    expect(resumeEverywhereChanges(settings, product)).toEqual([
      { scope: { channelId: null, productId: 10, productVariantId: null }, status: "inherit", expectedRevision: "1" },
    ]);
    expect(resumeEverywhereChanges(settings, pack)).toEqual([
      { scope: { channelId: EBAY, productId: 10, productVariantId: 101 }, status: "inherit", expectedRevision: "2" },
    ]);
  });

  it("offers a resume only where the item has a stop of its own", () => {
    const settings = view([productStoppedEverywhere()]);
    expect(hasOwnStop(settings, product)).toBe(true);
    expect(hasOwnStop(settings, pack)).toBe(false);
    expect(hasOwnStop(view([entry({ channelId: EBAY, productVariantId: 101 }, "stopped", "2")]), pack)).toBe(true);
    expect(hasOwnStop(view([entry({ channelId: EBAY, productVariantId: 101 }, "selling", "2")]), pack)).toBe(false);
  });

  it("sends nothing for a control already in the requested state", () => {
    const settings = view([entry({ channelId: SHOPIFY, productVariantId: 101 }, "stopped", "4")]);
    expect(channelChanges(settings, pack, SHOPIFY, "stopped")).toEqual([]);
    expect(channelChanges(settings, pack, EBAY, "inherit")).toEqual([]);
    expect(channelChanges(settings, pack, SHOPIFY, "inherit")).toEqual([
      { scope: { channelId: SHOPIFY, productId: 10, productVariantId: 101 }, status: "inherit", expectedRevision: "4" },
    ]);
    expect(stopEverywhereChanges(view([productStoppedEverywhere()]), product)).toEqual([]);
  });

  it("stores all-channels Selling as no setting, for products and SKUs alike", () => {
    expect(allChannelsChanges(view([productStoppedEverywhere()]), product, "selling"))
      .toEqual([{ scope: { channelId: null, productId: 10, productVariantId: null }, status: "inherit", expectedRevision: "1" }]);
    expect(allChannelsChanges(view(), product, "selling")).toEqual([]);
    expect(allChannelsChanges(view(), pack, "selling")).toEqual([]);
    expect(allChannelsChanges(view(), pack, "stopped"))
      .toEqual([{ scope: { channelId: null, productId: 10, productVariantId: 101 }, status: "stopped", expectedRevision: null }]);
  });

  it("builds one command for a bulk stop or resume of selected SKUs", () => {
    const settings = view([entry({ channelId: null, productVariantId: 102 }, "stopped", "9")]);
    expect(bulkChanges(settings, [101, 102], "stop")).toEqual([
      { scope: { channelId: null, productId: 10, productVariantId: 101 }, status: "stopped", expectedRevision: null },
    ]);
    expect(bulkChanges(settings, [101, 102], "resume")).toEqual([
      { scope: { channelId: null, productId: 10, productVariantId: 102 }, status: "inherit", expectedRevision: "9" },
    ]);
  });

  it("finds the setting stored exactly at a scope", () => {
    const settings = view([entry({ channelId: SHOPIFY, productVariantId: 101 }, "stopped", "4")]);
    expect(entryAt(settings, pack, SHOPIFY)?.revision).toBe("4");
    expect(entryAt(settings, pack, null)).toBeNull();
  });
});

describe("sales status feedback", () => {
  it("shows a SKU's own holds and destination holds, and every hold for the product", () => {
    const holds = [
      { publicationTargetId: 9, channelId: 7, productVariantId: 101, reason: "Tier below minimum", heldBy: "dropship-listing-tiers", heldAt: AT },
      { publicationTargetId: 9, channelId: 7, productVariantId: null, reason: "Vendor paused", heldBy: "dropship-vendor-standing", heldAt: AT },
      { publicationTargetId: 9, channelId: 7, productVariantId: 102, reason: "Tier below minimum", heldBy: "dropship-listing-tiers", heldAt: AT },
    ];
    const settings = view([], { otherHolds: holds });
    expect(otherHoldsFor(settings, pack).map((hold) => hold.productVariantId)).toEqual([101, null]);
    expect(otherHoldsFor(settings, product)).toHaveLength(3);
  });

  it("describes what a change queued, skipped and deferred", () => {
    const result: SalesStatusChangeResult = {
      changes: [], affectedProductIds: [10, 11],
      republished: [{ productId: 10, publicationRows: 2, skippedDestinations: [
        { publicationTargetId: 6, channelId: EBAY, channelName: "eBay", errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING" }] }],
      queued: [{ productId: 11, reason: "could_not_republish", errorCode: "X" }],
      alreadyApplied: false, providerWriteAttempted: false,
    };
    expect(describeChangeResult(result)).toBe(
      "2 stock updates queued for the channels. Not sent to eBay until that listing is fixed. 1 product will update within a few minutes.");
    expect(describeChangeResult({ ...result, affectedProductIds: [], republished: [], queued: [] }))
      .toBe("Nothing needed to change; it was already set that way.");
  });
});
