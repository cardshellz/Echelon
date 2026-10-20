import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_GENERATION, MAX_ORDINAL, MAX_PR_NUMBER, MigrationPolicyError,
  formatAllocatedFilename, parseAllocatedFilename, validateMigrationDirectory, validateMigrationInventory,
  type MigrationInventory, type MigrationMetadata,
} from "../../../scripts/migrations/migration-policy.mjs";
import { allocateMigration, planMigration, runMigrationAllocation } from "../../../scripts/migrations/create-migration.mjs";
import { ciMigrationContext, runMigrationCheck, validateMigrationChanges } from "../../../scripts/migrations/check-migrations.mjs";

const failures = vi.hoisted(() => ({ nextSqlWrite: false, nextSidecarUnlink: false, openFiles: new Map<number, string>() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (typeof args[0] === "string") failures.openFiles.set(fd, args[0]);
      return fd;
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>) => {
      failures.openFiles.delete(args[0]);
      return actual.closeSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const filename = typeof args[0] === "number" ? failures.openFiles.get(args[0]) : args[0];
      if (failures.nextSqlWrite && typeof filename === "string" && filename.endsWith(".sql")) {
        failures.nextSqlWrite = false;
        actual.writeFileSync(args[0], "partial write before disk failure");
        throw Object.assign(new Error("Injected SQL write failure"), { code: "EIO" });
      }
      return actual.writeFileSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (failures.nextSidecarUnlink && typeof args[0] === "string" && args[0].endsWith(".sql.json")) {
        failures.nextSidecarUnlink = false;
        throw Object.assign(new Error("Injected old sidecar removal failure"), { code: "EIO" });
      }
      return actual.unlinkSync(...args);
    },
  };
});

const legacy = ["0001_base.sql", "0751_cost.sql", "261_mail.sql"];
const temporaryDirectories: string[] = [];
const toolRoot = fileURLToPath(new URL("../../../scripts/migrations/", import.meta.url));
function inventory(...records: MigrationMetadata[]): MigrationInventory {
  return {
    filenames: [...legacy, ...records.map((record) => record.migration)],
    legacyManifest: { version: 1, filenames: [...legacy] },
    metadata: new Map(records.map((record) => [record.migration, record])),
  };
}
function allocation(pr = 1800, generation = 1, ordinal = 1, after = [legacy.at(-1)!]): MigrationMetadata {
  return { version: 1, migration: formatAllocatedFilename({ pr, generation, ordinal, name: "example" }), pr, generation, ordinal, after };
}
function fixture(withManifest = true): { root: string; migrationsDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "echelon-migration-test-"));
  temporaryDirectories.push(root);
  const migrationsDir = path.join(root, "migrations");
  mkdirSync(migrationsDir);
  for (const file of legacy) writeFileSync(path.join(migrationsDir, file), `-- ${file}\nSELECT 1;\n`);
  if (withManifest) manifest(migrationsDir);
  return { root, migrationsDir };
}
function manifest(migrationsDir: string): void {
  writeFileSync(path.join(migrationsDir, "legacy-migrations.json"), JSON.stringify({ version: 1, filenames: legacy }));
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commitFixture(root: string): string {
  git(root, "init");
  git(root, "config", "user.name", "Migration test");
  git(root, "config", "user.email", "migration-test@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  git(root, "add", "migrations");
  git(root, "commit", "-m", "fixture");
  return git(root, "rev-parse", "HEAD");
}
function prMergeFixture(options: { migrationOwner?: number; mutateMain?: "sql" | "sidecar" } = {}) {
  const { root, migrationsDir } = fixture();
  const eventBase = commitFixture(root);
  git(root, "branch", "-M", "fixture-main");
  const mainMigration = allocateMigration({ migrationsDir, pr: 1801, name: "merged_on_main" });
  git(root, "add", "migrations");
  git(root, "commit", "-m", "Advance main with another PR migration");
  const effectiveBase = git(root, "rev-parse", "HEAD");

  // Ordinary PRs still branch from the event-era base. A PR that edits newly
  // merged history first includes that history, then changes its SQL/sidecar.
  git(root, "checkout", "-b", "fixture-pr", options.mutateMain ? effectiveBase : eventBase);
  if (options.migrationOwner !== undefined) allocateMigration({ migrationsDir, pr: options.migrationOwner, name: "pr_change" });
  if (options.mutateMain === "sql") writeFileSync(path.join(migrationsDir, mainMigration.migration), "SELECT 'changed after merge';\n");
  if (options.mutateMain === "sidecar") {
    writeFileSync(path.join(migrationsDir, "metadata", `${mainMigration.migration}.json`), JSON.stringify(mainMigration, null, 4));
  }
  writeFileSync(path.join(root, "pr-change.txt"), "A change outside migrations.\n");
  git(root, "add", "migrations", "pr-change.txt");
  git(root, "commit", "-m", "PR changes");
  const head = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "fixture-main");
  git(root, "merge", "--no-ff", "--no-edit", "fixture-pr");
  const merge = git(root, "rev-parse", "HEAD");
  const event = { number: 1800, pull_request: { base: { sha: eventBase }, head: { sha: head } } };
  const eventFile = path.join(root, "event.json");
  writeFileSync(eventFile, JSON.stringify(event));
  const environment: NodeJS.ProcessEnv = {
    GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventFile,
    GITHUB_REF: "refs/pull/1800/merge", GITHUB_SHA: merge,
  };
  return { root, migrationsDir, eventBase, effectiveBase, head, merge, event, eventFile, environment, mainMigration };
}
function expectCode(action: () => unknown, code: string): void {
  try { action(); throw new Error("Expected rejection"); }
  catch (error) { expect(error).toBeInstanceOf(MigrationPolicyError); expect((error as MigrationPolicyError).code).toBe(code); }
}
afterEach(() => {
  failures.nextSqlWrite = false;
  failures.nextSidecarUnlink = false;
  failures.openFiles.clear();
  for (const root of temporaryDirectories.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe fixture cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("migration namespace and dependency policy", () => {
  it("preserves legacy lexical order and places every new migration after it", () => {
    const record = allocation();
    expect(validateMigrationInventory(inventory(record))).toEqual([...legacy, record.migration]);
    expect(record.migration.split("_")[0]).toHaveLength(21);
  });
  it("distinguishes historical string prefixes and catches real collisions first", () => {
    const current = inventory();
    current.filenames.push("001_extra.sql");
    current.legacyManifest = { version: 1, filenames: ["0001_base.sql", "001_extra.sql", ...legacy.slice(1)] };
    expect(validateMigrationInventory(current)).toHaveLength(4);
    current.filenames.push("0751_collision.sql");
    expectCode(() => validateMigrationInventory(current), "DUPLICATE_MIGRATION_PREFIX");
  });
  it("uses exact bounded fields even though the whole prefix exceeds safe integer precision", () => {
    const filename = formatAllocatedFilename({ generation: MAX_GENERATION, pr: MAX_PR_NUMBER, ordinal: MAX_ORDINAL, name: "maximum" });
    expect(parseAllocatedFilename(filename)).toEqual({ generation: MAX_GENERATION, pr: MAX_PR_NUMBER, ordinal: MAX_ORDINAL, name: "maximum" });
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_PR_NUMBER + 1])("rejects invalid PR number %s", (pr) => {
    expectCode(() => planMigration(inventory(), { pr, name: "invalid" }), "INVALID_ALLOCATION_FIELD");
  });
  it("allocates independent PRs without colliding on the same snapshot", () => {
    const first = planMigration(inventory(), { pr: 1800, name: "first" });
    const second = planMigration(inventory(), { pr: 1801, name: "second" });
    expect(first.generation).toBe(second.generation);
    expect(first.migration.split("_")[0]).not.toBe(second.migration.split("_")[0]);
    expect(validateMigrationInventory(inventory(first, second))).toHaveLength(5);
  });
  it("puts an older PR after its newer PR dependency and increments same-PR ordinals", () => {
    const newer = allocation(1900);
    const older = planMigration(inventory(newer), { pr: 1800, name: "depends_on_newer", after: [newer.migration] });
    expect(older.generation).toBe(2);
    expect(older.migration > newer.migration).toBe(true);
    const next = planMigration(inventory(newer, older), { pr: 1800, name: "next" });
    expect(next.ordinal).toBe(2);
    expect(next.generation).toBe(3);
    expect(next.after).toEqual([older.migration]);
    expect(validateMigrationInventory(inventory(newer, older, next))).toHaveLength(6);
  });
  it("includes explicit dependencies and the latest lexical visible migration", () => {
    expect(planMigration(inventory(), { pr: 1800, name: "new", after: [legacy[0], legacy[0]] }).after).toEqual([legacy[0], legacy[2]]);
  });
  it("rejects undeclared legacy additions, missing legacy files, and missing sidecars", () => {
    const unallocated = inventory(); unallocated.filenames.push("0752_new.sql");
    expectCode(() => validateMigrationInventory(unallocated), "UNALLOCATED_MIGRATION");
    const missing = inventory(); missing.filenames.pop();
    expectCode(() => validateMigrationInventory(missing), "MISSING_LEGACY_MIGRATION");
    const noSidecar = inventory(allocation()); noSidecar.metadata.clear();
    expectCode(() => validateMigrationInventory(noSidecar), "MISSING_MIGRATION_METADATA");
  });
  it.each([
    { version: 2 }, { pr: 19 }, { migration: "different.sql" }, { ordinal: 0 },
    { after: [legacy[2], legacy[0]] }, { after: [legacy[2], legacy[2]] }, { after: null }, { extra: true },
  ])("rejects inconsistent metadata %j", (patch) => {
    const record = allocation(); const current = inventory(record);
    current.metadata.set(record.migration, { ...record, ...patch });
    expectCode(() => validateMigrationInventory(current), "INVALID_METADATA");
  });
  it("rejects orphan sidecars and duplicate PR ordinals across generations", () => {
    const orphan = inventory(); const record = allocation(); orphan.metadata.set(record.migration, record);
    expectCode(() => validateMigrationInventory(orphan), "ORPHAN_MIGRATION_METADATA");
    const later = allocation(record.pr, 2, record.ordinal, [record.migration]);
    expectCode(() => validateMigrationInventory(inventory(record, later)), "DUPLICATE_PR_ORDINAL");
  });
  it("rejects missing dependencies, cycles, forward execution order, and generation gaps", () => {
    expectCode(() => planMigration(inventory(), { pr: 1800, name: "missing", after: ["999_missing.sql"] }), "MISSING_MIGRATION_DEPENDENCY");
    expectCode(() => validateMigrationInventory(inventory(allocation(1800, 1, 1, ["999_missing.sql"]))), "MISSING_MIGRATION_DEPENDENCY");
    const self = allocation(); self.after = [self.migration];
    expectCode(() => validateMigrationInventory(inventory(self)), "MIGRATION_DEPENDENCY_CYCLE");
    const first = allocation(); const second = allocation(1801, 2, 1, [first.migration]); first.after = [second.migration];
    expectCode(() => validateMigrationInventory(inventory(first, second)), "MIGRATION_DEPENDENCY_CYCLE");
    second.after = [legacy[2]];
    expectCode(() => validateMigrationInventory(inventory(first, second)), "MIGRATION_DEPENDENCY_ORDER");
    expectCode(() => validateMigrationInventory(inventory(allocation(1800, 3))), "MIGRATION_GENERATION_MISMATCH");
  });
  it("rejects ordinal exhaustion instead of wrapping or choosing a random identifier", () => {
    const last = allocation(1800, 1, MAX_ORDINAL);
    expectCode(() => planMigration(inventory(last), { pr: 1800, name: "overflow" }), "INVALID_ALLOCATION_FIELD");
    expectCode(() => formatAllocatedFilename({ generation: MAX_GENERATION + 1, pr: 1, ordinal: 1, name: "overflow" }), "INVALID_ALLOCATION_FIELD");
  });
});

describe("migration allocation filesystem safety", () => {
  it("adopts unmerged SQL without changing one byte, including BOM and CRLF", () => {
    const { migrationsDir } = fixture();
    const source = "0751_unmerged.sql";
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("-- audit\r\nSELECT '£';\r\n")]);
    writeFileSync(path.join(migrationsDir, source), bytes);
    const before = createHash("sha256").update(bytes).digest("hex");
    const record = allocateMigration({ migrationsDir, pr: 1800, name: "audit", adopt: source });
    const after = readFileSync(path.join(migrationsDir, record.migration));
    expect(after.equals(bytes)).toBe(true);
    expect(createHash("sha256").update(after).digest("hex")).toBe(before);
    expect(existsSync(path.join(migrationsDir, source))).toBe(false);
    expect(validateMigrationDirectory(migrationsDir)).toEqual([...legacy, record.migration]);
  });
  it("rejects legacy and known base migrations without deleting the source", () => {
    const { migrationsDir } = fixture();
    expectCode(() => allocateMigration({ migrationsDir, pr: 1800, name: "history", adopt: legacy[0] }), "MERGED_MIGRATION_IMMUTABLE");
    const source = "0752_merged.sql"; writeFileSync(path.join(migrationsDir, source), "SELECT 42;\n");
    expectCode(() => allocateMigration({ migrationsDir, pr: 1800, name: "history", adopt: source, protectedFilenames: [source] }), "MERGED_MIGRATION_IMMUTABLE");
    expect(readFileSync(path.join(migrationsDir, source), "utf8")).toBe("SELECT 42;\n");
  });
  it("does not ignore a second unallocated migration while adopting one", () => {
    const { migrationsDir } = fixture();
    writeFileSync(path.join(migrationsDir, "0752_one.sql"), "SELECT 1;");
    writeFileSync(path.join(migrationsDir, "0753_two.sql"), "SELECT 2;");
    expectCode(() => allocateMigration({ migrationsDir, pr: 1800, name: "one", adopt: "0752_one.sql" }), "UNALLOCATED_MIGRATION");
    expect(existsSync(path.join(migrationsDir, "0752_one.sql"))).toBe(true);
  });
  it("cleans both sidecar and partial SQL file when an exclusive SQL write fails", () => {
    const { migrationsDir } = fixture();
    const source = "0752_pending.sql"; writeFileSync(path.join(migrationsDir, source), "SELECT 2;");
    failures.nextSqlWrite = true;
    expect(() => allocateMigration({ migrationsDir, pr: 1800, name: "pending", adopt: source })).toThrow("Injected SQL write failure");
    expect(readFileSync(path.join(migrationsDir, source), "utf8")).toBe("SELECT 2;");
    expect(readdirSync(path.join(migrationsDir, "metadata"))).toEqual([]);
    expect(readdirSync(migrationsDir).filter((file) => file.startsWith("9"))).toEqual([]);
    expect(existsSync(path.join(migrationsDir, ".allocation.lock"))).toBe(false);
  });
  it("restores the exact source after a failure occurring after source SQL removal", () => {
    const { migrationsDir } = fixture();
    const original = allocateMigration({ migrationsDir, pr: 1800, name: "original" });
    const sql = path.join(migrationsDir, original.migration);
    const bytes = Buffer.from("SELECT 'preserve exactly';\r\n"); writeFileSync(sql, bytes);
    const sidecar = path.join(migrationsDir, "metadata", `${original.migration}.json`);
    const originalSidecar = readFileSync(sidecar);
    failures.nextSidecarUnlink = true;
    expect(() => allocateMigration({ migrationsDir, pr: 1800, name: "renamed", adopt: original.migration })).toThrow("Injected old sidecar removal failure");
    expect(readFileSync(sql).equals(bytes)).toBe(true);
    expect(readFileSync(sidecar).equals(originalSidecar)).toBe(true);
    expect(validateMigrationDirectory(migrationsDir)).toEqual([...legacy, original.migration]);
    expect(readdirSync(path.join(migrationsDir, "metadata"))).toEqual([`${original.migration}.json`]);
  });
  it("refuses an existing allocator lock without removing another writer's evidence", () => {
    const { migrationsDir } = fixture(); const lock = path.join(migrationsDir, ".allocation.lock");
    writeFileSync(lock, "another writer");
    expectCode(() => allocateMigration({ migrationsDir, pr: 1800, name: "locked" }), "MIGRATION_ALLOCATION_BUSY");
    expect(readFileSync(lock, "utf8")).toBe("another writer");
  });
  it("rejects malformed JSON, unexpected sidecars, and symlinked metadata directories", () => {
    const { root, migrationsDir } = fixture(); const metadataDir = path.join(migrationsDir, "metadata");
    mkdirSync(metadataDir); writeFileSync(path.join(metadataDir, "bad.sql.json"), "{");
    expectCode(() => validateMigrationDirectory(migrationsDir), "MIGRATION_METADATA_READ_FAILED");
    rmSync(metadataDir, { recursive: true }); mkdirSync(metadataDir); writeFileSync(path.join(metadataDir, "unexpected.txt"), "no");
    expectCode(() => validateMigrationDirectory(migrationsDir), "INVALID_METADATA_FILENAME");
    rmSync(metadataDir, { recursive: true }); const elsewhere = path.join(root, "elsewhere"); mkdirSync(elsewhere);
    symlinkSync(elsewhere, metadataDir, process.platform === "win32" ? "junction" : "dir");
    expectCode(() => validateMigrationDirectory(migrationsDir), "UNSAFE_MIGRATION_FILE");
    expectCode(() => allocateMigration({ migrationsDir, pr: 1800, name: "unsafe" }), "UNSAFE_MIGRATION_FILE");
    expect(readdirSync(elsewhere)).toEqual([]);
  });
  it("allocates two same-PR commands concurrently without duplicate prefixes or overwrites", async () => {
    const { root, migrationsDir } = fixture();
    const run = (name: string) => new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(toolRoot, "create-migration.mjs"), "--pr", "1800", "--name", name], { cwd: root });
      let stderr = ""; child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); }); child.stdout.resume();
      child.on("error", reject); child.on("close", (status) => resolve({ status, stderr }));
    });
    const results = await Promise.all([run("first"), run("second")]);
    expect(results.some((result) => result.status === 0)).toBe(true);
    for (const [index, result] of results.entries()) {
      if (result.status !== 0) { expect(result.stderr).toContain("MIGRATION_ALLOCATION_BUSY"); expect((await run(index === 0 ? "first" : "second")).status).toBe(0); }
    }
    const files = validateMigrationDirectory(migrationsDir).filter((file) => file.startsWith("9"));
    expect(files).toHaveLength(2);
    expect(files.map((file) => parseAllocatedFilename(file)?.ordinal)).toEqual([1, 2]);
  });
});

describe("migration CI provenance and immutability", () => {
  it("allows only the exact base SQL inventory when bootstrapping legacy history", () => {
    const { root, migrationsDir } = fixture(false); const base = commitFixture(root); manifest(migrationsDir);
    expect(validateMigrationChanges(root, base, 1800).added).toEqual([]);
    const extra = "0752_new.sql"; writeFileSync(path.join(migrationsDir, extra), "SELECT 2;");
    writeFileSync(path.join(migrationsDir, "legacy-migrations.json"), JSON.stringify({ version: 1, filenames: [...legacy, extra].sort() }));
    expectCode(() => validateMigrationChanges(root, base, 1800), "LEGACY_BOOTSTRAP_MISMATCH");
  });
  it("rejects a bootstrap manifest that omits existing history", () => {
    const { root, migrationsDir } = fixture(false); const base = commitFixture(root);
    writeFileSync(path.join(migrationsDir, "legacy-migrations.json"), JSON.stringify({ version: 1, filenames: legacy.slice(1) }));
    expectCode(() => validateMigrationChanges(root, base, 1800), "UNALLOCATED_MIGRATION");
  });
  it("checks PR ownership and rejects SQL and frozen-manifest mutations relative to base", () => {
    const { root, migrationsDir } = fixture(); const base = commitFixture(root);
    const record = allocateMigration({ migrationsDir, pr: 1800, name: "own" });
    expect(validateMigrationChanges(root, base, 1800).added).toEqual([record.migration]);
    expectCode(() => validateMigrationChanges(root, base, 1801), "MIGRATION_PR_OWNERSHIP");
    writeFileSync(path.join(migrationsDir, legacy[0]), "SELECT 'changed';\n");
    expectCode(() => validateMigrationChanges(root, base, 1800), "MERGED_MIGRATION_IMMUTABLE");
    git(root, "checkout", "--", `migrations/${legacy[0]}`);
    writeFileSync(path.join(migrationsDir, "legacy-migrations.json"), JSON.stringify({ version: 1, filenames: legacy }, null, 4));
    expectCode(() => validateMigrationChanges(root, base, 1800), "MERGED_MIGRATION_IMMUTABLE");
  });
  it("rejects changes to already merged allocation sidecars", () => {
    const { root, migrationsDir } = fixture(); const record = allocateMigration({ migrationsDir, pr: 1800, name: "merged" });
    const base = commitFixture(root);
    writeFileSync(path.join(migrationsDir, "metadata", `${record.migration}.json`), JSON.stringify(record, null, 4));
    expectCode(() => validateMigrationChanges(root, base, 1801), "MERGED_MIGRATION_IMMUTABLE");
  });
  it.each(["delete", "rename"])("rejects %s of a merged migration even when the resulting catalog is internally valid", (operation) => {
    const { root, migrationsDir } = fixture(); const record = allocateMigration({ migrationsDir, pr: 1800, name: "merged" });
    const base = commitFixture(root);
    const sql = path.join(migrationsDir, record.migration);
    const sidecar = path.join(migrationsDir, "metadata", `${record.migration}.json`);
    if (operation === "delete") { rmSync(sql); rmSync(sidecar); }
    else {
      const migration = formatAllocatedFilename({ ...record, name: "renamed" });
      renameSync(sql, path.join(migrationsDir, migration)); rmSync(sidecar);
      writeFileSync(path.join(migrationsDir, "metadata", `${migration}.json`), JSON.stringify({ ...record, migration }));
    }
    expect(() => validateMigrationDirectory(migrationsDir)).not.toThrow();
    expectCode(() => validateMigrationChanges(root, base, 1801), "MERGED_MIGRATION_IMMUTABLE");
  });
  it("adoption CLI proves source absence from base and rejects path traversal", () => {
    const { root } = fixture(); const base = commitFixture(root);
    expectCode(() => runMigrationAllocation(["--pr", "1800", "--name", "history", "--adopt", `migrations/${legacy[0]}`, "--base", base], root), "MERGED_MIGRATION_IMMUTABLE");
    expectCode(() => runMigrationAllocation(["--pr", "1800", "--name", "unsafe", "--adopt", "../outside.sql", "--base", base], root), "INVALID_ADOPTION_SOURCE");
  });
  it("uses event-backed PR, push, and merge-group bases; manual dispatch only checks the catalog", () => {
    const sha = "a".repeat(40);
    const head = "b".repeat(40);
    expect(ciMigrationContext("pull_request", { number: 1800, pull_request: { base: { sha }, head: { sha: head } } })).toEqual({ base: sha, pr: 1800, head });
    expect(ciMigrationContext("pull_request", { number: 1800, pull_request: { base: { sha: "a".repeat(64) }, head: { sha: "b".repeat(64) } } }))
      .toEqual({ base: "a".repeat(64), pr: 1800, head: "b".repeat(64) });
    expect(ciMigrationContext("push", { before: sha })).toEqual({ base: sha, pr: undefined });
    expect(ciMigrationContext("merge_group", { merge_group: { base_sha: sha } })).toEqual({ base: sha, pr: undefined });
    expect(ciMigrationContext("workflow_dispatch", {})).toEqual({});
    expectCode(() => ciMigrationContext("push", { before: "0".repeat(40) }), "MISSING_MIGRATION_BASE");
    expectCode(() => ciMigrationContext("pull_request", { number: 1800 }), "MISSING_MIGRATION_BASE");
    expectCode(() => ciMigrationContext("pull_request_target", {}), "UNSUPPORTED_MIGRATION_CI_EVENT");
  });
  it.each([undefined, null, "", "not-a-sha", "0".repeat(40), "b".repeat(39)])("rejects missing or invalid PR head evidence: %s", (head) => {
    expectCode(() => ciMigrationContext("pull_request", { number: 1800, pull_request: {
      base: { sha: "a".repeat(40) }, head: { sha: head },
    } }), "MISSING_MIGRATION_HEAD");
  });
  it.each([undefined, 1800])("does not claim another PR's newly merged migration when the event base is stale (own migration: %s)", (migrationOwner) => {
    const context = prMergeFixture({ migrationOwner });
    expect(git(context.root, "rev-list", "--parents", "-n", "1", "HEAD").split(" "))
      .toEqual([context.merge, context.effectiveBase, context.head]);
    const before = git(context.root, "status", "--porcelain");
    expect(runMigrationCheck(["--ci"], context.root, context.environment)).toMatchObject({
      event: "migration_policy_validated", migrations: migrationOwner === undefined ? 4 : 5,
      base: context.effectiveBase, eventBase: context.eventBase, pr: 1800,
    });
    expect(git(context.root, "status", "--porcelain")).toBe(before);
  });
  it("still rejects a new PR migration allocated to somebody else after main advances", () => {
    const context = prMergeFixture({ migrationOwner: 1802 });
    expectCode(() => runMigrationCheck(["--ci"], context.root, context.environment), "MIGRATION_PR_OWNERSHIP");
  });
  it.each(["sql", "sidecar"] as const)("protects newly merged main %s from edits in the PR", (mutateMain) => {
    const context = prMergeFixture({ mutateMain });
    expect(() => validateMigrationDirectory(context.migrationsDir)).not.toThrow();
    expectCode(() => runMigrationCheck(["--ci"], context.root, context.environment), "MERGED_MIGRATION_IMMUTABLE");
  });
  it("rejects absent or mismatched CI checkout identity instead of guessing a base", () => {
    const context = prMergeFixture();
    for (const override of [
      { GITHUB_REF: undefined }, { GITHUB_REF: "refs/pull/1801/merge" }, { GITHUB_REF: "refs/heads/fixture-pr" },
      { GITHUB_SHA: undefined }, { GITHUB_SHA: "not-a-sha" }, { GITHUB_SHA: "0".repeat(40) }, { GITHUB_SHA: context.head },
    ]) {
      expectCode(() => runMigrationCheck(["--ci"], context.root, { ...context.environment, ...override }), "MIGRATION_PR_CHECKOUT_MISMATCH");
    }
    writeFileSync(context.eventFile, JSON.stringify({ ...context.event, pull_request: {
      ...context.event.pull_request, head: { sha: context.effectiveBase },
    } }));
    expectCode(() => runMigrationCheck(["--ci"], context.root, context.environment), "MIGRATION_PR_CHECKOUT_MISMATCH");
  });
  it("rejects head-only, reversed-parent, and extra-parent checkouts even when their catalog is valid", () => {
    const context = prMergeFixture();
    const tree = git(context.root, "rev-parse", "HEAD^{tree}");
    const reversed = git(context.root, "commit-tree", tree, "-p", context.head, "-p", context.effectiveBase, "-m", "Wrong parent order");
    const extraParent = git(context.root, "commit-tree", tree, "-p", context.effectiveBase, "-p", context.head, "-p", context.eventBase, "-m", "Not a PR merge");
    for (const sha of [context.head, reversed, extraParent]) {
      git(context.root, "checkout", "--detach", sha);
      expect(() => validateMigrationDirectory(context.migrationsDir)).not.toThrow();
      expectCode(() => runMigrationCheck(["--ci"], context.root, { ...context.environment, GITHUB_SHA: sha }), "MIGRATION_PR_CHECKOUT_MISMATCH");
    }
  });
  it("requires the event base to be an ancestor of the verified merge's first parent", () => {
    const context = prMergeFixture();
    const tree = git(context.root, "rev-parse", "HEAD^{tree}");
    const unrelated = git(context.root, "commit-tree", tree, "-m", "Unrelated root with an identical tree");
    const merge = git(context.root, "commit-tree", tree, "-p", unrelated, "-p", context.head, "-m", "Merge from unrelated base history");
    git(context.root, "checkout", "--detach", merge);
    expectCode(() => runMigrationCheck(["--ci"], context.root, { ...context.environment, GITHUB_SHA: merge }), "MIGRATION_PR_BASE_MISMATCH");
  });
  it("rejects a divergent recorded base even when it shares history with the merge's first parent", () => {
    const context = prMergeFixture();
    const tree = git(context.root, "rev-parse", "HEAD^{tree}");
    const divergent = git(context.root, "commit-tree", tree, "-p", context.eventBase, "-m", "Divergent base branch");
    writeFileSync(context.eventFile, JSON.stringify({ ...context.event, pull_request: {
      ...context.event.pull_request, base: { sha: divergent },
    } }));
    expectCode(() => runMigrationCheck(["--ci"], context.root, context.environment), "MIGRATION_PR_BASE_MISMATCH");
  });
  it("fails closed when the recorded event base is validly shaped but unavailable locally", () => {
    const context = prMergeFixture();
    writeFileSync(context.eventFile, JSON.stringify({ ...context.event, pull_request: {
      ...context.event.pull_request, base: { sha: "f".repeat(40) },
    } }));
    expectCode(() => runMigrationCheck(["--ci"], context.root, context.environment), "MIGRATION_GIT_EVIDENCE_UNAVAILABLE");
  });
  it("fails closed on missing event/base evidence and propagates CLI status without dependencies", () => {
    const { root } = fixture();
    expectCode(() => runMigrationCheck(["--ci"], root, {}), "MISSING_MIGRATION_CI_EVENT");
    const eventFile = path.join(root, "event.json"); writeFileSync(eventFile, "{}");
    const env = { ...process.env, GITHUB_EVENT_PATH: eventFile, GITHUB_EVENT_NAME: "workflow_dispatch" };
    expect(runMigrationCheck(["--ci"], root, env).migrations).toBe(3);
    const isolatedTools = path.join(root, "scripts", "migrations"); mkdirSync(isolatedTools, { recursive: true });
    for (const file of ["check-migrations.mjs", "migration-policy.mjs", "inherited-migration-provenance.mjs"]) writeFileSync(path.join(isolatedTools, file), readFileSync(path.join(toolRoot, file)));
    expect(existsSync(path.join(root, "node_modules"))).toBe(false);
    const result = spawnSync(process.execPath, [path.join(isolatedTools, "check-migrations.mjs"), "--ci"], { cwd: root, env: { ...env, NODE_PATH: undefined }, encoding: "utf8" });
    expect(result.status).toBe(0); expect(result.stdout).toContain("migration_policy_validated");
    const fail = spawnSync(process.execPath, [path.join(toolRoot, "check-migrations.mjs"), "--base", "missing"], { cwd: root, encoding: "utf8" });
    expect(fail.status).toBe(1); expect(fail.stderr).toContain("MIGRATION_GIT_EVIDENCE_UNAVAILABLE");
  });
  it("executes actual PR and push event files with ownership checks before any package installation", () => {
    const context = prMergeFixture({ migrationOwner: 1800 });
    const { root, eventFile } = context;
    const isolatedTools = path.join(root, "scripts", "migrations"); mkdirSync(isolatedTools, { recursive: true });
    for (const file of ["check-migrations.mjs", "migration-policy.mjs", "inherited-migration-provenance.mjs"]) writeFileSync(path.join(isolatedTools, file), readFileSync(path.join(toolRoot, file)));
    function check(eventName: string, event: unknown, pr = 1800) {
      writeFileSync(eventFile, JSON.stringify(event));
      return spawnSync(process.execPath, [path.join(isolatedTools, "check-migrations.mjs"), "--ci"], {
        cwd: root, env: { ...process.env, ...context.environment, NODE_PATH: undefined,
          GITHUB_EVENT_NAME: eventName, GITHUB_REF: `refs/pull/${pr}/merge` }, encoding: "utf8",
      });
    }
    expect(check("pull_request", context.event).status).toBe(0);
    const wrongOwner = check("pull_request", { ...context.event, number: 1802 }, 1802);
    expect(wrongOwner.status).toBe(1); expect(wrongOwner.stderr).toContain("MIGRATION_PROVENANCE_UNAVAILABLE");
    expect(check("push", { before: context.eventBase }).status).toBe(0);
  });
});
