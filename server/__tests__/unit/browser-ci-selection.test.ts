import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BROWSER_SUITES, dependencyClosure, parseChangedFiles, runSelection, selectBrowserSuite,
} from "../../../scripts/ci/browser-suite-impact.mjs";

function fixture(extra: Record<string, string> = {}) {
  const sources: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { react: "1", "@playwright/test": "1" } }),
    "client/src/App.tsx": 'import "@/components/layout/AppShell"; import "@/pages/Unrelated"; import "@/pages/PurchaseOrders";',
    "client/src/components/layout/AppShell.tsx": 'import "@/components/SharedBanner";',
    "client/src/components/SharedBanner.tsx": "export const banner = true;",
    "client/src/pages/Unrelated.tsx": 'import "@/components/shipping/BoxSuitesPanel"; export const unrelated = true;',
    "client/src/pages/PurchaseOrders.tsx": "export const purchases = true;",
    "client/src/features/unrelated/Isolated.ts": "export const isolated = true;",
    "client/src/components/shipping/BoxSuitesPanel.tsx": "export const boxes = true;",
    "test/browser/procurement-navigation.spec.ts": 'import "@playwright/test";',
    "test/browser/dropship-pricing-rules.spec.ts": 'import "@playwright/test";',
    ...Object.fromEntries(Object.values(BROWSER_SUITES).flatMap((suite) => suite.roots.map((root: string) => [root, ""]))),
    "client/src/main.tsx": 'import "./App";',
    ...extra,
  };
  return { files: new Set(Object.keys(sources)), readSource: (file: string) => {
    if (!(file in sources)) throw new Error(`Missing fixture source: ${file}`);
    return sources[file];
  } };
}

function selection(file: string, suite = "procurement", extra: Record<string, string> = {}) {
  return selectBrowserSuite({ suite, changes: [{ status: "M", paths: [file] }], ...fixture(extra) });
}

describe("browser CI impact selection", () => {
  it("preserves eagerly imported packaging startup dependencies in procurement", () => {
    const source = "client/src/components/shipping/BoxSuitesPanel.tsx";
    expect(selection(source).reason).toBe(`Transitive suite dependency: ${source}`);
    expect(selection(source, "dropship").run).toBe(true);
  });

  it("follows transitive cross-feature imports, barrel exports, and cycles", () => {
    const changed = "client/src/features/logistics/Costs.tsx";
    const result = selection(changed, "procurement", {
      "client/src/pages/PurchaseOrders.tsx": 'import { cost } from "@/features/logistics";',
      "client/src/features/logistics/index.ts": 'export { cost } from "./Costs";',
      [changed]: 'import "./index"; export const cost = 1;',
    });
    expect(result).toEqual({ run: true, reason: `Transitive suite dependency: ${changed}` });
  });

  it.each([
    'const component = import("@/features/logistics/Costs");',
    'const component = require("@/features/logistics/Costs");',
    'type Component = import("@/features/logistics/Costs").Component;',
    'import Component = require("@/features/logistics/Costs");',
    'export type { Component } from "@/features/logistics/Costs";',
  ])("follows supported dynamic and type import syntax: %s", (source) => {
    const changed = "client/src/features/logistics/Costs.tsx";
    expect(selection(changed, "procurement", {
      "client/src/pages/PurchaseOrders.tsx": source,
      [changed]: "export type Component = string;",
    }).reason).toBe(`Transitive suite dependency: ${changed}`);
  });

  it("tracks shared shell and eager page imports but can skip a genuinely unimported feature", () => {
    expect(selection("client/src/components/SharedBanner.tsx").reason).toContain("Transitive suite dependency");
    expect(selection("client/src/pages/Unrelated.tsx").run).toBe(true);
    expect(selection("client/src/features/unrelated/Isolated.ts").run).toBe(false);
  });

  it("includes HTML-injected harness roots and their transitive imports", () => {
    const changed = "client/src/features/estimates/Estimate.tsx";
    expect(selection(changed, "dropship", {
      "test/browser/fixtures/dropship-shipping-estimate-harness.tsx": 'import "@/features/estimates/Estimate";',
      [changed]: "export const estimate = true;",
    }).reason).toBe(`Transitive suite dependency: ${changed}`);
    expect(selection("test/browser/fixtures/shared-shipping-configuration-harness.tsx", "dropship").run).toBe(true);
  });

  it.each([
    "client/src/App.tsx", "client/src/main.tsx", "client/index.html", "client/src/components/ui/button.tsx",
    "client/src/hooks/use-anything.ts", "client/src/lib/auth.ts", "client/src/styles/brand.css",
    "shared/schema/any.ts", "client/public/logo.svg", "attached_assets/label.png", "package-lock.json",
    "vite.config.ts", "vite-plugin-meta-images.ts", "tailwind.config.ts", "postcss.config.js", "tsconfig.json",
    "scripts/ci/browser-suite-impact.mjs",
  ])("always runs shared UI, hooks, libraries, assets and toolchain: %s", (file) => {
    for (const suite of ["procurement", "dropship"]) expect(selection(file, suite, { [file]: "" }).run).toBe(true);
  });

  it.each(["D", "R100", "C100"])("fails open for changed dependency history: %s", (status) => {
    const paths = status === "D" ? ["client/src/pages/Old.tsx"] : ["client/src/pages/Old.tsx", "client/src/pages/New.tsx"];
    expect(selectBrowserSuite({ suite: "procurement", changes: [{ status, paths }], ...fixture() }).run).toBe(true);
  });

  it.each([
    'import "./missing";',
    'const value = import(variable);',
    'const value = import.meta.glob("./*.tsx");',
    'import "#unknownAlias/Costs";',
    'import "@unconfigured/alias";',
    'const value = (;',
  ])("fails open when dependency analysis is uncertain: %s", (source) => {
    const result = selection("client/src/pages/Unrelated.tsx", "procurement", {
      "client/src/pages/PurchaseOrders.tsx": source,
    });
    expect(result.run).toBe(true);
    expect(result.reason).toContain("Dependency analysis was uncertain");
  });

  it("fails open for a missing changed path, unknown path, missing roots or missing tests", () => {
    expect(selection("client/src/pages/Removed.tsx").run).toBe(true);
    expect(selection("new-runtime/entry.js", "procurement", { "new-runtime/entry.js": "" }).run).toBe(true);
    const missingRoot = fixture();
    missingRoot.files.delete(BROWSER_SUITES.procurement.roots[0]);
    expect(selectBrowserSuite({ suite: "procurement", changes: [{ status: "M", paths: ["client/src/pages/Unrelated.tsx"] }], ...missingRoot }).run).toBe(true);
    const missingTests = fixture();
    missingTests.files.delete("test/browser/procurement-navigation.spec.ts");
    expect(selectBrowserSuite({ suite: "procurement", changes: [{ status: "M", paths: ["client/src/pages/Unrelated.tsx"] }], ...missingTests }).run).toBe(true);
  });

  it("forces full coverage for manual dispatch and missing diff evidence", () => {
    expect(selectBrowserSuite({ suite: "procurement", changes: [], ...fixture() }).run).toBe(true);
    expect(selectBrowserSuite({ suite: "procurement", changes: [], force: true, ...fixture() }).reason).toContain("Manual dispatch");
    expect(runSelection({ BROWSER_SUITE: "procurement", BROWSER_EVENT_NAME: "workflow_dispatch" }).run).toBe(true);
    expect(runSelection({ BROWSER_SUITE: "procurement", BROWSER_BASE_SHA: "main; echo injected", BROWSER_HEAD_SHA: "0".repeat(40) }).run).toBe(true);
  });

  it("handles NUL-delimited filenames without splitting whitespace, newlines, or rename records", () => {
    expect(parseChangedFiles("M\0client/src/pages/A B\nC.tsx\0R100\0old.ts\0new.ts\0")).toEqual([
      { status: "M", paths: ["client/src/pages/A B\nC.tsx"] }, { status: "R100", paths: ["old.ts", "new.ts"] },
    ]);
    for (const invalid of ["M\0", "R100\0old.ts\0", "X\0file.ts\0", "M\0../outside\0"]) {
      expect(() => parseChangedFiles(invalid)).toThrow();
    }
  });

  it("resolves assets and .js specifiers to TypeScript sources without evaluating code", () => {
    const sources = fixture({
      "client/src/pages/PurchaseOrders.tsx": 'import "./Dependency.js"; import "@assets/logo.svg?url";',
      "client/src/pages/Dependency.ts": 'import "node:fs";',
      "attached_assets/logo.svg": "<svg/>",
    });
    const graph = dependencyClosure(["client/src/pages/PurchaseOrders.tsx"], sources.files, sources.readSource);
    expect(graph.has("client/src/pages/Dependency.ts")).toBe(true);
    expect(graph.has("attached_assets/logo.svg")).toBe(true);
  });

  it("preserves the current real application startup graph for packaging-only changes", () => {
    const files = new Set(execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean));
    const result = selectBrowserSuite({ suite: "procurement", changes: [{ status: "M", paths: ["client/src/components/shipping/BoxSuitesPanel.tsx"] }],
      files, readSource: (file: string) => readFileSync(file, "utf8") });
    expect(result).toEqual({ run: true, reason: "Transitive suite dependency: client/src/components/shipping/BoxSuitesPanel.tsx" });
  });

  it("registers every current HTML-injected dropship harness as a dependency root", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    const harnesses = new Set<string>();
    for (const file of files.filter((file) => BROWSER_SUITES.dropship.tests.test(file))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/["'](test\/browser\/fixtures\/[^"']+\.tsx)["']/g)) harnesses.add(match[1]);
    }
    expect([...harnesses].sort()).toEqual([...BROWSER_SUITES.dropship.roots].sort());
  });
});
