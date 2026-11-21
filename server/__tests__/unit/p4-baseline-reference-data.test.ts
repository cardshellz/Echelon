import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASELINE_MANIFEST_FILENAME,
  BASELINE_REFERENCE_AUDIT_FILENAME,
  BASELINE_REFERENCE_DATA_FILENAME,
  BASELINE_SCHEMA_FILENAME,
  baselineSha256,
  validateBaselineManifest,
  validateBaselineReferenceAudit,
} from "../../../scripts/migrations/baseline-format.mjs";

const ROOT = process.cwd();
const MIGRATIONS_DIR = resolve(ROOT, "migrations");
const BASELINE_DIR = resolve(MIGRATIONS_DIR, "baseline");
const RUNBOOK_PATH = resolve(ROOT, "docs/runbooks/schema-drift-activation.md");

const CANONICAL_LEGACY_TABLE_NAMES: Record<string, string> = {
  auth_permissions: "identity.auth_permissions",
  auth_role_permissions: "identity.auth_role_permissions",
  product_lines: "catalog.product_lines",
  product_line_products: "catalog.product_line_products",
  channel_product_lines: "catalog.channel_product_lines",
  product_assets: "catalog.product_assets",
  channel_allocation_rules: "channels.channel_allocation_rules",
  channel_listings: "channels.channel_listings",
  inventory_transactions: "inventory.inventory_transactions",
  notification_types: "public.notification_types",
  notification_preferences: "public.notification_preferences",
};

describe("P4.1 Tail — Baseline Reference Data Audit, Empty-DB Seed & Schema-Drift Runbook", () => {
  const manifest = validateBaselineManifest(
    JSON.parse(readFileSync(resolve(BASELINE_DIR, BASELINE_MANIFEST_FILENAME), "utf8")),
  );
  const schemaSql = readFileSync(resolve(BASELINE_DIR, BASELINE_SCHEMA_FILENAME), "utf8");
  const referenceDataSql = readFileSync(
    resolve(BASELINE_DIR, BASELINE_REFERENCE_DATA_FILENAME),
    "utf8",
  );
  const referenceAudit = validateBaselineReferenceAudit(
    JSON.parse(readFileSync(resolve(BASELINE_DIR, BASELINE_REFERENCE_AUDIT_FILENAME), "utf8")),
  );

  it("matches reference-data.sql SHA-256 against reference-data-audit.json and baseline capturedAt", () => {
    expect(baselineSha256(referenceDataSql)).toBe(referenceAudit.referenceDataSha256);
    expect(referenceAudit.baselineCapturedAt).toBe(manifest.capturedAt);
  });

  it("accounts for 100% of persistent-table INSERT migrations covered by migrations/baseline/manifest.json", () => {
    const discoveredMigrations = new Set<string>();
    const discoveredTables = new Set<string>();

    for (const file of manifest.covers) {
      const raw = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
      const stripped = raw
        .replace(/--[^\r\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      const tempTables = new Set(
        [
          ...stripped.matchAll(
            /\bCREATE\s+TEMP(?:ORARY)?\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_."]+)/gi,
          ),
        ].map((m) => m[1].replace(/"/g, "").toLowerCase()),
      );
      const cteNames = new Set(
        [...stripped.matchAll(/\b(?:WITH|,)\s+([a-zA-Z0-9_]+)\s+AS\s*\(/gi)].map((m) =>
          m[1].toLowerCase(),
        ),
      );

      let hasPersistentInsert = false;
      for (const match of stripped.matchAll(/\bINSERT\s+INTO\s+([a-zA-Z0-9_."]+)\b/gi)) {
        const rawTbl = match[1].replace(/"/g, "").toLowerCase();
        if (tempTables.has(rawTbl) || cteNames.has(rawTbl)) continue;
        const canonical = CANONICAL_LEGACY_TABLE_NAMES[rawTbl] ?? rawTbl;
        discoveredTables.add(canonical);
        hasPersistentInsert = true;
      }
      if (hasPersistentInsert) {
        discoveredMigrations.add(file);
      }
    }

    expect(referenceAudit.coveredInsertMigrations).toEqual([...discoveredMigrations].sort());
    expect(referenceAudit.tables.map((t) => t.table).sort()).toEqual(
      [...discoveredTables].sort(),
    );
  });

  it("keeps reference-data.sql schema-qualified, idempotent, and aligned with baseline_reference_seed tables in schema.sql", () => {
    const schemaTables = new Set(
      [...schemaSql.matchAll(/^CREATE TABLE ([a-z0-9_]+\.[a-z0-9_]+) \(/gm)].map((m) => m[1]),
    );

    const strippedSql = referenceDataSql
      .replace(/--[^\r\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // Must not contain psql commands, COPY data blocks, or session-level SET statements
    expect(referenceDataSql).not.toMatch(/^\\/m);
    expect(referenceDataSql).not.toMatch(/^COPY .* FROM stdin;$/m);
    expect(strippedSql).not.toMatch(/\bSET\s+(?!LOCAL\b)/i);

    // Every INSERT target must be schema-qualified and exist in migrations/baseline/schema.sql
    const insertedTables = new Set<string>();
    for (const match of strippedSql.matchAll(/\bINSERT\s+INTO\s+([a-zA-Z0-9_."]+)\b/gi)) {
      const target = match[1].replace(/"/g, "");
      expect(target).toMatch(/^[a-z0-9_]+\.[a-z0-9_]+$/);
      expect(schemaTables.has(target), `Missing table in baseline/schema.sql: ${target}`).toBe(
        true,
      );
      insertedTables.add(target);
    }

    const expectedSeededTables = referenceAudit.tables
      .filter((t) => t.disposition === "baseline_reference_seed")
      .map((t) => t.table)
      .sort();

    expect([...insertedTables].sort()).toEqual(expectedSeededTables);

    // Any bootstrap-disabled singleton guard trigger must be symmetrically re-enabled
    const disabledTriggers = [
      ...strippedSql.matchAll(
        /ALTER\s+TABLE\s+([a-z0-9_]+\.[a-z0-9_]+)\s+DISABLE\s+TRIGGER\s+([a-z0-9_]+)\s*;/gi,
      ),
    ].map((m) => `${m[1]}:${m[2]}`);
    const enabledTriggers = [
      ...strippedSql.matchAll(
        /ALTER\s+TABLE\s+([a-z0-9_]+\.[a-z0-9_]+)\s+ENABLE\s+TRIGGER\s+([a-z0-9_]+)\s*;/gi,
      ),
    ].map((m) => `${m[1]}:${m[2]}`);

    expect(disabledTriggers).toEqual([
      "inventory.availability_runtime_authority:aa_cutover_control_owner",
      "inventory.cutover_admission_fence:cutover_admission_owner_write_guard",
    ]);
    expect(enabledTriggers).toEqual(disabledTriggers);
  });

  it("documents the 3 one-time Heroku/GitHub schema-drift activation settings and error triage codes", () => {
    expect(existsSync(RUNBOOK_PATH)).toBe(true);
    const runbook = readFileSync(RUNBOOK_PATH, "utf8");

    expect(runbook).toContain("SCHEMA_STRUCTURE_GITHUB_TOKEN");
    expect(runbook).toContain("SCHEMA_STRUCTURE_GITHUB_REPOSITORY");
    expect(runbook).toContain("npx tsx scripts/publish-production-structure.ts");
    expect(runbook).toContain("09:00 UTC");
    expect(runbook).toContain("09:30 UTC");
    expect(runbook).toContain("SCHEMA_DRIFT_ALERT_WEBHOOK_URL");
    expect(runbook).toContain("production-structure");
    expect(runbook).toContain("SCHEMA_DRIFT_DETECTED");
    expect(runbook).toContain("PRODUCTION_STRUCTURE_STALE");
  });
});
