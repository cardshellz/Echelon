import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const SERVER_ROOT = path.resolve(__dirname, "../../../..");

const PRIORITY_13_MODULES = [
  "server/modules/customer-account",
  "server/modules/subscriptions",
  "server/modules/membership",
  "server/modules/identity",
] as const;

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

describe("CUST-2: Customer Account, Subscriptions, Membership & Identity internal API boundaries (CI-03) and writer-ratchet authority", () => {
  it("forbids production and script files outside Priority 13 modules from importing deep module files directly (CI-03)", () => {
    const files = [
      ...collectProductionCodeFiles(SERVER_ROOT),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "client/src")),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "shared")),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "scripts")),
      ...collectProductionCodeFiles(path.resolve(REPO_ROOT, "script")),
    ];

    const violations: Array<{
      targetModule: string;
      importer: string;
      specifier: string;
      resolved: string;
    }> = [];

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

          for (const targetModule of PRIORITY_13_MODULES) {
            if (
              relImporter === targetModule ||
              relImporter.startsWith(`${targetModule}/`)
            ) {
              continue;
            }
            if (
              resolved !== targetModule &&
              resolved !== `${targetModule}/index` &&
              !resolved.endsWith(".api") &&
              resolved.startsWith(`${targetModule}/`)
            ) {
              violations.push({
                targetModule,
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

  it("exposes explicit layer-separated *.api.ts facades and index.ts barrels across all 4 modules (CI-03)", () => {
    const expectedFacades: Record<string, string[]> = {
      "server/modules/customer-account": [
        "index.ts",
        "staging-config.api.ts",
        "account-native-contracts.api.ts",
        "order-cancellation-contracts.api.ts",
        "order-action-projection-contracts.api.ts",
        "progress-contracts.api.ts",
        "order-action-invalidation.api.ts",
        "shopify-account-native.api.ts",
        "order-action-projection.api.ts",
        "runtime.api.ts",
        "routes.api.ts",
      ],
      "server/modules/subscriptions": [
        "index.ts",
        "pick-priority-plans.api.ts",
        "runtime-scheduler.api.ts",
        "routes.api.ts",
      ],
      "server/modules/membership": [
        "index.ts",
        "member-resolution-contracts.api.ts",
        "runtime-readers.api.ts",
      ],
      "server/modules/identity": [
        "index.ts",
        "authority-contracts.api.ts",
        "purchase-approval-authority.api.ts",
        "command-authority.api.ts",
        "staff-authority.api.ts",
        "staff-session.api.ts",
        "routes.api.ts",
      ],
    };

    for (const [moduleDir, files] of Object.entries(expectedFacades)) {
      for (const apiFile of files) {
        expect(fs.existsSync(path.join(REPO_ROOT, moduleDir, apiFile))).toBe(true);
      }
    }

    // Pure contract facades must stay free of infrastructure/HTTP imports
    const pureContractFacades = [
      "server/modules/customer-account/staging-config.api.ts",
      "server/modules/customer-account/account-native-contracts.api.ts",
      "server/modules/customer-account/order-cancellation-contracts.api.ts",
      "server/modules/customer-account/order-action-projection-contracts.api.ts",
      "server/modules/customer-account/progress-contracts.api.ts",
      "server/modules/membership/member-resolution-contracts.api.ts",
      "server/modules/identity/authority-contracts.api.ts",
    ];

    for (const relPath of pureContractFacades) {
      const content = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      expect(content).not.toContain("./infrastructure/");
      expect(content).not.toContain("./interfaces/");
      expect(content).not.toContain("../../db");
      expect(content).not.toContain("../../../db");
    }

    // Transaction-scoped authority & invalidation facades must not import database singletons
    const dbSingletonFreeFacades = [
      "server/modules/customer-account/order-action-invalidation.api.ts",
      "server/modules/identity/purchase-approval-authority.api.ts",
      "server/modules/identity/command-authority.api.ts",
      "server/modules/identity/staff-authority.api.ts",
    ];
    for (const relPath of dbSingletonFreeFacades) {
      const content = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      expect(content).not.toContain("../../db");
      expect(content).not.toContain("../../../db");
    }

    // Subscriptions facades must not leak raw Shopify contract mutation adapter
    for (const apiFile of expectedFacades["server/modules/subscriptions"]) {
      const content = fs.readFileSync(
        path.join(REPO_ROOT, "server/modules/subscriptions", apiFile),
        "utf8",
      );
      expect(content).not.toContain("shopify.adapter");
    }
  });

  it("locks sole-writer ownership for customer-account, subscriptions/membership.plans, read-only membership, and identity.* tables", () => {
    const baseline = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "scripts/writer-ratchet/baseline.json"), "utf8"),
    ) as Record<string, string[]>;
    const routeAndScriptBaseline = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "scripts/writer-ratchet/route-and-script-baseline.json"),
        "utf8",
      ),
    ) as { routeWriters: Record<string, string[]>; scriptWriters: Record<string, string[]> };

    // 1. membership module is strictly read-only across the entire schema
    for (const writers of Object.values(baseline)) {
      expect(writers).not.toContain("modules/membership");
    }

    // 2. membership.plans and subscription tables belong solely to modules/subscriptions (no route writers!)
    const subscriptionOwnedTables = [
      "membership.member_current_membership",
      "membership.member_subscriptions",
      "membership.members",
      "membership.plans",
      "membership.selling_plan_map",
      "membership.subscription_billing_attempts",
      "membership.subscription_events",
    ];
    for (const table of subscriptionOwnedTables) {
      expect(baseline[table]).toEqual(["modules/subscriptions"]);
      expect(routeAndScriptBaseline.routeWriters[table]).toBeUndefined();
      expect(routeAndScriptBaseline.scriptWriters[table]).toBeUndefined();
    }

    // 3. customer-account projection tables belong solely to modules/customer-account
    const customerAccountTables = [
      "oms.customer_account_native_cursors",
      "oms.customer_account_native_summaries",
      "oms.customer_order_action_invalidations",
      "oms.customer_order_actions",
    ];
    for (const table of customerAccountTables) {
      expect(baseline[table]).toEqual(["modules/customer-account"]);
      expect(routeAndScriptBaseline.routeWriters[table]).toBeUndefined();
      expect(routeAndScriptBaseline.scriptWriters[table]).toBeUndefined();
    }

    // 4. identity.* tables belong solely to modules/identity
    const identityTables = [
      "identity.auth_permissions",
      "identity.auth_role_permissions",
      "identity.auth_roles",
      "identity.auth_user_roles",
      "identity.staff_credentials",
      "identity.users",
    ];
    for (const table of identityTables) {
      expect(baseline[table]).toEqual(["modules/identity"]);
      expect(routeAndScriptBaseline.routeWriters[table]).toBeUndefined();
      expect(routeAndScriptBaseline.scriptWriters[table]).toBeUndefined();
    }
  });

  it("delegates pick-priority plan reads and priority_modifier writes through subscriptions/pick-priority-plans.api", async () => {
    const pickPrioritySrc = fs.readFileSync(
      path.join(REPO_ROOT, "server/routes/pick-priority.routes.ts"),
      "utf8",
    );
    expect(pickPrioritySrc).toContain('../modules/subscriptions/pick-priority-plans.api');
    expect(pickPrioritySrc).toContain("updatePlanModifiersUseCase(planModifierUpdates, actor)");
    expect(pickPrioritySrc).not.toMatch(/UPDATE\s+membership\.plans/i);

    const { readPickPriorityPlans } = await import(
      "../../../subscriptions/pick-priority-plans.api"
    );
    const fakeExecutor = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          {
            id: "gold",
            name: "Gold Club",
            tier_level: 1,
            priority_modifier: 50,
            primary_color: "#FFD700",
            is_active: true,
          },
          {
            id: "legacy",
            name: null,
            tier_level: null,
            priority_modifier: null,
            primary_color: null,
            is_active: false,
          },
        ],
      }),
    };

    const plans = await readPickPriorityPlans(fakeExecutor as any);
    expect(plans).toEqual([
      {
        id: "gold",
        name: "Gold Club",
        tierLevel: 1,
        priorityModifier: 50,
        primaryColor: "#FFD700",
        isActive: true,
      },
      {
        id: "legacy",
        name: "(unnamed plan)",
        tierLevel: null,
        priorityModifier: 0,
        primaryColor: null,
        isActive: false,
      },
    ]);
  });
});
