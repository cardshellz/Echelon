import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseActivationFlags } from "../activate-wms-inventory-integrity-monitor";
import {
  buildAuditCredentialStatements,
  parseCredentialFlags,
} from "../configure-wms-integrity-audit-credential";
import { parseMonitorFlags } from "../run-wms-inventory-integrity-monitor";
import { requiredWmsIntegrityAuditRelations } from "../audit-wms-inventory-integrity";
import { deliverPendingIntegrityAlerts } from "../../server/modules/inventory/integrity/integrity-alert-delivery.service";
import { runInventoryIntegrityMonitorJob } from "../../server/modules/inventory/integrity/integrity-monitor.job";
import {
  formatIntegrityAlertWebhook,
  hasActionableIntegrityAlert,
  integrityAlertRetryAt,
  integrityAlertSignature,
  type IntegrityAlertPayload,
} from "../../server/modules/inventory/integrity/integrity-monitor.domain";
import {
  activateIntegrityMonitoring,
  assertIntegrityAuditRoleIsReadOnly,
  enqueueContinuousIntegrityAlert,
} from "../../server/modules/inventory/integrity/integrity-monitor.repository";

const BASELINE_RUN_ID = "11111111-1111-4111-8111-111111111111";

function payload(): IntegrityAlertPayload {
  return {
    runId: "22222222-2222-4222-8222-222222222222",
    snapshotAt: "2026-07-10T12:00:00.000Z",
    sourceVersion: "test-sha",
    blockerCount: 11,
    warningCount: 2,
    previousBlockerCount: 10,
    triggerCounts: { newBlockers: 1, worsened: 0, recurred: 0, blockerCountGrowth: 1 },
    samples: [{
      checkId: "terminal_order_open_reservation",
      severity: "blocker",
      observationKind: "new",
      entityFingerprint: "a".repeat(64),
      entityKey: { order_id: 5 },
      metricValue: "2",
    }],
  };
}

describe("WMS inventory integrity monitor", () => {
  it("parses activation and monitor flags with safe defaults", () => {
    expect(parseActivationFlags([`--baseline-run-id=${BASELINE_RUN_ID}`])).toEqual({
      help: false,
      execute: false,
      baselineRunId: BASELINE_RUN_ID,
      actor: null,
    });
    expect(parseMonitorFlags([])).toEqual({
      help: false,
      execute: false,
      statementTimeoutMs: 120_000,
    });
    expect(() => parseMonitorFlags(["--dry-run", "--execute"])).toThrow(/either/);
    expect(parseCredentialFlags(["--credential=wms_integrity_auditor"])).toEqual({
      help: false,
      execute: false,
      credential: "wms_integrity_auditor",
    });
  });

  it("derives least-privilege audit grants from every qualified check relation", () => {
    const relations = requiredWmsIntegrityAuditRelations();
    expect(relations).toHaveLength(16);
    expect(relations).toContain("inventory.inventory_levels");
    expect(relations).toContain("wms.order_items");
    expect(relations).toContain("procurement.receiving_orders");
    const statements = buildAuditCredentialStatements("wms_integrity_auditor").join(";\n");
    expect(statements).toContain("GRANT SELECT ON");
    expect(statements).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE");
    expect(statements).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE)/i);
  });

  it("builds deterministic alert signatures, bounded retries, and actionable payloads", () => {
    expect(integrityAlertSignature(payload().runId)).toMatch(/^[0-9a-f]{64}$/);
    expect(integrityAlertSignature(payload().runId)).toBe(integrityAlertSignature(payload().runId));
    expect(integrityAlertRetryAt(new Date("2026-07-10T12:00:00Z"), 1).toISOString())
      .toBe("2026-07-10T12:01:00.000Z");
    expect(integrityAlertRetryAt(new Date("2026-07-10T12:00:00Z"), 8).toISOString())
      .toBe("2026-07-10T13:00:00.000Z");
    expect(hasActionableIntegrityAlert(payload().triggerCounts)).toBe(true);
    expect(hasActionableIntegrityAlert({
      newBlockers: 0,
      worsened: 0,
      recurred: 0,
      blockerCountGrowth: 0,
    })).toBe(false);
    expect(formatIntegrityAlertWebhook(payload()).content).toContain("new blockers=1");
  });

  it("rejects an audit credential that can mutate any operational table", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ database_user: "broad_writer", mutable_table_count: 2, mutable_schema_count: 1 }],
    });
    await expect(assertIntegrityAuditRoleIsReadOnly({ query } as any)).rejects.toThrow(/read-only/);
  });

  it("accepts a credential with zero operational DML privileges", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ database_user: "audit_reader", mutable_table_count: 0, mutable_schema_count: 0 }],
    });
    await expect(assertIntegrityAuditRoleIsReadOnly({ query } as any)).resolves.toBe("audit_reader");
  });

  it("records one continuous run with injected clock, id, audit, and persistence boundaries", async () => {
    const persistRegistry = vi.fn().mockResolvedValue({
      findings: 0,
      new: 0,
      unchanged: 0,
      changed: 0,
      worsened: 0,
      improved: 0,
      recurred: 0,
      resolved: 0,
    });
    const result = await runInventoryIntegrityMonitorJob({
      auditClient: { query: vi.fn() } as any,
      registryClient: { query: vi.fn() } as any,
      statementTimeoutMs: 120_000,
      sourceVersion: "test-sha",
      clock: () => new Date("2026-07-10T12:00:00Z"),
      idGenerator: () => payload().runId,
    }, {
      assertAuditRoleIsReadOnly: vi.fn().mockResolvedValue("audit_reader"),
      runAudit: vi.fn().mockResolvedValue({
        snapshot: {
          snapshotAt: "2026-07-10T12:00:01.000Z",
          databaseName: "echelon",
          databaseUser: "audit_reader",
          serverVersion: "17.9",
          recoveryMode: false,
        },
        summary: { checks: 1, blockers: 0, warnings: 0, issueCount: 0, byCategory: {} },
        results: [{
          check: {
            id: "negative_inventory_level_bucket",
            category: "balances",
            severity: "blocker",
            description: "test",
            remediationTarget: "test",
            identityColumns: ["inventory_level_id"],
            sql: "SELECT 1 WHERE FALSE",
          },
          count: 0,
          samples: [],
          elapsedMs: 1,
        }],
      }),
      persistRegistry,
      recordFailure: vi.fn(),
    });
    expect(result.runId).toBe(payload().runId);
    expect(result.auditDatabaseUser).toBe("audit_reader");
    expect(persistRegistry.mock.calls[0][1]).toMatchObject({
      runId: payload().runId,
      scope: "continuous",
      sourceVersion: "test-sha",
    });
  });

  it("records an invalid audit-role failure before running any audit query", async () => {
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    const runAudit = vi.fn();
    await expect(runInventoryIntegrityMonitorJob({
      auditClient: { query: vi.fn() } as any,
      registryClient: { query: vi.fn() } as any,
      statementTimeoutMs: 120_000,
      sourceVersion: null,
      clock: () => new Date("2026-07-10T12:00:00Z"),
      idGenerator: () => payload().runId,
    }, {
      assertAuditRoleIsReadOnly: vi.fn().mockRejectedValue(new Error("writer role")),
      runAudit,
      persistRegistry: vi.fn(),
      recordFailure,
    })).rejects.toThrow("writer role");
    expect(runAudit).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      code: "AUDIT_ROLE_NOT_READ_ONLY",
    }));
  });

  it("activates one explicit completed all-check baseline transactionally", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (text: string) => {
      calls.push(text);
      if (text.includes("FROM inventory.integrity_audit_runs")) {
        return { rows: [{
          id: BASELINE_RUN_ID,
          scope: "all",
          status: "completed",
          snapshot_at: "2026-07-10T09:10:06.971Z",
          blocker_count: "1773",
          warning_count: "25888",
        }] };
      }
      if (text.includes("FROM inventory.integrity_monitor_state")) return { rows: [] };
      return { rows: [] };
    });
    const result = await activateIntegrityMonitoring({ query } as any, {
      baselineRunId: BASELINE_RUN_ID,
      actor: "owner@cardshellz.com",
      now: new Date("2026-07-10T10:00:00Z"),
    });
    expect(result.baselineBlockerCount).toBe(1773);
    expect(calls[0]).toBe("BEGIN");
    expect(calls.some((text) => text.includes("INSERT INTO inventory.integrity_monitor_state"))).toBe(true);
    expect(calls.at(-1)).toBe("COMMIT");
  });

  it("enqueues one durable alert for new blockers and updates monitor success atomically", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const query = vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text.includes("FOR UPDATE") && text.includes("integrity_monitor_state")) {
        return { rows: [{ baseline_run_id: BASELINE_RUN_ID }] };
      }
      if (text.includes("FROM inventory.integrity_audit_runs") && text.includes("id <>")) {
        return { rows: [{ blocker_count: "10" }] };
      }
      if (text.includes("AS new_blockers")) {
        return { rows: [{ new_blockers: 1, worsened: 2, recurred: 0 }] };
      }
      if (text.includes("FROM integrity_observed_stage") && text.includes("LIMIT $1")) {
        return { rows: [{
          check_id: "terminal_order_open_reservation",
          severity: "blocker",
          observation_kind: "new",
          entity_fingerprint: "a".repeat(64),
          entity_key: { order_id: 5 },
          metric_value: "2",
        }] };
      }
      return { rows: [] };
    });
    const enqueued = await enqueueContinuousIntegrityAlert({ query } as any, {
      runId: payload().runId,
      snapshotAt: payload().snapshotAt,
      sourceVersion: payload().sourceVersion,
      blockerCount: 11,
      warningCount: 2,
    });
    expect(enqueued).toBe(true);
    expect(calls.some((call) => call.text.includes("INSERT INTO inventory.integrity_alert_outbox"))).toBe(true);
    expect(calls.some((call) => call.text.includes("last_successful_run_id"))).toBe(true);
  });

  it("delivers a claimed alert and marks the exact lease sent", async () => {
    let claimCount = 0;
    const query = vi.fn(async (text: string) => {
      if (text.includes("WITH exhausted")) {
        claimCount += 1;
        return claimCount === 1
          ? { rows: [{
            id: 9,
            run_id: payload().runId,
            payload: payload(),
            attempt_count: 1,
            lease_owner: "worker-1",
          }] }
          : { rows: [] };
      }
      if (text.includes("status = 'sent'")) return { rows: [{ id: 9 }] };
      return { rows: [] };
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const summary = await deliverPendingIntegrityAlerts({
      client: { query } as any,
      webhookUrl: "https://alerts.example.test/wms",
      workerId: "worker-1",
      clock: () => new Date("2026-07-10T12:00:00Z"),
      fetchImpl,
    });
    expect(summary).toEqual({ claimed: 1, sent: 1, failed: 0, dead: 0 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("requeues a failed alert with durable error context", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("WITH exhausted")) {
        return { rows: [{
          id: 9,
          run_id: payload().runId,
          payload: payload(),
          attempt_count: 1,
          lease_owner: "worker-1",
        }] };
      }
      if (text.includes("status = $3")) return { rows: [{ id: 9 }] };
      return { rows: [] };
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    const summary = await deliverPendingIntegrityAlerts({
      client: { query } as any,
      webhookUrl: "https://alerts.example.test/wms",
      workerId: "worker-1",
      clock: () => new Date("2026-07-10T12:00:00Z"),
      fetchImpl,
      maxAlerts: 1,
    });
    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 1, dead: 0 });
    expect(query.mock.calls.some(([text]) => String(text).includes("next_attempt_at"))).toBe(true);
  });

  it("adds monitoring metadata without inventory quantity DML", () => {
    const migration = readFileSync(
      join(process.cwd(), "migrations", "127_inventory_integrity_monitoring.sql"),
      "utf8",
    );
    expect(migration).toContain("inventory.integrity_monitor_state");
    expect(migration).toContain("inventory.integrity_alert_outbox");
    expect(migration).toContain("lease_expires_at");
    expect(migration).not.toMatch(
      /(?:INSERT INTO|UPDATE|DELETE FROM)\s+inventory\.(?:inventory_levels|inventory_lots|inventory_transactions)/i,
    );
  });
});
