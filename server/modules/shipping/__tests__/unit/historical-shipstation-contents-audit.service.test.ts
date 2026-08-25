import { describe, expect, it, vi } from "vitest";

import { auditHistoricalShipStationContents } from "../../historical-shipstation-contents-audit.service";
import type { HistoricalShipStationContentsRecoveryStatus } from "../../historical-shipstation-contents-recovery.domain";

const expectedContents = {
  kind: "available" as const,
  source: "physical_shipment" as const,
  lines: [{ wmsShipmentItemId: 7_001, sku: "SKU-A", quantity: 1 }],
};
const expectedContentsSummary = {
  kind: "available" as const,
  source: "physical_shipment" as const,
  lineCount: 1,
};

const candidates = [
  { shippingProviderLabelId: "108", providerShipmentId: 44_008, expectedContents },
  { shippingProviderLabelId: "107", providerShipmentId: 44_007, expectedContents },
  { shippingProviderLabelId: "106", providerShipmentId: 44_006, expectedContents },
  { shippingProviderLabelId: "105", providerShipmentId: 44_005, expectedContents },
  { shippingProviderLabelId: "104", providerShipmentId: 44_004, expectedContents },
  { shippingProviderLabelId: "103", providerShipmentId: 44_003, expectedContents },
  { shippingProviderLabelId: "102", providerShipmentId: 44_002, expectedContents },
  { shippingProviderLabelId: "101", providerShipmentId: 44_001, expectedContents },
] as const;

function found(
  status: "authoritative" | "omitted" | "empty" | "unrecognized" | "malformed" | "mixed",
  recoveryStatus: HistoricalShipStationContentsRecoveryStatus,
) {
  return {
    kind: "found" as const,
    evidence: {
      status,
      recoveryStatus,
      providerItemCount: 0,
      recognizedProviderItemCount: 0,
      canonicalLineCount: 0,
      malformedItemCount: 0,
      unrecognizedItemCount: 0,
      duplicateLineItemCount: 0,
    },
  };
}

function reviewCase(
  shippingProviderLabelId: string,
  reason: string,
  providerContentsStatus: string | null,
) {
  const providerFound = providerContentsStatus !== null;
  return {
    shippingProviderLabelId,
    reason,
    providerContentsStatus,
    providerItemCount: providerFound ? 0 : null,
    canonicalLineCount: providerFound ? 0 : null,
    expectedContents: expectedContentsSummary,
  };
}

describe("historical ShipStation contents audit service", () => {
  it("classifies every candidate sequentially and emits redacted recovery evidence", async () => {
    const results = [
      found("authoritative", "provider_line_keys_authoritative"),
      found("omitted", "provider_evidence_unavailable"),
      found("empty", "provider_empty"),
      found("unrecognized", "exact_unique_wms_match"),
      found("malformed", "provider_evidence_unavailable"),
      found("mixed", "provider_evidence_unavailable"),
      { kind: "not_found" as const },
      new Error("SECRET-PROVIDER-FAILURE"),
    ];
    let active = 0;
    let maxActive = 0;
    const loadShipmentContents = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const result = results.shift();
      await Promise.resolve();
      active -= 1;
      if (result instanceof Error) throw result;
      return result!;
    });

    const report = await auditHistoricalShipStationContents({
      candidateLimit: 8,
      beforeLabelId: null,
      nextBeforeLabelId: "101",
      batchLimitReached: true,
      databaseTemporaryPrivilege: false,
      candidates,
    }, { loadShipmentContents });

    expect(report).toEqual({
      mode: "read_only_historical_shipstation_contents_audit",
      candidateLimit: 8,
      beforeLabelId: null,
      nextBeforeLabelId: "101",
      batchLimitReached: true,
      selectedCandidateCount: 8,
      providerRequestCount: 8,
      providerShipmentFoundCount: 6,
      providerShipmentNotFoundCount: 1,
      providerRequestFailureCount: 1,
      contentsStatusCounts: {
        authoritative: 1,
        omitted: 1,
        empty: 1,
        unrecognized: 1,
        malformed: 1,
        mixed: 1,
      },
      recoveryStatusCounts: {
        provider_line_keys_authoritative: 1,
        exact_unique_wms_match: 1,
        provider_empty: 1,
        provider_evidence_unavailable: 3,
        wms_lineage_unavailable: 0,
        ambiguous_wms_match: 0,
        provider_wms_conflict: 0,
      },
      providerAuthoritativeCount: 1,
      recoverableProviderEvidenceCount: 2,
      reviewRequiredByCurrentEvidenceCount: 6,
      reviewCases: [
        reviewCase("107", "provider_evidence_unavailable", "omitted"),
        reviewCase("106", "provider_empty", "empty"),
        reviewCase("104", "provider_evidence_unavailable", "malformed"),
        reviewCase("103", "provider_evidence_unavailable", "mixed"),
        reviewCase("102", "provider_shipment_not_found", null),
        reviewCase("101", "provider_request_failed", null),
      ],
      requiresLeadAttestationCount: 8,
      safeToAutoResolveCount: 0,
      databaseTemporaryPrivilege: false,
    });
    expect(maxActive).toBe(1);
    expect(loadShipmentContents.mock.calls).toEqual(
      candidates.map((candidate) => [candidate.providerShipmentId, candidate.expectedContents]),
    );
    expect(JSON.stringify(report)).not.toContain("SECRET");
    expect(JSON.stringify(report)).not.toContain("SKU-A");
    expect(JSON.stringify(report)).not.toContain("44008");
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.contentsStatusCounts)).toBe(true);
    expect(Object.isFrozen(report.recoveryStatusCounts)).toBe(true);
    expect(Object.isFrozen(report.reviewCases)).toBe(true);
    expect(report.reviewCases.every((entry) => Object.isFrozen(entry.expectedContents))).toBe(true);
  });

  it.each([
    ["provider_evidence_unavailable", "omitted"],
    ["wms_lineage_unavailable", "unrecognized"],
    ["ambiguous_wms_match", "unrecognized"],
    ["provider_wms_conflict", "unrecognized"],
  ] as const)("emits a redacted review record for %s", async (recoveryStatus, contentsStatus) => {
    const unavailableExpectedContents = {
      kind: "unavailable" as const,
      reason: "linked_package_contents_unavailable" as const,
    };
    const candidate = {
      ...candidates[0],
      expectedContents: unavailableExpectedContents,
    };
    const loadShipmentContents = vi.fn().mockResolvedValue(
      found(contentsStatus, recoveryStatus),
    );

    const report = await auditHistoricalShipStationContents({
      candidateLimit: 1,
      beforeLabelId: null,
      nextBeforeLabelId: null,
      batchLimitReached: false,
      databaseTemporaryPrivilege: false,
      candidates: [candidate],
    }, { loadShipmentContents });

    expect(report.reviewRequiredByCurrentEvidenceCount).toBe(1);
    expect(report.reviewCases).toEqual([{
      shippingProviderLabelId: candidate.shippingProviderLabelId,
      reason: recoveryStatus,
      providerContentsStatus: contentsStatus,
      providerItemCount: 0,
      canonicalLineCount: 0,
      expectedContents: unavailableExpectedContents,
    }]);
    expect(JSON.stringify(report)).not.toContain(String(candidate.providerShipmentId));
  });

  it("rejects duplicated identities before any provider call", async () => {
    const loadShipmentContents = vi.fn();
    await expect(auditHistoricalShipStationContents({
      candidateLimit: 2,
      beforeLabelId: null,
      nextBeforeLabelId: null,
      batchLimitReached: false,
      databaseTemporaryPrivilege: false,
      candidates: [candidates[0], { ...candidates[1], providerShipmentId: 44_008 }],
    }, { loadShipmentContents })).rejects.toThrow(/duplicated/);
    expect(loadShipmentContents).not.toHaveBeenCalled();
  });

  it("rejects malformed expected WMS contents before any provider call", async () => {
    const loadShipmentContents = vi.fn();
    await expect(auditHistoricalShipStationContents({
      candidateLimit: 1,
      beforeLabelId: null,
      nextBeforeLabelId: null,
      batchLimitReached: false,
      databaseTemporaryPrivilege: false,
      candidates: [{
        ...candidates[0],
        expectedContents: {
          kind: "available",
          source: "physical_shipment",
          lines: [{ wmsShipmentItemId: 7_001, sku: "", quantity: 1 }],
        },
      }],
    }, { loadShipmentContents })).rejects.toThrow(/evidence is invalid/);
    expect(loadShipmentContents).not.toHaveBeenCalled();
  });

  it("rejects non-descending label IDs before any provider call", async () => {
    const loadShipmentContents = vi.fn();
    await expect(auditHistoricalShipStationContents({
      candidateLimit: 2,
      beforeLabelId: null,
      nextBeforeLabelId: null,
      batchLimitReached: false,
      databaseTemporaryPrivilege: false,
      candidates: [candidates[1], candidates[0]],
    }, { loadShipmentContents })).rejects.toThrow(/descending/);
    expect(loadShipmentContents).not.toHaveBeenCalled();
  });

  it("rejects inconsistent continuation evidence before any provider call", async () => {
    const loadShipmentContents = vi.fn();
    await expect(auditHistoricalShipStationContents({
      candidateLimit: 2,
      beforeLabelId: "109",
      nextBeforeLabelId: "108",
      batchLimitReached: true,
      databaseTemporaryPrivilege: false,
      candidates: [candidates[0], candidates[1]],
    }, { loadShipmentContents })).rejects.toThrow(/pagination evidence/);
    expect(loadShipmentContents).not.toHaveBeenCalled();
  });
});
