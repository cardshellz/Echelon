const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 15_000;
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const MAX_CONFIGURED_ATTEMPTS = 10;
const MAX_CONFIGURED_DELAY_MS = 120_000;

export const MIGRATION_ADVISORY_LOCK_NAME = "echelon:release:migrations:v1";

const RETRYABLE_SQLSTATES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available, including lock_timeout
]);

export interface MigrationQueryClient {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

export interface MigrationRetryOptions {
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  lockTimeoutMs: number;
}

export interface MigrationRetryNotice {
  file: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  sqlState: string;
  message: string;
}

interface ExecuteMigrationInput {
  client: MigrationQueryClient;
  file: string;
  sql: string;
  contentHash: string;
  options: MigrationRetryOptions;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (notice: MigrationRetryNotice) => void;
}

export function migrationRetryOptionsFromEnv(
  env: NodeJS.ProcessEnv,
): MigrationRetryOptions {
  const options = {
    maxAttempts: parseBoundedInteger(
      env.MIGRATION_MAX_ATTEMPTS,
      "MIGRATION_MAX_ATTEMPTS",
      DEFAULT_MAX_ATTEMPTS,
      1,
      MAX_CONFIGURED_ATTEMPTS,
    ),
    retryBaseDelayMs: parseBoundedInteger(
      env.MIGRATION_RETRY_BASE_DELAY_MS,
      "MIGRATION_RETRY_BASE_DELAY_MS",
      DEFAULT_RETRY_BASE_DELAY_MS,
      0,
      MAX_CONFIGURED_DELAY_MS,
    ),
    retryMaxDelayMs: parseBoundedInteger(
      env.MIGRATION_RETRY_MAX_DELAY_MS,
      "MIGRATION_RETRY_MAX_DELAY_MS",
      DEFAULT_RETRY_MAX_DELAY_MS,
      0,
      MAX_CONFIGURED_DELAY_MS,
    ),
    lockTimeoutMs: parseBoundedInteger(
      env.MIGRATION_LOCK_TIMEOUT_MS,
      "MIGRATION_LOCK_TIMEOUT_MS",
      DEFAULT_LOCK_TIMEOUT_MS,
      1,
      MAX_CONFIGURED_DELAY_MS,
    ),
  };
  validateRetryOptions(options);
  return options;
}

export async function acquireMigrationAdvisoryLock(
  client: MigrationQueryClient,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_lock(hashtext($1))",
    [MIGRATION_ADVISORY_LOCK_NAME],
  );
}

export async function releaseMigrationAdvisoryLock(
  client: MigrationQueryClient,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_unlock(hashtext($1))",
    [MIGRATION_ADVISORY_LOCK_NAME],
  );
}

export async function executeMigrationWithRetry(
  input: ExecuteMigrationInput,
): Promise<{ attempts: number }> {
  validateRetryOptions(input.options);
  const sleep = input.sleep ?? wait;

  for (let attempt = 1; attempt <= input.options.maxAttempts; attempt += 1) {
    let transactionStarted = false;
    try {
      await input.client.query("BEGIN");
      transactionStarted = true;
      await input.client.query(
        "SELECT set_config('lock_timeout', $1, true)",
        [`${input.options.lockTimeoutMs}ms`],
      );
      await input.client.query(input.sql);
      await input.client.query(
        "INSERT INTO _migrations (filename, content_hash) VALUES ($1, $2)",
        [input.file, input.contentHash],
      );
      await input.client.query("COMMIT");
      return { attempts: attempt };
    } catch (error) {
      if (transactionStarted) {
        await rollbackOrThrow(input.client, error);
      }

      const sqlState = migrationSqlState(error);
      if (
        sqlState === null
        || !RETRYABLE_SQLSTATES.has(sqlState)
        || attempt >= input.options.maxAttempts
      ) {
        throw error;
      }

      const delayMs = retryDelayMs(attempt, input.options);
      input.onRetry?.({
        file: input.file,
        attempt,
        maxAttempts: input.options.maxAttempts,
        delayMs,
        sqlState,
        message: migrationErrorMessage(error),
      });
      await sleep(delayMs);
    }
  }

  throw new Error(`Migration ${input.file} exhausted its retry loop unexpectedly.`);
}

export function migrationSqlState(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim().toUpperCase() : null;
}

function retryDelayMs(
  failedAttempt: number,
  options: MigrationRetryOptions,
): number {
  if (options.retryBaseDelayMs === 0 || options.retryMaxDelayMs === 0) return 0;
  const exponentialDelay = options.retryBaseDelayMs * (2 ** (failedAttempt - 1));
  return Math.min(exponentialDelay, options.retryMaxDelayMs);
}

async function rollbackOrThrow(
  client: MigrationQueryClient,
  migrationError: unknown,
): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError(
      [migrationError, rollbackError],
      "Migration failed and its transaction could not be rolled back safely.",
    );
  }
}

function validateRetryOptions(options: MigrationRetryOptions): void {
  if (options.retryMaxDelayMs < options.retryBaseDelayMs) {
    throw new Error(
      "MIGRATION_RETRY_MAX_DELAY_MS must be greater than or equal to MIGRATION_RETRY_BASE_DELAY_MS.",
    );
  }
}

function parseBoundedInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function migrationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
