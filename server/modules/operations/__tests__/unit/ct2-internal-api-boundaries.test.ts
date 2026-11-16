import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  CONTROL_TOWER_DOMAINS,
  CONTROL_TOWER_SOURCE_ADAPTERS,
  ControlTowerActionError,
  controlTowerProjectorInitialDelayMs,
  getControlTowerSourceAdapter,
  parseControlTowerFilters,
} from "../../index";

const ROOT = process.cwd();
const OPERATIONS_DIR = resolve(ROOT, "server/modules/operations");

const ALLOWED_OPERATIONS_ENTRYPOINTS = new Set([
  "index",
  "index.ts",
  "routes.api",
  "routes.api.ts",
  "projection-scheduler.api",
  "projection-scheduler.api.ts",
  "projection-runner.api",
  "projection-runner.api.ts",
  "legacy-overview.api",
  "legacy-overview.api.ts",
]);

const OPERATIONS_TABLES = [
  "operations.control_tower_flow_snapshots",
  "operations.control_tower_observations",
  "operations.control_tower_source_runs",
  "operations.control_tower_work_items",
] as const;

const PRIORITY_1_TO_15_INDEX_MODULES = [
  "catalog",
  "procurement",
  "inventory",
  "warehouse",
  "inventory-planning",
  "channels",
  "marketplace-listings",
  "dropship",
  "oms",
  "order-edits",
  "sync",
  "orders",
  "wms",
  "cartonization",
  "shipping",
  "shipping-engine",
  "returns",
  "customer-account",
  "subscriptions",
  "membership",
  "identity",
  "notifications",
  "operations",
] as const;

const PRIORITY_1_TO_15_API_FACADE_MODULES = [
  "catalog",
  "procurement",
  "inventory",
  "warehouse",
  "inventory-planning",
  "channels",
  "marketplace-listings",
  "dropship",
  "oms",
  "order-edits",
  "sync",
  "orders",
  "wms",
  "cartonization",
  "shipping",
  "shipping-engine",
  "returns",
  "customer-account",
  "subscriptions",
  "membership",
  "identity",
  "notifications",
  "operations",
] as const;

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsFiles(full, acc);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

function collectModuleSpecifiers(filePath: string, sourceText: string): string[] {
  const sf = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const expr = node.expression;
      if (
        expr.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(expr) && expr.text === "require") ||
        (ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === "vi" &&
          (expr.name.text === "mock" || expr.name.text === "doMock"))
      ) {
        specifiers.push(node.arguments[0].text);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return specifiers;
}

function checkOperationsSpecifier(fromFile: string, specifier: string): string | null {
  let targetRelToOperations: string | null = null;

  if (specifier.startsWith(".")) {
    const resolvedTarget = resolve(fromFile, "..", specifier);
    const rel = relative(OPERATIONS_DIR, resolvedTarget).split(sep).join("/");
    if (!rel.startsWith("..") && !rel.startsWith("/")) {
      targetRelToOperations = rel === "" ? "index" : rel;
    }
  } else if (specifier.includes("modules/operations")) {
    const idx = specifier.indexOf("modules/operations");
    const after = specifier.slice(idx + "modules/operations".length).replace(/^\/+/, "");
    targetRelToOperations = after === "" ? "index" : after;
  }

  if (targetRelToOperations === null) return null;
  if (ALLOWED_OPERATIONS_ENTRYPOINTS.has(targetRelToOperations)) return null;

  const repoRelFrom = relative(ROOT, fromFile).split(sep).join("/");
  return `${repoRelFrom} -> "${specifier}" (resolves to operations/${targetRelToOperations})`;
}

describe("CT-2 Priority 15 Control Tower CI-03 internal API boundaries & Priority 1-15 roadmap closure", () => {
  it("blocks all external deep imports and vi.mock bypasses into server/modules/operations internals", () => {
    const roots = ["server", "scripts", "script", "shared", "client", "test"].map((d) => resolve(ROOT, d));
    const allFiles = roots.flatMap((r) => walkTsFiles(r));
    const violations: string[] = [];

    for (const file of allFiles) {
      const relToOperations = relative(OPERATIONS_DIR, file).split(sep).join("/");
      const isInsideOperations =
        !relToOperations.startsWith("..") && !relToOperations.startsWith("/");
      if (isInsideOperations) continue;

      const content = readFileSync(file, "utf8");
      if (!content.includes("operations") && !content.includes("control-tower")) continue;

      for (const specifier of collectModuleSpecifiers(file, content)) {
        const violation = checkOperationsSpecifier(file, specifier);
        if (violation) violations.push(violation);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps operations barrel and .api.ts facades strictly layered and free of singleton leaks", () => {
    const indexSource = readFileSync(resolve(OPERATIONS_DIR, "index.ts"), "utf8");
    const indexSpecifiers = collectModuleSpecifiers(resolve(OPERATIONS_DIR, "index.ts"), indexSource);
    expect(indexSpecifiers).toEqual([
      "./routes.api",
      "./projection-scheduler.api",
      "./projection-runner.api",
      "./legacy-overview.api",
    ]);

    for (const pureFacade of ["projection-runner.api.ts", "legacy-overview.api.ts"]) {
      const source = readFileSync(resolve(OPERATIONS_DIR, pureFacade), "utf8");
      const specifiers = collectModuleSpecifiers(resolve(OPERATIONS_DIR, pureFacade), source);
      expect(specifiers.some((s) => s.includes("db") || s.includes("routes"))).toBe(false);
    }

    expect(CONTROL_TOWER_DOMAINS).toEqual(["oms", "wms", "shipping", "inventory", "procurement"]);
    expect(parseControlTowerFilters({ domain: "wms", limit: "25" })).toEqual({
      domain: "wms",
      severity: "all",
      status: "all",
      search: "",
      limit: 25,
    });
    expect(CONTROL_TOWER_SOURCE_ADAPTERS.length).toBeGreaterThanOrEqual(5);
    expect(getControlTowerSourceAdapter("inventory_integrity")?.name).toBe("inventory_integrity");
    expect(getControlTowerSourceAdapter("nonexistent_source")).toBeNull();
    expect(controlTowerProjectorInitialDelayMs(60_000)).toBe(30_000);
    const err = new ControlTowerActionError("Not found", 404, "WORK_ITEM_NOT_FOUND");
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("WORK_ITEM_NOT_FOUND");
  });

  it("locks sole-writer ownership for all operations.control_tower_* tables", () => {
    const baseline = JSON.parse(
      readFileSync(resolve(ROOT, "scripts/writer-ratchet/baseline.json"), "utf8"),
    ) as Record<string, string[]>;

    for (const table of OPERATIONS_TABLES) {
      expect(baseline[table]).toEqual(["modules/operations"]);
    }

    const routeAndScript = JSON.parse(
      readFileSync(resolve(ROOT, "scripts/writer-ratchet/route-and-script-baseline.json"), "utf8"),
    ) as {
      routeWriters: Record<string, Record<string, string[]>>;
      scriptWriters: Record<string, Record<string, string[]>>;
    };

    const leakingRoutes = Object.entries(routeAndScript.routeWriters)
      .filter(([, tables]) => Object.keys(tables).some((t) => t.startsWith("operations.")))
      .map(([file]) => file);
    const leakingScripts = Object.entries(routeAndScript.scriptWriters)
      .filter(([, tables]) => Object.keys(tables).some((t) => t.startsWith("operations.")))
      .map(([file]) => file);

    expect(leakingRoutes).toEqual([]);
    expect(leakingScripts).toEqual([]);
  });

  it("verifies Priority 1-15 roadmap closure: every ratcheted domain module publishes explicit contracts", () => {
    const missingIndex = PRIORITY_1_TO_15_INDEX_MODULES.filter(
      (mod) => !existsSync(resolve(ROOT, "server/modules", mod, "index.ts")),
    );
    expect(missingIndex).toEqual([]);

    const missingApiFacades = PRIORITY_1_TO_15_API_FACADE_MODULES.filter((mod) => {
      const modDir = resolve(ROOT, "server/modules", mod);
      const apiFiles = readdirSync(modDir).filter((f) => f.endsWith(".api.ts"));
      return apiFiles.length === 0;
    });
    expect(missingApiFacades).toEqual([]);
  });
});
