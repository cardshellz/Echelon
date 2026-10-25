import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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

// Execute the aggregate's actual shell body, including its ordering of migration
// validation, selection, and safe-skip checks. Git for Windows supplies Bash on
// local Windows checkouts; hosted CI uses the same script with runner Bash.
function runBrowserAggregate(jobText: string, evidence: Record<string, string>) {
  const lines = jobText.split(/\r?\n/);
  const start = lines.indexOf("        run: |");
  expect(start).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && /^ {10}/.test(lines[end])) end++;
  const script = lines.slice(start + 1, end).map((line) => line.slice(10)).join("\n");
  let bash = "bash";
  if (process.platform === "win32") {
    const git = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
    expect(git.status).toBe(0);
    bash = resolve(git.stdout.trim(), "../../../bin/bash.exe");
    expect(existsSync(bash), "Git for Windows Bash is required for workflow contract tests").toBe(true);
  }
  return spawnSync(bash, ["--noprofile", "--norc", "-s"], {
    input: script,
    encoding: "utf8",
    env: { ...process.env, ...evidence },
    timeout: 10_000,
  });
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

  it.each([
    ["ci", "preflight"], ["procurement-navigation", "select"], ["procurement-connected", "select"],
    ["dropship-pricing", "select"], ["order-edits", "select"],
    ["inventory-availability", "preflight"], ["returns-preview", "preflight"],
  ])("validates migrations without installed dependencies in %s", (file, gateName) => {
    const gate = job(source(".github/workflows/" + file + ".yml"), gateName);
    const checkout = gate.indexOf("uses: actions/checkout@v4");
    const migrationGuard = gate.indexOf("run: node scripts/migrations/check-migrations.mjs --ci");
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(migrationGuard).toBeGreaterThan(checkout);
    expect(gate.slice(checkout, migrationGuard)).toContain("fetch-depth: 0");
    expect(gate.slice(checkout, migrationGuard)).toContain("persist-credentials: false");
    expect(gate).toContain("    permissions:\n      contents: read\n      pull-requests: read");
    expect(gate).toContain("run: node scripts/migrations/check-migrations.mjs --ci\n        env:\n          GITHUB_TOKEN: ${{ github.token }}");
    expect(gate).not.toMatch(/(?:contents|pull-requests): write/);
    for (const setup of ["uses: actions/setup-node@", "run: npm ci", "playwright install", "services:"]) {
      const setupPosition = gate.indexOf(setup);
      if (setupPosition !== -1) expect(setupPosition, setup).toBeGreaterThan(migrationGuard);
    }
    expect(gate).not.toContain("continue-on-error:");
  });

  it.each(["procurement-navigation", "procurement-connected", "dropship-pricing", "order-edits"])(
    "blocks %s browser setup after invalid migrations while preserving selector uncertainty coverage",
    (file) => {
      const browserWorkflow = source(".github/workflows/" + file + ".yml");
      const select = job(browserWorkflow, "select");
      expect(select).toContain("migrations: ${{ steps.migrations.outcome }}");
      expect(select).toContain("- id: migrations");
      const browser = job(browserWorkflow, "browser");
      expect(browser).toContain("needs: select");
      expect(browser).toContain("if: ${{ !cancelled() && needs.select.outputs.migrations == 'success' && (needs.select.result != 'success' || needs.select.outputs.run != 'false') }}");
      const aggregate = job(browserWorkflow, "result");
      expect(aggregate).toContain("needs: [select, browser]");
      expect(aggregate).toContain("if: ${{ always() }}");
      expect(aggregate).toContain("MIGRATIONS_RESULT: ${{ needs.select.outputs.migrations }}");
      expect(aggregate).toContain("SELECT_RESULT: ${{ needs.select.result }}");
      expect(aggregate).toContain("RUN_SUITE: ${{ needs.select.outputs.run }}");
      expect(aggregate).toMatch(/(?:SHARD_RESULT|BROWSER_RESULT): \$\{\{ needs\.browser\.result \}\}/);
      for (const [migrations, selection, run, shards, exitStatus] of [
        ["success", "success", "true", "success", 0],
        ["success", "success", "false", "skipped", 0],
        ["failure", "failure", "", "skipped", 1],
        ["failure", "success", "false", "skipped", 1],
        ["skipped", "success", "false", "skipped", 1],
        ["", "success", "false", "skipped", 1],
        ["cancelled", "cancelled", "", "skipped", 1],
        ["success", "failure", "false", "skipped", 1],
        ["success", "success", "", "success", 1],
        ["success", "success", "true", "failure", 1],
        ["success", "success", "true", "cancelled", 1],
        ["success", "success", "true", "skipped", 1],
        ["success", "success", "false", "success", 1],
      ] as const) {
        const result = runBrowserAggregate(aggregate, {
          MIGRATIONS_RESULT: migrations, SELECT_RESULT: selection, RUN_SUITE: run,
          SHARD_RESULT: shards, BROWSER_RESULT: shards,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, JSON.stringify({ migrations, selection, run, shards })).toBe(exitStatus);
        if (exitStatus === 1) expect(result.stdout).toContain("::error::");
      }
    },
  );

  it.each(["inventory-availability", "returns-preview"])("gates every %s shard and its aggregate on preflight", (file) => {
    const browserWorkflow = source(".github/workflows/" + file + ".yml");
    const preflight = job(browserWorkflow, "preflight");
    expect(preflight).not.toMatch(/playwright install|services:/);
    expect(preflight).toContain("node scripts/ci/browser-feature-impact.mjs");
    const shards = job(browserWorkflow, "browser-shard");
    expect(shards).toContain("needs: preflight");
    expect(shards).toContain("if: ${{ needs.preflight.outputs.run == 'true' }}");
    expect(shards).toContain("matrix: ${{ fromJSON(needs.preflight.outputs.matrix) }}");
    const aggregate = job(browserWorkflow, "browser");
    expect(aggregate).toContain("needs: [preflight, browser-shard]");
    expect(aggregate).toContain("if: ${{ always() }}");
    expect(aggregate).toContain("CI_NEEDS: ${{ toJSON(needs) }}");
    expect(aggregate).toContain("node scripts/ci/require-selected-success.mjs browser-shard");
    for (const result of ["failure", "cancelled", "skipped", "", undefined]) {
      expect(() => requireSuccessfulJobs({ preflight: { result }, "browser-shard": success() }, ["preflight", "browser-shard"]))
        .toThrow("CI jobs did not all succeed: preflight");
    }
  });

  it("runs all connected procurement shards with serial database ownership and bounded setup headroom", () => {
    const connected = source(".github/workflows/procurement-connected.yml");
    const browser = job(connected, "browser");
    const indices: number[] = JSON.parse(browser.match(/^        shard: (\[[\d, ]+\])$/m)?.[1] ?? "[]");
    expect(indices).toEqual([1, 2, 3, 4]);
    expect(browser).toContain("fail-fast: false");
    expect(browser).toContain("timeout-minutes: 20");
    expect(browser).toContain("name: Connected procurement database and browser (${{ matrix.shard }}/4)");
    expect(browser).toContain("run: npx playwright test --config playwright.procurement-connected.config.ts --shard=${{ matrix.shard }}/4 --forbid-only");
    expect(browser).not.toMatch(/--grep|--max-failures|--pass-with-no-tests|continue-on-error/);
    expect(browser).toContain("name: procurement-connected-evidence-${{ matrix.shard }}");
    expect(browser).toContain("path: test-results/procurement-connected/");
    expect(browser).toContain('ECHELON_TEST_DATABASE_DISPOSABLE: "true"');
    const config = source("playwright.procurement-connected.config.ts");
    expect(config).toContain("workers: 1");
    expect(config).toContain("fullyParallel: true");
    expect(config).toContain("globalTimeout: 12 * 60_000");
    const aggregate = job(connected, "result");
    expect(aggregate).toContain("needs: [select, browser]");
    expect(aggregate).toContain("BROWSER_RESULT: ${{ needs.browser.result }}");
  });

  it("runs cheap coverage, test-exclusion, migration and writer-ownership guards before expensive core jobs", () => {
    const preflight = job(workflow, "preflight");
    const manifest = source("scripts/ci/guard-test-manifest.mjs");
    for (const file of [
      "postgres-ci-shards.test.ts", "migration-prefix-collision.test.ts",
      "migration-allocation.test.ts", "migration-inherited-provenance.test.ts",
      "browser-ci-selection.test.ts", "dropship-browser-features.test.ts", "test-typecheck-ratchet.test.ts", "ci-fast-feedback.test.ts",
      "writer-ratchet.test.ts",
    ]) expect(manifest).toContain(`server/__tests__/unit/${file}`);
    expect(preflight).toContain("node scripts/ci/run-test-lane.mjs guards");
    for (const name of ["typecheck", "unit-tests", "contracts", "postgres-hardening-shard"]) {
      expect(job(workflow, name)).toContain("needs: preflight");
    }
  });

  it("runs only the selected feature matrix, with bounded concurrency and an unfiltered failure fallback", () => {
    const workflow = source(".github/workflows/dropship-pricing.yml");
    const select = job(workflow, "select");
    expect(select).toContain("run: node scripts/ci/dropship-browser-impact.mjs");
    expect(select).toContain("matrix: ${{ steps.impact.outputs.matrix }}");
    const browser = job(workflow, "browser");
    expect(browser).toContain("max-parallel: 4");
    expect(browser).toContain("fail-fast: false");
    expect(browser).toContain("fromJSON(needs.select.outputs.matrix ||");
    expect(browser).toContain('"feature":"all","label":"Full coverage fallback","shard":1,"shards":4');
    expect(browser).toContain('"feature":"all","label":"Full coverage fallback","shard":2,"shards":4');
    expect(browser).toContain('"feature":"all","label":"Full coverage fallback","shard":3,"shards":4');
    expect(browser).toContain('"feature":"all","label":"Full coverage fallback","shard":4,"shards":4');
    expect(browser).toContain("BROWSER_FEATURE: ${{ matrix.feature }}");
    expect(browser).toContain("--shard=${{ matrix.shard }}/${{ matrix.shards }} --forbid-only");
    expect(browser).toContain("feature-browser-traces-${{ matrix.feature }}-${{ matrix.shard }}");
    expect(job(workflow, "result")).toContain("name: Dropship pricing browser journeys\n");
    expect(workflow).not.toMatch(/continue-on-error:|paths(?:-ignore)?:|pass-with-no-tests/);
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
    expect(step).toContain("NODE_OPTIONS: --max-old-space-size=8192");
    expect(step).toContain("run: npx tsc -p tsconfig.tests.server.json");
  });

  it("partitions the unchanged unit selection into four complete, isolated shards", () => {
    const unit = job(workflow, "unit-tests");
    expect(unit).toContain("shard: [1, 2, 3, 4]");
    expect(unit).toContain("fail-fast: false");
    expect(unit).toContain("node scripts/ci/run-test-lane.mjs unit --shard=${{ matrix.shard }}/4");
    expect(unit).toContain("--maxWorkers=2");
    expect(source("scripts/ci/run-test-lane.mjs")).toContain('"--allowOnly=false", "--passWithNoTests=false"');
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
      "client/src/pages/dropship/__tests__/DropshipPortalCatalog.test.ts",
      "client/src/lib/__tests__/dropship-listing-preview.test.ts",
      "client/src/lib/__tests__/dropship-listing-price.test.ts",
      "client/src/lib/__tests__/dropship-pricing-rules.test.ts",
      "client/src/pages/dropship/__tests__/DropshipListingPreview.test.ts",
      "client/src/lib/__tests__/dropship-catalog-steps.test.ts",
      "client/src/lib/__tests__/dropship-catalog-choose.test.ts",
      "client/src/lib/__tests__/dropship-catalog-choose-requests.test.ts",
      "client/src/lib/__tests__/dropship-catalog-choose-words.test.ts",
      "client/src/pages/dropship/__tests__/DropshipCatalogChoose.test.ts",
      // PLAN-B v4.1 §15.4, §17 (B3): step 1's new-items notice (model, requests, words).
      "client/src/lib/__tests__/dropship-catalog-new-items.test.ts",
      "client/src/lib/__tests__/dropship-catalog-new-items-requests.test.ts",
      "client/src/lib/__tests__/dropship-catalog-new-items-words.test.ts",
      // PLAN-B v4.1 V31, TESTS-13: the chosen-items words of onboarding and the dashboard (both green at cea5cb027).
      "client/src/lib/__tests__/dropship-onboarding.test.ts",
      "client/src/pages/dropship/__tests__/DropshipPortalDashboard.test.ts",
      // Step 1 plan S2-5 §4.9 item 3: "site updating" for the requests stages 2-5 add.
      "client/src/lib/__tests__/dropship-api-json.test.ts",
      // Step 1 plan S2-5 PR A §4.10: Catalog step 3 on publish runs.
      "client/src/lib/__tests__/dropship-catalog-publish.test.ts",
      "client/src/lib/__tests__/dropship-catalog-publish-requests.test.ts",
      "client/src/lib/__tests__/dropship-catalog-publish-words.test.ts",
      "client/src/pages/dropship/__tests__/DropshipCatalogPublish.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings.test.ts",
      "client/src/pages/dropship/__tests__/DropshipCatalogFrame.test.ts",
      "client/src/lib/__tests__/dropship-ebay-category-rules.test.ts",
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
      "client/src/lib/__tests__/dropship-listing-settings-product-edit.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-product-requests.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsDrawerEdit.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-selection.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-bulk.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-bulk-requests.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsBulk.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-price-check.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-price-check-requests.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsPriceCheck.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-updated.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-updated-requests.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsUpdatedProducts.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-categories.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-category-requests.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsCategories.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-size-prices.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-size-prices-requests.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsSizePrices.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-conversion.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-conversion-requests.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsConversion.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-conversion-notice.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsConversionNotice.test.ts",
      "client/src/lib/__tests__/dropship-listing-settings-attention.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsHeaderBannerStrip.test.ts",
      "client/src/pages/dropship/__tests__/ListingSettingsStep.test.ts",
      "client/src/lib/__tests__/dropship-ebay-listing-setup.test.ts",
      "client/src/lib/__tests__/dropship-ebay-listing-query-sync.test.ts",
      "client/src/lib/__tests__/dropship-listing-push-status.test.ts",
      "client/src/lib/__tests__/dropship-cost-changes.test.ts",
      "client/src/pages/__tests__/dropship-portal-cost-changes-page.test.ts",
      // PLAN-B v4.1 V17 (B2b deviation 11; review CLI-7/TST-3): the only pin of the admin "Items chosen" label.
      "client/src/pages/__tests__/dropship-launch-readiness-panels.test.ts",
      "shared/dropship/__tests__/program-finance-money.test.ts",
      "shared/dropship/__tests__/program-finance-contract.test.ts",
      "shared/dropship/__tests__/program-finance-definitions.test.ts",
      "client/src/pages/__tests__/dropship-finance-model.test.ts",
      "client/src/pages/__tests__/dropship-finance-panel.test.ts",
    ]) expect(contracts).toContain(file);
    expect(contracts).toContain("--strict --types node scripts/inventory-cutover-records-*.ts");
    // Step 1 plan S2-5 (TESTS17): the Catalog page's browser stubs and specs are type-checked, every spec they serve named.
    expect(contracts).toContain("      - name: Dropship catalog browser stub types");
    for (const file of ["test/browser/dropship-policy-catalog-stubs.ts", "test/browser/dropship-policy-listing-settings-*.ts",
      "test/browser/dropship-policy-catalog-steps.spec.ts", "test/browser/dropship-policy-catalog-choose.spec.ts",
      // PLAN-B v4.1 V29: step 1 at scale, on the same stubs.
      "test/browser/dropship-policy-catalog-choose-scale.spec.ts",
      "test/browser/dropship-policy-catalog-publish-runs.spec.ts", "test/browser/dropship-policy-listing-access.spec.ts",
      // Review round 2 CT12: every file the step names, the cost changes portal spec too.
      "test/browser/dropship-policy-cost-changes-portal.spec.ts"]) {
      expect(contracts).toMatch(new RegExp(`--strict --types node --allowImportingTsExtensions --jsx preserve --lib esnext,dom [^\\n]*${file.replace(/[.*]/g, (match) => `\\${match}`)}`));
    }
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
  it("runs every Listing settings and Catalog client test in the dropship listing UI step", () => {
    const registered = new Set(vitestStepFiles(job(workflow, "contracts"), "Dropship listing policy UI contracts"));
    const onDisk = [
      ...testFilesIn("client/src/lib/__tests__/", /^dropship-listing-settings(?:-[a-z]+)*\.test\.ts$/),
      ...testFilesIn("client/src/pages/dropship/__tests__/", /^ListingSettings[A-Za-z]*\.test\.ts$/),
      // Catalog step 1 stage 1 (review CT9): the Catalog families, so a new step-1 test file can't run nowhere.
      ...testFilesIn("client/src/lib/__tests__/", /^dropship-catalog(?:-[a-z]+)*\.test\.ts$/),
      ...testFilesIn("client/src/pages/dropship/__tests__/", /^DropshipCatalog[A-Za-z]*\.test\.ts$/),
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

  it.each([
    ["order-edits", "browser"], ["inventory-availability", "browser-shard"],
    ["returns-preview", "browser-shard"], ["procurement-navigation", "browser"],
    ["dropship-pricing", "browser"],
  ])("uses a pinned compatible browser runtime in %s", (file, jobName) => {
    const lock = JSON.parse(source("package-lock.json")) as { packages: Record<string, { version: string }> };
    const version = lock.packages["node_modules/playwright"].version;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const browser = job(source(".github/workflows/" + file + ".yml"), jobName);
    const image = browser.match(/^      image: (.+)$/m)?.[1] ?? "";
    expect(image).toMatch(new RegExp("^mcr\\.microsoft\\.com/playwright:v" + version.replaceAll(".", "\\.") + "-noble@sha256:[a-f0-9]{64}$"));
    expect(browser).toContain("options: --user 1001 --ipc=host");
    expect(browser).not.toContain("playwright install");
    expect(browser).not.toContain("continue-on-error:");
  });

  it("gives procurement eight complete shards and setup headroom without weakening coverage", () => {
    const procurement = source(".github/workflows/procurement-navigation.yml");
    const browser = job(procurement, "browser");
    // Parse the actual matrix: missing/duplicated indices or a mismatched total
    // would silently repeat or omit cases even when every scheduled job succeeds.
    const indices: number[] = JSON.parse(browser.match(/^        shard: (\[[\d, ]+\])$/m)?.[1] ?? "[]");
    const totals: number[] = JSON.parse(browser.match(/^        shards: (\[[\d, ]+\])$/m)?.[1] ?? "[]");
    expect(totals).toEqual([8]);
    expect(indices).toEqual(Array.from({ length: totals[0] }, (_, index) => index + 1));
    expect(browser).toContain("timeout-minutes: 20");
    expect(browser).toContain("fail-fast: false");
    expect(browser).toContain("name: Procurement browser journeys (${{ matrix.shard }}/${{ matrix.shards }})");
    expect(browser).toContain("npx playwright test --config playwright.procurement.config.ts --shard=${{ matrix.shard }}/${{ matrix.shards }}\n");
    expect(browser).not.toMatch(/--(?:grep|grep-invert|retries|max-failures|pass-with-no-tests)\b|continue-on-error:/);
    expect(job(procurement, "result")).toContain("name: Procurement browser journeys\n");
    const config = source("playwright.procurement.config.ts");
    expect(config).toContain('testMatch: "procurement-*.spec.ts"');
    expect(config).toContain("timeout: 45_000");
    expect(config).toContain("expect: { timeout: 15_000 }");
    expect(config).not.toMatch(/retries:|maxFailures:|testIgnore:|grep:/);
  });

  it("runs all Returns shards and retains its original required check identity", () => {
    const returns = source(".github/workflows/returns-preview.yml");
    const shards = job(returns, "browser-shard");
    expect(shards).toContain("matrix: ${{ fromJSON(needs.preflight.outputs.matrix) }}");
    expect(shards).toContain("fail-fast: false");
    expect(shards).toContain("--config playwright.returns-preview.config.ts --shard=${{ matrix.shard }}/${{ matrix.shards }}");
    expect(shards).toContain("name: returns-preview-browser-results-${{ matrix.feature }}-${{ matrix.shard }}");
    const gate = job(returns, "browser");
    expect(gate).toContain("name: Returns preview browser journeys\n");
    expect(gate).toContain("needs: [preflight, browser-shard]");
    expect(gate).toContain("if: ${{ always() }}");
    expect(gate).toContain("CI_NEEDS: ${{ toJSON(needs) }}");
    expect(gate).toContain("node scripts/ci/require-selected-success.mjs browser-shard");
    expect(returns).not.toMatch(/continue-on-error:|paths(?:-ignore)?:/);
  });

  it.each([["returns-preview", 1], ["procurement", 2]] as const)("balances %s by test with %i bounded workers per runner", (suite, workers) => {
    const config = source("playwright." + suite + ".config.ts");
    expect(config).toContain("fullyParallel: true");
    expect(config).toContain(`workers: ${workers}`);
    expect(config).toContain('name: "desktop"');
    expect(config).toContain('name: "mobile"');
  });
});
