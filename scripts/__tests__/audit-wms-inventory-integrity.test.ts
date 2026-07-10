import { describe, expect, it, vi } from "vitest";

async function loadAuditModule() {
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
  return await import("../audit-wms-inventory-integrity");
}

describe("audit-wms-inventory-integrity", () => {
  it("parses production-safe defaults and explicit filters", async () => {
    const { parseFlags } = await loadAuditModule();
    expect(parseFlags([])).toEqual({
      help: false,
      json: false,
      failOnBlockers: false,
      listChecks: false,
      sampleLimit: 25,
      checkId: null,
      statementTimeoutMs: 60_000,
    });
    expect(parseFlags([
      "--json",
      "--fail-on-blockers",
      "--list-checks",
      "--limit=all",
      "--check=level_lot_bucket_drift",
      "--statement-timeout-ms=120000",
    ])).toEqual({
      help: false,
      json: true,
      failOnBlockers: true,
      listChecks: true,
      sampleLimit: "all",
      checkId: "level_lot_bucket_drift",
      statementTimeoutMs: 120_000,
    });
  });

  it("rejects invalid CLI input", async () => {
    const { parseFlags } = await loadAuditModule();
    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer or all/);
    expect(() => parseFlags(["--check="])).toThrow(/cannot be blank/);
    expect(() => parseFlags(["--statement-timeout-ms=999"])).toThrow(/between 1000 and 900000/);
    expect(() => parseFlags(["--execute"])).toThrow(/Unknown flag/);
  });

  it("defines unique checks across every audited WMS integrity category", async () => {
    const { buildWmsIntegrityChecks } = await loadAuditModule();
    const checks = buildWmsIntegrityChecks();
    const ids = checks.map((check) => check.id);
    const categories = new Set(checks.map((check) => check.category));
    expect(new Set(ids).size).toBe(ids.length);
    expect(checks.length).toBeGreaterThanOrEqual(25);
    expect(categories).toEqual(new Set([
      "schema",
      "balances",
      "ledger",
      "reservations",
      "picking",
      "receiving",
      "returns",
      "conversions",
      "cycle_counts",
      "replenishment",
      "costs",
    ]));
    for (const check of checks) {
      expect(check.identityColumns.length, check.id).toBeGreaterThan(0);
      expect(new Set(check.identityColumns).size, check.id).toBe(check.identityColumns.length);
    }
  });

  it("keeps entity fingerprints stable while evidence and magnitude change", async () => {
    const { buildObservedIntegrityFindings, buildWmsIntegrityChecks } = await loadAuditModule();
    const check = buildWmsIntegrityChecks().find((candidate) => candidate.id === "level_lot_bucket_drift")!;
    const base = {
      product_variant_id: 10,
      warehouse_location_id: 20,
      on_hand_delta: "2",
      reserved_delta: "0",
      picked_delta: "0",
    };
    const first = buildObservedIntegrityFindings({
      snapshot: {} as any,
      summary: { checks: 1, blockers: 1, warnings: 0, issueCount: 1, byCategory: {} },
      results: [{ check, count: 1, samples: [base], elapsedMs: 1 }],
    })[0];
    const second = buildObservedIntegrityFindings({
      snapshot: {} as any,
      summary: { checks: 1, blockers: 1, warnings: 0, issueCount: 1, byCategory: {} },
      results: [{
        check,
        count: 1,
        samples: [{ ...base, on_hand_delta: "5" }],
        elapsedMs: 1,
      }],
    })[0];

    expect(first.entityFingerprint).toBe(second.entityFingerprint);
    expect(first.evidenceHash).not.toBe(second.evidenceHash);
    expect(first.metricValue).toBe("2");
    expect(second.metricValue).toBe("5");
  });

  it("refuses to record bounded samples as a complete finding set", async () => {
    const { buildObservedIntegrityFindings, buildWmsIntegrityChecks } = await loadAuditModule();
    const check = buildWmsIntegrityChecks()[0];
    expect(() => buildObservedIntegrityFindings({
      snapshot: {} as any,
      summary: { checks: 1, blockers: 2, warnings: 0, issueCount: 2, byCategory: {} },
      results: [{
        check,
        count: 2,
        samples: [{ missing_constraint: "one" }],
        elapsedMs: 1,
      }],
    })).toThrow(/Run with --limit=all/);
  });

  it("keeps every check query read-only", async () => {
    const { buildWmsIntegrityChecks } = await loadAuditModule();
    const mutating = /\b(insert|update|delete|merge|alter|create|drop|truncate|grant|revoke|call)\b/i;
    for (const check of buildWmsIntegrityChecks()) {
      expect(check.sql, check.id).not.toMatch(mutating);
      expect(check.sql, check.id).not.toContain(";");
    }
  });

  it("does not call the legacy replay implementation", async () => {
    const { buildWmsIntegrityChecks } = await loadAuditModule();
    const allSql = buildWmsIntegrityChecks().map((check) => check.sql).join("\n");
    expect(allSql).not.toContain("replayLedger");
    expect(allSql).not.toContain("ledger-replay");
    expect(allSql).toContain("variant_qty_after - it.variant_qty_before");
  });

  it("encodes the current inventory, conversion, and replenishment contracts", async () => {
    const { buildWmsIntegrityChecks } = await loadAuditModule();
    const checks = new Map(buildWmsIntegrityChecks().map((check) => [check.id, check.sql]));

    expect(checks.get("ledger_row_arithmetic_mismatch")).not.toContain("'ship'");
    expect(checks.get("reservation_level_ledger_drift")).toContain("legacy_missing_delta_count = 0");
    expect(checks.get("closed_receipt_line_ledger_drift")).toContain("ro.status = 'closed'");
    expect(checks.get("multiple_active_base_variants")).toContain("is_base_unit = true");
    expect(checks.get("invalid_variant_hierarchy")).toContain(
      "parent.units_per_variant >= child.units_per_variant",
    );
    expect(checks.get("inline_replen_not_completed")).toContain("'blocked'");
  });

  it("counts and samples each check with one database scan", async () => {
    const { buildWmsIntegrityChecks, runCheck } = await loadAuditModule();
    const query = vi.fn().mockResolvedValue({
      rows: [
        { inventory_level_id: 10, __issue_count: "3" },
        { inventory_level_id: 11, __issue_count: "3" },
      ],
    });
    const result = await runCheck({ query } as any, buildWmsIntegrityChecks()[2], 2);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("COUNT(*) OVER()");
    expect(query.mock.calls[0][1]).toEqual([2]);
    expect(result.count).toBe(3);
    expect(result.samples).toEqual([
      { inventory_level_id: 10 },
      { inventory_level_id: 11 },
    ]);
  });

  it("runs all checks in one repeatable-read read-only transaction and always rolls back", async () => {
    const { parseFlags, runAuditWithClient } = await loadAuditModule();
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const query = vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text.includes("transaction_timestamp()")) {
        return {
          rows: [{
            snapshot_at: "2026-07-09T12:00:00.000Z",
            database_name: "echelon",
            database_user: "audit_user",
            server_version: "16.1",
            recovery_mode: false,
          }],
        };
      }
      if (text.includes("COUNT(*) OVER()")) return { rows: [] };
      return { rows: [] };
    });
    const result = await runAuditWithClient({ query } as any, parseFlags(["--check=negative_inventory_level_bucket"]));
    expect(calls[0].text).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(calls[1].text).toContain("set_config('statement_timeout'");
    expect(calls[2].text).toContain("set_config('lock_timeout'");
    expect(calls[3].text).toContain("set_config('idle_in_transaction_session_timeout'");
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
    expect(result.summary.issueCount).toBe(0);
    expect(result.snapshot.databaseName).toBe("echelon");
  });

  it("rolls back when a check fails", async () => {
    const { parseFlags, runAuditWithClient } = await loadAuditModule();
    const calls: string[] = [];
    const query = vi.fn(async (text: string) => {
      calls.push(text);
      if (text.includes("transaction_timestamp()")) {
        return {
          rows: [{
            snapshot_at: "2026-07-09T12:00:00.000Z",
            database_name: "echelon",
            database_user: "audit_user",
            server_version: "16.1",
            recovery_mode: false,
          }],
        };
      }
      if (text.includes("COUNT(*) OVER()")) throw new Error("statement timeout");
      return { rows: [] };
    });
    await expect(
      runAuditWithClient({ query } as any, parseFlags(["--check=negative_inventory_level_bucket"])),
    ).rejects.toThrow("statement timeout");
    expect(calls.at(-1)).toBe("ROLLBACK");
  });

  it("summarizes blocker and warning rows by category", async () => {
    const { buildWmsIntegrityChecks, summarizeResults } = await loadAuditModule();
    const checks = buildWmsIntegrityChecks();
    const blocker = checks.find((check) => check.severity === "blocker")!;
    const warning = checks.find(
      (check) => check.severity === "warning" && check.category !== blocker.category,
    )!;
    expect(summarizeResults([
      { check: blocker, count: 2, samples: [], elapsedMs: 1 },
      { check: warning, count: 3, samples: [], elapsedMs: 1 },
    ])).toEqual({
      checks: 2,
      blockers: 2,
      warnings: 3,
      issueCount: 5,
      byCategory: {
        [blocker.category]: 2,
        [warning.category]: 3,
      },
    });
  });
});
