import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_PR_NUMBER, boundedInteger, fail, readMigrationInventory,
  reportMigrationError, validateLegacyManifest, validateMigrationInventory,
} from "./migration-policy.mjs";

const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function isCommitSha(value) {
  return typeof value === "string" && COMMIT_SHA.test(value) && !/^0+$/.test(value);
}

function git(repositoryRoot, args) {
  try {
    return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    fail("MIGRATION_GIT_EVIDENCE_UNAVAILABLE", `Cannot read Git evidence. Fetch the base commit with full history before checking migrations.`, { command: args[0] });
  }
}

export function baseMigrationFiles(repositoryRoot, baseRef) {
  if (typeof baseRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(baseRef)) fail("INVALID_BASE_REF", "A valid base commit or ref is required.");
  const commit = git(repositoryRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`]).trim();
  const files = git(repositoryRoot, ["ls-tree", "-r", "--name-only", "-z", commit, "--", "migrations"]).split("\0").filter(Boolean);
  return { commit, files, sql: files.filter((file) => /^migrations\/[^/]+\.sql$/.test(file)) };
}

export function ciMigrationContext(eventName, event) {
  let base;
  let pr;
  let head;
  if (eventName === "workflow_dispatch") {
    // A manual dispatch identifies a checkout, not an immutable PR base or owner.
    return {};
  } else if (eventName === "pull_request") {
    base = event?.pull_request?.base?.sha;
    pr = boundedInteger(event?.number, MAX_PR_NUMBER, "pull request number");
    head = event?.pull_request?.head?.sha;
  } else if (eventName === "push") {
    base = event?.before;
  } else if (eventName === "merge_group") {
    base = event?.merge_group?.base_sha;
  } else {
    fail("UNSUPPORTED_MIGRATION_CI_EVENT", `Unsupported migration CI event: ${eventName ?? "none"}.`);
  }
  if (!isCommitSha(base)) {
    fail("MISSING_MIGRATION_BASE", "The GitHub event must identify a nonzero base commit; no base evidence may be guessed.");
  }
  if (eventName === "pull_request") {
    if (!isCommitSha(head)) fail("MISSING_MIGRATION_HEAD", "The pull request event must identify a nonzero head commit.");
    return { base, pr, head };
  }
  return { base, pr };
}

function pullRequestMigrationBase(repositoryRoot, context, environment) {
  const { base, pr, head } = context;
  const merge = environment.GITHUB_SHA;
  if (environment.GITHUB_REF !== `refs/pull/${pr}/merge` || !isCommitSha(merge)) {
    fail("MIGRATION_PR_CHECKOUT_MISMATCH", "Pull request migration checks require the event's synthetic merge ref and commit.", { pr });
  }
  const checkout = git(repositoryRoot, ["rev-parse", "--verify", "HEAD"]).trim();
  const parents = git(repositoryRoot, ["show", "-s", "--format=%P", checkout]).trim().split(/\s+/);
  if (checkout !== merge || parents.length !== 2 || parents[1] !== head) {
    fail("MIGRATION_PR_CHECKOUT_MISMATCH", "The checked-out commit must be the event's two-parent merge with the recorded PR head as its second parent.", { pr, checkout, merge, head, parents });
  }
  // GitHub can build the merge after main advances beyond the event's base SHA.
  // Use that merge's verified base, so migrations already on main retain their owner.
  const actualBase = parents[0];
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", base, actualBase], {
    cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  // Git distinguishes a valid non-ancestor (1) from unavailable/broken evidence.
  if (ancestry.error || ![0, 1].includes(ancestry.status)) {
    fail("MIGRATION_GIT_EVIDENCE_UNAVAILABLE", "Cannot verify merge ancestry. Fetch the event base and full merge history before checking migrations.", { command: "merge-base" });
  }
  if (ancestry.status === 1) {
    fail("MIGRATION_PR_BASE_MISMATCH", "The checked-out merge base must descend from the event's base commit. Refresh the PR before retrying.", { eventBase: base, actualBase });
  }
  return actualBase;
}

export function validateMigrationChanges(repositoryRoot, baseRef, ownerPr) {
  if (ownerPr !== undefined) boundedInteger(ownerPr, MAX_PR_NUMBER, "pull request number");
  const inventory = readMigrationInventory(path.join(repositoryRoot, "migrations"));
  const filenames = validateMigrationInventory(inventory);
  const base = baseMigrationFiles(repositoryRoot, baseRef);
  const basePaths = new Set(base.files);
  const changed = git(repositoryRoot, ["diff", "--name-only", "--no-renames", "-z", base.commit, "--", "migrations"]).split("\0").filter(Boolean);
  for (const file of changed) {
    if (basePaths.has(file) && (/^migrations\/[^/]+\.sql$/.test(file)
        || file.startsWith("migrations/metadata/") || file === "migrations/legacy-migrations.json")) {
      fail("MERGED_MIGRATION_IMMUTABLE", `Migration history already on the base cannot be changed, renamed, or deleted: ${file}. Create a new migration.`, { file, base: base.commit });
    }
  }
  if (!basePaths.has("migrations/legacy-migrations.json")) {
    const expected = base.sql.map((file) => file.slice("migrations/".length)).sort();
    const actual = validateLegacyManifest(inventory.legacyManifest);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      fail("LEGACY_BOOTSTRAP_MISMATCH", "The initial legacy allowlist must contain exactly the SQL migrations already on the base commit.", { base: base.commit });
    }
  }
  const added = filenames.filter((file) => !basePaths.has(`migrations/${file}`));
  for (const filename of added) {
    const record = inventory.metadata.get(filename);
    if (!record || (ownerPr !== undefined && record.pr !== ownerPr)) {
      fail("MIGRATION_PR_OWNERSHIP", `New migration ${filename} must be allocated to ${ownerPr === undefined ? "its owning PR" : `PR ${ownerPr}`}.`, { filename, expectedPr: ownerPr ?? null });
    }
  }
  return { filenames, added, base: base.commit };
}

export function runMigrationCheck(args, repositoryRoot = process.cwd(), environment = process.env) {
  let ci = false;
  let base;
  let pr;
  let eventBase;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ci" && !ci) ci = true;
    else if (args[i] === "--base" && base === undefined && args[i + 1]) base = args[++i];
    else if (args[i] === "--pr" && pr === undefined && /^\d+$/.test(args[i + 1] ?? "")) pr = boundedInteger(Number(args[++i]), MAX_PR_NUMBER, "pr");
    else fail("INVALID_CHECK_ARGUMENT", "Usage: check-migrations.mjs [--ci | --base <ref> [--pr <number>]].");
  }
  if (ci) {
    if (base !== undefined || pr !== undefined) fail("AMBIGUOUS_CI_EVIDENCE", "--ci cannot be combined with manually supplied base or PR evidence.");
    let event;
    try { event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, "utf8")); }
    catch { fail("MISSING_MIGRATION_CI_EVENT", "GITHUB_EVENT_PATH must identify a readable GitHub event JSON file."); }
    const context = ciMigrationContext(environment.GITHUB_EVENT_NAME, event);
    ({ base, pr } = context);
    if (environment.GITHUB_EVENT_NAME === "pull_request") {
      eventBase = base;
      base = pullRequestMigrationBase(repositoryRoot, context, environment);
    }
  }
  if (pr !== undefined && base === undefined) fail("MISSING_MIGRATION_BASE", "--pr requires --base.");
  const filenames = base === undefined
    ? validateMigrationInventory(readMigrationInventory(path.join(repositoryRoot, "migrations")))
    : validateMigrationChanges(repositoryRoot, base, pr).filenames;
  return {
    event: "migration_policy_validated",
    migrations: filenames.length,
    ...(base === undefined ? {} : { base }),
    ...(pr === undefined ? {} : { pr }),
    ...(eventBase === undefined ? {} : { eventBase }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(runMigrationCheck(process.argv.slice(2)))); }
  catch (error) { reportMigrationError(error); process.exitCode = 1; }
}
