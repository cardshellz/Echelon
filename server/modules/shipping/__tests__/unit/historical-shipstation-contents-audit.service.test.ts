import { describe, expect, it, vi } from "vitest";

import { auditHistoricalShipStationContents } from "../../historical-shipstation-contents-audit.service";
import type { HistoricalShipStationContentsRecoveryStatus } from "../../historical-shipstation-contents-recovery.domain";

const expectedContents = {
  kind: "available" as const,
  source: "physical_shipment" as const,
  lines: [{ wmsShipmentItemId: 7_001, sku: "SKU-A", quantity: 1 }],
};

const candidates = [
  { shippingProviderLabelId: "101", providerShipmentId: 44_001, expectedContents },
  { shippingProviderLabelId: "102", providerShipmentId: 44_002, expectedContents },
  { shippingProviderLabelId: "103", providerShipmentId: 44_003, expectedContents },
  { shippingProviderLabelId: "104", providerShipmentId: 44_004, expectedContents },
  { shippingProviderLabelId: "105", providerShipmentId: 44_005, expectedContents },
  { shippingProviderLabelId: "106", providerShipmentId: 44_006, expectedContents },
  { shippingProviderLabelId: "107", providerShipmentId: 44_007, expectedContents },
  { shippingProviderLabelId: "108", providerShipmentId: 44_008, expectedContents },
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

describe("historical ShipStation contents audit service", () => {
  it("classifies every candidate sequentially and emits aggregate-only recovery evidence", async () => {
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
      batchLimitReached: true,
      databaseTemporaryPrivilege: false,
      candidates,
    }, { loadShipmentContents });

    expect(report).toEqual({
      mode: "read_only_historical_shipstation_contents_audit",
      candidateLimit: 8,
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
      requiresLeadAttestationCount: 8,
      safeToAutoResolveCount: 0,
      databaseTemporaryPrivilege: false,
    });
    expect(maxActive).toBe(1);
    expect(loadShipmentContents.mock.calls).toEqual(
      candidates.map((candidate) => [candidate.providerShipmentId, candidate.expectedContents]),
    );
    expect(JSON.stringify(report)).not.toContain("SECRET");
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.contentsStatusCounts)).toBe(true);
    expect(Object.isFrozen(report.recoveryStatusCounts)).toBe(true);
  });

  it("rejects duplicated identities before any provider call", async () => {
    const loadShipmentContents = vi.fn();
    await expect(auditHistoricalShipStationContents({
      candidateLimit: 2,
      batchLimitReached: false,
      databaseTemporaryPrivilege: false,
      candidates: [candidates[0], { ...candidates[1], providerShipmentId: 44_001 }],
    }, { loadShipmentContents })).rejects.toThrow(/duplicated/);
    expect(loadShipmentContents).not.toHaveBeenCalled();
  });

  it("rejects malformed expected WMS contents before any provider call", async () => {
    const loadShipmentContents = vi.fn();
    await expect(auditHistoricalShipStationContents({
      candidateLimit: 1,
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
});
