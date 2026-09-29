import { describe, expect, it } from "vitest";
import { attestationPrefillFromProviderAnswer, describeProviderAnswerBatch, describeProviderAnswerResult,
  providerAnswerConfirmations, providerAnswerLabel } from "../inventory-publication-recovery";
import type { PendingQuantityPublicationRecovery } from "@shared/types/inventory-publication-recovery";

type Attempt = PendingQuantityPublicationRecovery["unresolvedAttempts"][number];
const attempt: Attempt = { attemptId: "482", owner: "legacy", state: "uncertain", outboxId: null,
  destinationKind: "dropship_store_connection", connectionId: 9, providerKey: "ebay", providerScopeType: "account",
  externalScopeId: "account-1", externalInventoryItemId: "ARM-ENV-SGL-P50",
  providerAnswer: { requestId: "9002", method: "POST", path: "/sell/inventory/v1/offer/77/publish", httpStatus: 400,
    errorCodes: ["25002"], responseHash: "b".repeat(64), recordedAt: "2026-09-29T09:30:00.000Z" } };

describe("attestationPrefillFromProviderAnswer", () => {
  it("fills every attestation field from the stored answer, with the response hash as the evidence hash", () => {
    expect(attestationPrefillFromProviderAnswer(attempt)).toEqual({
      evidenceKind: "provider_terminal_request_record",
      terminalOutcome: "completed",
      evidenceReference: "Stored provider request 9002: POST /sell/inventory/v1/offer/77/publish answered HTTP 400 (codes 25002) at 2026-09-29T09:30:00.000Z",
      evidenceHash: "b".repeat(64),
      reason: "eBay answered every request of attempt 482; the last answer was HTTP 400 with codes 25002, a refusal that wrote no quantity.",
      summary: "eBay answered HTTP 400 (codes 25002) to POST /sell/inventory/v1/offer/77/publish at 2026-09-29T09:30:00.000Z. " +
        "That is a refusal: nothing was written, so this request can no longer change quantities. The fields below are filled from that stored answer.",
    });
    expect(providerAnswerLabel(attempt)).toBe(" · answered HTTP 400");
  });

  it("fills nothing when the server found no answer on file", () => {
    expect(attestationPrefillFromProviderAnswer({ ...attempt, providerAnswer: null })).toBeNull();
    expect(attestationPrefillFromProviderAnswer({ ...attempt, providerAnswer: undefined })).toBeNull();
    expect(providerAnswerLabel({ ...attempt, providerAnswer: null })).toBe("");
  });
});

describe("one-click confirmation helpers", () => {
  const unanswered: Attempt = { ...attempt, attemptId: "483", externalInventoryItemId: "ARM-ENV-SGL-P100", providerAnswer: null };

  it("sends exactly the listed attempts with an answer on file, pinned to the hash shown", () => {
    expect(providerAnswerConfirmations([attempt, unanswered])).toEqual([{ attemptId: "482", responseHash: "b".repeat(64) }]);
    expect(providerAnswerConfirmations([unanswered])).toEqual([]);
  });

  it("describes what one click covers and what stays listed", () => {
    expect(describeProviderAnswerBatch([attempt, unanswered])).toBe(
      "eBay refused 1 of the 2 listed requests, and each refusal is on file. That request wrote nothing, so it can be confirmed together. " +
      "The other entry stays listed because no answer is on file for it.");
    expect(describeProviderAnswerBatch([attempt, { ...attempt, attemptId: "484" }])).toBe(
      "eBay refused 2 of the 2 listed requests, and each refusal is on file. Those requests wrote nothing, so they can be confirmed together.");
    expect(describeProviderAnswerBatch([attempt, { ...attempt, attemptId: "484", providerKey: "walmart" }, unanswered, { ...unanswered, attemptId: "485" }]))
      .toContain("The marketplaces refused 2 of the 4 listed requests, and each refusal is on file. Those requests wrote nothing, so they can be confirmed together. The other 2 entries stay listed because no answer is on file for them.");
    expect(describeProviderAnswerBatch([unanswered])).toBeNull();
    expect(describeProviderAnswerBatch([])).toBeNull();
  });

  it("reports the outcome in plain words without claiming a provider write", () => {
    expect(describeProviderAnswerResult({ basis: "operator_attestation", providerWriteAttempted: false,
      confirmed: [{ attemptId: "1", replay: false }, { attemptId: "2", replay: false }, { attemptId: "3", replay: true }],
      skipped: [{ attemptId: "4", reason: "answer_changed" }, { attemptId: "5", reason: "no_provider_answer" }, { attemptId: "6", reason: "answer_changed" }] }))
      .toBe("Confirmed 2 entries · 1 already recorded · 3 skipped (answer changed since it was shown; no answer on file). " +
        "No provider write or provider verification was performed. Failed listing pushes for the confirmed SKUs can be queued again.");
    expect(describeProviderAnswerResult({ basis: "operator_attestation", providerWriteAttempted: false, confirmed: [{ attemptId: "1", replay: false }], skipped: [] }))
      .toBe("Confirmed 1 entry. No provider write or provider verification was performed. Failed listing pushes for the confirmed SKUs can be queued again.");
  });
});
