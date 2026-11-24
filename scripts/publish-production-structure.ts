/**
 * Publishes production's database structure for the schema drift check.
 *
 * Runs on Heroku (nightly, from Heroku Scheduler), where the database
 * credential already lives. It dumps the structure there and commits three
 * small files to the `production-structure` branch of this repository. The
 * drift check in GitHub reads them from that branch, so no database credential
 * ever leaves Heroku. See scripts/migrations/production-structure.mjs for the
 * file format and scripts/ci/check-schema-drift.ts for the check.
 *
 * It only reads the database: a structure dump (no rows) and the list of
 * applied migrations, both in sessions that refuse writes.
 *
 * It does not alert. If it fails or stops running, the published copy goes
 * stale and the drift check reports that the next time it runs.
 *
 *   npx tsx scripts/publish-production-structure.ts            publish
 *   npx tsx scripts/publish-production-structure.ts --dry-run <directory>
 *                                                              write the files locally instead
 *
 * Environment:
 *   DATABASE_URL                         the database to dump
 *   SCHEMA_STRUCTURE_GITHUB_TOKEN        token with contents write on the repository
 *   SCHEMA_STRUCTURE_GITHUB_REPOSITORY   "owner/name"
 *   PG_DUMP_PATH                         pg_dump executable (default: pg_dump)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { resolvePostgresPoolSslConfig } from "../server/database-pool-config";
import { PRODUCTION_STRUCTURE_BRANCH, buildPublication } from "./migrations/production-structure.mjs";
import { CheckError } from "./ci/disposable-database";
import { publishFilesToBranch } from "./ci/github-branch-publisher";
import { dumpStructure, libpqEnvironment } from "./ci/structure-dump";

const STATEMENT_TIMEOUT_MS = 60_000;

function log(level: "info" | "error", outcome: string, errorCode: string | null, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, action: "publish_production_structure", outcome, error_code: errorCode, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

function parseArguments(argv: readonly string[]): { dryRunDirectory: string | null } {
  if (argv.length === 0) return { dryRunDirectory: null };
  if (argv.length === 2 && argv[0] === "--dry-run" && argv[1] !== "") return { dryRunDirectory: argv[1] };
  throw new CheckError("PUBLISH_STRUCTURE_USAGE", "Usage: publish-production-structure.ts [--dry-run <directory>]");
}

function databaseUrlFromEnv(env: NodeJS.ProcessEnv): URL {
  try {
    return new URL(env.DATABASE_URL?.trim() ?? "");
  } catch {
    throw new CheckError("PUBLISH_STRUCTURE_DATABASE_URL_MISSING", "DATABASE_URL must hold the database to dump.");
  }
}

async function readAppliedMigrations(
  databaseUrl: URL,
  environment: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const client = new pg.Client({
    host: environment.PGHOST,
    port: Number(environment.PGPORT),
    user: environment.PGUSER,
    password: environment.PGPASSWORD,
    database: environment.PGDATABASE,
    ssl: resolvePostgresPoolSslConfig(databaseUrl.toString(), {
      ...env,
      NODE_ENV: env.NODE_ENV || "production",
    }),
    options: environment.PGOPTIONS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  try {
    await client.connect();
    return (await client.query<{ filename: string }>("SELECT filename FROM public._migrations")).rows.map((row) => row.filename);
  } catch (error) {
    throw new CheckError("PUBLISH_STRUCTURE_MIGRATIONS_UNREADABLE", "The applied-migrations list could not be read.", {
      errorName: error instanceof Error ? error.name : typeof error,
      sqlState: (error as { code?: unknown } | null)?.code ?? null,
    });
  } finally {
    await client.end().catch(() => undefined); // Closing a connection that never opened has nothing to report.
  }
}

async function main(): Promise<void> {
  const env = process.env;
  const { dryRunDirectory } = parseArguments(process.argv.slice(2));
  const token = env.SCHEMA_STRUCTURE_GITHUB_TOKEN?.trim() ?? "";
  const repository = env.SCHEMA_STRUCTURE_GITHUB_REPOSITORY?.trim() ?? "";
  if (dryRunDirectory === null && (token === "" || repository === "")) {
    throw new CheckError("PUBLISH_STRUCTURE_GITHUB_SETTINGS_MISSING", "SCHEMA_STRUCTURE_GITHUB_TOKEN and SCHEMA_STRUCTURE_GITHUB_REPOSITORY are required to publish.");
  }

  const databaseUrl = databaseUrlFromEnv(env);
  const environment = libpqEnvironment(databaseUrl, { production: true });
  // The clock is read once, here at the edge; everything below receives it.
  const capturedAt = new Date();
  const publication = buildPublication({
    rawDump: dumpStructure(environment, "PUBLISH_STRUCTURE_DUMP_FAILED", env),
    applied: await readAppliedMigrations(databaseUrl, environment, env),
    capturedAt,
  });
  const summary = { capturedAt: publication.heartbeat.capturedAt, structureSha256: publication.heartbeat.structureSha256 };

  if (dryRunDirectory !== null) {
    mkdirSync(dryRunDirectory, { recursive: true });
    for (const [name, text] of Object.entries(publication.files)) {
      writeFileSync(path.join(dryRunDirectory, name), text, "utf8");
    }
    log("info", "dry_run_written", null, summary);
    return;
  }

  const result = await publishFilesToBranch({
    fetchImpl: fetch,
    delay: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
    token,
    repository,
    branch: PRODUCTION_STRUCTURE_BRANCH,
    files: publication.files,
    message: `Production structure captured ${publication.heartbeat.capturedAt}`,
  });
  log("info", "published", null, { ...summary, commit: result.commitSha, branchExisted: result.branchExisted });
}

main().catch((error: unknown) => {
  const failure = error instanceof CheckError ? error : null;
  log("error", "failed", failure?.code ?? "PUBLISH_STRUCTURE_CRASHED", {
    // Only this script's own messages are logged in full; an unexpected error's text is not known to be free of connection details.
    message: failure?.message ?? `Unexpected ${error instanceof Error ? error.name : typeof error}.`,
    context: failure?.context ?? {},
  });
  process.exitCode = 1;
});
