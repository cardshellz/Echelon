import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseRecorderFlags } from "../record-wms-inventory-integrity";
import {
  persistIntegrityAuditRegistry,
  previewIntegrityAuditRegistry,
  type IntegrityAuditRegistryInput,
} from "../../server/modules/inventory/integrity/integrity-registry.repository";
import {
  classifyIntegrityObservation,
  createObservedIntegrityFinding,
} from "../../server/modules/inventory/integrity/integrity-registry.domain";

function hash(char: string): string {
  return char.repeat(64);
}

function input(overrides: Partial<IntegrityAuditRegistryInput> = {}): IntegrityAuditRegistryInput {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    scope: "all",
    sourceVersion: "test-sha",
    startedAt: "2026-07-09T12:00:00.000Z",
    snapshotAt: "2026-07-09T12:00:01.000Z",
    completedAt: "2026-07-09T12:00:02.000Z",
    databaseName: "echelon",
    databaseUser: "audit",
    serverVersion: "17.9",
    recoveryMode: false,
    blockerCount: 0,
    warningCount: 0,
    checks: [{
      checkId: "negative_inventory_level_bucket",
      category: "balances",
      severity: "blocker",
      findingCount: 0,
      elapsedMs: 4,
    }],
    findings: [],
    ...overrides,
  };
}

describe("WMS inventory integrity registry", () => {
  it("parses dry-run defaults and explicit execute flags", () => {
    expect(parseRecorderFlags([])).toEqual({
      help: false,
      execute: false,
      json: false,
      checkId: null,
      statementTimeoutMs: 120_000,
    });
    expect(parseRecorderFlags([
      "--execute",
      "--json",
      "--check=terminal_order_open_reservation",
      "--statement-timeout-ms=300000",
    ])).toEqual({
      help: false,
      execute: true,
      json: true,
      checkId: "terminal_order_open_reservation",
      statementTimeoutMs: 300_000,
    });
    expect(() => parseRecorderFlags(["--dry-run", "--execute"])).toThrow(/either/);
    expect(() => parseRecorderFlags(["--limit=25"])).toThrow(/Unknown flag/);
  });

  it("canonicalizes evidence and classifies lifecycle changes deterministically", () => {
    const finding = createObservedIntegrityFinding({
      checkId: "test_check",
      category: "balances",
      severity: "blocker",
      identityColumns: ["location_id", "variant_id"],
      evidence: { variant_id: 2, quantity: 5, location_id: 1 },
      metricValue: BigInt(5),
    });
    const sameIdentity = createObservedIntegrityFinding({
      checkId: "test_check",
      category: "balances",
      severity: "blocker",
      identityColumns: ["location_id", "variant_id"],
      evidence: { quantity: 8, location_id: 1, variant_id: 2 },
      metricValue: BigInt(8),
    });
    expect(finding.entityFingerprint).toBe(sameIdentity.entityFingerprint);
    expect(classifyIntegrityObservation(null, finding)).toBe("new");
    expect(classifyIntegrityObservation({
      status: "open",
      evidenceHash: finding.evidenceHash,
      metricValue: "4",
    }, finding)).toBe("worsened");
    expect(classifyIntegrityObservation({
      status: "resolved",
      evidenceHash: finding.evidenceHash,
      metricValue: "5",
    }, finding)).toBe("recurred");
  });

  it("previews new, worsened, and resolved findings only for executed checks", async () => {
    const observed = {
      checkId: "negative_inventory_level_bucket",
      category: "balances",
      severity: "blocker" as const,
      entityFingerprint: hash("a"),
      entityKey: { inventory_level_id: 1 },
      evidence: { inventory_level_id: 1 },
      evidenceHash: hash("b"),
      metricValue: "5",
    };
    const newFinding = { ...observed, entityFingerprint: hash("c"), evidenceHash: hash("d") };
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          check_id: observed.checkId,
          entity_fingerprint: observed.entityFingerprint,
          status: "open",
          current_evidence_hash: hash("e"),
          current_metric: "2",
        },
        {
          check_id: observed.checkId,
          entity_fingerprint: hash("f"),
          status: "acknowledged",
          current_evidence_hash: hash("f"),
          current_metric: "1",
        },
      ],
    });

    const result = await previewIntegrityAuditRegistry({ query } as any, input({
      blockerCount: 2,
      checks: [{ ...input().checks[0], findingCount: 2 }],
      findings: [observed, newFinding],
    }));
    expect(result).toEqual({
      findings: 2,
      new: 1,
      unchanged: 0,
      changed: 0,
      worsened: 1,
      improved: 0,
      recurred: 0,
      resolved: 1,
    });
    expect(query.mock.calls[0][1]).toEqual([["negative_inventory_level_bucket"]]);
  });

  it("persists one serialized transaction and never writes inventory state tables", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const query = vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text.includes("resolved_count")) return { rows: [{ resolved_count: 0 }] };
      if (text.includes("GROUP BY observation_kind")) return { rows: [] };
      return { rows: [] };
    });

    const result = await persistIntegrityAuditRegistry({ query } as any, input());
    expect(result).toEqual({
      findings: 0,
      new: 0,
      unchanged: 0,
      changed: 0,
      worsened: 0,
      improved: 0,
      recurred: 0,
      resolved: 0,
    });
    expect(calls[0].text).toBe("BEGIN");
    expect(calls[1].text).toContain("pg_advisory_xact_lock");
    expect(calls.at(-1)?.text).toBe("COMMIT");
    const sql = calls.map((call) => call.text).join("\n").toLowerCase();
    expect(sql).not.toMatch(/(?:insert into|update|delete from)\s+inventory\.inventory_(?:levels|lots|transactions)/);
  });

  it("reports the full SQL lifecycle count instead of one row per observation kind", async () => {
    const findings = ["a", "b", "c"].map((character) => ({
      checkId: "negative_inventory_level_bucket",
      category: "balances",
      severity: "blocker" as const,
      entityFingerprint: hash(character),
      entityKey: { inventory_level_id: character },
      evidence: { inventory_level_id: character },
      evidenceHash: hash(character === "a" ? "d" : character === "b" ? "e" : "f"),
      metricValue: "1",
    }));
    const query = vi.fn(async (text: string) => {
      if (text.includes("resolved_count")) return { rows: [{ resolved_count: 0 }] };
      if (text.includes("GROUP BY observation_kind")) {
        return { rows: [{ observation_kind: "new", count: 3 }] };
      }
      return { rows: [] };
    });

    const result = await persistIntegrityAuditRegistry({ query } as any, input({
      blockerCount: 3,
      checks: [{ ...input().checks[0], findingCount: 3 }],
      findings,
    }));

    expect(result.findings).toBe(3);
    expect(result.new).toBe(3);
  });

  it("rolls back the complete registry run on persistence failure", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (text: string) => {
      calls.push(text);
      if (text.includes("INSERT INTO inventory.integrity_audit_runs")) throw new Error("write failed");
      return { rows: [] };
    });
    await expect(persistIntegrityAuditRegistry({ query } as any, input())).rejects.toThrow("write failed");
    expect(calls.at(-1)).toBe("ROLLBACK");
  });

  it("rejects an out-of-order snapshot after acquiring the registry lock", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (text: string) => {
      calls.push(text);
      if (text.includes("audit_run.snapshot_at >=")) {
        return {
          rows: [{
            check_id: "negative_inventory_level_bucket",
            newer_run_id: "22222222-2222-4222-8222-222222222222",
            snapshot_at: "2026-07-09T13:00:00.000Z",
          }],
        };
      }
      return { rows: [] };
    });
    await expect(persistIntegrityAuditRegistry({ query } as any, input())).rejects.toThrow(/stale integrity audit run/);
    expect(calls[1]).toContain("pg_advisory_xact_lock");
    expect(calls.at(-1)).toBe("ROLLBACK");
  });

  it("requires activation and updates monitor state inside a continuous run transaction", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (text: string) => {
      calls.push(text);
      if (text.includes("resolved_count")) return { rows: [{ resolved_count: 0 }] };
      if (text.includes("GROUP BY observation_kind")) return { rows: [] };
      if (text.includes("FOR UPDATE") && text.includes("integrity_monitor_state")) {
        return { rows: [{ baseline_run_id: "33333333-3333-4333-8333-333333333333" }] };
      }
      if (text.includes("id <>")) return { rows: [{ blocker_count: 0 }] };
      if (text.includes("AS new_blockers")) {
        return { rows: [{ new_blockers: 0, worsened: 0, recurred: 0 }] };
      }
      return { rows: [] };
    });

    await persistIntegrityAuditRegistry({ query } as any, input({ scope: "continuous" }));

    expect(calls.some((text) => text.includes("last_successful_run_id"))).toBe(true);
    expect(calls.at(-1)).toBe("COMMIT");
  });

  it("defines append-only registry observations without inventory counter DML", () => {
    const migration = readFileSync(
      join(process.cwd(), "migrations", "126_inventory_integrity_registry.sql"),
      "utf8",
    );
    expect(migration).toContain("integrity_finding_observations_immutable_guard");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON inventory.integrity_finding_observations");
    expect(migration).not.toMatch(/(?:UPDATE|DELETE FROM)\s+inventory\.inventory_(?:levels|lots|transactions)/i);
  });
});
