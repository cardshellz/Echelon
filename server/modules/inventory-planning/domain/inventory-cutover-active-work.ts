import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { activeCutoverHistory } from "./inventory-cutover-history-retirement";

type ActiveCutoverWork = Pick<CutoverReconstructionEvidence,
  "sourceItems" | "physicalItems" | "shipmentReviewEvidence">;

/** Shared processing scope for the verified opening and historical retirement.
 * Closed lifecycle records remain in the ORIGINAL census, hash and historical
 * findings. Excluding them from outstanding work is not proof of delivery or a
 * stock movement. Everything else (including unknown states) remains in scope;
 * pending work can leave this scope only through a validated retirement audit.
 */
export function selectActiveCutoverWork(evidence: CutoverReconstructionEvidence): ActiveCutoverWork {
  const activeHistory = activeCutoverHistory(evidence);
  return {
    sourceItems: activeHistory.sourceItems.filter(source => source.shipmentStatus !== "shipped"),
    physicalItems: evidence.physicalItems.filter(item => item.packageStatus !== "shipped"),
    shipmentReviewEvidence: activeHistory.shipmentReviewEvidence.filter(review => !(
      ((review.kind === "channel_fulfillment_acknowledgment" || review.kind === "channel_fulfillment_receipt")
        && review.status === "ignored")
      || (review.kind === "outbound_shipment_review" && review.status === "shipped"))),
  };
}
