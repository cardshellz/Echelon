import { createHash } from "node:crypto";
import { MigrationPolicyError } from "./migration-policy.mjs";

/**
 * Format of the schema baseline in migrations/baseline/.
 *
 * The baseline is a structure-only snapshot of the production database. An
 * empty database loads it and then runs only the migrations it does not cover
 * (see migrations/baseline-bootstrap.ts). It exists because the legacy
 * migration files cannot build a database from nothing: they were written
 * against a database that already existed, and they are frozen by the hashes
 * production recorded for them.
 *
 * This module is dependency-free so the generator, the release runner and CI
 * all read the same rules.
 */
export const BASELINE_VERSION = 1;
export const BASELINE_DIRECTORY = "baseline";
export const BASELINE_SCHEMA_FILENAME = "schema.sql";
export const BASELINE_MANIFEST_FILENAME = "manifest.json";
export const BASELINE_REFERENCE_DATA_FILENAME = "reference-data.sql";
export const BASELINE_REFERENCE_AUDIT_FILENAME = "reference-data-audit.json";

const MANIFEST_KEYS = ["version", "capturedAt", "serverVersion", "schemaSha256", "covers"];
const REFERENCE_AUDIT_KEYS = [
  "version",
  "reviewedAt",
  "baselineCapturedAt",
  "referenceDataSha256",
  "coveredInsertMigrations",
  "tables",
];
const REFERENCE_DISPOSITIONS = new Set([
  "baseline_reference_seed",
  "dependent_or_runtime_seeded",
  "historical_backfill_or_event",
]);
const SQL_FILENAME = /^\d+_[^/\\\r\n]+\.sql$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// pg_dump writes these as session-level settings. The baseline runs inside the
// runner's transaction on a connection that is reused afterwards, so each one
// becomes SET LOCAL and ends with that transaction.
const PREAMBLE_SETTING = /^SET ([a-z_]+) = (.+);$/;
const PREAMBLE_SEARCH_PATH = "SELECT pg_catalog.set_config('search_path', '', false);";
const LOCAL_SEARCH_PATH = "SELECT pg_catalog.set_config('search_path', '', true);";
const BODY_SETTINGS = new Map([
  ["SET default_tablespace = '';", "SET LOCAL default_tablespace = '';"],
  ["SET default_table_access_method = heap;", "SET LOCAL default_table_access_method = heap;"],
]);
// Heroku creates this empty schema itself on newer databases, so creating it
// must tolerate it already being there.
const HOST_SCHEMAS = new Map([
  ["CREATE SCHEMA heroku_ext;", "CREATE SCHEMA IF NOT EXISTS heroku_ext;"],
]);
const PSQL_RESTRICT = /^\\(?:un)?restrict(?: |$)/;

function fail(code, message, context = {}) {
  throw new MigrationPolicyError(code, message, context);
}

export function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n");
}

/** Hash of the LF-normalized text, so a CRLF checkout hashes the same as Linux. */
export function baselineSha256(text) {
  return createHash("sha256").update(normalizeLineEndings(text)).digest("hex");
}

const HEADER = [
  "-- Echelon schema baseline. GENERATED - do not edit by hand.",
  "--",
  "-- A structure-only snapshot of the production database, produced by",
  "-- scripts/migrations/generate-baseline.mjs from `pg_dump --schema-only",
  "-- --no-owner --no-privileges`. It holds no rows.",
  "--",
  "-- The release runner loads it only into a database that has no objects and",
  "-- no migration records, then runs the migrations manifest.json does not list.",
  "-- Production has migration records, so this file never runs there.",
  "--",
  "-- The production database is shared with shellz-club-app. This snapshot",
  "-- therefore includes the membership schema and some public tables that",
  "-- shellz-club owns, because foreign keys cross between the two applications",
  "-- in both directions. They are here so a test database can be built; Echelon",
  "-- is not their schema authority and must never run DDL against them.",
  "",
].join("\n");

/**
 * Turns raw `pg_dump --schema-only` output into the committed baseline text.
 * Fails closed on anything it does not recognise instead of passing it through.
 */
export function transformProductionDump(rawDump) {
  if (typeof rawDump !== "string" || rawDump.trim() === "") {
    fail("BASELINE_DUMP_EMPTY", "The production dump is empty.");
  }
  const lines = normalizeLineEndings(rawDump).split("\n");
  const firstCreate = lines.findIndex((line) => line.startsWith("CREATE "));
  if (firstCreate < 0) fail("BASELINE_DUMP_HAS_NO_OBJECTS", "The production dump creates no objects.");

  let searchPathLines = 0;
  const output = [];
  lines.forEach((line, index) => {
    if (PSQL_RESTRICT.test(line)) return; // psql-only guard lines; the runner does not use psql.
    if (line.startsWith("\\")) {
      fail("BASELINE_DUMP_PSQL_COMMAND", "The production dump contains a psql command the runner cannot execute.", { line: index + 1 });
    }
    if (/^COPY .* FROM stdin;$/.test(line)) {
      fail("BASELINE_DUMP_HAS_DATA", "The production dump contains rows; the baseline must be structure only.", { line: index + 1 });
    }
    if (index < firstCreate) {
      if (line === PREAMBLE_SEARCH_PATH) {
        searchPathLines += 1;
        output.push(LOCAL_SEARCH_PATH);
        return;
      }
      const setting = PREAMBLE_SETTING.exec(line);
      if (setting) {
        output.push(`SET LOCAL ${setting[1]} = ${setting[2]};`);
        return;
      }
      if (line.startsWith("SET ") || line.startsWith("SELECT ")) {
        fail("BASELINE_DUMP_UNKNOWN_PREAMBLE", "The production dump has a session statement the generator does not recognise.", { line: index + 1 });
      }
    }
    output.push(BODY_SETTINGS.get(line) ?? HOST_SCHEMAS.get(line) ?? line);
  });
  if (searchPathLines !== 1) {
    fail("BASELINE_DUMP_SEARCH_PATH", "Expected exactly one empty search_path statement in the dump preamble.", { found: searchPathLines });
  }
  return `${HEADER}\n${output.join("\n").replace(/\n+$/, "")}\n`;
}

export function validateBaselineManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== [...MANIFEST_KEYS].sort().join("\0")) {
    fail("INVALID_BASELINE_MANIFEST", `Baseline manifest must contain exactly: ${MANIFEST_KEYS.join(", ")}.`);
  }
  const { version, capturedAt, serverVersion, schemaSha256, covers } = value;
  if (version !== BASELINE_VERSION
      || typeof capturedAt !== "string" || !ISO_DATE.test(capturedAt)
      || typeof serverVersion !== "string" || serverVersion.trim() === ""
      || typeof schemaSha256 !== "string" || !SHA256_HEX.test(schemaSha256)
      || !Array.isArray(covers) || covers.length === 0
      || covers.some((name) => typeof name !== "string" || !SQL_FILENAME.test(name))
      || new Set(covers).size !== covers.length
      || covers.join("\0") !== [...covers].sort().join("\0")) {
    fail("INVALID_BASELINE_MANIFEST", "Baseline manifest fields are invalid; covers must be unique, sorted SQL filenames.");
  }
  return { version, capturedAt, serverVersion, schemaSha256, covers: [...covers] };
}

/**
 * Builds the manifest for a new baseline. Every migration file in the
 * repository must already be applied in production, otherwise the snapshot
 * would claim a migration whose effect it does not contain.
 */
export function buildBaselineManifest({ schemaText, repositoryMigrations, appliedInProduction, capturedAt, serverVersion }) {
  const applied = new Set(appliedInProduction);
  const missing = repositoryMigrations.filter((name) => !applied.has(name));
  if (missing.length > 0) {
    fail("BASELINE_MIGRATION_NOT_APPLIED", "Production has not applied every migration in the repository; take the baseline after the next release.", { missing });
  }
  return validateBaselineManifest({
    version: BASELINE_VERSION,
    capturedAt,
    serverVersion,
    schemaSha256: baselineSha256(schemaText),
    covers: [...repositoryMigrations].sort(),
  });
}

export function validateBaselineReferenceAudit(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...REFERENCE_AUDIT_KEYS].sort().join("\0")
  ) {
    fail(
      "INVALID_BASELINE_REFERENCE_AUDIT",
      `Baseline reference-data audit must contain exactly: ${REFERENCE_AUDIT_KEYS.join(", ")}.`,
    );
  }
  const {
    version,
    reviewedAt,
    baselineCapturedAt,
    referenceDataSha256,
    coveredInsertMigrations,
    tables,
  } = value;
  if (
    version !== BASELINE_VERSION ||
    typeof reviewedAt !== "string" ||
    !ISO_DATE.test(reviewedAt) ||
    typeof baselineCapturedAt !== "string" ||
    !ISO_DATE.test(baselineCapturedAt) ||
    typeof referenceDataSha256 !== "string" ||
    !SHA256_HEX.test(referenceDataSha256) ||
    !Array.isArray(coveredInsertMigrations) ||
    coveredInsertMigrations.some((name) => typeof name !== "string" || !SQL_FILENAME.test(name)) ||
    new Set(coveredInsertMigrations).size !== coveredInsertMigrations.length ||
    coveredInsertMigrations.join("\0") !== [...coveredInsertMigrations].sort().join("\0") ||
    !Array.isArray(tables)
  ) {
    fail(
      "INVALID_BASELINE_REFERENCE_AUDIT",
      "Baseline reference-data audit fields are invalid.",
    );
  }
  for (const entry of tables) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.table !== "string" ||
      !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entry.table) ||
      !REFERENCE_DISPOSITIONS.has(entry.disposition) ||
      typeof entry.rationale !== "string" ||
      entry.rationale.trim() === "" ||
      !Array.isArray(entry.sourceMigrations) ||
      entry.sourceMigrations.length === 0 ||
      entry.sourceMigrations.some((name) => typeof name !== "string" || !SQL_FILENAME.test(name))
    ) {
      fail(
        "INVALID_BASELINE_REFERENCE_AUDIT",
        "Baseline reference-data audit contains an invalid table classification entry.",
      );
    }
  }
  return {
    version,
    reviewedAt,
    baselineCapturedAt,
    referenceDataSha256,
    coveredInsertMigrations: [...coveredInsertMigrations],
    tables: tables.map((entry) => ({
      table: entry.table,
      disposition: entry.disposition,
      rationale: entry.rationale,
      sourceMigrations: [...entry.sourceMigrations],
    })),
  };
}
