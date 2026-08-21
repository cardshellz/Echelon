import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "@shared/utils/canonical-json";
import { describe, expect, it, vi } from "vitest";

import {
  SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL,
  SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL,
  type ShipmentLifecycleShadowAuditBatch,
} from "../../../modules/shipping/shipment-lifecycle-shadow-audit.repository";
import {
  assertShipmentLifecycleShadowEnabled,
  runShipmentLifecycleShadowAuditJob,
  shipmentLifecycleShadowAuditConnectionString,
  shipmentLifecycleShadowAuditPoolConfig,
  summarizeShipmentLifecycleShadowAuditBatch,
} from "../../shipment-lifecycle-shadow-audit.job";

const SNAPSHOT_AT = "2026-08-21T12:00:00.000Z";

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

describe("shipment lifecycle read-only shadow job", () => {
  it.each([undefined, "", "false", "TRUE", " true "])(
    "fails closed when the shadow flag is %#",
    (flag) => {
      const environment: NodeJS.ProcessEnv = {
        WMS_INTEGRITY_AUDIT_DATABASE_URL: "postgresql://audit@localhost/echelon",
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

  it("requires certificate verification for non-local audit databases", () => {
    expect(shipmentLifecycleShadowAuditPoolConfig(
      "postgresql://audit@db.example.com/echelon",
    )).toMatchObject({
      ssl: { rejectUnauthorized: true },
    });
    expect(shipmentLifecycleShadowAuditPoolConfig(
      "postgresql://localhost@db.example.com/echelon",
    )).toMatchObject({
      ssl: { rejectUnauthorized: true },
    });
    expect(shipmentLifecycleShadowAuditPoolConfig(
      "postgresql://audit@localhost/echelon",
    ).ssl).toBeUndefined();
    for (const query of [
      "sslmode=no-verify",
      "ssl=false",
      "SSLROOTCERT=ignored.pem",
      "uselibpqcompat=true",
      "host=db.example.com",
      "port=6432",
    ]) {
      expect(() => shipmentLifecycleShadowAuditPoolConfig(
        `postgresql://audit@db.example.com/echelon?${query}`,
      )).toThrow("must not contain query parameters");
    }
  });


  it("does not create a pool when the feature flag is not exactly enabled", async () => {
    const poolFactory = vi.fn();

    await expect(runShipmentLifecycleShadowAuditJob({
      environment: {
        SHIPMENT_LIFECYCLE_SHADOW_ENABLED: "TRUE",
        WMS_INTEGRITY_AUDIT_DATABASE_URL: "postgresql://audit@localhost/echelon",
      },
      poolFactory,
    })).rejects.toThrow("must be exactly 'true'");

    expect(poolFactory).not.toHaveBeenCalled();
  });

  it("projects all directions but exposes only aggregate lifecycle counts", () => {
    const result = summarizeShipmentLifecycleShadowAuditBatch(auditBatch());

    expect(result).toMatchObject({
      contractVersion: 1,
      mode: "read_only_shadow",
      packageCount: 2,
      projectedCount: 1,
      rejectedCount: 1,
      labelEventCount: 1,
      currentConfirmedCarrierEvidenceCount: 1,
      rejectionReasonCounts: {
        non_outbound_label: 1,
      },
      evidenceCoverageCounts: {
        current_flow: 1,
      },
      carrierStatusCounts: {
        possession_confirmed: 1,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /PROVIDER-LABEL-MUST-NOT-LEAK|TRACKING-MUST-NOT-LEAK|wms-item-987/,
    );
    expect(result).not.toHaveProperty("readOnlyRoleVerified");
    expect(serialized).not.toContain('"shippingProviderLabelId"');
    expect(serialized).not.toContain('"providerPhysicalShipmentId"');
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

  it("uses only the audit credential and releases the one-connection pool", async () => {
    const query = vi.fn(async (text: string) => {
      if (text === SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL) {
        return {
          rows: [{
            transaction_read_only: "on",
            mutable_table_count: "0",
            mutable_sequence_count: "0",
            mutable_schema_count: "0",
            sequence_usage_count: "0",
            mutable_database: false,
            elevated_role: false,
          }],
        };
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

    const result = await runShipmentLifecycleShadowAuditJob({
      environment: {
        SHIPMENT_LIFECYCLE_SHADOW_ENABLED: "true",
        WMS_INTEGRITY_AUDIT_DATABASE_URL: "postgresql://audit@localhost/echelon",
        DATABASE_URL: "postgresql://writer@localhost/echelon",
      },
      poolFactory,
    });

    expect(result.packageCount).toBe(0);
    expect(result.readOnlyRoleVerified).toBe(true);
    expect(poolFactory).toHaveBeenCalledWith(expect.objectContaining({
      connectionString: "postgresql://audit@localhost/echelon",
      max: 1,
      application_name: "shipment-lifecycle-read-only-shadow",
    }));
    expect(poolFactory.mock.calls[0][0]).not.toHaveProperty(
      "connectionString",
      "postgresql://writer@localhost/echelon",
    );
    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("has no imports capable of provider calls or downstream effects", () => {
    const root = process.cwd();
    const files = [
      join(root, "server", "jobs", "shipment-lifecycle-shadow-audit.job.ts"),
      join(
        root,
        "server",
        "modules",
        "shipping",
        "shipment-lifecycle-shadow-audit.repository.ts",
      ),
      join(
        root,
        "server",
        "modules",
        "shipping",
        "declared-package-lifecycle-shadow.domain.ts",
      ),
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
