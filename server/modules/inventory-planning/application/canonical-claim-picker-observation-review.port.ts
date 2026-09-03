import type { CanonicalClaimTransactionClient } from "./canonical-claim-inventory.port";

export type CanonicalClaimPickerObservationReviewMetadata = {
  schemaVersion: "inventory_availability_claim_picker_observation_v1";
  pickerNonBlocking: true;
  shipmentBlocking: false;
  claimId: string;
  claimLineId: string;
  observationKind: "validated_item_scan" | "picker_confirmed_physical_stock";
  observedPhysicalQty: string;
  systemLevelQtyBefore: string;
  systemLotQtyBefore: string;
  recordedUnreservedQtyBefore: string;
  recordedReconciledQty: string;
  observedRelocatedQty: string;
  relocatedInventoryLotIds: readonly number[];
  releasedClaimResourceIds: readonly string[];
  deviceType: string | null;
  sessionId: string | null;
  actor: string;
};

export interface CanonicalClaimPickerObservationReviewPort {
  recordReview(input: {
    client: CanonicalClaimTransactionClient;
    orderId: number;
    orderItemId: number;
    targetVariantId: number;
    requestedQty: number;
    selectedLocationId: number;
    resolution: "picker_scan_count_correction" | "picker_confirmed_count_correction";
    reviewReason: string;
    metadata: CanonicalClaimPickerObservationReviewMetadata;
    occurredAt: Date;
  }): Promise<number>;
}
