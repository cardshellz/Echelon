import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@shared/utils/canonical-json";
import { proveEbayStockOnlyEffects } from "../../adapters/ebay/ebay-recovery-effects";
import type { EbayListingSyncIdentity } from "../../ebay-listing-sync.domain";
import type { RetainedPublicationEffectEvidence } from "../../../inventory-planning/application/ebay-publication-reconciliation.service";

const identity: EbayListingSyncIdentity = { channelId: 67, connectionId: 9, productId: 20, accountId: "seller", marketplaceId: "EBAY_US",
  groupKey: null, variants: [{ variantId: 101, sku: "P5", externalSku: "P5", offerId: "offer-P5", listingId: "listing-20" }] };
const body = { requests: [{ sku: "P5", shipToLocationAvailability: { quantity: 17 },
  offers: [{ offerId: "offer-P5", availableQuantity: 17 }] }] };
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const effect: RetainedPublicationEffectEvidence = { attemptId: "5", ownerKind: "outbox", requestCount: 1,
  method: "POST", path: "/sell/inventory/v1/bulk_update_price_quantity", requestHash: hash(body),
  desiredQuantity: "17", inventoryItemId: "P5", productVariantId: 101, connectionId: 9, accountId: "seller" };
const checkedAt = new Date("2026-11-02T12:00:00Z");
const prove = (effects: RetainedPublicationEffectEvidence[]) => proveEbayStockOnlyEffects({ effects, identity, checkedAt });

describe("eBay retained request effect proof", () => {
  it("proves only the exact stock-only request body", () => {
    expect(prove([effect])).toMatchObject({ kind: "stock_only", checkedAt,
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/), identityHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it.each([
    { ...effect, requestHash: hash({ requests: [{ ...body.requests[0], offers: [
      { ...body.requests[0].offers[0], price: { value: "1.00", currency: "USD" } }] }] }) },
    { ...effect, ownerKind: "legacy" }, { ...effect, requestCount: 0 }, { ...effect, requestCount: 2 },
    { ...effect, method: "PUT" }, { ...effect, path: "/sell/inventory/v1/inventory_item/P5" },
    { ...effect, requestHash: null }, { ...effect, inventoryItemId: "OTHER" },
    { ...effect, desiredQuantity: "9007199254740992" }, { ...effect, accountId: "other" },
  ])("requires a full check for ambiguous or broader effects", candidate => {
    expect(prove([effect, candidate])).toBeNull();
  });
  it("requires saved evidence rather than assuming the old request was stock-only", () => {
    expect(prove([])).toBeNull();
  });
});
