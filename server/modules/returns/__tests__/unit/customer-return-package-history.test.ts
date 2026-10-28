import { describe, expect, it } from "vitest";
import {
  liveLocalFixture,
  liveShopifyFixture,
} from "../support/live-inspection-fixtures";
import { historyFixture } from "../../../shipping/__tests__/support/package-history-fixtures";
import {
  buildPackageHistory,
  packageHistoryNativeFromShopify,
} from "../../../shipping/package-history.domain";
import { projectHistoricalReturnBoxes } from "../../application/customer-return-package-history";

function fixture() {
  const f = historyFixture(),
    local = liveLocalFixture(),
    provider = liveShopifyFixture();
  local.order.externalOrderNumber = "#12";
  provider.order.name = "#12";
  local.lines[0] = { ...local.lines[0], quantity: 1, sku: "PRODUCT" };
  local.lines[1] = {
    ...local.lines[1],
    quantity: 1,
    sku: "CLUB",
    requiresShipping: false,
  };
  provider.lines[0] = {
    ...provider.lines[0],
    quantity: 1,
    currentQuantity: 1,
    refundableQuantity: 1,
    sku: "PRODUCT",
  };
  provider.lines[1] = {
    ...provider.lines[1],
    quantity: 1,
    currentQuantity: 1,
    refundableQuantity: 1,
    sku: "CLUB",
    requiresShipping: false,
  };
  provider.fulfillments = [
    {
      ...provider.fulfillments[0],
      totalQuantity: 1,
      tracking: [{ number: "TRACK601", company: "USPS" }],
      lines: [{ ...provider.fulfillments[0].lines[0], quantity: 1 }],
    },
    provider.fulfillments[2],
  ];
  return {
    local,
    provider,
    document: buildPackageHistory(
      f.scope,
      packageHistoryNativeFromShopify(provider),
      f.observations,
    ),
  };
}
describe("historical return box defaults", () => {
  it("shows the proven original box without requiring missing legacy WMS bindings", () => {
    const f = fixture(),
      boxes = projectHistoricalReturnBoxes(f.local, f.provider, f.document);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].dimensions).toEqual({
      lengthMm: 254,
      widthMm: 203.2,
      heightMm: 101.6,
    });
    expect(boxes[0].items[0].quantity).toBe(1);
  });
  it("rejects source changes, foreign owners and mutated allocation proofs", () => {
    const f = fixture();
    f.provider.fulfillments[0].status = "CANCELLED";
    expect(
      projectHistoricalReturnBoxes(f.local, f.provider, f.document),
    ).toEqual([]);
    const other = fixture();
    other.document.channelId = 37;
    expect(() =>
      projectHistoricalReturnBoxes(other.local, other.provider, other.document),
    ).toThrow();
    const altered = fixture();
    altered.document.packages[0].lines[0].quantity = 2;
    expect(() =>
      projectHistoricalReturnBoxes(
        altered.local,
        altered.provider,
        altered.document,
      ),
    ).toThrow();
    const duplicate = fixture();
    duplicate.document.packages.push(
      structuredClone(duplicate.document.packages[0]),
    );
    expect(() =>
      projectHistoricalReturnBoxes(
        duplicate.local,
        duplicate.provider,
        duplicate.document,
      ),
    ).toThrow();
  });
  it("preserves canonical ownership even when a canonical package is not currently usable", () => {
    const f = fixture();
    f.local.packageItems.push({
      physicalShipmentId: 401,
      physicalShipmentItemId: 501,
      wmsOrderItemId: null,
      omsOrderLineId: null,
      legacyShipmentItemId: null,
      legacyShipmentId: null,
      purpose: "customer_fulfillment",
      replacementForOrderItemId: null,
      correctionForPhysicalShipmentItemId: null,
      originalQuantity: 1,
      effectiveQuantity: 0,
      status: "cancelled",
      provider: "shipstation",
      providerPhysicalShipmentId: "601",
      trackingNumber: "TRACK601",
      carrier: "USPS",
    });
    expect(
      projectHistoricalReturnBoxes(f.local, f.provider, f.document),
    ).toEqual([]);
  });
  it("offers manual sizing for a proven package whose measurements are unavailable", () => {
    const f = fixture();
    f.document.packages[0].dimensions = null;
    f.document.packages[0].measurementStatus = "missing";
    f.document.packages[0].measurementSource = "missing";
    expect(
      projectHistoricalReturnBoxes(f.local, f.provider, f.document),
    ).toEqual([]);
  });
});
