import { describe, expect, it } from "vitest";
import { formatProviderErrorCodes, providerAnswerEvidence, providerAnswerIdempotencyKey } from "../inventory-publication-recovery-evidence";
import { quantityPublicationRecoverySchema } from "../types/inventory-publication-recovery";

const answer = { requestId: "9002", method: "POST" as const, path: "/sell/inventory/v1/offer/77/publish", httpStatus: 400,
  errorCodes: ["25002"], responseHash: "b".repeat(64), recordedAt: "2026-09-29T09:30:00.000Z" };

describe("provider answer evidence", () => {
  it("builds the same attestation words for a stored refusal wherever it is recorded", () => {
    expect(providerAnswerEvidence({ attemptId: "482", providerKey: "ebay" }, answer)).toEqual({
      evidenceKind: "provider_terminal_request_record", terminalOutcome: "completed", evidenceHash: "b".repeat(64),
      evidenceReference: "Stored provider request 9002: POST /sell/inventory/v1/offer/77/publish answered HTTP 400 (codes 25002) at 2026-09-29T09:30:00.000Z",
      reason: "eBay answered every request of attempt 482; the last answer was HTTP 400 with codes 25002, a refusal that wrote no quantity.",
    });
    expect(providerAnswerEvidence({ attemptId: "1", providerKey: "walmart" }, { ...answer, errorCodes: [] }).reason)
      .toBe("Walmart answered every request of attempt 1; the last answer was HTTP 400 with codes none supplied, a refusal that wrote no quantity.");
  });

  it("produces a complete attestation command with a deterministic, bounded key", () => {
    const attemptId = "9223372036854775807"; // the largest attempt id the ledger can hold
    const key = providerAnswerIdempotencyKey(attemptId, answer.responseHash);
    expect(key).toBe(`provider-answer:${attemptId}:${"b".repeat(64)}`);
    expect(key.length).toBeLessThanOrEqual(200);
    expect(quantityPublicationRecoverySchema.safeParse({ attemptId, idempotencyKey: key,
      ...providerAnswerEvidence({ attemptId, providerKey: "ebay" }, answer) }).success).toBe(true);
  });

  it("names absent codes instead of printing an empty list", () => {
    expect(formatProviderErrorCodes([])).toBe("none supplied");
    expect(formatProviderErrorCodes(["25002", "25001"])).toBe("25002, 25001");
  });
});
