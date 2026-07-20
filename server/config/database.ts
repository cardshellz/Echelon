import type { PoolConfig } from "pg";

type DatabaseEnvironment = NodeJS.ProcessEnv;

export const LOCAL_TEST_DATABASE_URL = "postgresql://localhost:5432/echelon_test_placeholder";

export function requireDatabaseUrl(env: DatabaseEnvironment = process.env): string {
  const value = env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error("DATABASE_URL environment variable is required.");
  }
  return value;
}

export function resolveDatabaseUrl(env: DatabaseEnvironment = process.env): string {
  const isTest = env.VITEST === "true" || env.NODE_ENV === "test";
  if (isTest) {
    return env.TEST_DATABASE_URL?.trim() || LOCAL_TEST_DATABASE_URL;
  }
  return requireDatabaseUrl(env);
}

export function databaseSsl(
  connectionString: string,
  env: DatabaseEnvironment = process.env,
): PoolConfig["ssl"] {
  let hostname: string;
  try {
    hostname = new URL(connectionString).hostname.toLowerCase();
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  return env.NODE_ENV === "production" || !isLocal
    ? { rejectUnauthorized: false }
    : undefined;
}
