import { describe, expect, it } from "vitest";
import { attestationPrefillFromProviderAnswer, providerAnswerLabel } from "../inventory-publication-recovery";
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
