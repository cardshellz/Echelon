import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "@shared/utils/canonical-json";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";

import { verifiedPostgresPoolConfig } from "../../../infrastructure/verified-postgres-pool-config";
import {
  SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL,
  SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL,
  type ShipmentLifecycleShadowAuditBatch,
} from "../../../modules/shipping/shipment-lifecycle-shadow-audit.repository";
import {
  ShipmentLifecycleShadowAuditJobError,
  assertShipmentLifecycleShadowEnabled,
  parseShipmentLifecycleShadowAuditCliOptions,
  runShipmentLifecycleShadowAuditJob,
  shipmentLifecycleShadowAuditConnectionString,
  shipmentLifecycleShadowAuditPoolConfig,
  summarizeShipmentLifecycleShadowAuditBatch,
} from "../../shipment-lifecycle-shadow-audit.job";

const SNAPSHOT_AT = "2026-08-21T12:00:00.000Z";
const LOCAL_URL = "postgresql://audit:test-password@localhost/echelon";
const REMOTE_URL = "postgresql://audit:test-password@db.example.com:5432/echelon";
const ENHANCED_CERT_URL = REMOTE_URL
  + "?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Fcerts%2Fca-certificates.crt";

function authoritativePayload(providerLabelId: string, trackingNumber: string) {
  return {
    payloadSchemaVersion: 2,
    providerLabelId,
    trackingNumber,
    observationSource: "shipstation_shipment_observation",
    sourceObservationHash: "f".repeat(64),
    createDate: null,
    shipDate: null,
    voidDate: null,
    isReturnLabel: false,
    declaredContentsEvidence: {
      evidenceSchemaVersion: 1,
      status: "authoritative",
      providerItemCount: 1,
      recognizedProviderItemCount: 1,
      canonicalLineCount: 1,
      malformedItemCount: 0,
      unrecognizedItemCount: 0,
      duplicateLineItemCount: 0,
      rejectedItemCount: 0,
      reviewRequired: false,
      lines: [{ lineItemKey: "wms-item-987", quantity: 2 }],
    },
  };
}

function persistedEventHash(
  sanitizedPayload: Record<string, unknown>,
  labelStatus: string,
): string {
  return createHash("sha256")
    .update(canonicalJson({ provider: "shipstation", ...sanitizedPayload, labelStatus }))
    .digest("hex");
}

function auditBatch(): ShipmentLifecycleShadowAuditBatch {
  const providerLabelId = "PROVIDER-LABEL-MUST-NOT-LEAK";
  const trackingNumber = "TRACKING-MUST-NOT-LEAK";
  const labelPayload = authoritativePayload(providerLabelId, trackingNumber);
  return {
    snapshotAt: SNAPSHOT_AT,
    labelLimit: 100,
    batchLimitReached: false,
    nextCursor: null,
    selectedEventPayloadBytes: 600,
    maxEventPayloadBytes: 600,
    databaseTemporaryPrivilege: true,
    labels: [
      {
        shippingProviderLabelId: "10",
        provider: "shipstation",
        providerLabelId,
        trackingNumber,
        labelStatus: "active",
        labelDirection: "outbound",
        firstObservedAt: "2026-08-21T10:00:00.000Z",
        lastObservedAt: "2026-08-21T10:00:00.000Z",
        labelEventCount: 1,
        labelEventPayloadBytes: 600,
        maxEventPayloadBytes: 600,
      },
      {
        shippingProviderLabelId: "11",
        provider: "shipstation",
        providerLabelId: "RETURN-PROVIDER-LABEL-MUST-NOT-LEAK",
        trackingNumber: "RETURN-TRACKING-MUST-NOT-LEAK",
        labelStatus: "active",
        labelDirection: "return",
        firstObservedAt: "2026-08-21T10:00:00.000Z",
        lastObservedAt: "2026-08-21T10:00:00.000Z",
        labelEventCount: 0,
        labelEventPayloadBytes: 0,
        maxEventPayloadBytes: 0,
      },
    ],
    labelEvents: [{
      labelEventId: "20",
      shippingProviderLabelId: "10",
      eventHash: persistedEventHash(labelPayload, "active"),
      eventType: "label_observed",
      labelStatus: "active",
      trackingNumber,
      providerOccurredAt: null,
      receivedAt: "2026-08-21T10:00:00.000Z",
      sanitizedPayload: labelPayload,
    }],
    currentCarrierMatches: [{
      matchAttemptId: "30",
      shippingProviderLabelId: "10",
      carrierTrackingEventId: "40",
      matchStatus: "matched",
      dispatchEvidence: "confirmed",
      eventOccurredAt: "2026-08-21T11:00:00.000Z",
      receivedAt: "2026-08-21T11:01:00.000Z",
    }],
  };
}

function readOnlyRoleRow() {
  return {
    transaction_read_only: "on",
    missing_required_select_count: "0",
    required_rls_count: "0",
    missing_required_schema_usage_count: "0",
    mutable_table_count: "0",
    mutable_column_relation_count: "0",
    mutable_sequence_count: "0",
    mutable_schema_count: "0",
    sequence_usage_count: "0",
    mutable_database: false,
    database_temporary_privilege: true,
    other_role_membership_count: "0",
    elevated_role: false,
  };
}

describe("shipment lifecycle read-only shadow job", () => {
  it.each([undefined, "", "false", "TRUE", " true "])(
    "fails closed when the shadow flag is %#",
    (flag) => {
      const environment: NodeJS.ProcessEnv = {
        WMS_INTEGRITY_AUDIT_DATABASE_URL: LOCAL_URL,
      };
      if (flag !== undefined) environment.SHIPMENT_LIFECYCLE_SHADOW_ENABLED = flag;
      expect(() => assertShipmentLifecycleShadowEnabled(environment)).toThrow(
        "must be exactly 'true'",
      );
    },
  );

  it("never falls back to the application database credential", () => {
    const environment: NodeJS.ProcessEnv = {
      SHIPMENT_LIFECYCLE_SHADOW_ENABLED: "true",
      DATABASE_URL: "postgresql://writer@localhost/echelon",
      EXTERNAL_DATABASE_URL: "postgresql://other-writer@localhost/echelon",
    };
    expect(() => shipmentLifecycleShadowAuditConnectionString(environment))
      .toThrow("WMS_INTEGRITY_AUDIT_DATABASE_URL is required");
  });

  it("pins every connection field and TLS policy instead of accepting PG environment fallback", () => {
    const config = shipmentLifecycleShadowAuditPoolConfig(REMOTE_URL);
    expect(config).toMatchObject({
      host: "db.example.com",
      port: 5_432,
      user: "audit",
      password: "test-password",
      database: "echelon",
      ssl: {
        rejectUnauthorized: true,
        servername: "db.example.com",
        minVersion: "TLSv1.2",
      },
      max: 1,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 35_000,
      query_timeout: 40_000,
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 60_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      options: "-c client_min_messages=warning",
      client_encoding: "utf8",
      replication: "false",
    });
    expect(config).not.toHaveProperty("connectionString");
    expect(shipmentLifecycleShadowAuditPoolConfig(REMOTE_URL, {
      statementTimeoutMs: 120_000,
      lockTimeoutMs: 10_000,
      idleInTransactionTimeoutMs: 300_000,
    })).toMatchObject({
      statement_timeout: 125_000,
      query_timeout: 130_000,
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 315_000,
    });
    expect(shipmentLifecycleShadowAuditPoolConfig(
      LOCAL_URL,
    ).ssl).toBe(false);
    expect(shipmentLifecycleShadowAuditPoolConfig(
      "postgresql://audit:test-password@[::1]/echelon",
    )).toMatchObject({ host: "::1", ssl: false });

    vi.stubEnv("PGHOST", "override.example.com");
    vi.stubEnv("PGPORT", "6543");
    vi.stubEnv("PGUSER", "override-user");
    vi.stubEnv("PGPASSWORD", "override-password");
    vi.stubEnv("PGDATABASE", "override-database");
    vi.stubEnv("PGOPTIONS", "-c default_transaction_read_only=off");
    vi.stubEnv("PGCLIENTENCODING", "SQL_ASCII");
    vi.stubEnv("PGREPLICATION", "database");
    vi.stubEnv("PGCONNECT_TIMEOUT", "99");
    vi.stubEnv("PGAPPNAME", "override-app");
    vi.stubEnv("PGSSLMODE", "no-verify");
    try {
      const client = new Client(config);
      const parameters = (client as unknown as {
        connectionParameters: {
          host: string;
          port: number;
          user: string;
          password: string;
          database: string;
          options: string;
          client_encoding: string;
          replication: string;
          connect_timeout: number;
          application_name: string;
          ssl: unknown;
          statement_timeout: number;
          query_timeout: number;
          lock_timeout: number;
          idle_in_transaction_session_timeout: number;
        };
      }).connectionParameters;
      expect(parameters).toMatchObject({
        host: "db.example.com",
        port: 5_432,
        user: "audit",
        password: "test-password",
        database: "echelon",
        options: "-c client_min_messages=warning",
        client_encoding: "utf8",
        replication: "false",
        connect_timeout: 10,
        application_name: "shipment-lifecycle-read-only-shadow",
        ssl: expect.objectContaining({ rejectUnauthorized: true }),
        statement_timeout: 35_000,
        query_timeout: 40_000,
        lock_timeout: 10_000,
        idle_in_transaction_session_timeout: 60_000,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("loads the approved Enhanced Certificates CA and never forwards URL query controls", () => {
    const readTextFile = vi.fn(() => "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n");
    const config = verifiedPostgresPoolConfig({
      connectionString: ENHANCED_CERT_URL,
      applicationName: "test-shadow",
      max: 1,
    }, { readTextFile });

    expect(readTextFile).toHaveBeenCalledExactlyOnceWith(
      "/etc/ssl/certs/ca-certificates.crt",
    );
    expect(config).toMatchObject({
      host: "db.example.com",
      port: 5_432,
      user: "audit",
      password: "test-password",
      database: "echelon",
      ssl: {
        rejectUnauthorized: true,
        servername: "db.example.com",
        minVersion: "TLSv1.2",
        ca: expect.stringContaining("BEGIN CERTIFICATE"),
      },
    });
    expect(config).not.toHaveProperty("connectionString");
  });

  it("rejects incomplete endpoints, query overrides, and unproven CA sources", () => {
    for (const url of [
      "postgresql:///echelon",
      "postgresql://:test-password@db.example.com:5432/echelon",
      "postgresql://audit@db.example.com:5432/echelon",
      "postgresql://audit@localhost/echelon",
      "postgresql://audit:test-password@db.example.com:5432/",
    ]) {
      expect(() => shipmentLifecycleShadowAuditPoolConfig(url)).toThrow();
    }
    for (const query of [
      "sslmode=no-verify",
      "ssl=false",
      "SSLROOTCERT=ignored.pem",
      "uselibpqcompat=true",
      "host=override.example.com",
      "port=6432",
      "sslmode=verify-full&sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Fcerts%2Fca-certificates.crt",
      "sslmode=verify-full&sslrootcert=system",
      "sslmode=verify-full&sslrootcert=%2Ftmp%2Funreviewed.pem",
    ]) {
      expect(() => shipmentLifecycleShadowAuditPoolConfig(`${REMOTE_URL}?${query}`)).toThrow();
    }
    expect(() => verifiedPostgresPoolConfig({
      connectionString: ENHANCED_CERT_URL,
      applicationName: "test-shadow",
      max: 1,
    }, { readTextFile: () => { throw new Error("missing"); } })).toThrow(
      "system CA bundle could not be read",
    );
    expect(() => verifiedPostgresPoolConfig({
      connectionString: ENHANCED_CERT_URL,
      applicationName: "test-shadow",
      max: 1,
    }, { readTextFile: () => "   " })).toThrow("must not be empty");
  });

  it("does not create a pool when the feature flag is not exactly enabled", async () => {
    const poolFactory = vi.fn();

    await expect(runShipmentLifecycleShadowAuditJob({
      environment: {
        SHIPMENT_LIFECYCLE_SHADOW_ENABLED: "TRUE",
        WMS_INTEGRITY_AUDIT_DATABASE_URL: LOCAL_URL,
      },
      poolFactory,
    })).rejects.toThrow("must be exactly 'true'");

    expect(poolFactory).not.toHaveBeenCalled();
  });

  it("validates repository limits before creating a pool", async () => {
    const poolFactory = vi.fn();
    await expect(runShipmentLifecycleShadowAuditJob({
      environment: {
        SHIPMENT_LIFECYCLE_SHADOW_ENABLED: "true",
        WMS_INTEGRITY_AUDIT_DATABASE_URL: LOCAL_URL,
      },
      repositoryOptions: { labelLimit: 0 },
      poolFactory,
    })).rejects.toThrow("labelLimit");
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it("projects all directions but exposes only bounded aggregate lifecycle counts", () => {
    const result = summarizeShipmentLifecycleShadowAuditBatch(auditBatch());

    expect(result).toMatchObject({
      contractVersion: 1,
      mode: "read_only_shadow",
      packageCount: 2,
      projectedCount: 1,
      rejectedCount: 1,
      nextPageAvailable: false,
      labelEventCount: 1,
      selectedEventPayloadBytes: 600,
      maxEventPayloadBytes: 600,
      databaseTemporaryPrivilege: true,
      currentConfirmedCarrierEvidenceCount: 1,
      rejectionReasonCounts: { non_outbound_label: 1 },
      evidenceCoverageCounts: { current_flow: 1 },
      carrierStatusCounts: { possession_confirmed: 1 },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /PROVIDER-LABEL-MUST-NOT-LEAK|TRACKING-MUST-NOT-LEAK|wms-item-987/,
    );
    expect(result).not.toHaveProperty("readOnlyRoleVerified");
    expect(serialized).not.toContain('"shippingProviderLabelId"');
    expect(serialized).not.toContain('"providerPhysicalShipmentId"');
    expect(serialized).not.toContain('"nextCursor"');
    expect(serialized).not.toContain('"beforeLabelId"');
  });

  it("rejects bigint identities that cannot be converted without precision loss", () => {
    const batch = auditBatch();
    const unsafeIdentity = "9007199254740992";
    const unsafe: ShipmentLifecycleShadowAuditBatch = {
      ...batch,
      labels: [{ ...batch.labels[0], shippingProviderLabelId: unsafeIdentity }],
      labelEvents: [],
      currentCarrierMatches: [],
    };

    try {
      summarizeShipmentLifecycleShadowAuditBatch(unsafe);
      throw new Error("Expected unsafe bigint conversion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("safe integer range");
      expect((error as Error).message).not.toContain(unsafeIdentity);
    }
  });

  it("uses only the audit credential, reports sampled runtime bounds, and releases the pool", async () => {
    const query = vi.fn(async (text: string) => {
      if (text === SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL) {
        return { rows: [readOnlyRoleRow()] };
      }
      if (text.includes("transaction_timestamp()")) {
        return { rows: [{ snapshot_at: SNAPSHOT_AT }] };
      }
      if (text === SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL) return { rows: [] };
      return { rows: [] };
    });
    const release = vi.fn();
    const end = vi.fn().mockResolvedValue(undefined);
    const poolFactory = vi.fn(() => ({
      connect: vi.fn().mockResolvedValue({ query, release }),
      end,
    }));
    const nowMs = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(5)
      .mockReturnValueOnce(15)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(35)
      .mockReturnValueOnce(40)
      .mockReturnValueOnce(70)
      .mockReturnValueOnce(80)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(110)
      .mockReturnValueOnce(140)
      .mockReturnValueOnce(150);
    const rssBytes = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_200)
      .mockReturnValueOnce(1_100)
      .mockReturnValueOnce(900);

    const result = await runShipmentLifecycleShadowAuditJob({
      environment: {
        SHIPMENT_LIFECYCLE_SHADOW_ENABLED: "true",
        WMS_INTEGRITY_AUDIT_DATABASE_URL: LOCAL_URL,
        DATABASE_URL: "postgresql://writer@localhost/echelon",
      },
      poolFactory,
      runtime: { nowMs, rssBytes },
    });

    expect(result).toMatchObject({
      packageCount: 0,
      readOnlyRoleVerified: true,
      setupDurationMs: 10,
      connectDurationMs: 15,
      repositoryDurationMs: 30,
      projectionDurationMs: 20,
      cleanupDurationMs: 30,
      totalDurationMs: 150,
      rssBeforeBytes: 1_000,
      rssAfterLoadBytes: 1_200,
      rssAfterProjectionBytes: 1_100,
      rssAfterCleanupBytes: 900,
      observedMaxRssBytes: 1_200,
      nextPageAvailable: false,
      selectedEventPayloadBytes: 0,
      maxEventPayloadBytes: 0,
      databaseTemporaryPrivilege: true,
    });
    expect(poolFactory).toHaveBeenCalledWith(expect.objectContaining({
      host: "localhost",
      port: 5_432,
      user: "audit",
      password: "test-password",
      database: "echelon",
      ssl: false,
      max: 1,
      application_name: "shipment-lifecycle-read-only-shadow",
      connectionTimeoutMillis: 10_000,
      statement_timeout: 35_000,
      query_timeout: 40_000,
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 60_000,
    }));
    expect(poolFactory.mock.calls[0][0]).not.toHaveProperty("connectionString");
    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("rethrows the original execution failure after successful cleanup", async () => {
    const primaryFailure = new Error("primary query failure");
    const query = vi.fn().mockRejectedValueOnce(primaryFailure);
    const release = vi.fn();
    const end = vi.fn().mockResolvedValue(undefined);
    const poolFactory = vi.fn(() => ({
      connect: vi.fn().mockResolvedValue({ query, release }),
      end,
    }));

    await expect(runShipmentLifecycleShadowAuditJob({
      environment: {
        SHIPMENT_LIFECYCLE_SHADOW_ENABLED: "true",
        WMS_INTEGRITY_AUDIT_DATABASE_URL: LOCAL_URL,
      },
      poolFactory,
    })).rejects.toBe(primaryFailure);

    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("preserves execution, release, and pool shutdown failures together", async () => {
    const primaryFailure = new Error("primary query failure");
    const releaseFailure = new Error("release failure");
    const shutdownFailure = new Error("pool shutdown failure");
    const query = vi.fn().mockRejectedValueOnce(primaryFailure);
    const release = vi.fn(() => {
      throw releaseFailure;
    });
    const end = vi.fn().mockRejectedValue(shutdownFailure);
    const poolFactory = vi.fn(() => ({
      connect: vi.fn().mockResolvedValue({ query, release }),
      end,
    }));

    try {
      await runShipmentLifecycleShadowAuditJob({
        environment: {
          SHIPMENT_LIFECYCLE_SHADOW_ENABLED: "true",
          WMS_INTEGRITY_AUDIT_DATABASE_URL: LOCAL_URL,
        },
        poolFactory,
      });
      throw new Error("Expected combined execution and cleanup failure");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ShipmentLifecycleShadowAuditJobError);
      const jobError = error as ShipmentLifecycleShadowAuditJobError;
      expect(jobError.code).toBe(
        "SHIPMENT_LIFECYCLE_SHADOW_EXECUTION_AND_CLEANUP_FAILED",
      );
      expect(jobError.cause).toBeInstanceOf(AggregateError);
      expect((jobError.cause as AggregateError).errors).toEqual([
        primaryFailure,
        releaseFailure,
        shutdownFailure,
      ]);
    }

    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("reports cleanup failure after a successful read and still attempts pool shutdown", async () => {
    const query = vi.fn(async (text: string) => {
      if (text === SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL) {
        return { rows: [readOnlyRoleRow()] };
      }
      if (text.includes("transaction_timestamp()")) {
        return { rows: [{ snapshot_at: SNAPSHOT_AT }] };
      }
      if (text === SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL) return { rows: [] };
      return { rows: [] };
    });
    const releaseFailure = new Error("release failure");
    const shutdownFailure = new Error("pool shutdown failure");
    const release = vi.fn(() => {
      throw releaseFailure;
    });
    const end = vi.fn().mockRejectedValue(shutdownFailure);
    const poolFactory = vi.fn(() => ({
      connect: vi.fn().mockResolvedValue({ query, release }),
      end,
    }));

    try {
      await runShipmentLifecycleShadowAuditJob({
        environment: {
          SHIPMENT_LIFECYCLE_SHADOW_ENABLED: "true",
          WMS_INTEGRITY_AUDIT_DATABASE_URL: LOCAL_URL,
        },
        poolFactory,
      });
      throw new Error("Expected cleanup failure");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ShipmentLifecycleShadowAuditJobError);
      const jobError = error as ShipmentLifecycleShadowAuditJobError;
      expect(jobError.code).toBe("SHIPMENT_LIFECYCLE_SHADOW_CLEANUP_FAILED");
      expect(jobError.cause).toBeInstanceOf(AggregateError);
      expect((jobError.cause as AggregateError).errors).toEqual([
        releaseFailure,
        shutdownFailure,
      ]);
    }

    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("parses only the bounded one-page CLI controls and rejects ambiguous input", () => {
    const parsed = parseShipmentLifecycleShadowAuditCliOptions([
      "--label-limit=10",
      "--max-event-payload-bytes=1000",
      "--max-page-payload-bytes=2000",
    ]);
    expect(parsed).toMatchObject({
      help: false,
      repositoryOptions: {
        labelLimit: 10,
        maxEventPayloadBytes: 1_000,
        maxPagePayloadBytes: 2_000,
      },
    });
    expect(() => parseShipmentLifecycleShadowAuditCliOptions(["--label-limit=0"]))
      .toThrow("positive decimal integer");
    expect(() => parseShipmentLifecycleShadowAuditCliOptions([
      "--label-limit=10",
      "--label-limit=11",
    ])).toThrow("Duplicate flag");
    expect(() => parseShipmentLifecycleShadowAuditCliOptions(["--cursor=secret-id"]))
      .toThrow("Unknown flag");
    expect(() => parseShipmentLifecycleShadowAuditCliOptions([
      "--max-event-payload-bytes=2000",
      "--max-page-payload-bytes=1000",
    ])).toThrow("must not exceed");
  });

  it("has no imports capable of provider calls or downstream effects", () => {
    const root = process.cwd();
    const files = [
      join(root, "server", "jobs", "shipment-lifecycle-shadow-audit.job.ts"),
      join(root, "server", "modules", "shipping", "shipment-lifecycle-shadow-audit.repository.ts"),
      join(root, "server", "modules", "shipping", "declared-package-lifecycle-shadow.domain.ts"),
    ];
    const importTargets = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    });

    expect(importTargets).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/shipstation\.service|fulfillment|channel|notification|server\/db|\/db$/i),
    ]));
    const jobSource = readFileSync(files[0], "utf8");
    expect(jobSource).not.toMatch(/(?:process\.env|environment)\.(?:DATABASE_URL|EXTERNAL_DATABASE_URL)/);
  });

  it("exposes the isolated package command", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(packageJson.scripts["wms:audit-shipment-lifecycle-shadow"])
      .toBe("tsx server/jobs/shipment-lifecycle-shadow-audit.job.ts");
  });
});
