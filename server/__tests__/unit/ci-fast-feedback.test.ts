import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { requireSuccessfulJobs } from "../../../scripts/ci/require-success.mjs";

const repositoryRoot = new URL("../../../", import.meta.url);
const source = (file: string) => readFileSync(new URL(file, repositoryRoot), "utf8");
const success = () => ({ result: "success", outputs: {} });

function job(workflow: string, name: string): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf("  " + name + ":");
  expect(start, "Missing workflow job: " + name).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && !/^  [a-z][a-z0-9-]*:/.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

// The paths one job step hands to `npx vitest run`, in order. The step must be
// a folded `run: >-` block with one path per line and no other arguments.
function vitestStepFiles(jobText: string, stepName: string): string[] {
  const lines = jobText.split(/\r?\n/);
  const start = lines.indexOf("      - name: " + stepName);
  expect(start, "Missing workflow step: " + stepName).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && /^ {8,}\S/.test(lines[end])) end++;
  const [run, command, ...paths] = lines.slice(start + 1, end);
  expect(run).toBe("        run: >-");
  expect(command).toBe("          npx vitest run");
  for (const line of paths) expect(line, "Not a test path: " + line).toMatch(/^ {10}[\w./-]+\.test\.ts$/);
  return paths.map((line) => line.trim());
}

// Repository-relative test files in one directory whose names match.
function testFilesIn(directory: string, name: RegExp): string[] {
  return readdirSync(new URL(directory, repositoryRoot))
    .filter((file) => name.test(file))
    .map((file) => directory + file)
    .sort();
}

describe("parallel CI required-check aggregation", () => {
  it("requires the exact job set to succeed without mutating evidence", () => {
    const results = Object.freeze({ unit: Object.freeze(success()), types: Object.freeze(success()) });
    expect(() => requireSuccessfulJobs(results, Object.freeze(["unit", "types"]))).not.toThrow();
  });

  it.each(["failure", "cancelled", "skipped", "pending", "", null, undefined, 0])(
    "rejects a child job result of %s",
    (result) => {
      expect(() => requireSuccessfulJobs({ unit: { result }, types: success() }, ["unit", "types"]))
        .toThrow("CI jobs did not all succeed: unit");
    },
  );

  it.each([null, undefined, [], "success", 1])("rejects malformed dependency evidence: %s", (results) => {
    expect(() => requireSuccessfulJobs(results, ["unit"])).toThrow();
  });

  it("rejects missing, unexpected, inherited, or malformed job records", () => {
    for (const results of [
      {}, { unit: success(), unaccounted: success() }, Object.create({ unit: success() }),
      { unit: "success" }, { unit: null }, { unit: [] }, { unit: Object.create(success()) },
    ]) {
      expect(() => requireSuccessfulJobs(results, ["unit"])).toThrow();
    }
  });

  it.each([[], ["unit", "unit"], ["unit\ninjected"], [""]])("rejects invalid expected jobs: %j", (...jobs: string[]) => {
    expect(() => requireSuccessfulJobs({ unit: success() }, jobs)).toThrow();
  });

  it.each([
    { input: JSON.stringify({ unit: success() }), args: ["unit"], status: 0 },
    { input: JSON.stringify({ unit: { result: "skipped" } }), args: ["unit"], status: 1 },
    { input: JSON.stringify({ unit: { result: "failure" } }), args: ["unit"], status: 1 },
    { input: JSON.stringify({ unit: success() }), args: [], status: 1 },
    { input: "{}", args: ["unit"], status: 1 },
    { input: "not json", args: ["unit"], status: 1 },
  ])("propagates CLI exit status $status for $input", ({ input, args, status }) => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("scripts/ci/require-success.mjs", repositoryRoot)), ...args,
    ], { encoding: "utf8", env: { ...process.env, CI_NEEDS: input } });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    if (status === 1) expect(result.stderr).toContain("::error::");
    else expect(result.stderr).toBe("");
  });
});

describe("fast CI preserves coverage and required checks", () => {
  const workflow = source(".github/workflows/ci.yml");

  it("runs cheap coverage and migration guards before expensive core jobs", () => {
    const preflight = job(workflow, "preflight");
    for (const file of [
      "postgres-ci-shards.test.ts", "migration-prefix-collision.test.ts",
      "browser-ci-selection.test.ts", "ci-fast-feedback.test.ts",
    ]) expect(preflight).toContain(file);
    expect(preflight).toContain("--allowOnly=false --passWithNoTests=false");
    for (const name of ["typecheck", "unit-tests", "contracts", "postgres-hardening-shard"]) {
      expect(job(workflow, name)).toContain("needs: preflight");
    }
  });

  it("runs all three existing typecheck programs on independent runners", () => {
    const typecheck = job(workflow, "typecheck");
    expect(typecheck).toContain("project: [application, server-tests, client-tests]");
    expect(typecheck).toContain("fail-fast: false");
    expect(typecheck).toContain("run: npm run check");
    expect(typecheck).toContain("run: npx tsc -p tsconfig.tests.server.json");
    expect(typecheck).toContain("run: npx tsc -p tsconfig.tests.client.json");
    expect(typecheck).not.toContain("needs: unit-tests");
  });

  it("gives the server test typecheck a heap above Node's ~4 GB default", () => {
    const typecheck = job(workflow, "typecheck");
    const step = typecheck.slice(typecheck.indexOf("- name: Server test types"), typecheck.indexOf("- name: Client test types"));
    expect(step).toContain("NODE_OPTIONS: --max-old-space-size=6144");
    expect(step).toContain("run: npx tsc -p tsconfig.tests.server.json");
  });

  it("partitions the unchanged unit selection into four complete, isolated shards", () => {
    const unit = job(workflow, "unit-tests");
    expect(unit).toContain("shard: [1, 2, 3, 4]");
    expect(unit).toContain("fail-fast: false");
    expect(unit).toContain("npm run test:unit -- --shard=${{ matrix.shard }}/4");
    expect(unit).toContain("--maxWorkers=2 --allowOnly=false --passWithNoTests=false");
    expect(unit).toContain("test-results/unit-${{ matrix.shard }}.xml");
    expect(unit).not.toMatch(/--(?:exclude|no-isolate|changed|bail)/);
    expect(JSON.parse(source("package.json")).scripts["test:unit"]).toBe("vitest run unit");
  });

  it("retains every separately scheduled maintenance and client contract", () => {
    const contracts = job(workflow, "contracts");
    for (const file of [
      "scripts/inventory-cutover-records-proposal-20260925.test.ts",
      "scripts/inventory-cutover-records-execution-20260925.test.ts",
      "client/src/features/purchasing/__tests__/reorderEngine.test.ts",
      "client/src/features/purchasing/__tests__/forecastBacktesting.test.ts",
      "client/src/features/purchasing/__tests__/reorder-explanation-format.test.ts",
      "client/src/lib/__tests__/procurement-schedule-date.test.ts",
      "shared/procurement/__tests__/purchase-buying-review.test.ts",
      "shared/inventory/__tests__/cost-report-read.test.ts",
      "shared/inventory/__tests__/order-cogs-report.test.ts",
      "client/src/lib/__tests__/inventory-transaction-quantity.test.ts",
      "client/src/pages/__tests__/inventory-history-shipment-quantity.test.ts",
      "client/src/features/channel-listing-publication/__tests__/api.test.ts",
      "client/src/features/channel-listing-publication/__tests__/model.test.ts",
      "client/src/lib/__tests__/dropship-ebay-policy-assignment.test.ts",
      "client/src/pages/dropship/__tests__/DropshipPortalCatalog.test.ts",
      "client/src/pages/dropship/__tests__/EbayListingSetupPanel.test.ts",
      "client/src/pages/dropship/__tests__/EbayListingPolicyOverridePanel.test.ts",
      "client/src/lib/__tests__/dropship-listing-preview.test.ts",
      "client/src/lib/__tests__/dropship-listing-price.test.ts",
      "client/src/lib/__tests__/dropship-pricing-rules.test.ts",
      "client/src/pages/dropship/__tests__/DropshipListingPreview.test.ts",
      "client/src/pages/dropship/__tests__/DropshipListingPriceEditor.test.ts",
      "client/src/lib/__tests__/dropship-catalog-steps.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings.test.ts",
      "client/src/pages/dropship/__tests__/DropshipCatalogFrame.test.ts",
      "client/src/lib/__tests__/dropship-ebay-category-rules.test.ts",
      "client/src/pages/dropship/__tests__/DropshipEbayCategoryRulesPanel.test.ts",
      "client/src/lib/__tests__/dropship-unsaved-changes.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-price-words.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-drafts.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsFramework.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-access.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-words.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-store-requests.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsPolicyShelf.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-content-requests.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsCategoryDescription.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-recipe.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsPriceRow.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsTabs.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-drawer.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsProductDrawer.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-attention.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsHeaderBannerStrip.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsStep.test.ts",
      "client/src/lib/__tests__/dropship-ebay-listing-setup.test.ts",
      "client/src/lib/__tests__/dropship-ebay-listing-query-sync.test.ts",
      "shared/dropship/__tests__/program-finance-money.test.ts",
      "shared/dropship/__tests__/program-finance-contract.test.ts",
      "shared/dropship/__tests__/program-finance-definitions.test.ts",
      "client/src/pages/__tests__/dropship-finance-model.test.ts",
      "client/src/pages/__tests__/dropship-finance-panel.test.ts",
    ]) expect(contracts).toContain(file);
    expect(contracts).toContain("--strict --types node scripts/inventory-cutover-records-*.ts");
  });

  // `vitest run` treats each path as a filter and exits 0 when one matches no
  // file, so a misspelt or deleted path would drop that suite from CI quietly.
  it("names only real, distinct files in the dropship listing UI step", () => {
    const files = vitestStepFiles(job(workflow, "contracts"), "Dropship listing policy UI contracts");
    expect(files.length).toBeGreaterThan(0);
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) {
      expect(existsSync(new URL(file, repositoryRoot)), "Missing test file: " + file).toBe(true);
    }
  });

  // test:unit is `vitest run unit`, which matches none of these paths, so they
  // run in CI only because this step names them.
  it("runs every Listing settings client test in the dropship listing UI step", () => {
    const registered = new Set(vitestStepFiles(job(workflow, "contracts"), "Dropship listing policy UI contracts"));
    const onDisk = [
      ...testFilesIn("client/src/lib/__tests__/", /^dropship-listing-settings(?:-[a-z]+)*\.test\.ts$/),
      ...testFilesIn("client/src/pages/dropship/__tests__/", /^ListingSettings[A-Za-z]*\.test\.ts$/),
    ];
    expect(onDisk.length).toBeGreaterThan(0);
    for (const file of onDisk) expect(registered.has(file), "Not run in CI: " + file).toBe(true);
  });

  it("retains the existing required core check and fails closed on every dependency", () => {
    const gate = job(workflow, "check-and-unit");
    expect(gate).toContain("name: Typecheck + unit tests");
    expect(gate).toContain("needs: [preflight, typecheck, unit-tests, contracts]");
    expect(gate).toContain("if: ${{ always() }}");
    expect(gate).toContain("CI_NEEDS: ${{ toJSON(needs) }}");
    expect(gate).toContain("node scripts/ci/require-success.mjs preflight typecheck unit-tests contracts");
    expect(workflow).not.toMatch(/continue-on-error:|paths(?:-ignore)?:/);
  });

  it("runs all Returns shards and retains its original required check identity", () => {
    const returns = source(".github/workflows/returns-preview.yml");
    const shards = job(returns, "browser-shard");
    expect(shards).toContain("shard: [1, 2, 3, 4]");
    expect(shards).toContain("fail-fast: false");
    expect(shards).toContain("--config playwright.returns-preview.config.ts --shard=${{ matrix.shard }}/4");
    expect(shards).toContain("name: returns-preview-browser-results-${{ matrix.shard }}");
    const gate = job(returns, "browser");
    expect(gate).toContain("name: Returns preview browser journeys\n");
    expect(gate).toContain("needs: [browser-shard]");
    expect(gate).toContain("if: ${{ always() }}");
    expect(gate).toContain("CI_NEEDS: ${{ toJSON(needs) }}");
    expect(gate).toContain("node scripts/ci/require-success.mjs browser-shard");
    expect(returns).not.toMatch(/continue-on-error:|paths(?:-ignore)?:/);
  });

  it.each(["returns-preview", "procurement"])("balances %s by test while retaining one worker per runner", (suite) => {
    const config = source("playwright." + suite + ".config.ts");
    expect(config).toContain("fullyParallel: true");
    expect(config).toContain("workers: 1");
    expect(config).toContain('name: "desktop"');
    expect(config).toContain('name: "mobile"');
  });
});
