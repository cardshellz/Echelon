import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MODULES_ROOT = resolve(ROOT, "server/modules");

/**
 * Phase 4 (`P4.3`) & Phase 2 (`P2.1` / `CI-03`) — Universal 26/26 Module Layering
 * and Cross-Module `.api.ts` / `index.ts` Boundary Ratchet.
 *
 * 1. Every module in `server/modules/<mod>` (`26/26` — 100% of modules, including
 *    any future module added to `server/modules/`) must expose ONLY:
 *      - `index.ts` (public barrel)
 *      - `*.api.ts` (capability-scoped internal API facades, `CI-03`)
 *    at its module root directory (`0` loose implementation files at root).
 * 2. Every production cross-module import from `server/modules/<A>/**` into
 *    `server/modules/<B>/**` (`A !== B`) must target `<B>/index.ts` or
 *    `<B>/*.api.ts` (except the single ratified same-transaction read projection
 *    locked by `shipment-context-boundary.test.ts`).
 */
const EXPECTED_ALL_26_MODULES = [
  "cartonization",
  "catalog",
  "catalog-export",
  "channels",
  "customer-account",
  "dropship",
  "identity",
  "integrations",
  "inventory",
  "inventory-planning",
  "marketplace-listings",
  "membership",
  "notifications",
  "oms",
  "operations",
  "order-edits",
  "orders",
  "procurement",
  "returns",
  "shipping",
  "shipping-engine",
  "shopify",
  "subscriptions",
  "sync",
  "warehouse",
  "wms",
] as const;

const ALLOWED_SUBDIRECTORIES = new Set([
  "domain",
  "application",
  "infrastructure",
  "interfaces",
  // Bounded sub-slices within large domain modules
  "work",
  "integrity",
  "reconcile",
  "adapters",
  "listing-connectors",
  "reconcilers",
  "shipstation",
  "purchasing",
  "__tests__",
]);

const RATIFIED_PRIVATE_PARTICIPANT_CALLER =
  "server/modules/shipping/infrastructure/outbound-shipment-access.query.ts";
const RATIFIED_PRIVATE_PARTICIPANT_TARGET =
  "server/modules/orders/infrastructure/shipment-order-context.query";

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "build" || entry.startsWith(".")) {
      continue;
    }
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

describe("P4.3 & P2.1 — Universal 26/26 Module Layering & Cross-Module Boundary Ratchet", () => {
  it("keeps 100% of modules in server/modules (all 26/26 modules) strictly free of loose root implementation files", () => {
    const discoveredModules = readdirSync(MODULES_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();

    expect(discoveredModules).toEqual([...EXPECTED_ALL_26_MODULES].sort());

    const rootFileViolations: string[] = [];
    const subDirViolations: string[] = [];
    const missingEntrypoints: string[] = [];

    for (const mod of discoveredModules) {
      const modDir = resolve(MODULES_ROOT, mod);
      if (!existsSync(resolve(modDir, "index.ts"))) {
        missingEntrypoints.push(`${mod}/index.ts`);
      }

      const entries = readdirSync(modDir, { withFileTypes: true });
      const apiFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".api.ts"));
      if (apiFiles.length === 0) {
        missingEntrypoints.push(`${mod}/*.api.ts`);
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!ALLOWED_SUBDIRECTORIES.has(entry.name)) {
            subDirViolations.push(`server/modules/${mod}/${entry.name}/`);
          }
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name === "index.ts" || entry.name.endsWith(".api.ts") || entry.name === "README.md") {
          continue;
        }
        rootFileViolations.push(`server/modules/${mod}/${entry.name}`);
      }
    }

    expect(missingEntrypoints).toEqual([]);
    expect(subDirViolations).toEqual([]);
    expect(rootFileViolations).toEqual([]);
  });

  it("enforces zero unratified cross-module deep imports across all 26/26 modules in server/modules (P2.1 / CI-03)", () => {
    const moduleFiles = walkTsFiles(MODULES_ROOT).filter(
      (f) =>
        !f.includes(`${sep}__tests__${sep}`) &&
        !f.includes(`${sep}test${sep}`) &&
        !/\.(?:test|spec)\.ts$/.test(f),
    );

    expect(moduleFiles.length).toBeGreaterThan(1000);
    const violations: string[] = [];

    for (const file of moduleFiles) {
      const relImporter = relative(ROOT, file).split(sep).join("/");
      const fromModMatch = /^server\/modules\/([^/]+)\//.exec(relImporter);
      if (!fromModMatch) continue;
      const fromMod = fromModMatch[1];

      const content = readFileSync(file, "utf8");
      const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);

      const checkSpec = (spec: string) => {
        if (!spec.startsWith(".")) return;
        const clean = spec.replace(/[?#].*$/, "");
        const resolvedTarget = resolve(file, "..", clean);
        const relTarget = relative(ROOT, resolvedTarget)
          .split(sep)
          .join("/")
          .replace(/\.[cm]?[jt]sx?$/, "");

        const toModMatch = /^server\/modules\/([^/]+)(?:\/(.+))?$/.exec(relTarget);
        if (!toModMatch) return;
        const toMod = toModMatch[1];
        const subPath = toModMatch[2] ?? "";

        if (
          toMod === fromMod ||
          subPath === "" ||
          subPath === "index" ||
          subPath.endsWith(".api")
        ) {
          return;
        }
        if (
          relImporter === RATIFIED_PRIVATE_PARTICIPANT_CALLER &&
          relTarget === RATIFIED_PRIVATE_PARTICIPANT_TARGET
        ) {
          return;
        }
        violations.push(`${relImporter} -> ${spec} (${relTarget})`);
      };

      const visit = (node: ts.Node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteralLike(node.moduleSpecifier)
        ) {
          checkSpec(node.moduleSpecifier.text);
        } else if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference) &&
          node.moduleReference.expression &&
          ts.isStringLiteralLike(node.moduleReference.expression)
        ) {
          checkSpec(node.moduleReference.expression.text);
        } else if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteralLike(node.argument.literal)
        ) {
          checkSpec(node.argument.literal.text);
        } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
          const exprText = node.expression.getText(sf);
          if (
            (node.expression.kind === ts.SyntaxKind.ImportKeyword || exprText === "require") &&
            ts.isStringLiteralLike(node.arguments[0])
          ) {
            checkSpec(node.arguments[0].text);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    expect(violations).toEqual([]);
  });

  it("blocks production and script callers outside shopify, integrations & catalog-export from bypassing .api.ts / index.ts", () => {
    const scanRoots = ["server", "scripts", "script", "shared", "client"].map((d) => resolve(ROOT, d));
    const files = scanRoots
      .flatMap((r) => walkTsFiles(r))
      .filter((f) => !f.includes(`${sep}__tests__${sep}`) && !/\.test\.ts$/.test(f));

    const protectedLeafModules = [
      "server/modules/shopify",
      "server/modules/integrations",
      "server/modules/catalog-export",
    ] as const;

    const violations: string[] = [];

    for (const file of files) {
      const relImporter = relative(ROOT, file).split(sep).join("/");
      const content = readFileSync(file, "utf8");
      if (
        !content.includes("shopify") &&
        !content.includes("integrations") &&
        !content.includes("catalog-export")
      ) {
        continue;
      }

      const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        let spec: string | null = null;
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteralLike(node.moduleSpecifier)
        ) {
          spec = node.moduleSpecifier.text;
        } else if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length >= 1 &&
          ts.isStringLiteralLike(node.arguments[0])
        ) {
          spec = node.arguments[0].text;
        }

        if (spec && spec.startsWith(".")) {
          const resolvedTarget = resolve(file, "..", spec);
          const relTarget = relative(ROOT, resolvedTarget)
            .split(sep)
            .join("/")
            .replace(/\.[cm]?[jt]sx?$/, "");

          for (const targetMod of protectedLeafModules) {
            if (relImporter === targetMod || relImporter.startsWith(`${targetMod}/`)) {
              continue;
            }
            if (
              relTarget !== targetMod &&
              relTarget !== `${targetMod}/index` &&
              !relTarget.endsWith(".api") &&
              relTarget.startsWith(`${targetMod}/`)
            ) {
              violations.push(`${relImporter} -> ${spec} (${relTarget})`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    expect(violations).toEqual([]);
  });
});
