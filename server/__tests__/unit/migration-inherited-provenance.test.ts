import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMigrationCheck, runMigrationCheckCli } from "../../../scripts/migrations/check-migrations.mjs";
import { allocateMigration } from "../../../scripts/migrations/create-migration.mjs";
import { MigrationPolicyError, type MigrationMetadata } from "../../../scripts/migrations/migration-policy.mjs";

const REPOSITORY = "cardshellz/Echelon";
const CURRENT_PR = 1800;
const SOURCE_PR = 1801;
const TOKEN = "fixture-token-never-sent-to-a-network";
const temporaryDirectories: string[] = [];
type Change = "sql" | "metadata" | "delete" | "rename" | "reallocate" | "replace_history";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(root: string, message: string): string {
  git(root, "add", "--all");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function removeAllocation(migrationsDir: string, record: MigrationMetadata): void {
  rmSync(path.join(migrationsDir, record.migration));
  rmSync(path.join(migrationsDir, "metadata", `${record.migration}.json`));
}

/** Real Git commits and merges; only the GitHub HTTP evidence is mocked. */
function fixture(options: { inherited?: boolean; alreadyMain?: boolean; own?: boolean; change?: Change; siblings?: boolean; premergeReallocation?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "echelon-inherited-migration-test-"));
  temporaryDirectories.push(root);
  const migrationsDir = path.join(root, "migrations");
  mkdirSync(migrationsDir);
  writeFileSync(path.join(migrationsDir, "0001_base.sql"), "SELECT 1;\n");
  writeFileSync(path.join(migrationsDir, "legacy-migrations.json"), JSON.stringify({ version: 1, filenames: ["0001_base.sql"] }));
  git(root, "init");
  git(root, "config", "user.name", "Migration provenance test");
  git(root, "config", "user.email", "migration-provenance@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "commit.gpgsign", "false");
  const eventBase = commit(root, "Initial main migration");
  git(root, "branch", "-M", "fixture-main");
  const inherited: MigrationMetadata[] = [];
  let sourceMerge = eventBase;
  let sourceHead = eventBase;
  if (options.inherited !== false) {
    git(root, "checkout", "-b", "source-pr", eventBase);
    inherited.push(allocateMigration({ migrationsDir, pr: SOURCE_PR, name: "inherited" }));
    if (options.siblings) inherited.push(allocateMigration({ migrationsDir, pr: SOURCE_PR, name: "inherited_sibling" }));
    sourceHead = commit(root, "Source PR migration allocation");
    if (options.premergeReallocation) {
      removeAllocation(migrationsDir, inherited[0]);
      inherited[0] = allocateMigration({ migrationsDir, pr: SOURCE_PR, name: "final_source_allocation" });
      sourceHead = commit(root, "Reallocate pending source migration before its PR merges");
    }
    git(root, "checkout", "-b", "source-base", eventBase);
    writeFileSync(path.join(root, "source-base.txt"), "Dependency target branch\n");
    commit(root, "Advance dependency target branch");
    git(root, "merge", "--no-ff", "--no-edit", "source-pr");
    sourceMerge = git(root, "rev-parse", "HEAD");
    if (options.alreadyMain) git(root, "branch", "-f", "fixture-main", sourceMerge);
  }
  git(root, "checkout", "-b", "current-pr", sourceMerge);
  const first = inherited[0];
  if (options.change === "sql") writeFileSync(path.join(migrationsDir, first.migration), "SELECT 'substituted SQL';\n");
  if (options.change === "metadata") {
    writeFileSync(path.join(migrationsDir, "metadata", `${first.migration}.json`), JSON.stringify(first, null, 4));
  }
  if (options.change && ["delete", "rename", "reallocate", "replace_history"].includes(options.change)) {
    // Deletion/reallocation removes the ONLY foreign owner in the ordinary fixture.
    // The resulting catalog passes the strict checker; history must still be audited.
    removeAllocation(migrationsDir, first);
    if (options.change !== "delete") {
      allocateMigration({ migrationsDir, pr: options.change === "reallocate" ? CURRENT_PR : SOURCE_PR,
        name: options.change === "replace_history" ? "substituted_history" : "renamed" });
    }
  }
  const own = options.own ? allocateMigration({ migrationsDir, pr: CURRENT_PR, name: "current_change" }) : undefined;
  writeFileSync(path.join(root, "current-change.txt"), "Current PR change\n");
  const head = commit(root, "Current PR changes");
  git(root, "checkout", "fixture-main");
  writeFileSync(path.join(root, "main-change.txt"), "Main advanced independently\n");
  const effectiveBase = commit(root, "Main advance before CI merge");
  git(root, "merge", "--no-ff", "--no-edit", "current-pr");
  const merge = git(root, "rev-parse", "HEAD");
  const event = { number: CURRENT_PR, repository: { full_name: REPOSITORY },
    pull_request: { base: { sha: eventBase }, head: { sha: head } } };
  const eventFile = path.join(root, "event.json");
  writeFileSync(eventFile, JSON.stringify(event));
  const environment: NodeJS.ProcessEnv = { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventFile,
    GITHUB_REF: `refs/pull/${CURRENT_PR}/merge`, GITHUB_SHA: merge, GITHUB_REPOSITORY: REPOSITORY, GITHUB_TOKEN: TOKEN };
  const sourceEvidence = { number: SOURCE_PR, merged: true, state: "closed", merge_commit_sha: sourceMerge,
    base: { repo: { full_name: REPOSITORY } } };
  return { root, migrationsDir, eventBase, effectiveBase, sourceMerge, sourceHead, head, merge, inherited, own,
    event, eventFile, environment, sourceEvidence };
}

function mockApi(body: unknown) {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  }));
}

async function rejectsCode(action: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try { await action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(MigrationPolicyError);
  expect((caught as MigrationPolicyError).code).toBe(code);
  expect(JSON.stringify(caught)).not.toContain(TOKEN);
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe fixture cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("trusted merged-PR migration provenance", () => {
  it("accepts exact SQL and metadata inherited through an actual stacked merge, without weakening the synchronous checker", async () => {
    const context = fixture({ own: true, siblings: true });
    const fetch = mockApi(context.sourceEvidence);
    const status = git(context.root, "status", "--porcelain");
    expect(git(context.root, "show", "-s", "--format=%P", context.sourceMerge).split(" ")).toHaveLength(2);
    expect(() => runMigrationCheck(["--ci"], context.root, context.environment)).toThrowError(expect.objectContaining({ code: "MIGRATION_PR_OWNERSHIP" }));
    await expect(runMigrationCheckCli(["--ci"], context.root, context.environment, { fetch })).resolves.toMatchObject({
      event: "migration_policy_validated", pr: CURRENT_PR, migrations: 4, base: context.effectiveBase,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(`https://api.github.com/repos/${REPOSITORY}/pulls/${SOURCE_PR}`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init?.redirect).toBe("error");
    expect(git(context.root, "status", "--porcelain")).toBe(status);
  });

  it.each([
    { inherited: false, own: false }, { inherited: false, own: true }, { alreadyMain: true, own: true },
  ])("requires no token or API request when no foreign migration history needs proof: %j", async (options) => {
    const context = fixture(options);
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Unexpected network request"));
    await expect(runMigrationCheckCli(["--ci"], context.root, { ...context.environment,
      GITHUB_TOKEN: undefined, GITHUB_REPOSITORY: undefined }, { fetch })).resolves.toMatchObject({ event: "migration_policy_validated" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a source PR's final merged allocation after its unmerged draft allocation was replaced", async () => {
    const context = fixture({ premergeReallocation: true, own: true });
    const fetch = mockApi(context.sourceEvidence);
    await expect(runMigrationCheckCli(["--ci"], context.root, context.environment, { fetch })).resolves.toMatchObject({
      event: "migration_policy_validated", migrations: 3, pr: CURRENT_PR,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["delete", "reallocate"] as const)("audits %s of the sole inherited allocation even though the current strict catalog check passes", async (change) => {
    const context = fixture({ change });
    expect(() => runMigrationCheck(["--ci"], context.root, context.environment)).not.toThrow();
    const fetch = mockApi(context.sourceEvidence);
    await rejectsCode(() => runMigrationCheckCli(["--ci"], context.root, context.environment, { fetch }), "MERGED_MIGRATION_IMMUTABLE");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { change: "delete", state: "open" }, { change: "delete", state: "closed" },
    { change: "reallocate", state: "open" }, { change: "reallocate", state: "closed" },
  ] as const)("permits removal of an independently verified never-merged draft owner: %j", async ({ change, state }) => {
    const context = fixture({ change });
    const fetch = mockApi({ ...context.sourceEvidence, merged: false, state, merge_commit_sha: null });
    expect(() => runMigrationCheck(["--ci"], context.root, context.environment)).not.toThrow();
    await expect(runMigrationCheckCli(["--ci"], context.root, context.environment, { fetch })).resolves.toMatchObject({
      event: "migration_policy_validated", pr: CURRENT_PR,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not treat absent historical files as evidence that their owner was never merged", async () => {
    const context = fixture({ change: "delete" });
    const fetch = mockApi({ ...context.sourceEvidence, merged: false, state: "open", merge_commit_sha: null,
      base: { repo: { full_name: "another/repository" } } });
    await rejectsCode(() => runMigrationCheckCli(["--ci"], context.root, context.environment, { fetch }), "MIGRATION_OWNER_NOT_MERGED");
  });

  it("requires trusted lookup even when every historical foreign file was removed", async () => {
    const context = fixture({ change: "delete" });
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Connection reset"));
    await rejectsCode(() => runMigrationCheckCli(["--ci"], context.root, context.environment, { fetch }), "MIGRATION_PROVENANCE_UNAVAILABLE");
  });

  it("rejects shallow history even when missing history would let the current catalog pass", async () => {
    const context = fixture({ change: "delete" });
    // A real Git shallow boundary at the event head hides prior introductions.
    // The synthetic merge and its independent first-parent base remain available.
    writeFileSync(path.join(context.root, ".git", "shallow"), `${context.head}\n`);
    expect(git(context.root, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(() => runMigrationCheck(["--ci"], context.root, context.environment)).not.toThrow();
    const fetch = mockApi(context.sourceEvidence);
    await rejectsCode(() => runMigrationCheckCli(["--ci"], context.root, context.environment, { fetch }), "MIGRATION_GIT_EVIDENCE_UNAVAILABLE");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["sql", "metadata", "rename", "replace_history"] as const)("rejects inherited %s changes against the trusted merged tree", async (change) => {
    const context = fixture({ change });
    await rejectsCode(() => runMigrationCheckCli(["--ci"], context.root, context.environment,
      { fetch: mockApi(context.sourceEvidence) }), change === "rename" || change === "replace_history"
      ? "MIGRATION_PR_OWNERSHIP" : "MERGED_MIGRATION_IMMUTABLE");
  });

  it.each(["sql", "metadata"] as const)("rejects an uncommitted %s substitution even when both recorded Git trees are unchanged", async (part) => {
    const context = fixture();
    const first = context.inherited[0];
    const filename = part === "sql" ? path.join(context.migrationsDir, first.migration)
      : path.join(context.migrationsDir, "metadata", `${first.migration}.json`);
    writeFileSync(filename, part === "sql" ? "SELECT 'changed after checkout';\n" : JSON.stringify(first, null, 4));
    await rejectsCode(() => runMigrationCheckCli(["--ci"], context.root, context.environment,
      { fetch: mockApi(context.sourceEvidence) }), "MERGED_MIGRATION_IMMUTABLE");
  });

  it("does not let an ancestor with unrelated history bless a later foreign allocation", async () => {
    const context = fixture();
    await rejectsCode(() => runMigrationCheckCli(["--ci"], context.root, context.environment,
      { fetch: mockApi({ ...context.sourceEvidence, merge_commit_sha: context.eventBase }) }), "MIGRATION_PR_OWNERSHIP");
  });

  it("checks deleted siblings owned by the merged PR, not only the still-present file that caused lookup", async () => {
    const context = fixture({ siblings: true });
    const sibling = context.inherited[1];
    removeAllocation(context.migrationsDir, sibling);
    await rejectsCode(() => runMigrationCheckCli(["--ci"], context.root, context.environment,
      { fetch: mockApi(context.sourceEvidence) }), "MERGED_MIGRATION_IMMUTABLE");
  });

  it.each([
    { merged: false }, { state: "open" }, { number: CURRENT_PR },
    { base: { repo: { full_name: "somebody/another-repository" } } },
    { merge_commit_sha: null }, { merge_commit_sha: undefined }, { merge_commit_sha: "" },
    { merge_commit_sha: "not-a-commit" }, { merge_commit_sha: "0".repeat(40) },
  ])("rejects untrusted or incomplete owner evidence: %j", async (patch) => {
    const context = fixture();
    await rejectsCode(() => runMigrationCheckCli(["--ci"], context.root, context.environment,
      { fetch: mockApi({ ...context.sourceEvidence, ...patch }) }), "MIGRATION_OWNER_NOT_MERGED");
  });

  it("rejects a real merge-shaped commit with matching file contents when it is not an ancestor of the event head", async () => {
    const context = fixture();
    const tree = git(context.root, "rev-parse", `${context.sourceMerge}^{tree}`);
    const unrelated = git(context.root, "commit-tree", tree, "-p", context.eventBase, "-p", context.sourceHead,
      "-m", "Different merge with identical allocation bytes");
    await rejectsCode(() => runMigrationCheckCli(["--ci"], context.root, context.environment,
      { fetch: mockApi({ ...context.sourceEvidence, merge_commit_sha: unrelated }) }), "MIGRATION_INHERITED_NOT_ANCESTOR");
  });

  it.each([
    { GITHUB_TOKEN: undefined }, { GITHUB_TOKEN: "" }, { GITHUB_REPOSITORY: undefined },
    { GITHUB_REPOSITORY: "another/repository" }, { GITHUB_REPOSITORY: "https://attacker.invalid/repository" },
  ])("fails closed before a request when trusted lookup configuration is missing or mismatched: %j", async (override) => {
    const context = fixture();
    const fetch = mockApi(context.sourceEvidence);
    await rejectsCode(() => runMigrationCheckCli(["--ci"], context.root, { ...context.environment, ...override }, { fetch }), "MIGRATION_PROVENANCE_UNAVAILABLE");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 429, 500])("fails closed for owner lookup HTTP %s", async (status) => {
    const context = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("Lookup unavailable", { status }));
    await rejectsCode(() => runMigrationCheckCli(["--ci"], context.root, context.environment, { fetch }), "MIGRATION_PROVENANCE_UNAVAILABLE");
  });

  it("fails closed for network and malformed JSON responses without exposing credentials", async () => {
    const context = fixture();
    for (const fetch of [
      vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(`Connection reset while using ${TOKEN}`)),
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("not JSON", { status: 200 })),
    ]) {
      await rejectsCode(() => runMigrationCheckCli(["--ci"], context.root, context.environment, { fetch }), "MIGRATION_PROVENANCE_UNAVAILABLE");
    }
  });

  it("still rejects edits to history already on main before looking up a foreign owner", async () => {
    const context = fixture({ alreadyMain: true, change: "sql" });
    const fetch = mockApi(context.sourceEvidence);
    await rejectsCode(() => runMigrationCheckCli(["--ci"], context.root, context.environment, { fetch }), "MERGED_MIGRATION_IMMUTABLE");
    expect(fetch).not.toHaveBeenCalled();
  });
});
