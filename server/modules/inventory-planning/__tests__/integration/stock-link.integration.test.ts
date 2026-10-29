import { createHash } from "node:crypto";
import pg, { type Pool, type PoolClient } from "pg";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MigrationRetryNotice } from "../../../../../migrations/migration-executor";
import { stockLinkChecks, stockLinkDestinations } from "@shared/schema/inventory-planning.schema";
import type { InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import {
  STOCK_LINKS_MIGRATION_FILE, STOCK_LINK_SHOPIFY, addShopifyFeed, applyThroughReleaseExecutor, claimStockLinkCheck,
  createLiveShopifyTarget, createStockLinkDatabase, inStockLinkTransaction,
  installStockLinkConnectionColumns, installStockLinkTickColumns, readStockLinkCheck, readStockLinkHead, sealStockLink, seedStockLinkDestination,
  stockLinksMigrationSql,
} from "../fixtures/stock-link.fixture";
import {
  STOCK_LINK_ACTOR, STOCK_LINK_KEY_PREFIX, normalizeShopifyItemId, normalizeStockLinkSku, planStockLinkBatch,
  type StockLinkBatchPlan, type StockLinkCommandPlan, type StockLinkSizeFacts,
} from "../../domain/stock-link";
import type { StockLinkDestination, StockLinkStoreItem } from "@shared/types/stock-link";
import { readPublicationStockSelection } from "../../infrastructure/inventory-publication-selection.reader";
import { createShopifyStockLinkSource } from "../../../channels/shopify-stock-link-source";
import { CHANNEL_VARIANT_OVERRIDE_LOCK_SQL, channelVariantOverrideLockKey } from "../../../channels/infrastructure/channel-variant-override-lock";
import { quantityPublicationScopeLockKey } from "../../infrastructure/quantity-publication-admission.repository";
import { PUBLICATION_TARGET_SCOPE_LOCK_SEED } from "../../infrastructure/inventory-publication-target-stop.repository";
import { STOCK_LINK_HEADS_FOR_UPDATE_SQL } from "../../infrastructure/stock-link-command";
import type { StockLinkCheckClaim } from "../../infrastructure/stock-link-checks.repository";
import {
  runShopifyStockLinkCommand, type StockLinkCommandResult,
} from "../../infrastructure/stock-link-shopify-command";
import { InventoryPublicationOutboxService } from "../../application/inventory-publication-outbox.service";
import { InventoryPublicationTransportError, type InventoryPublicationTransportAdapter } from "../../application/inventory-publication-transport";
import { InventoryPublicationTargetEnableService } from "../../application/inventory-publication-target-enable.service";
import { InventoryPublicationTargetStopService } from "../../application/inventory-publication-target-stop.service";
import {
  createAuthorityAwareInventoryPublicationService, createTransactionScopedInventoryPublicationService,
} from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { PostgresInventoryChannelExposureAdminStore } from "../../infrastructure/inventory-channel-exposure-admin.repository";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";
import { PostgresInventoryPublicationTargetEnableStore } from "../../infrastructure/inventory-publication-target-enable.repository";
import { PostgresInventoryPublicationTargetStopStore } from "../../infrastructure/inventory-publication-target-stop.repository";
import { readTargets } from "../../infrastructure/publication-mapping-preparation.repository";
import { createStockLinkService } from "../../infrastructure/stock-link.factory";
import { STOCK_LINK_LOCK_ID, runLockedStockLinkTick } from "../../infrastructure/stock-link-runner";
import type { StockLinkAdapter } from "../../application/stock-link.ports";
import { createAdvisoryLockRunner } from "../../../../infrastructure/scheduler-lock";
import { applyStockIdentityChangeInsideTransaction, type ExactStockIdentityMember } from "../../infrastructure/exact-stock-identity.apply";
import { retireStockLinkMappingsInsideTransaction } from "../../infrastructure/stock-link-retire";
import {
  channelStockUpdateDeadLetterDestinationCountSql,
} from "../../channel-stock-update-dead-letters";
import { StockLinkControlsService } from "../../application/stock-link-controls.service";
import { PostgresStockLinkControlsStore } from "../../infrastructure/stock-link-controls.repository";
import { STOCK_LINK_HEALTH_CHECKS, stockLinkHealthChecks } from "../../stock-link-health";
import { beatStockLinkDestination, countStockLinkRetiresWithoutReplacement } from "../../infrastructure/stock-link-checks.repository";
import { stockLinkRetireWindowStart } from "../../domain/stock-link";

// Channels PR2 (PLAN-CH2 v4.1 §11.4): the shared stock-link engine over real PostgreSQL. This block is the schema
// (PG 1 and 1b): migration M1 through the release executor, its keys, CHECKs, indexes and the Drizzle declaration.
// Later blocks (P4+) cover the engine; each builds its own database.
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const AT = "2026-10-27T12:00:00.000Z";
const CASE_TIMEOUT_MS = 60_000;

type Refusal = { code?: string; constraint?: string };

dbDescribe.sequential("stock-link migration M1, real PostgreSQL (PG 1, 1b)", () => {
  let database: InventoryCutoverTestDatabase;
  let targetId: number;
  const notices: MigrationRetryNotice[] = [];
  let beforeRetry: unknown[] = [];
  let lockWait: Array<{ rel: string; mode: string; granted: boolean }> = [];
  let attempts = 0;

  beforeAll(async () => {
    database = await createStockLinkDatabase({ applyStockLinks: false });
    targetId = await createLiveShopifyTarget(database.pool);
    // A catalog writer of the previous release holds ROW EXCLUSIVE on the sizes while the release runs: the file's
    // variant key needs SHARE ROW EXCLUSIVE there, waits, times out (55P03); the retry runs once the writer commits.
    const blocker = await database.pool.connect();
    const migrationClient = await database.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE catalog.product_variants IN ROW EXCLUSIVE MODE");
      const migrationPid = (await migrationClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const applying = applyThroughReleaseExecutor(migrationClient, STOCK_LINKS_MIGRATION_FILE, stockLinksMigrationSql(), {
        maxAttempts: 3, lockTimeoutMs: 3_000,
        onRetry: (notice) => { notices.push(notice); },
        sleep: async () => {
          beforeRetry = (await database.pool.query(`SELECT to_regclass('inventory.stock_link_checks')::text AS checks,
            to_regclass('inventory.stock_link_destinations')::text AS destinations,
            EXISTS (SELECT 1 FROM public._migrations WHERE filename = $1) AS applied`, [STOCK_LINKS_MIGRATION_FILE])).rows;
          await blocker.query("COMMIT");
        },
      });
      // While the first attempt waits: the locks it holds and waits for on the two referenced tables (the plain
      // AccessShareLock of reading a table's definition is left out; it blocks no writer).
      for (let poll = 0; poll < 100 && lockWait.length === 0; poll += 1) {
        const rows = (await database.pool.query<{ rel: string; mode: string; granted: boolean }>(`SELECT relation::regclass::text AS rel,mode,granted
          FROM pg_locks WHERE pid=$1 AND locktype='relation' AND mode <> 'AccessShareLock'
            AND relation IN ('catalog.product_variants'::regclass,'inventory.inventory_publication_targets'::regclass)
          ORDER BY rel,mode`, [migrationPid])).rows;
        if (rows.some((row) => !row.granted)) lockWait = rows;
        else await new Promise((done) => setTimeout(done, 20));
      }
      attempts = await applying;
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      migrationClient.release();
    }
  }, 120_000);

  afterAll(async () => { await database?.close(); });

  /** Statements in one transaction that is always rolled back. */
  async function rolledBack(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await work(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  /** The error a piece of work raises, inside a savepoint of the caller's transaction (rolled back to after). */
  async function refusalIn(client: PoolClient, sql: string, values: unknown[] = []): Promise<Refusal> {
    await client.query("SAVEPOINT refusal");
    const error = await client.query(sql, values).then(() => null, (caught: unknown) => caught as Refusal);
    await client.query("ROLLBACK TO SAVEPOINT refusal");
    expect(error, `expected a refusal of: ${sql}`).not.toBeNull();
    return { code: error!.code, constraint: error!.constraint };
  }

  /** One check row with valid values for its status; overrides are raw column values. */
  function checkRow(overrides: Record<string, unknown> = {}): { sql: string; values: unknown[] } {
    const row: Record<string, unknown> = { publication_target_id: targetId, product_variant_id: STOCK_LINK_SHOPIFY.variantId,
      status: "waiting", next_check_at: AT, created_at: AT, updated_at: AT, ...overrides };
    const columns = Object.keys(row);
    return { sql: `INSERT INTO inventory.stock_link_checks(${columns.join(",")}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(",")})`,
      values: Object.values(row) };
  }
  function destinationRow(overrides: Record<string, unknown> = {}): { sql: string; values: unknown[] } {
    const row: Record<string, unknown> = { publication_target_id: targetId, created_at: AT, updated_at: AT, ...overrides };
    const columns = Object.keys(row);
    return { sql: `INSERT INTO inventory.stock_link_destinations(${columns.join(",")}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(",")})`,
      values: Object.values(row) };
  }
  const refuseCheck = (client: PoolClient, overrides: Record<string, unknown>) => {
    const { sql, values } = checkRow(overrides);
    return refusalIn(client, sql, values);
  };
  const refuseDestination = (client: PoolClient, overrides: Record<string, unknown>) => {
    const { sql, values } = destinationRow(overrides);
    return refusalIn(client, sql, values);
  };

  it("applies once through the release executor after a lock wait on the sizes, leaving nothing behind (PG 1b)", async () => {
    // The keys take SHARE ROW EXCLUSIVE: granted on the destinations, waited for on the sizes (the held ROW EXCLUSIVE).
    expect(lockWait).toEqual([
      { rel: "catalog.product_variants", mode: "ShareRowExclusiveLock", granted: false },
      { rel: "inventory.inventory_publication_targets", mode: "ShareRowExclusiveLock", granted: true },
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ file: STOCK_LINKS_MIGRATION_FILE, attempt: 1, sqlState: "55P03" });
    expect(beforeRetry).toEqual([{ checks: null, destinations: null, applied: false }]);
    expect(attempts).toBe(2);
    expect((await database.pool.query("SELECT 1 FROM public._migrations WHERE filename = $1", [STOCK_LINKS_MIGRATION_FILE])).rowCount).toBe(1);
    // No boot DML, no backfill: both tables are new and empty, with no triggers (not fence-pinned, §3).
    expect((await database.pool.query(`SELECT (SELECT count(*)::int FROM inventory.stock_link_checks) AS checks,
      (SELECT count(*)::int FROM inventory.stock_link_destinations) AS destinations`)).rows).toEqual([{ checks: 0, destinations: 0 }]);
    expect((await database.pool.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
      AND tgrelid IN ('inventory.stock_link_checks'::regclass,'inventory.stock_link_destinations'::regclass)`)).rows).toEqual([]);
    // Not written to be re-run: a second application fails loudly and changes nothing.
    await rolledBack(async (client) => {
      expect(await refusalIn(client, stockLinksMigrationSql())).toMatchObject({ code: "42P07" });
    });
  }, CASE_TIMEOUT_MS);

  it("declares the same columns, keys, CHECKs and indexes in Drizzle as the migration creates (PG 1)", async () => {
    for (const table of [stockLinkChecks, stockLinkDestinations] as PgTable[]) {
      const config = getTableConfig(table);
      const qualified = `${config.schema}.${config.name}`;
      const columns = (await database.pool.query<{ name: string; type: string; not_null: boolean; has_default: boolean }>(`SELECT
          a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
          (a.atthasdef OR a.attidentity <> '') AS has_default
        FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attname`, [qualified])).rows;
      const sqlType = (type: string) => type.replace(/^varchar\((\d+)\)$/, "character varying($1)").replace(/^timestamp$/, "timestamp without time zone");
      expect(config.columns.map((column) => ({ name: column.name, type: sqlType(column.getSQLType()), not_null: column.notNull,
        has_default: column.hasDefault || column.generatedIdentity !== undefined })).sort((a, b) => a.name.localeCompare(b.name)), qualified)
        .toEqual(columns);
      const constraints = (await database.pool.query<{ name: string }>(`SELECT conname AS name FROM pg_constraint
        WHERE conrelid=$1::regclass AND contype IN ('c','f','u') ORDER BY conname`, [qualified])).rows.map((row) => row.name);
      expect([...config.checks.map((check) => check.name), ...config.foreignKeys.map((key) => key.getName()),
        ...config.uniqueConstraints.map((constraint) => constraint.name!)].sort(), qualified).toEqual(constraints);
      const indexes = (await database.pool.query<{ name: string }>(`SELECT i.relname AS name FROM pg_index x
        JOIN pg_class i ON i.oid=x.indexrelid
        WHERE x.indrelid=$1::regclass AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=x.indexrelid)
        ORDER BY i.relname`, [qualified])).rows.map((row) => row.name);
      expect(config.indexes.map((index) => index.config.name!).sort(), qualified).toEqual(indexes);
    }
    expect((await database.pool.query<{ name: string; definition: string }>(`SELECT indexname AS name, indexdef AS definition FROM pg_indexes
      WHERE schemaname='inventory' AND tablename='stock_link_checks' ORDER BY indexname`)).rows).toEqual([
      { name: "stock_link_checks_due_idx", definition: expect.stringMatching(
        /\(publication_target_id, next_check_at, id\) WHERE \(\(status\)::text <> 'error'::text\)$/) },
      { name: "stock_link_checks_pair_uq", definition: expect.stringMatching(/UNIQUE INDEX .* \(publication_target_id, product_variant_id\)$/) },
      { name: "stock_link_checks_pkey", definition: expect.stringMatching(/UNIQUE INDEX .* \(id\)$/) },
      { name: "stock_link_checks_variant_idx", definition: expect.stringMatching(/\(product_variant_id\)$/) },
      { name: "stock_link_checks_waiting_item_idx", definition: expect.stringMatching(
        /\(publication_target_id, waiting_item_id\) WHERE \(waiting_item_id IS NOT NULL\)$/) },
    ]);
    // Delete rules: a destination cannot be deleted under its rows; a deleted size takes its check rows with it.
    expect((await database.pool.query(`SELECT conname,confdeltype FROM pg_constraint WHERE contype='f'
      AND conrelid IN ('inventory.stock_link_checks'::regclass,'inventory.stock_link_destinations'::regclass) ORDER BY conname`)).rows).toEqual([
      { conname: "stock_link_checks_target_fk", confdeltype: "r" },
      { conname: "stock_link_checks_variant_fk", confdeltype: "c" },
      { conname: "stock_link_destinations_target_fk", confdeltype: "r" },
    ]);
  });

  it("accepts each check status with the defaults the engine relies on (PG 1)", async () => {
    await rolledBack(async (client) => {
      const waiting = checkRow();
      const id = (await client.query<{ id: string }>(`${waiting.sql} RETURNING id::text`, waiting.values)).rows[0]!.id;
      expect((await client.query(`SELECT status,reason_code,error_class,attempt_count,revision::text,lease_token,first_failure_at,busy_since,
        waiting_item_id,observed_sku FROM inventory.stock_link_checks WHERE id=$1`, [id])).rows).toEqual([{ status: "waiting", reason_code: null,
        error_class: null, attempt_count: 0, revision: "1", lease_token: null, first_failure_at: null, busy_since: null, waiting_item_id: null,
        observed_sku: null }]);
      await client.query("DELETE FROM inventory.stock_link_checks");
      for (const overrides of [
        { status: "waiting", reason_code: "STOCK_LINK_NOT_LISTED", attempt_count: 3, first_failure_at: AT, busy_since: AT },
        { status: "linked", observed_sku: "P5", lease_token: "6b1c3d7e-0f4a-4c1b-9a2e-8d5f6a7b8c9d", lease_expires_at: AT },
        { status: "flagged", reason_code: "STOCK_LINK_ITEM_SHARED", waiting_item_id: "8".repeat(240) },
        { status: "error", reason_code: "STOCK_MAPPING_COMMAND_CONFLICT", error_class: "permanent", next_check_at: null, message: "m".repeat(1000) },
      ]) {
        const row = checkRow(overrides);
        await client.query(row.sql, row.values);
        await client.query("DELETE FROM inventory.stock_link_checks");
      }
    });
  });

  it("refuses check rows that break a rule, each by its named constraint (PG 1)", async () => {
    await rolledBack(async (client) => {
      const check = (constraint: string) => ({ code: "23514", constraint });
      expect(await refuseCheck(client, { status: "linked_maybe" })).toEqual(check("stock_link_checks_status_chk"));
      for (const reason_code of ["", " STOCK_LINK_NOT_LISTED", "STOCK_LINK_NOT_LISTED "])
        expect(await refuseCheck(client, { reason_code })).toEqual(check("stock_link_checks_reason_code_chk"));
      expect(await refuseCheck(client, { error_class: "busy" })).toEqual(check("stock_link_checks_error_class_chk"));
      expect(await refuseCheck(client, { attempt_count: -1 })).toEqual(check("stock_link_checks_attempt_count_chk"));
      expect(await refuseCheck(client, { revision: 0 })).toEqual(check("stock_link_checks_revision_chk"));
      expect(await refuseCheck(client, { lease_token: "6b1c3d7e-0f4a-4c1b-9a2e-8d5f6a7b8c9d" })).toEqual(check("stock_link_checks_lease_chk"));
      expect(await refuseCheck(client, { lease_expires_at: AT })).toEqual(check("stock_link_checks_lease_chk"));
      // next_check_at is NULL exactly for rows stopped on an error.
      expect(await refuseCheck(client, { next_check_at: null })).toEqual(check("stock_link_checks_next_chk"));
      expect(await refuseCheck(client, { status: "error", reason_code: "STOCK_LINK_UNCLASSIFIED" })).toEqual(check("stock_link_checks_next_chk"));
      // A flagged or error row always says why.
      expect(await refuseCheck(client, { status: "flagged" })).toEqual(check("stock_link_checks_reason_chk"));
      expect(await refuseCheck(client, { status: "error", next_check_at: null })).toEqual(check("stock_link_checks_reason_chk"));
      // The engine writes its own clock: no default for created_at / updated_at.
      const noCreatedAt = { sql: `INSERT INTO inventory.stock_link_checks(publication_target_id,product_variant_id,status,next_check_at,updated_at)
        VALUES($1,$2,'waiting',$3,$3)`, values: [targetId, STOCK_LINK_SHOPIFY.variantId, AT] };
      expect(await refusalIn(client, noCreatedAt.sql, noCreatedAt.values)).toMatchObject({ code: "23502" });
      // Widths: never silently truncated (a 101-character store SKU is never stored, TST-12).
      expect(await refuseCheck(client, { observed_sku: "S".repeat(101) })).toMatchObject({ code: "22001" });
      expect(await refuseCheck(client, { waiting_item_id: "8".repeat(241) })).toMatchObject({ code: "22001" });
      expect(await refuseCheck(client, { reason_code: "R".repeat(121) })).toMatchObject({ code: "22001" });
      // One row per (destination, size).
      const first = checkRow();
      await client.query(first.sql, first.values);
      expect(await refuseCheck(client, { status: "linked" })).toEqual({ code: "23505", constraint: "stock_link_checks_pair_uq" });
      // Keys.
      expect(await refuseCheck(client, { publication_target_id: 999_999 })).toEqual({ code: "23503", constraint: "stock_link_checks_target_fk" });
      expect(await refuseCheck(client, { product_variant_id: 999_999 })).toEqual({ code: "23503", constraint: "stock_link_checks_variant_fk" });
    });
  });

  it("deletes a size's check rows with the size; a destination is never deleted at all (PG 1)", async () => {
    await rolledBack(async (client) => {
      await client.query("INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(9101,$1,'STOCK-LINK-CASCADE')", [STOCK_LINK_SHOPIFY.productId]);
      // A bare destination with nothing else under it.
      const bare = (await client.query<{ id: number }>(`INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,
        fulfillment_node_id,provider_scope_type,external_scope_id,publication_authority,state,change_reason,created_by)
        VALUES($1,$2,1,'location','55555','echelon','disabled','Bare stock-link destination','fixture') RETURNING id`,
      [STOCK_LINK_SHOPIFY.channelId, STOCK_LINK_SHOPIFY.connectionId])).rows[0]!.id;
      for (const variant of [9101, STOCK_LINK_SHOPIFY.variantId]) {
        const row = checkRow({ publication_target_id: bare, product_variant_id: variant });
        await client.query(row.sql, row.values);
      }
      await client.query("DELETE FROM catalog.product_variants WHERE id=9101");
      expect((await client.query("SELECT product_variant_id FROM inventory.stock_link_checks WHERE publication_target_id=$1", [bare])).rows)
        .toEqual([{ product_variant_id: STOCK_LINK_SHOPIFY.variantId }]);
      // Destinations are append-only (inventory_publication_targets_delete_guard, 0623): the delete is refused before
      // any key is checked, so this file's RESTRICT keys (confdeltype 'r', pinned above) are a backstop only.
      const destination = destinationRow({ publication_target_id: bare });
      await client.query(destination.sql, destination.values);
      expect(await refusalIn(client, "DELETE FROM inventory.inventory_publication_targets WHERE id=$1", [bare]))
        .toMatchObject({ code: "P0001" });
    });
  });

  it("keeps destination state whole: switch on by default, pause / halt / release all or none, codes trimmed (PG 1)", async () => {
    await rolledBack(async (client) => {
      const row = destinationRow();
      await client.query(row.sql, row.values);
      expect((await client.query(`SELECT auto_link_enabled,revision::text,paused_until,paused_code,paused_since,halted_at,halted_code,
        retires_released_at,retires_released_by,recent_cursor_raw,recent_cursor_id,sweep_cursor_variant_id,dead_letter_cursor_at,heartbeat_at
        FROM inventory.stock_link_destinations WHERE publication_target_id=$1`, [targetId])).rows).toEqual([{ auto_link_enabled: true,
        revision: "1", paused_until: null, paused_code: null, paused_since: null, halted_at: null, halted_code: null, retires_released_at: null,
        retires_released_by: null, recent_cursor_raw: null, recent_cursor_id: null, sweep_cursor_variant_id: null, dead_letter_cursor_at: null,
        heartbeat_at: null }]);
      expect(await refuseDestination(client, {})).toEqual({ code: "23505", constraint: "stock_link_destinations_pkey" });
      await client.query("DELETE FROM inventory.stock_link_destinations");
      const check = (constraint: string) => ({ code: "23514", constraint });
      for (const overrides of [
        { paused_until: AT }, { paused_until: AT, paused_code: "STOCK_LINK_STORE_AUTH_REFUSED" }, { paused_code: "X", paused_since: AT },
        { paused_until: AT, paused_code: " STOCK_LINK_STORE_AUTH_REFUSED", paused_since: AT }, { paused_until: AT, paused_code: "", paused_since: AT },
      ]) expect(await refuseDestination(client, overrides)).toEqual(check("stock_link_destinations_pause_chk"));
      for (const overrides of [{ halted_at: AT }, { halted_code: "STOCK_LINK_UNCLASSIFIED" }, { halted_at: AT, halted_code: "STOCK_LINK_UNCLASSIFIED " }])
        expect(await refuseDestination(client, overrides)).toEqual(check("stock_link_destinations_halt_chk"));
      for (const overrides of [{ retires_released_at: AT }, { retires_released_by: "operator" }, { retires_released_at: AT, retires_released_by: " " }])
        expect(await refuseDestination(client, overrides)).toEqual(check("stock_link_destinations_release_chk"));
      expect(await refuseDestination(client, { revision: 0 })).toEqual(check("stock_link_destinations_revision_chk"));
      expect(await refuseDestination(client, { publication_target_id: 999_999 }))
        .toEqual({ code: "23503", constraint: "stock_link_destinations_target_fk" });
      const whole = destinationRow({ auto_link_enabled: false, paused_until: AT, paused_code: "STOCK_LINK_STORE_NOT_ANSWERING", paused_since: AT,
        halted_at: AT, halted_code: "STOCK_LINK_UNCLASSIFIED", retires_released_at: AT, retires_released_by: "operator-1", revision: 7 });
      await client.query(whole.sql, whole.values);
    });
  });

  it("keeps the raw feed cursor exactly as written, whatever the session time zone (PG 1, TST-8)", async () => {
    await rolledBack(async (client) => {
      // The feed column is zone-less with microseconds (channel_feeds.updated_at); the cursor must hold it unchanged.
      const row = destinationRow({ recent_cursor_raw: "2026-10-27 08:15:30.123456", recent_cursor_id: "9007199254740993" });
      await client.query(row.sql, row.values);
      for (const zone of ["UTC", "America/New_York", "Asia/Kolkata"]) {
        await client.query(`SET LOCAL TIME ZONE '${zone}'`);
        expect((await client.query(`SELECT recent_cursor_raw::text AS raw, recent_cursor_id::text AS id,
          pg_typeof(recent_cursor_raw)::text AS type FROM inventory.stock_link_destinations`)).rows)
          .toEqual([{ raw: "2026-10-27 08:15:30.123456", id: "9007199254740993", type: "timestamp without time zone" }]);
      }
    });
  });
});

// P3 (PLAN-CH2 v4.1 §12): the writers PR2 keeps on any revert (§21), over real PostgreSQL on PR1's real-outbox path. The
// engine's command (P4) is not built yet: these cases drive its two steps 7-8 (applyStockIdentityChangeInsideTransaction,
// stock-link-retire.ts) inside the engine's configuration transaction with the cutover fence held, then the existing
// writers that must now accept a retired or relinked size: the draft writer (§4.4), target enable (§4.5, N1), the outbox
// worker (§4.8, N5) and the dead-letter reader (§8, N9).
const ITEM_A = "222";
const ITEM_B = "223";
const ITEM_NEW = "333";
const P3_NOW = new Date(AT);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

dbDescribe.sequential("stock-link writers kept on any revert, real PostgreSQL (P3: PG 5, 6, 10, 11, 12, 19, 27; B1 swap)", () => {
  let database: InventoryCutoverTestDatabase;
  let targetId: number;
  let mappingA: number;
  let due: Date;
  const dialect = new PgDialect();
  const pool = () => database.pool;

  beforeEach(async () => {
    database = await createStockLinkDatabase();
    await addShopifyFeed(database.pool, 101, ITEM_A, { sku: "P5" });
    targetId = await createLiveShopifyTarget(database.pool);
    mappingA = await sealStockLink(database.pool, targetId, 101, ITEM_A, { sku: "P5" });
  }, CASE_TIMEOUT_MS);
  afterEach(async () => {
    vi.restoreAllMocks();
    await database?.close();
  });

  const publish = async (productVariantIds: number[], publicationTargetId = targetId) => {
    const routed = await createAuthorityAwareInventoryPublicationService(database.pool, { logger: quiet }).publishProduct({
      productId: 20, publicationTargetId, productVariantIds, dryRun: false, triggeredBy: "stock_link_p3_test" }, async () => null);
    expect(routed.authority).toBe("canonical");
  };
  const outbox = async (productVariantId: number, publicationTargetId = targetId) => (await database.pool.query<{
    id: string; desired_revision: string; desired_quantity: string; state: string; external_inventory_item_id_snapshot: string;
    last_error_class: string | null; lease_token: string | null }>(`SELECT id::text,desired_revision::text,desired_quantity::text,
    state,external_inventory_item_id_snapshot,last_error_class,lease_token
    FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1 AND product_variant_id=$2 ORDER BY desired_revision`,
  [publicationTargetId, productVariantId])).rows;
  const versions = async (productVariantId: number, publicationTargetId = targetId) => (await database.pool.query<{
    id: number; version: number; lifecycle_status: string; external_inventory_item_id: string; supersedes_mapping_id: number | null;
    retired_by: string | null; sealed_at: Date | null; retired_at: Date | null }>(`SELECT id,version,lifecycle_status,
    external_inventory_item_id,supersedes_mapping_id,retired_by,sealed_at,retired_at
    FROM inventory.publication_variant_mapping_versions WHERE publication_target_id=$1 AND product_variant_id=$2 ORDER BY version`,
  [publicationTargetId, productVariantId])).rows;
  const target = async (id = targetId) => (await database.pool.query<{ state: string; revision: string }>(
    "SELECT state,revision::text FROM inventory.inventory_publication_targets WHERE id=$1", [id])).rows[0]!;
  const sellFiveUnits = () => database.pool.query(`UPDATE inventory.inventory_levels SET variant_qty=variant_qty-5 WHERE product_variant_id=101;
    UPDATE inventory.inventory_lots SET qty_on_hand=qty_on_hand-5 WHERE product_variant_id=101`);
  const nextDue = async () => {
    due = (await database.pool.query(`SELECT date_trunc('milliseconds',max(available_at))+interval '1 millisecond' AS due
      FROM inventory.inventory_publication_outbox WHERE state='queued'`)).rows[0].due;
  };

  /** The engine's retire-only command for one size (steps 7 only), on the head as it is now. */
  const retireOnly = async (productVariantId: number, now = P3_NOW) => {
    const head = (await readStockLinkHead(database.pool, targetId, productVariantId))!;
    return inStockLinkTransaction(database.pool, client => retireStockLinkMappingsInsideTransaction(client, {
      publicationTargetId: targetId, actor: STOCK_LINK_ACTOR, reason: "Store item is gone.", now,
      members: [{ productVariantId, mappingId: head.active_mapping_id!, expectedHeadRevision: head.revision }] }));
  };
  /** Steps 7-8 of one engine command: retire `retire`, then link `links` (create) in one transaction. */
  const change = async (input: { commandKey: string; retire: number[]; links: Array<{ productVariantId: number; itemId: string; sku: string }> }) => {
    const heads = new Map<number, { revision: string; active_mapping_id: number | null }>();
    for (const variantId of new Set([...input.retire, ...input.links.map(link => link.productVariantId)])) {
      const head = await readStockLinkHead(database.pool, targetId, variantId);
      heads.set(variantId, head ?? { revision: "0", active_mapping_id: null });
    }
    return inStockLinkTransaction(database.pool, async (client, scopeKeys) => {
      const destination = (await readTargets(client, undefined, undefined, targetId, true))[0]!;
      const members: ExactStockIdentityMember[] = input.links.map(link => ({ productVariantId: link.productVariantId,
        mappingAction: "create", externalInventoryItemId: link.itemId, externalSku: link.sku,
        expectedHeadRevision: heads.get(link.productVariantId)!.revision }));
      return applyStockIdentityChangeInsideTransaction(client, scopeKeys, {
        publicationTargetId: targetId, actor: STOCK_LINK_ACTOR, now: P3_NOW, retireReason: "Store item moved.",
        retire: input.retire.map(variantId => ({ productVariantId: variantId, mappingId: heads.get(variantId)!.active_mapping_id!,
          expectedHeadRevision: heads.get(variantId)!.revision })),
        link: members.length === 0 ? null : { target: destination, members, productId: 20, allowRetainedZero: false,
          exactVariantScope: true, idempotencyPrefix: STOCK_LINK_KEY_PREFIX, commandKey: input.commandKey,
          requestHash: sha(input.commandKey), actor: STOCK_LINK_ACTOR, now: P3_NOW, changeReason: "Linked by store SKU.",
          afterPromotion: async () => undefined },
      });
    });
  };
  /** A stub store: records every write; `refuse` items answer a non-retryable refusal (Shopify's 404). */
  const stubStore = (refuse: readonly string[] = []) => {
    const accepted = new Map<string, number>();
    const adapter = {
      destinationKind: "channel_connection", providerKey: "shopify", supportedScopeTypes: ["location"],
      publishAbsolute: vi.fn(async (request: { externalInventoryItemId: string; desiredQuantity: number }) => {
        if (refuse.includes(request.externalInventoryItemId))
          throw new InventoryPublicationTransportError("SHOPIFY_INVENTORY_ITEM_NOT_FOUND", "Shopify answered 404 for this item.", false);
        accepted.set(request.externalInventoryItemId, request.desiredQuantity);
        return { publishedQuantity: request.desiredQuantity, providerResponse: { stub: true } };
      }),
      readAbsolute: vi.fn(async (request: { externalInventoryItemId: string }) => ({
        observedQuantity: accepted.get(request.externalInventoryItemId) ?? 0, providerResponse: { stub: true } })),
    } satisfies InventoryPublicationTransportAdapter;
    const repository = new PostgresInventoryPublicationOutboxRepository(database.pool, { error: vi.fn(), debug: vi.fn() });
    const service = new InventoryPublicationOutboxService(repository, { get: () => adapter }, { now: () => due }, () => "stock-link-p3-lease",
      { runOutbox: async (_claim, work) => work() });
    return { adapter, repository, service };
  };
  const stop = async () => new InventoryPublicationTargetStopService(new PostgresInventoryPublicationTargetStopStore(database.pool),
    { now: () => P3_NOW }).stop({ publicationTargetId: targetId, expectedRevision: (await target()).revision, idempotencyKey: `stop-${targetId}` },
    "operator-1");
  const enable = async (id = targetId) => new InventoryPublicationTargetEnableService(new PostgresInventoryPublicationTargetEnableStore(database.pool),
    { now: () => P3_NOW }).enable({ publicationTargetId: id, expectedRevision: (await target(id)).revision, idempotencyKey: `enable-${id}` },
    "operator-1");
  const deadLetterCount = async () => {
    const { sql, params } = dialect.sqlToQuery(channelStockUpdateDeadLetterDestinationCountSql() as SQL);
    return Number((await database.pool.query(sql, params as unknown[])).rows[0]?.count);
  };

  it("retires a sealed link: head loses its active version, version retired by the engine, old-item rows superseded (PG 6)", async () => {
    await publish([101]);
    await nextDue();
    const { repository, service, adapter } = stubStore();
    const [claim] = await repository.claimDue({ batchSize: 5, leaseSeconds: 120, leaseToken: "worker-before-retire", now: due });
    expect(claim).toMatchObject({ productVariantId: 101, externalInventoryItemId: ITEM_A });
    const head = (await readStockLinkHead(database.pool, targetId, 101))!;

    const [retired] = await retireOnly(101);

    expect(retired).toEqual({ productVariantId: 101, mappingId: mappingA, externalInventoryItemId: ITEM_A, externalSku: "P5",
      sealedAt: "2026-10-01T00:00:00.000Z", retiredAt: AT, headRevision: String(Number(head.revision) + 1),
      supersededOutboxIds: [claim!.outboxId] });
    expect(await readStockLinkHead(database.pool, targetId, 101)).toEqual({ revision: retired!.headRevision, active_mapping_id: null,
      draft_mapping_id: null });
    expect(await versions(101)).toMatchObject([{ id: mappingA, lifecycle_status: "retired", retired_by: STOCK_LINK_ACTOR }]);
    // The leased row lost its lease: the worker that claimed it can no longer write to the store.
    expect(await outbox(101)).toEqual([expect.objectContaining({ id: claim!.outboxId, state: "superseded",
      last_error_class: "PUBLICATION_IDENTITY_RETIRED", lease_token: null })]);
    const work = vi.fn();
    await expect(repository.runIfCurrent(claim!, work)).rejects.toMatchObject({ code: "PUBLICATION_LEASE_LOST" });
    expect(work).not.toHaveBeenCalled();
    expect(await service.processDue()).toMatchObject({ claimed: 0 });
    expect(adapter.publishAbsolute).not.toHaveBeenCalled();
  }, CASE_TIMEOUT_MS);

  it("retires at the version's seal time when the seal is later than the injected clock (PG 10)", async () => {
    // Sealed by a process whose clock runs an hour ahead of the engine's.
    await addShopifyFeed(database.pool, 102, ITEM_B, { sku: "NEW" });
    await sealStockLink(database.pool, targetId, 102, ITEM_B, { sku: "NEW", sealedAt: "2026-10-27T13:00:00.000Z" });
    const heads = [await readStockLinkHead(database.pool, targetId, 101), await readStockLinkHead(database.pool, targetId, 102)];
    const retired = await inStockLinkTransaction(database.pool, client => retireStockLinkMappingsInsideTransaction(client, {
      publicationTargetId: targetId, actor: STOCK_LINK_ACTOR, reason: "Store items are gone.", now: P3_NOW,
      members: [102, 101].map((productVariantId, index) => ({ productVariantId, mappingId: heads[1 - index]!.active_mapping_id!,
        expectedHeadRevision: heads[1 - index]!.revision })) }));
    expect(retired.map(row => [row.productVariantId, row.sealedAt, row.retiredAt])).toEqual([
      [101, "2026-10-01T00:00:00.000Z", AT],
      [102, "2026-10-27T13:00:00.000Z", "2026-10-27T13:00:00.000Z"],
    ]);
    expect((await versions(102))[0]).toMatchObject({ lifecycle_status: "retired", retired_at: new Date("2026-10-27T13:00:00.000Z") });
  }, CASE_TIMEOUT_MS);

  it("refuses a retire decided on an older head revision, writing nothing", async () => {
    const head = (await readStockLinkHead(database.pool, targetId, 101))!;
    await expect(inStockLinkTransaction(database.pool, client => retireStockLinkMappingsInsideTransaction(client, {
      publicationTargetId: targetId, actor: STOCK_LINK_ACTOR, reason: "Store item is gone.", now: P3_NOW,
      members: [{ productVariantId: 101, mappingId: mappingA, expectedHeadRevision: String(Number(head.revision) - 1) }] })))
      .rejects.toMatchObject({ code: "STOCK_LINK_HEAD_CHANGED", errorClass: "transient" });
    expect(await readStockLinkHead(database.pool, targetId, 101)).toEqual(head);
    expect((await versions(101))[0]).toMatchObject({ lifecycle_status: "sealed" });
  }, CASE_TIMEOUT_MS);

  it("lets a manual draft follow an engine retire-only: the new version supersedes the retired one (PG 5)", async () => {
    await retireOnly(101);
    const head = (await readStockLinkHead(database.pool, targetId, 101))!;
    const store = new PostgresInventoryChannelExposureAdminStore(drizzle(database.pool) as never);
    const saved = await store.saveVariantMappingDraft({ publicationTargetId: targetId, productVariantId: 101,
      externalInventoryItemId: ITEM_NEW, externalSku: "P5", expectedHeadRevision: head.revision, expectedDraftMappingId: null,
      expectedDraftDefinitionHash: null, changeReason: "Operator saved the new store item.", idempotencyKey: "manual-after-retire",
      requestHash: sha("manual-after-retire"), actorId: "operator-1", occurredAt: P3_NOW });
    expect(saved).toMatchObject({ version: 2, alreadyApplied: false });
    expect(await versions(101)).toMatchObject([
      { id: mappingA, version: 1, lifecycle_status: "retired" },
      { id: saved.definitionId, version: 2, lifecycle_status: "draft", external_inventory_item_id: ITEM_NEW, supersedes_mapping_id: mappingA },
    ]);
    expect(await readStockLinkHead(database.pool, targetId, 101)).toMatchObject({ active_mapping_id: null, draft_mapping_id: saved.definitionId });
    expect((await database.pool.query(`SELECT changes->'before' AS before FROM public.audit_events
      WHERE action='inventory_availability.publication_variant_mapping.draft_saved'`)).rows).toEqual([{ before: null }]);
  }, CASE_TIMEOUT_MS);

  it("lets the engine link a size again after a retire-only and enqueues the new item (PG 5)", async () => {
    await retireOnly(101);
    const result = await change({ commandKey: "0b5f2c1e-8d1a-5a3e-9f00-000000000005", retire: [], links: [{ productVariantId: 101, itemId: ITEM_NEW, sku: "P5" }] });
    expect(result.retired).toEqual([]);
    expect(result.preparation).toMatchObject({ publicationTargetId: targetId, changedProductVariantIds: [101], publicationRows: 1 });
    const [, linked] = await versions(101);
    expect(linked).toMatchObject({ version: 2, lifecycle_status: "sealed", external_inventory_item_id: ITEM_NEW, supersedes_mapping_id: mappingA });
    expect(await readStockLinkHead(database.pool, targetId, 101)).toMatchObject({ active_mapping_id: linked!.id, draft_mapping_id: null });
    expect((await outbox(101)).map(row => [row.external_inventory_item_id_snapshot, row.state])).toEqual([[ITEM_NEW, "queued"]]);
  }, CASE_TIMEOUT_MS);

  it("refuses a new version whose history is not a retired link, with the typed code (PG 5)", async () => {
    // A head without an active version over a still-sealed version: no writer leaves this; the draft writer must not guess.
    await database.pool.query(`UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=NULL,revision=revision+1,
      updated_by='operator',update_reason='Fixture broken history' WHERE publication_target_id=$1 AND product_variant_id=101`, [targetId]);
    const head = (await readStockLinkHead(database.pool, targetId, 101))!;
    const store = new PostgresInventoryChannelExposureAdminStore(drizzle(database.pool) as never);
    await expect(store.saveVariantMappingDraft({ publicationTargetId: targetId, productVariantId: 101, externalInventoryItemId: ITEM_NEW,
      externalSku: "P5", expectedHeadRevision: head.revision, expectedDraftMappingId: null, expectedDraftDefinitionHash: null,
      changeReason: "Operator saved the new store item.", idempotencyKey: "manual-broken-history", requestHash: sha("manual-broken-history"),
      actorId: "operator-1", occurredAt: P3_NOW })).rejects.toMatchObject({ status: 409,
      code: "INVENTORY_PUBLICATION_VARIANT_MAPPING_HISTORY_INVALID" });
    expect(await versions(101)).toHaveLength(1);
  }, CASE_TIMEOUT_MS);

  it("swaps two sizes' store items inside one product in one transaction: retire first, then link (B1)", async () => {
    await addShopifyFeed(database.pool, 102, ITEM_B, { sku: "NEW" });
    const mappingB = await sealStockLink(database.pool, targetId, 102, ITEM_B, { sku: "NEW" });
    await publish([101, 102]);
    await database.pool.query("UPDATE channels.channel_feeds SET channel_inventory_item_id=CASE product_variant_id WHEN 101 THEN $1 ELSE $2 END WHERE channel_id=$3",
      [ITEM_B, ITEM_A, STOCK_LINK_SHOPIFY.channelId]);
    const result = await change({ commandKey: "0b5f2c1e-8d1a-5a3e-9f00-000000000014", retire: [101, 102],
      links: [{ productVariantId: 101, itemId: ITEM_B, sku: "P5" }, { productVariantId: 102, itemId: ITEM_A, sku: "NEW" }] });
    expect(result.retired.map(row => [row.productVariantId, row.externalInventoryItemId])).toEqual([[101, ITEM_A], [102, ITEM_B]]);
    expect((await versions(101)).map(row => [row.lifecycle_status, row.external_inventory_item_id, row.supersedes_mapping_id]))
      .toEqual([["retired", ITEM_A, null], ["sealed", ITEM_B, mappingA]]);
    expect((await versions(102)).map(row => [row.lifecycle_status, row.external_inventory_item_id, row.supersedes_mapping_id]))
      .toEqual([["retired", ITEM_B, null], ["sealed", ITEM_A, mappingB]]);
    expect((await outbox(101)).map(row => [row.external_inventory_item_id_snapshot, row.state, row.last_error_class]))
      .toEqual([[ITEM_A, "superseded", "PUBLICATION_IDENTITY_RETIRED"], [ITEM_B, "queued", null]]);
    expect((await outbox(102)).map(row => [row.external_inventory_item_id_snapshot, row.state, row.last_error_class]))
      .toEqual([[ITEM_B, "superseded", "PUBLICATION_IDENTITY_RETIRED"], [ITEM_A, "queued", null]]);
  }, CASE_TIMEOUT_MS);

  it("restarts a stopped Shopify store after a relink: the old item's history is covered by its retired link (PG 11)", async () => {
    await publish([101]);
    await database.pool.query("UPDATE channels.channel_feeds SET channel_inventory_item_id=$1 WHERE channel_id=$2 AND product_variant_id=101",
      [ITEM_NEW, STOCK_LINK_SHOPIFY.channelId]);
    await change({ commandKey: "0b5f2c1e-8d1a-5a3e-9f00-000000000011", retire: [101], links: [{ productVariantId: 101, itemId: ITEM_NEW, sku: "P5" }] });
    await stop();
    const restarted = await enable();
    expect(restarted).toMatchObject({ state: "live", publicationRows: 1 });
    expect((await outbox(101)).map(row => [row.external_inventory_item_id_snapshot, row.state])).toEqual([
      [ITEM_A, "superseded"], [ITEM_NEW, "superseded"], [ITEM_NEW, "queued"]]);
  }, CASE_TIMEOUT_MS);

  it("restarts a stopped Shopify store after a retire-only while a linked size keeps it live (PG 11, N1)", async () => {
    await addShopifyFeed(database.pool, 102, ITEM_B, { sku: "NEW" });
    await sealStockLink(database.pool, targetId, 102, ITEM_B, { sku: "NEW" });
    await publish([101, 102]);
    await retireOnly(101);
    await stop();
    const restarted = await enable();
    expect(restarted).toMatchObject({ state: "live", publicationRows: 1 });
    expect((await outbox(101)).map(row => row.state)).toEqual(["superseded"]);
    expect((await outbox(102)).map(row => [row.external_inventory_item_id_snapshot, row.state])).toEqual([[ITEM_B, "superseded"], [ITEM_B, "queued"]]);
    expect((await database.pool.query(`SELECT context->'withheldUnlinkedVariantIds' AS withheld FROM public.audit_events
      WHERE action='inventory_availability.publication_target.enabled'`)).rows).toEqual([{ withheld: [101] }]);
  }, CASE_TIMEOUT_MS);

  it("restarts a stopped Shopify store whose product has one linked and one unlinked selected size; only the linked one is sent (PG 12)", async () => {
    await addShopifyFeed(database.pool, 102, ITEM_B, { sku: "NEW" });
    await stop();
    const restarted = await enable();
    expect(restarted).toMatchObject({ state: "live", publicationRows: 1 });
    expect((await outbox(101)).map(row => [row.external_inventory_item_id_snapshot, row.state])).toEqual([[ITEM_A, "queued"]]);
    expect(await outbox(102)).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("keeps refusing a Shopify restart when no required size is linked: the destination never goes live (PG 12)", async () => {
    await retireOnly(101);
    await stop();
    await expect(enable()).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_STOCK_NOT_READY" });
    expect(await target()).toMatchObject({ state: "disabled" });
    expect(await outbox(101)).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("keeps refusing a Shopify restart when an unlinked size has another blocker too (PG 12)", async () => {
    // The unlinked sibling's feed is quarantined: a selection blocker besides the missing link, so nothing is withheld.
    await addShopifyFeed(database.pool, 102, ITEM_B, { sku: "NEW", quarantined: true });
    await stop();
    await expect(enable()).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_STOCK_NOT_READY" });
    expect(await target()).toMatchObject({ state: "disabled" });
    expect(await outbox(101)).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("keeps a Walmart restart with one unlinked selected size refusing exactly as before N1 (PG 12)", async () => {
    // The fixture's Walmart destination 2 (channel 36): 101 is linked by its SKU, 102 is selected but not linked.
    await sealStockLink(database.pool, 2, 101, "P5", { sku: "P5" });
    await database.pool.query(`INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id,is_active)
      VALUES(36,102,'NEW','NEW',1)`);
    await new InventoryPublicationTargetStopService(new PostgresInventoryPublicationTargetStopStore(database.pool), { now: () => P3_NOW })
      .stop({ publicationTargetId: 2, expectedRevision: (await target(2)).revision, idempotencyKey: "stop-walmart" }, "operator-1");
    await expect(enable(2)).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_STOCK_NOT_READY" });
    expect(await target(2)).toMatchObject({ state: "disabled" });
    expect(await outbox(101, 2)).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("stops a stale SERIALIZABLE publisher's old-item row at the worker after a retire-only: no store call (PG 19, N5)", async () => {
    await publish([101]);
    await nextDue();
    const store = stubStore();
    expect(await store.service.processDue()).toMatchObject({ claimed: 1, verified: 1 });
    expect(store.adapter.publishAbsolute).toHaveBeenCalledTimes(1);
    await sellFiveUnits();
    const stale = await database.pool.connect();
    try {
      await stale.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      // The publisher's snapshot is taken here, before the engine's retire commits.
      await stale.query("SELECT count(*) FROM inventory.publication_variant_mapping_heads");
      await retireOnly(101);
      const routed = await createTransactionScopedInventoryPublicationService(stale, { logger: quiet }).publishProduct({
        productId: 20, publicationTargetId: targetId, productVariantIds: [101], dryRun: false, triggeredBy: "stale_serializable_publisher" },
      async () => null);
      expect(routed.authority === "canonical" && routed.publication.enqueuedRows).toBe(1);
      await stale.query("COMMIT");
    } catch (error) {
      await stale.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      stale.release();
    }
    // Postgres serializability did not save us: the old item's row is queued after the retire committed.
    expect((await outbox(101)).map(row => [row.desired_quantity, row.external_inventory_item_id_snapshot, row.state]))
      .toEqual([["17", ITEM_A, "verified"], ["12", ITEM_A, "queued"]]);
    await nextDue();
    expect(await store.service.processDue()).toMatchObject({ claimed: 1, verified: 0, superseded: 1 });
    expect(store.adapter.publishAbsolute).toHaveBeenCalledTimes(1);
    const [, staleRow] = await outbox(101);
    expect(staleRow).toMatchObject({ state: "superseded", last_error_class: "PUBLICATION_IDENTITY_RETIRED" });
    expect((await database.pool.query("SELECT outcome,error_class FROM inventory.inventory_publication_attempts WHERE outbox_id=$1",
      [staleRow!.id])).rows).toEqual([{ outcome: "superseded", error_class: "PUBLICATION_IDENTITY_RETIRED" }]);
  }, CASE_TIMEOUT_MS);

  it("stops counting a refused item on Ops Health once the engine retired it, and counts it again after a relink until the store accepts (PG 27, N9)", async () => {
    await publish([101]);
    await nextDue();
    const refusing = stubStore([ITEM_A]);
    expect(await refusing.service.processDue()).toMatchObject({ claimed: 1, failed: 1 });
    expect((await outbox(101)).map(row => row.state)).toEqual(["dead_letter"]);
    expect(await deadLetterCount()).toBe(1);

    await retireOnly(101);
    expect(await deadLetterCount()).toBe(0);

    // Linked to a new item: the old refusal counts again until an update of this size reaches the store.
    await change({ commandKey: "0b5f2c1e-8d1a-5a3e-9f00-000000000027", retire: [], links: [{ productVariantId: 101, itemId: ITEM_NEW, sku: "P5" }] });
    expect(await deadLetterCount()).toBe(1);
    await nextDue();
    expect(await refusing.service.processDue()).toMatchObject({ claimed: 1, verified: 1 });
    expect(await deadLetterCount()).toBe(0);
  }, CASE_TIMEOUT_MS);

  it("keeps counting a refused item whose link someone other than the engine retired (PG 27, N9)", async () => {
    await publish([101]);
    await nextDue();
    expect(await stubStore([ITEM_A]).service.processDue()).toMatchObject({ claimed: 1, failed: 1 });
    await inStockLinkTransaction(database.pool, async client => {
      await client.query(`UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=NULL,revision=revision+1,
        updated_by='operator',update_reason='Operator retire' WHERE publication_target_id=$1 AND product_variant_id=101`, [targetId]);
      await client.query(`UPDATE inventory.publication_variant_mapping_versions SET lifecycle_status='retired',retired_by='operator-1',
        retired_at=GREATEST($2::timestamptz,sealed_at) WHERE id=$1`, [mappingA, AT]);
    });
    expect(await deadLetterCount()).toBe(1);
  }, CASE_TIMEOUT_MS);
});

// P4 (PLAN-CH2 v4.1 §12): one stock-link command end to end (runStockLinkCommand with the Shopify policy) over real
// PostgreSQL. A test plans each command with the engine's own pure decision (planStockLinkBatch) from the database's
// current facts and a stand-in store (the tick's provider reads, P7), claims the sizes' check rows as the tick does, and
// runs the command; the source is the test-only fixture source (P6 builds the Channels one).
type QueryHook = (query: { text: string; values: readonly unknown[] }, run: (text: string, values?: unknown[]) => Promise<unknown>) =>
  Promise<void> | void;

/** A pool whose connections call `before`/`after` around every statement (scheduling and fault injection only; the
 * statements themselves are never altered). */
function hookedPool(pool: Pool, hooks: { before?: QueryHook; after?: QueryHook }): Pool {
  return new Proxy(pool, { get(target, key) {
    if (key === "connect") return async () => {
      const connected = await target.connect();
      const raw = connected.query.bind(connected) as (...args: unknown[]) => Promise<unknown>;
      const run = (text: string, values: unknown[] = []) => raw(text, values);
      return new Proxy(connected, { get(connection, field) {
        if (field === "query") return async (...args: unknown[]) => {
          const first = args[0] as string | { text?: string; values?: unknown[] };
          const query = typeof first === "string" ? { text: first, values: (args[1] as unknown[] | undefined) ?? [] }
            : { text: first?.text ?? "", values: first?.values ?? (args[1] as unknown[] | undefined) ?? [] };
          await hooks.before?.(query, run);
          const result = await raw(...args);
          await hooks.after?.(query, run);
          return result;
        };
        const value = Reflect.get(connection, field);
        return typeof value === "function" ? value.bind(connection) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as Pool;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const P4_NOW = new Date(AT);
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(P4_NOW.getTime() + ms);
const storeItem = (itemId: string, sku: string | null, productStatus = "ACTIVE"): StockLinkStoreItem =>
  ({ itemId, sku, productId: "9001", productStatus });

dbDescribe.sequential("stock-link command, real PostgreSQL (P4: PG 2-4, 7-9, 13, 14, 20-24, 26)", () => {
  let database: InventoryCutoverTestDatabase;
  let targetId: number;
  /** The Shopify store as the tick read it. */
  let store: Map<string, StockLinkStoreItem>;
  let auditBaseline: number;
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(async () => {
    database = await createStockLinkDatabase();
    await installStockLinkConnectionColumns(database.pool);
    await addShopifyFeed(database.pool, 101, ITEM_A, { sku: "P5" });
    targetId = await createLiveShopifyTarget(database.pool);
    await seedStockLinkDestination(database.pool, targetId, AT);
    store = new Map([[ITEM_A, storeItem(ITEM_A, "P5")]]);
    auditBaseline = Number((await database.pool.query("SELECT COALESCE(max(id),0) AS id FROM public.audit_events")).rows[0].id);
    for (const fn of Object.values(log)) fn.mockReset();
  }, CASE_TIMEOUT_MS);
  afterEach(async () => {
    vi.restoreAllMocks();
    await database?.close();
  });

  const target = async () => (await database.pool.query<{ revision: string }>(
    "SELECT revision::text FROM inventory.inventory_publication_targets WHERE id=$1", [targetId])).rows[0]!;
  const destination = async (): Promise<StockLinkDestination> => ({ publicationTargetId: targetId, destinationKind: "channel_connection",
    providerKey: "shopify", channelId: STOCK_LINK_SHOPIFY.channelId, channelConnectionId: STOCK_LINK_SHOPIFY.connectionId,
    dropshipStoreConnectionId: null, providerScopeType: "location", externalScopeId: STOCK_LINK_SHOPIFY.location,
    targetRevision: (await target()).revision });
  /** The Channels source of Shopify destinations (P6): its fingerprint is the one the adapter's reads carry. */
  const shopifySource = createShopifyStockLinkSource();
  const fingerprint = async () => shopifySource.readFingerprint(database.pool, await destination());

  /** The engine's decision for these sizes from the database as it is now and the stand-in store (§4.2). */
  const plan = async (variantIds: number[]): Promise<StockLinkBatchPlan> => {
    const pool = database.pool;
    const heads = (await pool.query<{ product_variant_id: number; revision: string; active_mapping_id: number | null; active_item: string | null;
      active_sku: string | null; draft_mapping_id: number | null; draft_item: string | null; draft_sku: string | null; draft_hash: string | null }>(
      `SELECT h.product_variant_id, h.revision::text, h.active_mapping_id, a.external_inventory_item_id AS active_item, a.external_sku AS active_sku,
         h.draft_mapping_id, d.external_inventory_item_id AS draft_item, d.external_sku AS draft_sku, d.definition_hash AS draft_hash
       FROM inventory.publication_variant_mapping_heads h
       LEFT JOIN inventory.publication_variant_mapping_versions a ON a.id=h.active_mapping_id
       LEFT JOIN inventory.publication_variant_mapping_versions d ON d.id=h.draft_mapping_id
       WHERE h.publication_target_id=$1`, [targetId])).rows;
    const sizes: StockLinkSizeFacts[] = [];
    for (const variantId of variantIds) {
      const row = (await pool.query<{ product_id: number; sku: string | null; hint: string | null; observed_sku: string | null }>(
        `SELECT v.product_id, COALESCE(o.sku_override, v.sku) AS sku, f.channel_inventory_item_id AS hint, c.observed_sku
         FROM catalog.product_variants v
         LEFT JOIN channels.channel_variant_overrides o ON o.channel_id=$2 AND o.product_variant_id=v.id
         LEFT JOIN channels.channel_feeds f ON f.channel_id=$2 AND f.product_variant_id=v.id
         LEFT JOIN inventory.stock_link_checks c ON c.publication_target_id=$3 AND c.product_variant_id=v.id
         WHERE v.id=$1`, [variantId, STOCK_LINK_SHOPIFY.channelId, targetId])).rows[0]!;
      const selection = (await readPublicationStockSelection(pool, { destinationKind: "channel_connection",
        channelId: STOCK_LINK_SHOPIFY.channelId, channelConnectionId: STOCK_LINK_SHOPIFY.connectionId, dropshipStoreConnectionId: null },
      { productId: row.product_id, productVariantIds: [variantId] })).variants[0]!;
      const head = heads.find(candidate => candidate.product_variant_id === variantId);
      sizes.push({ productVariantId: variantId, productId: row.product_id, cardShellzSku: row.sku,
        selection: { action: selection.action, blockerCodes: selection.blockers.map(blocker => blocker.code) },
        head: head ? { revision: head.revision,
          active: head.active_mapping_id === null ? null : { mappingId: head.active_mapping_id, itemId: head.active_item!, externalSku: head.active_sku },
          draft: head.draft_mapping_id === null ? null : { mappingId: head.draft_mapping_id, itemId: head.draft_item!, externalSku: head.draft_sku,
            definitionHash: head.draft_hash! } } : null,
        observedSku: row.observed_sku, feedHintItemId: row.hint });
    }
    const keys = new Set(sizes.map(size => normalizeStockLinkSku(size.cardShellzSku)).flatMap(sku => sku.kind === "sku" ? [sku.key] : []));
    const observed = new Set([...heads.flatMap(head => [head.active_item]), ...sizes.map(size => size.feedHintItemId)]
      .map(id => normalizeShopifyItemId(id)).filter((id): id is string => id !== null));
    return planStockLinkBatch({ sizes, carriedSkus: sizes.map(size => ({ productVariantId: size.productVariantId, sku: size.cardShellzSku })),
      destinationHeads: heads.map(head => ({ productVariantId: head.product_variant_id, activeItemId: head.active_item, draftItemId: head.draft_item })),
      reads: { lookedUpSkus: sizes.flatMap(size => normalizeStockLinkSku(size.cardShellzSku).kind === "sku" ? [size.cardShellzSku!.trim()] : []),
        lookupItems: [...store.values()].filter(item => { const sku = normalizeStockLinkSku(item.sku); return sku.kind === "sku" && keys.has(sku.key); }),
        observations: [...observed].map(itemId => ({ itemId, item: store.get(itemId) ?? null })), controlReadDone: true },
      recentRetireCount: 0 });
  };
  const onlyCommand = async (variantIds: number[]): Promise<StockLinkCommandPlan> => {
    const planned = await plan(variantIds);
    expect(planned.commands).toHaveLength(1);
    return planned.commands[0]!;
  };
  const claimAll = (command: StockLinkCommandPlan) => Promise.all(command.members.map(member =>
    claimStockLinkCheck(database.pool, targetId, member.productVariantId, AT)));
  const run = async (command: StockLinkCommandPlan, options: { pool?: Pool; claims?: StockLinkCheckClaim[]; random?: () => number } = {}):
    Promise<StockLinkCommandResult> => runShopifyStockLinkCommand(options.pool ?? database.pool, {
    destination: await destination(), command, claims: options.claims ?? await claimAll(command),
    evidence: { observedAt: AT, readFingerprint: await fingerprint() },
  }, { source: shopifySource, clock: () => P4_NOW, monotonicNow: () => 0, random: options.random ?? (() => 0), logger: log });

  const versions = async (productVariantId: number) => (await database.pool.query<{ id: number; version: number; lifecycle_status: string;
    external_inventory_item_id: string; external_sku: string | null; supersedes_mapping_id: number | null; retired_by: string | null }>(
    `SELECT id, version, lifecycle_status, external_inventory_item_id, external_sku, supersedes_mapping_id, retired_by
     FROM inventory.publication_variant_mapping_versions WHERE publication_target_id=$1 AND product_variant_id=$2 ORDER BY version`,
  [targetId, productVariantId])).rows;
  const outbox = async (productVariantId: number) => (await database.pool.query<{ item: string; state: string; quantity: string; error: string | null }>(
    `SELECT external_inventory_item_id_snapshot AS item, state, desired_quantity::text AS quantity, last_error_class AS error
     FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1 AND product_variant_id=$2 ORDER BY desired_revision`,
  [targetId, productVariantId])).rows.map(row => [row.item, row.state, row.quantity, row.error]);
  const auditActions = async () => (await database.pool.query<{ action: string }>(
    "SELECT action FROM public.audit_events WHERE id > $1 ORDER BY id", [auditBaseline])).rows.map(row => row.action);
  const receipts = async () => (await database.pool.query<{ key: string }>(
    "SELECT key FROM public.idempotency_keys WHERE key LIKE 'stock-link:%' ORDER BY key")).rows.map(row => row.key);
  const nothingWritten = async (productVariantIds: number[]) => {
    for (const variantId of productVariantIds) {
      expect(await outbox(variantId)).toEqual([]);
    }
    expect(await auditActions()).toEqual([]);
    expect(await receipts()).toEqual([]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.publication_mapping_preparations")).rows[0].n).toBe(0);
  };
  const publish = async (productVariantIds: number[], productId = 20) => {
    const routed = await createAuthorityAwareInventoryPublicationService(database.pool, { logger: quiet }).publishProduct({
      productId, publicationTargetId: targetId, productVariantIds, dryRun: false, triggeredBy: "stock_link_p4_test" }, async () => null);
    expect(routed.authority).toBe("canonical");
  };
  const scopeKey = (itemId: string) => quantityPublicationScopeLockKey({ destinationKind: "channel_connection",
    connectionId: STOCK_LINK_SHOPIFY.connectionId, providerKey: "shopify", providerScopeType: "location",
    externalScopeId: STOCK_LINK_SHOPIFY.location, externalInventoryItemId: itemId, productId: null, productVariantId: null });
  /** Another session holding a lock (advisory, or a row lock in its open transaction) for the duration of `work`. */
  const whileHeld = async <T>(statements: Array<[string, unknown[]]>, work: () => Promise<T>): Promise<T> => {
    const holder = await database.pool.connect();
    try {
      for (const [sql, values] of statements) await holder.query(sql, values);
      return await work();
    } finally {
      await holder.query("ROLLBACK");
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
  };
  const waitForLockWaiter = async () => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const waiting = (await database.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'`)).rows[0]!.n;
      if (waiting > 0) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("No session waited on a lock.");
  };
  /** Product 21 with one size (201, OTHER-PACK) on the store, as the eBay readiness suite builds a second product. */
  const addSecondProduct = async () => {
    await database.pool.query(`BEGIN;
      INSERT INTO catalog.products(id,sku) VALUES(21,'OTHER');
      INSERT INTO catalog.product_variants(id,product_id,sku,is_active) VALUES(201,21,'OTHER-PACK',true);
      INSERT INTO inventory.inventory_levels(id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty)
        VALUES(11,100,201,7,0,0,0);
      INSERT INTO inventory.transformation_model_versions(product_id,version,build_to_promise_enabled,definition_hash,validation_state,validation_errors,change_reason,idempotency_key,request_hash,created_by)
        VALUES(21,1,false,repeat('c',64),'valid','[]','Other product model','other-product-model',repeat('c',64),'operator');
      INSERT INTO inventory.transformation_model_heads(product_id,draft_model_id,revision,updated_by,update_reason)
        SELECT 21,id,0,'operator','Other product model' FROM inventory.transformation_model_versions WHERE product_id=21;
      UPDATE inventory.transformation_model_versions SET lifecycle_status='sealed',sealed_by='operator',sealed_at=transaction_timestamp() WHERE product_id=21;
      UPDATE inventory.transformation_model_heads SET active_model_id=draft_model_id,draft_model_id=NULL,revision=revision+1 WHERE product_id=21;
      COMMIT;`);
  };

  it("links a size's first store item in one commit with its stock row, audit trail, receipt and check row (PG 2)", async () => {
    const command = await onlyCommand([101]);
    expect(command.members).toMatchObject([{ productVariantId: 101, change: "link", rule: "L10",
      link: { itemId: ITEM_A, storeSku: "P5", mappingAction: "create" } }]);
    const [claim] = await claimAll(command);
    const result = await run(command, { claims: [claim!] });

    expect(result).toMatchObject({ status: "applied", action: "linked", cleanupUncertain: false,
      preparation: { publicationTargetId: targetId, changedProductVariantIds: [101], publicationRows: 1, appliedBy: STOCK_LINK_ACTOR } });
    expect(await versions(101)).toMatchObject([{ version: 1, lifecycle_status: "sealed", external_inventory_item_id: ITEM_A, external_sku: "P5" }]);
    expect(await outbox(101)).toEqual([[ITEM_A, "queued", "17", null]]);
    expect(await auditActions()).toEqual(expect.arrayContaining(["inventory_availability.publication_variant_mapping.draft_saved",
      "inventory_availability.listing_mapping.prepared", "inventory_availability.stock_link.linked"]));
    expect(await receipts()).toEqual([`stock-link:${result.commandKey}`]);
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "linked", reason_code: null, error_class: null,
      attempt_count: 0, busy_since: null, lease_token: null, next_check_at: at(DAY_MS), revision: String(BigInt(claim!.revision) + BigInt(1)) });
    // One commit: every row the command wrote carries the same transaction id.
    const writers = (await database.pool.query<{ x: string }>(`
      SELECT xmin::text AS x FROM inventory.publication_variant_mapping_versions WHERE publication_target_id=$1
      UNION SELECT xmin::text FROM inventory.publication_variant_mapping_heads WHERE publication_target_id=$1
      UNION SELECT xmin::text FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1
      UNION SELECT xmin::text FROM inventory.publication_mapping_preparations
      UNION SELECT xmin::text FROM public.audit_events WHERE id > $2
      UNION SELECT xmin::text FROM public.idempotency_keys WHERE key LIKE '%stock-link:%'
      UNION SELECT xmin::text FROM inventory.stock_link_checks WHERE publication_target_id=$1`, [targetId, auditBaseline])).rows;
    expect(writers).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith("inventory_availability.stock_link.command", expect.objectContaining({ outcome: "linked",
      publication_target_id: targetId, product_variant_ids: [101], command_key: result.commandKey }));
  }, CASE_TIMEOUT_MS);

  it("rolls everything back when a step after the link fails, and releases the size busy without an attempt (PG 2)", async () => {
    const command = await onlyCommand([101]);
    const faulting = hookedPool(database.pool, { before: query => {
      if (query.text.includes("INSERT INTO public.audit_events") && String(query.values[2]).startsWith("inventory_availability.stock_link."))
        throw Object.assign(new Error("forced failure after step 8"), { code: "40001" });
    } });
    const result = await run(command, { pool: faulting, random: () => 0.5 });

    expect(result).toMatchObject({ status: "failed", recordedProductVariantIds: [101],
      failure: { kind: "busy", code: "STOCK_MAPPING_CONCURRENT_CHANGE", countsAttempt: false } });
    expect(await versions(101)).toEqual([]);
    expect(await readStockLinkHead(database.pool, targetId, 101)).toBeNull();
    await nothingWritten([101]);
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "waiting", attempt_count: 0,
      busy_since: P4_NOW, first_failure_at: null, lease_token: null, reason_code: "STOCK_MAPPING_CONCURRENT_CHANGE",
      error_class: "transient", next_check_at: at(60_000 + Math.floor(0.5 * 120_001)) });
  }, CASE_TIMEOUT_MS);

  it("links a removed size (zero) for a clearing update: a 0 row (PG 3)", async () => {
    await database.pool.query("UPDATE channels.channel_feeds SET is_active=0 WHERE channel_id=$1 AND product_variant_id=101", [STOCK_LINK_SHOPIFY.channelId]);
    const command = await onlyCommand([101]);
    expect(command).toMatchObject({ purpose: "sync", members: [{ selectionAction: "zero", change: "link" }] });
    expect(await run(command)).toMatchObject({ status: "applied", action: "linked", preparation: { publicationRows: 1 } });
    expect(await outbox(101)).toEqual([[ITEM_A, "queued", "0", null]]);
  }, CASE_TIMEOUT_MS);

  it("relinks to the store's new item with the same quantity: new row, old row superseded, old version retired (PG 4)", async () => {
    const mappingA = await sealStockLink(database.pool, targetId, 101, ITEM_A, { sku: "P5" });
    await publish([101]);
    store = new Map([[ITEM_NEW, storeItem(ITEM_NEW, "P5")]]);
    const command = await onlyCommand([101]);
    expect(command.members).toMatchObject([{ change: "relink", rule: "V2/L10", replacesMappingId: mappingA, link: { itemId: ITEM_NEW } }]);
    expect(await run(command)).toMatchObject({ status: "applied", action: "relinked", retiredMappingIds: [mappingA] });
    expect(await outbox(101)).toEqual([[ITEM_A, "superseded", "17", "PUBLICATION_IDENTITY_RETIRED"], [ITEM_NEW, "queued", "17", null]]);
    expect((await versions(101)).map(row => [row.lifecycle_status, row.external_inventory_item_id, row.retired_by, row.supersedes_mapping_id]))
      .toEqual([["retired", ITEM_A, STOCK_LINK_ACTOR, null], ["sealed", ITEM_NEW, null, mappingA]]);
    expect(await auditActions()).toContain("inventory_availability.stock_link.relinked");
  }, CASE_TIMEOUT_MS);

  it("stays busy while a provider request holds the new item's scope key: nothing written, no attempt (PG 7)", async () => {
    const command = await onlyCommand([101]);
    const result = await whileHeld([["SELECT pg_advisory_lock(hashtextextended($1,$2))", [scopeKey(ITEM_A), PUBLICATION_TARGET_SCOPE_LOCK_SEED]]],
      () => run(command));
    expect(result).toMatchObject({ status: "failed", failure: { kind: "busy", code: "STOCK_LINK_SCOPE_BUSY" }, recordedProductVariantIds: [101] });
    expect(await versions(101)).toEqual([]);
    await nothingWritten([101]);
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ attempt_count: 0, busy_since: P4_NOW, lease_token: null,
      reason_code: "STOCK_LINK_SCOPE_BUSY", status: "waiting" });
  }, CASE_TIMEOUT_MS);

  it("stays busy without waiting while the size's pair is locked, for a first link and a relink (PG 8)", async () => {
    const holdPair = <T>(work: () => Promise<T>) => whileHeld([["SELECT pg_advisory_lock($1,$2)", [targetId, 101]]], work);
    const first = await onlyCommand([101]);
    const started = Date.now();
    expect(await holdPair(() => run(first))).toMatchObject({ status: "failed", failure: { kind: "busy", code: "STOCK_LINK_PAIR_BUSY" } });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(await versions(101)).toEqual([]);
    await nothingWritten([101]);

    const mappingA = await sealStockLink(database.pool, targetId, 101, ITEM_A, { sku: "P5" });
    store = new Map([[ITEM_NEW, storeItem(ITEM_NEW, "P5")]]);
    const relink = await onlyCommand([101]);
    expect(relink.members).toMatchObject([{ change: "relink" }]);
    expect(await holdPair(() => run(relink))).toMatchObject({ status: "failed", failure: { kind: "busy", code: "STOCK_LINK_PAIR_BUSY" } });
    expect(await versions(101)).toMatchObject([{ id: mappingA, lifecycle_status: "sealed" }]);
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ attempt_count: 0, busy_since: P4_NOW });
  }, CASE_TIMEOUT_MS);

  describe("a manual draft save at the same moment never deadlocks with the engine (PG 9, N3)", () => {
    const deadlocks = async () => Number((await database.pool.query<{ n: string }>(
      "SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname=current_database()")).rows[0]!.n);
    /** Both sides on their own connections, closed afterwards so their statistics are flushed; the delta is read after. */
    const sides = () => ({ engine: new pg.Pool({ connectionString: database.connectionString, max: 3 }),
      manual: new pg.Pool({ connectionString: database.connectionString, max: 2 }) });
    const deadlockDelta = async (before: number) => {
      let delta = 0;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await database.pool.query("SELECT pg_stat_clear_snapshot()");
        delta = (await deadlocks()) - before;
        if (delta > 0) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return delta;
    };
    const manualSave = async (pool: Pool, revision: string) => new PostgresInventoryChannelExposureAdminStore(drizzle(pool) as never)
      .saveVariantMappingDraft({ publicationTargetId: targetId, productVariantId: 101, externalInventoryItemId: "444", externalSku: "P5",
        expectedHeadRevision: revision, expectedDraftMappingId: null, expectedDraftDefinitionHash: null,
        changeReason: "Operator saved another store item.", idempotencyKey: `manual-${revision}`, requestHash: sha(`manual-${revision}`),
        actorId: "operator-1", occurredAt: P4_NOW });
    const settle = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }));

    beforeEach(async () => {
      await sealStockLink(database.pool, targetId, 101, ITEM_A, { sku: "P5" });
      store = new Map([[ITEM_NEW, storeItem(ITEM_NEW, "P5")]]);
    });

    it("(a) engine paused after its heads FOR UPDATE while a manual save starts: the save waits, then finds the link changed", async () => {
      const command = await onlyCommand([101]);
      const revision = (await readStockLinkHead(database.pool, targetId, 101))!.revision;
      const before = await deadlocks();
      const pools = sides();
      const reached = gate(), resume = gate();
      const engine = hookedPool(pools.engine, { after: async query => {
        if (query.text === STOCK_LINK_HEADS_FOR_UPDATE_SQL) { reached.release(); await resume.promise; }
      } });
      let results: Array<{ value: unknown; error: unknown }>;
      try {
        const engineRun = settle(run(command, { pool: engine }));
        await reached.promise;
        const manualRun = settle(manualSave(pools.manual, revision));
        await waitForLockWaiter();
        resume.release();
        results = await Promise.all([engineRun, manualRun]);
      } finally {
        resume.release();
        await pools.engine.end();
        await pools.manual.end();
      }
      expect(await deadlockDelta(before)).toBe(0);
      const [engineResult, manualResult] = results;
      expect(engineResult!.value).toMatchObject({ status: "applied", action: "relinked" });
      expect(manualResult!.error).toMatchObject({ code: "INVENTORY_CHANNEL_EXPOSURE_STALE_VARIANT_MAPPING" });
      expect((await versions(101)).map(row => row.external_inventory_item_id)).toEqual([ITEM_A, ITEM_NEW]);
    }, CASE_TIMEOUT_MS);

    it("(b) manual save paused after the draft writer's lock while the engine runs: the engine waits, the save meets the fence", async () => {
      const command = await onlyCommand([101]);
      const revision = (await readStockLinkHead(database.pool, targetId, 101))!.revision;
      const before = await deadlocks();
      const pools = sides();
      const reached = gate(), resume = gate();
      const manual = hookedPool(pools.manual, { after: async query => {
        if (query.text.includes("pg_advisory_xact_lock($1, $2)") && Number(query.values[0]) === 918428) {
          reached.release(); await resume.promise;
        }
      } });
      let results: Array<{ value: unknown; error: unknown }>;
      try {
        const manualRun = settle(manualSave(manual, revision));
        await reached.promise;
        const engineRun = settle(run(command, { pool: pools.engine }));
        await waitForLockWaiter();
        resume.release();
        results = await Promise.all([engineRun, manualRun]);
      } finally {
        resume.release();
        await pools.engine.end();
        await pools.manual.end();
      }
      expect(await deadlockDelta(before)).toBe(0);
      const [engineResult, manualResult] = results;
      // The engine holds the cutover fence exclusively; the manual save's first mapping write meets it (NOWAIT).
      expect(manualResult!.error).toMatchObject({ code: "55P03" });
      expect(engineResult!.value).toMatchObject({ status: "applied", action: "relinked" });
      expect((await versions(101)).map(row => row.external_inventory_item_id)).toEqual([ITEM_A, ITEM_NEW]);
    }, CASE_TIMEOUT_MS);
  });

  it("replays a command without a second row; the same key with another request is refused (PG 13)", async () => {
    const command = await onlyCommand([101]);
    const first = await run(command);
    expect(first).toMatchObject({ status: "applied" });
    // A sequential replay: the fast path finds the link and settles the row; no fence, nothing else written.
    expect(await run(command)).toMatchObject({ status: "already_linked", commandKey: first.commandKey, recordedProductVariantIds: [101] });
    expect(await outbox(101)).toHaveLength(1);
    expect((await auditActions()).filter(action => action.startsWith("inventory_availability.stock_link."))).toHaveLength(1);

    // A command whose link changed after it applied (here: the engine retired it) never applies again under its key.
    await inStockLinkTransaction(database.pool, async client => {
      const head = (await readStockLinkHead(database.pool, targetId, 101))!;
      await retireStockLinkMappingsInsideTransaction(client, { publicationTargetId: targetId, actor: STOCK_LINK_ACTOR,
        reason: "Store item is gone.", now: P4_NOW, members: [{ productVariantId: 101, mappingId: head.active_mapping_id!,
          expectedHeadRevision: head.revision }] });
    });
    const replay = await run(command);
    expect(replay).toMatchObject({ status: "failed", commandKey: first.commandKey,
      failure: { kind: "permanent", code: "STOCK_MAPPING_LINK_CHANGED_AFTER_APPLY" }, recordedProductVariantIds: [101] });
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "error", next_check_at: null,
      error_class: "permanent", reason_code: "STOCK_MAPPING_LINK_CHANGED_AFTER_APPLY" });
    expect(log.error).toHaveBeenCalledWith("inventory_availability.stock_link.command", expect.objectContaining({ outcome: "error" }));

    // The same key with another request (here: the size became a removed size, so the purpose differs).
    const conflicting: StockLinkCommandPlan = { ...command, purpose: "sync",
      members: command.members.map(member => ({ ...member, selectionAction: "zero" as const })) };
    const conflict = await run(conflicting);
    expect(conflict).toMatchObject({ status: "failed", commandKey: first.commandKey,
      failure: { kind: "permanent", code: "STOCK_MAPPING_COMMAND_CONFLICT" } });
    // Neither refused replay wrote anything: the only row is the first link's, superseded by the retire.
    expect(await outbox(101)).toEqual([[ITEM_A, "superseded", "17", "PUBLICATION_IDENTITY_RETIRED"]]);
    expect(await receipts()).toEqual([`stock-link:${first.commandKey}`]);
  }, CASE_TIMEOUT_MS);

  it("replays a command that waited behind its own first run: the receipt answers, nothing is written twice (PG 13)", async () => {
    const command = await onlyCommand([101]);
    const claims = await claimAll(command);
    const reached = gate(), resume = gate();
    const paused = hookedPool(database.pool, { after: async query => {
      if (query.text === "SELECT pg_advisory_xact_lock(hashtextextended($1,0))") { reached.release(); await resume.promise; }
    } });
    const firstRun = run(command, { pool: paused, claims });
    await reached.promise;
    // The second run passes its fast path (nothing linked yet) and waits for the first one's cutover fence.
    const secondRun = run(command, { claims });
    await waitForLockWaiter();
    resume.release();
    const [first, second] = await Promise.all([firstRun, secondRun]);
    expect(first).toMatchObject({ status: "applied" });
    // The receipt says the command applied; its claim is the first run's (now ended), so the row is not written again.
    expect(second).toMatchObject({ status: "replayed", commandKey: first.commandKey, recordedProductVariantIds: [] });
    expect(await outbox(101)).toHaveLength(1);
    expect(await versions(101)).toHaveLength(1);
    expect((await auditActions()).filter(action => action.startsWith("inventory_availability.stock_link."))).toHaveLength(1);
    expect(await receipts()).toEqual([`stock-link:${first.commandKey}`]);
  }, CASE_TIMEOUT_MS);

  it("swaps two sizes' items inside one product in one command (PG 14)", async () => {
    await addShopifyFeed(database.pool, 102, ITEM_B, { sku: "NEW" });
    const mappingA = await sealStockLink(database.pool, targetId, 101, ITEM_A, { sku: "P5" });
    const mappingB = await sealStockLink(database.pool, targetId, 102, ITEM_B, { sku: "NEW" });
    await publish([101, 102]);
    store = new Map([[ITEM_A, storeItem(ITEM_A, "NEW")], [ITEM_B, storeItem(ITEM_B, "P5")]]);
    const command = await onlyCommand([101, 102]);
    expect(command.members.map(member => [member.productVariantId, member.change, member.link?.itemId, member.replacesMappingId]))
      .toEqual([[101, "relink", ITEM_B, mappingA], [102, "relink", ITEM_A, mappingB]]);
    expect(await run(command)).toMatchObject({ status: "applied", action: "relinked", retiredMappingIds: [mappingA, mappingB] });
    expect((await versions(101)).map(row => [row.lifecycle_status, row.external_inventory_item_id])).toEqual([["retired", ITEM_A], ["sealed", ITEM_B]]);
    expect((await versions(102)).map(row => [row.lifecycle_status, row.external_inventory_item_id])).toEqual([["retired", ITEM_B], ["sealed", ITEM_A]]);
    expect((await outbox(101)).map(row => row.slice(0, 2))).toEqual([[ITEM_A, "superseded"], [ITEM_B, "queued"]]);
    expect((await outbox(102)).map(row => row.slice(0, 2))).toEqual([[ITEM_B, "superseded"], [ITEM_A, "queued"]]);
  }, CASE_TIMEOUT_MS);

  it("swaps items across two products over two ticks: each side retires and waits for the freed item, then links (PG 14)", async () => {
    await addSecondProduct();
    await addShopifyFeed(database.pool, 201, "224", { sku: "OTHER-PACK" });
    await sealStockLink(database.pool, targetId, 101, ITEM_A, { sku: "P5" });
    await sealStockLink(database.pool, targetId, 201, "224", { sku: "OTHER-PACK" });
    store = new Map([[ITEM_A, storeItem(ITEM_A, "OTHER-PACK")], ["224", storeItem("224", "P5")]]);
    const tick1 = await plan([101, 201]);
    expect(tick1.commands.map(command => [command.productId, command.members.map(member => [member.productVariantId, member.change,
      member.code, member.waitingItemId, member.dueNextTick])])).toEqual([
      [20, [[101, "retire", "STOCK_LINK_WAITING_FOR_FREED_ITEM", "224", true]]],
      [21, [[201, "retire", "STOCK_LINK_WAITING_FOR_FREED_ITEM", ITEM_A, true]]],
    ]);
    for (const command of tick1.commands) expect(await run(command)).toMatchObject({ status: "applied", action: "retired" });
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "waiting",
      reason_code: "STOCK_LINK_WAITING_FOR_FREED_ITEM", waiting_item_id: "224", next_check_at: P4_NOW });
    expect(await readStockLinkCheck(database.pool, targetId, 201)).toMatchObject({ waiting_item_id: ITEM_A, next_check_at: P4_NOW });

    const tick2 = await plan([101, 201]);
    expect(tick2.commands.map(command => command.members.map(member => [member.productVariantId, member.change, member.link?.itemId])))
      .toEqual([[[101, "link", "224"]], [[201, "link", ITEM_A]]]);
    for (const command of tick2.commands) expect(await run(command)).toMatchObject({ status: "applied", action: "linked" });
    expect((await versions(101)).map(row => [row.lifecycle_status, row.external_inventory_item_id])).toEqual([["retired", ITEM_A], ["sealed", "224"]]);
    expect((await versions(201)).map(row => [row.lifecycle_status, row.external_inventory_item_id])).toEqual([["retired", "224"], ["sealed", ITEM_A]]);
    expect(await readStockLinkCheck(database.pool, targetId, 201)).toMatchObject({ status: "linked", waiting_item_id: null });
  }, CASE_TIMEOUT_MS);

  it("relinks the same item after a retire with a new command key: no conflict, no LINK_CHANGED_AFTER_APPLY (PG 20)", async () => {
    const link = await onlyCommand([101]);
    const linked = await run(link);
    expect(linked).toMatchObject({ status: "applied", action: "linked" });
    // The store item's SKU is erased: no item carries P5 any more; nothing else is linked, so no control is possible.
    store = new Map([[ITEM_A, storeItem(ITEM_A, "  ")]]);
    const retire = await onlyCommand([101]);
    expect(retire.members).toMatchObject([{ change: "retire", status: "flagged", code: "STOCK_LINK_STORE_SKU_BLANK", rule: "V3/L5" }]);
    expect(await run(retire)).toMatchObject({ status: "applied", action: "retired" });
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "flagged", reason_code: "STOCK_LINK_STORE_SKU_BLANK" });
    expect(log.error).toHaveBeenCalledWith("inventory_availability.stock_link.flagged", expect.objectContaining({ error_code: "STOCK_LINK_STORE_SKU_BLANK" }));
    // The SKU is back on the same item: a new head state, so a new command.
    store = new Map([[ITEM_A, storeItem(ITEM_A, "P5")]]);
    const relink = await onlyCommand([101]);
    expect(relink.members).toMatchObject([{ change: "link", link: { itemId: ITEM_A, mappingAction: "create" } }]);
    const relinked = await run(relink);
    expect(relinked).toMatchObject({ status: "applied", action: "linked" });
    expect(new Set([linked.commandKey, relinked.commandKey]).size).toBe(2);
    expect((await versions(101)).map(row => [row.version, row.lifecycle_status, row.external_inventory_item_id]))
      .toEqual([[1, "retired", ITEM_A], [2, "sealed", ITEM_A]]);
    expect((await auditActions()).filter(action => action.startsWith("inventory_availability.stock_link.")))
      .toEqual(["inventory_availability.stock_link.linked", "inventory_availability.stock_link.retired", "inventory_availability.stock_link.linked"]);
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "linked", reason_code: null });
  }, CASE_TIMEOUT_MS);

  it.each([
    { name: "the store login's token changed", code: "STOCK_LINK_CONNECTION_CHANGED",
      change: "UPDATE channels.channel_connections SET access_token='rotated-token' WHERE id=7" },
    { name: "the store login's domain changed", code: "STOCK_LINK_CONNECTION_CHANGED",
      change: "UPDATE channels.channel_connections SET shop_domain='other-shop.myshopify.com' WHERE id=7" },
    { name: "the store login's location changed", code: "STOCK_LINK_CONNECTION_CHANGED",
      change: "UPDATE channels.channel_connections SET shopify_location_id='11111' WHERE id=7" },
    { name: "the Card Shellz SKU changed", code: "STOCK_LINK_SKU_CHANGED_SINCE_READ",
      change: "UPDATE catalog.product_variants SET sku='P5-RENAMED' WHERE id=101" },
    { name: "a channel SKU override appeared", code: "STOCK_LINK_SKU_CHANGED_SINCE_READ",
      change: "INSERT INTO channels.channel_variant_overrides(channel_id,product_variant_id,sku_override) VALUES(35,101,'P5-SHOPIFY')" },
    { name: "the destination changed", code: "STOCK_MAPPING_TARGET_CHANGED",
      change: "UPDATE inventory.inventory_publication_targets SET revision=revision+1 WHERE channel_id=35 AND external_scope_id='98765'" },
  ])("refuses to write when $name after the store was read: transient, nothing written (PG 21)", async ({ code, change }) => {
    const command = await onlyCommand([101]);
    const claims = await claimAll(command);
    const evidence = { observedAt: AT, readFingerprint: await fingerprint() };
    const decidedFor = await destination();
    await database.pool.query(change);
    const result = await runShopifyStockLinkCommand(database.pool, { destination: decidedFor, command, claims, evidence },
      { source: shopifySource, clock: () => P4_NOW, monotonicNow: () => 0, random: () => 0, logger: log });
    expect(result).toMatchObject({ status: "failed", failure: { kind: "transient", code }, recordedProductVariantIds: [101] });
    expect(await versions(101)).toEqual([]);
    await nothingWritten([101]);
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ attempt_count: 1, first_failure_at: P4_NOW,
      reason_code: code, error_class: "transient", lease_token: null, next_check_at: at(10 * 60_000) });
    expect(log.warn).toHaveBeenCalledWith("inventory_availability.stock_link.command", expect.objectContaining({ outcome: "retry_scheduled", error_code: code }));
  }, CASE_TIMEOUT_MS);

  it("serializes a first channel SKU override with the SKU confirmation: the command waits for it and refuses (review DB-1)", async () => {
    const command = await onlyCommand([101]);
    const claims = await claimAll(command);
    const evidence = { observedAt: AT, readFingerprint: await fingerprint() };
    const decidedFor = await destination();
    // Size 101 has no override row yet. A first override is saved as the override writer saves it: its lock, then
    // the INSERT, not yet committed while the command confirms the SKU.
    const writer = await database.pool.connect();
    let committed = false;
    try {
      await writer.query("BEGIN");
      await writer.query(CHANNEL_VARIANT_OVERRIDE_LOCK_SQL, [channelVariantOverrideLockKey(35, 101)]);
      await writer.query("INSERT INTO channels.channel_variant_overrides(channel_id,product_variant_id,sku_override) VALUES(35,101,'XYZ-9')");
      const running = runShopifyStockLinkCommand(database.pool, { destination: decidedFor, command, claims, evidence },
        { source: shopifySource, clock: () => P4_NOW, monotonicNow: () => 0, random: () => 0, logger: log });
      const settled = running.then(() => "settled" as const, () => "settled" as const);
      // Either the command waits on the override lock, or (without the lock) it finishes before the writer commits.
      for (let waited = 0; waited < 4_000; waited += 25) {
        const waiting = (await database.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted`)).rows[0]!.n;
        if (waiting > 0 || await Promise.race([settled, new Promise(resolve => setTimeout(() => resolve("pending"), 25))]) === "settled") break;
      }
      await writer.query("COMMIT");
      committed = true;
      const result = await running;
      expect(result).toMatchObject({ status: "failed", failure: { kind: "transient", code: "STOCK_LINK_SKU_CHANGED_SINCE_READ" },
        recordedProductVariantIds: [101] });
      expect(await versions(101)).toEqual([]);
      await nothingWritten([101]);
    } finally {
      if (!committed) await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }
  }, CASE_TIMEOUT_MS);

  it.each([
    { name: "turned off", options: { autoLinkEnabled: false }, reason: "switch_off" },
    { name: "halted", options: { halted: true }, reason: "halted" },
  ])("stops with no change when the store's linking is $name after the read (PG 21)", async ({ options, reason }) => {
    const command = await onlyCommand([101]);
    const [claim] = await claimAll(command);
    await seedStockLinkDestination(database.pool, targetId, AT, options);
    expect(await run(command, { claims: [claim!] })).toMatchObject({ status: "stopped", reason });
    expect(await versions(101)).toEqual([]);
    await nothingWritten([101]);
    // The claim is left as it was: the tick no longer runs this destination; the lease expires.
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ lease_token: claim!.leaseToken, revision: claim!.revision,
      attempt_count: 0 });
  }, CASE_TIMEOUT_MS);

  it("loses its claim when another tick took the row after the read: nothing written to the row or the links (PG 21)", async () => {
    const command = await onlyCommand([101]);
    const [claim] = await claimAll(command);
    const thief = await claimStockLinkCheck(database.pool, targetId, 101, AT);
    const result = await run(command, { claims: [claim!] });
    expect(result).toMatchObject({ status: "failed", failure: { kind: "transient", code: "STOCK_LINK_CLAIM_LOST" }, recordedProductVariantIds: [] });
    expect(await versions(101)).toEqual([]);
    await nothingWritten([101]);
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ lease_token: thief.leaseToken, revision: thief.revision,
      attempt_count: 0 });
  }, CASE_TIMEOUT_MS);

  it("never acts on store reads older than 5 minutes: transient, re-read, no fence taken (§4.3 step 0)", async () => {
    const command = await onlyCommand([101]);
    const epoch = async () => (await database.pool.query<{ epoch: string }>("SELECT epoch::text FROM inventory.cutover_admission_fence")).rows[0]!.epoch;
    const before = await epoch();
    const result = await runShopifyStockLinkCommand(database.pool, { destination: await destination(), command, claims: await claimAll(command),
      evidence: { observedAt: new Date(P4_NOW.getTime() - 5 * 60_000 - 1).toISOString(), readFingerprint: await fingerprint() } },
    { source: shopifySource, clock: () => P4_NOW, monotonicNow: () => 0, random: () => 0, logger: log });
    expect(result).toMatchObject({ status: "failed", fenceHoldMs: null, failure: { kind: "transient", code: "STOCK_LINK_EVIDENCE_STALE" },
      recordedProductVariantIds: [101] });
    expect(await epoch()).toBe(before);
    expect(await versions(101)).toEqual([]);
    await nothingWritten([101]);
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ attempt_count: 1, reason_code: "STOCK_LINK_EVIDENCE_STALE" });
  }, CASE_TIMEOUT_MS);

  it("links one size of a product while a selected sibling stays unlinked: only that size's row (PG 22)", async () => {
    await addShopifyFeed(database.pool, 102, "225", { sku: "NEW" });
    const planned = await plan([101, 102]);
    expect(planned.decisions.map(decision => [decision.productVariantId, decision.change, decision.status, decision.code]))
      .toEqual([[101, "link", "linked", null], [102, "none", "waiting", "STOCK_LINK_NOT_LISTED"]]);
    expect(planned.commands).toHaveLength(1);
    expect(await run(planned.commands[0]!)).toMatchObject({ status: "applied", preparation: { changedProductVariantIds: [101], publicationRows: 1 } });
    expect(await outbox(101)).toEqual([[ITEM_A, "queued", "17", null]]);
    expect(await outbox(102)).toEqual([]);
    expect(await readStockLinkHead(database.pool, targetId, 102)).toBeNull();
  }, CASE_TIMEOUT_MS);

  it("reports a command whose scope unlock is unconfirmed after COMMIT as applied (receipt found), and a replay takes the fast path (PG 23)", async () => {
    const command = await onlyCommand([101]);
    let locked = false, released = false;
    const preReleasing = hookedPool(database.pool, { before: async (query, sql) => {
      // Only the configuration transaction's COMMIT (the one that took scope locks), not the fast path's read.
      if (query.text.startsWith("SELECT pg_try_advisory_lock(hashtextextended(")) locked = true;
      if (query.text === "COMMIT" && locked && !released) {
        released = true;
        // The new item's key is held twice (the engine's step 6 and the preparation's own); releasing one now makes the
        // store's second release after COMMIT return false (STOCK_MAPPING_CLEANUP_UNCERTAIN, thrown from its finally).
        await sql("SELECT pg_advisory_unlock(hashtextextended($1,$2))", [scopeKey(ITEM_A), PUBLICATION_TARGET_SCOPE_LOCK_SEED]);
      }
    } });
    const result = await run(command, { pool: preReleasing });
    expect(released).toBe(true);
    expect(result).toMatchObject({ status: "applied", action: "linked", cleanupUncertain: true,
      preparation: { changedProductVariantIds: [101] } });
    expect(log.warn).toHaveBeenCalledWith("inventory_availability.stock_link.command", expect.objectContaining({ outcome: "applied_cleanup_uncertain" }));
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "linked", attempt_count: 0, lease_token: null });
    expect(await receipts()).toEqual([`stock-link:${result.commandKey}`]);
    expect(await run(command)).toMatchObject({ status: "already_linked" });
    expect((await auditActions()).filter(action => action.startsWith("inventory_availability.stock_link."))).toEqual(["inventory_availability.stock_link.linked"]);
    expect(await outbox(101)).toHaveLength(1);
  }, CASE_TIMEOUT_MS);

  it("records a transient attempt when the scope unlock is unconfirmed after ROLLBACK (no receipt) (PG 23)", async () => {
    const command = await onlyCommand([101]);
    const failing = hookedPool(database.pool, { before: async (query, sql) => {
      if (query.text.includes("INSERT INTO public.audit_events") && String(query.values[2]).startsWith("inventory_availability.stock_link.")) {
        await sql("SELECT pg_advisory_unlock(hashtextextended($1,$2))", [scopeKey(ITEM_A), PUBLICATION_TARGET_SCOPE_LOCK_SEED]);
        throw new Error("forced failure after step 8");
      }
    } });
    const result = await run(command, { pool: failing });
    expect(result).toMatchObject({ status: "failed", failure: { kind: "cleanup_uncertain", code: "STOCK_MAPPING_CLEANUP_UNCERTAIN" },
      recordedProductVariantIds: [101] });
    await nothingWritten([101]);
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ attempt_count: 1, error_class: "transient",
      reason_code: "STOCK_MAPPING_CLEANUP_UNCERTAIN", next_check_at: at(10 * 60_000) });
  }, CASE_TIMEOUT_MS);

  it("treats a statement timeout as transient, never as an error (PG 24)", async () => {
    const command = await onlyCommand([101]);
    const slow = hookedPool(database.pool, { after: async (query, sql) => {
      if (query.text === "SET LOCAL statement_timeout='60s'") await sql("SET LOCAL statement_timeout='300ms'");
    } });
    const claims = await claimAll(command);
    // Another writer holds the destination row, so the command's own target lock outlasts the statement timeout.
    const result = await whileHeld([["BEGIN", []], ["SELECT id FROM inventory.inventory_publication_targets WHERE id=$1 FOR UPDATE", [targetId]]],
      () => run(command, { pool: slow, claims }));
    expect(result).toMatchObject({ status: "failed", failure: { kind: "transient", code: "STOCK_LINK_STATEMENT_TIMEOUT", causeCode: "57014",
      countsAttempt: true }, recordedProductVariantIds: [101] });
    await nothingWritten([101]);
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "waiting", attempt_count: 1,
      error_class: "transient", reason_code: "STOCK_LINK_STATEMENT_TIMEOUT" });
  }, CASE_TIMEOUT_MS);

  it.each([
    { name: "a recorded store SKU", sku: "P5" as string | null },
    { name: "no recorded store SKU (grandfathered)", sku: null },
  ])("retires a link whose store SKU is longer than 100 characters, storing nothing over 100 ($name) (PG 26)", async ({ sku }) => {
    const mappingA = await sealStockLink(database.pool, targetId, 101, ITEM_A, { sku });
    const long = `P5${"X".repeat(99)}`;
    expect(Array.from(long)).toHaveLength(101);
    store = new Map([[ITEM_A, storeItem(ITEM_A, long)]]);
    const command = await onlyCommand([101]);
    expect(command.members).toMatchObject([{ change: "retire", status: "waiting", code: "STOCK_LINK_NOT_LISTED", rule: "V6b/L5",
      replacesMappingId: mappingA, recordObservedSku: null }]);
    expect(await run(command)).toMatchObject({ status: "applied", action: "retired" });
    expect(await versions(101)).toMatchObject([{ lifecycle_status: "retired", external_sku: sku }]);
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "waiting", reason_code: "STOCK_LINK_NOT_LISTED",
      observed_sku: null, next_check_at: at(15 * 60_000) });
    const stored = (await database.pool.query<{ n: number }>(`SELECT
      (SELECT count(*) FROM inventory.publication_variant_mapping_versions WHERE char_length(external_sku) > 100)
      + (SELECT count(*) FROM inventory.stock_link_checks WHERE char_length(observed_sku) > 100) AS n`)).rows[0]!;
    expect(Number(stored.n)).toBe(0);
  }, CASE_TIMEOUT_MS);
});

// P7 (PLAN-CH2 v4.1 §7.1, §7.2, §11.4): the tick end to end over real PostgreSQL: the composition's own store, the
// Channels source, the Shopify command policy and the pinned-client lock runner, with only the store's answers stubbed.
dbDescribe.sequential("stock-link tick and runner, real PostgreSQL (P7: PG 18, 25, 28)", () => {
  let database: InventoryCutoverTestDatabase;
  let targetId: number;
  /** The Shopify store the stub adapter answers from. */
  let shop: Map<string, StockLinkStoreItem>;
  let now: Date;
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const source = createShopifyStockLinkSource();
  const storeItem = (itemId: string, sku: string | null): StockLinkStoreItem => ({ itemId, sku, productId: "9001", productStatus: "ACTIVE" });
  const reads: Array<{ kind: "lookup" | "observe"; values: string[] }> = [];

  beforeEach(async () => {
    database = await createStockLinkDatabase();
    await installStockLinkConnectionColumns(database.pool);
    await installStockLinkTickColumns(database.pool);
    await addShopifyFeed(database.pool, 101, ITEM_A, { sku: "P5" });
    targetId = await createLiveShopifyTarget(database.pool);
    shop = new Map([[ITEM_A, storeItem(ITEM_A, "P5")]]);
    now = new Date(AT);
    reads.length = 0;
    for (const fn of Object.values(log)) fn.mockReset();
  }, CASE_TIMEOUT_MS);
  afterEach(async () => {
    vi.restoreAllMocks();
    await database?.close();
  });

  /** The store's answers (the only stand-in): each read carries the login fingerprint the Channels source computes. */
  const adapter = (pool: Pool): StockLinkAdapter => ({
    destinationKind: "channel_connection", providerKey: "shopify",
    async findItemsBySku(destination, skus) {
      reads.push({ kind: "lookup", values: [...skus] });
      const keys = new Set(skus.map(sku => normalizeStockLinkSku(sku)).flatMap(sku => sku.kind === "sku" ? [sku.key] : []));
      return { observedAt: now.toISOString(), readFingerprint: await source.readFingerprint(pool, destination), skus: [...skus],
        items: [...shop.values()].filter(item => { const sku = normalizeStockLinkSku(item.sku); return sku.kind === "sku" && keys.has(sku.key); }) };
    },
    async observeItems(destination, itemIds) {
      reads.push({ kind: "observe", values: [...itemIds] });
      return { observedAt: now.toISOString(), readFingerprint: await source.readFingerprint(pool, destination),
        observations: itemIds.map(itemId => ({ itemId, item: shop.get(itemId) ?? null })) };
    },
  });
  let leases = 0;
  const service = (pool: Pool = database.pool) => createStockLinkService({ pool, bindings: [{ adapter: adapter(pool), source }],
    clock: () => now, monotonicNow: () => 0, random: () => 0.5, logger: log,
    newLeaseToken: () => `00000000-0000-4000-8000-${String(++leases).padStart(12, "0")}` });
  const quietConsole = { log: () => undefined, error: () => undefined };
  /** One tick as the runner runs it: under advisory lock STOCK_LINK_LOCK_ID on a pinned client of the database. */
  const tickThroughRunner = async (pool: Pool = database.pool) => {
    const tickService = service(pool);
    const summaries: unknown[] = [];
    await runLockedStockLinkTick({ service: { tick: async () => { const summary = await tickService.tick(); summaries.push(summary); return summary; },
      recordTickFailure: (error, extra) => tickService.recordTickFailure(error, extra) },
    lock: createAdvisoryLockRunner(database.pool, quietConsole) });
    return summaries[0] as Awaited<ReturnType<ReturnType<typeof service>["tick"]>> | undefined;
  };
  const head = async (productVariantId: number) => (await database.pool.query<{ item: string | null; versions: string }>(
    `SELECT a.external_inventory_item_id AS item,
       (SELECT string_agg(v.lifecycle_status || ':' || v.external_inventory_item_id, ',' ORDER BY v.version)
          FROM inventory.publication_variant_mapping_versions v
          WHERE v.publication_target_id=h.publication_target_id AND v.product_variant_id=h.product_variant_id) AS versions
     FROM inventory.publication_variant_mapping_heads h
     LEFT JOIN inventory.publication_variant_mapping_versions a ON a.id=h.active_mapping_id
     WHERE h.publication_target_id=$1 AND h.product_variant_id=$2`, [targetId, productVariantId])).rows[0] ?? null;
  const stockLinkAudit = async () => (await database.pool.query<{ action: string }>(
    "SELECT action FROM public.audit_events WHERE action LIKE 'inventory_availability.stock_link.%' ORDER BY id")).rows.map(row => row.action);
  const destinationRow = async () => (await database.pool.query<{ heartbeat_at: Date | null; recent_cursor_raw: string | null;
    recent_cursor_id: string | null; sweep_cursor_variant_id: number | null; dead_letter_cursor_at: Date | null; revision: string }>(
    `SELECT heartbeat_at, to_char(recent_cursor_raw,'YYYY-MM-DD HH24:MI:SS.US') AS recent_cursor_raw, recent_cursor_id::text,
       sweep_cursor_variant_id, dead_letter_cursor_at, revision::text FROM inventory.stock_link_destinations WHERE publication_target_id=$1`,
  [targetId])).rows[0] ?? null;
  const feedRaw = async (productVariantId: number) => (await database.pool.query<{ raw: string }>(
    `SELECT to_char(updated_at,'YYYY-MM-DD HH24:MI:SS.US') AS raw FROM channels.channel_feeds WHERE channel_id=$1 AND product_variant_id=$2`,
  [STOCK_LINK_SHOPIFY.channelId, productVariantId])).rows[0]!.raw;
  /** The outbox's own worker with a store that answers 404 for `refuse` (Shopify's "item not found"): a dead letter. */
  const deliverOutbox = async (refuse: readonly string[]) => {
    const due = (await database.pool.query(`SELECT date_trunc('milliseconds',max(available_at))+interval '1 millisecond' AS due
      FROM inventory.inventory_publication_outbox WHERE state='queued'`)).rows[0].due as Date;
    const transport = {
      destinationKind: "channel_connection", providerKey: "shopify", supportedScopeTypes: ["location"],
      publishAbsolute: vi.fn(async (request: { externalInventoryItemId: string; desiredQuantity: number }) => {
        if (refuse.includes(request.externalInventoryItemId))
          throw new InventoryPublicationTransportError("SHOPIFY_INVENTORY_ITEM_NOT_FOUND", "Shopify answered 404 for this item.", false);
        return { publishedQuantity: request.desiredQuantity, providerResponse: { stub: true } };
      }),
      readAbsolute: vi.fn(async () => ({ observedQuantity: 0, providerResponse: { stub: true } })),
    } satisfies InventoryPublicationTransportAdapter;
    const repository = new PostgresInventoryPublicationOutboxRepository(database.pool, { error: vi.fn(), debug: vi.fn() });
    return new InventoryPublicationOutboxService(repository, { get: () => transport }, { now: () => due }, () => "stock-link-p7-lease",
      { runOutbox: async (_claim, work) => work() }).processDue();
  };

  it("links a new size end to end through the runner, then verifies it at once after a 404 dead letter and relinks (PG 18)", async () => {
    // Tick 1: the destination row is created switch-on with its heartbeat; discovery adds the size, the tick reads the
    // store, links the one item that carries its SKU, and the link's stock row is queued.
    const first = await tickThroughRunner();
    expect(first).toMatchObject({ outcome: "completed", destinations: 1, claimed: 1, applies: 1, links: 1, relinks: 0 });
    expect(reads).toEqual([{ kind: "observe", values: [ITEM_A] }, { kind: "lookup", values: ["P5"] }]);
    expect(await head(101)).toEqual({ item: ITEM_A, versions: `sealed:${ITEM_A}` });
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "linked", lease_token: null,
      attempt_count: 0, next_check_at: new Date(now.getTime() + 24 * 60 * 60_000) });
    expect(await destinationRow()).toMatchObject({ heartbeat_at: now, recent_cursor_raw: await feedRaw(101), sweep_cursor_variant_id: null });
    expect(await stockLinkAudit()).toEqual(["inventory_availability.stock_link.linked"]);
    expect((await database.pool.query("SELECT external_inventory_item_id_snapshot AS item, state FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1",
      [targetId])).rows).toEqual([{ item: ITEM_A, state: "queued" }]);

    // The store deleted the item and re-added it under a new id; the outbox's write is refused (404, dead letter).
    expect(await deliverOutbox([ITEM_A])).toMatchObject({ claimed: 1, failed: 1 });
    shop = new Map([[ITEM_NEW, storeItem(ITEM_NEW, "P5")]]);

    // Tick 2, two minutes later: the dead letter makes the linked size due now (not in 24 h); the verify finds the
    // item gone and the SKU on the new item, and relinks.
    now = new Date(Date.parse(AT) + 2 * 60_000);
    reads.length = 0;
    const second = await tickThroughRunner();
    expect(second).toMatchObject({ claimed: 1, applies: 1, relinks: 1 });
    expect(await head(101)).toEqual({ item: ITEM_NEW, versions: `retired:${ITEM_A},sealed:${ITEM_NEW}` });
    expect(await stockLinkAudit()).toEqual(["inventory_availability.stock_link.linked", "inventory_availability.stock_link.relinked"]);
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "linked",
      next_check_at: new Date(now.getTime() + 24 * 60 * 60_000) });
    expect((await destinationRow())!.dead_letter_cursor_at).not.toBeNull();

    // Tick 3: the dead letter is behind the cursor, so it wakes nothing again; nothing is due.
    now = new Date(Date.parse(AT) + 4 * 60_000);
    reads.length = 0;
    expect(await tickThroughRunner()).toMatchObject({ claimed: 0, providerCalls: 0 });
    expect(log.error).not.toHaveBeenCalled();
  }, CASE_TIMEOUT_MS);

  it("holds the retire over the day's allowance, and after Continue the next tick retires it at once (review LNK-1)", async () => {
    expect(await tickThroughRunner()).toMatchObject({ links: 1 });
    // 25 earlier engine retires in the window use the day's allowance up.
    const others = Array.from({ length: 25 }, (_, index) => 2001 + index);
    await database.pool.query(`INSERT INTO catalog.product_variants(id, product_id, sku)
      SELECT id, 20, 'SL-' || id FROM unnest($1::integer[]) AS id ON CONFLICT DO NOTHING`, [others]);
    for (const productVariantId of others) {
      const mappingId = await sealStockLink(database.pool, targetId, productVariantId, `9${productVariantId}`, { sku: `SL-${productVariantId}` });
      const linkHead = (await readStockLinkHead(database.pool, targetId, productVariantId))!;
      await inStockLinkTransaction(database.pool, client => retireStockLinkMappingsInsideTransaction(client, {
        publicationTargetId: targetId, actor: STOCK_LINK_ACTOR, reason: "Store item gone.", now: new Date(Date.parse(AT) - 60 * 60_000),
        members: [{ productVariantId, mappingId, expectedHeadRevision: linkHead.revision }] }));
    }
    // The store item lost its SKU; the size is verified now (as a dead letter would make it due).
    shop = new Map();
    await database.pool.query("UPDATE inventory.stock_link_checks SET next_check_at=$3 WHERE publication_target_id=$1 AND product_variant_id=$2",
      [targetId, 101, now]);
    now = new Date(Date.parse(AT) + 2 * 60_000);
    expect(await tickThroughRunner()).toMatchObject({ claimed: 1, applies: 0 });
    expect(await head(101)).toEqual({ item: ITEM_A, versions: `sealed:${ITEM_A}` });
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "linked", reason_code: "STOCK_LINK_RETIRES_HELD",
      next_check_at: new Date(now.getTime() + 24 * 60 * 60_000) });

    const controls = new StockLinkControlsService(new PostgresStockLinkControlsStore(database.pool), () => now, log);
    const status = await controls.status({ publicationTargetId: String(targetId) });
    expect(status).toMatchObject({ retiresHeld: { count: 1 } });
    await controls.continue({ publicationTargetId: targetId, expectedRevision: (status as { revision: string }).revision }, "operator-1");
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ next_check_at: now });

    now = new Date(Date.parse(AT) + 4 * 60_000);
    expect(await tickThroughRunner()).toMatchObject({ claimed: 1, applies: 1 });
    expect(await head(101)).toEqual({ item: null, versions: `retired:${ITEM_A}` });
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "waiting", reason_code: "STOCK_LINK_NOT_LISTED" });
    expect(log.error).not.toHaveBeenCalled();
  }, CASE_TIMEOUT_MS);

  it("skips the tick while another process holds lock 736220, and runs the next one (PG 18, §7.1)", async () => {
    const other = await database.pool.connect();
    try {
      expect((await other.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [STOCK_LINK_LOCK_ID])).rows[0]!.ok).toBe(true);
      expect(await tickThroughRunner()).toBeUndefined();
      expect(await destinationRow()).toBeNull();
      expect(reads).toEqual([]);
    } finally {
      await other.query("SELECT pg_advisory_unlock($1)", [STOCK_LINK_LOCK_ID]);
      other.release();
    }
    expect(await tickThroughRunner()).toMatchObject({ claimed: 1, links: 1 });
  }, CASE_TIMEOUT_MS);

  it("finds updated feeds by the raw cursor and a feed stored in another zone by the sweep, whatever the session zone (PG 25, TST-8)", async () => {
    // The engine's sessions run in New York while the feeds' writer runs in UTC; the injected clock is neither
    // database now() nor the feeds' time.
    const newYork = new pg.Pool({ connectionString: database.connectionString, max: 4, options: "-c TimeZone=America/New_York" });
    try {
      expect((await newYork.query<{ zone: string }>("SELECT current_setting('TimeZone') AS zone")).rows[0]!.zone).toBe("America/New_York");
      shop = new Map();
      // Tick 1: nothing on the store yet, the size waits; the cursor is the feed's raw value, unchanged by the zone.
      expect(await tickThroughRunner(newYork)).toMatchObject({ claimed: 1, applies: 0 });
      expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "waiting", reason_code: "STOCK_LINK_NOT_LISTED" });
      const cursor = (await destinationRow())!;
      expect(cursor.recent_cursor_raw).toBe(await feedRaw(101));

      // The UTC writer updates the feed (a later raw value); a New York writer adds a feed for size 102 with the
      // database default, stored in New York time, hours behind the cursor.
      await database.pool.query(`UPDATE channels.channel_feeds SET channel_inventory_item_id=$1, updated_at=updated_at + interval '1 second'
        WHERE channel_id=$2 AND product_variant_id=101`, [ITEM_NEW, STOCK_LINK_SHOPIFY.channelId]);
      await newYork.query(`INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id,is_active)
        VALUES($1,102,'NEW','444',1)`, [STOCK_LINK_SHOPIFY.channelId]);
      expect(await feedRaw(102) < cursor.recent_cursor_raw!).toBe(true);
      shop = new Map([[ITEM_NEW, storeItem(ITEM_NEW, "P5")]]);

      // Tick 2, one minute later: the update is found by the raw cursor and wakes the waiting size (its 15-minute
      // wait not over), which links; the New York feed is behind the cursor, so the sweep adds its size.
      now = new Date(Date.parse(AT) + 60_000);
      reads.length = 0;
      expect(await tickThroughRunner(newYork)).toMatchObject({ links: 1 });
      expect(await head(101)).toEqual({ item: ITEM_NEW, versions: `sealed:${ITEM_NEW}` });
      expect(await destinationRow()).toMatchObject({ recent_cursor_raw: await feedRaw(101) });
      expect(await readStockLinkCheck(database.pool, targetId, 102)).toMatchObject({ status: "waiting" });
      const changed = log.debug.mock.calls.filter(([, event]) => (event as { phase?: string }).phase === "discovery").at(-1)![1] as
        { changed: number; inserted: number; woken: number };
      expect(changed).toMatchObject({ changed: 1, inserted: 1, woken: 1 });
    } finally {
      await newYork.end();
    }
  }, CASE_TIMEOUT_MS);

  it("wakes a waiting size at a 24 h backoff once its feed's store item id changes, and only then (PG 28, SAF-6)", async () => {
    shop = new Map();
    expect(await tickThroughRunner()).toMatchObject({ claimed: 1, applies: 0 });
    // The size has waited long: its next check is a day away (the longest wait).
    await database.pool.query(`UPDATE inventory.stock_link_checks SET next_check_at=$3::timestamptz + interval '24 hours', updated_at=$3
      WHERE publication_target_id=$1 AND product_variant_id=$2`, [targetId, 101, AT]);
    shop = new Map([[ITEM_NEW, storeItem(ITEM_NEW, "P5")]]);

    // No feed change: nothing is due, nothing is read.
    now = new Date(Date.parse(AT) + 60_000);
    reads.length = 0;
    expect(await tickThroughRunner()).toMatchObject({ claimed: 0, providerCalls: 0 });

    // The listing record now names the store item: the size is due at the next tick and links.
    await database.pool.query(`UPDATE channels.channel_feeds SET channel_inventory_item_id=$1, updated_at=updated_at + interval '1 second'
      WHERE channel_id=$2 AND product_variant_id=101`, [ITEM_NEW, STOCK_LINK_SHOPIFY.channelId]);
    now = new Date(Date.parse(AT) + 2 * 60_000);
    expect(await tickThroughRunner()).toMatchObject({ claimed: 1, links: 1 });
    expect(reads).toEqual([{ kind: "observe", values: [ITEM_NEW] }, { kind: "lookup", values: ["P5"] }]);
    expect(await head(101)).toEqual({ item: ITEM_NEW, versions: `sealed:${ITEM_NEW}` });
    expect(await readStockLinkCheck(database.pool, targetId, 101)).toMatchObject({ status: "linked" });
  }, CASE_TIMEOUT_MS);
});

// P8 (PLAN-CH2 v4.1 §7.3, §8, §11.4): the Channel Inventory controls and the Ops Health checks over real PostgreSQL,
// and two Shopify stores (US and Canada) linked independently by the real tick.
dbDescribe.sequential("stock-link controls, Ops Health and two stores, real PostgreSQL (P8: PG 15, 16, 17)", () => {
  let database: InventoryCutoverTestDatabase;
  let targetId: number;
  const NOW = new Date(AT);
  const HOUR_MS = 60 * 60_000;
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const log = { info: vi.fn(), debug: vi.fn() };
  const dialect = new PgDialect();
  const controls = (clock: () => Date = () => NOW) => new StockLinkControlsService(new PostgresStockLinkControlsStore(database.pool), clock, log);

  beforeEach(async () => {
    database = await createStockLinkDatabase();
    targetId = await createLiveShopifyTarget(database.pool);
    log.info.mockReset();
    log.debug.mockReset();
  }, CASE_TIMEOUT_MS);
  afterEach(async () => {
    vi.restoreAllMocks();
    await database?.close();
  });

  const destination = async (id = targetId) => (await database.pool.query<{ auto_link_enabled: boolean; revision: string;
    halted_at: Date | null; halted_code: string | null; paused_until: Date | null; paused_code: string | null; paused_since: Date | null;
    retires_released_at: Date | null; retires_released_by: string | null }>(`SELECT auto_link_enabled, revision::text, halted_at, halted_code,
      paused_until, paused_code, paused_since, retires_released_at, retires_released_by
    FROM inventory.stock_link_destinations WHERE publication_target_id=$1`, [id])).rows[0] ?? null;
  const controlAudit = async () => (await database.pool.query<{ actor: string; action: string; target: string;
    changes: { before: Record<string, unknown>; after: Record<string, unknown> }; context: Record<string, unknown> }>(
    `SELECT actor, action, target, changes, context FROM public.audit_events
     WHERE action LIKE 'inventory_availability.stock_link.%' ORDER BY id`)).rows;
  /** A check row in any state, written as the engine would leave it. */
  const seedCheck = async (productVariantId: number, row: { status: "waiting" | "linked" | "flagged" | "error";
    reasonCode?: string | null; attemptCount?: number; firstFailureAt?: Date | null; busySince?: Date | null; nextCheckAt?: Date | null;
    leaseExpiresAt?: Date | null; updatedAt?: Date; id?: number }) => {
    await database.pool.query(`INSERT INTO inventory.stock_link_checks(publication_target_id, product_variant_id, status, reason_code,
        error_class, message, attempt_count, first_failure_at, busy_since, next_check_at, lease_token, lease_expires_at, created_at, updated_at)
      VALUES($1,$2,$3::varchar,$4,CASE WHEN $3::varchar='error' THEN 'permanent' END,CASE WHEN $3::varchar='error' THEN 'stopped' END,$5,$6,$7,$8,
        CASE WHEN $9::timestamptz IS NULL THEN NULL ELSE '00000000-0000-4000-8000-000000000999'::uuid END,$9,$10,$10)`,
    [row.id ?? targetId, productVariantId, row.status, row.reasonCode ?? (row.status === "flagged" ? "STOCK_LINK_SKU_DUPLICATE"
      : row.status === "error" ? "STOCK_MAPPING_COMMAND_CONFLICT" : null), row.attemptCount ?? 0, row.firstFailureAt ?? null,
    row.busySince ?? null, row.status === "error" ? null : row.nextCheckAt ?? new Date(NOW.getTime() + 24 * HOUR_MS),
    row.leaseExpiresAt ?? null, row.updatedAt ?? ago(HOUR_MS)]);
  };
  const addVariants = async (ids: readonly number[]) => {
    await database.pool.query(`INSERT INTO catalog.product_variants(id, product_id, sku)
      SELECT id, 20, 'SL-' || id FROM unnest($1::integer[]) AS id ON CONFLICT DO NOTHING`, [[...ids]]);
  };
  /** Links each size, then retires it as the engine does (retired_at = `at`, actor system:stock-link). */
  const retireAt = async (ids: readonly number[], at: Date) => {
    for (const productVariantId of ids) {
      const mappingId = await sealStockLink(database.pool, targetId, productVariantId, `9${productVariantId}`, { sku: `SL-${productVariantId}` });
      const head = (await readStockLinkHead(database.pool, targetId, productVariantId))!;
      await inStockLinkTransaction(database.pool, client => retireStockLinkMappingsInsideTransaction(client, {
        publicationTargetId: targetId, actor: STOCK_LINK_ACTOR, reason: "Store item gone.", now: at,
        members: [{ productVariantId, mappingId, expectedHeadRevision: head.revision }] }));
    }
  };
  const healthCount = async (code: string, now: Date) => {
    const check = stockLinkHealthChecks({ now }).find(entry => entry.code === code)!;
    const { sql, params } = dialect.sqlToQuery(check.countSql);
    return Number((await database.pool.query(sql, params as unknown[])).rows[0]!.count);
  };
  const healthSample = async (code: string, now: Date) => {
    const check = stockLinkHealthChecks({ now }).find(entry => entry.code === code)!;
    const { sql, params } = dialect.sqlToQuery(check.sampleSql);
    return (await database.pool.query(sql, params as unknown[])).rows;
  };
  const allCounts = async (now: Date) => Object.fromEntries(await Promise.all(stockLinkHealthChecks({ now })
    .map(async check => [check.code, await healthCount(check.code, now)] as const)));

  it("audits each control in its own transaction, refuses a stale revision and writes nothing for a no-op (PG 15)", async () => {
    // No destination row yet: the switch is on at revision "0".
    expect(await controls().status({ publicationTargetId: String(targetId) })).toEqual({ supported: true, publicationTargetId: targetId,
      autoLinkEnabled: true, revision: "0", counts: { linked: 0, waiting: 0, flagged: 0, error: 0 }, paused: null, halted: null, retiresHeld: null, runnerOff: false });

    const off = await controls().setSwitch({ publicationTargetId: targetId, enabled: false, expectedRevision: "0", reason: "Store migration" }, "operator-1");
    expect(off).toMatchObject({ autoLinkEnabled: false, revision: "2" });
    expect(await destination()).toMatchObject({ auto_link_enabled: false, revision: "2" });
    expect(await controlAudit()).toEqual([{ actor: "operator-1", action: "inventory_availability.stock_link.switch_changed",
      target: `inventory.inventory_publication_target:${targetId}`,
      changes: { before: expect.objectContaining({ autoLinkEnabled: true, revision: "1" }),
        after: expect.objectContaining({ autoLinkEnabled: false, revision: "2" }) },
      context: expect.objectContaining({ reason: "Store migration", expectedRevision: "0" }) }]);

    // A stale revision is refused with nothing written; so is a second "no row yet" request.
    for (const expectedRevision of ["1", "0", "3"]) {
      await expect(controls().setSwitch({ publicationTargetId: targetId, enabled: true, expectedRevision }, "operator-2"))
        .rejects.toMatchObject({ status: 409, code: "STOCK_LINK_DESTINATION_STALE" });
    }
    // The same position again changes nothing: no revision, no audit row (DEBUG only).
    expect(await controls().setSwitch({ publicationTargetId: targetId, enabled: false, expectedRevision: "2" }, "operator-1"))
      .toMatchObject({ revision: "2" });
    expect(await controlAudit()).toHaveLength(1);
    expect(log.debug).toHaveBeenCalledWith("inventory_availability.stock_link.control", expect.objectContaining({ outcome: "unchanged" }));

    // The audit row commits or rolls back with its change: a refused audit insert leaves the switch as it was.
    await database.pool.query(`ALTER TABLE public.audit_events ADD CONSTRAINT p8_refuse_switch_audit
      CHECK (action <> 'inventory_availability.stock_link.switch_changed') NOT VALID`);
    await expect(controls().setSwitch({ publicationTargetId: targetId, enabled: true, expectedRevision: "2" }, "operator-1"))
      .rejects.toMatchObject({ code: "23514" });
    expect(await destination()).toMatchObject({ auto_link_enabled: false, revision: "2" });
    await database.pool.query("ALTER TABLE public.audit_events DROP CONSTRAINT p8_refuse_switch_audit");
    expect(await controls().setSwitch({ publicationTargetId: targetId, enabled: true, expectedRevision: "2" }, "operator-1"))
      .toMatchObject({ autoLinkEnabled: true, revision: "3" });

    // Channels PR4: Walmart is a controlled destination now (the engine links it): its status answers before the tick
    // created its destination row, and reading it writes nothing. A destination of a provider with no policy is
    // unsupported (unit-pinned, stock-link-controls.test.ts); an unknown id is 404.
    const walmart = (await database.pool.query<{ id: number }>(`SELECT t.id FROM inventory.inventory_publication_targets t
      JOIN channels.channels c ON c.id=t.channel_id WHERE c.provider='walmart' ORDER BY t.id LIMIT 1`)).rows[0]!.id;
    expect(await controls().status({ publicationTargetId: String(walmart) })).toMatchObject({ supported: true, publicationTargetId: walmart,
      revision: "0", counts: { linked: 0, waiting: 0, flagged: 0, error: 0 } });
    await expect(controls().status({ publicationTargetId: "999999" })).rejects.toMatchObject({ status: 404 });
    expect(await destination(walmart)).toBeNull();
  }, CASE_TIMEOUT_MS);

  it("Check again makes failed, flagged and linked sizes due with streaks reset, clears a halt, and leaves claimed and waiting rows (PG 15)", async () => {
    await addVariants([106, 107]);
    await sealStockLink(database.pool, targetId, 101, ITEM_A, { sku: "P5" });
    await seedStockLinkDestination(database.pool, targetId, AT, { halted: true });
    await seedCheck(101, { status: "error" });                                         // linked size stopped on an error
    await seedCheck(102, { status: "error", attemptCount: 3, firstFailureAt: ago(5 * HOUR_MS) }); // no link: back to waiting
    await seedCheck(103, { status: "flagged", attemptCount: 2, busySince: ago(HOUR_MS) });
    await seedCheck(104, { status: "linked", attemptCount: 4, firstFailureAt: ago(2 * HOUR_MS), reasonCode: "STOCK_LINK_LOOKUP_MISSED" });
    await seedCheck(105, { status: "linked", leaseExpiresAt: new Date(NOW.getTime() + 60_000) }); // a live claim holds it
    await seedCheck(106, { status: "waiting", nextCheckAt: new Date(NOW.getTime() + HOUR_MS) });
    await seedCheck(107, { status: "flagged", leaseExpiresAt: ago(60_000) });          // an expired claim does not
    const before = (await destination())!;

    const result = await controls().checkAgain({ publicationTargetId: targetId, expectedRevision: before.revision }, "operator-1");
    expect(result).toMatchObject({ halted: null, revision: String(Number(before.revision) + 1),
      counts: { linked: 3, waiting: 2, flagged: 2, error: 0 } });
    expect(await destination()).toMatchObject({ halted_at: null, halted_code: null });
    const rows = (await database.pool.query(`SELECT product_variant_id AS v, status, reason_code, error_class, message, attempt_count,
      first_failure_at, busy_since, next_check_at FROM inventory.stock_link_checks WHERE publication_target_id=$1 ORDER BY 1`, [targetId])).rows;
    const due = { attempt_count: 0, first_failure_at: null, busy_since: null, next_check_at: NOW };
    expect(rows).toEqual([
      { v: 101, status: "linked", reason_code: null, error_class: null, message: null, ...due },
      { v: 102, status: "waiting", reason_code: null, error_class: null, message: null, ...due },
      { v: 103, status: "flagged", reason_code: "STOCK_LINK_SKU_DUPLICATE", error_class: null, message: null, ...due },
      { v: 104, status: "linked", reason_code: "STOCK_LINK_LOOKUP_MISSED", error_class: null, message: null, ...due },
      { v: 105, status: "linked", reason_code: null, error_class: null, message: null, attempt_count: 0, first_failure_at: null,
        busy_since: null, next_check_at: new Date(NOW.getTime() + 24 * HOUR_MS) },
      { v: 106, status: "waiting", reason_code: null, error_class: null, message: null, attempt_count: 0, first_failure_at: null,
        busy_since: null, next_check_at: new Date(NOW.getTime() + HOUR_MS) },
      { v: 107, status: "flagged", reason_code: "STOCK_LINK_SKU_DUPLICATE", error_class: null, message: null, ...due },
    ]);
    const [audit] = await controlAudit();
    expect(audit).toMatchObject({ action: "inventory_availability.stock_link.check_requested",
      changes: { before: { halted: { code: "STOCK_LINK_UNCLASSIFIED" } }, after: { halted: null } },
      context: { clearedHalt: true, rowsMadeDue: 5, productVariantIds: [101, 102, 103, 104, 107] } });

    // A row a command holds right now (locked) is skipped, never waited on.
    const holder = await database.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM inventory.stock_link_checks WHERE publication_target_id=$1 AND product_variant_id=101 FOR UPDATE", [targetId]);
      const again = await controls(() => new Date(NOW.getTime() + 30_000)).checkAgain(
        { publicationTargetId: targetId, expectedRevision: (await destination())!.revision }, "operator-1");
      expect(again.counts).toEqual({ linked: 3, waiting: 2, flagged: 2, error: 0 });
      // 102 is waiting now (it has no link), 105's claim still holds it: only the locked row 101 is skipped among the rest.
      expect((await controlAudit()).at(-1)!.context).toMatchObject({ productVariantIds: [103, 104, 107] });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }, CASE_TIMEOUT_MS);

  it("a switch-off waits for a running command's FOR SHARE and answers busy after the lock timeout (PG 15)", async () => {
    await seedStockLinkDestination(database.pool, targetId, AT);
    const command = await database.pool.connect();
    try {
      await command.query("BEGIN");
      await command.query("SELECT 1 FROM inventory.stock_link_destinations WHERE publication_target_id=$1 FOR SHARE", [targetId]);
      await expect(controls().setSwitch({ publicationTargetId: targetId, enabled: false, expectedRevision: (await destination())!.revision },
        "operator-1")).rejects.toMatchObject({ status: 409, code: "STOCK_LINK_DESTINATION_BUSY" });
    } finally {
      await command.query("ROLLBACK");
      command.release();
    }
    expect(await destination()).toMatchObject({ auto_link_enabled: true });
    expect(await controlAudit()).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("counts and samples each Ops Health issue on seeded rows; a target that is not live counts nothing (PG 16)", async () => {
    await addVariants([106, 107]);
    await seedStockLinkDestination(database.pool, targetId, AT);
    await seedCheck(101, { status: "linked" });
    await seedCheck(102, { status: "waiting" });
    await seedCheck(103, { status: "waiting", attemptCount: 8, firstFailureAt: ago(73 * HOUR_MS), reasonCode: "STOCK_LINK_LOOKUP_MISSED" });
    await seedCheck(104, { status: "flagged" });
    await seedCheck(105, { status: "error" });
    await seedCheck(106, { status: "linked", busySince: ago(25 * HOUR_MS) });            // busy streak over a day (TST-9)
    await seedCheck(107, { status: "waiting", attemptCount: 8, firstFailureAt: ago(71 * HOUR_MS) }); // not yet 72 h
    // The heartbeat is old: the runner has not run for 11 minutes.
    await database.pool.query(`UPDATE inventory.stock_link_destinations SET heartbeat_at=$2, updated_at=$2 WHERE publication_target_id=$1`,
      [targetId, ago(11 * 60_000)]);
    expect(await allCounts(NOW)).toEqual({ STOCK_LINK_UNLINKED: 3, STOCK_LINK_FLAGGED: 1, STOCK_LINK_ERROR: 3,
      STOCK_LINK_SKU_CHANGED: 0, STOCK_LINK_DESTINATION_PAUSED: 0, STOCK_LINK_RETIRES_HELD: 0, STOCK_LINK_HALTED: 0, STOCK_LINK_STALLED: 1 });
    expect(await healthSample("STOCK_LINK_UNLINKED", NOW)).toEqual([{ publication_target_id: targetId, channel_id: STOCK_LINK_SHOPIFY.channelId,
      channel_connection_id: STOCK_LINK_SHOPIFY.connectionId, external_scope_id: STOCK_LINK_SHOPIFY.location,
      linked: 2, waiting: 3, flagged: 1, error: 1 }]);
    expect((await healthSample("STOCK_LINK_ERROR", NOW)).map(row => row.product_variant_id).sort()).toEqual([103, 105, 106]);
    expect((await healthSample("STOCK_LINK_FLAGGED", NOW))).toMatchObject([{ product_variant_id: 104, reason_code: "STOCK_LINK_SKU_DUPLICATE" }]);

    // Paused for two hours: PAUSED; the tick still beats a paused destination, so it is not STALLED (TST-9).
    await database.pool.query(`UPDATE inventory.stock_link_destinations SET paused_until=$2, paused_code='STOCK_LINK_STORE_AUTH_REFUSED',
      paused_since=$3 WHERE publication_target_id=$1`, [targetId, new Date(NOW.getTime() + HOUR_MS), ago(2 * HOUR_MS)]);
    await beatStockLinkDestination(database.pool, targetId, NOW);
    expect(await allCounts(NOW)).toMatchObject({ STOCK_LINK_DESTINATION_PAUSED: 1, STOCK_LINK_STALLED: 0 });
    expect(await healthCount("STOCK_LINK_DESTINATION_PAUSED", new Date(NOW.getTime() - 61 * 60_000))).toBe(0);
    // Halted: HALTED; a switched-off destination counts in none of the destination issues.
    await database.pool.query("UPDATE inventory.stock_link_destinations SET halted_at=$2, halted_code='STOCK_LINK_UNCLASSIFIED' WHERE publication_target_id=$1",
      [targetId, NOW]);
    expect(await healthCount("STOCK_LINK_HALTED", NOW)).toBe(1);
    await database.pool.query("UPDATE inventory.stock_link_destinations SET auto_link_enabled=false WHERE publication_target_id=$1", [targetId]);
    expect(await allCounts(new Date(NOW.getTime() + HOUR_MS))).toMatchObject({ STOCK_LINK_DESTINATION_PAUSED: 0, STOCK_LINK_HALTED: 0,
      STOCK_LINK_STALLED: 0, STOCK_LINK_UNLINKED: 3 });

    // The production checks (database clock) run as Ops Health renders them.
    for (const check of STOCK_LINK_HEALTH_CHECKS) {
      const { sql, params } = dialect.sqlToQuery(check.sampleSql);
      await database.pool.query(sql, params as unknown[]);
    }
    // Only live targets count: a stopped store shows nothing. (Legacy authority cannot be shown here: the database
    // refuses to return to legacy after the first canonical cutover, so rows written by the engine can never meet
    // legacy authority; the canonical predicate is pinned in ops-health.stock-link.test.ts. BUILD-NOTES D-P8-7.)
    const revision = (await database.pool.query<{ revision: string }>("SELECT revision::text FROM inventory.inventory_publication_targets WHERE id=$1",
      [targetId])).rows[0]!.revision;
    await new InventoryPublicationTargetStopService(new PostgresInventoryPublicationTargetStopStore(database.pool), { now: () => NOW })
      .stop({ publicationTargetId: targetId, expectedRevision: revision, idempotencyKey: `stop-${targetId}` }, "operator-1");
    expect(Object.values(await allCounts(NOW)).every(count => count === 0)).toBe(true);
  }, CASE_TIMEOUT_MS);

  it("raises a linked size whose SKU changed while no on-sale item carries the new SKU, and drops it once the row is decided again (PG 16, channels PR4 §3.5)", async () => {
    await seedStockLinkDestination(database.pool, targetId, AT);
    await seedCheck(101, { status: "linked", reasonCode: "STOCK_LINK_SKU_CHANGED" });
    await seedCheck(102, { status: "linked" });
    await seedCheck(103, { status: "waiting", reasonCode: "STOCK_LINK_SKU_CHANGED" }); // only a linked row means the old link is kept
    expect(await healthCount("STOCK_LINK_SKU_CHANGED", NOW)).toBe(1);
    expect(await healthSample("STOCK_LINK_SKU_CHANGED", NOW)).toMatchObject([{ publication_target_id: targetId,
      channel_id: STOCK_LINK_SHOPIFY.channelId, channel_connection_id: STOCK_LINK_SHOPIFY.connectionId, product_variant_id: 101,
      status: "linked", reason_code: "STOCK_LINK_SKU_CHANGED" }]);
    // The kill switch leaves it in: stock keeps flowing to the old item either way.
    const off = stockLinkHealthChecks({ now: NOW, runnerOff: true }).find(entry => entry.code === "STOCK_LINK_SKU_CHANGED")!;
    const rendered = dialect.sqlToQuery(off.countSql);
    expect(Number((await database.pool.query(rendered.sql, rendered.params as unknown[])).rows[0]!.count)).toBe(1);
    // A later decision (a relink to the new SKU, or the SKU changed back) records another reason: the size leaves the issue.
    await database.pool.query(`UPDATE inventory.stock_link_checks SET reason_code=NULL, updated_at=$3
      WHERE publication_target_id=$1 AND product_variant_id=$2`, [targetId, 101, NOW]);
    expect(await healthCount("STOCK_LINK_SKU_CHANGED", NOW)).toBe(0);
    expect(await healthSample("STOCK_LINK_SKU_CHANGED", NOW)).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("counts the window's retires exactly as the engine does with equal clocks; RETIRES_HELD only while a retire is held, and Continue makes it due (PG 16, TST-8, review LNK-1/LNK-3)", async () => {
    const ids = Array.from({ length: 27 }, (_, index) => 1001 + index);
    await addVariants(ids);
    await seedStockLinkDestination(database.pool, targetId, AT);
    await retireAt(ids.slice(0, 1), ago(25 * HOUR_MS));   // outside the 24 h window
    await retireAt(ids.slice(1, 25), ago(2 * HOUR_MS));   // 24 inside
    const engine = (now: Date, releasedAt: Date | null) =>
      countStockLinkRetiresWithoutReplacement(database.pool, targetId, STOCK_LINK_ACTOR, stockLinkRetireWindowStart(now, releasedAt));
    expect(await engine(NOW, null)).toBe(24);
    expect(await healthCount("STOCK_LINK_RETIRES_HELD", NOW)).toBe(0);

    // The 25th retire uses the allowance up, but the engine allows it: nothing is held, so nothing is raised (LNK-3).
    await retireAt(ids.slice(25, 26), ago(HOUR_MS));
    expect(await engine(NOW, null)).toBe(25);
    expect(await healthCount("STOCK_LINK_RETIRES_HELD", NOW)).toBe(0);
    expect(await controls().status({ publicationTargetId: String(targetId) })).toMatchObject({ retiresHeld: null });

    // The 26th is held: the engine kept its link and records the hold, due in 24 h (stockLinkCheckAfterDecision).
    await sealStockLink(database.pool, targetId, 1027, "91027", { sku: "SL-1027" });
    await seedCheck(1027, { status: "linked", reasonCode: "STOCK_LINK_RETIRES_HELD", nextCheckAt: new Date(NOW.getTime() + 24 * HOUR_MS) });
    expect(await healthCount("STOCK_LINK_RETIRES_HELD", NOW)).toBe(1);
    expect(await healthSample("STOCK_LINK_RETIRES_HELD", NOW)).toMatchObject([{ publication_target_id: targetId, retires_held: 1,
      retires_in_window: 25 }]);
    // Same rows, other equal clocks: 22 h 1 min later only the last retire is still in the window, on both sides.
    const later = new Date(NOW.getTime() + 22 * HOUR_MS + 60_000);
    expect(await engine(later, null)).toBe(1);
    expect(await healthSample("STOCK_LINK_RETIRES_HELD", later)).toMatchObject([{ retires_in_window: 1 }]);

    const status = await controls().status({ publicationTargetId: String(targetId) });
    expect(status).toMatchObject({ retiresHeld: { count: 1, limit: 25, windowHours: 24 } });
    const continued = await controls().continue({ publicationTargetId: targetId, expectedRevision: (status as { revision: string }).revision },
      "operator-1");
    expect(continued.retiresHeld).toBeNull();
    expect(await destination()).toMatchObject({ retires_released_at: NOW, retires_released_by: "operator-1" });
    // LNK-1: the held size is due now, so the next tick decides it with the released window, not in 24 h.
    expect(await readStockLinkCheck(database.pool, targetId, 1027)).toMatchObject({ status: "linked", reason_code: "STOCK_LINK_RETIRES_HELD",
      next_check_at: NOW });
    expect([await engine(NOW, NOW), await healthCount("STOCK_LINK_RETIRES_HELD", NOW)]).toEqual([0, 0]);
    expect((await controlAudit()).at(-1)).toMatchObject({ action: "inventory_availability.stock_link.continued",
      context: { retiresHeld: true, releasedRetires: true, resumedPause: false, rowsMadeDue: 1, productVariantIds: [1027] } });
    // Nothing held or paused any more: Continue changes nothing and writes no audit row.
    const audits = (await controlAudit()).length;
    await controls().continue({ publicationTargetId: targetId, expectedRevision: continued.revision }, "operator-1");
    expect(await controlAudit()).toHaveLength(audits);
  }, CASE_TIMEOUT_MS);

  it("Continue retries a pause now and keeps its start, so a store that still refuses keeps its PAUSED clock (PG 15, 16)", async () => {
    await seedStockLinkDestination(database.pool, targetId, AT);
    await database.pool.query(`UPDATE inventory.stock_link_destinations SET paused_until=$2, paused_code='STOCK_LINK_STORE_NOT_ANSWERING',
      paused_since=$3, revision=revision+1 WHERE publication_target_id=$1`, [targetId, new Date(NOW.getTime() + HOUR_MS), ago(2 * HOUR_MS)]);
    const result = await controls().continue({ publicationTargetId: targetId, expectedRevision: (await destination())!.revision }, "operator-1");
    expect(result.paused).toEqual({ code: "STOCK_LINK_STORE_NOT_ANSWERING", since: ago(2 * HOUR_MS).toISOString(), until: NOW.toISOString() });
    expect(await healthCount("STOCK_LINK_DESTINATION_PAUSED", NOW)).toBe(1);
  }, CASE_TIMEOUT_MS);

  it("links two Shopify stores (US and Canada) independently, each read with its own destination; one switch stops one store (PG 17)", async () => {
    const CANADA = { channelId: 37, connectionId: 11, location: "55555" };
    const ITEM_CA = "555";
    await installStockLinkConnectionColumns(database.pool);
    await installStockLinkTickColumns(database.pool);
    await database.pool.query(`INSERT INTO channels.channels(id,name,provider,status) VALUES($1,'Card Shellz Canada','shopify','active');
      INSERT INTO channels.channel_connections(id,channel_id,shop_domain,access_token,shopify_location_id)
        VALUES($2,$1,'card-shellz-ca.myshopify.com','fixture-token-ca',$3)`.replaceAll("$1", String(CANADA.channelId))
      .replaceAll("$2", String(CANADA.connectionId)).replaceAll("$3", `'${CANADA.location}'`));
    // Canada's own reviewed exposure policy (the US store's is channel 35's, from the fixture).
    const policy = await database.pool.connect();
    try {
      await policy.query("BEGIN");
      const version = (await policy.query<{ id: number }>(`INSERT INTO inventory.channel_exposure_policy_versions(scope_key,channel_id,scope_type,version,
          allocation_semantics,eligible,share_bps,holdback_sellable_units,max_publish_mode,min_publish_sellable_units,definition_hash,change_reason,
          idempotency_key,request_hash,created_by)
        VALUES('channel:37',37,'channel',1,'exposure',true,10000,0,'unlimited',0,repeat('e',64),'Full exposure','canada-exposure',repeat('e',64),'operator')
        RETURNING id`)).rows[0]!.id;
      await policy.query(`INSERT INTO inventory.channel_exposure_policy_heads(scope_key,channel_id,draft_policy_id,revision,updated_by,update_reason)
        VALUES('channel:37',37,$1,1,'operator','Reviewed exposure')`, [version]);
      await policy.query("UPDATE inventory.channel_exposure_policy_versions SET lifecycle_status='sealed',sealed_by='operator',sealed_at=$2 WHERE id=$1",
        [version, AT]);
      await policy.query(`UPDATE inventory.channel_exposure_policy_heads SET active_policy_id=draft_policy_id,draft_policy_id=NULL,revision=revision+1
        WHERE scope_key='channel:37'`);
      await policy.query("COMMIT");
    } catch (error) {
      await policy.query("ROLLBACK");
      throw error;
    } finally {
      policy.release();
    }
    const canadaId = await createLiveShopifyTarget(database.pool, CANADA);
    await addShopifyFeed(database.pool, 101, ITEM_A, { sku: "P5" });
    await addShopifyFeed(database.pool, 101, ITEM_CA, { sku: "P5", channelId: CANADA.channelId });

    // Each store answers from its own items; the stub records which destination each read was made for.
    const shops = new Map<number, Map<string, StockLinkStoreItem>>([
      [targetId, new Map([[ITEM_A, { itemId: ITEM_A, sku: "P5", productId: "9001", productStatus: "ACTIVE" }]])],
      [canadaId, new Map([[ITEM_CA, { itemId: ITEM_CA, sku: "P5", productId: "9002", productStatus: "ACTIVE" }]])],
    ]);
    const reads: Array<{ target: number; connection: number | null; kind: string }> = [];
    const source = createShopifyStockLinkSource();
    const adapter: StockLinkAdapter = {
      destinationKind: "channel_connection", providerKey: "shopify",
      async findItemsBySku(dest, skus) {
        reads.push({ target: dest.publicationTargetId, connection: dest.channelConnectionId, kind: "lookup" });
        const keys = new Set(skus.map(sku => normalizeStockLinkSku(sku)).flatMap(sku => sku.kind === "sku" ? [sku.key] : []));
        return { observedAt: now.toISOString(), readFingerprint: await source.readFingerprint(database.pool, dest), skus: [...skus],
          items: [...shops.get(dest.publicationTargetId)!.values()].filter(item => {
            const sku = normalizeStockLinkSku(item.sku); return sku.kind === "sku" && keys.has(sku.key); }) };
      },
      async observeItems(dest, itemIds) {
        reads.push({ target: dest.publicationTargetId, connection: dest.channelConnectionId, kind: "observe" });
        return { observedAt: now.toISOString(), readFingerprint: await source.readFingerprint(database.pool, dest),
          observations: itemIds.map(itemId => ({ itemId, item: shops.get(dest.publicationTargetId)!.get(itemId) ?? null })) };
      },
    };
    let now = new Date(AT);
    let leases = 0;
    const tick = () => createStockLinkService({ pool: database.pool, bindings: [{ adapter, source }], clock: () => now,
      monotonicNow: () => 0, random: () => 0.5, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      newLeaseToken: () => `00000000-0000-4000-8000-${String(++leases).padStart(12, "0")}` }).tick();
    const linkedItem = async (id: number) => (await database.pool.query<{ item: string | null }>(`SELECT a.external_inventory_item_id AS item
      FROM inventory.publication_variant_mapping_heads h LEFT JOIN inventory.publication_variant_mapping_versions a ON a.id=h.active_mapping_id
      WHERE h.publication_target_id=$1 AND h.product_variant_id=101`, [id])).rows[0]?.item ?? null;

    expect(await tick()).toMatchObject({ destinations: 2, links: 2 });
    expect(await linkedItem(targetId)).toBe(ITEM_A);
    expect(await linkedItem(canadaId)).toBe(ITEM_CA);
    expect(new Set(reads.map(read => `${read.target}:${read.connection}`)))
      .toEqual(new Set([`${targetId}:${STOCK_LINK_SHOPIFY.connectionId}`, `${canadaId}:${CANADA.connectionId}`]));
    expect((await database.pool.query("SELECT publication_target_id AS t, external_inventory_item_id_snapshot AS item FROM inventory.inventory_publication_outbox ORDER BY 1"))
      .rows).toEqual([{ t: targetId, item: ITEM_A }, { t: canadaId, item: ITEM_CA }]);

    // Canada's store replaces its item; Canada's linking is switched off: only the US store is looked after.
    shops.set(canadaId, new Map([[ITEM_NEW, { itemId: ITEM_NEW, sku: "P5", productId: "9002", productStatus: "ACTIVE" }]]));
    const canadaStatus = await controls(() => now).status({ publicationTargetId: String(canadaId) });
    await controls(() => now).setSwitch({ publicationTargetId: canadaId, enabled: false,
      expectedRevision: (canadaStatus as { revision: string }).revision }, "operator-1");
    await controls(() => now).checkAgain({ publicationTargetId: targetId, expectedRevision: (await destination())!.revision }, "operator-1");
    await controls(() => now).checkAgain({ publicationTargetId: canadaId, expectedRevision: (await destination(canadaId))!.revision }, "operator-1");
    now = new Date(Date.parse(AT) + 2 * 60_000);
    reads.length = 0;
    expect(await tick()).toMatchObject({ destinations: 1 });
    expect(reads.every(read => read.target === targetId)).toBe(true);
    expect(await linkedItem(canadaId)).toBe(ITEM_CA);
    expect(await linkedItem(targetId)).toBe(ITEM_A);
  }, CASE_TIMEOUT_MS);
});
