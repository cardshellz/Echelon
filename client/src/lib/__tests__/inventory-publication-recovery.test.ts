import { describe, expect, it } from "vitest";
import { attestationPrefill, describeRecoveryEvidenceBatch, describeRecoveryEvidenceResult,
  recoveryEvidenceConfirmations, recoveryEvidenceLabel } from "../inventory-publication-recovery";
import type { PendingQuantityPublicationRecovery } from "@shared/types/inventory-publication-recovery";

type Attempt = PendingQuantityPublicationRecovery["unresolvedAttempts"][number];
const attempt: Attempt = { attemptId: "482", owner: "legacy", state: "uncertain", outboxId: null,
  destinationKind: "dropship_store_connection", connectionId: 9, providerKey: "ebay", providerScopeType: "account",
  externalScopeId: "account-1", externalInventoryItemId: "ARM-ENV-SGL-P50",
  providerAnswer: { requestId: "9002", method: "POST", path: "/sell/inventory/v1/offer/77/publish", httpStatus: 400,
    errorCodes: ["25002"], responseHash: "b".repeat(64), recordedAt: "2026-09-29T09:30:00.000Z" }, requestTermination: null };
const quiet: Attempt = { ...attempt, attemptId: "483", externalInventoryItemId: "ARM-ENV-SGL-P100", providerAnswer: null,
  requestTermination: { requestCount: 2, lastActivityAt: "2026-09-29T09:30:00.000Z", quiescentSince: "2026-09-29T10:30:30.000Z",
    providerRequestTimeoutSeconds: 30, quiescenceMarginMinutes: 60, evidenceHash: "e".repeat(64) } };
const bare: Attempt = { ...attempt, attemptId: "484", externalInventoryItemId: "ARM-ENV-SGL-P200", providerAnswer: null, requestTermination: null };

describe("attestationPrefill", () => {
  it("fills every attestation field from the stored refusal, with the response hash as the evidence hash", () => {
    expect(attestationPrefill(attempt)).toEqual({
      evidenceKind: "provider_terminal_request_record",
      terminalOutcome: "completed",
      evidenceReference: "Stored provider request 9002: POST /sell/inventory/v1/offer/77/publish answered HTTP 400 (codes 25002) at 2026-09-29T09:30:00.000Z",
      evidenceHash: "b".repeat(64),
      reason: "eBay answered every request of attempt 482; the last answer was HTTP 400 with codes 25002, a refusal that wrote no quantity.",
      summary: "eBay answered HTTP 400 (codes 25002) to POST /sell/inventory/v1/offer/77/publish at 2026-09-29T09:30:00.000Z. " +
        "That is a refusal: nothing was written, so this request can no longer change quantities. The fields below are filled from that stored answer.",
    });
    expect(recoveryEvidenceLabel(attempt)).toBe(" · answered HTTP 400");
  });

  it("fills the termination record for an attempt that has been quiet past the deadline and margin", () => {
    expect(attestationPrefill(quiet)).toEqual({
      evidenceKind: "owner_process_and_request_termination_record",
      terminalOutcome: "completed",
      evidenceReference: "Stored request record of attempt 483: 2 requests; last activity at 2026-09-29T09:30:00.000Z; the 30-second provider request deadline and a 60-minute margin passed at 2026-09-29T10:30:30.000Z.",
      evidenceHash: "e".repeat(64),
      reason: "eBay was last contacted for attempt 483 at 2026-09-29T09:30:00.000Z; every request of it has been terminated since 2026-09-29T10:30:30.000Z, so none can still change provider quantities. Catch-up republishes the current quantity.",
      summary: "eBay was last contacted at 2026-09-29T09:30:00.000Z. Nothing has happened on this request for more than 60 minutes, and a request times out after 30 seconds, " +
        "so it can no longer change quantities; catch-up republishes the current stock. The fields below are filled from that stored record.",
    });
    expect(recoveryEvidenceLabel(quiet)).toBe(" · no activity since 2026-09-29T09:30:00.000Z");
  });

  it("fills nothing when the server found no evidence on file", () => {
    expect(attestationPrefill(bare)).toBeNull();
    expect(attestationPrefill({ ...bare, providerAnswer: undefined, requestTermination: undefined })).toBeNull();
    expect(recoveryEvidenceLabel(bare)).toBe("");
  });
});

describe("one-click confirmation helpers", () => {
  it("sends exactly the listed attempts with evidence on file, pinned to the hash shown", () => {
    expect(recoveryEvidenceConfirmations([attempt, quiet, bare])).toEqual([
      { attemptId: "482", evidenceHash: "b".repeat(64) }, { attemptId: "483", evidenceHash: "e".repeat(64) }]);
    expect(recoveryEvidenceConfirmations([bare])).toEqual([]);
  });

  it("describes what one click covers and what stays listed", () => {
    expect(describeRecoveryEvidenceBatch([attempt, bare])).toBe(
      "1 of the 2 listed entries can be confirmed: 1 refused by eBay with the refusal on file. " +
      "Those writes can no longer change stock; catch-up republishes the current quantity. The other entry stays listed: it was active too recently.");
    expect(describeRecoveryEvidenceBatch([attempt, quiet, { ...quiet, attemptId: "485" }, bare, { ...bare, attemptId: "486" }])).toBe(
      "3 of the 5 listed entries can be confirmed: 1 refused by eBay with the refusal on file; 2 with no activity for more than 60 minutes " +
      "(a request times out after 30 seconds, so nothing is still in flight). " +
      "Those writes can no longer change stock; catch-up republishes the current quantity. The other 2 entries stay listed: they were active too recently.");
    expect(describeRecoveryEvidenceBatch([quiet])).toBe(
      "1 of the 1 listed entry can be confirmed: 1 with no activity for more than 60 minutes (a request times out after 30 seconds, so nothing is still in flight). " +
      "Those writes can no longer change stock; catch-up republishes the current quantity.");
    expect(describeRecoveryEvidenceBatch([attempt, { ...attempt, attemptId: "487", providerKey: "walmart" }])).toContain("2 refused by the marketplace with the refusal on file");
    expect(describeRecoveryEvidenceBatch([bare])).toBeNull();
    expect(describeRecoveryEvidenceBatch([])).toBeNull();
  });

  it("reports the outcome in plain words without claiming a provider write", () => {
    expect(describeRecoveryEvidenceResult({ basis: "operator_attestation", providerWriteAttempted: false,
      confirmed: [{ attemptId: "1", replay: false }, { attemptId: "2", replay: false }, { attemptId: "3", replay: true }],
      skipped: [{ attemptId: "4", reason: "evidence_changed" }, { attemptId: "5", reason: "no_evidence" }, { attemptId: "6", reason: "evidence_changed" }] }))
      .toBe("Confirmed 2 entries · 1 already recorded · 3 skipped (record changed since it was shown; no evidence on file). " +
        "No provider write or provider verification was performed. Failed listing pushes for the confirmed SKUs can be queued again.");
    expect(describeRecoveryEvidenceResult({ basis: "operator_attestation", providerWriteAttempted: false, confirmed: [{ attemptId: "1", replay: false }], skipped: [] }))
      .toBe("Confirmed 1 entry. No provider write or provider verification was performed. Failed listing pushes for the confirmed SKUs can be queued again.");
  });
});
