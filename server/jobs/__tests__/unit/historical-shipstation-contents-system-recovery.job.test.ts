import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { HistoricalShipStationContentsAuditJobResult } from "../../historical-shipstation-contents-audit.job";
import {
  assertHistoricalShipStationContentsSystemRecoveryEnabled,
  historicalShipStationContentsSystemRecoveryConnectionString,
  historicalShipStationContentsSystemRecoveryPoolConfig,
  historicalShipStationContentsSystemRecoveryPreviewToken,
  parseHistoricalShipStationContentsSystemRecoveryCliOptions,
  runHistoricalShipStationContentsSystemRecoveryJob,
} from "../../historical-shipstation-contents-system-recovery.job";
import { HistoricalShipStationContentsSystemRecoveryServiceError } from "../../../modules/shipping/historical-shipstation-contents-system-recovery.service";

const providerClient = { loadShipmentContents: vi.fn() };
const recoveryEnvironment = {
  HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_ENABLED: "true",
  HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_ENABLED: "true",
  HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_DATABASE_URL:
    "postgresql://recovery:test-password@localhost/echelon",
};

function recoverableCase(
  shippingProviderLabelId: string,
  evidenceCharacter: string,
) {
  return Object.freeze({
    shippingProviderLabelId,
    recoveryStatus: "provider_line_keys_authoritative" as const,
    providerContentsStatus: "authoritative" as const,
    providerItemCount: 1,
    canonicalLineCount: 1,
    attestedLineCount: 1,
    expectedContents: {
      kind: "available" as const,
      source: "physical_shipment" as const,
      lineCount: 1,
    },
    contractVersion: 1 as const,
    evidenceHash: evidenceCharacter.repeat(64),
  });
}

function report(
  recoverableCases = [recoverableCase("101", "a")],
): HistoricalShipStationContentsAuditJobResult {
  return Object.freeze({
    mode: "read_only_historical_shipstation_contents_audit" as const,
    candidateLimit: 10,
    beforeLabelId: null,
    nextBeforeLabelId: null,
    batchLimitReached: false,
    selectedCandidateCount: recoverableCases.length,
    providerRequestCount: recoverableCases.length,
    providerShipmentFoundCount: recoverableCases.length,
    providerShipmentNotFoundCount: 0,
    providerRequestFailureCount: 0,
    contentsStatusCounts: {
      authoritative: recoverableCases.length,
      omitted: 0,
      empty: 0,
      unrecognized: 0,
      malformed: 0,
      mixed: 0,
    },
    recoveryStatusCounts: {
      provider_line_keys_authoritative: recoverableCases.length,
      exact_unique_wms_match: 0,
      provider_empty: 0,
      provider_evidence_unavailable: 0,
      wms_lineage_unavailable: 0,
      ambiguous_wms_match: 0,
      provider_wms_conflict: 0,
    },
    providerAuthoritativeCount: recoverableCases.length,
    recoverableProviderEvidenceCount: recoverableCases.length,
    recoverableCases,
    reviewRequiredByCurrentEvidenceCount: 0,
    reviewCases: [],
    requiresLeadAttestationCount: 0,
    safeToAutoResolveCount: recoverableCases.length,
    databaseTemporaryPrivilege: false,
    setupDurationMs: 1,
    databaseReadDurationMs: 2,
    providerAuditDurationMs: 3,
    totalDurationMs: 6,
  });
}

describe("historical ShipStation contents system recovery job", () => {
  it("defaults to a bounded preview and requires an exact preview token for apply", () => {
    expect(parseHistoricalShipStationContentsSystemRecoveryCliOptions([])).toEqual({
      help: false,
      mode: "preview",
      candidateLimit: 10,
      beforeLabelId: null,
      previewToken: null,
    });
    expect(parseHistoricalShipStationContentsSystemRecoveryCliOptions([
      "--apply",
      `--preview-token=${"a".repeat(64)}`,
      "--limit=25",
      "--before-label-id=9223372036854775807",
    ])).toEqual({
      help: false,
      mode: "apply",
      candidateLimit: 25,
      beforeLabelId: "9223372036854775807",
      previewToken: "a".repeat(64),
    });
    expect(() => parseHistoricalShipStationContentsSystemRecoveryCliOptions(["--apply"]))
      .toThrow(/requires --preview-token/);
    expect(() => parseHistoricalShipStationContentsSystemRecoveryCliOptions([
      `--preview-token=${"a".repeat(64)}`,
    ])).toThrow(/only with --apply/);
    expect(() => parseHistoricalShipStationContentsSystemRecoveryCliOptions(["--limit=26"]))
      .toThrow(/must not exceed 25/);
    expect(() => parseHistoricalShipStationContentsSystemRecoveryCliOptions(["--execute"]))
      .toThrow(/Unknown flag/);
  });

  it("requires the exact write gate and never falls back to application database URLs", () => {
    expect(() => assertHistoricalShipStationContentsSystemRecoveryEnabled({})).toThrow(
      /exactly 'true'/,
    );
    expect(() => assertHistoricalShipStationContentsSystemRecoveryEnabled({
      HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_ENABLED: "TRUE",
    })).toThrow(/exactly 'true'/);
    expect(() => assertHistoricalShipStationContentsSystemRecoveryEnabled(recoveryEnvironment))
      .not.toThrow();
    expect(() => historicalShipStationContentsSystemRecoveryConnectionString({
      DATABASE_URL: "postgresql://writer:password@localhost/echelon",
      EXTERNAL_DATABASE_URL: "postgresql://writer:password@localhost/echelon",
    })).toThrow(/SYSTEM_RECOVERY_DATABASE_URL is required/);
  });

  it("pins a one-connection recovery pool with bounded session deadlines", () => {
    const config = historicalShipStationContentsSystemRecoveryPoolConfig(
      recoveryEnvironment.HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_DATABASE_URL,
    ) as Record<string, unknown>;

    expect(config).toMatchObject({
      host: "localhost",
      port: 5432,
      user: "recovery",
      password: "test-password",
      database: "echelon",
      max: 1,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      query_timeout: 35_000,
      lock_timeout: 2_000,
      idle_in_transaction_session_timeout: 45_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
    expect(config).not.toHaveProperty("connectionString");
  });

  it("builds a deterministic token over the complete sanitized preview page", () => {
    const first = report();
    const replay = report();
    const changed = report([recoverableCase("101", "b")]);

    expect(historicalShipStationContentsSystemRecoveryPreviewToken(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(historicalShipStationContentsSystemRecoveryPreviewToken(replay))
      .toBe(historicalShipStationContentsSystemRecoveryPreviewToken(first));
    expect(historicalShipStationContentsSystemRecoveryPreviewToken(changed))
      .not.toBe(historicalShipStationContentsSystemRecoveryPreviewToken(first));
  });

  it("previews without creating a write pool or invoking recovery", async () => {
    const audit = report();
    const auditJob = vi.fn(async () => audit);
    const poolFactory = vi.fn();
    const serviceFactory = vi.fn();
    const times = [0, 1, 4, 5, 9, 10];

    const result = await runHistoricalShipStationContentsSystemRecoveryJob({
      environment: { HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_ENABLED: "true" },
      providerClient,
      auditJob,
      poolFactory,
      serviceFactory,
      runtime: { nowMs: () => times.shift()! },
    });

    expect(result).toMatchObject({
      mode: "preview_historical_shipstation_contents_system_recovery",
      previewContractVersion: 1,
      audit,
      attemptedRecoveryCount: 0,
      createdRecoveryCount: 0,
      alreadyPersistedRecoveryCount: 0,
      failedRecoveryCount: 0,
      auditDurationMs: 3,
      recoveryDurationMs: 4,
      totalDurationMs: 10,
      outcomes: [{
        kind: "would_recover",
        shippingProviderLabelId: "101",
        previewEvidenceHash: "a".repeat(64),
      }],
    });
    expect(auditJob).toHaveBeenCalledWith(expect.objectContaining({
      candidateLimit: 10,
      beforeLabelId: undefined,
      providerClient,
    }));
    expect(poolFactory).not.toHaveBeenCalled();
    expect(serviceFactory).not.toHaveBeenCalled();
  });

  it("rejects apply before audit when the write authority is incomplete", async () => {
    const auditJob = vi.fn(async () => report());

    await expect(runHistoricalShipStationContentsSystemRecoveryJob({
      mode: "apply",
      previewToken: "a".repeat(64),
      environment: {
        HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_ENABLED: "true",
        DATABASE_URL: "postgresql://writer:password@localhost/echelon",
      },
      providerClient,
      auditJob,
    })).rejects.toThrow(/SYSTEM_RECOVERY_ENABLED/);
    expect(auditJob).not.toHaveBeenCalled();
  });

  it("rejects a changed preview before creating the write pool", async () => {
    const original = report();
    const changed = report([recoverableCase("101", "b")]);
    const poolFactory = vi.fn();

    await expect(runHistoricalShipStationContentsSystemRecoveryJob({
      mode: "apply",
      previewToken: historicalShipStationContentsSystemRecoveryPreviewToken(original),
      environment: recoveryEnvironment,
      providerClient,
      auditJob: vi.fn(async () => changed),
      poolFactory,
    })).rejects.toMatchObject({ code: "PREVIEW_TOKEN_MISMATCH" });
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it("applies the exact preview sequentially and reports every per-label outcome", async () => {
    const audit = report([
      recoverableCase("103", "a"),
      recoverableCase("102", "b"),
      recoverableCase("101", "c"),
    ]);
    const end = vi.fn(async () => undefined);
    const pool = { end } as unknown as Pool;
    const poolFactory = vi.fn(() => pool);
    const recover = vi.fn()
      .mockResolvedValueOnce({
        kind: "created",
        shippingProviderLabelId: "103",
        labelEventId: "9001",
        eventHash: "d".repeat(64),
      })
      .mockResolvedValueOnce({
        kind: "already_persisted",
        shippingProviderLabelId: "102",
        labelEventId: "9002",
        eventHash: "e".repeat(64),
      })
      .mockRejectedValueOnce(new HistoricalShipStationContentsSystemRecoveryServiceError(
        "CANDIDATE_CHANGED",
        "candidate changed",
      ));
    const serviceFactory = vi.fn(() => ({ recover }));

    const result = await runHistoricalShipStationContentsSystemRecoveryJob({
      mode: "apply",
      previewToken: historicalShipStationContentsSystemRecoveryPreviewToken(audit),
      environment: recoveryEnvironment,
      providerClient,
      auditJob: vi.fn(async () => audit),
      poolFactory,
      serviceFactory,
    });

    expect(recover.mock.calls).toEqual([
      ["103", "a".repeat(64)],
      ["102", "b".repeat(64)],
      ["101", "c".repeat(64)],
    ]);
    expect(result).toMatchObject({
      mode: "apply_historical_shipstation_contents_system_recovery",
      attemptedRecoveryCount: 3,
      createdRecoveryCount: 1,
      alreadyPersistedRecoveryCount: 1,
      failedRecoveryCount: 1,
      outcomes: [
        { kind: "created", shippingProviderLabelId: "103", labelEventId: "9001" },
        { kind: "already_persisted", shippingProviderLabelId: "102", labelEventId: "9002" },
        { kind: "failed", shippingProviderLabelId: "101", errorCode: "CANDIDATE_CHANGED" },
      ],
    });
    expect(poolFactory).toHaveBeenCalledWith(expect.objectContaining({ max: 1 }));
    expect(serviceFactory).toHaveBeenCalledWith(pool, providerClient);
    expect(end).toHaveBeenCalledOnce();
  });

  it("surfaces write-pool cleanup failures after successful recovery", async () => {
    const audit = report();
    const cleanupFailure = new Error("pool cleanup failed");
    const pool = { end: vi.fn(async () => { throw cleanupFailure; }) } as unknown as Pool;

    await expect(runHistoricalShipStationContentsSystemRecoveryJob({
      mode: "apply",
      previewToken: historicalShipStationContentsSystemRecoveryPreviewToken(audit),
      environment: recoveryEnvironment,
      providerClient,
      auditJob: vi.fn(async () => audit),
      poolFactory: () => pool,
      serviceFactory: () => ({
        recover: vi.fn(async () => ({
          kind: "created" as const,
          shippingProviderLabelId: "101",
          labelEventId: "9001",
          eventHash: "d".repeat(64),
        })),
      }),
    })).rejects.toMatchObject({
      code: "HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_CLEANUP_FAILED",
      cause: cleanupFailure,
    });
  });
});
