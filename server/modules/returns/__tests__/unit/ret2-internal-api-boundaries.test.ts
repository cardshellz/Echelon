import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const SERVER_ROOT = path.resolve(__dirname, "../../../..");
const RETURNS_ROOT = path.resolve(__dirname, "../..");

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
        entry.name === "build"
      ) {
        continue;
      }
      results.push(...collectProductionCodeFiles(fullPath));
      continue;
    }
    if (
      entry.isFile() &&
      /\.(ts|tsx|mts|cts|mjs|cjs|js)$/.test(entry.name) &&
      !/\.(test|spec)\./.test(entry.name)
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("RET-2: Returns internal API boundaries (CI-03) and writer-ratchet authority", () => {
  it("forbids production and script files outside server/modules/returns from importing deep module files directly (CI-03)", () => {
    const files = [
      ...collectProductionCodeFiles(SERVER_ROOT),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "client/src")),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "shared")),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "scripts")),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "script")),
    ];
    const targetModule = "server/modules/returns";

    const violations: Array<{ importer: string; specifier: string; resolved: string }> = [];

    for (const filePath of files) {
      const relImporter = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
      if (relImporter === targetModule || relImporter.startsWith(`${targetModule}/`)) {
        continue;
      }

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
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
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
          const resolved = path.posix
            .normalize(path.posix.join(path.posix.dirname(relImporter), specifier))
            .replace(/\.[cm]?[jt]sx?$/, "");

          if (
            resolved !== targetModule &&
            resolved !== `${targetModule}/index` &&
            !resolved.endsWith(".api") &&
            resolved.startsWith(`${targetModule}/`)
          ) {
            violations.push({
              importer: relImporter,
              specifier,
              resolved,
            });
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });

  it("exposes explicit layer-separated *.api.ts facades and index.ts barrel without leaking private repositories or providers (CI-03)", () => {
    const expectedReturnsApis = [
      "index.ts",
      "runtime-workflow.api.ts",
      "shopify-return-intake.api.ts",
      "shopify-snapshot-contracts.api.ts",
      "shopify-snapshot-reader.api.ts",
      "customer-return-access-contracts.api.ts",
      "customer-account-composition.api.ts",
      "customer-account-http.api.ts",
      "routes.api.ts",
    ];
    for (const apiFile of expectedReturnsApis) {
      expect(fs.existsSync(path.join(RETURNS_ROOT, apiFile))).toBe(true);
    }

    const privateInternalModules = [
      "open-return-case.repository",
      "return-case.repository",
      "return-case-financial.repository",
      "return-policy.repository",
      "shopify-customer-refund.provider",
      "return-policy-lock",
    ];
    for (const apiFile of expectedReturnsApis) {
      const content = fs.readFileSync(path.join(RETURNS_ROOT, apiFile), "utf8");
      for (const forbidden of privateInternalModules) {
        expect(content).not.toContain(forbidden);
      }
    }
  });

  it("keeps pure application/domain contract facades free of infrastructure and HTTP interface imports", () => {
    const pureContractFacades = [
      "shopify-snapshot-contracts.api.ts",
      "customer-return-access-contracts.api.ts",
    ];

    for (const apiFile of pureContractFacades) {
      const content = fs.readFileSync(path.join(RETURNS_ROOT, apiFile), "utf8");
      expect(content).not.toContain("./infrastructure/");
      expect(content).not.toContain("./interfaces/");
    }
  });

  it("locks sole-writer ownership of all 42 returns.* tables to modules/returns and wms.returns / wms.return_items to modules/wms", () => {
    const baseline = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "scripts/writer-ratchet/baseline.json"), "utf8"),
    ) as Record<string, string[]>;
    const routeAndScriptBaseline = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "scripts/writer-ratchet/route-and-script-baseline.json"),
        "utf8",
      ),
    ) as { routeWriters: Record<string, string[]>; scriptWriters: Record<string, string[]> };

    const expectedReturnsTables = [
      "returns.customer_login_challenges",
      "returns.customer_return_allocation_case_items",
      "returns.customer_return_authorization_allocations",
      "returns.customer_return_authorization_commands",
      "returns.customer_return_authorization_events",
      "returns.customer_return_authorization_lines",
      "returns.customer_return_authorization_outbox",
      "returns.customer_return_authorizations",
      "returns.customer_return_box_measurements",
      "returns.customer_return_case_links",
      "returns.customer_return_guest_challenges",
      "returns.customer_return_guest_events",
      "returns.customer_return_intakes",
      "returns.customer_return_label_attempts",
      "returns.customer_return_label_control_events",
      "returns.customer_return_label_controls",
      "returns.customer_return_label_events",
      "returns.customer_return_parcel_items",
      "returns.customer_return_parcel_receipt_allocations",
      "returns.customer_return_parcel_receipts",
      "returns.customer_return_parcels",
      "returns.customer_return_quote_decisions",
      "returns.customer_return_submission_commands",
      "returns.customer_return_workflow_events",
      "returns.customer_return_workflows",
      "returns.return_case_commands",
      "returns.return_case_customer_refund_items",
      "returns.return_case_customer_refund_transactions",
      "returns.return_case_customer_refunds",
      "returns.return_case_disposition_items",
      "returns.return_case_dispositions",
      "returns.return_case_events",
      "returns.return_case_inspections",
      "returns.return_case_inventory_treatment_items",
      "returns.return_case_inventory_treatments",
      "returns.return_case_items",
      "returns.return_case_vendor_settlement_ledger_entries",
      "returns.return_case_vendor_settlements",
      "returns.return_cases",
      "returns.return_policies",
      "returns.return_policy_commands",
      "returns.return_policy_shipping",
    ];

    for (const table of expectedReturnsTables) {
      expect(baseline[table]).toEqual(["modules/returns"]);
    }

    const allReturnsBaselineTables = Object.keys(baseline).filter((key) =>
      key.startsWith("returns."),
    );
    expect(allReturnsBaselineTables.length).toBeGreaterThanOrEqual(expectedReturnsTables.length);
    for (const table of allReturnsBaselineTables) {
      expect(baseline[table]).toEqual(["modules/returns"]);
    }

    // Physical WMS return receipt tables remain solely owned by modules/wms:
    expect(baseline["wms.returns"]).toEqual(["modules/wms"]);
    expect(baseline["wms.return_items"]).toEqual(["modules/wms"]);

    // Zero direct route or script writers on returns.* or physical wms.return* tables:
    for (const table of [...allReturnsBaselineTables, "wms.returns", "wms.return_items"]) {
      expect(routeAndScriptBaseline.routeWriters[table]).toBeUndefined();
      expect(routeAndScriptBaseline.scriptWriters[table]).toBeUndefined();
    }
  });
});
