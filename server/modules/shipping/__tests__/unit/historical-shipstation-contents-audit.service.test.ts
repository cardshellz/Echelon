import { describe, expect, it, vi } from "vitest";

import { auditHistoricalShipStationContents } from "../../historical-shipstation-contents-audit.service";

const candidates = [
  { shippingProviderLabelId: "101", providerShipmentId: 44_001 },
  { shippingProviderLabelId: "102", providerShipmentId: 44_002 },
  { shippingProviderLabelId: "103", providerShipmentId: 44_003 },
  { shippingProviderLabelId: "104", providerShipmentId: 44_004 },
  { shippingProviderLabelId: "105", providerShipmentId: 44_005 },
  { shippingProviderLabelId: "106", providerShipmentId: 44_006 },
  { shippingProviderLabelId: "107", providerShipmentId: 44_007 },
  { shippingProviderLabelId: "108", providerShipmentId: 44_008 },
] as const;

function found(status: "authoritative" | "omitted" | "empty" | "unrecognized" | "malformed" | "mixed") {
  return {
    kind: "found" as const,
    evidence: {
      status,
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
  it("classifies every candidate sequentially and emits aggregate-only evidence", async () => {
    const results = [
      found("authoritative"),
      found("omitted"),
      found("empty"),
      found("unrecognized"),
      found("malformed"),
      found("mixed"),
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
      providerAuthoritativeCount: 1,
      requiresLeadAttestationCount: 8,
      safeToAutoResolveCount: 0,
      databaseTemporaryPrivilege: false,
    });
    expect(maxActive).toBe(1);
    expect(loadShipmentContents.mock.calls.map(([id]) => id)).toEqual(
      candidates.map((candidate) => candidate.providerShipmentId),
    );
    expect(JSON.stringify(report)).not.toContain("SECRET");
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.contentsStatusCounts)).toBe(true);
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
});
