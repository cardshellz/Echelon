import { describe, expect, it } from "vitest";

import { requiredWmsIntegrityAuditRelations } from "../audit-wms-inventory-integrity";
import {
  auditCredentialPoolConfig,
  buildAuditCredentialConfigurationPlan,
  parseCredentialFlags,
  requiredWmsIntegrityAuditCredentialRelations,
} from "../configure-wms-integrity-audit-credential";
import {
  SHIPMENT_LIFECYCLE_SHADOW_REQUIRED_RELATIONS,
} from "../../server/modules/shipping/shipment-lifecycle-shadow-audit.repository";

const REMOTE_URL = "postgresql://audit:test-password@db.example.com:5432/echelon";

describe("shipment lifecycle shadow audit credential configuration", () => {
  it("pins the non-local endpoint and requires certificate verification", () => {
    expect(auditCredentialPoolConfig(REMOTE_URL)).toMatchObject({
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
    });
    expect(auditCredentialPoolConfig(
      "postgresql://audit:test-password@localhost/echelon",
    ).ssl)
      .toBe(false);
    expect(() => auditCredentialPoolConfig(
      `${REMOTE_URL}?sslmode=no-verify`,
    )).toThrow("exact enhanced-certificate pair");
  });

  it("keeps dry-run as the default and requires explicit execute", () => {
    expect(parseCredentialFlags([
      "--dry-run",
      "--credential=wms_integrity_auditor",
    ])).toEqual({
      help: false,
      execute: false,
      credential: "wms_integrity_auditor",
    });
  });

  it("exposes the exact shipment lifecycle shadow relation contract", () => {
    expect(SHIPMENT_LIFECYCLE_SHADOW_REQUIRED_RELATIONS).toEqual([
      "wms.carrier_tracking_event_matches",
      "wms.carrier_tracking_events",
      "wms.carrier_tracking_reconciliation_state",
      "wms.shipping_provider_label_events",
      "wms.shipping_provider_labels",
    ]);
  });

  it("builds a deterministic least-privilege plan without executing a grant", () => {
    const plan = buildAuditCredentialConfigurationPlan("wms_integrity_auditor");
    const expectedRelations = [...new Set([
      ...requiredWmsIntegrityAuditRelations(),
      ...SHIPMENT_LIFECYCLE_SHADOW_REQUIRED_RELATIONS,
    ])].sort();

    expect(requiredWmsIntegrityAuditCredentialRelations()).toEqual(expectedRelations);
    expect(plan).toMatchObject({
      credential: "wms_integrity_auditor",
      relations: expectedRelations,
    });
    const schemaCount = new Set(expectedRelations.map((relation) => relation.split(".")[0])).size;
    expect(plan.statements).toHaveLength((schemaCount * 4) + 1);

    const statements = plan.statements.join(";\n");
    for (const relation of SHIPMENT_LIFECYCLE_SHADOW_REQUIRED_RELATIONS) {
      const [schema, table] = relation.split(".");
      expect(statements).toContain(`"${schema}"."${table}"`);
    }
    expect(statements).toContain("GRANT SELECT ON");
    expect(statements).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE");
    expect(statements).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE)/i);
  });
});
