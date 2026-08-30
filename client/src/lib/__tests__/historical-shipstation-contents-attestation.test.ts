import { describe, expect, it, vi } from "vitest";

import {
  HistoricalShipStationContentsAttestationApiError,
  loadHistoricalShipStationContentsAttestationPreview,
  submitHistoricalShipStationContentsAttestation,
} from "../historical-shipstation-contents-attestation";

const preview = {
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
    linkedShipments: [{ source: "legacy_wms_shipment", shipmentId: "88" }],
    linePresentations: [{ wmsShipmentItemId: 7_001, itemName: "Card Shell" }],
  },
  expectedContents: {
    kind: "available",
    source: "physical_shipment",
    lines: [{ wmsShipmentItemId: 7_001, sku: "SKU-A", quantity: 2 }],
  },
  attestedContents: [{ wmsShipmentItemId: 7_001, quantity: 2 }],
};

describe("historical ShipStation contents attestation client", () => {
  it("loads and validates an authenticated preview", async () => {
    const fetchImplementation = vi.fn(async () => new Response(
      JSON.stringify({ preview }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    await expect(loadHistoricalShipStationContentsAttestationPreview(
      "5530",
      fetchImplementation,
    )).resolves.toMatchObject({ shippingProviderLabelId: "5530" });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/shipping/admin/historical-contents-attestations/5530/preview",
      { credentials: "include" },
    );
  });

  it("posts only the exact preview hash and operator reason", async () => {
    const attestation = {
      kind: "created",
      attestationId: "901",
      shippingProviderLabelId: "5530",
      previewEvidenceHash: "a".repeat(64),
      resolvedEventCount: 2,
    };
    const fetchImplementation = vi.fn(async () => new Response(
      JSON.stringify({ attestation }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    const request = {
      expectedPreviewEvidenceHash: "a".repeat(64),
      reason: "Reviewed exact WMS and ShipStation evidence",
    };

    await expect(submitHistoricalShipStationContentsAttestation(
      "5530",
      request,
      fetchImplementation,
    )).resolves.toEqual(attestation);
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/shipping/admin/historical-contents-attestations/5530",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(request),
      },
    );
  });

  it("fails closed on invalid success responses and preserves server error identity", async () => {
    const invalidResponse = vi.fn(async () => new Response(
      JSON.stringify({ preview: { shippingProviderLabelId: "5530" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    await expect(loadHistoricalShipStationContentsAttestationPreview(
      "5530",
      invalidResponse,
    )).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const staleResponse = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "PREVIEW_EVIDENCE_MISMATCH", message: "Preview changed" },
    }), { status: 409, headers: { "content-type": "application/json" } }));
    await expect(loadHistoricalShipStationContentsAttestationPreview(
      "5530",
      staleResponse,
    )).rejects.toEqual(expect.objectContaining<Partial<HistoricalShipStationContentsAttestationApiError>>({
      status: 409,
      code: "PREVIEW_EVIDENCE_MISMATCH",
      message: "Preview changed",
    }));
  });

  it("rejects invalid label identity before issuing a request", async () => {
    const fetchImplementation = vi.fn();
    await expect(loadHistoricalShipStationContentsAttestationPreview(
      "0",
      fetchImplementation,
    )).rejects.toMatchObject({ code: "INVALID_LABEL_ID" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
