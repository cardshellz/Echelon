import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg, { type Pool } from "pg";
import { executeMigrationWithRetry, type MigrationRetryNotice } from "../../../../../migrations/migration-executor";
import { createInventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { LISTING_PUSH_RUNS_MIGRATION_FILE, listingPushRunsMigrationSql } from "./listing-push-runs.fixture";
import {
  PICKS_PRODUCTION_INDEXES_SQL,
  SELECTED_VARIANTS_MIGRATION_FILE,
  installPicksMigrationPrerequisites,
  picksMigrationSchemaSql,
  selectedVariantsMigrationSql,
} from "./selection-picks-migration.fixture";

/**
 * The listing end requests migration of PR C (PLAN-C v4.1 §3), found by its name, never by its number: the number
 * is allocated under the stand-in PR 99999 and changes when the file is adopted under the real one
 * (docs/migration-allocation.md). Exactly one file may carry the name.
 */
export const LISTING_END_MIGRATION_SUFFIX = "_dropship_listing_end_requests.sql";

export const LISTING_END_MIGRATION_FILE: string = (() => {
  const matches = readdirSync(resolve(process.cwd(), "migrations")).filter((file) => file.endsWith(LISTING_END_MIGRATION_SUFFIX));
  if (matches.length !== 1) throw new Error(`Expected exactly one migration ending in ${LISTING_END_MIGRATION_SUFFIX}; found ${matches.length}.`);
  return matches[0]!;
})();

export function listingEndMigrationSql(): string {
  return readFileSync(resolve(process.cwd(), "migrations", LISTING_END_MIGRATION_FILE), "utf8");
}

/** The executor's options for one file; a case that holds a lock passes its own (shorter) lock timeout and attempts. */
export interface ListingEndMigrationRun {
  maxAttempts?: number;
  lockTimeoutMs?: number;
  onRetry?: (notice: MigrationRetryNotice) => void;
  sleep?: () => Promise<void>;
}

/** Applies one migration file the way the release does: through the release executor, in one transaction. */
export async function applyThroughReleaseExecutor(client: pg.PoolClient, file: string, sql: string,
  run: ListingEndMigrationRun = {}): Promise<number> {
  const result = await executeMigrationWithRetry({
    client, file, sql, contentHash: createHash("sha256").update(sql).digest("hex"),
    options: { maxAttempts: run.maxAttempts ?? 1, retryBaseDelayMs: 1, retryMaxDelayMs: 1, lockTimeoutMs: run.lockTimeoutMs ?? 15_000 },
    onRetry: run.onRetry ?? (() => undefined), sleep: run.sleep ?? (async () => undefined),
  });
  return result.attempts;
}

export interface ListingEndDatabase {
  pool: Pool;
  close: () => Promise<void>;
}

/**
 * A database of its own on the real schema path PR B's suites use (the listing-push-runs base, the real 0743, PR A's
 * runs migration, the real B picks file), then the seed, then C's file through the release executor unless
 * `applyListingEnd` is false (the migration suite applies it itself, under a held lock).
 */
export async function createListingEndDatabase(options: { seed: string; applyListingEnd?: boolean }): Promise<ListingEndDatabase> {
  const database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL,
    process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true", picksMigrationSchemaSql);
  let pool: pg.Pool | undefined;
  try {
    await installPicksMigrationPrerequisites(database.pool);
    pool = new pg.Pool({ connectionString: database.connectionString, max: 10 });
    const files: Array<[string, string]> = [[LISTING_PUSH_RUNS_MIGRATION_FILE, listingPushRunsMigrationSql()],
      [SELECTED_VARIANTS_MIGRATION_FILE, selectedVariantsMigrationSql()]];
    const client = await pool.connect();
    try {
      for (const [file, sql] of files) await applyThroughReleaseExecutor(client, file, sql);
    } finally {
      client.release();
    }
    await pool.query(PICKS_PRODUCTION_INDEXES_SQL);
    await pool.query(options.seed);
    if (options.applyListingEnd !== false) {
      const migrationClient = await pool.connect();
      try {
        await applyThroughReleaseExecutor(migrationClient, LISTING_END_MIGRATION_FILE, listingEndMigrationSql());
      } finally {
        migrationClient.release();
      }
    }
    const opened = pool;
    return { pool: opened, close: async () => { await opened.end(); await database.close(); } };
  } catch (error) {
    await pool?.end();
    await database.close();
    throw error;
  }
}

/** The columns of one end request row; a test names what it cares about and the rest is a valid `pending` row. */
export interface ListingEndRequestRow {
  vendorId: number;
  storeConnectionId: number;
  listingId: number;
  productId: number;
  productVariantId: number;
  selectionRevisionId: number;
  reason?: string;
  state?: string;
  requestedIdentity?: unknown;
  resolvedIdentity?: unknown;
  code?: string | null;
  context?: unknown;
  attemptCount?: number;
  deferralCount?: number;
  nextAttemptAt?: string | null;
  withdrawCallCount?: number;
  withdrawRequestedAt?: string | null;
  withdrawReturnedAt?: string | null;
  withdrawOutcome?: string | null;
  decidedAt?: string | null;
  endedAt?: string | null;
  staffAction?: string | null;
  staffActionKey?: string | null;
  createdAt?: string;
  version?: number;
}

/** The fixture clock of every end row (the writers pass their own injected clock; the table has no time default). */
export const LISTING_END_FIXTURE_AT = "2026-10-25T12:00:00.000Z";

/**
 * Inserts end request rows in one statement (so the consistency trigger sees them together) and returns their ids in
 * order. A row with no state is `pending`, due at its creation time. Only fixtures write here outside the save (PR C's
 * static guard covers non-test server code).
 */
export async function insertListingEndRequests(client: Pick<Pool, "query">, rows: readonly ListingEndRequestRow[]): Promise<number[]> {
  const at = LISTING_END_FIXTURE_AT;
  const values = rows.map((row) => {
    const state = row.state ?? "pending";
    return [row.vendorId, row.storeConnectionId, row.listingId, row.productId, row.productVariantId, row.selectionRevisionId,
      row.reason ?? "size_removed", state,
      JSON.stringify(row.requestedIdentity ?? { externalListingId: null, externalOfferId: null, externalAccountId: null,
        providerEnvironment: null }),
      row.resolvedIdentity === undefined ? null : JSON.stringify(row.resolvedIdentity), row.code ?? null,
      JSON.stringify(row.context ?? {}), row.attemptCount ?? 0, row.deferralCount ?? 0,
      row.nextAttemptAt !== undefined ? row.nextAttemptAt : (state === "pending" || state === "ending" ? at : null),
      row.withdrawCallCount ?? 0, row.withdrawRequestedAt ?? null, row.withdrawReturnedAt ?? null, row.withdrawOutcome ?? null,
      row.decidedAt !== undefined ? row.decidedAt : (state === "pending" || state === "ending" ? null : at),
      row.endedAt !== undefined ? row.endedAt : (state === "ended" ? at : null),
      row.staffAction ?? null, row.staffActionKey ?? null, row.createdAt ?? at, row.createdAt ?? at, row.version ?? 1];
  });
  const width = values[0]?.length ?? 0;
  const placeholders = values.map((_, row) => `(${Array.from({ length: width }, (_, column) => `$${row * width + column + 1}`).join(", ")})`);
  const result = await client.query<{ id: string }>(`INSERT INTO dropship.dropship_listing_end_requests
      (vendor_id, store_connection_id, listing_id, product_id, product_variant_id, selection_revision_id, reason, state,
       requested_identity, resolved_identity, code, context, attempt_count, deferral_count, next_attempt_at, withdraw_call_count,
       withdraw_requested_at, withdraw_returned_at, withdraw_outcome, decided_at, ended_at, staff_action, staff_action_key,
       created_at, updated_at, version)
    VALUES ${placeholders.join(", ")}
    RETURNING id`, values.flat());
  return result.rows.map((row) => Number(row.id));
}
