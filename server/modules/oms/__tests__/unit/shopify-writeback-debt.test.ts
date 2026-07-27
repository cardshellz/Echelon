import { describe, expect, it } from "vitest";

import {
  evaluateShopifyWritebackDebt,
  type ShopifyWritebackDebtShipment,
} from "../../shopify-writeback-debt";

function shipment(
  overrides: Partial<ShopifyWritebackDebtShipment> = {},
): ShopifyWritebackDebtShipment {
  return {
    shipmentId: 101,
    trackingNumber: "TRACK-101",
    retryIds: [1001],
    sourceInboxIds: [2001],
    items: [{
      legacyShipmentItemId: 3001,
      wmsOrderItemId: 4001,
      channelOrderLineId: "9001",
      quantityRequired: 2,
      directEvidenceQuantity: 2,
    }],
    ...overrides,
  };
}

describe("evaluateShopifyWritebackDebt", () => {
  it("resolves exact direct package evidence and deduplicates retry identities", () => {
    const result = evaluateShopifyWritebackDebt([
      shipment({ retryIds: [1001, 1001], sourceInboxIds: [2001, 2001] }),
    ], [], "direct");
    expect(result).toEqual({
      resolvedShipmentIds: [101],
      resolvedRetryIds: [1001],
      resolvedSourceInboxIds: [2001],
      unresolved: [],
    });
  });

  it("does not use aggregate evidence for a tracked package without direct lineage", () => {
    const result = evaluateShopifyWritebackDebt([
      shipment({
        items: [{
          legacyShipmentItemId: 3001,
          wmsOrderItemId: 4001,
          channelOrderLineId: "9001",
          quantityRequired: 2,
          directEvidenceQuantity: 1,
        }],
      }),
    ], [{ channelOrderLineId: "9001", quantity: 20 }], "full_snapshot");
    expect(result.resolvedShipmentIds).toEqual([]);
    expect(result.unresolved).toEqual([{
      shipmentId: 101,
      reason: "direct_package_evidence_incomplete",
    }]);
  });

  it("requires a fresh full-snapshot mode for trackingless historical debt", () => {
    const result = evaluateShopifyWritebackDebt([
      shipment({
        trackingNumber: null,
        items: [{
          legacyShipmentItemId: 3001,
          wmsOrderItemId: 4001,
          channelOrderLineId: "9001",
          quantityRequired: 2,
          directEvidenceQuantity: 0,
        }],
      }),
    ], [{ channelOrderLineId: "9001", quantity: 2 }], "direct");
    expect(result.resolvedShipmentIds).toEqual([]);
    expect(result.unresolved).toEqual([{
      shipmentId: 101,
      reason: "full_snapshot_required",
    }]);
  });

  it("resolves a trackingless group only when snapshot packages cover every channel line", () => {
    const result = evaluateShopifyWritebackDebt([
      shipment({
        shipmentId: 101,
        trackingNumber: null,
        retryIds: [1001],
        items: [{
          legacyShipmentItemId: 3001,
          wmsOrderItemId: 4001,
          channelOrderLineId: "9001",
          quantityRequired: 2,
          directEvidenceQuantity: 0,
        }],
      }),
      shipment({
        shipmentId: 102,
        trackingNumber: null,
        retryIds: [1002],
        sourceInboxIds: [2002],
        items: [{
          legacyShipmentItemId: 3002,
          wmsOrderItemId: 4002,
          channelOrderLineId: "9002",
          quantityRequired: 3,
          directEvidenceQuantity: 0,
        }],
      }),
    ], [
      { channelOrderLineId: "9001", quantity: 2 },
      { channelOrderLineId: "9002", quantity: 3 },
    ], "full_snapshot");
    expect(result.resolvedShipmentIds).toEqual([101, 102]);
    expect(result.resolvedRetryIds).toEqual([1001, 1002]);
    expect(result.unresolved).toEqual([]);
  });

  it("sums duplicate historical rows for the same Shopify line before proving coverage", () => {
    const result = evaluateShopifyWritebackDebt([
      shipment({
        shipmentId: 101,
        trackingNumber: null,
        items: [{
          legacyShipmentItemId: 3001,
          wmsOrderItemId: 4001,
          channelOrderLineId: "9001",
          quantityRequired: 2,
          directEvidenceQuantity: 0,
        }],
      }),
      shipment({
        shipmentId: 102,
        trackingNumber: null,
        retryIds: [1002],
        items: [{
          legacyShipmentItemId: 3002,
          wmsOrderItemId: 4002,
          channelOrderLineId: "9001",
          quantityRequired: 2,
          directEvidenceQuantity: 0,
        }],
      }),
    ], [{ channelOrderLineId: "9001", quantity: 2 }], "full_snapshot");
    expect(result.resolvedShipmentIds).toEqual([]);
    expect(result.unresolved).toEqual([
      { shipmentId: 101, reason: "snapshot_package_coverage_incomplete" },
      { shipmentId: 102, reason: "snapshot_package_coverage_incomplete" },
    ]);
  });

  it("fails closed when trackingless aggregate lineage is missing", () => {
    const result = evaluateShopifyWritebackDebt([
      shipment({
        trackingNumber: null,
        items: [{
          legacyShipmentItemId: 3001,
          wmsOrderItemId: 4001,
          channelOrderLineId: null,
          quantityRequired: 2,
          directEvidenceQuantity: 0,
        }],
      }),
    ], [{ channelOrderLineId: "9001", quantity: 2 }], "full_snapshot");
    expect(result.resolvedShipmentIds).toEqual([]);
    expect(result.unresolved).toEqual([{
      shipmentId: 101,
      reason: "snapshot_package_coverage_incomplete",
    }]);
  });

  it("does not clear a retry whose shipment has no eligible fulfillment items", () => {
    const result = evaluateShopifyWritebackDebt([
      shipment({ items: [] }),
    ], [], "full_snapshot");
    expect(result.resolvedRetryIds).toEqual([]);
    expect(result.unresolved).toEqual([{
      shipmentId: 101,
      reason: "no_eligible_items",
    }]);
  });

  it("rejects duplicate shipment identities and invalid quantities", () => {
    expect(() => evaluateShopifyWritebackDebt(
      [shipment(), shipment()],
      [],
      "direct",
    )).toThrow(/Duplicate Shopify writeback debt shipment 101/);
    expect(() => evaluateShopifyWritebackDebt([
      shipment({
        items: [{
          legacyShipmentItemId: 3001,
          wmsOrderItemId: 4001,
          channelOrderLineId: "9001",
          quantityRequired: 0,
          directEvidenceQuantity: 0,
        }],
      }),
    ], [], "direct")).toThrow(/quantityRequired must be a positive integer/);
  });
});
