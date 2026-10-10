import { describe, expect, it } from "vitest";
import { formatProviderErrorCodes, providerAnswerEvidence, providerAnswerIdempotencyKey, requestTerminationEvidence,
  requestTerminationIdempotencyKey, selectRecoveryEvidence } from "../inventory-publication-recovery-evidence";
import { quantityPublicationRecoverySchema } from "../types/inventory-publication-recovery";

const answer = { requestId: "9002", method: "POST" as const, path: "/sell/inventory/v1/offer/77/publish", httpStatus: 400,
  errorCodes: ["25002"], responseHash: "b".repeat(64), recordedAt: "2026-09-29T09:30:00.000Z" };
const termination = { requestCount: 2, lastActivityAt: "2026-09-29T09:30:00.000Z", quiescentSince: "2026-09-29T10:30:30.000Z",
  providerRequestTimeoutSeconds: 30, quiescenceMarginMinutes: 60, evidenceHash: "e".repeat(64) };

describe("recovery evidence words", () => {
  it("builds the same attestation words for a stored refusal wherever it is recorded", () => {
    expect(providerAnswerEvidence({ attemptId: "482", providerKey: "ebay" }, answer)).toEqual({
      evidenceKind: "provider_terminal_request_record", terminalOutcome: "completed", evidenceHash: "b".repeat(64),
      evidenceReference: "Stored provider request 9002: POST /sell/inventory/v1/offer/77/publish answered HTTP 400 (codes 25002) at 2026-09-29T09:30:00.000Z",
      reason: "eBay answered every request of attempt 482; the last answer was HTTP 400 with codes 25002. Historical quantity effects have not been verified.",
    });
    expect(providerAnswerEvidence({ attemptId: "1", providerKey: "walmart" }, { ...answer, errorCodes: [] }).reason)
      .toBe("Walmart answered every request of attempt 1; the last answer was HTTP 400 with codes none supplied. Historical quantity effects have not been verified.");
  });

  it("builds termination words from the stored record, with not_sent for an attempt that never sent a request", () => {
    expect(requestTerminationEvidence({ attemptId: "482", providerKey: "ebay" }, termination)).toEqual({
      evidenceKind: "owner_process_and_request_termination_record", terminalOutcome: "completed", evidenceHash: "e".repeat(64),
      evidenceReference: "Stored request record of attempt 482: 2 requests; last activity at 2026-09-29T09:30:00.000Z; the 30-second provider request deadline and a 60-minute margin passed at 2026-09-29T10:30:30.000Z.",
      reason: "eBay was last contacted for attempt 482 at 2026-09-29T09:30:00.000Z; every request of it has been terminated since 2026-09-29T10:30:30.000Z, so none can still change provider quantities. Catch-up republishes the current quantity.",
    });
    expect(requestTerminationEvidence({ attemptId: "7", providerKey: "shopify" }, { ...termination, requestCount: 0 }))
      .toMatchObject({ terminalOutcome: "not_sent", evidenceReference: expect.stringContaining("0 requests") });
    expect(requestTerminationEvidence({ attemptId: "7", providerKey: "shopify" }, { ...termination, requestCount: 1 }).evidenceReference).toContain("1 request;");
  });

  it("produces complete attestation commands with deterministic, bounded keys", () => {
    const attemptId = "9223372036854775807"; // the largest attempt id the ledger can hold
    for (const [key, evidence] of [
      [providerAnswerIdempotencyKey(attemptId, answer.responseHash), providerAnswerEvidence({ attemptId, providerKey: "ebay" }, answer)],
      [requestTerminationIdempotencyKey(attemptId, termination.evidenceHash), requestTerminationEvidence({ attemptId, providerKey: "ebay" }, termination)],
    ] as const) {
      expect(key.length).toBeLessThanOrEqual(200);
      expect(quantityPublicationRecoverySchema.safeParse({ attemptId, idempotencyKey: key, ...evidence }).success).toBe(true);
    }
    expect(providerAnswerIdempotencyKey("9", "b".repeat(64))).toBe(`provider-answer:9:${"b".repeat(64)}`);
    expect(requestTerminationIdempotencyKey("9", "e".repeat(64))).toBe(`request-termination:9:${"e".repeat(64)}`);
  });

  it("selects the provider's refusal before a termination record, and nothing when neither is on file", () => {
    const base = { attemptId: "482", providerKey: "ebay" as const };
    expect(selectRecoveryEvidence({ ...base, providerAnswer: answer, requestTermination: termination }))
      .toMatchObject({ source: "provider_answer", evidenceHash: "b".repeat(64), idempotencyKey: `provider-answer:482:${"b".repeat(64)}` });
    expect(selectRecoveryEvidence({ ...base, providerAnswer: null, requestTermination: termination }))
      .toMatchObject({ source: "request_termination", evidenceHash: "e".repeat(64), idempotencyKey: `request-termination:482:${"e".repeat(64)}` });
    expect(selectRecoveryEvidence({ ...base, providerAnswer: null, requestTermination: null })).toBeNull();
    expect(selectRecoveryEvidence({ ...base })).toBeNull();
  });

  it("names absent codes instead of printing an empty list", () => {
    expect(formatProviderErrorCodes([])).toBe("none supplied");
    expect(formatProviderErrorCodes(["25002", "25001"])).toBe("25002, 25001");
  });
});
