import type { OpeningAssessment, OpeningSaved, OpeningSource, OpeningVerification } from "@shared/types/inventory-cutover-opening";
import { reconstructionEvidence } from "./inventory-cutover-reconstruction.fixture";

export const OPENING_TIME = "2026-09-09T12:00:00.000Z";
export const OPENING_HASH = "a".repeat(64);
export function openingSource(): OpeningSource {
  return { contractVersion: "inventory_cutover_opening_source_v1", capturedAt: OPENING_TIME,
    runtimeAuthority: "legacy", authorityRevision: "1", configurationRunId: null, evidenceHash: OPENING_HASH,
    evidence: reconstructionEvidence(), labels: [
      { kind: "order", id: "1", label: "Order #CS-1001" }, { kind: "variant", id: "101", label: "P5" },
      { kind: "warehouse", id: "1", label: "MAIN — Main warehouse" }, { kind: "location", id: "100", label: "PICK-A-01" },
    ], latestVerification: null };
}
export function openingVerification(): OpeningVerification {
  const source = openingSource();
  return { contractVersion: "inventory_cutover_opening_v1", expectedEvidenceHash: source.evidenceHash,
    expectedAuthorityRevision: source.authorityRevision, expectedConfigurationRunId: null,
    verificationReference: "Reviewed current stock count and order commitments", verificationEvidenceHash: "b".repeat(64),
    verifiedAt: OPENING_TIME, historicalDisposition: "preserve_unresolved", levels: source.evidence.levels,
    lots: source.evidence.lots, owners: [{ orderId: 1, orderItemId: 11, remainingQty: "6", reservedQty: "3", pickedQty: "2",
      allocations: [{ inventoryLevelId: 10, lots: [{ inventoryLotId: 4, reservedQty: "3", pickedQty: "2", originalCostIds: [9] }] }] }] };
}
export function openingAssessment(): OpeningAssessment {
  return { sourceEvidenceHash: OPENING_HASH, verificationHash: "c".repeat(64), ready: true, blockers: [],
    historicalExceptions: [{ code: "HISTORY_UNKNOWN", subject: "journal:1", message: "Earlier history remains unresolved" }],
    historicalExceptionHash: "d".repeat(64), plan: { evidenceHash: OPENING_HASH, ready: true, blockers: [], orders: [],
      retainedIndependentBuildReservationIds: [], legacyPromiseReleases: [] } };
}
export function openingSaved(): OpeningSaved {
  return { id: "7", sourceEvidenceHash: OPENING_HASH, verificationHash: "c".repeat(64), authorityRevision: "1",
    historicalExceptionHash: "d".repeat(64), historicalExceptionCount: 1, verifiedAt: OPENING_TIME, actor: "operator-1",
    reason: "Reviewed independent current evidence", alreadyApplied: false, stockChanged: false, authorityChanged: false };
}
