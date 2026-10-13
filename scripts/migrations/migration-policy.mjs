import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const NAMESPACE_VERSION = 1;
export const MAX_GENERATION = 99_999_999;
export const MAX_PR_NUMBER = 99_999_999;
export const MAX_ORDINAL = 9_999;
const allocatedName = /^9(\d{8})(\d{8})(\d{4})_([a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)\.sql$/;
const sqlName = /^\d+_[^/\\\r\n]+\.sql$/;

export class MigrationPolicyError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "MigrationPolicyError";
    this.code = code;
    this.context = context;
  }
}

export function fail(code, message, context = {}) {
  throw new MigrationPolicyError(code, message, context);
}

function objectWithKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail("INVALID_METADATA", `${label} must contain exactly: ${keys.join(", ")}.`);
  }
}

export function boundedInteger(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("INVALID_ALLOCATION_FIELD", `${label} must be an integer between 1 and ${maximum}.`, { field: label });
  }
  return value;
}

export function parseAllocatedFilename(filename) {
  if (typeof filename !== "string") return null;
  const match = allocatedName.exec(filename);
  if (!match) return null;
  return {
    generation: boundedInteger(Number(match[1]), MAX_GENERATION, "generation"),
    pr: boundedInteger(Number(match[2]), MAX_PR_NUMBER, "pr"),
    ordinal: boundedInteger(Number(match[3]), MAX_ORDINAL, "ordinal"),
    name: match[4],
  };
}

export function formatAllocatedFilename({ generation, pr, ordinal, name }) {
  boundedInteger(generation, MAX_GENERATION, "generation");
  boundedInteger(pr, MAX_PR_NUMBER, "pr");
  boundedInteger(ordinal, MAX_ORDINAL, "ordinal");
  if (typeof name !== "string" || !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(name)) {
    fail("INVALID_MIGRATION_NAME", "Migration name must be lowercase words separated by underscores or hyphens.");
  }
  // The complete prefix exceeds JavaScript's exact integer range. Never coerce it to Number.
  return `9${String(generation).padStart(8, "0")}${String(pr).padStart(8, "0")}${String(ordinal).padStart(4, "0")}_${name}.sql`;
}

export function validateLegacyManifest(value) {
  objectWithKeys(value, ["version", "filenames"], "Legacy migration manifest");
  if (value.version !== NAMESPACE_VERSION || !Array.isArray(value.filenames)
      || value.filenames.some((name) => typeof name !== "string" || !sqlName.test(name) || name >= "9")
      || new Set(value.filenames).size !== value.filenames.length
      || value.filenames.join("\0") !== [...value.filenames].sort().join("\0")) {
    fail("INVALID_LEGACY_MANIFEST", "Legacy filenames must be unique, sorted, and precede the new 9 namespace.");
  }
  return [...value.filenames];
}

function validatePrefixes(sorted) {
  // Keep historical duplicate semantics: numeric strings, not parsed integers.
  const prefixes = new Map();
  for (const filename of sorted) {
    const prefix = /^(\d+)_/.exec(filename)?.[1];
    if (prefix && prefixes.has(prefix)) {
      fail("DUPLICATE_MIGRATION_PREFIX", `Migration prefix collision: ${prefixes.get(prefix)} and ${filename}.`, { prefix });
    }
    if (prefix) prefixes.set(prefix, filename);
  }
}

export function validateMigrationInventory({ filenames, legacyManifest, metadata }) {
  const sorted = [...filenames].sort();
  validatePrefixes(sorted);
  const legacy = new Set(validateLegacyManifest(legacyManifest));
  const all = new Set(sorted);
  const allocations = new Map();
  const identities = new Set();
  for (const filename of legacy) {
    if (!all.has(filename)) fail("MISSING_LEGACY_MIGRATION", `Frozen legacy migration is missing: ${filename}.`, { filename });
  }
  for (const filename of sorted) {
    if (legacy.has(filename)) {
      if (metadata.has(filename)) fail("LEGACY_METADATA_FORBIDDEN", `Legacy migration cannot acquire allocation metadata: ${filename}.`);
      continue;
    }
    const allocation = parseAllocatedFilename(filename);
    if (!allocation) {
      fail("UNALLOCATED_MIGRATION", `Migration ${filename} is not frozen legacy history. Allocate it with migration:create and its draft PR number.`, { filename });
    }
    const record = metadata.get(filename);
    if (record === undefined) fail("MISSING_MIGRATION_METADATA", `Missing sidecar for ${filename}.`, { filename });
    objectWithKeys(record, ["version", "migration", "generation", "pr", "ordinal", "after"], filename);
    if (record.version !== NAMESPACE_VERSION || record.migration !== filename
        || record.generation !== allocation.generation || record.pr !== allocation.pr || record.ordinal !== allocation.ordinal
        || !Array.isArray(record.after) || record.after.some((name) => typeof name !== "string" || !sqlName.test(name))
        || new Set(record.after).size !== record.after.length
        || record.after.join("\0") !== [...record.after].sort().join("\0")) {
      fail("INVALID_METADATA", `Invalid allocation metadata for ${filename}.`, { filename });
    }
    const identity = `${allocation.pr}:${allocation.ordinal}`;
    if (identities.has(identity)) fail("DUPLICATE_PR_ORDINAL", `PR ${allocation.pr} reuses migration ordinal ${allocation.ordinal}.`);
    identities.add(identity);
    allocations.set(filename, record);
  }
  for (const filename of metadata.keys()) {
    if (!all.has(filename)) fail("ORPHAN_MIGRATION_METADATA", `Sidecar has no SQL migration: ${filename}.`, { filename });
  }
  for (const [filename, record] of allocations) {
    for (const dependency of record.after) {
      if (!all.has(dependency)) fail("MISSING_MIGRATION_DEPENDENCY", `${filename} depends on missing migration ${dependency}.`, { filename, dependency });
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(filename) {
    if (visiting.has(filename)) fail("MIGRATION_DEPENDENCY_CYCLE", `Migration dependency cycle includes ${filename}.`, { filename });
    if (visited.has(filename)) return;
    visiting.add(filename);
    for (const dependency of allocations.get(filename)?.after ?? []) visit(dependency);
    visiting.delete(filename);
    visited.add(filename);
  }
  for (const filename of allocations.keys()) visit(filename);
  for (const [filename, record] of allocations) {
    for (const dependency of record.after) {
      if (dependency >= filename) fail("MIGRATION_DEPENDENCY_ORDER", `${filename} would run before its dependency ${dependency}.`, { filename, dependency });
    }
    const expectedGeneration = 1 + Math.max(0, ...record.after.map((name) => allocations.get(name)?.generation ?? 0));
    if (record.generation !== expectedGeneration) {
      fail("MIGRATION_GENERATION_MISMATCH", `${filename} must have dependency generation ${expectedGeneration}.`, { filename, expectedGeneration });
    }
  }
  return sorted;
}

function readJson(file) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) fail("UNSAFE_MIGRATION_FILE", `Expected a regular file: ${file}.`);
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof MigrationPolicyError) throw error;
    fail("MIGRATION_METADATA_READ_FAILED", `Cannot read JSON metadata ${file}: ${error instanceof Error ? error.message : "unknown error"}.`);
  }
}

/** Only the allocator may exclude its explicitly named adoption source. */
export function readMigrationInventory(migrationsDir, excludedFilename) {
  const directoryInfo = lstatSync(migrationsDir);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) fail("UNSAFE_MIGRATION_FILE", "Migrations directory must be a real directory.");
  const filenames = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql") && name !== excludedFilename).sort();
  validatePrefixes(filenames);
  for (const filename of filenames) {
    const info = lstatSync(path.join(migrationsDir, filename));
    if (!info.isFile() || info.isSymbolicLink()) fail("UNSAFE_MIGRATION_FILE", `Expected regular SQL file: ${filename}.`);
  }
  const legacyManifest = readJson(path.join(migrationsDir, "legacy-migrations.json"));
  const metadata = new Map();
  const metadataDir = path.join(migrationsDir, "metadata");
  let sidecars;
  try {
    const info = lstatSync(metadataDir);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("UNSAFE_MIGRATION_FILE", "Migration metadata directory must be a real directory.");
    sidecars = readdirSync(metadataDir);
  }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    sidecars = [];
  }
  for (const sidecar of sidecars) {
    if (!sidecar.endsWith(".sql.json")) fail("INVALID_METADATA_FILENAME", `Unexpected migration sidecar: ${sidecar}.`);
    const filename = sidecar.slice(0, -5);
    if (filename !== excludedFilename) metadata.set(filename, readJson(path.join(metadataDir, sidecar)));
  }
  return { filenames, legacyManifest, metadata };
}

export function validateMigrationDirectory(migrationsDir) {
  return validateMigrationInventory(readMigrationInventory(migrationsDir));
}

export function reportMigrationError(error) {
  const failure = error instanceof MigrationPolicyError ? error : new MigrationPolicyError(
    "MIGRATION_CHECK_FAILED", error instanceof Error ? error.message : "Unknown migration check failure.",
  );
  console.error(JSON.stringify({ event: "migration_policy_rejected", code: failure.code, message: failure.message, context: failure.context }));
}
