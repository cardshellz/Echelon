import { describe, expect, it } from "vitest";

import type { HistoricalShipStationContentsAttestationPreview } from "@shared/types/historical-shipstation-contents-attestation";
import {
  historicalContentsAttestationReadiness,
  historicalContentsComparisonRows,
  parseHistoricalContentsLabelId,
} from "../historical-shipment-contents-review-model";

const preview: HistoricalShipStationContentsAttestationPreview = {
  shippingProviderLabelId: "5530",
  providerShipmentId: 44_001,
  providerContentsStatus: "authoritative",
  recoveryStatus: "provider_line_keys_authoritative",
  previewEvidenceHash: "a".repeat(64),
  providerEvidenceHash: "b".repeat(64),
  reviewContext: {
    trackingNumber: "9400111899223856928499",
    shipStationOrderId: "700100200",
    wmsOrders: [{ wmsOrderId: 301, orderNumber: "#1001" }],
    linkedShipments: [
      { source: "physical_shipment", shipmentId: "77" },
      { source: "legacy_wms_shipment", shipmentId: "88" },
    ],
    linePresentations: [
      { wmsShipmentItemId: 10, itemName: "Item A" },
      { wmsShipmentItemId: 20, itemName: "Item B" },
    ],
  },
  expectedContents: {
    kind: "available",
    source: "physical_shipment",
    lines: [
      { wmsShipmentItemId: 20, sku: "SKU-B", quantity: 3 },
      { wmsShipmentItemId: 10, sku: "SKU-A", quantity: 2 },
    ],
  },
  attestedContents: [
    { wmsShipmentItemId: 10, quantity: 2 },
    { wmsShipmentItemId: 20, quantity: 4 },
    { wmsShipmentItemId: 30, quantity: 1 },
  ],
};

describe("historical shipment contents review model", () => {
  it("builds a stable identity-level WMS and ShipStation comparison", () => {
    expect(historicalContentsComparisonRows(preview)).toEqual([
      {
        wmsShipmentItemId: 10,
        itemName: "Item A",
        sku: "SKU-A",
        expectedQuantity: 2,
        attestedQuantity: 2,
        status: "match",
      },
      {
        wmsShipmentItemId: 20,
        itemName: "Item B",
        sku: "SKU-B",
        expectedQuantity: 3,
        attestedQuantity: 4,
        status: "quantity_mismatch",
      },
      {
        wmsShipmentItemId: 30,
        itemName: null,
        sku: null,
        expectedQuantity: null,
        attestedQuantity: 1,
        status: "missing_from_wms",
      },
    ]);
  });

  it("requires permission, current preview, exact reason, and explicit confirmation", () => {
    expect(historicalContentsAttestationReadiness({
      canAttest: false,
      preview: null,
      reason: " ",
      reviewConfirmed: false,
    })).toMatchObject({ ready: false, request: null });

    expect(historicalContentsAttestationReadiness({
      canAttest: true,
      preview,
      reason: "Reviewed exact WMS and ShipStation evidence",
      reviewConfirmed: true,
    })).toEqual({
      ready: true,
      issues: [],
      request: {
        expectedPreviewEvidenceHash: preview.previewEvidenceHash,
        reason: "Reviewed exact WMS and ShipStation evidence",
      },
    });
  });

  it("normalizes pasted label whitespace but rejects invalid identities", () => {
    expect(parseHistoricalContentsLabelId(" 5530 ")).toEqual({ valid: true, value: "5530" });
    expect(parseHistoricalContentsLabelId("0")).toEqual({
      valid: false,
      message: "Enter a positive shipping provider label ID.",
    });
  });
});
