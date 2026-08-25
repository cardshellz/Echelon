import { describe, expect, it, vi } from "vitest";

import {
  assertHistoricalShipStationContentsAuditEnabled,
  historicalShipStationContentsAuditPoolConfig,
  parseHistoricalShipStationContentsAuditCliOptions,
  runHistoricalShipStationContentsAuditJob,
} from "../../historical-shipstation-contents-audit.job";
import { normalizeHistoricalShipStationContentsAuditRepositoryOptions } from "../../../modules/shipping/historical-shipstation-contents-audit.repository";

const environment = {
  HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_ENABLED: "true",
  WMS_INTEGRITY_AUDIT_DATABASE_URL: "postgresql://audit:test-password@localhost/echelon",
  SHIPSTATION_API_KEY: "test-key",
  SHIPSTATION_API_SECRET: "test-secret",
};

function report() {
  return {
    mode: "read_only_historical_shipstation_contents_audit" as const,
    candidateLimit: 1,
    batchLimitReached: false,
    selectedCandidateCount: 1,
    providerRequestCount: 1,
    providerShipmentFoundCount: 1,
    providerShipmentNotFoundCount: 0,
    providerRequestFailureCount: 0,
    contentsStatusCounts: {
      authoritative: 1,
      omitted: 0,
      empty: 0,
      unrecognized: 0,
      malformed: 0,
      mixed: 0,
    },
    recoveryStatusCounts: {
      provider_line_keys_authoritative: 1,
      exact_unique_wms_match: 0,
      provider_empty: 0,
      provider_evidence_unavailable: 0,
      wms_lineage_unavailable: 0,
      ambiguous_wms_match: 0,
      provider_wms_conflict: 0,
    },
    providerAuthoritativeCount: 1,
    recoverableProviderEvidenceCount: 1,
    reviewRequiredByCurrentEvidenceCount: 0,
    requiresLeadAttestationCount: 1,
    safeToAutoResolveCount: 0 as const,
    databaseTemporaryPrivilege: false,
  };
}

describe("historical ShipStation contents audit job", () => {
  it("requires the exact enable flag", () => {
    expect(() => assertHistoricalShipStationContentsAuditEnabled({})).toThrow(/exactly 'true'/);
    expect(() => assertHistoricalShipStationContentsAuditEnabled({
      HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_ENABLED: "TRUE",
    })).toThrow(/exactly 'true'/);
    expect(() => assertHistoricalShipStationContentsAuditEnabled(environment)).not.toThrow();
  });

  it("parses one bounded optional limit and rejects unknown flags", () => {
    expect(parseHistoricalShipStationContentsAuditCliOptions([])).toEqual({
      help: false,
      candidateLimit: 25,
    });
    expect(parseHistoricalShipStationContentsAuditCliOptions(["--limit=100"])).toEqual({
      help: false,
      candidateLimit: 100,
    });
    expect(() => parseHistoricalShipStationContentsAuditCliOptions(["--limit=101"]))
      .toThrow(/must not exceed/);
    expect(() => parseHistoricalShipStationContentsAuditCliOptions(["--execute"]))
      .toThrow(/Unknown flag/);
  });

  it("pins bounded pool and PostgreSQL session deadlines", () => {
    const options = normalizeHistoricalShipStationContentsAuditRepositoryOptions({
      statementTimeoutMs: 30_000,
      lockTimeoutMs: 2_000,
      idleInTransactionTimeoutMs: 45_000,
    });
    const config = historicalShipStationContentsAuditPoolConfig(
      environment.WMS_INTEGRITY_AUDIT_DATABASE_URL,
      options,
    ) as Record<string, unknown>;

    expect(config).toMatchObject({
      host: "localhost",
      port: 5432,
      user: "audit",
      password: "test-password",
      database: "echelon",
      max: 1,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 35_000,
      query_timeout: 40_000,
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 60_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
    expect(config).not.toHaveProperty("connectionString");
  });

  it("closes the database pool before making provider requests", async () => {
    const order: string[] = [];
    const release = vi.fn(() => { order.push("release"); });
    const end = vi.fn(async () => { order.push("end"); });
    const poolFactory = vi.fn(() => ({
      connect: async () => {
        order.push("connect");
        return { query: vi.fn(), release };
      },
      end,
    }));
    const loadCandidates = vi.fn(async () => {
      order.push("database");
      return {
        candidateLimit: 1,
        batchLimitReached: false,
        databaseTemporaryPrivilege: false,
        candidates: [{
          shippingProviderLabelId: "101",
          providerShipmentId: 44_001,
          expectedContents: { kind: "unavailable" as const, reason: "no_linked_package" as const },
        }],
      };
    });
    const audit = vi.fn(async () => {
      order.push("provider");
      return report();
    });
    const times = [0, 1, 2, 3, 8, 9, 14, 15];

    const result = await runHistoricalShipStationContentsAuditJob({
      candidateLimit: 1,
      environment,
      poolFactory,
      providerClient: { loadShipmentContents: vi.fn() },
      loadCandidates,
      audit,
      runtime: { nowMs: () => times.shift()! },
    });

    expect(order).toEqual(["connect", "database", "release", "end", "provider"]);
    expect(result).toMatchObject({
      ...report(),
      setupDurationMs: 1,
      databaseReadDurationMs: 5,
      providerAuditDurationMs: 5,
      totalDurationMs: 15,
    });
    expect(release).toHaveBeenCalledWith(undefined);
    expect(end).toHaveBeenCalledOnce();
  });

  it("preserves database and cleanup failures and never calls the provider", async () => {
    const databaseFailure = new Error("database failed");
    const releaseFailure = new Error("release failed");
    const endFailure = new Error("end failed");
    const audit = vi.fn();
    const promise = runHistoricalShipStationContentsAuditJob({
      candidateLimit: 1,
      environment,
      poolFactory: () => ({
        connect: async () => ({
          query: vi.fn(),
          release: () => { throw releaseFailure; },
        }),
        end: async () => { throw endFailure; },
      }),
      providerClient: { loadShipmentContents: vi.fn() },
      loadCandidates: async () => { throw databaseFailure; },
      audit,
    });

    await expect(promise).rejects.toMatchObject({
      code: "HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_EXECUTION_AND_CLEANUP_FAILED",
    });
    await promise.catch((error: unknown) => {
      const cause = (error as Error & { cause: AggregateError }).cause;
      expect(cause.errors).toEqual([databaseFailure, releaseFailure, endFailure]);
    });
    expect(audit).not.toHaveBeenCalled();
  });
});
