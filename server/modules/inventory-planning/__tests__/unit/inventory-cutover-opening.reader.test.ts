import { describe, expect, it } from "vitest";
import type { OpeningVerification } from "@shared/types/inventory-cutover-opening";
import { evaluateCutoverOpening } from "../../domain/inventory-cutover-opening";
import { reconstructionEvidenceHash, reconstructionHash } from "../../domain/inventory-cutover-reconstruction";
import { validateStoredCutoverOpening } from "../../infrastructure/inventory-cutover-opening.reader";
import { reconstructionEvidence } from "../fixtures/inventory-cutover-reconstruction.fixture";

function stored() {
  const evidence = reconstructionEvidence();
  evidence.journals[0] = { ...evidence.journals[0], unknownCount: "1" };
  const verification: OpeningVerification = { contractVersion: "inventory_cutover_opening_v1",
    expectedEvidenceHash: reconstructionEvidenceHash(evidence), expectedAuthorityRevision: "1", expectedConfigurationRunId: null,
    verificationReference: "Independent counted stock and open-order verification", verificationEvidenceHash: "c".repeat(64),
    verifiedAt: "2026-09-09T15:00:00Z", historicalDisposition: "preserve_unresolved", levels: evidence.levels, lots: evidence.lots,
    owners: [{ orderId: 1, orderItemId: 11, remainingQty: "6", reservedQty: "3", pickedQty: "2",
      allocations: [{ inventoryLevelId: 10, lots: [{ inventoryLotId: 4, reservedQty: "3", pickedQty: "2", originalCostIds: [9] }] }] }] };
  const assessment = evaluateCutoverOpening(evidence, verification);
  expect(assessment.ready).toBe(true);
  const result = { id: "1", sourceEvidenceHash: assessment.sourceEvidenceHash, verificationHash: assessment.verificationHash,
    authorityRevision: "1", historicalExceptionHash: assessment.historicalExceptionHash,
    historicalExceptionCount: assessment.historicalExceptions.length, verifiedAt: verification.verifiedAt,
    actor: "operator", reason: "Verified current facts", alreadyApplied: false, stockChanged: false, authorityChanged: false };
  const request = { verification, reason: result.reason, idempotencyKey: "opening-1" };
  return { id: "1", authority_revision: "1", configuration_run_id: null,
    source_evidence_hash: assessment.sourceEvidenceHash, verification_hash: assessment.verificationHash,
    historical_exception_hash: assessment.historicalExceptionHash,
    request_hash: reconstructionHash({ contractVersion: "inventory_cutover_opening_save_v1", actor: "operator", ...request }),
    result_hash: reconstructionHash(result), evidence_payload: evidence, verification_payload: verification,
    assessment_payload: assessment, request_payload: request, result_payload: result,
    actor: "operator", reason: result.reason, idempotency_key: request.idempotencyKey,
    verified_at: new Date(verification.verifiedAt), occurred_at: new Date("2026-09-09T16:00:00Z") };
}

describe("immutable opening evidence reader", () => {
  it("validates original facts and independently rebuilds the persisted assessment", () => {
    const row = stored();
    expect(validateStoredCutoverOpening(row)).toEqual({ saved: row.result_payload,
      verification: row.verification_payload, assessment: row.assessment_payload, requestHash: row.request_hash });
    // PostgreSQL normalizes timestamptz precision; equivalent valid source spelling is accepted.
    expect(row.verification_payload.verifiedAt).toBe("2026-09-09T15:00:00Z");
    expect(row.verified_at.toISOString()).toBe("2026-09-09T15:00:00.000Z");
  });

  it.each(["id", "authority_revision", "source_evidence_hash", "verification_hash", "historical_exception_hash",
    "request_hash", "result_hash", "actor", "reason", "idempotency_key"])("rejects tampered %s", field => {
    const row = stored();
    expect(() => validateStoredCutoverOpening({ ...row, [field]: "changed" })).toThrowError(expect.objectContaining({ code: "CUTOVER_OPENING_RECEIPT_INVALID" }));
  });

  it.each(["configuration_run_id", "verified_at", "occurred_at"])("rejects tampered %s context", field => {
    const row = stored(); const changed = field === "configuration_run_id" ? "2" : new Date("2026-09-01T00:00:00Z");
    expect(() => validateStoredCutoverOpening({ ...row, [field]: changed })).toThrowError(expect.objectContaining({ code: "CUTOVER_OPENING_RECEIPT_INVALID" }));
  });

  it("does not trust a rehashed success receipt claiming a different exception count", () => {
    const row = stored(); row.result_payload.historicalExceptionCount += 1;
    row.result_hash = reconstructionHash(row.result_payload);
    expect(() => validateStoredCutoverOpening(row)).toThrowError(expect.objectContaining({ code: "CUTOVER_OPENING_RECEIPT_INVALID" }));
  });

  it("does not trust altered assessment contents with otherwise valid original hashes", () => {
    const row = stored(); row.assessment_payload.plan.orders[0].lines[0].freshDemandQty = "99";
    expect(() => validateStoredCutoverOpening(row)).toThrowError(expect.objectContaining({ code: "CUTOVER_OPENING_RECEIPT_INVALID" }));
  });

  it("rejects edits to raw historical evidence, chosen facts or command intent", () => {
    const row = stored(); row.evidence_payload.journals[0].journalHash = "d".repeat(64);
    expect(() => validateStoredCutoverOpening(row)).toThrowError(expect.objectContaining({ code: "CUTOVER_OPENING_RECEIPT_INVALID" }));
    const verification = structuredClone(stored()); verification.verification_payload.verificationReference = "Different evidence";
    expect(() => validateStoredCutoverOpening(verification)).toThrowError(expect.objectContaining({ code: "CUTOVER_OPENING_RECEIPT_INVALID" }));
    const request = stored(); request.request_payload.reason = "Different reason";
    expect(() => validateStoredCutoverOpening(request)).toThrowError(expect.objectContaining({ code: "CUTOVER_OPENING_RECEIPT_INVALID" }));
  });

  it.each([null, [], { extra: true }])("rejects malformed persisted full snapshots: %#", evidence => {
    expect(() => validateStoredCutoverOpening({ ...stored(), evidence_payload: evidence }))
      .toThrowError(expect.objectContaining({ code: "CUTOVER_OPENING_RECEIPT_INVALID" }));
  });

  it("never accepts a receipt already marked replayed or one that reports an operational write", () => {
    const row = stored(); row.result_payload.alreadyApplied = true; row.result_hash = reconstructionHash(row.result_payload);
    expect(() => validateStoredCutoverOpening(row)).toThrowError(expect.objectContaining({ code: "CUTOVER_OPENING_RECEIPT_INVALID" }));
    const changed = stored(); changed.result_payload.stockChanged = true;
    expect(() => validateStoredCutoverOpening(changed)).toThrowError(expect.objectContaining({ code: "CUTOVER_OPENING_RECEIPT_INVALID" }));
  });
});
