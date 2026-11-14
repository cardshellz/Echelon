import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { renameWmsPickingLogSku } from "../../picking-execution.api";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const SERVER_ROOT = path.resolve(__dirname, "../../../..");
const WMS_ROOT = path.resolve(__dirname, "../..");
const ORDERS_ROOT = path.resolve(SERVER_ROOT, "modules/orders");
const CARTONIZATION_ROOT = path.resolve(SERVER_ROOT, "modules/cartonization");

function collectProductionTypeScriptFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "__tests__" ||
        entry.name === "test" ||
        entry.name === "node_modules" ||
        entry.name === "dist"
      ) {
        continue;
      }
      results.push(...collectProductionTypeScriptFiles(fullPath));
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("WMS-2: Orders, WMS, and Cartonization internal API boundaries (CI-03) and writer-ratchet authority", () => {
  it("forbids production files outside orders, wms, and cartonization from importing deep module files directly (CI-03)", () => {
    const files = [
      ...collectProductionTypeScriptFiles(SERVER_ROOT),
      ...collectProductionTypeScriptFiles(path.resolve(REPO_ROOT, "client/src")),
    ];
    const protectedModules = [
      "server/modules/orders",
      "server/modules/wms",
      "server/modules/cartonization",
    ];

    const violations: Array<{ importer: string; specifier: string; resolved: string }> = [];

    for (const filePath of files) {
      const relImporter = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
      const content = fs.readFileSync(filePath, "utf8");
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
      );

      const visit = (node: ts.Node) => {
        let specifier: string | null = null;
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          specifier = node.moduleSpecifier.text;
        } else if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          specifier = node.arguments[0].text;
        } else if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal)
        ) {
          specifier = node.argument.literal.text;
        }

        if (specifier && specifier.startsWith(".")) {
          const resolved = path.posix.normalize(
            path.posix.join(path.posix.dirname(relImporter), specifier),
          );
          for (const targetModule of protectedModules) {
            if (relImporter === targetModule || relImporter.startsWith(`${targetModule}/`)) {
              continue;
            }
            if (
              resolved === targetModule ||
              resolved === `${targetModule}/index` ||
              resolved.endsWith(".api")
            ) {
              continue;
            }
            // Dedicated single-caller private participant enforced by shipment-context-boundary.test.ts
            if (
              relImporter === "server/modules/shipping/outbound-shipment-access.query.ts" &&
              resolved === "server/modules/orders/shipment-order-context.query"
            ) {
              continue;
            }
            if (resolved.startsWith(`${targetModule}/`)) {
              violations.push({
                importer: relImporter,
                specifier,
                resolved,
              });
            }
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });

  it("exposes explicit *.api.ts facades and index.ts barrels for orders, wms, and cartonization (CI-03)", () => {
    const expectedWmsApis = [
      "index.ts",
      "order-intake-and-items.api.ts",
      "picking-execution.api.ts",
      "picking-logs.api.ts",
      "pick-corrections-and-holds.api.ts",
      "shipment-execution-and-projection.api.ts",
      "assembly-and-packing.api.ts",
      "returns-receipt.api.ts",
      "cutover-and-dispatch.api.ts",
    ];
    for (const apiFile of expectedWmsApis) {
      expect(fs.existsSync(path.join(WMS_ROOT, apiFile))).toBe(true);
    }

    const expectedOrdersApis = [
      "index.ts",
      "order-lifecycle-and-cancellation.api.ts",
      "bin-location-backfill.api.ts",
      "hold-release-push.api.ts",
      "shipment-rollup-and-context.api.ts",
      "sort-rank-and-priority.api.ts",
      "assembly-order-authority.api.ts",
      "reconciliation-and-repair.api.ts",
      "runtime-services.api.ts",
      "routes.api.ts",
    ];
    for (const apiFile of expectedOrdersApis) {
      expect(fs.existsSync(path.join(ORDERS_ROOT, apiFile))).toBe(true);
    }

    const expectedCartonizationApis = [
      "index.ts",
      "cartonize-engine.api.ts",
      "pack-plan.api.ts",
      "packing-inputs.api.ts",
    ];
    for (const apiFile of expectedCartonizationApis) {
      expect(fs.existsSync(path.join(CARTONIZATION_ROOT, apiFile))).toBe(true);
    }
  });

  it("encapsulates raw method objects inside orders/index.ts while preserving ordersStorage", () => {
    const ordersBarrelSource = fs.readFileSync(path.join(ORDERS_ROOT, "index.ts"), "utf8");
    const sf = ts.createSourceFile("index.ts", ordersBarrelSource, ts.ScriptTarget.Latest, true);
    const exportedNames = new Set<string>();

    for (const stmt of sf.statements) {
      if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          exportedNames.add(el.name.text);
        }
      } else if (ts.isVariableStatement(stmt)) {
        const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (isExported) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) exportedNames.add(decl.name.text);
          }
        }
      }
    }

    expect(exportedNames.has("ordersStorage")).toBe(true);
    expect(exportedNames.has("orderPageQuerySchema")).toBe(true);
    expect(exportedNames.has("orderMethods")).toBe(false);
    expect(exportedNames.has("pickingLogMethods")).toBe(false);
    expect(exportedNames.has("orderHistoryMethods")).toBe(false);
  });

  it("tightens wms.picking_logs and wms.orders in writer-ratchet baseline and preserves sole-writer tables", () => {
    const baselinePath = path.join(REPO_ROOT, "scripts/writer-ratchet/baseline.json");
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as Record<
      string,
      string[]
    >;

    expect(baseline["wms.picking_logs"]).toEqual(["modules/orders", "modules/wms"]);
    expect(baseline["wms.orders"]).toEqual([
      "modules/oms",
      "modules/orders",
      "modules/wms",
    ]);
    expect(baseline["wms.order_items"]).toEqual(["modules/wms"]);
    expect(baseline["wms.pick_corrections"]).toEqual(["modules/wms"]);
    expect(baseline["wms.pick_correction_events"]).toEqual(["modules/wms"]);
    expect(baseline["wms.picking_commands"]).toEqual(["modules/wms"]);
    expect(baseline["wms.returns"]).toEqual(["modules/wms"]);
    expect(baseline["wms.return_items"]).toEqual(["modules/wms"]);
    expect(baseline["wms.oms_wms_authority_cleanup_audit"]).toEqual(["modules/wms"]);
    expect(baseline["wms.order_build_demands"]).toEqual(["modules/wms"]);
  });

  it("delegates picking_logs SKU rename through WMS-owned command authority", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 10 }, { id: 11 }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));

    const count = await renameWmsPickingLogSku(
      { update } as any,
      { oldSku: " OLD-SKU-1 ", newSku: " NEW-SKU-1 " },
    );

    expect(count).toBe(2);
    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ sku: "NEW-SKU-1" });
    expect(where).toHaveBeenCalledTimes(1);
    expect(returning).toHaveBeenCalledTimes(1);

    await expect(
      renameWmsPickingLogSku({ update } as any, { oldSku: "   ", newSku: "NEW-SKU-1" }),
    ).rejects.toThrow(/oldSku and newSku are required/);
  });
});
