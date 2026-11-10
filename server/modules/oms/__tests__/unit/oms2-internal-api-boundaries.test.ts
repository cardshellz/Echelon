import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  repairShopifyOmsOrderCustomer,
  countOmsOrdersMissingCustomerName,
} from "../../shopify-intake.api";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const SERVER_ROOT = path.resolve(__dirname, "../../../..");
const OMS_ROOT = path.resolve(__dirname, "../..");
const ORDER_EDITS_ROOT = path.resolve(SERVER_ROOT, "modules/order-edits");
const SYNC_ROOT = path.resolve(SERVER_ROOT, "modules/sync");

function collectProductionTypeScriptFiles(dir: string): string[] {
  const results: string[] = [];
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
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("OMS-2: OMS, Order-Edits, and Sync internal API boundaries (CI-03) and sole-writer authority", () => {
  it("forbids production files outside oms, order-edits, and sync from importing deep module files directly (CI-03)", () => {
    const files = collectProductionTypeScriptFiles(SERVER_ROOT);
    const protectedModules = [
      "server/modules/oms",
      "server/modules/order-edits",
      "server/modules/sync",
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
      }

      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });

  it("exposes explicit *.api.ts facades and index.ts barrels for oms, order-edits, and sync (CI-03)", () => {
    const expectedOmsApis = [
      "index.ts",
      "dropship-order-authority.api.ts",
      "order-linkage-sql.api.ts",
      "order-edit-coordination.api.ts",
      "webhook-retry.api.ts",
      "channel-order-intake.api.ts",
      "shopify-intake.api.ts",
      "channel-fulfillment-authority.api.ts",
      "shipstation-execution.api.ts",
      "operations-observability.api.ts",
    ];
    for (const apiFile of expectedOmsApis) {
      expect(fs.existsSync(path.join(OMS_ROOT, apiFile))).toBe(true);
    }

    const expectedOrderEditsApis = [
      "index.ts",
      "oms-coordination.api.ts",
      "customer-account.api.ts",
      "runtime.api.ts",
    ];
    for (const apiFile of expectedOrderEditsApis) {
      expect(fs.existsSync(path.join(ORDER_EDITS_ROOT, apiFile))).toBe(true);
    }

    const expectedSyncApis = ["index.ts", "sync-recovery.api.ts"];
    for (const apiFile of expectedSyncApis) {
      expect(fs.existsSync(path.join(SYNC_ROOT, apiFile))).toBe(true);
    }
  });

  it("enforces modules/oms as the sole writer to oms.oms_orders, oms.oms_order_lines, and oms.oms_order_events in writer-ratchet baseline", () => {
    const baselinePath = path.join(REPO_ROOT, "scripts/writer-ratchet/baseline.json");
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as Record<
      string,
      string[]
    >;

    expect(baseline["oms.oms_orders"]).toEqual(["modules/oms"]);
    expect(baseline["oms.oms_order_lines"]).toEqual(["modules/oms"]);
    expect(baseline["oms.oms_order_events"]).toEqual(["modules/oms"]);
    expect(baseline["oms.order_edit_operations"]).toEqual(["modules/order-edits"]);
    expect(baseline["oms.order_edit_events"]).toEqual(["modules/order-edits"]);
    expect(baseline["oms.order_edit_settings"]).toEqual(["modules/order-edits"]);
  });

  it("delegates Shopify OMS customer repair through OMS-owned command authority", async () => {
    const txExecute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ channel_id: 36 }] })
      .mockResolvedValueOnce({ rows: [{ id: 501 }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const db = {
      transaction: vi.fn(async (cb: (tx: { execute: typeof txExecute }) => Promise<number>) =>
        cb({ execute: txExecute }),
      ),
      execute: vi.fn().mockResolvedValueOnce({ rows: [{ count: "3" }] }),
    };

    const updatedCount = await repairShopifyOmsOrderCustomer(
      db,
      {
        shopDomain: "cardshellz.myshopify.com",
        externalOrderId: "gid://shopify/Order/99887766",
        numericOrderId: "99887766",
      },
      {
        customerName: "Ada Lovelace",
        customerEmail: "ada@example.com",
        shippingName: "Ada Lovelace",
        shippingAddress1: "12 Analytical Engine Way",
        shippingAddress2: null,
        shippingCity: "London",
        shippingState: "LN",
        shippingPostalCode: "EC1A 1BB",
        shippingCountry: "GB",
      },
    );

    expect(updatedCount).toBe(1);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(txExecute).toHaveBeenCalledTimes(3);

    const missingCount = await countOmsOrdersMissingCustomerName(db);
    expect(missingCount).toBe(3);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});
