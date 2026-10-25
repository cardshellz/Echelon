import { hasUncertainImpact } from "./test-impact.mjs";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readBrowserChangeEvidence, selectBrowserSuite } from "./browser-suite-impact.mjs";
import { DROPSHIP_BROWSER_FEATURES, validateDropshipFeatureCoverage } from "./dropship-browser-features.mjs";

// If coverage registration or diff evidence cannot be trusted, the original
// unfiltered Playwright configuration still discovers and runs all specs.
// Two full-suite shards exceeded the workflow's 15-minute job budget. Keep
// complete coverage and the existing budget while using its four worker slots.
const FULL_BROWSER_SHARDS = 4;
export function fullDropshipBrowserPlan(reason) {
  return { run: true, decisions: [{ feature: "all", run: true, reason }], matrix: { include:
    Array.from({ length: FULL_BROWSER_SHARDS }, (_, index) => ({
      feature: "all", label: "Full coverage fallback", shard: index + 1, shards: FULL_BROWSER_SHARDS,
    })),
  } };
}

export function selectDropshipBrowserFeatures({ changes, files, readSource, previous, force = false }) {
  try {
    validateDropshipFeatureCoverage(files);
    const definitions = Object.fromEntries(Object.entries(DROPSHIP_BROWSER_FEATURES).map(([name, group]) => [name, {
      config: "playwright.dropship-pricing.config.ts",
      workflow: ".github/workflows/dropship-pricing.yml",
      tests: new RegExp(`^(?:${group.tests.map(file => file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`),
      roots: [...group.roots],
      // These tests mock APIs. Backend coverage remains in the unchanged unit
      // and PostgreSQL jobs; source actually imported by a spec is still followed.
      ownedPrefixes: [],
      isolated: true,
    }]));
    const dependencyCache = new Map();
    const decisions = Object.keys(definitions).map(feature => ({ feature,
      ...selectBrowserSuite({ suite: feature, changes, files, readSource, previous, force, definitions, dependencyCache }),
    }));
    if (decisions.some(hasUncertainImpact))
      return { ...fullDropshipBrowserPlan("Dependency evidence is uncertain"), decisions };
    const include = decisions.filter(result => result.run).flatMap(({ feature }) => {
      const { label, shards } = DROPSHIP_BROWSER_FEATURES[feature];
      return Array.from({ length: shards }, (_, index) => ({ feature, label, shard: index + 1, shards }));
    });
    return { run: include.length > 0, decisions, matrix: { include } };
  } catch (error) {
    return fullDropshipBrowserPlan(`Feature coverage was uncertain: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function runDropshipBrowserSelection(environment = process.env, root = process.cwd()) {
  let plan;
  try {
    plan = environment.BROWSER_EVENT_NAME === "workflow_dispatch"
      ? fullDropshipBrowserPlan("Manual dispatch requests complete coverage")
      : selectDropshipBrowserFeatures(readBrowserChangeEvidence(environment, root));
  } catch (error) {
    plan = fullDropshipBrowserPlan(`Selection evidence unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(plan));
  if (environment.GITHUB_OUTPUT) {
    appendFileSync(environment.GITHUB_OUTPUT, `run=${plan.run}\nmatrix=${JSON.stringify(plan.matrix)}\n`);
  }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runDropshipBrowserSelection();
