#!/usr/bin/env node
/**
 * Regenerates migrations/baseline/ from a production structure dump.
 *
 * This script never connects to a database. The operator takes the two inputs
 * read-only and passes them in as files:
 *
 *   1. --dump <file>     output of
 *        pg_dump --schema-only --no-owner --no-privileges <production>
 *   2. --applied <file>  JSON array of the filenames recorded in production's
 *        _migrations table (SELECT filename FROM _migrations)
 *
 *   node scripts/migrations/generate-baseline.mjs \
 *     --dump prod.sql --applied applied.json \
 *     --server-version 17.10 --captured-at 2026-11-17
 *
 * It refuses to write a baseline unless production has applied every migration
 * file in the repository, so the snapshot and the list it covers always agree.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_DIRECTORY, BASELINE_MANIFEST_FILENAME, BASELINE_SCHEMA_FILENAME,
  buildBaselineManifest, transformProductionDump,
} from "./baseline-format.mjs";
import { fail, reportMigrationError, validateMigrationDirectory } from "./migration-policy.mjs";

const OPTIONS = ["--dump", "--applied", "--server-version", "--captured-at"];

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!OPTIONS.includes(name) || value === undefined || values.has(name)) {
      fail("BASELINE_USAGE", `Usage: generate-baseline.mjs ${OPTIONS.map((option) => `${option} <value>`).join(" ")}`);
    }
    values.set(name, value);
  }
  for (const option of OPTIONS) {
    if (!values.has(option)) fail("BASELINE_USAGE", `Missing ${option}.`);
  }
  return values;
}

function readAppliedFilenames(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const names = Array.isArray(parsed)
    ? parsed.map((entry) => (typeof entry === "string" ? entry : entry?.filename))
    : null;
  if (!names || names.length === 0 || names.some((name) => typeof name !== "string")) {
    fail("BASELINE_APPLIED_LIST_INVALID", "--applied must be a JSON array of filenames, or of rows with a filename field.");
  }
  return names;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
  const schemaText = transformProductionDump(readFileSync(options.get("--dump"), "utf8"));
  const manifest = buildBaselineManifest({
    schemaText,
    repositoryMigrations: validateMigrationDirectory(migrationsDir),
    appliedInProduction: readAppliedFilenames(options.get("--applied")),
    capturedAt: options.get("--captured-at"),
    serverVersion: options.get("--server-version"),
  });
  const baselineDir = path.join(migrationsDir, BASELINE_DIRECTORY);
  mkdirSync(baselineDir, { recursive: true });
  writeFileSync(path.join(baselineDir, BASELINE_SCHEMA_FILENAME), schemaText, "utf8");
  writeFileSync(path.join(baselineDir, BASELINE_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    event: "baseline_generated",
    covers: manifest.covers.length,
    schemaSha256: manifest.schemaSha256,
    schemaBytes: Buffer.byteLength(schemaText, "utf8"),
  }));
}

try {
  main();
} catch (error) {
  reportMigrationError(error);
  process.exit(1);
}
