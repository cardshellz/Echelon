import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dependencyClosure, importsIn, resolveLocalImport, parseChangedFiles, readTestChangeEvidence, selectTestImpact } from "./test-impact.mjs";
export { dependencyClosure, parseChangedFiles };

// Procurement loads the real application. App eagerly imports all pages, so even
// an unrelated page can break startup. Preserve that full runtime dependency
// graph; narrowing procurement to route-specific pages would be unsafe today.
// Both commit snapshots are traversed, so deleted dependencies remain covered.
export const BROWSER_SUITES = {
  orderEdits: {
    config: "playwright.order-edits.config.ts",
    workflow: ".github/workflows/order-edits.yml",
    tests: /^test\/browser\/(order-edits|customer-order-edit-(?:resume|rewards|payment))\.spec\.ts$/,
    // The pilot renders the real application, including its eager page imports.
    roots: ["client/src/main.tsx", "client/src/customer-account/entry.tsx", "test/browser/fixtures/customer-order-edit-harness.tsx"],
    ownedPrefixes: ["server/modules/order-edits/", "client/src/pages/OrderEdits.tsx"],
  },
  procurement: {
    config: "playwright.procurement.config.ts",
    workflow: ".github/workflows/procurement-navigation.yml",
    tests: /^test\/browser\/procurement-.*\.ts$/,
    roots: ["client/src/main.tsx"],
    ownedPrefixes: ["client/src/features/purchasing/", "client/src/features/po-edit/", "client/src/components/purchasing/"],
  },
  procurementConnected: {
    config: "playwright.procurement-connected.config.ts",
    workflow: ".github/workflows/procurement-connected.yml",
    tests: /^test\/connected\/procurement\/.*\.spec\.ts$/,
    // The backend is started in a child process; it must be an explicit root.
    roots: ["client/src/main.tsx", "test/connected/procurement/server.ts"],
    ownedPrefixes: ["test/connected/procurement/", "server/modules/procurement/", "migrations/", "tsconfig.tests.connected.json"],
  },
  dropship: {
    config: "playwright.dropship-pricing.config.ts",
    workflow: ".github/workflows/dropship-pricing.yml",
    tests: /^test\/browser\/(?:dropship-(?:pricing|content|policy)-.*\.ts|dropship-shipping-estimate\.spec\.ts|dropship-wallet\.spec\.ts|dropship-orders\.spec\.ts|dropship-finance\.spec\.ts|dropship-onboarding\.spec\.ts|shared-shipping-configuration\.spec\.ts|bounded-page-loading\.spec\.ts|catalog-conversions\.spec\.ts)$/,
    // These modules are injected by mocked HTML, not imported by the specs.
    roots: [
      "dropship-catalog", "dropship-cost-change-policy",
      "dropship-cost-changes",
      "dropship-shipping-estimate", "dropship-wallet", "dropship-orders", "dropship-finance", "dropship-onboarding",
      "shared-shipping-configuration", "bounded-page-loading", "catalog-conversion",
    ].map((harness) => `test/browser/fixtures/${harness}-harness.tsx`),
    ownedPrefixes: ["client/src/pages/dropship/", "client/src/components/shipping/", "server/modules/dropship/"],
  },
};

const GLOBAL_PREFIXES = [
  "shared/", "client/src/components/ui/", "client/src/components/layout/",
  "client/src/hooks/", "client/src/lib/", "client/src/styles/", "client/public/",
  "attached_assets/", "scripts/ci/",
];
const GLOBAL_FILES = new Set([
  "client/src/App.tsx", "client/src/main.tsx", "client/index.html", "client/src/index.css",
  "package.json", "package-lock.json", ".npmrc", ".nvmrc", "tsconfig.json", "vitest.config.ts",
]);
// Isolated harnesses do not execute App or every shared module. Keep build,
// dependency, style and asset changes broad, then follow actual source imports.
const ISOLATED_GLOBAL_FILES = new Set([
  "package.json", "package-lock.json", ".npmrc", ".nvmrc", "tsconfig.json", "vitest.config.ts",
]);
const ISOLATED_GLOBAL_PREFIXES = ["client/public/", "attached_assets/", "scripts/ci/"];
const KNOWN_NON_BROWSER_PREFIXES = ["server/", "migrations/", "docs/", "scripts/", ".github/"];
const KNOWN_FEATURE_PREFIXES = ["client/src/pages/", "client/src/features/", "client/src/components/"];

function sharedShellRoots(files, readSource) {
  const app = "client/src/App.tsx";
  if (!files.has(app)) throw new Error("Missing application shell");
  const manifest = JSON.parse(readSource("package.json"));
  const packages = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }));
  return importsIn(readSource(app), app)
    .map((specifier) => resolveLocalImport(app, specifier, files, packages))
    .filter((file) => file && !file.startsWith("client/src/pages/"));
}

export function selectBrowserSuite({ suite, changes, files, readSource, previous, force = false, definitions = BROWSER_SUITES, dependencyCache }) {
  if (!Object.hasOwn(definitions, suite)) throw new Error(`Unknown browser suite: ${suite}`);
  if (force) return { run: true, reason: "Manual dispatch requests complete coverage" };
  const config = definitions[suite];
  return selectTestImpact({ changes, files, readSource, previous, dependencyCache, coverage: {
    roots: snapshot => [...config.roots, ...(config.isolated ? [] : sharedShellRoots(snapshot.files, snapshot.readSource))],
    testPattern: config.tests,
    ownedFiles: [config.config, config.workflow],
    ownedPrefixes: config.ownedPrefixes,
    globalFiles: [...(config.isolated ? ISOLATED_GLOBAL_FILES : GLOBAL_FILES)],
    globalPrefixes: config.isolated ? ISOLATED_GLOBAL_PREFIXES : GLOBAL_PREFIXES,
    globalPattern: /^(?:vite|tailwind|postcss|playwright)[^/]*\.[cm]?[jt]s$|\.(?:css|scss|sass|less)$/,
    knownPrefixes: [...KNOWN_FEATURE_PREFIXES, ...KNOWN_NON_BROWSER_PREFIXES, "test/browser/",
      ...(config.isolated ? ["shared/", "client/src/", "test/browser/"] : [])],
    knownPattern: /^test\/browser\/(?:procurement-|dropship-)|^(?:README|AGENTS|LICENSE)(?:\.[^/]*)?$/,
  } });
}
export const readBrowserChangeEvidence = readTestChangeEvidence;

export function runSelection(environment = process.env, root = process.cwd()) {
  const suite = environment.BROWSER_SUITE;
  if (!Object.hasOwn(BROWSER_SUITES, suite ?? "")) throw new Error("BROWSER_SUITE must name a configured suite");
  let selection;
  try {
    if (environment.BROWSER_EVENT_NAME === "workflow_dispatch") {
      selection = { run: true, reason: "Manual dispatch requests complete coverage" };
    } else {
      selection = selectBrowserSuite({ suite, ...readBrowserChangeEvidence(environment, root) });
    }
  } catch (error) {
    selection = { run: true, reason: `Selection evidence unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  console.log(JSON.stringify({ suite, ...selection }));
  if (environment.GITHUB_OUTPUT) appendFileSync(environment.GITHUB_OUTPUT, `run=${selection.run}\n`);
  return selection;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runSelection();
