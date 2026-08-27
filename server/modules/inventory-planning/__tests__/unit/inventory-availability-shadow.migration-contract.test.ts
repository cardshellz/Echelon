import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  plannerShadowResults,
  plannerShadowRuns,
} from "../../../../../shared/schema/inventory-planning.schema";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/214_inventory_planner_shadow_evidence.sql"),
  "utf8",
);
const repository = readFileSync(
  resolve(
    process.cwd(),
    "server/modules/inventory-planning/infrastructure/inventory-availability-shadow.repository.ts",
  ),
  "utf8",
);

describe("inventory availability Phase 2 shadow evidence contract", () => {
  it("owns the unique current migration prefix and creates only evidence tables", () => {
    const migrationNames = readdirSync(resolve(process.cwd(), "migrations"))
      .filter((name) => name.startsWith("214_"));
    expect(migrationNames).toEqual(["214_inventory_planner_shadow_evidence.sql"]);
    expect([...migration.matchAll(/CREATE TABLE\s+([a-z_]+\.[a-z_]+)/gi)]
      .map((match) => match[1])).toEqual([
      "inventory.planner_shadow_runs",
      "inventory.planner_shadow_results",
    ]);
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?(?:catalog|warehouse|wms|channels)\./i);
  });

  it("keeps SQL and Drizzle table columns in exact parity", () => {
    expect(getTableConfig(plannerShadowRuns).columns.map((column) => column.name).sort())
      .toEqual(migrationColumns("planner_shadow_runs"));
    expect(getTableConfig(plannerShadowResults).columns.map((column) => column.name).sort())
      .toEqual(migrationColumns("planner_shadow_results"));
    for (const requiredObject of [
      "planner_shadow_runs_model_product_fk",
      "planner_shadow_runs_idempotency_uq",
      "planner_shadow_runs_product_lookup_idx",
      "planner_shadow_runs_status_chk",
      "planner_shadow_runs_legacy_strategy_chk",
      "planner_shadow_runs_hash_chk",
      "planner_shadow_runs_model_evidence_chk",
      "planner_shadow_runs_json_chk",
      "planner_shadow_runs_actor_chk",
      "planner_shadow_runs_time_chk",
      "planner_shadow_results_scope_variant_uq",
      "planner_shadow_results_run_idx",
      "planner_shadow_results_quantity_chk",
      "planner_shadow_results_readiness_chk",
      "planner_shadow_results_evidence_chk",
    ]) {
      expect(migration).toContain(requiredObject);
    }
  });

  it("makes run and result evidence append-only at the database boundary", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION inventory.guard_planner_shadow_evidence_write()");
    expect(migration).toContain("IF TG_OP <> 'INSERT' THEN");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON inventory.planner_shadow_runs");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON inventory.planner_shadow_results");
  });

  it("uses one repeatable-read snapshot and writes only shadow evidence", () => {
    expect(repository).toContain("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(repository).toContain('claimProjectionSource: "inventory_levels.reserved_qty"');
    expect(repository).not.toContain("build_component_reservations");
    expect([...repository.matchAll(/INSERT INTO\s+inventory\.([a-z_]+)/g)]
      .map((match) => match[1]).sort()).toEqual([
      "planner_shadow_results",
      "planner_shadow_runs",
    ]);
    expect(repository).not.toMatch(/\b(?:UPDATE|DELETE)\s+(?:inventory|catalog|warehouse|wms|channels)\./i);
  });

  it("does not attach the proposed planner to operational ATP or publishers", () => {
    const operationalConsumers = [
      "server/modules/inventory/atp.service.ts",
      "server/modules/inventory/recipe-capacity.service.ts",
      "server/modules/channels/reservation.service.ts",
      "server/modules/channels/allocation-engine.service.ts",
      "server/modules/channels/sync.service.ts",
      "server/modules/channels/variant-availability-sync.service.ts",
      "server/modules/dropship/infrastructure/dropship-atp.provider.ts",
      "server/modules/oms/ebay-order-ingestion.ts",
      "server/routes/shopify.routes.ts",
      "server/routes/ebay/ebay-listings.routes.ts",
    ];
    for (const path of operationalConsumers) {
      const source = readFileSync(resolve(process.cwd(), path), "utf8");
      expect(source, path).not.toContain("inventory-availability-planner");
      expect(source, path).not.toContain("inventory-availability-shadow");
      expect(source, path).not.toContain("planner_shadow_");
    }
  });

  it("exposes comparison evidence only through permission-gated admin routes and UI", () => {
    const routes = readFileSync(resolve(
      process.cwd(),
      "server/modules/inventory-planning/interfaces/http/inventory-availability-shadow.routes.ts",
    ), "utf8");
    const registry = readFileSync(resolve(process.cwd(), "server/routes.ts"), "utf8");
    const page = readFileSync(resolve(process.cwd(), "client/src/pages/SupplyTransformations.tsx"), "utf8");

    expect(registry).toContain("registerInventoryAvailabilityShadowRoutes(app)");
    expect(routes).toContain('requirePermission("inventory_planning", "edit")');
    expect(routes).toContain('requirePermission("inventory_planning", "view")');
    expect(routes).toContain("/shadow-runs");
    expect(routes).not.toContain("/activate");
    expect(page).toContain("Shadow ATP comparison");
    expect(page).toContain("Runtime ATP is unchanged");
    expect(page).toContain("plannerShadowRunSchema");
    expect(page).toContain("does not switch readers, reserve stock, or publish channel quantities");
  });
});

function migrationColumns(tableName: string): string[] {
  const header = `CREATE TABLE inventory.${tableName} (`;
  const start = migration.indexOf(header);
  if (start < 0) throw new Error(`Missing ${tableName}`);
  const bodyStart = start + header.length;
  let depth = 1;
  let quoted = false;
  let end = bodyStart;
  for (; end < migration.length; end += 1) {
    const character = migration[end];
    if (character === "'") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = migration.slice(bodyStart, end);
  const parts: string[] = [];
  let partStart = 0;
  depth = 0;
  quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "'") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(body.slice(partStart, index).trim());
      partStart = index + 1;
    }
  }
  parts.push(body.slice(partStart).trim());
  return parts
    .filter((part) => !part.startsWith("CONSTRAINT"))
    .map((part) => part.match(/^([a-z_][a-z0-9_]*)\s/i)?.[1])
    .filter((value): value is string => Boolean(value))
    .sort();
}
