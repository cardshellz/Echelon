import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as procurementBarrel from "../../index";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const SERVER_ROOT = path.resolve(__dirname, "../../../..");
const PROCUREMENT_ROOT = path.resolve(__dirname, "../..");

const EXPECTED_BARREL_FACADES = [
  "./routes.api",
  "./runtime-workers.api",
  "./runtime-services.api",
  "./cost-source-evidence.api",
  "./receiving-custody.api",
  "./catalog-identity-coordination.api",
  "./health-and-observability.api",
  "./planning-and-pipeline-jobs.api",
  "./maintenance-remediation.api",
];

function collectProductionCodeFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "__tests__" ||
        entry.name === "test" ||
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      results.push(...collectProductionCodeFiles(fullPath));
      continue;
    }
    if (
      entry.isFile() &&
      /\.(ts|tsx|mts|cts|mjs|cjs|js)$/.test(entry.name) &&
      !/\.(test|spec)\./.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

function collectSpecifiers(filePath: string, content: string): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

describe("P2-1A: Procurement internal API boundaries (CI-03) and sole-writer authority", () => {
  it("forbids production and operational script files outside server/modules/procurement from importing deep module files directly", () => {
    const files = [
      ...collectProductionCodeFiles(SERVER_ROOT),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "client/src")),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "shared")),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "scripts")),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "script")),
    ];
    const targetModule = "server/modules/procurement";
    const violations: Array<{ importer: string; specifier: string; resolved: string }> = [];

    for (const filePath of files) {
      const relImporter = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
      if (relImporter === targetModule || relImporter.startsWith(`${targetModule}/`)) {
        continue;
      }

      const content = fs.readFileSync(filePath, "utf8");
      if (!content.includes("procurement")) continue;

      for (const specifier of collectSpecifiers(filePath, content)) {
        if (specifier.startsWith(".")) {
          const resolved = path.posix
            .normalize(path.posix.join(path.posix.dirname(relImporter), specifier))
            .replace(/\.[cm]?[jt]sx?$/, "");

          if (
            resolved !== targetModule &&
            resolved !== `${targetModule}/index` &&
            !resolved.endsWith(".api") &&
            resolved.startsWith(`${targetModule}/`)
          ) {
            violations.push({ importer: relImporter, specifier, resolved });
          }
        } else if (specifier.includes("modules/procurement")) {
          const after = specifier
            .slice(specifier.indexOf("modules/procurement") + "modules/procurement".length)
            .replace(/^\/+/, "")
            .replace(/\.[cm]?[jt]sx?$/, "");
          if (after !== "" && after !== "index" && !after.endsWith(".api")) {
            violations.push({ importer: relImporter, specifier, resolved: `${targetModule}/${after}` });
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps procurement/index.ts strictly layered over capability-scoped .api.ts facades", () => {
    const indexPath = path.resolve(PROCUREMENT_ROOT, "index.ts");
    const indexContent = fs.readFileSync(indexPath, "utf8");
    const specifiers = collectSpecifiers(indexPath, indexContent);
    expect(specifiers).toEqual(EXPECTED_BARREL_FACADES);

    expect(typeof procurementBarrel.registerPurchasingRoutes).toBe("function");
    expect(typeof procurementBarrel.startPoEmailOutboxWorker).toBe("function");
    expect(typeof procurementBarrel.createPurchasingService).toBe("function");
    expect(typeof procurementBarrel.createReceivingService).toBe("function");
    expect(typeof procurementBarrel.readReceivingLineCostProvenance).toBe("function");
    expect(typeof procurementBarrel.readUnresolvedReceivingCustody).toBe("function");
    expect(typeof procurementBarrel.synchronizeProcurementSkuReferences).toBe("function");
    expect(typeof procurementBarrel.loadProcurementHealthSummary).toBe("function");
    expect(typeof procurementBarrel.generatePurchasingRecommendations).toBe("function");
    expect(typeof procurementBarrel.previewHistoricalPoSupplierEvidence).toBe("function");
  });

  it("locks sole-writer ownership across all 82+ procurement.* tables with zero route or script leaks", () => {
    const baseline = JSON.parse(
      fs.readFileSync(path.resolve(REPO_ROOT, "scripts/writer-ratchet/baseline.json"), "utf8"),
    ) as Record<string, string[]>;

    const procurementTables = Object.entries(baseline).filter(([table]) =>
      table.startsWith("procurement."),
    );
    expect(procurementTables.length).toBeGreaterThanOrEqual(82);

    const nonSoleWriters = procurementTables.filter(
      ([, writers]) => writers.length !== 1 || writers[0] !== "modules/procurement",
    );
    expect(nonSoleWriters).toEqual([]);

    const routeAndScript = JSON.parse(
      fs.readFileSync(
        path.resolve(REPO_ROOT, "scripts/writer-ratchet/route-and-script-baseline.json"),
        "utf8",
      ),
    ) as {
      routeWriters: Record<string, string[]>;
      scriptWriters: Record<string, string[]>;
    };

    const leakingRouteTables = Object.keys(routeAndScript.routeWriters).filter((t) =>
      t.startsWith("procurement."),
    );
    const leakingScriptTables = Object.keys(routeAndScript.scriptWriters).filter((t) =>
      t.startsWith("procurement."),
    );
    expect(leakingRouteTables).toEqual([]);
    expect(leakingScriptTables).toEqual([]);
  });
});
