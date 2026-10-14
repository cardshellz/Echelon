import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { baseMigrationFiles } from "./check-migrations.mjs";
import {
  MAX_GENERATION, MAX_ORDINAL, MAX_PR_NUMBER, boundedInteger, fail, formatAllocatedFilename,
  readMigrationInventory, reportMigrationError, validateLegacyManifest, validateMigrationDirectory, validateMigrationInventory,
} from "./migration-policy.mjs";

export function planMigration(inventory, { pr, name, after = [] }) {
  const files = validateMigrationInventory(inventory);
  boundedInteger(pr, MAX_PR_NUMBER, "pr");
  if (!Array.isArray(after) || after.some((file) => typeof file !== "string" || !files.includes(file))) {
    fail("MISSING_MIGRATION_DEPENDENCY", "Every --after dependency must name an existing, validated migration.");
  }
  const dependencies = [...new Set([...(files.length ? [files.at(-1)] : []), ...after])].sort();
  const generation = boundedInteger(1 + Math.max(0, ...dependencies.map((file) => inventory.metadata.get(file)?.generation ?? 0)), MAX_GENERATION, "generation");
  const ordinal = boundedInteger(1 + Math.max(0, ...[...inventory.metadata.values()].filter((record) => record.pr === pr).map((record) => record.ordinal)), MAX_ORDINAL, "ordinal");
  const migration = formatAllocatedFilename({ generation, pr, ordinal, name });
  return { version: 1, migration, generation, pr, ordinal, after: dependencies };
}

export function allocateMigration({ migrationsDir, pr, name, after = [], adopt, protectedFilenames = [] }) {
  const root = path.resolve(migrationsDir);
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("UNSAFE_MIGRATION_FILE", "Migrations directory must be a real directory.");
  const lock = path.join(root, ".allocation.lock");
  let lockFd;
  try { lockFd = openSync(lock, "wx"); }
  catch (error) {
    if (error?.code === "EEXIST") fail("MIGRATION_ALLOCATION_BUSY", "Another allocation owns migrations/.allocation.lock. Retry after it finishes; inspect a leftover lock before removing it.");
    throw error;
  }
  let source;
  let sourceBytes;
  let sourceSidecarBytes;
  let sourceRemoved = false;
  let sourceSidecarRemoved = false;
  const created = [];
  function writeExclusive(file, bytes) {
    const fd = openSync(file, "wx");
    // Track creation before writing: disk-full errors can leave a partial file.
    created.push(file);
    try { writeFileSync(fd, bytes); }
    finally { closeSync(fd); }
  }
  try {
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, operation: "allocate_migration" }));
    if (adopt !== undefined) {
      if (typeof adopt !== "string" || path.basename(adopt) !== adopt || !/^\d+_[^/\\]+\.sql$/.test(adopt)) {
        fail("INVALID_ADOPTION_SOURCE", "Adoption source must be a top-level migration filename.");
      }
      source = path.join(root, adopt);
      const info = lstatSync(source);
      if (!info.isFile() || info.isSymbolicLink()) fail("UNSAFE_MIGRATION_FILE", "Adoption source must be a regular SQL file.");
      sourceBytes = readFileSync(source);
    }
    const inventory = readMigrationInventory(root, adopt);
    if (adopt && (validateLegacyManifest(inventory.legacyManifest).includes(adopt) || protectedFilenames.includes(adopt))) {
      fail("MERGED_MIGRATION_IMMUTABLE", `Cannot adopt migration already on the base: ${adopt}.`);
    }
    const record = planMigration(inventory, { pr, name, after });
    const metadataDir = path.join(root, "metadata");
    if (existsSync(metadataDir) && (lstatSync(metadataDir).isSymbolicLink() || !lstatSync(metadataDir).isDirectory())) {
      fail("UNSAFE_MIGRATION_FILE", "Migration metadata directory must be a real directory.");
    }
    mkdirSync(metadataDir, { recursive: true });
    const target = path.join(root, record.migration);
    const sidecar = path.join(metadataDir, `${record.migration}.json`);
    const oldSidecar = adopt ? path.join(metadataDir, `${adopt}.json`) : undefined;
    if (oldSidecar && existsSync(oldSidecar)) {
      if (lstatSync(oldSidecar).isSymbolicLink() || !lstatSync(oldSidecar).isFile()) fail("UNSAFE_MIGRATION_FILE", "Adoption sidecar must be a regular file.");
      sourceSidecarBytes = readFileSync(oldSidecar);
    }
    // Exclusive writes plus a directory-wide lock prevent overlapping local allocations.
    // Separate worktrees using the same PR must still coordinate their ordinals.
    writeExclusive(sidecar, `${JSON.stringify(record, null, 2)}\n`);
    writeExclusive(target, sourceBytes ?? Buffer.from(`-- ${name}\n-- Write the forward-only migration SQL here before review.\n`));
    validateMigrationInventory(readMigrationInventory(root, adopt));
    if (source) { unlinkSync(source); sourceRemoved = true; }
    if (sourceSidecarBytes) { unlinkSync(oldSidecar); sourceSidecarRemoved = true; }
    validateMigrationDirectory(root);
    return record;
  } catch (error) {
    const cleanupFailures = [];
    function recover(action) { try { action(); } catch (failure) { cleanupFailures.push(failure instanceof Error ? failure.message : "Unknown cleanup failure"); } }
    if (sourceRemoved) recover(() => writeFileSync(source, sourceBytes, { flag: "wx" }));
    if (sourceSidecarRemoved) recover(() => writeFileSync(path.join(root, "metadata", `${adopt}.json`), sourceSidecarBytes, { flag: "wx" }));
    for (const file of [...created].reverse()) recover(() => unlinkSync(file));
    if (cleanupFailures.length) fail("MIGRATION_ALLOCATION_RECOVERY_FAILED", "Allocation failed and automatic restoration was incomplete. Inspect the listed paths before retrying.", { cause: error instanceof Error ? error.message : "Unknown failure", cleanupFailures });
    throw error;
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}

export function runMigrationAllocation(args, repositoryRoot = process.cwd()) {
  const options = { after: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const value = args[++i];
    if (!value || value.startsWith("--")) fail("INVALID_ALLOCATION_ARGUMENT", "Each allocation option needs a value.");
    if (key === "--after") options.after.push(value);
    else if (["--pr", "--name", "--adopt", "--base"].includes(key) && options[key.slice(2)] === undefined) options[key.slice(2)] = value;
    else fail("INVALID_ALLOCATION_ARGUMENT", "Usage: create-migration.mjs --pr <number> --name <name> [--after <filename>] [--adopt migrations/<filename>] [--base <ref>].");
  }
  if (!/^\d+$/.test(options.pr ?? "")) fail("INVALID_ALLOCATION_FIELD", "--pr must identify the existing draft pull request number.");
  const migrationsDir = path.join(repositoryRoot, "migrations");
  let adopt;
  let protectedFilenames = [];
  if (options.adopt !== undefined) {
    const source = path.resolve(repositoryRoot, options.adopt);
    if (path.dirname(source) !== path.resolve(migrationsDir)) fail("INVALID_ADOPTION_SOURCE", "--adopt must remain inside the top-level migrations directory.");
    adopt = path.basename(source);
    protectedFilenames = baseMigrationFiles(repositoryRoot, options.base ?? "origin/main").sql.map((file) => file.slice("migrations/".length));
  } else if (options.base !== undefined) {
    fail("INVALID_ALLOCATION_ARGUMENT", "--base is only used to prove an --adopt source is unmerged.");
  }
  return allocateMigration({ migrationsDir, pr: Number(options.pr), name: options.name, after: options.after, adopt, protectedFilenames });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify({ event: "migration_allocated", ...runMigrationAllocation(process.argv.slice(2)) })); }
  catch (error) { reportMigrationError(error); process.exitCode = 1; }
}
