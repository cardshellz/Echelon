import { MigrationPolicyError } from "./migration-policy.mjs";

/**
 * Comparison of two `pg_dump --schema-only` outputs, object by object.
 *
 * Used by the schema drift check (scripts/ci/check-schema-drift.ts) to answer
 * one question: does a database built from this repository have the same
 * structure as production?
 *
 * Both dumps must come from databases that were loaded the same way. PostgreSQL
 * rewords stored expressions when a dump is reloaded (for example the list of
 * values in a CHECK constraint), so a first-generation production dump never
 * matches a rebuilt database line for line. The drift check therefore reloads
 * production's dump into a scratch database and dumps that again before calling
 * this module.
 *
 * Objects are matched by type, schema and name, not by position, so the order
 * pg_dump happens to write them in does not matter.
 *
 * Line endings are not compared. Production holds at least one function whose
 * body was saved with CRLF line endings, the baseline stores LF, and pg_dump on
 * Windows adds a carriage return of its own. None of that changes what a
 * function does, so every run of carriage returns before a newline is dropped.
 *
 * This module is dependency-free and does no I/O, so it is unit-tested directly.
 */

/**
 * Schemas in the shared production database that another application owns.
 * A difference here is usually that application shipping its own change; the
 * fix is to regenerate the baseline, never to run DDL from Echelon.
 */
export const SCHEMAS_OWNED_BY_OTHER_APPLICATIONS = Object.freeze(["membership"]);

/** Discord rejects messages longer than 2000 characters; leave headroom. */
export const DRIFT_ALERT_MAX_CHARACTERS = 1_800;
/** Objects named individually in an alert before the rest are only counted. */
export const DRIFT_ALERT_MAX_LISTED_OBJECTS = 15;
/** Label for objects pg_dump files under no schema (extensions, schemas themselves). */
export const DATABASE_LEVEL_GROUP = "(database level)";

const OBJECT_HEADER = /^-- Name: (.+); Type: ([A-Z][A-Z ]*); Schema: ([^;]+); Owner: .*$/;
const PSQL_RESTRICT = /^\\(?:un)?restrict(?: |$)/;
const DUMP_FOOTER = "-- PostgreSQL database dump complete";
const KEY_SEPARATOR = "\u0000";

export const DRIFT_KINDS = Object.freeze({
  onlyInRepository: "only_in_repository",
  onlyInProduction: "only_in_production",
  different: "different",
});

function fail(code, message, context = {}) {
  throw new MigrationPolicyError(code, message, context);
}

function withoutCarriageReturns(text) {
  return text.replace(/\r+\n/g, "\n");
}

/** Drops the blank and bare `--` separator lines pg_dump puts around each object. */
function trimSeparators(lines) {
  const isSeparator = (line) => line === "" || line === "--";
  let start = 0;
  let end = lines.length;
  while (start < end && isSeparator(lines[start])) start += 1;
  while (end > start && isSeparator(lines[end - 1])) end -= 1;
  return lines.slice(start, end).join("\n");
}

/**
 * Splits a structure dump into its objects.
 * Returns a Map from an opaque key to { type, schema, name, definition }.
 */
export function parseStructureDump(dumpText) {
  if (typeof dumpText !== "string" || dumpText.trim() === "") {
    fail("SCHEMA_DRIFT_DUMP_EMPTY", "A structure dump is empty.");
  }
  const lines = withoutCarriageReturns(dumpText).split("\n")
    .filter((line) => !PSQL_RESTRICT.test(line) && line !== DUMP_FOOTER);

  const objects = new Map();
  let current = null;
  const close = () => {
    if (!current) return;
    const key = [current.type, current.schema, current.name].join(KEY_SEPARATOR);
    const definition = trimSeparators(current.lines);
    const existing = objects.get(key);
    if (existing) {
      // pg_dump can write several entries under one name (for example two
      // comments). Keep them all, in a stable order, so they compare as a set.
      existing.definitions.push(definition);
    } else {
      objects.set(key, { type: current.type, schema: current.schema, name: current.name, definitions: [definition] });
    }
  };
  for (const line of lines) {
    const header = OBJECT_HEADER.exec(line);
    if (header) {
      close();
      current = { name: header[1], type: header[2], schema: header[3], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  close();
  if (objects.size === 0) fail("SCHEMA_DRIFT_DUMP_HAS_NO_OBJECTS", "A structure dump contains no objects.");

  const result = new Map();
  for (const [key, object] of objects) {
    result.set(key, {
      type: object.type,
      schema: object.schema,
      name: object.name,
      definition: [...object.definitions].sort().join("\n\n"),
    });
  }
  return result;
}

/** The schema an object is reported under. */
function groupOf(object) {
  if (object.schema !== "-") return object.schema;
  return object.type === "SCHEMA" ? object.name : DATABASE_LEVEL_GROUP;
}

function compareText(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * Compares a dump of a database built from the repository with a dump of
 * production's structure (reloaded once, see the module comment).
 */
export function compareStructureDumps({ repositoryDump, productionDump }) {
  const repository = parseStructureDump(repositoryDump);
  const production = parseStructureDump(productionDump);
  const differences = [];
  const describe = (object, kind, definitions) => ({
    schema: groupOf(object), type: object.type, name: object.name, kind, ...definitions,
  });

  for (const [key, object] of repository) {
    const other = production.get(key);
    if (!other) {
      differences.push(describe(object, DRIFT_KINDS.onlyInRepository, { repository: object.definition, production: null }));
    } else if (other.definition !== object.definition) {
      differences.push(describe(object, DRIFT_KINDS.different, { repository: object.definition, production: other.definition }));
    }
  }
  for (const [key, object] of production) {
    if (!repository.has(key)) {
      differences.push(describe(object, DRIFT_KINDS.onlyInProduction, { repository: null, production: object.definition }));
    }
  }
  differences.sort((a, b) => compareText(a.schema, b.schema) || compareText(a.type, b.type) || compareText(a.name, b.name));

  return {
    identical: differences.length === 0,
    objects: { repository: repository.size, production: production.size },
    differences,
  };
}

/** Number of differences per schema, sorted by schema name. */
export function countDifferencesBySchema(differences) {
  const counts = new Map();
  for (const difference of differences) {
    counts.set(difference.schema, (counts.get(difference.schema) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => compareText(a, b)).map(([schema, count]) => ({
    schema,
    count,
    ownedByAnotherApplication: SCHEMAS_OWNED_BY_OTHER_APPLICATIONS.includes(schema),
  }));
}

const KIND_LABELS = {
  [DRIFT_KINDS.onlyInRepository]: "missing in production",
  [DRIFT_KINDS.onlyInProduction]: "only in production",
  [DRIFT_KINDS.different]: "differs",
};

function withinLimit(text) {
  if (text.length <= DRIFT_ALERT_MAX_CHARACTERS) return text;
  const marker = "\n(message shortened)";
  return text.slice(0, DRIFT_ALERT_MAX_CHARACTERS - marker.length) + marker;
}

/** Alert text for differences between the repository and production. */
export function formatDriftAlert({ differences, runUrl = null }) {
  if (!Array.isArray(differences) || differences.length === 0) {
    fail("SCHEMA_DRIFT_ALERT_WITHOUT_DIFFERENCES", "A drift alert needs at least one difference.");
  }
  const bySchema = countDifferencesBySchema(differences);
  const listed = differences.slice(0, DRIFT_ALERT_MAX_LISTED_OBJECTS);
  const unlisted = differences.length - listed.length;
  const onlyOtherApplications = bySchema.every((entry) => entry.ownedByAnotherApplication);
  return withinLimit([
    `WARNING: production's database structure differs from the Echelon repository (${differences.length} object(s)).`,
    ...bySchema.map((entry) => `- ${entry.schema}: ${entry.count}${entry.ownedByAnotherApplication ? " (owned by another application)" : ""}`),
    "Objects:",
    ...listed.map((difference) => `- ${difference.schema} ${difference.type} ${difference.name}: ${KIND_LABELS[difference.kind]}`),
    unlisted > 0 ? `...and ${unlisted} more.` : "",
    onlyOtherApplications
      ? "Every difference is in a schema another application owns. Regenerate the baseline (scripts/migrations/generate-baseline.mjs)."
      : "A difference in an Echelon schema means production was changed outside a migration, or a migration did not do what the baseline expects. Investigate before regenerating the baseline.",
    runUrl ? `Full comparison: ${runUrl}` : "",
  ].filter(Boolean).join("\n"));
}

/** Alert text for a run that could not produce a comparison. */
export function formatCheckFailureAlert({ code, message, runUrl = null }) {
  return withinLimit([
    "WARNING: the Echelon schema drift check could not run, so drift is NOT being checked.",
    `${code}: ${message}`,
    runUrl ? `Run: ${runUrl}` : "",
  ].filter(Boolean).join("\n"));
}
