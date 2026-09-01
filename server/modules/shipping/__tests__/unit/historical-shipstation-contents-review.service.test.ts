import { describe, expect, it, vi } from "vitest";

import type { HistoricalShipStationContentsClient } from "../../historical-shipstation-contents-audit.client";
import {
  HistoricalShipStationContentsReviewService,
  HistoricalShipStationContentsReviewServiceError,
  type HistoricalShipStationContentsReviewCandidate,
  type HistoricalShipStationContentsReviewRepository,
  type HistoricalShipStationContentsReviewSnapshot,
} from "../../historical-shipstation-contents-review.service";

const providerObservationHash = "a".repeat(64);
const candidate: HistoricalShipStationContentsReviewCandidate = Object.freeze({
  shippingProviderLabelId: "41",
  providerShipmentId: 44_001,
  trackingNumber: "1Z999AA10123456784",
  labelStatus: "active",
  expectedContents: Object.freeze({
    kind: "available",
    source: "physical_shipment",
    lines: Object.freeze([
      Object.freeze({ wmsShipmentItemId: 7_001, sku: "WMS-SKU", quantity: 2 }),
    ]),
  }),
  shipStationOrderId: "SS-1001",
  wmsOrders: Object.freeze([Object.freeze({ wmsOrderId: 301, orderNumber: "1001" })]),
  linkedShipments: Object.freeze([
    Object.freeze({ source: "physical_shipment", shipmentId: "201" }),
  ]),
  linePresentations: Object.freeze([
    Object.freeze({ wmsShipmentItemId: 7_001, itemName: "WMS item" }),
  ]),
});

const snapshot: HistoricalShipStationContentsReviewSnapshot = Object.freeze({
  exceptionId: "501",
  candidate,
  reason: "provider_wms_conflict",
  providerObservationHash,
  providerRecoveryStatus: "provider_wms_conflict",
});

function providerResult(hash = providerObservationHash) {
  return Object.freeze({
    kind: "found" as const,
    evidence: Object.freeze({
      status: "unrecognized" as const,
      recoveryStatus: "provider_wms_conflict" as const,
      providerItemCount: 1,
      recognizedProviderItemCount: 0,
      canonicalLineCount: 0,
      malformedItemCount: 0,
      unrecognizedItemCount: 1,
      duplicateLineItemCount: 0,
      recoveryEvidence: null,
    }),
    recoveryEvidenceDetails: null,
    providerObservation: Object.freeze({
      evidenceHash: hash,
      lines: Object.freeze([Object.freeze({ sku: "SHIPSTATION-SKU", quantity: 5 })]),
    }),
  });
}

function harness() {
  const loadCandidate = vi.fn(async () => candidate);
  const loadOpenReview = vi.fn(async () => snapshot);
  const upsertReview = vi.fn(async () => Object.freeze({
    kind: "created" as const,
    exceptionId: "501",
    shippingProviderLabelId: "41",
  }));
  const loadWmsResolutionReplay = vi.fn(async () => null);
  const confirmWmsContents = vi.fn(async () => Object.freeze({
    kind: "created" as const,
    exceptionId: "501",
    shippingProviderLabelId: "41",
    labelEventId: "601",
    eventHash: "b".repeat(64),
  }));
  const recordDecision = vi.fn(async () => Object.freeze({
    exceptionId: "501",
    status: "acknowledged" as const,
  }));
  const repository: HistoricalShipStationContentsReviewRepository = {
    loadCandidate,
    loadOpenReview,
    upsertReview,
    loadWmsResolutionReplay,
    confirmWmsContents,
    recordDecision,
  };
  const loadShipmentContents = vi.fn(async () => providerResult());
  const client: HistoricalShipStationContentsClient = { loadShipmentContents };
  return {
    service: new HistoricalShipStationContentsReviewService(repository, client),
    loadCandidate,
    loadOpenReview,
    upsertReview,
    loadWmsResolutionReplay,
    confirmWmsContents,
    recordDecision,
    loadShipmentContents,
  };
}

describe("HistoricalShipStationContentsReviewService", () => {
  it("persists intake only after exact provider evidence is re-fetched", async () => {
    const test = harness();

    await expect(test.service.intake({
      shippingProviderLabelId: "41",
      reason: "provider_wms_conflict",
      expectedEvidenceHash: providerObservationHash,
    })).resolves.toMatchObject({ kind: "created", exceptionId: "501" });

    expect(test.loadShipmentContents).toHaveBeenCalledWith(44_001, candidate.expectedContents);
    expect(test.upsertReview).toHaveBeenCalledWith(expect.objectContaining({
      candidate,
      reason: "provider_wms_conflict",
      providerObservation: providerResult().providerObservation,
    }));
  });

  it("rejects intake when ShipStation evidence changed after the recovery preview", async () => {
    const test = harness();
    test.loadShipmentContents.mockResolvedValueOnce(providerResult("c".repeat(64)));

    await expect(test.service.intake({
      shippingProviderLabelId: "41",
      reason: "provider_wms_conflict",
      expectedEvidenceHash: providerObservationHash,
    })).rejects.toMatchObject({ code: "PROVIDER_EVIDENCE_CHANGED" });
    expect(test.upsertReview).not.toHaveBeenCalled();
  });

  it("previews recognizable identifiers and both exact content sets", async () => {
    const test = harness();

    await expect(test.service.preview("501")).resolves.toMatchObject({
      exceptionId: "501",
      shippingProviderLabelId: "41",
      previewEvidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      orderNumber: "1001",
      trackingNumber: "1Z999AA10123456784",
      providerContents: [{ sku: "SHIPSTATION-SKU", quantity: 5 }],
      wmsContents: [{
        wmsShipmentItemId: 7_001,
        sku: "WMS-SKU",
        itemName: "WMS item",
        quantity: 2,
      }],
    });
  });

  it("confirms WMS through immutable recovery evidence bound to the reviewed preview", async () => {
    const test = harness();
    const preview = await test.service.preview("501");

    await expect(test.service.decide({
      exceptionId: "501",
      expectedPreviewEvidenceHash: preview.previewEvidenceHash,
      authenticatedActorUserId: "lead-1",
      decision: "wms_confirmed",
      reason: "Physical packing record confirms the WMS package.",
    })).resolves.toMatchObject({ kind: "created", labelEventId: "601" });

    expect(test.confirmWmsContents).toHaveBeenCalledWith({
      snapshot,
      expectedPreviewHash: preview.previewEvidenceHash,
      actorUserId: "lead-1",
      reason: "Physical packing record confirms the WMS package.",
      recoveryEvidence: {
        contractVersion: 1,
        recoveryStatus: "wms_confirmed_after_provider_conflict",
        evidenceHash: providerObservationHash,
        attestedContents: [{ wmsShipmentItemId: 7_001, quantity: 2 }],
      },
    });
  });

  it("returns an exact WMS-decision replay without re-fetching provider evidence", async () => {
    const test = harness();
    test.loadWmsResolutionReplay.mockResolvedValueOnce(Object.freeze({
      kind: "already_persisted",
      exceptionId: "501",
      shippingProviderLabelId: "41",
      labelEventId: "601",
      eventHash: "b".repeat(64),
    }));

    await expect(test.service.decide({
      exceptionId: "501",
      expectedPreviewEvidenceHash: "c".repeat(64),
      authenticatedActorUserId: "lead-1",
      decision: "wms_confirmed",
      reason: "Physical packing record confirms the WMS package.",
    })).resolves.toMatchObject({ kind: "already_persisted", labelEventId: "601" });
    expect(test.loadOpenReview).not.toHaveBeenCalled();
    expect(test.loadShipmentContents).not.toHaveBeenCalled();
  });

  it("records provider-correct as an unresolved inventory-correction blocker", async () => {
    const test = harness();
    const preview = await test.service.preview("501");

    await expect(test.service.decide({
      exceptionId: "501",
      expectedPreviewEvidenceHash: preview.previewEvidenceHash,
      authenticatedActorUserId: "admin-1",
      decision: "provider_confirmed_pending_inventory_correction",
      reason: "The carrier packing record is the supported package record.",
    })).resolves.toEqual({ exceptionId: "501", status: "acknowledged" });
    expect(test.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: "provider_confirmed_pending_inventory_correction",
    }));
    expect(test.confirmWmsContents).not.toHaveBeenCalled();
  });

  it("keeps a no-lineage review usable without offering WMS confirmation", async () => {
    const test = harness();
    const unavailableCandidate: HistoricalShipStationContentsReviewCandidate = Object.freeze({
      ...candidate,
      expectedContents: Object.freeze({
        kind: "unavailable",
        reason: "no_linked_package",
      }),
      linePresentations: Object.freeze([]),
    });
    const unavailableSnapshot: HistoricalShipStationContentsReviewSnapshot = Object.freeze({
      ...snapshot,
      candidate: unavailableCandidate,
      reason: "wms_lineage_unavailable",
      providerRecoveryStatus: "wms_lineage_unavailable",
    });
    test.loadCandidate.mockResolvedValue(unavailableCandidate);
    test.loadOpenReview.mockResolvedValue(unavailableSnapshot);
    test.loadShipmentContents.mockResolvedValue(Object.freeze({
      ...providerResult(),
      evidence: Object.freeze({
        ...providerResult().evidence,
        recoveryStatus: "wms_lineage_unavailable" as const,
      }),
    }));

    const preview = await test.service.preview("501");
    expect(preview).toMatchObject({
      wmsContents: null,
      allowedDecisions: [
        "provider_confirmed_pending_inventory_correction",
        "cannot_prove",
      ],
    });
    await expect(test.service.decide({
      exceptionId: "501",
      expectedPreviewEvidenceHash: preview.previewEvidenceHash,
      authenticatedActorUserId: "lead-1",
      decision: "wms_confirmed",
      reason: "This must fail because there is no single WMS package.",
    })).rejects.toMatchObject({ code: "WMS_CONTENTS_UNAVAILABLE" });
    expect(test.confirmWmsContents).not.toHaveBeenCalled();
  });

  it("requires a bounded nonblank decision reason", async () => {
    const test = harness();
    await expect(test.service.decide({
      exceptionId: "501",
      expectedPreviewEvidenceHash: "c".repeat(64),
      authenticatedActorUserId: "lead-1",
      decision: "cannot_prove",
      reason: " ",
    })).rejects.toBeInstanceOf(HistoricalShipStationContentsReviewServiceError);
    expect(test.loadWmsResolutionReplay).not.toHaveBeenCalled();
  });
});
