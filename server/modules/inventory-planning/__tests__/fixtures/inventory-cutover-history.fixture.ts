import type { OpeningSource } from "@shared/types/inventory-cutover-opening";
import type { CutoverHistoryFacts, HistoricalReceiptFacts, HistoricalShipmentFacts } from "../../domain/inventory-cutover-history-proposal";
import { reconstructionEvidenceHash } from "../../domain/inventory-cutover-reconstruction";
import { reconstructionEvidence } from "./inventory-cutover-reconstruction.fixture";

export const HISTORY_TIME = "2026-09-27T13:00:00.000Z";
export const HISTORY_HASH = "a".repeat(64);
export function historyReceipt(): HistoricalReceiptFacts {
  return {
    id: "20", rowHash: HISTORY_HASH, attemptsHash: HISTORY_HASH, itemsHash: HISTORY_HASH,
    status: "review", sourceChannelId: 36, sourceOrderId: "external-20", linkedOrderId: "50",
    leaseExpiresAt: null, leaseTokenPresent: false, createdAt: "2026-07-23T13:00:00.000Z",
    matchedOrders: [{
      id: "50", channelId: 36, externalOrderId: "external-20", status: "shipped",
      rowHash: HISTORY_HASH, linesHash: HISTORY_HASH, lines: [{ id: "51", requiresShipping: true, authorizedQty: 1, fulfillmentStatus: "fulfilled" }]
    }]
  };
}
export function historyShipment(): HistoricalShipmentFacts {
  return {
    id: 90, rowHash: HISTORY_HASH, status: "cancelled", orderId: 2, orderStatus: "shipped", orderHash: HISTORY_HASH,
    purpose: "customer_fulfillment", externalFulfillmentId: null, requiresReview: true, held: false,
    physicalLinksHash: HISTORY_HASH, labelsHash: HISTORY_HASH, physicalStatuses: [], openPickCorrections: 0,
    sources: [{
      id: 91, rowHash: HISTORY_HASH, purpose: "customer_fulfillment", quantity: 1, orderItemId: 21, variantId: 101,
      replacementForOrderItemId: null, correctionForSourceItemId: null,
      owner: {
        id: 21, orderId: 2, orderStatus: "shipped", quantity: 1, pickedQuantity: 1, fulfilledQuantity: 1,
        rowHash: HISTORY_HASH, orderHash: HISTORY_HASH
      }, correctedPhysicalItems: []
    }]
  };
}
export function historyFixture() {
  const evidence = reconstructionEvidence(); evidence.items[0].pickedQuantity = 0;
  const source: OpeningSource = {
    contractVersion: "inventory_cutover_opening_source_v1", capturedAt: HISTORY_TIME,
    runtimeAuthority: "legacy", authorityRevision: "1", configurationRunId: null, evidenceHash: HISTORY_HASH,
    evidence, labels: [], latestVerification: null
  };
  const facts: CutoverHistoryFacts = {
    contractVersion: "inventory_cutover_history_facts_v1", sourceEvidenceHash: HISTORY_HASH,
    capturedAt: HISTORY_TIME, receipts: [historyReceipt()], shipments: [historyShipment()]
  };
  resealHistoryFixture(source, facts);
  return { source, facts };
}
export function resealHistoryFixture(source: OpeningSource, facts: CutoverHistoryFacts): void {
  source.evidence.shipmentReviewEvidence = [
    ...facts.receipts.map(row => ({ id: row.id, kind: "channel_fulfillment_receipt", status: row.status, evidenceHash: row.rowHash })),
    ...facts.shipments.filter(row => row.requiresReview).map(row => ({ id: String(row.id), kind: "outbound_shipment_review", status: row.status, evidenceHash: row.rowHash })),
  ];
  source.evidence.sourceItems = facts.shipments.flatMap(row => row.sources.map(item => ({
    id: item.id, shipmentId: row.id,
    headerOrderId: row.orderId, orderItemId: item.orderItemId, replacementForOrderItemId: item.replacementForOrderItemId,
    correctionForShipmentItemId: item.correctionForSourceItemId, productVariantId: item.variantId, quantity: item.quantity,
    purpose: item.purpose, fromLocationId: null, shipmentStatus: row.status, shipmentHeld: row.held
  })));
  source.evidenceHash = reconstructionEvidenceHash(source.evidence); facts.sourceEvidenceHash = source.evidenceHash;
}
