import { describe, expect, it } from "vitest";
import { hasFinalQuantityProviderOutcome, type QuantityProviderFinalityEvidence } from "../../domain/quantity-provider-finality";

describe("quantity provider finality", () => {
  const unknown: QuantityProviderFinalityEvidence = { state: "uncertain",resolutionBasis: null,
    requestCount: 0,unfinishedRequestCount: 0,completedRequestCount: 0,hasRequestJournalContract: false,hasResponseRecoveryReceipt: false };
  const cases: Array<[Partial<QuantityProviderFinalityEvidence>,boolean]> = [
    [{ state: "not_sent",resolutionBasis: "owner_preflight_no_request" },true],
    [{ state: "not_sent",resolutionBasis: "owner_preflight_no_request",requestCount: 1 },false],
    [{ state: "not_sent",resolutionBasis: null },false],
    [{ state: "rejected",resolutionBasis: "provider_rejection",requestCount: 2,hasRequestJournalContract: true },true],
    [{ state: "rejected",resolutionBasis: "provider_rejection",requestCount: 2,hasRequestJournalContract: false },false],
    [{ state: "rejected",resolutionBasis: "provider_rejection",requestCount: 0,hasRequestJournalContract: true },false],
    [{ state: "rejected",resolutionBasis: "provider_rejection",requestCount: 2,unfinishedRequestCount: 1,hasRequestJournalContract: true },false],
    [{ state: "resolved",resolutionBasis: "provider_response_terminal",hasResponseRecoveryReceipt: true,hasRequestJournalContract: true },true],
    [{ state: "resolved",resolutionBasis: "provider_response_terminal",hasResponseRecoveryReceipt: true,hasRequestJournalContract: false },false],
    [{ state: "resolved",resolutionBasis: "provider_response_terminal",hasResponseRecoveryReceipt: false,hasRequestJournalContract: true },false],
    [{ state: "resolved",resolutionBasis: "operator_attestation",hasResponseRecoveryReceipt: true,hasRequestJournalContract: true },false],
    [{ state: "succeeded",resolutionBasis: "owner_completion" },false],
    [{ state: "succeeded",resolutionBasis: "owner_completion",hasRequestJournalContract: true,requestCount: 1,completedRequestCount: 1 },true],
    [{ state: "succeeded",resolutionBasis: "owner_completion",hasRequestJournalContract: false,requestCount: 1,completedRequestCount: 1 },false],
    [{ state: "succeeded",resolutionBasis: "owner_completion",hasRequestJournalContract: true,requestCount: 2,completedRequestCount: 1 },false],
    [{ state: "succeeded",resolutionBasis: "owner_completion",hasRequestJournalContract: true,requestCount: 1,completedRequestCount: 1,unfinishedRequestCount: 1 },false],
    [{ state: "running" },false],
    [{ state: "superseded_unknown" },false],
  ];
  it.each(cases)("classifies retained evidence %j as final=%s", (patch, expected) => {
    expect(hasFinalQuantityProviderOutcome({ ...unknown,...patch })).toBe(expected);
  });
});
