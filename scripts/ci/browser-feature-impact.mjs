import { hasUncertainImpact } from "./test-impact.mjs";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readBrowserChangeEvidence, selectBrowserSuite } from "./browser-suite-impact.mjs";
import { BROWSER_CONFIGS, BROWSER_FEATURES, validateBrowserFeatures } from "./browser-feature-manifest.mjs";

export function fullBrowserFeaturePlan(suite, reason) {
  const config = BROWSER_CONFIGS[suite];
  if (!config) throw new Error("Unknown browser suite: " + suite);
  return { run: true, decisions: [{ feature: "all", run: true, reason }], matrix: { include:
    Array.from({ length: config.shards }, (_, i) => ({ feature: "all", shard: i + 1, shards: config.shards })) } };
}
export function selectBrowserFeatures(suite, evidence) {
  try {
    validateBrowserFeatures(suite, evidence.files);
    const definitions = Object.fromEntries(Object.entries(BROWSER_FEATURES[suite]).map(([name, group]) => [name, {
      ...BROWSER_CONFIGS[suite], roots: group.roots, appRoutes: group.appRoutes, ownedPrefixes: [], isolated: true,
      tests: new RegExp("^(?:" + group.tests.map(file => file.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")).join("|") + ")$"),
    }]));
    const dependencyCache = new Map();
    const decisions = Object.keys(definitions).map(feature => ({ feature,
      ...selectBrowserSuite({ suite: feature, ...evidence, definitions, dependencyCache }) }));
    // Preserve the already-tested full-suite partition when every feature is
    // affected or when any dependency graph cannot prove its scope.
    if (decisions.every(d => d.run) || decisions.some(hasUncertainImpact))
      return { ...fullBrowserFeaturePlan(suite, "Full coverage: affected or uncertain scope"), decisions };
    const include = decisions.filter(d => d.run).flatMap(({ feature }) =>
      Array.from({ length: BROWSER_FEATURES[suite][feature].shards }, (_, i) => ({
        feature, shard: i + 1, shards: BROWSER_FEATURES[suite][feature].shards,
      })));
    return { run: include.length > 0, decisions, matrix: { include } };
  } catch (error) { return fullBrowserFeaturePlan(suite, "Coverage evidence unavailable: " + (error instanceof Error ? error.message : String(error))); }
}
export function runBrowserFeatureSelection(env = process.env, root = process.cwd()) {
  const suite = env.BROWSER_SUITE;
  let plan;
  try {
    plan = env.BROWSER_EVENT_NAME === "pull_request"
      ? selectBrowserFeatures(suite, readBrowserChangeEvidence(env, root))
      : fullBrowserFeaturePlan(suite, "Full coverage for main, schedule, dispatch or unknown event");
  } catch (error) { plan = fullBrowserFeaturePlan(suite, "Impact evidence unavailable: " + (error instanceof Error ? error.message : String(error))); }
  console.log(JSON.stringify(plan));
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT,
    `run=${plan.run}\nmatrix=${JSON.stringify(plan.matrix)}\n`);
  return plan;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runBrowserFeatureSelection();
