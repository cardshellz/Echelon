import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import * as schema from "@shared/schema";
import { createDatabasePoolConfig } from "./database-pool-config";
import {
  getPostgresPoolSnapshot,
  type PostgresPoolSnapshot,
} from "./infrastructure/postgres-pool-observability";

const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString && !process.env.VITEST) {
  throw new Error(
    "Database connection string must be set. Provide EXTERNAL_DATABASE_URL or DATABASE_URL.",
  );
}

// Always use SSL for external/production databases
// Heroku and most cloud databases require SSL connections
const useSSL = process.env.EXTERNAL_DATABASE_URL || (process.env.DATABASE_URL && process.env.DATABASE_URL.includes("amazonaws.com"));

// In test environments without a DB connection, create a stub pool so
// modules that import db.ts don't crash at load time. Actual DB calls
// will fail at runtime (tests should mock them).
const poolConfig = createDatabasePoolConfig({
  connectionString: connectionString || "postgresql://stub:stub@localhost:5432/stub",
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
  // Pool size per process. The old max:3 throttled the app to 3 connections and made
  // the reconcile sweep saturate and throw "timeout exceeded when trying to connect"
  // (the pool-acquire timeout). Heroku PG allows 200 (≈19 in use, single web dyno), so
  // there's ample headroom. Env-overridable (PG_POOL_MAX) for tuning; default 20.
  max: connectionString ? (Number(process.env.PG_POOL_MAX) || 20) : 0,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

export const pool = new Pool(poolConfig);

export function getDatabasePoolSnapshot(): PostgresPoolSnapshot {
  return getPostgresPoolSnapshot({
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    options: { max: poolConfig.max },
  });
}

pool.on("error", (error) => {
  console.error("[DatabasePool] Unexpected idle client error:", error);
});

/**
 * A small pool of its own, on the same database with the same SSL rule and
 * search path, for a side channel that must never wait behind the shared
 * pool's queue: the dropship process heartbeat (step 1 PR A, verify V5), whose
 * row other releases read to tell whether this process is alive. Every
 * statement and query is bounded, and TCP keepalive finds a dead connection.
 * The caller owns the pool and must listen for its "error" event.
 */
export function createSideChannelPool(config: {
  max: number;
  statementTimeoutMs: number;
  queryTimeoutMs: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
}): InstanceType<typeof Pool> {
  return new Pool({
    ...createDatabasePoolConfig({
      connectionString: connectionString || "postgresql://stub:stub@localhost:5432/stub",
      ssl: useSSL ? { rejectUnauthorized: false } : undefined,
      max: connectionString ? config.max : 0,
      idleTimeoutMillis: config.idleTimeoutMs,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      keepAlive: true,
    }),
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.queryTimeoutMs,
  });
}

export const db = drizzle(pool, { schema });
export type DrizzleDb = typeof db;

// This file never changes table structure or seeds rows. Schema lives only in
// the tracked migrations under migrations/, applied in the release phase
// (scripts/release.sh). The legacy fallback routine that used to live here
// (runStartupMigrations, later runReleaseSchemaFallbacks) was retired block by
// block and deleted (REFACTOR-PLAN-2026-07.md, P4.1); its progress table records
// where each block's objects are declared. Do not add DDL or DML here, and never
// run DDL against membership.* from Echelon (shellz-club owns that schema).
