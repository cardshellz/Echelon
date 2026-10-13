import { describe, expect, it } from "vitest";
import type { ListingFeedRow } from "../feed-model";
import type { ListingLifecycleView } from "@shared/types/channel-listing-lifecycle";
import {
  listingDraftItemSchema,
  listingOperationItemSchema,
} from "@shared/types/channel-listing-publication";
import {
  lifecycleTargets,
  listingPrice,
  listingStatus,
  listingTitle,
} from "../feed-presentation";
const row = (): ListingFeedRow => ({
  key: "sku:A",
  sku: "A",
  draft: null,
  catalog: null,
  issue: null,
  operation: null,
  remote: {
    sku: "A",
    title: "Product A",
    externalProductId: "W1",
    externalVariantId: "A",
    externalInventoryItemId: "A",
    lifecycleStatus: "ACTIVE",
    publishedStatus: "PUBLISHED",
    mappingStatus: "linked",
    variant: null,
    message: null,
    priceCents: 2399,
  },
});
const control = (
  action: "remove" | "unpublish",
  state: ListingLifecycleView["state"] = "pending",
) => ({ action, state }) as ListingLifecycleView;
describe("compact listing presentation", () => {
  it("shows one active status from provider evidence, not accepted submission", () => {
    const r = row();
    r.operation = {
      id: "op",
      item: listingOperationItemSchema.parse({
        variantId: 1,
        sku: "A",
        priceCents: 2499,
        state: "accepted",
        stockState: "waiting_for_item",
        externalProductId: null,
        error: null,
      }),
    };
    expect(listingStatus(r)).toEqual({ label: "Active", tone: "good" });
    expect(listingPrice(r)).toEqual({ cents: 2399, source: "Walmart" });
    r.remote = null;
    expect(listingStatus(r).label).toBe("Processing");
    expect(listingPrice(r)).toEqual({ cents: 2499, source: "Submitted" });
  });
  it("does not turn system problems or unpublished listings into active ones", () => {
    const r = row();
    r.remote!.publishedStatus = "SYSTEM_PROBLEM";
    expect(listingStatus(r).label).toBe("Needs attention");
    r.remote!.publishedStatus = "UNPUBLISHED";
    expect(listingStatus(r).label).toBe("Unpublished");
  });
  it("preserves the submitted title and only labels missing after an explicit provider observation", () => {
    const r = row(); r.remote = null;
    r.operation = { id: "operation", item: listingOperationItemSchema.parse({
      variantId: 1, sku: "A", title: "Real product title", state: "accepted", priceCents: 2499,
      stockState: "waiting_for_item", externalProductId: null, error: null,
    }) };
    expect(listingTitle(r)).toBe("Real product title");
    expect(listingStatus(r).label).toBe("Processing");
    r.operation.item.missingOnProvider = true;
    expect(listingStatus(r).label).toBe("Not found on Walmart");
    r.operation.item.state = "superseded";
    expect(listingStatus(r).label).toBe("Recreated");
    r.draft = listingDraftItemSchema.parse({ variantId: 1, recreateFromOperationId: "00000000-0000-4000-8000-000000000003" });
    expect(listingStatus(r).label).toBe("Recreate draft");
  });
  it("keeps lifecycle transitions ahead of stale published state", () => {
    expect(listingStatus(row(), control("remove")).label).toBe("Unpublishing");
    expect(listingStatus(row(), control("remove", "retired")).label).toBe(
      "Removed",
    );
    expect(listingStatus(row(), control("unpublish", "failed")).tone).toBe(
      "attention",
    );
  });
  it("distinguishes missing prices from zero and labels draft values", () => {
    const r = row();
    r.remote!.priceCents = 0;
    expect(listingPrice(r)).toEqual({ cents: 0, source: "Walmart" });
    delete r.remote!.priceCents;
    expect(listingPrice(r)).toEqual({ cents: null, source: "Unavailable" });
    r.draft = listingDraftItemSchema.parse({
      variantId: 1,
      priceOverrideCents: 1200,
    });
    expect(listingPrice(r)).toEqual({ cents: 1200, source: "Draft" });
  });
  it("selects linked active rows for bulk actions and excludes drafts and existing stops", () => {
    const draft = {
      ...row(),
      key: "variant:2",
      sku: "DRAFT",
      draft: listingDraftItemSchema.parse({ variantId: 2 }),
    };
    expect(
      lifecycleTargets([row(), draft], new Map(), "unpublish").map(
        (item) => item.sku,
      ),
    ).toEqual(["A"]);
    const controls = new Map([["A", control("unpublish")]]);
    expect(lifecycleTargets([row()], controls, "unpublish")).toEqual([]);
    expect(lifecycleTargets([row()], controls, "remove")).toHaveLength(1);
    expect(
      lifecycleTargets([row()], new Map([["A", control("remove")]]), "remove"),
    ).toEqual([]);
  });
});
