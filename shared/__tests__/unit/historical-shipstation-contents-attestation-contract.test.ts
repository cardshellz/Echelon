import { describe, expect, it } from "vitest";

import {
  historicalShipStationContentsAttestationPreviewResponseSchema,
  historicalShipStationContentsAttestationRequestSchema,
  historicalShipStationContentsAttestationResponseSchema,
} from "../../types/historical-shipstation-contents-attestation";

const preview = Object.freeze({
  shippingProviderLabelId: "5530",
  providerShipmentId: 44_001,
  providerContentsStatus: "authoritative" as const,
  recoveryStatus: "provider_line_keys_authoritative" as const,
  previewEvidenceHash: "a".repeat(64),
  providerEvidenceHash: "b".repeat(64),
  expectedContents: Object.freeze({
    kind: "available" as const,
    source: "physical_shipment" as const,
    lines: Object.freeze([
      Object.freeze({ wmsShipmentItemId: 7_001, sku: "SKU-A", quantity: 2 }),
    ]),
  }),
  attestedContents: Object.freeze([
    Object.freeze({ wmsShipmentItemId: 7_001, quantity: 2 }),
  ]),
});

describe("historical ShipStation contents attestation API contract", () => {
  it("accepts a bounded exact preview response", () => {
    expect(historicalShipStationContentsAttestationPreviewResponseSchema.parse({ preview }))
      .toEqual({ preview });
  });

  it("rejects malformed identities, hashes, lines, and extra request authority", () => {
    expect(historicalShipStationContentsAttestationPreviewResponseSchema.safeParse({
      preview: { ...preview, shippingProviderLabelId: "0" },
    }).success).toBe(false);
    expect(historicalShipStationContentsAttestationPreviewResponseSchema.safeParse({
      preview: { ...preview, attestedContents: [] },
    }).success).toBe(false);
    expect(historicalShipStationContentsAttestationRequestSchema.safeParse({
      expectedPreviewEvidenceHash: "not-a-hash",
      reason: "Reviewed exact evidence",
    }).success).toBe(false);
    expect(historicalShipStationContentsAttestationRequestSchema.safeParse({
      expectedPreviewEvidenceHash: "a".repeat(64),
      reason: "Reviewed exact evidence",
      authenticatedActorUserId: "forged-user",
    }).success).toBe(false);
  });


  it("rejects duplicate WMS shipment item identities", () => {
    const duplicateAttestedContents = [
      { wmsShipmentItemId: 7_001, quantity: 1 },
      { wmsShipmentItemId: 7_001, quantity: 1 },
    ];

    expect(historicalShipStationContentsAttestationPreviewResponseSchema.safeParse({
      preview: { ...preview, attestedContents: duplicateAttestedContents },
    }).success).toBe(false);
    expect(historicalShipStationContentsAttestationPreviewResponseSchema.safeParse({
      preview: {
        ...preview,
        expectedContents: {
          ...preview.expectedContents,
          lines: [
            ...preview.expectedContents.lines,
            ...preview.expectedContents.lines,
          ],
        },
      },
    }).success).toBe(false);
  });

  it("accepts created and exact idempotent replay receipts", () => {
    for (const kind of ["created", "already_persisted"] as const) {
      expect(historicalShipStationContentsAttestationResponseSchema.parse({
        attestation: {
          kind,
          attestationId: "901",
          shippingProviderLabelId: "5530",
          previewEvidenceHash: "a".repeat(64),
          resolvedEventCount: 2,
        },
      }).attestation.kind).toBe(kind);
    }
  });
});
