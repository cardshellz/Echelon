import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { readTestChangeEvidence, selectTestImpact } from "../../../scripts/ci/test-impact.mjs";
import { selectPostgresTests, readPostgresImpactPlan, validatePostgresSelection, selectedPostgresShards } from "../../../scripts/ci/postgres-test-impact";
import { POSTGRES_TEST_FILES } from "../../../scripts/ci/postgres-test-manifest";
import { BROWSER_CONFIGS, BROWSER_FEATURES, validateBrowserFeatures } from "../../../scripts/ci/browser-feature-manifest.mjs";
import { selectBrowserFeatures } from "../../../scripts/ci/browser-feature-impact.mjs";
import { CI_GUARD_TEST_FILES } from "../../../scripts/ci/guard-test-manifest.mjs";
import { testLaneArguments } from "../../../scripts/ci/run-test-lane.mjs";
import { requireSelectedSuccess } from "../../../scripts/ci/require-selected-success.mjs";
import { runPostgresShard, type PostgresRunnerDependencies } from "../../../scripts/ci/postgres-tests";

const root = resolve(import.meta.dirname, "../../..");
function snapshot(extra: Record<string, string> = {}) {
  const sources: Record<string, string> = { "package.json": "{}", "test/example.test.ts": 'import "../server/example";',
    "server/example.ts": 'export const value = 1;', ...extra };
  return { files: new Set(Object.keys(sources)), readSource(file: string) {
    if (!(file in sources)) throw new Error("Missing fixture: " + file);
    return sources[file];
  } };
}
const coverage = { roots: () => [], testPattern: /^test\/example\.test\.ts$/, ownedFiles: [], ownedPrefixes: [],
  globalFiles: ["package.json"], globalPrefixes: ["migrations/"], knownPrefixes: ["server/", "test/", "client/"] };
const change = (path: string, status = "M") => ({ status, paths: [path] });
const impact = (changes: Array<{ status: string; paths: string[] }>, current = snapshot(), previous?: ReturnType<typeof snapshot>) =>
  selectTestImpact({ changes, ...current, previous, coverage });

describe("shared impact evidence", () => {
  it("selects removed dependencies from the old graph", () => {
    const previous = snapshot({ "server/example.ts": 'import "./removed";', "server/removed.ts": "export {};" });
    expect(impact([change("server/removed.ts", "D")], snapshot(), previous).run).toBe(true);
  });
  it.each(["D", "R100", "C100"])("can prove an unrelated %s using both snapshots", status => {
    const previous = snapshot({ "client/old.ts": "export {};" });
    const current = snapshot({ "client/new.ts": "export {};" });
    const paths = status === "D" ? ["client/old.ts"] : ["client/old.ts", "client/new.ts"];
    expect(impact([{ status, paths }], current, previous).run).toBe(false);
    expect(impact([{ status, paths }], current).run).toBe(true);
  });
  it.each(["import(variable);", 'import.meta.glob("./*.ts");', 'import "#unknown";', 'vi.mock(variable);', 'export { from "broken";'])(
    "runs full coverage for unresolved syntax: %s", source => {
      expect(impact([change("client/unrelated.ts")], snapshot({
        "client/unrelated.ts": "export {};", "server/example.ts": source,
      })).run).toBe(true);
    });
  it("follows mocks, dynamic imports, type imports and injected HTML modules", () => {
    const current = snapshot({
      "server/example.ts": 'vi.mock("./mocked"); import("./dynamic"); type T = import("./types").T; const html = resolve("test/browser/fixtures/harness.tsx");',
      "server/mocked.ts": "export {};", "server/dynamic.ts": "export {};", "server/types.ts": "export type T = string;",
      "test/browser/fixtures/harness.tsx": 'import "../../../client/source";', "client/source.ts": "export {};",
    });
    for (const path of ["server/mocked.ts", "server/dynamic.ts", "server/types.ts", "client/source.ts"])
      expect(impact([change(path)], current).run).toBe(true);
  });
  it("does not skip malformed, missing or unclassified change evidence", () => {
    for (const changes of [[], [change("unknown/path")], [change("client/missing.ts")],
      [{ status: "R100", paths: ["server/example.ts"] }], [change("../escape")]])
      expect(impact(changes).run).toBe(true);
  });
  it("reads committed history, excludes dirty edits, and rejects an unrelated checkout", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "echelon-ci-impact-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const save = (path: string, source: string) => { mkdirSync(dirname(resolve(directory, path)), { recursive: true }); writeFileSync(resolve(directory, path), source); };
    try {
      git("init"); git("config", "user.name", "CI fixture"); git("config", "user.email", "ci@example.invalid");
      save("package.json", "{}"); save("server/value.ts", "export const value = 1;");
      git("add", "."); git("commit", "-m", "base");
      const base = git("rev-parse", "HEAD");
      save("server/value.ts", "export const value = 2;");
      git("add", "."); git("commit", "-m", "head");
      const head = git("rev-parse", "HEAD");
      save("server/value.ts", "uncommitted garbage");
      const evidence = readTestChangeEvidence({ CI_BASE_SHA: base, CI_HEAD_SHA: head }, directory);
      expect(evidence.changes).toEqual([change("server/value.ts")]);
      expect(evidence.readSource("server/value.ts")).toContain("value = 2");
      expect(evidence.previous.readSource("server/value.ts")).toContain("value = 1");
      expect(() => readTestChangeEvidence({ CI_BASE_SHA: base, CI_HEAD_SHA: base }, directory)).toThrow("Checkout");
      expect(() => readTestChangeEvidence({ CI_BASE_SHA: "--help", CI_HEAD_SHA: head }, directory)).toThrow("SHA");
      save("server/value.ts", "export const value = 2;");
      git("checkout", "-b", "advanced-base", base);
      save("server/base.ts", "export const advanced = true;");
      git("add", "."); git("commit", "-m", "advance base");
      const advancedBase = git("rev-parse", "HEAD");
      git("merge", "--no-ff", head, "-m", "test merge");
      const merged = readTestChangeEvidence({ CI_BASE_SHA: advancedBase, CI_HEAD_SHA: head }, directory);
      expect(merged.changes.map((entry: { paths: string[] }) => entry.paths[0]).sort())
        .toEqual(["server/base.ts", "server/value.ts"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

function postgresFixture() {
  const sources: Record<string, string> = {};
  for (const file of POSTGRES_TEST_FILES) {
    const owner = file.split("/__tests__/")[0];
    sources[file] = "export {};";
    sources[owner + "/service.ts"] = "export {};";
  }
  return snapshot(sources);
}
describe("PostgreSQL coverage selection", () => {
  it("selects the complete changed owner and cross-owner imported dependencies", () => {
    const current = postgresFixture();
    const first = POSTGRES_TEST_FILES[0].split("/__tests__/")[0];
    const foreignTest = POSTGRES_TEST_FILES.find(file => !file.startsWith(first + "/"))!;
    const original = current.readSource;
    current.readSource = file => file === foreignTest ? 'import "' + "../".repeat(file.split("/").length - 1) + first + '/service";' : original(file);
    const result = selectPostgresTests({ ...current, changes: [change(first + "/service.ts")] });
    expect(result.files).toEqual(POSTGRES_TEST_FILES.filter(file =>
      file.startsWith(first + "/") || file.startsWith(foreignTest.split("/__tests__/")[0] + "/")));
    expect(result.files.length).toBeLessThan(POSTGRES_TEST_FILES.length);
  });
  it("skips PostgreSQL for independent client-only changes with complete graphs", () => {
    const current = postgresFixture();
    current.files.add("client/src/Independent.tsx");
    expect(selectPostgresTests({ ...current, changes: [change("client/src/Independent.tsx")] }).files).toEqual([]);
  });
  it.each(["migrations/new.sql", "shared/schema.ts", "server/new-owner/service.ts", "scripts/ci/test-impact.mjs", "package-lock.json", "server/modules/channels/__tests__/integration/new.test.ts", "server/modules/channels/runtime-policy.json"])(
    "runs the entire manifest for %s", path => {
      const current = postgresFixture(); current.files.add(path);
      expect(selectPostgresTests({ ...current, changes: [change(path)] }).files).toEqual(POSTGRES_TEST_FILES);
    });
  it("runs all coverage when any owner's graph is uncertain", () => {
    const current = postgresFixture();
    current.files.add("client/unrelated.ts");
    const read = current.readSource;
    current.readSource = file => file === POSTGRES_TEST_FILES[0] ? 'import(variable);' : read(file);
    expect(selectPostgresTests({ ...current, changes: [change("client/unrelated.ts")] }).files).toEqual(POSTGRES_TEST_FILES);
  });
  it.each(["push", "schedule", "workflow_dispatch", undefined])("runs all files for event %s", event => {
    expect(readPostgresImpactPlan({ CI_EVENT_NAME: event }).files).toEqual(POSTGRES_TEST_FILES);
  });
  it("falls back to full coverage for unavailable PR evidence", () => {
    expect(readPostgresImpactPlan({ CI_EVENT_NAME: "pull_request" }).files).toEqual(POSTGRES_TEST_FILES);
  });
  it("partitions selected files exactly once and rejects malformed or empty selections", () => {
    const files = POSTGRES_TEST_FILES.slice(0, 5);
    const plan = selectedPostgresShards(files);
    expect(plan.shards.flatMap(shard => shard.files).sort()).toEqual([...files].sort());
    for (const raw of ["[]", "null", "{}", '["unknown.test.ts"]', JSON.stringify([files[0], files[0]]), "bad"])
      expect(() => validatePostgresSelection(raw)).toThrow();
    expect(validatePostgresSelection(undefined)).toEqual(POSTGRES_TEST_FILES);
  });
  it("rejects an invalid selection before opening a database connection", async () => {
    const dependencies = { createAdminConnection() { throw new Error("MUST NOT CONNECT"); } } as unknown as PostgresRunnerDependencies;
    await expect(runPostgresShard(["1/1"], { POSTGRES_SELECTED_TEST_FILES: "[]" }, dependencies)).rejects.toThrow("nonempty");
  });
});

describe("selected-check aggregation", () => {
  const needs = (run: string, result: string, include: unknown[] = []) => ({
    preflight: { result: "success", outputs: { run, matrix: JSON.stringify({ include }) } }, execute: { result },
  });
  it("accepts only proven safe skips or successful requested work", () => {
    expect(() => requireSelectedSuccess(needs("false", "skipped"), "execute")).not.toThrow();
    expect(() => requireSelectedSuccess(needs("true", "success", [{ shard: 1 }]), "execute")).not.toThrow();
  });
  it.each(["failure", "cancelled", "skipped", "pending", ""])("rejects requested work that is %s", result => {
    expect(() => requireSelectedSuccess(needs("true", result, [{ shard: 1 }]), "execute")).toThrow();
  });
  it("rejects missing plans, contradictory skips, empty requested matrices and failed preflight", () => {
    for (const evidence of [needs("", "skipped"), needs("false", "success"), needs("false", "skipped", [{}]),
      needs("true", "success"), { ...needs("false", "skipped"), preflight: { result: "failure" } }])
      expect(() => requireSelectedSuccess(evidence, "execute")).toThrow();
  });
});

describe("inventory and returns browser impact adapters", () => {
  function browserFixture() {
    const sources: Record<string, string> = {};
    for (const group of Object.values(BROWSER_FEATURES.inventory))
      for (const file of [...group.tests, ...group.roots]) sources[file] = "export {};";
    sources["test/browser/ebay-listing-photos.spec.ts"] = 'import "../../client/src/pages/EbayChannelPage";';
    sources["client/src/pages/EbayChannelPage.tsx"] = "export {};";
    sources["client/src/pages/Unrelated.tsx"] = "export {};";
    sources["playwright.inventory.config.ts"] = "export {};";
    return snapshot(sources);
  }
  it("selects only the imported feature and retains all its configured shards", () => {
    const current = browserFixture();
    const plan = selectBrowserFeatures("inventory", { ...current, previous: current,
      changes: [change("client/src/pages/EbayChannelPage.tsx")] });
    expect(plan.matrix.include).toEqual(Array.from({ length: 4 }, (_, i) => ({ feature: "ebay", shard: i + 1, shards: 4 })));
    expect(selectBrowserFeatures("inventory", { ...current, previous: current,
      changes: [change("client/src/pages/Unrelated.tsx")] }).run).toBe(false);
  });
  it("keeps full unfiltered coverage for tooling changes or any unresolved graph", () => {
    const current = browserFixture();
    const full = { include: Array.from({ length: 4 }, (_, i) => ({ feature: "all", shard: i + 1, shards: 4 })) };
    expect(selectBrowserFeatures("inventory", { ...current, changes: [change("playwright.inventory.config.ts")] }).matrix).toEqual(full);
    const readSource = current.readSource;
    current.readSource = file => file === BROWSER_FEATURES.inventory.catalog.tests[0] ? "import(variable);" : readSource(file);
    expect(selectBrowserFeatures("inventory", { ...current, changes: [change("client/src/pages/EbayChannelPage.tsx")] }).matrix).toEqual(full);
  });
  it("uses full discovery when feature registration is incomplete", () => {
    const current = browserFixture();
    current.files.delete(BROWSER_FEATURES.inventory.ebay.tests[0]);
    const plan = selectBrowserFeatures("inventory", { ...current, changes: [change("client/src/pages/Unrelated.tsx")] });
    expect(plan.run).toBe(true);
    expect(plan.matrix.include.every(entry => entry.feature === "all")).toBe(true);
  });
});

describe("coverage partition contracts", () => {
  it("executes every guard once in CI and retains the local full unit command", () => {
    expect(new Set(CI_GUARD_TEST_FILES).size).toBe(CI_GUARD_TEST_FILES.length);
    const guards = testLaneArguments("guards");
    const unit = testLaneArguments("unit");
    for (const file of CI_GUARD_TEST_FILES) {
      expect(readFileSync(resolve(root, file), "utf8").length).toBeGreaterThan(0);
      expect(guards.filter((value: string) => value === file)).toHaveLength(1);
      expect(unit[unit.indexOf(file) - 1]).toBe("--exclude");
    }
    expect(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts["test:unit"]).toBe("vitest run unit");
  });
  it("discovers the original unit inventory exactly once across guards and remaining units", () => {
    const discover = (filters: string[]) => {
      const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "list", ...filters, "--filesOnly", "--json"], {
        cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024,
      });
      expect(result.status, result.stderr).toBe(0);
      return (JSON.parse(result.stdout) as Array<{ file: string }>).map(row => row.file);
    };
    const full = discover(["unit"]);
    const guard = discover(testLaneArguments("guards").slice(1));
    const remaining = discover(testLaneArguments("unit").slice(1));
    expect(guard).toHaveLength(CI_GUARD_TEST_FILES.length);
    expect([...guard, ...remaining].sort()).toEqual(full.sort());
    expect(new Set([...guard, ...remaining]).size).toBe(full.length);
  }, 120_000);
  it.each(["inventory", "returns"] as const)("keeps every desktop/mobile case exactly once in %s feature partitions", suite => {
    const list = (feature?: string, shard?: string) => {
      const env = { ...process.env }; delete env.BROWSER_FEATURE;
      if (feature) env.BROWSER_FEATURE = feature;
      const child = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test",
        "--config", BROWSER_CONFIGS[suite].config, "--list", "--reporter=json", ...(shard ? ["--shard=" + shard] : [])], {
        cwd: root, encoding: "utf8", env, maxBuffer: 20 * 1024 * 1024, timeout: 60_000,
      });
      expect(child.status, child.stderr).toBe(0);
      const report = JSON.parse(child.stdout);
      expect(report.errors).toEqual([]);
      const cases: string[] = [];
      const files = new Set<string>();
      function visit(node: { file?: string; title?: string; specs?: Array<{ id: string; file: string; tests: Array<{ projectName: string }> }>; suites?: unknown[] }) {
        for (const spec of node.specs ?? []) {
          files.add("test/browser/" + spec.file.replaceAll("\\", "/"));
          for (const test of spec.tests) cases.push(spec.id + ":" + test.projectName);
        }
        for (const child of node.suites ?? []) visit(child as typeof node);
      }
      for (const node of report.suites) visit(node);
      return { cases, files };
    };
    const full = list();
    const repositoryFiles = new Set(execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split("\n"));
    const registered = validateBrowserFeatures(suite, repositoryFiles);
    expect([...registered].sort()).toEqual([...full.files].sort());
    const partition = Object.entries(BROWSER_FEATURES[suite]).flatMap(([feature, group]) =>
      Array.from({ length: group.shards }, (_, i) => list(feature, `${i + 1}/${group.shards}`).cases).flat());
    expect(partition.sort()).toEqual(full.cases.sort());
    expect(new Set(partition).size).toBe(partition.length);
    expect(full.cases.some(value => value.endsWith(":desktop"))).toBe(true);
    expect(full.cases.some(value => value.endsWith(":mobile"))).toBe(true);
  }, 120_000);
});
