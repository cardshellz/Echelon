import type { ReceivingIntegrityTransaction } from "./receiving-close-integrity.repository";
import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import { receivingUnitVersion, type ReceiptUnitLine } from "./receiving-unit-contract";

/** Quarantine source review includes money/provenance as well as count units.
 * Keep the ordinary receiving version protocol unchanged. Equal timestamps
 * alone cannot establish that the reviewed cost stayed the same. */
export function receivingQuarantineSourceVersion(line: ReceiptUnitLine & {
  unitCost?: number | null; unitCostMills?: number | null; costSourceKind?: string | null; costSourceEvidence?: unknown;
}): string {
  return createHash("sha256").update(canonicalJson({ unitVersion: receivingUnitVersion(line),
    unitCost: line.unitCost ?? null, unitCostMills: line.unitCostMills ?? null,
    costSourceKind: line.costSourceKind ?? null, costSourceEvidence: line.costSourceEvidence ?? null,
  })).digest("hex");
}

export interface ReviewQuarantineIntakeInput {
  receivingOrderId: number;
  receivingLineId: number;
  expectedUnitVersion: string;
  acceptedQty: number;
  heldQty: number;
  holdingLocationId: number;
}

export interface QuarantineIntakeLineSnapshot {
  id: number;
  receivingOrderId: number;
  productId: number | null;
  productVariantId: number;
  unitsPerVariantSnapshot: number;
  purchaseOrderLineId: number | null;
  inboundShipmentLineId: number | null;
  sku: string | null;
  productName: string | null;
  receivedQty: number;
  damagedQty: number;
  expectedQty: number;
}

export interface ReviewedQuarantineIntake {
  order: { id: number; warehouseId: number; purchaseOrderId: number | null; inboundShipmentId: number | null; status: string };
  lineBefore: QuarantineIntakeLineSnapshot;
  lineAfter: QuarantineIntakeLineSnapshot;
  productId: number;
  productVariantId: number;
  unitsPerVariantSnapshot: number;
}

export interface PrepareReceivingQuarantineAcceptanceInput {
  sourceReceivingOrderId: number;
  targetReceivingOrderId: number | null;
  targetSourceReceivingLineId: number;
  expectedTargetUnitVersion: string;
  productVariantId: number;
  expectedUnitsPerVariant: number;
  acceptedVariantQty: number;
  purchaseOrderLineId: number | null;
  inboundShipmentLineId: number | null;
  putawayLocationId: number;
  observationId: number;
  reason: string;
}

export interface PreparedReceivingQuarantineAcceptance {
  receivingOrderId: number;
  receivingLineId: number;
  productId: number;
  productVariantId: number;
  unitsPerVariantSnapshot: number;
  acceptedVariantQty: number;
}

/** The custody owner supplies the transaction and owns the cost-graph lock.
 * These methods prepare ordinary receiving; only normal receipt close posts stock.
 */
export interface ReceivingQuarantineReceivingPort {
  reviewQuarantineIntakeInTransaction(tx: ReceivingIntegrityTransaction, input: ReviewQuarantineIntakeInput,
    actorId: string, recordedAt: Date): Promise<ReviewedQuarantineIntake>;
  prepareQuarantineAcceptanceInTransaction(tx: ReceivingIntegrityTransaction, input: PrepareReceivingQuarantineAcceptanceInput,
    actorId: string, recordedAt: Date): Promise<PreparedReceivingQuarantineAcceptance>;
  cancelQuarantineAcceptanceInTransaction(tx: ReceivingIntegrityTransaction,
    input: { receivingOrderId: number; receivingLineId: number; acceptanceId: number }, actorId: string, recordedAt: Date): Promise<void>;
}
