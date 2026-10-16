import { describe, expect, it } from "vitest";
import { ebayAutomaticRecoveryCommandSchema, ebayReconciliationCommandKey, supportsAutomaticEbayReplacement } from "../../domain/ebay-automatic-publication-recovery";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";

const scope: QuantityPublicationScope = { destinationKind: "channel_connection", connectionId: 9,
  providerKey: "ebay", providerScopeType: "account", externalScopeId: "seller", externalInventoryItemId: "P5", productId: 20, productVariantId: 101 };
describe("automatic eBay replacement policy", () => {
  it.each(["inventory_item/P5", "inventory_item_group/PACK", "offer/offer-5"])("permits exact synchronous PUT %s without claiming termination", path => {
    expect(supportsAutomaticEbayReplacement({ owner: "legacy", outboxScopeProven: false,
      requests: [{ ordinal: 1, method: "PUT", path: `/sell/inventory/v1/${path}` }] })).toBe(true);
  });
  it.each([
    { method: "POST", path: "/sell/inventory/v1/offer/offer-5/publish" },
    { method: "DELETE", path: "/sell/inventory/v1/inventory_item/P5" },
    { method: "PUT", path: "/sell/inventory/v1/inventory_item/P5?unknown=true" },
    { method: "POST", path: "/sell/feed/v1/task" },
  ])("refuses unsupported provider operation $method $path", request => {
    expect(supportsAutomaticEbayReplacement({ owner: "legacy", outboxScopeProven: false, requests: [{ ordinal: 1, ...request }] })).toBe(false);
  });
  it("requires immutable outbox proof if no request record exists", () => {
    expect(supportsAutomaticEbayReplacement({ owner: "outbox", outboxScopeProven: true, requests: [] })).toBe(true);
    expect(supportsAutomaticEbayReplacement({ owner: "outbox", outboxScopeProven: false, requests: [] })).toBe(false);
    expect(supportsAutomaticEbayReplacement({ owner: "legacy", outboxScopeProven: true, requests: [] })).toBe(false);
  });
  it("rejects missing request ordinals and mixed-account or duplicate catalog scope", () => {
    expect(supportsAutomaticEbayReplacement({ owner: "legacy", outboxScopeProven: false,
      requests: [{ ordinal: 2, method: "POST", path: "/sell/inventory/v1/bulk_update_price_quantity" }] })).toBe(false);
    const command = { syncJobId: "00000000-0000-4000-8000-000000000001", syncRevision: "1", scopes: [scope] };
    expect(ebayAutomaticRecoveryCommandSchema.safeParse(command).success).toBe(true);
    for (const other of [{ ...scope }, { ...scope, externalScopeId: "other", externalInventoryItemId: "P10", productVariantId: 102 },
      { ...scope, externalInventoryItemId: "P10" }]) {
      expect(ebayAutomaticRecoveryCommandSchema.safeParse({ ...command, scopes: [scope, other] }).success).toBe(false);
    }
  });
  it("uses a stable replay command for each watch cycle and rejects unsafe bigint identifiers", () => {
    expect(ebayReconciliationCommandKey("10", "2")).toBe(ebayReconciliationCommandKey("10", "2"));
    expect(ebayReconciliationCommandKey("10", "2")).not.toBe(ebayReconciliationCommandKey("10", "3"));
    expect(ebayReconciliationCommandKey("10", "2")).not.toBe(ebayReconciliationCommandKey("11", "2"));
    expect(() => ebayReconciliationCommandKey("9223372036854775808", "2")).toThrow();
  });
});
