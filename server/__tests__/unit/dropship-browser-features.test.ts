import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dependencyClosure } from "../../../scripts/ci/browser-suite-impact.mjs";
import {
  DROPSHIP_BROWSER_FEATURES, DROPSHIP_BROWSER_TEST_PATTERN, dropshipFeatureTestMatch,
  validateDropshipFeatureCoverage,
} from "../../../scripts/ci/dropship-browser-features.mjs";
import {
  fullDropshipBrowserPlan, runDropshipBrowserSelection, selectDropshipBrowserFeatures,
} from "../../../scripts/ci/dropship-browser-impact.mjs";

function repositorySources() {
  const files = new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" }).split("\0").filter(Boolean));
  return { files, readSource: (file: string) => readFileSync(file, "utf8") };
}

function fixture(extra: Record<string, string> = {}) {
  const sources: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { react: "1", "@playwright/test": "1" } }),
    ...Object.fromEntries(Object.values(DROPSHIP_BROWSER_FEATURES).flatMap(group =>
      [...group.roots, ...group.tests].map(file => [file, ""]))),
    "docs/example.md": "Documentation",
    ...extra,
  };
  return { files: new Set(Object.keys(sources)), readSource: (file: string) => {
    if (!(file in sources)) throw new Error(`Missing fixture source: ${file}`);
    return sources[file];
  } };
}

function selectedFeatures(plan: ReturnType<typeof selectDropshipBrowserFeatures>) {
  return plan.decisions.filter(decision => decision.run).map(decision => decision.feature);
}

function select(file: string, extra: Record<string, string> = {}) {
  return selectDropshipBrowserFeatures({ changes: [{ status: "M", paths: [file] }], ...fixture(extra) });
}

describe("affected feature browser selection", () => {
  it("runs a changed spec's feature, including all of that feature's shards", () => {
    const plan = select("test/browser/dropship-policy-listing-settings-bulk.spec.ts");
    expect(selectedFeatures(plan)).toEqual(["listings"]);
    expect(plan.matrix.include.map(entry => [entry.feature, entry.shard, entry.shards])).toEqual([
      ["listings", 1, 3], ["listings", 2, 3], ["listings", 3, 3],
    ]);
  });

  it("follows shared imports, helper imports, barrel exports and literal dynamic imports per feature", () => {
    const changed = "shared/dropship/funding.ts";
    const plan = select(changed, {
      "test/browser/fixtures/dropship-wallet-harness.tsx": 'import { value } from "@/lib/funding";',
      "client/src/lib/funding.ts": 'export { value } from "@shared/dropship/funding";',
      "test/browser/dropship-orders.spec.ts": 'import "./orders-helper";',
      "test/browser/orders-helper.ts": 'const value = import("@shared/dropship/funding");',
      [changed]: "export const value = 1;",
    });
    expect(selectedFeatures(plan)).toEqual(["wallet", "orders"]);
  });

  it("does not pull unrelated App pages, shared modules or backend mocks into isolated harnesses", () => {
    for (const changed of ["shared/ebay-listing-issue.ts", "client/src/pages/EbayChannelPage.tsx",
      "client/src/lib/unrelated.ts", "server/modules/dropship/application/unrelated.ts", "client/src/App.tsx"]) {
      const plan = select(changed, { [changed]: 'export const unrelated = true;' });
      expect(plan.run, changed).toBe(false);
      expect(plan.matrix.include).toEqual([]);
      expect(plan.decisions).toHaveLength(Object.keys(DROPSHIP_BROWSER_FEATURES).length);
    }
  });

  it("still follows backend source actually imported by a browser spec", () => {
    const changed = "server/modules/dropship/domain/example.ts";
    expect(selectedFeatures(select(changed, {
      "test/browser/dropship-finance.spec.ts": 'import "../../server/modules/dropship/domain/example";',
      [changed]: "export const value = 1;",
    }))).toEqual(["finance"]);
  });

  it.each(["package-lock.json", "tsconfig.json", "vite.config.ts", "tailwind.config.ts", "client/src/index.css",
    "scripts/ci/dropship-browser-impact.mjs", "playwright.dropship-pricing.config.ts",
    ".github/workflows/dropship-pricing.yml", "client/public/logo.svg"])(
    "retains broad coverage for global tooling, style or asset changes: %s", file => {
      expect(selectedFeatures(select(file, { [file]: "" }))).toEqual(Object.keys(DROPSHIP_BROWSER_FEATURES));
    },
  );

  it.each(["D", "R100", "C100"])("never skips dependency history it cannot reconstruct: %s", status => {
    const plan = selectDropshipBrowserFeatures({ ...fixture(), changes: [{ status,
      paths: status === "D" ? ["shared/removed.ts"] : ["shared/old.ts", "shared/new.ts"],
    }] });
    expect(selectedFeatures(plan)).toEqual(Object.keys(DROPSHIP_BROWSER_FEATURES));
  });

  it.each(['import "./missing";', 'const feature = import(variable);', 'import "#unknown/alias";', 'const invalid = (;'])(
    "runs the affected group when its dependency graph cannot be trusted: %s", source => {
      const plan = select("docs/example.md", { "test/browser/fixtures/dropship-finance-harness.tsx": source });
      expect(selectedFeatures(plan)).toEqual(["finance"]);
      expect(plan.decisions.find(decision => decision.feature === "finance")?.reason).toContain("Dependency analysis was uncertain");
    },
  );

  it("runs all groups for missing paths, unknown paths or absent change evidence", () => {
    for (const plan of [
      select("shared/missing.ts"), select("new-runtime/entry.ts", { "new-runtime/entry.ts": "" }),
      selectDropshipBrowserFeatures({ ...fixture(), changes: [] }),
    ]) expect(selectedFeatures(plan)).toEqual(Object.keys(DROPSHIP_BROWSER_FEATURES));
  });

  it("uses unfiltered discovery when a new spec has not been assigned or a harness is missing", () => {
    const newSpec = "test/browser/dropship-policy-new-feature.spec.ts";
    const newPlan = select(newSpec, { [newSpec]: "" });
    expect(newPlan.matrix).toEqual(fullDropshipBrowserPlan("ignored").matrix);
    expect(newPlan.decisions[0].reason).toContain("Browser specs need a feature group");
    const missing = fixture();
    missing.files.delete("test/browser/fixtures/dropship-wallet-harness.tsx");
    expect(selectDropshipBrowserFeatures({ ...missing, changes: [{ status: "M", paths: ["docs/example.md"] }] }).matrix)
      .toEqual(fullDropshipBrowserPlan("ignored").matrix);
  });

  it("writes complete workflow outputs and runs the unfiltered suite for manual dispatch or invalid evidence", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "echelon-browser-selection-"));
    try {
      const output = path.join(directory, "outputs");
      const plan = runDropshipBrowserSelection({ BROWSER_EVENT_NAME: "workflow_dispatch", GITHUB_OUTPUT: output });
      expect(readFileSync(output, "utf8")).toBe(`run=true\nmatrix=${JSON.stringify(plan.matrix)}\n`);
      expect(plan.matrix.include.map(entry => entry.feature)).toEqual(["all", "all"]);
      expect(runDropshipBrowserSelection({ BROWSER_BASE_SHA: "main; echo injected", BROWSER_HEAD_SHA: "0".repeat(40) }).matrix)
        .toEqual(plan.matrix);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["client/src/pages/dropship/DropshipPortalWallet.tsx", ["wallet"]],
    ["shared/dropship/program-finance-money.ts", ["finance"]],
    // Listing settings PR 12 deleted the pricing rules panel and its own feature group; a step row is the listings group's.
    // Step 1 plan S2-5 PR A: the catalog-scale journeys render the same Catalog page (one harness), so it runs them too.
    ["client/src/pages/dropship/listing-settings/PriceDefaultRow.tsx", ["listings", "catalog-scale"]],
    ["client/src/pages/dropship/catalog/PublishStep.tsx", ["listings", "catalog-scale"]],
    ["test/browser/dropship-policy-catalog-publish-runs.spec.ts", ["catalog-scale"]],
    ["test/browser/dropship-policy-listing-settings-helpers.ts", ["listings"]],
    ["shared/ebay-listing-issue.ts", []],
    ["docs/migration-allocation.md", []],
  ])("selects the actual repository dependencies for %s", (file, expected) => {
    const plan = selectDropshipBrowserFeatures({ ...repositorySources(), changes: [{ status: "M", paths: [file as string] }] });
    expect(selectedFeatures(plan)).toEqual(expected);
  });
});

describe("feature browser coverage registration", () => {
  it("assigns every existing full-suite spec exactly once", () => {
    const { files } = repositorySources();
    expect(() => validateDropshipFeatureCoverage(files)).not.toThrow();
    const assigned = Object.values(DROPSHIP_BROWSER_FEATURES).flatMap(group => group.tests);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned.toSorted()).toEqual([...files].filter(file => DROPSHIP_BROWSER_TEST_PATTERN.test(file)).sort());
    for (const name of Object.keys(DROPSHIP_BROWSER_FEATURES)) {
      const patterns = dropshipFeatureTestMatch(name);
      expect(assigned.filter(file => patterns.some(pattern => pattern.test(`/workspace/${file}`))).toSorted())
        .toEqual([...DROPSHIP_BROWSER_FEATURES[name].tests].sort());
      for (const file of DROPSHIP_BROWSER_FEATURES[name].tests) {
        expect(patterns.some(pattern => pattern.test(`C:\\workspace\\${file.replaceAll("/", "\\")}`))).toBe(true);
        expect(patterns.some(pattern => pattern.test(`/workspace/${file}.backup`))).toBe(false);
      }
    }
  });

  it("rejects invalid group names instead of silently running no tests", () => {
    for (const name of ["", "missing", "__proto__", "constructor", "wallet --pass-with-no-tests"])
      expect(() => dropshipFeatureTestMatch(name)).toThrow("Unknown dropship browser feature");
  });

  it("rejects duplicate, missing or invalid assignments", () => {
    const { files } = fixture();
    const original = DROPSHIP_BROWSER_FEATURES.wallet;
    for (const replacement of [
      { ...original, tests: [] }, { ...original, shards: 0 }, { ...original, shards: 2 },
      { ...original, tests: DROPSHIP_BROWSER_FEATURES.orders.tests },
      { ...original, tests: ["test/browser/dropship-wallet-missing.spec.ts"] },
      { ...original, roots: ["../outside.tsx"] },
    ]) expect(() => validateDropshipFeatureCoverage(files, { ...DROPSHIP_BROWSER_FEATURES, wallet: replacement })).toThrow();
  });

  it("registers every injected HTML entrypoint, including those hidden behind spec helpers", () => {
    const { files, readSource } = repositorySources();
    for (const [name, group] of Object.entries(DROPSHIP_BROWSER_FEATURES)) {
      const harnesses = new Set<string>();
      // Imports from specs reach helper files such as the catalog stubs. Their
      // HTML module strings are not TypeScript imports and need explicit roots.
      for (const file of dependencyClosure(group.tests, files, readSource)) {
        for (const match of readSource(file).matchAll(/["'](test\/browser\/fixtures\/[^"']+\.tsx)["']/g)) harnesses.add(match[1]);
      }
      expect([...harnesses].sort(), name).toEqual([...group.roots].sort());
    }
  });
});
