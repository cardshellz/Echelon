import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { confirmProductVariantShipsInOwnContainer } from "../../../catalog/variant-shipping-flags.api";
import { recordShippingVariantSiocDecision } from "../../../shipping-engine/infrastructure/shipping-admin.repository";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const SERVER_ROOT = path.resolve(__dirname, "../../../..");
const SHIPPING_ROOT = path.resolve(__dirname, "../..");
const SHIPPING_ENGINE_ROOT = path.resolve(SERVER_ROOT, "modules/shipping-engine");

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

describe("SHP-2: Shipping and Shipping Engine internal API boundaries (CI-03) and writer-ratchet authority", () => {
  it("forbids production and script files outside shipping and shipping-engine from importing deep module files directly (CI-03)", () => {
    const files = [
      ...collectProductionCodeFiles(SERVER_ROOT),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "client/src")),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "scripts")),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "script")),
    ];
    const protectedModules = [
      "server/modules/shipping",
      "server/modules/shipping-engine",
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
      };

      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });

  it("exposes explicit capability-scoped *.api.ts facades and index.ts barrels for shipping and shipping-engine (CI-03)", () => {
    const expectedShippingApis = [
      "index.ts",
      "engine-and-reconcile.api.ts",
      "carrier-tracking-and-dispatch.api.ts",
      "shipstation-tracking-transport.api.ts",
      "package-allocation-authority.api.ts",
      "declared-package-lifecycle.api.ts",
      "shipstation-provider-reconciliation.api.ts",
      "historical-shipstation-contents.api.ts",
      "package-history-and-delivery.api.ts",
      "outbound-shipment-queries.api.ts",
    ];
    for (const apiFile of expectedShippingApis) {
      expect(fs.existsSync(path.join(SHIPPING_ROOT, apiFile))).toBe(true);
    }

    const expectedShippingEngineApis = [
      "index.ts",
      "rate-quoting-and-policy.api.ts",
      "fulfillment-routing-and-connections.api.ts",
      "shared-packaging-configuration.api.ts",
      "return-shipping-and-labels.api.ts",
      "routes.api.ts",
    ];
    for (const apiFile of expectedShippingEngineApis) {
      expect(fs.existsSync(path.join(SHIPPING_ENGINE_ROOT, apiFile))).toBe(true);
    }
  });

  it("preserves paused ORG-1 non-live packing boundaries inside shipping-engine without promoting packing.service externally", () => {
    expect(
      fs.existsSync(path.join(SHIPPING_ENGINE_ROOT, "application/packing.service.ts")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(SHIPPING_ENGINE_ROOT, "interfaces/http/packing.routes.ts")),
    ).toBe(true);

    const engineApiFiles = [
      "index.ts",
      "rate-quoting-and-policy.api.ts",
      "fulfillment-routing-and-connections.api.ts",
      "shared-packaging-configuration.api.ts",
      "return-shipping-and-labels.api.ts",
    ];
    for (const apiFile of engineApiFiles) {
      const content = fs.readFileSync(path.join(SHIPPING_ENGINE_ROOT, apiFile), "utf8");
      expect(content).not.toContain("packing.service");
    }
  });

  it("shrinks catalog.product_variants and shipping-admin.routes.ts route writers while locking sole-writer shipping.* and wms.* tables", () => {
    const baseline = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "scripts/writer-ratchet/baseline.json"), "utf8"),
    ) as Record<string, string[]>;
    const routeAndScriptBaseline = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "scripts/writer-ratchet/route-and-script-baseline.json"),
        "utf8",
      ),
    ) as { routeWriters: Record<string, string[]>; scriptWriters: Record<string, string[]> };

    // Catalog SIOC confirmation delegated to modules/catalog:
    expect(baseline["catalog.product_variants"]).not.toContain("modules/shipping-engine");
    expect(routeAndScriptBaseline.routeWriters["catalog.product_variants"]).not.toContain(
      "server/modules/shipping-engine/shipping-admin.routes.ts",
    );
    expect(routeAndScriptBaseline.routeWriters["shipping.service_levels"]).toBeUndefined();
    expect(routeAndScriptBaseline.routeWriters["shipping.variant_shipping_attrs"]).toBeUndefined();

    // Sole-writer shipping.* tables owned by modules/shipping-engine:
    const shippingEngineSoleTables = [
      "shipping.box_catalog",
      "shipping.box_suites",
      "shipping.channel_policies",
      "shipping.channel_policy_routes",
      "shipping.configuration_commands",
      "shipping.destination_scopes",
      "shipping.fulfillment_provider_connections",
      "shipping.fulfillment_provider_credentials",
      "shipping.fulfillment_routing_profiles",
      "shipping.quote_snapshots",
      "shipping.rate_books",
      "shipping.rate_book_assignments",
      "shipping.rate_rules",
      "shipping.rate_tables",
      "shipping.rate_table_rows",
      "shipping.service_levels",
      "shipping.variant_shipping_attrs",
    ];
    for (const table of shippingEngineSoleTables) {
      expect(baseline[table]).toEqual(["modules/shipping-engine"]);
    }

    // Sole-writer carrier tracking, dispatch, label, and package-allocation tables owned by modules/shipping:
    const shippingSoleTables = [
      "wms.carrier_dispatch_commands",
      "wms.carrier_dispatch_attempts",
      "wms.carrier_tracking_events",
      "wms.carrier_tracking_subscriptions",
      "wms.carrier_tracking_webhook_receipts",
      "wms.package_allocation_plans",
      "wms.package_allocation_entries",
      "wms.package_allocation_effect_outbox",
      "wms.sales_channel_delivery_evidence",
      "wms.saved_label_status_jobs",
      "wms.shipping_package_history_jobs",
      "wms.shipping_provider_labels",
      "wms.shipping_provider_label_events",
    ];
    for (const table of shippingSoleTables) {
      expect(baseline[table]).toEqual(["modules/shipping"]);
    }
  });

  it("delegates SIOC confirmation to Catalog within the same transaction while resolving suggestion state", async () => {
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set: updateSet }));

    await confirmProductVariantShipsInOwnContainer(42, { update } as any);
    expect(update).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ shipsInOwnContainer: true, updatedAt: expect.any(Date) }),
    );
    expect(updateWhere).toHaveBeenCalledTimes(1);

    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values: insertValues }));
    const selectLimit = vi.fn().mockResolvedValue([{ id: 77 }]);
    const selectWhere = vi.fn(() => ({ limit: selectLimit }));
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from: selectFrom }));

    const tx = { select, update, insert };
    const transaction = vi.fn(async (fn: (txArg: any) => Promise<any>) => fn(tx));

    const confirmedResult = await recordShippingVariantSiocDecision(
      { productVariantId: 77, confirmed: true },
      { transaction } as any,
    );
    expect(confirmedResult).toEqual({ productVariantId: 77, confirmed: true });
    expect(update).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenCalledTimes(1);

    const dismissedResult = await recordShippingVariantSiocDecision(
      { productVariantId: 77, confirmed: false },
      { transaction } as any,
    );
    expect(dismissedResult).toEqual({ productVariantId: 77, confirmed: false });
    // Dismissing does NOT mutate catalog.product_variants:
    expect(update).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenCalledTimes(2);
  });
});
