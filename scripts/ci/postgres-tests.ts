import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { POSTGRES_SHARD_COUNT, POSTGRES_TEST_FILES } from "./postgres-test-manifest";

export interface PostgresShard {
  readonly index: number;
  readonly count: number;
}

export interface PostgresAdminConnection {
  connect(): Promise<void>;
  query(statement: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface PostgresRunnerDependencies {
  createAdminConnection(connectionString: string): PostgresAdminConnection;
  randomId(): string;
  runTest(args: readonly string[], env: NodeJS.ProcessEnv): SpawnSyncReturns<Buffer | null>;
  info(message: string): void;
  error(message: string): void;
}

export const POSTGRES_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ADMIN_CONNECTION_TIMEOUT_MS = 10_000;
const ADMIN_STATEMENT_TIMEOUT_MS = 60_000;
const ADMIN_QUERY_TIMEOUT_MS = ADMIN_STATEMENT_TIMEOUT_MS + 5_000;

export function parsePostgresShard(args: readonly string[]): PostgresShard {
  const match = args.length === 1 ? /^([1-9]\d*)\/([1-9]\d*)$/.exec(args[0]) : null;
  if (!match) throw new Error("Expected exactly one shard argument, for example 1/" + POSTGRES_SHARD_COUNT + ".");
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isSafeInteger(index) || count !== POSTGRES_SHARD_COUNT || index > count) {
    throw new Error("Shard index must be 1.." + POSTGRES_SHARD_COUNT + " and count must be " + POSTGRES_SHARD_COUNT + ".");
  }
  return { index, count };
}

export function validatePostgresTestEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.ECHELON_TEST_DATABASE_DISPOSABLE !== "true") {
    throw new Error("PostgreSQL CI tests require ECHELON_TEST_DATABASE_DISPOSABLE=true.");
  }
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(env.ECHELON_TEST_DATABASE_URL ?? "");
  } catch {
    throw new Error("PostgreSQL CI tests require an explicit local ECHELON_TEST_DATABASE_URL.");
  }
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)
    || !["localhost", "127.0.0.1"].includes(databaseUrl.hostname)
    || !/^\/[a-zA-Z0-9_]+$/.test(databaseUrl.pathname)
    || databaseUrl.search !== ""
    || databaseUrl.hash !== "") {
    // Never include the supplied connection string: it may contain credentials.
    // Reject query overrides too: node-postgres accepts ?host=other-server.
    throw new Error("PostgreSQL CI tests only accept a named disposable database on localhost or 127.0.0.1, without URL query options.");
  }
  for (const key of ["DATABASE_URL", "EXTERNAL_DATABASE_URL"] as const) {
    if (!env[key]) continue;
    let applicationUrl: URL;
    try { applicationUrl = new URL(env[key]); } catch { continue; }
    if (["localhost", "127.0.0.1"].includes(applicationUrl.hostname)
      && (applicationUrl.port || "5432") === (databaseUrl.port || "5432")
      && applicationUrl.pathname === databaseUrl.pathname) {
      throw new Error("PostgreSQL CI admin database must not be the configured application database.");
    }
  }
}

export function validatePostgresManifest(root: string, files: readonly string[]): void {
  if (files.length < POSTGRES_SHARD_COUNT || new Set(files).size !== files.length) {
    throw new Error("PostgreSQL test manifest must contain unique files and at least one file per shard.");
  }
  for (const file of files) {
    if (!/^server\/(?:[a-zA-Z0-9_-]+\/)*__tests__\/integration\/[a-zA-Z0-9_.-]+\.test\.ts$/.test(file)) {
      throw new Error("Invalid PostgreSQL test manifest path: " + file);
    }
    let isFile = false;
    try {
      isFile = statSync(resolve(root, file)).isFile();
    } catch {
      // A renamed/missing suite must fail CI rather than silently reducing coverage.
    }
    if (!isFile) throw new Error("PostgreSQL test manifest file does not exist: " + file);
  }
}

export function selectPostgresShardFiles(shard: PostgresShard): readonly string[] {
  const validated = parsePostgresShard([shard.index + "/" + shard.count]);
  // Stable, inspectable assignment; no timing cache or platform-dependent order.
  return POSTGRES_TEST_FILES.filter((_, index) => index % validated.count === validated.index - 1);
}

export function buildPostgresVitestArgs(shard: PostgresShard, file: string): string[] {
  const selected = selectPostgresShardFiles(shard);
  const selectedIndex = selected.indexOf(file);
  if (selectedIndex < 0) throw new Error("Test file is not assigned to this PostgreSQL shard.");
  return [
    resolve(POSTGRES_REPOSITORY_ROOT, "node_modules/vitest/vitest.mjs"),
    "run",
    file,
    "--no-file-parallelism",
    "--maxWorkers=1",
    "--isolate",
    "--allowOnly=false",
    "--passWithNoTests=false",
    "--reporter=default",
    "--reporter=junit",
    "--outputFile.junit=test-results/postgres-hardening-" + shard.index + "/" + (selectedIndex + 1) + ".xml",
  ];
}

export function createOwnedDatabaseName(shard: PostgresShard, randomId: string): string {
  parsePostgresShard([shard.index + "/" + shard.count]);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(randomId)) {
    throw new Error("PostgreSQL CI database identity must be a UUID.");
  }
  return "echelon_ci_s" + shard.index + "_" + randomId.replaceAll("-", "");
}

function ownedDatabaseIdentifier(databaseName: string): string {
  // SQL parameters cannot represent identifiers. This fixed prefix and exact
  // generated-name shape exclude quotes, paths and all pre-existing DB names.
  if (!/^echelon_ci_s[1-8]_[0-9a-f]{32}$/.test(databaseName)) {
    throw new Error("Invalid owned PostgreSQL CI database name.");
  }
  return '"' + databaseName + '"';
}

function createAdminConnection(connectionString: string): PostgresAdminConnection {
  const client = new pg.Client({
    connectionString,
    application_name: "echelon-ci-database-owner",
    connectionTimeoutMillis: ADMIN_CONNECTION_TIMEOUT_MS,
    statement_timeout: ADMIN_STATEMENT_TIMEOUT_MS,
    query_timeout: ADMIN_QUERY_TIMEOUT_MS,
  });
  let connectionError: Error | undefined;
  // A server disconnect while a child test is running must not become an
  // unhandled EventEmitter error. The next operation/close still fails visibly.
  client.on("error", (error: Error) => { connectionError = error; });
  return {
    connect: async () => { await client.connect(); },
    query: async (statement: string) => {
      if (connectionError) throw connectionError;
      return client.query(statement);
    },
    end: async () => {
      await client.end();
      if (connectionError) throw connectionError;
    },
  };
}

const defaultDependencies: PostgresRunnerDependencies = {
  createAdminConnection,
  randomId: randomUUID,
  runTest: (args, env) => spawnSync(process.execPath, [...args], {
    cwd: POSTGRES_REPOSITORY_ROOT,
    env,
    stdio: "inherit",
    shell: false,
  }),
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

function safeFailureCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  // SQLSTATE and OS error codes are useful; raw error messages may expose URLs.
  return typeof code === "string" && /^[A-Z0-9_]{2,20}$/.test(code) ? code : "UNCLASSIFIED";
}

async function runPostgresFile(
  shard: PostgresShard,
  file: string,
  env: NodeJS.ProcessEnv,
  dependencies: PostgresRunnerDependencies,
): Promise<boolean> {
  let connection: PostgresAdminConnection | undefined;
  let databaseCreated = false;
  let failed = false;
  let phase = "database identity";
  let databaseName: string | undefined;
  let databaseIdentifier = "";
  const reportFailure = (failedPhase: string, detail: string): void => {
    failed = true;
    dependencies.error(JSON.stringify({ event: "postgres_ci_failure", shard: shard.index, file, database: databaseName, phase: failedPhase, detail }));
  };
  try {
    databaseName = createOwnedDatabaseName(shard, dependencies.randomId());
    databaseIdentifier = ownedDatabaseIdentifier(databaseName);
    phase = "admin connection";
    connection = dependencies.createAdminConnection(env.ECHELON_TEST_DATABASE_URL!);
    await connection.connect();
    phase = "database create";
    // No IF NOT EXISTS: a collision is a failure, never authority to drop/reuse
    // somebody else's database. Ownership begins only after CREATE succeeds.
    await connection.query("CREATE DATABASE " + databaseIdentifier);
    databaseCreated = true;

    const databaseUrl = new URL(env.ECHELON_TEST_DATABASE_URL!);
    databaseUrl.pathname = "/" + databaseName;
    const childEnvironment: NodeJS.ProcessEnv = { ...env, ECHELON_TEST_DATABASE_URL: databaseUrl.toString() };
    // Test imports must never inherit unrelated application DB credentials.
    delete childEnvironment.DATABASE_URL;
    delete childEnvironment.EXTERNAL_DATABASE_URL;
    phase = "test execution";
    const child = dependencies.runTest(buildPostgresVitestArgs(shard, file), childEnvironment);
    if (child.error) reportFailure(phase, safeFailureCode(child.error));
    else if (child.signal) reportFailure(phase, "signal=" + child.signal);
    else if (child.status !== 0) reportFailure(phase, "exit=" + String(child.status));
  } catch (error) {
    reportFailure(phase, safeFailureCode(error));
  } finally {
    if (connection) {
      if (databaseCreated) {
        try {
          // Tests can leave pools connected. FORCE is restricted to the exact DB
          // successfully created above, never the admin URL or a discovered DB.
          await connection.query("DROP DATABASE " + databaseIdentifier + " WITH (FORCE)");
        } catch (error) {
          reportFailure("database cleanup", safeFailureCode(error));
        }
      }
      try {
        await connection.end();
      } catch (error) {
        reportFailure("admin connection close", safeFailureCode(error));
      }
    }
  }
  return !failed;
}

export async function runPostgresShard(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  dependencies: PostgresRunnerDependencies = defaultDependencies,
): Promise<number> {
  const shard = parsePostgresShard(args);
  validatePostgresTestEnvironment(env);
  validatePostgresManifest(POSTGRES_REPOSITORY_ROOT, POSTGRES_TEST_FILES);
  const files = selectPostgresShardFiles(shard);
  dependencies.info(JSON.stringify({ event: "postgres_ci_shard_start", shard: shard.index, count: shard.count, files }));
  let failedFiles = 0;
  for (const file of files) {
    if (!await runPostgresFile(shard, file, env, dependencies)) failedFiles += 1;
  }
  dependencies.info(JSON.stringify({ event: "postgres_ci_shard_complete", shard: shard.index, files: files.length, failedFiles }));
  return failedFiles === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPostgresShard(process.argv.slice(2), process.env).then(
    (exitCode) => { process.exitCode = exitCode; },
    (error) => {
      console.error(error instanceof Error ? error.message : "PostgreSQL test runner failed.");
      process.exitCode = 1;
    },
  );
}
