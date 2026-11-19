import { createHash } from "node:crypto";
import { MigrationPolicyError } from "./migration-policy.mjs";

/**
 * Format of the published copy of production's database structure.
 *
 * The schema drift check runs in GitHub, and production's database is on
 * Heroku. So that no database credential ever leaves Heroku, a nightly Heroku
 * job (scripts/publish-production-structure.ts) dumps the structure there and
 * publishes three files to a branch of this repository; the drift check reads
 * them from that branch. The files hold structure only, never rows:
 *
 *   structure.sql            `pg_dump --schema-only --no-owner --no-privileges`
 *   applied-migrations.json  the filenames recorded in production's _migrations
 *   heartbeat.json           when it was captured, and a hash of each file
 *
 * The heartbeat is what lets the drift check tell "production matches" from
 * "nobody has looked lately": a copy older than the limit is refused.
 *
 * This module is dependency-free and does no I/O, so it is unit-tested directly.
 */
export const PRODUCTION_STRUCTURE_BRANCH = "production-structure";
export const STRUCTURE_FILENAME = "structure.sql";
export const APPLIED_MIGRATIONS_FILENAME = "applied-migrations.json";
export const HEARTBEAT_FILENAME = "heartbeat.json";
export const HEARTBEAT_VERSION = 1;
/**
 * The publisher runs nightly, shortly before the drift check. Twelve hours
 * means one missed night is reported at the very next check, while a manual
 * re-run later the same day still works.
 */
export const PRODUCTION_STRUCTURE_MAX_AGE_MS = 12 * 60 * 60 * 1_000;

const HEARTBEAT_KEYS = ["version", "capturedAt", "structureSha256", "appliedSha256"];
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const PSQL_RESTRICT = /^\\(?:un)?restrict(?: |$)/;

function fail(code, message, context = {}) {
  throw new MigrationPolicyError(code, message, context);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The dump as it is published. pg_dump writes a random token on its
 * `\restrict` lines, so they are removed: otherwise the file would change
 * every night and its history would say nothing about real changes. Line
 * endings become LF so the hash does not depend on where the dump was taken.
 */
export function stableStructureText(rawDump) {
  if (typeof rawDump !== "string" || rawDump.trim() === "") {
    fail("PRODUCTION_STRUCTURE_DUMP_EMPTY", "The production structure dump is empty.");
  }
  const lines = rawDump.replace(/\r+\n/g, "\n").split("\n").filter((line) => !PSQL_RESTRICT.test(line));
  if (lines.some((line) => /^COPY .* FROM stdin;$/.test(line))) {
    fail("PRODUCTION_STRUCTURE_DUMP_HAS_DATA", "The production dump contains rows; only structure may be published.");
  }
  if (!lines.some((line) => line.startsWith("CREATE "))) {
    fail("PRODUCTION_STRUCTURE_DUMP_HAS_NO_OBJECTS", "The production dump creates no objects.");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function appliedMigrationsText(applied) {
  if (!Array.isArray(applied) || applied.length === 0 || applied.some((name) => typeof name !== "string" || name === "")) {
    fail("PRODUCTION_STRUCTURE_APPLIED_LIST_INVALID", "The applied-migrations list must be a non-empty list of filenames.");
  }
  return `${JSON.stringify([...new Set(applied)].sort(), null, 2)}\n`;
}

export function validateHeartbeat(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== [...HEARTBEAT_KEYS].sort().join("\0")) {
    fail("PRODUCTION_STRUCTURE_HEARTBEAT_INVALID", `The heartbeat must contain exactly: ${HEARTBEAT_KEYS.join(", ")}.`);
  }
  const { version, capturedAt, structureSha256, appliedSha256 } = value;
  if (version !== HEARTBEAT_VERSION
      || typeof capturedAt !== "string" || !ISO_INSTANT.test(capturedAt) || Number.isNaN(Date.parse(capturedAt))
      || typeof structureSha256 !== "string" || !SHA256_HEX.test(structureSha256)
      || typeof appliedSha256 !== "string" || !SHA256_HEX.test(appliedSha256)) {
    fail("PRODUCTION_STRUCTURE_HEARTBEAT_INVALID", "The heartbeat fields are invalid.");
  }
  return { version, capturedAt, structureSha256, appliedSha256 };
}

/**
 * Builds the three files to publish. `capturedAt` is passed in (a Date) so the
 * caller owns the clock.
 */
export function buildPublication({ rawDump, applied, capturedAt }) {
  if (!(capturedAt instanceof Date) || Number.isNaN(capturedAt.getTime())) {
    fail("PRODUCTION_STRUCTURE_CAPTURE_TIME_INVALID", "capturedAt must be a valid date.");
  }
  const structure = stableStructureText(rawDump);
  const appliedText = appliedMigrationsText(applied);
  const heartbeat = validateHeartbeat({
    version: HEARTBEAT_VERSION,
    capturedAt: capturedAt.toISOString(),
    structureSha256: sha256(structure),
    appliedSha256: sha256(appliedText),
  });
  return {
    heartbeat,
    files: {
      [STRUCTURE_FILENAME]: structure,
      [APPLIED_MIGRATIONS_FILENAME]: appliedText,
      [HEARTBEAT_FILENAME]: `${JSON.stringify(heartbeat, null, 2)}\n`,
    },
  };
}

function parseJson(text, code, label) {
  try {
    return JSON.parse(text);
  } catch {
    return fail(code, `${label} is not valid JSON.`);
  }
}

/**
 * Checks a published copy before it is trusted: the heartbeat is well formed,
 * both files match the hashes it records, and it is recent enough.
 * Returns the structure dump and the applied-migrations list.
 */
export function verifyPublication({ structureText, appliedText, heartbeatText, now, maxAgeMs = PRODUCTION_STRUCTURE_MAX_AGE_MS }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    fail("PRODUCTION_STRUCTURE_CLOCK_INVALID", "now must be a valid date.");
  }
  const heartbeat = validateHeartbeat(parseJson(heartbeatText, "PRODUCTION_STRUCTURE_HEARTBEAT_INVALID", "The heartbeat"));
  // A checkout may have rewritten line endings; the hashes were taken over LF text.
  const structure = String(structureText).replace(/\r+\n/g, "\n");
  const applied = String(appliedText).replace(/\r+\n/g, "\n");
  if (sha256(structure) !== heartbeat.structureSha256 || sha256(applied) !== heartbeat.appliedSha256) {
    fail("PRODUCTION_STRUCTURE_HASH_MISMATCH", "The published structure does not match its heartbeat; the three files are not from one capture.");
  }
  const ageMs = now.getTime() - Date.parse(heartbeat.capturedAt);
  if (ageMs > maxAgeMs) {
    fail("PRODUCTION_STRUCTURE_STALE", `The published production structure was captured at ${heartbeat.capturedAt}, which is too old; the Heroku job that publishes it has not run.`, {
      capturedAt: heartbeat.capturedAt, ageHours: Math.floor(ageMs / 3_600_000),
    });
  }
  const names = parseJson(applied, "PRODUCTION_STRUCTURE_APPLIED_LIST_INVALID", "The applied-migrations list");
  if (!Array.isArray(names) || names.length === 0 || names.some((name) => typeof name !== "string" || name === "")) {
    fail("PRODUCTION_STRUCTURE_APPLIED_LIST_INVALID", "The applied-migrations list must be a non-empty list of filenames.");
  }
  return { structure, applied: names, capturedAt: heartbeat.capturedAt };
}
