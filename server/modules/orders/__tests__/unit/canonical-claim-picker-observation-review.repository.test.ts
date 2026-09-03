import { describe, expect, it, vi } from "vitest";

import {
  CanonicalClaimPickerObservationReviewError,
  PostgresCanonicalClaimPickerObservationReviewRepository,
} from "../../canonical-claim-picker-observation-review.repository";

const OCCURRED_AT = new Date("2026-09-03T11:00:00.000Z");

function reviewInput(client: { query: ReturnType<typeof vi.fn> }) {
  return {
    client,
    orderId: 70,
    orderItemId: 71,
    targetVariantId: 105,
    requestedQty: 3,
    selectedLocationId: 3,
    resolution: "picker_scan_count_correction" as const,
    reviewReason: "Picker scanned three units in P-3.",
    metadata: {
      schemaVersion: "inventory_availability_claim_picker_observation_v1" as const,
      pickerNonBlocking: true as const,
      shipmentBlocking: false as const,
      claimId: "9",
      claimLineId: "20",
      observationKind: "validated_item_scan" as const,
      observedPhysicalQty: "3",
      systemLevelQtyBefore: "1",
      systemLotQtyBefore: "1",
      recordedUnreservedQtyBefore: "1",
      recordedReconciledQty: "1",
      observedRelocatedQty: "2",
      relocatedInventoryLotIds: [53],
      releasedClaimResourceIds: ["12"],
      deviceType: "scanner",
      sessionId: "session-1",
      actor: "picker-1",
    },
    occurredAt: OCCURRED_AT,
  };
}

describe("PostgresCanonicalClaimPickerObservationReviewRepository", () => {
  it("records one open nonblocking review through the supplied transaction client", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: 88 }], rowCount: 1 }) };
    const repository = new PostgresCanonicalClaimPickerObservationReviewRepository();

    await expect(repository.recordReview(reviewInput(client))).resolves.toBe(88);

    expect(client.query).toHaveBeenCalledOnce();
    const [statement, values] = client.query.mock.calls[0];
    expect(statement).toContain("INSERT INTO wms.allocation_exceptions");
    expect(statement).toContain("'needs_review'");
    expect(values).toEqual([
      105,
      3,
      3,
      "picker_scan_count_correction",
      "Picker scanned three units in P-3.",
      JSON.stringify(reviewInput(client).metadata),
      OCCURRED_AT,
      71,
      70,
    ]);
  });

  it("fails when the order item or selected location cannot be resolved", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const repository = new PostgresCanonicalClaimPickerObservationReviewRepository();

    await expect(repository.recordReview(reviewInput(client))).rejects.toMatchObject<
      Partial<CanonicalClaimPickerObservationReviewError>
    >({ code: "PICKER_OBSERVATION_REVIEW_TARGET_MISSING" });
  });
});
