import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MODULES_ROOT = resolve(ROOT, "server/modules");

/**
 * Phase 4 (`P4.3`) — Strict Module Layering Normalization Ratchet.
 *
 * Every normalized module in `server/modules/<mod>` must expose ONLY:
 *   - `index.ts` (public barrel)
 *   - `*.api.ts` (capability-scoped internal API facades, `CI-03`)
 * at its module root directory.
 *
 * All concrete implementation files must reside inside canonical layer
 * subdirectories (`domain/`, `application/`, `infrastructure/`, `interfaces/`,
 * or bounded sub-slices such as `warehouse/work/`), and tests inside `__tests__/`.
 */
const STRICT_LAYERED_MODULES = [
  "cartonization",
  "catalog",
  "catalog-export",
  "customer-account",
  "dropship",
  "identity",
  "integrations",
  "inventory",
  "inventory-planning",
  "marketplace-listings",
  "membership",
  "notifications",
  "operations",
  "order-edits",
  "orders",
  "returns",
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
  "work",
  "integrity",
  "reconcile",
  "__tests__",
]);

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

describe("P4.3 — Module Layering Normalization Ratchet", () => {
  it("keeps all 22 normalized modules strictly free of loose implementation files at module root", () => {
    const rootFileViolations: string[] = [];
    const subDirViolations: string[] = [];
    const missingEntrypoints: string[] = [];

    for (const mod of STRICT_LAYERED_MODULES) {
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

  it("ensures every module in server/modules publishes an index.ts barrel (25/25 modules)", () => {
    const allModules = readdirSync(MODULES_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();

    expect(allModules.length).toBeGreaterThanOrEqual(25);
    const missingIndex = allModules.filter(
      (mod) => !existsSync(resolve(MODULES_ROOT, mod, "index.ts")),
    );
    expect(missingIndex).toEqual([]);
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
