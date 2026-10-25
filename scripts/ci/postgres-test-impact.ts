import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasUncertainImpact, readTestChangeEvidence, selectTestImpact } from "./test-impact.mjs";
import { POSTGRES_SHARD_COUNT, POSTGRES_TEST_FILES } from "./postgres-test-manifest";
import { POSTGRES_TEST_DURATION_MS } from "./postgres-test-timings";
import { planPostgresShards } from "./postgres-shard-planner";

import type { ChangeEvidence } from "./test-impact.mjs";
export interface PostgresImpactPlan {
  run: boolean;
  files: string[];
  decisions: Array<{ owner: string; run: boolean; reason: string }>;
  matrix: { include: Array<{ shard: number; count: number }> };
}
// Keep the full manifest's eight-way partition on full runs. Small selections
// use fewer runners; two minutes of measured test work is the initial target.
export const SELECTED_POSTGRES_TARGET_MS = 120_000;
const globalFiles = ["package.json", "package-lock.json", ".npmrc", ".nvmrc", "tsconfig.json",
  "vitest.config.ts", "server/db.ts", "server/storage.ts"];
const globalPrefixes = ["migrations/", "shared/", "test/fixtures/", "test/helpers/", "test/support/",
  "server/platform/", "server/__tests__/", "scripts/", ".github/", "server/db/"];
const ownerFor = (file: string): string | null => /^server\/(modules\/[^/]+|platform)\//.exec(file)?.[1] ?? null;

export function postgresSelectionShardCount(files: readonly string[]): number {
  if (!files.length || files.length > POSTGRES_TEST_FILES.length || new Set(files).size !== files.length
      || files.some(file => !POSTGRES_TEST_FILES.includes(file)))
    throw new Error("PostgreSQL selection must be a nonempty, unique subset of the coverage manifest.");
  if (files.length === POSTGRES_TEST_FILES.length) return POSTGRES_SHARD_COUNT;
  const timings = POSTGRES_TEST_DURATION_MS as Readonly<Record<string, number>>;
  const fallback = Math.max(...Object.values(timings));
  const work = files.reduce((sum, file) => sum + (timings[file] ?? fallback), 0);
  return Math.max(1, Math.min(POSTGRES_SHARD_COUNT, files.length, Math.ceil(work / SELECTED_POSTGRES_TARGET_MS)));
}

function plan(files: readonly string[], decisions: PostgresImpactPlan["decisions"]): PostgresImpactPlan {
  const count = files.length ? postgresSelectionShardCount(files) : 0;
  return { run: files.length > 0, files: [...files], decisions,
    matrix: { include: Array.from({ length: count }, (_, index) => ({ shard: index + 1, count })) } };
}
export function fullPostgresPlan(reason: string): PostgresImpactPlan {
  return plan(POSTGRES_TEST_FILES, [{ owner: "all", run: true, reason }]);
}
export function selectPostgresTests(evidence: ChangeEvidence): PostgresImpactPlan {
  const owners = new Map<string, string[]>();
  for (const file of POSTGRES_TEST_FILES) {
    const owner = ownerFor(file);
    if (!owner) throw new Error("Unregistered PostgreSQL suite owner: " + file);
    owners.set(owner, [...(owners.get(owner) ?? []), file]);
  }
  // A new server area has no reviewed coverage boundary yet. Never classify it
  // as unrelated merely because existing tests do not import it.
  for (const change of evidence.changes) for (const file of change.paths) {
    if ((file.startsWith("server/") && !/\.[cm]?[jt]sx?$/.test(file))
        || (file.includes("/__tests__/integration/") && !POSTGRES_TEST_FILES.includes(file))
        || (file.startsWith("server/") && !file.includes("/__tests__/unit/") && !owners.has(ownerFor(file) ?? "")))
      return fullPostgresPlan("Unclassified server ownership: " + file);
  }
  const dependencyCache = new Map();
  const decisions: PostgresImpactPlan["decisions"] = [];
  const selected = new Set<string>();
  for (const [owner, suites] of owners) {
    const ownedFiles = [...new Set([...evidence.files, ...(evidence.previous?.files ?? [])])]
      .filter(file => file.startsWith("server/" + owner + "/") && !file.includes("/__tests__/"));
    const testPattern = new RegExp("^(?:" + suites.map(file => file.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")).join("|") + ")$");
    const decision = selectTestImpact({ ...evidence, dependencyCache, coverage: {
      roots: () => [], testPattern, ownedFiles, ownedPrefixes: [], globalFiles, globalPrefixes,
      globalPattern: /^(?:tsconfig[^/]*\.json|vitest[^/]*\.[cm]?[jt]s)$/,
      knownPrefixes: ["client/", "server/", "test/browser/", "docs/"],
      knownPattern: /^(?:README|AGENTS|LICENSE)(?:\.[^/]*)?$/,
    } });
    if (hasUncertainImpact(decision)) return fullPostgresPlan(decision.reason);
    decisions.push({ owner, ...decision });
    if (decision.run) for (const file of suites) selected.add(file);
  }
  return plan(POSTGRES_TEST_FILES.filter(file => selected.has(file)), decisions);
}
export function readPostgresImpactPlan(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): PostgresImpactPlan {
  if ((env.CI_EVENT_NAME ?? env.GITHUB_EVENT_NAME) !== "pull_request")
    return fullPostgresPlan("Full coverage for main, schedule, manual dispatch or unknown event");
  try { return selectPostgresTests(readTestChangeEvidence(env, root)); }
  catch (error) { return fullPostgresPlan("Impact evidence unavailable: " + (error instanceof Error ? error.message : String(error))); }
}
export function validatePostgresSelection(raw: string | undefined): readonly string[] {
  if (raw === undefined) return POSTGRES_TEST_FILES;
  const files: unknown = JSON.parse(raw);
  if (!Array.isArray(files) || files.some(file => typeof file !== "string")) throw new Error("Invalid PostgreSQL selection.");
  postgresSelectionShardCount(files);
  return files;
}
export function selectedPostgresShards(files: readonly string[]) {
  return planPostgresShards(files, POSTGRES_TEST_DURATION_MS, postgresSelectionShardCount(files));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selection = readPostgresImpactPlan();
  console.log(JSON.stringify(selection));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `run=${selection.run}\nfiles=${JSON.stringify(selection.files)}\nmatrix=${JSON.stringify(selection.matrix)}\n`);
}
