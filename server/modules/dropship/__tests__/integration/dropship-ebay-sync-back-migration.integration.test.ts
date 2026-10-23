import { createHash } from "node:crypto";
import pg, { type Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeMigrationWithRetry, type MigrationRetryNotice } from "../../../../../migrations/migration-executor";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { MARKETPLACE_ISSUE_CODES } from "../../domain/marketplace-sync-decision";
import {
  EBAY_SYNC_BACK_MIGRATION_FILE,
  ebaySyncBackBaseFixtureSql,
  ebaySyncBackMigrationSql,
  installEbaySyncBackSchema,
} from "../fixtures/ebay-sync-back.fixture";

/**
 * The eBay sync-back migration against a real PostgreSQL (plan v4 §8, §11
 * PG): applied once by the release executor, with a lock wait on its first
 * statement leaving nothing behind; rows that existed before read exactly as
 * before; every new constraint refuses what it should; and the recreated
 * publication selection trigger re-plans on a limit change and on nothing
 * new else (FF-15).
 */
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const VENDOR = 10;
const STORE = 22;
const OTHER_VENDOR = 11;
const OTHER_STORE = 23;
const AT = "2026-10-22T12:00:00.000Z";

describeDatabase.sequential("eBay sync-back migration (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  let pool: Pool;
  let wide: pg.Pool;
  const notices: MigrationRetryNotice[] = [];
  let beforeRetry: unknown[] = [];
  let attempts = 0;
  let existingListingId = 0;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, ebaySyncBackBaseFixtureSql);
    pool = database.pool;
    wide = new pg.Pool({ connectionString: database.connectionString, max: 4 });
    await installEbaySyncBackSchema(pool, { applyMigration: false });
    // Rows written by the release before this one.
    await pool.query(`
      INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (${VENDOR}, 'member-10'), (${OTHER_VENDOR}, 'member-11');
      INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, last_order_sync_at)
        VALUES (${STORE}, ${VENDOR}, 'ebay', '${AT}'), (${OTHER_STORE}, ${OTHER_VENDOR}, 'ebay', NULL);
      INSERT INTO catalog.products (id, product_type) VALUES (20, 'toploader'), (21, 'sleeve');
      INSERT INTO catalog.product_variants (id, product_id, sku) VALUES (101, 20, 'CS-101'), (102, 21, 'CS-102'), (103, 20, 'CS-103');
      INSERT INTO dropship.dropship_order_intake (vendor_id, store_connection_id, external_order_id, status)
        VALUES (${VENDOR}, ${STORE}, 'ORDER-1', 'retrying');`);
    existingListingId = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_vendor_listings
      (vendor_id, store_connection_id, product_variant_id, platform, external_listing_id, external_offer_id, status, pushed_quantity, quantity_cap)
      VALUES (${VENDOR}, ${STORE}, 101, 'ebay', '110000000001', 'OFFER-1', 'active', 10, 10) RETURNING id`)).rows[0]!.id;

    // The previous release holds order intake while the release runs: the file's first statement waits on it and
    // times out (55P03) after taking the first two tables; the retry runs once the writer commits.
    const blocker = await wide.connect();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE dropship.dropship_order_intake IN ROW EXCLUSIVE MODE");
    const migrationClient = await wide.connect();
    const sql = ebaySyncBackMigrationSql();
    try {
      const result = await executeMigrationWithRetry({
        client: migrationClient, file: EBAY_SYNC_BACK_MIGRATION_FILE, sql,
        contentHash: createHash("sha256").update(sql).digest("hex"),
        options: { maxAttempts: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 1, lockTimeoutMs: 300 },
        onRetry: (notice) => { notices.push(notice); },
        sleep: async () => {
          beforeRetry = (await wide.query(`SELECT to_regclass('dropship.dropship_listing_marketplace_sales') AS sales,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'dropship' AND table_name = 'dropship_vendor_listings'
              AND column_name = 'vendor_quantity_limit') AS limit_column,
            (SELECT count(*)::int FROM public._migrations) AS applied`)).rows;
          await blocker.query("COMMIT");
        },
      });
      attempts = result.attempts;
    } finally {
      migrationClient.release();
      blocker.release();
    }
  }, 120_000);

  afterAll(async () => {
    await wide?.end();
    await database?.close();
  });

  /** Statements in one transaction that is always rolled back. */
  async function rolledBack(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await work(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  /** One statement in its own rolled-back transaction, so a refusal leaves nothing behind. */
  async function refused(sql: string, code: string, constraint?: string): Promise<void> {
    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      const error = await client.query(sql).then(() => null, (caught: unknown) => caught);
      expect(error, sql).toMatchObject({ code, ...(constraint ? { constraint } : {}) });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  it("applies once through the release executor; a lock wait on its first statement left nothing behind", async () => {
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ file: EBAY_SYNC_BACK_MIGRATION_FILE, attempt: 1, sqlState: "55P03" });
    expect(beforeRetry).toEqual([{ sales: null, limit_column: false, applied: 0 }]);
    expect(attempts).toBe(2);
    expect((await pool.query("SELECT filename FROM public._migrations")).rows).toEqual([{ filename: EBAY_SYNC_BACK_MIGRATION_FILE }]);
    // Not written to be re-run: a second application fails loudly and changes nothing.
    await refused(ebaySyncBackMigrationSql(), "42701");
  });

  it("leaves every existing row reading as before: no limit, no observation, no issue, never read", async () => {
    const listing = (await pool.query(`SELECT quantity_cap, vendor_quantity_limit, marketplace_issue_codes,
      marketplace_sync_attempted_at, observed_marketplace_quantity, marketplace_quantity_baseline, marketplace_ended_at,
      observed_fulfillment_policy_id FROM dropship.dropship_vendor_listings WHERE id = $1`, [existingListingId])).rows[0];
    expect(listing).toEqual({ quantity_cap: 10, vendor_quantity_limit: null, marketplace_issue_codes: [],
      marketplace_sync_attempted_at: null, observed_marketplace_quantity: null, marketplace_quantity_baseline: null,
      marketplace_ended_at: null, observed_fulfillment_policy_id: null });
    // Nothing of a vendor's eBay title or description, and no content baseline, is stored anywhere (owner rules 2 and 3).
    expect((await pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'dropship'
      AND (column_name LIKE 'marketplace_title%' OR column_name LIKE 'marketplace_description%' OR column_name LIKE 'content_baseline%'
        OR column_name LIKE 'content_notified%' OR column_name LIKE 'vendor_quantity_cap%')`)).rows).toEqual([]);
    expect((await pool.query(`SELECT processing_attempt_count, next_processing_attempt_at, marketplace_cancelled_at, marketplace_status_checked_at
      FROM dropship.dropship_order_intake`)).rows).toEqual([{ processing_attempt_count: 0, next_processing_attempt_at: null,
      marketplace_cancelled_at: null, marketplace_status_checked_at: null }]);
    expect((await pool.query(`SELECT marketplace_sales_ledger_since FROM dropship.dropship_store_connections ORDER BY id`)).rows)
      .toEqual([{ marketplace_sales_ledger_since: null }, { marketplace_sales_ledger_since: null }]);
    for (const table of ["dropship_listing_marketplace_sales", "dropship_listing_previous_marketplace_ids", "dropship_unmatched_marketplace_orders",
      "dropship_ebay_fulfillment_policy_checks", "dropship_marketplace_sync_notices"]) {
      expect((await pool.query(`SELECT count(*)::int AS count FROM dropship.${table}`)).rows[0]).toEqual({ count: 0 });
    }
  });

  it("adds the CHECKs on existing tables NOT VALID (no scan under the lock), and they still check every new write", async () => {
    const constraints = await pool.query<{ conname: string; convalidated: boolean }>(`SELECT conname, convalidated FROM pg_constraint
      WHERE conrelid IN ('dropship.dropship_vendor_listings'::regclass, 'dropship.dropship_order_intake'::regclass) AND contype = 'c'
        AND conname NOT IN
        ('dropship_listing_platform_chk','dropship_listing_status_chk','dropship_listing_price_chk','dropship_listing_qty_chk','dropship_order_intake_status_chk')
        ORDER BY conname`);
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      "dropship_listing_marketplace_issue_codes_chk", "dropship_listing_observed_policy_chk", "dropship_listing_qty_baseline_chk",
      "dropship_listing_qty_baseline_pair_chk", "dropship_listing_qty_observed_chk", "dropship_listing_qty_observed_pair_chk",
      "dropship_listing_vendor_quantity_limit_chk", "dropship_order_intake_attempt_count_chk",
    ]);
    expect(constraints.rows.every((row) => row.convalidated === false)).toBe(true);
  });

  it("refuses bad listing sync state", async () => {
    const update = (set: string) => `UPDATE dropship.dropship_vendor_listings SET ${set} WHERE id = ${existingListingId}`;
    await refused(update(`marketplace_issue_codes = ARRAY['made_up']`), "23514", "dropship_listing_marketplace_issue_codes_chk");
    await refused(update(`marketplace_issue_codes = ARRAY['vendor_content_unusable']`), "23514", "dropship_listing_marketplace_issue_codes_chk");
    await refused(update(`vendor_quantity_limit = -1`), "23514", "dropship_listing_vendor_quantity_limit_chk");
    await refused(update(`marketplace_quantity_baseline = 3`), "23514", "dropship_listing_qty_baseline_pair_chk");
    await refused(update(`marketplace_quantity_baseline = -1, marketplace_quantity_baseline_at = now()`), "23514", "dropship_listing_qty_baseline_chk");
    await refused(update(`observed_marketplace_quantity_at = now()`), "23514", "dropship_listing_qty_observed_pair_chk");
    await refused(update(`observed_marketplace_quantity = -2, observed_marketplace_quantity_at = now()`), "23514", "dropship_listing_qty_observed_chk");
    await refused(update(`observed_fulfillment_policy_id = '  '`), "23514", "dropship_listing_observed_policy_chk");
    await refused(update(`marketplace_issue_codes = NULL`), "23502");
    // Every listed code is accepted, and 0 is a valid limit.
    await rolledBack(async (client) => {
      await client.query(update(`marketplace_issue_codes = $1::text[], vendor_quantity_limit = 0`), [[...MARKETPLACE_ISSUE_CODES]]);
    });
  });

  it("refuses bad sales, previous ids, parked lines, policy verdicts and notices", async () => {
    const sale = (values: string) => `INSERT INTO dropship.dropship_listing_marketplace_sales (store_connection_id, listing_id,
      external_order_id, external_line_item_id, quantity, ordered_at, first_seen_at) VALUES (${values})`;
    await refused(sale(`${STORE}, ${existingListingId}, 'O-1', 'L-1', 0, now(), now()`), "23514", "dropship_listing_sale_quantity_chk");
    await refused(sale(`${STORE}, ${existingListingId}, ' ', 'L-1', 1, now(), now()`), "23514", "dropship_listing_sale_order_chk");
    await refused(sale(`${STORE}, ${existingListingId}, 'O-1', '', 1, now(), now()`), "23514", "dropship_listing_sale_line_chk");
    await refused(`${sale(`${STORE}, ${existingListingId}, 'O-1', 'L-1', 1, now(), now()`)}; ${sale(`${STORE}, ${existingListingId}, 'O-1', 'L-1', 2, now(), now()`)}`,
      "23505", "dropship_listing_sale_line_uk");

    const previous = (vendor: number, store: number, id: string, reason = "relisted") => `INSERT INTO dropship.dropship_listing_previous_marketplace_ids
      (listing_id, vendor_id, store_connection_id, external_listing_id, reason, replaced_at) VALUES (${existingListingId}, ${vendor}, ${store}, '${id}', '${reason}', now())`;
    await refused(previous(OTHER_VENDOR, STORE, "1"), "23503", "dropship_listing_prev_store_owner_fk");
    await refused(previous(VENDOR, STORE, "1", "moved"), "23514", "dropship_listing_prev_reason_chk");
    await refused(`${previous(VENDOR, STORE, "1")}; ${previous(VENDOR, STORE, "1", "republished")}`, "23505", "dropship_listing_prev_id_uk");

    const parked = (status: string, resolved: string, line = "L-1") => `INSERT INTO dropship.dropship_unmatched_marketplace_orders (vendor_id,
      store_connection_id, external_order_id, external_line_item_id, external_listing_id, sku, candidate_listing_id, status, reason,
      first_seen_at, last_checked_at, resolved_at) VALUES (${VENDOR}, ${STORE}, 'O-1', '${line}', '119', 'CS-101', ${existingListingId},
      '${status}', 'unmatched_sku', now(), now(), ${resolved})`;
    await refused(parked("open", "now()"), "23514", "dropship_unmatched_resolved_chk");
    await refused(parked("relinked", "NULL"), "23514", "dropship_unmatched_resolved_chk");
    await refused(parked("lost", "now()"), "23514", "dropship_unmatched_status_chk");
    await refused(`${parked("open", "NULL")}; ${parked("expired", "now()")}`, "23505", "dropship_unmatched_order_line_uk");

    const verdict = (hash: string, notified = "NULL") => `INSERT INTO dropship.dropship_ebay_fulfillment_policy_checks (store_connection_id,
      fulfillment_policy_id, compatible, verdict_hash, notified_verdict_hash, checked_at) VALUES (${STORE}, 'F-1', false, ${hash}, ${notified}, now())`;
    await refused(verdict(`'abc'`), "23514", "dropship_ebay_policy_check_verdict_chk");
    await refused(verdict(`repeat('a', 64)`, `'x'`), "23514", "dropship_ebay_policy_check_notified_chk");
    await refused(`${verdict(`repeat('a', 64)`)}; ${verdict(`repeat('b', 64)`)}`, "23505");

    const notice = (overrides: Partial<Record<string, string>> = {}) => {
      const values = { vendor: String(VENDOR), kind: "'price_below_cost'", subject: "'below-cost:1:2026-10-22'",
        payload: "'{}'::jsonb", batch: "NULL", sent: "NULL", ...overrides };
      return `INSERT INTO dropship.dropship_marketplace_sync_notices (vendor_id, store_connection_id, kind, subject_key, payload,
        created_at, batch_key, sent_at) VALUES (${values.vendor}, ${STORE}, ${values.kind}, ${values.subject},
        ${values.payload}, now(), ${values.batch}, ${values.sent})`;
    };
    await refused(notice({ vendor: String(OTHER_VENDOR) }), "23503", "dropship_sync_notice_store_owner_fk");
    await refused(notice({ kind: "'Price Kept'" }), "23514", "dropship_sync_notice_kind_chk");
    await refused(notice({ subject: "'listing 1'" }), "23514", "dropship_sync_notice_subject_chk");
    await refused(notice({ payload: "'[]'::jsonb" }), "23514", "dropship_sync_notice_payload_chk");
    await refused(notice({ sent: "now()" }), "23514", "dropship_sync_notice_sent_chk");
    await refused(notice({ batch: "'bad key!'" }), "23514", "dropship_sync_notice_batch_chk");
    await refused(`${notice()}; ${notice()}`, "23505", "dropship_sync_notice_subject_uk");

    await refused(`UPDATE dropship.dropship_order_intake SET processing_attempt_count = -1`, "23514", "dropship_order_intake_attempt_count_chk");
  });

  it("cascades with the listing and the store, and lets a parked line outlive its candidate", async () => {
    await rolledBack(async (client) => {
      const listing = (await client.query<{ id: number }>(`INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id,
        product_variant_id, platform, status) VALUES (${VENDOR}, ${STORE}, 103, 'ebay', 'active') RETURNING id`)).rows[0]!.id;
      await client.query(`INSERT INTO dropship.dropship_listing_marketplace_sales (store_connection_id, listing_id, external_order_id,
        external_line_item_id, quantity, ordered_at, first_seen_at) VALUES (${STORE}, $1, 'O-9', 'L-9', 1, now(), now())`, [listing]);
      await client.query(`INSERT INTO dropship.dropship_listing_previous_marketplace_ids (listing_id, vendor_id, store_connection_id,
        external_listing_id, reason, replaced_at) VALUES ($1, ${VENDOR}, ${STORE}, '9', 'relisted', now())`, [listing]);
      await client.query(`INSERT INTO dropship.dropship_unmatched_marketplace_orders (vendor_id, store_connection_id, external_order_id,
        external_line_item_id, external_listing_id, sku, candidate_listing_id, status, reason, first_seen_at, last_checked_at)
        VALUES (${VENDOR}, ${STORE}, 'O-8', 'L-8', '8', 'CS-103', $1, 'open', 'unmatched_sku', now(), now())`, [listing]);
      await client.query(`DELETE FROM dropship.dropship_vendor_listings WHERE id = $1`, [listing]);
      const counts = (await client.query(`SELECT (SELECT count(*)::int FROM dropship.dropship_listing_marketplace_sales WHERE listing_id = $1) AS sales,
        (SELECT count(*)::int FROM dropship.dropship_listing_previous_marketplace_ids WHERE listing_id = $1) AS previous,
        (SELECT candidate_listing_id FROM dropship.dropship_unmatched_marketplace_orders WHERE external_order_id = 'O-8') AS candidate`, [listing])).rows[0];
      expect(counts).toEqual({ sales: 0, previous: 0, candidate: null });
      // A store connection's own rows go with it.
      await client.query(`INSERT INTO dropship.dropship_unmatched_marketplace_orders (vendor_id, store_connection_id, external_order_id,
        external_line_item_id, external_listing_id, sku, status, reason, first_seen_at, last_checked_at)
        VALUES (${OTHER_VENDOR}, ${OTHER_STORE}, 'O-7', 'L-7', '7', 'CS-102', 'open', 'unmatched_sku', now(), now())`);
      await client.query(`INSERT INTO dropship.dropship_marketplace_sync_notices (vendor_id, store_connection_id, kind, subject_key,
        payload, created_at) VALUES (${OTHER_VENDOR}, ${OTHER_STORE}, 'offer_missing', 'listing:1:offer-missing', '{}', now())`);
      await client.query(`DELETE FROM dropship.dropship_store_connections WHERE id = ${OTHER_STORE}`);
      expect((await client.query(`SELECT (SELECT count(*)::int FROM dropship.dropship_unmatched_marketplace_orders WHERE store_connection_id = ${OTHER_STORE}) AS parked,
        (SELECT count(*)::int FROM dropship.dropship_marketplace_sync_notices WHERE store_connection_id = ${OTHER_STORE}) AS notices`)).rows[0])
        .toEqual({ parked: 0, notices: 0 });
    });
  });

  it("creates the indexes the sweep, the ledger, the outbox and order intake read by", async () => {
    const indexes = await pool.query<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'dropship'
      AND indexname IN ('dropship_listing_marketplace_sync_due_idx','dropship_listing_marketplace_issues_idx','dropship_listing_sale_window_idx',
        'dropship_listing_prev_listing_idx','dropship_unmatched_open_item_idx','dropship_unmatched_open_age_idx','dropship_unmatched_candidate_idx',
        'dropship_sync_notice_pending_idx','dropship_order_intake_retry_due_idx','dropship_order_intake_accepted_check_idx') ORDER BY indexname`);
    expect(indexes.rows).toHaveLength(10);
    const due = indexes.rows.find((row) => row.indexname === "dropship_listing_marketplace_sync_due_idx")!.indexdef;
    expect(due).toContain("(store_connection_id, marketplace_sync_attempted_at NULLS FIRST, id)");
    expect(due).toContain("WHERE (((platform)::text = 'ebay'::text) AND (external_offer_id IS NOT NULL))");
    expect(indexes.rows.find((row) => row.indexname === "dropship_listing_marketplace_issues_idx")!.indexdef).toContain("USING gin");
  });

  describe("the recreated publication selection trigger (FF-15)", () => {
    async function selectionRevision(client: PoolClient): Promise<string | null> {
      return (await client.query<{ revision: string }>(`SELECT revision::text FROM inventory.publication_selection_work WHERE product_id = 20`)).rows[0]?.revision ?? null;
    }

    it("re-plans the product when the vendor's limit changes, and not when the preview snapshot or sync state changes", async () => {
      const client = await pool.connect();
      try {
        // Each step commits, so each is its own invalidation (0743 coalesces repeats inside one transaction).
        // A mapped Card Shellz size makes its product's selection work real (0743's invalidate needs an active mapping).
        await client.query("INSERT INTO inventory.publication_variant_mapping_heads VALUES (3, 101, 401)");
        await client.query("TRUNCATE inventory.publication_selection_work");
        const step = async (sql: string) => {
          await client.query("BEGIN");
          await client.query(sql, [existingListingId]);
          await client.query("COMMIT");
          return selectionRevision(client);
        };
        expect(await step("UPDATE dropship.dropship_vendor_listings SET quantity_cap = 4 WHERE id = $1")).toBeNull();
        expect(await step(`UPDATE dropship.dropship_vendor_listings SET marketplace_issue_codes = '{ended_out_of_stock}',
          marketplace_sync_attempted_at = now(), observed_marketplace_quantity = 4, observed_marketplace_quantity_at = now() WHERE id = $1`)).toBeNull();
        expect(await step("UPDATE dropship.dropship_vendor_listings SET vendor_quantity_limit = 4 WHERE id = $1")).toBe("1");
        expect(await step("UPDATE dropship.dropship_vendor_listings SET vendor_quantity_limit = 4 WHERE id = $1")).toBe("1");
        // A raised limit (owner rule 1) and a cleared one re-plan too.
        expect(await step("UPDATE dropship.dropship_vendor_listings SET vendor_quantity_limit = 9 WHERE id = $1")).toBe("2");
        expect(await step("UPDATE dropship.dropship_vendor_listings SET vendor_quantity_limit = NULL WHERE id = $1")).toBe("3");
        // The columns 0743 watched still re-plan.
        expect(await step("UPDATE dropship.dropship_vendor_listings SET status = 'paused' WHERE id = $1")).toBe("4");
        expect(await step("UPDATE dropship.dropship_vendor_listings SET external_offer_id = 'OFFER-2' WHERE id = $1")).toBe("5");
        const trigger = (await client.query<{ definition: string }>(`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
          WHERE tgrelid = 'dropship.dropship_vendor_listings'::regclass AND tgname = 'publication_selection_invalidation'`)).rows;
        expect(trigger).toHaveLength(1);
        expect(trigger[0]!.definition).toContain("UPDATE OF vendor_id, store_connection_id, product_variant_id, status, external_listing_id, external_offer_id, vendor_quantity_limit");
        expect(trigger[0]!.definition).not.toContain("quantity_cap,");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    });
  });
});
