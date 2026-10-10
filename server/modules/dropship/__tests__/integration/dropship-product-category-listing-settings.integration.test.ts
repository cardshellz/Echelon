import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProductListingSettingBulkPatch,
  ProductListingSettingPatch,
} from "../../../../../shared/dropship/listing-setting-values";
import type { ListingSettingWriteTransaction } from "../../application/dropship-listing-setting-writes";
import { DropshipError } from "../../domain/errors";
import { listingSettingChildKey, listingSettingRequestHash } from "../../domain/listing-setting-values";
import { PgDropshipListingSettingWritesRepository } from "../../infrastructure/dropship-listing-setting-writes.repository";
import { PgDropshipPricingRulesRepository } from "../../infrastructure/dropship-pricing-rules.repository";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testUrl && disposable ? describe : describe.skip;
const NOW = new Date("2026-10-10T12:00:00.000Z");
const LATER = new Date("2026-10-11T08:15:00.000Z");
const EARLIER = new Date("2026-10-09T07:45:00.000Z");

/** The earlier migrations PR 8's writers run on (owner index, prices, reviews, content, eBay category rules, inherit mode). */
const PRIOR_MIGRATIONS = [
  "0657_dropship_listing_price_settings.sql", "0659_dropship_store_pricing_rules.sql",
  "0660_dropship_vendor_listing_content.sql", "0717_dropship_ebay_category_rules.sql",
  "0735_dropship_listing_price_inherit_mode.sql",
];
const PR8_MIGRATIONS = [
  "0736_dropship_product_listing_settings.sql", "0737_dropship_category_listing_settings.sql",
  "0738_dropship_pricing_review_kind.sql",
];

/**
 * Every object the migrations, the fixture and the writers name. Each maps
 * into one isolated schema, and any other name fails the test, so a writer
 * that reaches a new table is seen here first.
 */
const OBJECTS: ReadonlySet<string> = new Set([
  "dropship.dropship_vendors", "dropship.dropship_store_connections", "dropship.dropship_audit_events",
  "dropship.dropship_catalog_rules", "dropship.dropship_vendor_selection_rules", "dropship.dropship_vendor_variant_overrides",
  "dropship.dropship_listing_price_revisions", "dropship.dropship_listing_price_settings",
  "dropship.dropship_pricing_profile_revisions", "dropship.dropship_pricing_profiles",
  "dropship.dropship_pricing_reviews", "dropship.dropship_pricing_applications",
  "dropship.dropship_content_profile_revisions", "dropship.dropship_content_profiles",
  "dropship.dropship_listing_content_revisions", "dropship.dropship_listing_content_settings",
  "dropship.dropship_ebay_category_rule_revisions", "dropship.dropship_ebay_category_rule_profiles",
  "dropship.dropship_product_listing_setting_requests", "dropship.dropship_product_listing_setting_revisions",
  "dropship.dropship_product_listing_settings",
  "dropship.dropship_category_listing_setting_revisions", "dropship.dropship_category_listing_settings",
  "dropship.dropship_product_category_seen",
  "dropship.guard_listing_price_revision_immutable", "dropship.guard_listing_price_setting_coherence",
  "dropship.guard_pricing_profile_coherence", "dropship.guard_content_revision_immutable",
  "dropship.guard_content_profile_coherence", "dropship.guard_listing_content_coherence",
  "dropship.guard_ebay_category_rule_revision_immutable", "dropship.guard_ebay_category_rule_profile_coherence",
  "dropship.guard_product_listing_setting_revision_immutable", "dropship.guard_product_listing_setting_coherence",
  "dropship.guard_product_listing_setting_request_append_only",
  "dropship.guard_category_listing_setting_revision_immutable", "dropship.guard_category_listing_setting_coherence",
  "dropship.guard_product_category_seen",
  "catalog.products", "catalog.product_variants", "catalog.product_categories", "catalog.product_line_products",
]);

const MEMBER = "member-1";
const VENDOR = 10;
const STORE = 22;
const SECOND_STORE = 24; // vendor 10 too
const OTHER_VENDOR_STORE = 23; // vendor 11
const TOPLOADERS = 3;
const SLEEVES = 5;
const PRODUCT = 7; // Toploaders, sizes 101 and 102
const SECOND_PRODUCT = 8; // Toploaders, no sizes
const THIRD_PRODUCT = 9; // Sleeves, no sizes
const MISSING = 999;
const BULK_FIRST_PRODUCT = 1001;
const BULK_PRODUCTS = 10_000;
/** The 10,000-product cases measure, never assert, their time; this only keeps a slow runner from failing them. */
const BULK_TEST_TIMEOUT_MS = 240_000;
const HEAVY_TEXT_LENGTH = 4_000;
const HEAP_SAMPLE_INTERVAL_MS = 20;

/** Upper bound on every wait in the concurrency tests: a wait that never ends fails here instead of hanging the suite. */
const WAIT_LIMIT_MS = 5_000;
const POLL_INTERVAL_MS = 10;

const SHELF_NONE: ProductListingSettingPatch = { storeShelf: { mode: "none" } };
const OWN_SHELF: ProductListingSettingBulkPatch = { storeShelf: { mode: "own", shelves: [{ id: "11", name: "Top shelf" }] } };

type Row = Record<string, unknown>;

describeDatabase.sequential("product and category listing settings (migrations 0736-0738) on PostgreSQL", () => {
  const schema = `dropship_listing_setting_writes_${process.pid}`;
  let pool: pg.Pool;
  let created = false;
  const qualify = (sql: string) => sql.replace(/\b(dropship|catalog)\.([a-z_]+)\b/g, (name, _namespace, object) => {
    if (!OBJECTS.has(name)) throw new Error(`Unexpected database object: ${name}`);
    return `"${schema}"."${object}"`;
  });
  const execute = (sql: string, values?: unknown[]) => pool.query(qualify(sql), values);
  const migration = (file: string) => readFileSync(resolve(process.cwd(), "migrations", file), "utf8");

  /** The repositories' own SQL against the isolated schema. */
  function scopedPool(): Pool {
    return {
      query: (sql: string, values?: unknown[]) => pool.query(qualify(sql), values),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql: string, values?: unknown[]) => client.query(qualify(sql), values),
          release: (destroy?: boolean | Error) => client.release(destroy),
        };
      },
    } as unknown as Pool;
  }

  const repository = () => new PgDropshipListingSettingWritesRepository(scopedPool());
  const key = (label: string) => `listing-settings:${label}`;
  const hash = (value: unknown) => listingSettingRequestHash(value);

  function run<T>(label: string, operation: (tx: ListingSettingWriteTransaction) => Promise<T>,
    input: { memberId?: string; storeConnectionId?: number } = {}): Promise<T> {
    return repository().execute({
      memberId: input.memberId ?? MEMBER, storeConnectionId: input.storeConnectionId ?? STORE, idempotencyKey: key(label),
    }, operation);
  }

  function saveProduct(label: string, patch: ProductListingSettingPatch, expectedRevisionId: number | null = null,
    options: { productId?: number; requestHash?: string; storeConnectionId?: number; now?: Date } = {}) {
    return run(label, (tx) => tx.saveProduct({
      productId: options.productId ?? PRODUCT, expectedRevisionId, patch,
      requestHash: options.requestHash ?? hash({ label, patch }), now: options.now ?? NOW,
    }), { storeConnectionId: options.storeConnectionId });
  }

  function bulkInput(label: string, productIds: readonly number[], patch: ProductListingSettingBulkPatch,
    expected: (productId: number) => number | null = () => null,
    operation: "product_settings_bulk" | "category_settings_clear" = "product_settings_bulk") {
    return {
      operation,
      products: productIds.map((productId) => ({ productId, expectedRevisionId: expected(productId) })),
      patch, requestHash: hash({ label, patch }), now: NOW,
    };
  }

  async function count(table: string, where = "true", values: unknown[] = []): Promise<number> {
    const result = await execute(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values);
    return (result.rows[0] as { n: number }).n;
  }

  async function writeCounts() {
    return {
      ledger: await count("dropship.dropship_product_listing_setting_requests"),
      productRevisions: await count("dropship.dropship_product_listing_setting_revisions"),
      productSettings: await count("dropship.dropship_product_listing_settings"),
      categoryRevisions: await count("dropship.dropship_category_listing_setting_revisions"),
      categorySettings: await count("dropship.dropship_category_listing_settings"),
      marks: await count("dropship.dropship_product_category_seen"),
      audit: await count("dropship.dropship_audit_events"),
    };
  }

  async function expectDropshipError(promise: Promise<unknown>, code: string): Promise<DropshipError> {
    const error = await promise.then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(DropshipError);
    expect((error as DropshipError).code).toBe(code);
    return error as DropshipError;
  }

  async function expectSqlState(promise: Promise<unknown>, code: string, constraint?: string): Promise<void> {
    const error = await promise.then(() => null, (reason: unknown) => reason) as { code?: string; constraint?: string } | null;
    expect(error?.code).toBe(code);
    if (constraint !== undefined) expect(error?.constraint).toBe(constraint);
  }

  /** Resolves or rejects with `promise`, or rejects once WAIT_LIMIT_MS passes. */
  async function within<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} did not finish within ${WAIT_LIMIT_MS} ms`)), WAIT_LIMIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Polls until `count` other backends of this database wait on a lock `holderPid` holds; returns their statements. */
  async function waitUntilBlockedBy(holderPid: number, waiting: number): Promise<string[]> {
    const deadline = Date.now() + WAIT_LIMIT_MS;
    for (;;) {
      const result = await pool.query<{ query: string }>(
        `SELECT query FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
        [holderPid],
      );
      if (result.rows.length >= waiting) return result.rows.map((row) => row.query);
      if (Date.now() > deadline) throw new Error(`Expected ${waiting} backend(s) waiting on ${holderPid}; saw ${result.rows.length}`);
      await new Promise((done) => setTimeout(done, POLL_INTERVAL_MS));
    }
  }

  /** A second connection standing in for another writer (a listing queue); it holds its locks until commit. */
  async function otherWriter() {
    const client = await pool.connect();
    const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    let open = false;
    return {
      pid,
      async begin() {
        await client.query("BEGIN");
        open = true;
        await client.query(`SET LOCAL lock_timeout = '${WAIT_LIMIT_MS}ms'`);
      },
      query: (sql: string, values?: unknown[]) => client.query(qualify(sql), values),
      async commit() {
        await client.query("COMMIT");
        open = false;
      },
      async end() {
        try {
          if (open) await client.query("ROLLBACK");
          client.release();
        } catch (error) {
          client.release(error as Error);
          throw error;
        }
      },
    };
  }

  /** Every constraint, trigger, index and column in the schema, for comparing before and after a re-run. */
  async function schemaInventory(): Promise<string> {
    const constraints = await pool.query(
      `SELECT c.conrelid::regclass::text AS relation, c.conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 ORDER BY 1, 2`, [schema]);
    const triggers = await pool.query(
      `SELECT t.tgrelid::regclass::text AS relation, t.tgname, pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace
       WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY 1, 2`, [schema]);
    const indexes = await pool.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY 1, 2`, [schema]);
    const columns = await pool.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = $1 ORDER BY 1, ordinal_position`, [schema]);
    return JSON.stringify({ constraints: constraints.rows, triggers: triggers.rows, indexes: indexes.rows, columns: columns.rows });
  }

  /** `count` catalog products from BULK_FIRST_PRODUCT, with no category. */
  async function seedBulkProducts(total: number): Promise<number[]> {
    await execute(`INSERT INTO catalog.products (id, name) SELECT g, 'Bulk product ' || g FROM generate_series($1::int, $2::int) g`,
      [BULK_FIRST_PRODUCT, BULK_FIRST_PRODUCT + total - 1]);
    return Array.from({ length: total }, (_, index) => BULK_FIRST_PRODUCT + index);
  }

  /** Elapsed time and heap growth of `work`, with the heap sampled while it runs (no forced GC: the numbers are indicative). */
  async function measure<T>(label: string, work: () => Promise<T>): Promise<T> {
    const heapBefore = process.memoryUsage().heapUsed;
    let heapPeak = heapBefore;
    const sampler = setInterval(() => { heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed); }, HEAP_SAMPLE_INTERVAL_MS);
    const started = process.hrtime.bigint();
    try {
      return await work();
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      clearInterval(sampler);
      const heapAfter = process.memoryUsage().heapUsed;
      heapPeak = Math.max(heapPeak, heapAfter);
      // The PR body carries these numbers (plan 3.12); nothing asserts them. Written to stdout
      // directly: a reporter may hide console output of passing tests.
      process.stdout.write(`${JSON.stringify({
        measurement: label, elapsedMs: Math.round(elapsedMs),
        heapUsedDeltaMiB: Number(((heapAfter - heapBefore) / 1_048_576).toFixed(1)),
        heapUsedPeakDeltaMiB: Number(((heapPeak - heapBefore) / 1_048_576).toFixed(1)),
      })}\n`);
    }
  }

  beforeAll(async () => {
    if (!testUrl || !disposable || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(testUrl)) {
      throw new Error("Listing setting write tests require a distinct, explicitly disposable PostgreSQL database.");
    }
    if (!/^dropship_listing_setting_writes_\d+$/.test(schema)) throw new Error("Invalid isolated schema.");
    pool = new pg.Pool({ connectionString: testUrl, max: 6 });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    // The tables earlier migrations made, with the columns these writers and
    // their foreign keys use: 0086 (vendors, stores, audit events; the audit
    // foreign keys take key-share locks on the owner rows), 0108 (categories,
    // products.category_id), the catalog and the selection tables W9 locks.
    await execute(`
      CREATE TABLE dropship.dropship_vendors (id integer PRIMARY KEY, member_id varchar(255) NOT NULL);
      CREATE TABLE dropship.dropship_store_connections (id integer PRIMARY KEY,
        vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id), platform varchar(30) NOT NULL DEFAULT 'ebay');
      CREATE TABLE dropship.dropship_audit_events (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer REFERENCES dropship.dropship_vendors(id) ON DELETE SET NULL,
        store_connection_id integer REFERENCES dropship.dropship_store_connections(id) ON DELETE SET NULL,
        entity_type varchar(80) NOT NULL, entity_id varchar(255), event_type varchar(120) NOT NULL,
        actor_type varchar(40) NOT NULL, actor_id varchar(255), severity varchar(20) NOT NULL, payload jsonb,
        created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE catalog.product_categories (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name varchar(100) NOT NULL, slug varchar(120) NOT NULL UNIQUE, is_active boolean DEFAULT true NOT NULL);
      CREATE TABLE catalog.products (id integer PRIMARY KEY, name text NOT NULL, category varchar(100),
        category_id integer REFERENCES catalog.product_categories(id) ON DELETE SET NULL,
        inventory_tracking_default boolean NOT NULL DEFAULT true);
      CREATE TABLE catalog.product_variants (id integer PRIMARY KEY, product_id integer NOT NULL REFERENCES catalog.products(id),
        name text NOT NULL DEFAULT 'Size', inventory_tracking_override boolean);
      CREATE TABLE catalog.product_line_products (product_id integer NOT NULL, product_line_id integer NOT NULL);
      CREATE TABLE dropship.dropship_catalog_rules (id integer PRIMARY KEY);
      CREATE TABLE dropship.dropship_vendor_selection_rules (id integer PRIMARY KEY);
      CREATE TABLE dropship.dropship_vendor_variant_overrides (id integer PRIMARY KEY);
    `);
    for (const file of [...PRIOR_MIGRATIONS, ...PR8_MIGRATIONS]) await execute(migration(file));
  });

  afterAll(async () => {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    // Revisions, ledger and marks refuse DELETE by trigger; TRUNCATE is the
    // test's reset, not a code path.
    const tables = [...OBJECTS].filter((name) => !name.startsWith("dropship.guard_"));
    await execute(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
    await execute(`
      INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (10, 'member-1'), (11, 'member-2');
      INSERT INTO dropship.dropship_store_connections (id, vendor_id) VALUES (22, 10), (24, 10), (23, 11);
      INSERT INTO catalog.product_categories (id, name, slug) OVERRIDING SYSTEM VALUE
        VALUES (3, 'Toploaders', 'toploaders'), (5, 'Sleeves', 'sleeves');
      INSERT INTO catalog.products (id, name, category, category_id)
        VALUES (7, 'Toploader 3x4', 'Toploaders', 3), (8, 'Toploader 5x7', 'Toploaders', 3), (9, 'Penny sleeves', 'Sleeves', 5);
      INSERT INTO catalog.product_variants (id, product_id, name) VALUES (101, 7, '25 pack'), (102, 7, '100 pack');
    `);
  });

  it("applies 0736, 0737 and 0738 again without changing a constraint, trigger, index or column", async () => {
    const before = await schemaInventory();
    for (const file of PR8_MIGRATIONS) await execute(migration(file));
    expect(await schemaInventory()).toBe(before);
    expect(before).toContain("dropship_product_listing_setting_revision_price_chk");
    expect(before).toContain("dropship_category_listing_setting_revision_price_chk");
    expect(before).toContain("dropship_pricing_review_kind_chk");
    expect(before).toContain("product_category_seen_guard");
  });

  describe("every all-or-none value group, refused by its own CHECK (F1)", () => {
    const PRODUCT_TABLE = "dropship.dropship_product_listing_setting_revisions";
    const CATEGORY_TABLE = "dropship.dropship_category_listing_setting_revisions";
    let inserted = 0;

    /** One revision row written straight to the table: a valid identity, then `values`. */
    function insertRevision(table: string, values: Row) {
      inserted += 1;
      const target: Row = table === PRODUCT_TABLE
        ? { product_id: PRODUCT }
        : { category_id: TOPLOADERS, category_name: "Toploaders" };
      const row: Row = {
        vendor_id: VENDOR, store_connection_id: STORE, ...target,
        idempotency_key: `direct-revision:${inserted}`, request_hash: "e".repeat(64),
        actor_type: "vendor", actor_id: MEMBER, created_at: NOW, ...values,
      };
      const columns = Object.keys(row);
      return execute(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
        columns.map((column) => row[column]));
    }

    const PARTIAL_SHAPES: ReadonlyArray<[string, Row, string]> = [
      ["price_basis alone", { price_basis: "product_cost" }, "price_chk"],
      ["a recipe without its rounding", { price_basis: "product_cost", price_markup_bps: 3000, price_flat_cents: 100 }, "price_chk"],
      ["an eBay category id without its name and path", { ebay_category_id: "183438" }, "ebay_category_chk"],
      ["an own shelf without ids or names", { shelf_mode: "own" }, "shelf_chk"],
      ["shelf ids without a shelf mode", { shelf_ids: "[\"11\"]" }, "shelf_chk"],
      ["own text above without its text", { text_above_mode: "own" }, "text_chk"],
      ["a policy name without its id", { fulfillment_policy_name: "Free shipping" }, "policy_chk"],
    ];
    const PRODUCT_ONLY_SHAPES: ReadonlyArray<[string, Row, string]> = [
      ["body_text alone", { body_text: "Our own words." }, "body_chk"],
      ["body_catalog_hash alone", { body_catalog_hash: "c".repeat(64) }, "body_chk"],
    ];
    const FULL: Row = {
      price_basis: "catalog_retail", price_markup_bps: 2500, price_flat_cents: 0, price_rounding: "up_99",
      ebay_category_id: "183438", ebay_category_name: "Toploaders", ebay_category_path: "[\"Collectibles\", \"Toploaders\"]",
      shelf_mode: "own", shelf_ids: "[\"11\", \"12\"]", shelf_names: "[\"Top shelf\", \"Second shelf\"]",
      fulfillment_policy_id: "ship-a", fulfillment_policy_name: "Free shipping", return_policy_id: "return-a",
      return_policy_name: null, payment_policy_id: "pay-a", payment_policy_name: "Managed payments",
      text_above_mode: "own", text_above: "Shipped in a box.", text_below_mode: "own", text_below: "Thanks for buying.",
    };

    const CASES: Array<[string, string, Row, string]> = [
      ...PARTIAL_SHAPES.map(([label, values, check]): [string, string, Row, string] => ["product", label, values, check]),
      ...PRODUCT_ONLY_SHAPES.map(([label, values, check]): [string, string, Row, string] => ["product", label, values, check]),
      ...PARTIAL_SHAPES.map(([label, values, check]): [string, string, Row, string] => ["category", label, values, check]),
    ];

    it.each(CASES)("refuses on the %s revisions: %s", async (kind, _label, values, check) => {
      const table = kind === "product" ? PRODUCT_TABLE : CATEGORY_TABLE;
      await expectSqlState(insertRevision(table, values), "23514", `dropship_${kind}_listing_setting_revision_${check}`);
    });

    it("accepts the empty row, the fully set row and none/none on both tables", async () => {
      for (const table of [PRODUCT_TABLE, CATEGORY_TABLE]) {
        await insertRevision(table, {});
        await insertRevision(table, table === PRODUCT_TABLE
          ? { ...FULL, body_text: "Our own words.", body_catalog_hash: "c".repeat(64) } : FULL);
        await insertRevision(table, { shelf_mode: "none", text_above_mode: "none", text_below_mode: "none" });
      }
      expect(await count(PRODUCT_TABLE)).toBe(3);
      expect(await count(CATEGORY_TABLE)).toBe(3);
    });
  });

  it("refuses UPDATE and DELETE of product and category revisions", async () => {
    await saveProduct("immutable-product", SHELF_NONE);
    await run("immutable-category", (tx) => tx.saveCategory({
      categoryId: TOPLOADERS, expectedRevisionId: null, patch: SHELF_NONE, requestHash: hash("immutable-category"), now: NOW,
    }));

    for (const table of ["dropship.dropship_product_listing_setting_revisions", "dropship.dropship_category_listing_setting_revisions"]) {
      await expectSqlState(execute(`UPDATE ${table} SET actor_id = 'someone-else'`), "23514");
      await expectSqlState(execute(`DELETE FROM ${table}`), "23514");
      expect(await count(table, "actor_id = $1", [MEMBER])).toBe(1);
    }
  });

  it("refuses DELETE of a current setting, an identity change, and a stale predecessor", async () => {
    const product = await saveProduct("coherence-product", SHELF_NONE);
    const category = await run("coherence-category", (tx) => tx.saveCategory({
      categoryId: TOPLOADERS, expectedRevisionId: null, patch: SHELF_NONE, requestHash: hash("coherence-category"), now: NOW,
    }));
    expect(product.row?.revisionId).toBe(1);
    expect(category.row?.revisionId).toBe(1);

    await expectSqlState(execute("DELETE FROM dropship.dropship_product_listing_settings"), "23514");
    await expectSqlState(execute("DELETE FROM dropship.dropship_category_listing_settings"), "23514");
    await expectSqlState(execute("UPDATE dropship.dropship_product_listing_settings SET product_id = 8"), "23514");
    await expectSqlState(execute("UPDATE dropship.dropship_category_listing_settings SET category_id = 5"), "23514");

    // A second revision that names no predecessor, while revision 1 is current.
    await execute(`INSERT INTO dropship.dropship_product_listing_setting_revisions
      (vendor_id, store_connection_id, product_id, previous_revision_id, idempotency_key, request_hash, actor_type, actor_id, created_at)
      VALUES (10, 22, 7, NULL, 'direct:stale-product', $1, 'vendor', 'member-1', $2)`, ["e".repeat(64), NOW]);
    await execute(`INSERT INTO dropship.dropship_category_listing_setting_revisions
      (vendor_id, store_connection_id, category_id, category_name, previous_revision_id, idempotency_key, request_hash,
       actor_type, actor_id, created_at)
      VALUES (10, 22, 3, 'Toploaders', NULL, 'direct:stale-category', $1, 'vendor', 'member-1', $2)`, ["e".repeat(64), NOW]);
    await expectSqlState(execute("UPDATE dropship.dropship_product_listing_settings SET revision_id = 2"), "23514");
    await expectSqlState(execute("UPDATE dropship.dropship_category_listing_settings SET revision_id = 2"), "23514");
    expect(await count("dropship.dropship_product_listing_settings", "revision_id = 1")).toBe(1);
    expect(await count("dropship.dropship_category_listing_settings", "revision_id = 1")).toBe(1);
  });

  it("refuses UPDATE and DELETE of a ledger row", async () => {
    await run("ledger-row", (tx) => tx.saveProductsBulk(bulkInput("ledger-row", [PRODUCT], SHELF_NONE)));

    await expectSqlState(execute("UPDATE dropship.dropship_product_listing_setting_requests SET product_count = 0"), "23514");
    await expectSqlState(execute("DELETE FROM dropship.dropship_product_listing_setting_requests"), "23514");
    expect(await count("dropship.dropship_product_listing_setting_requests", "product_count = 1")).toBe(1);
  });

  it("saves one product with a chained revision and its audit row in one commit, and rolls both back together", async () => {
    const first = await saveProduct("chain-1", OWN_SHELF);
    const second = await saveProduct("chain-2", { textAbove: { mode: "own", text: "Shipped in a rigid mailer." } }, 1);

    expect(first).toMatchObject({ outcome: "changed", before: null, changedFields: ["storeShelf"], row: { revisionId: 1 } });
    expect(second).toMatchObject({ outcome: "changed", changedFields: ["textAbove"], row: { revisionId: 2 } });
    // The second patch keeps what the first set.
    expect(second.row?.values.storeShelf).toEqual(OWN_SHELF.storeShelf);
    const revisions = await execute(`SELECT id, previous_revision_id, request_id, idempotency_key, shelf_ids, text_above
      FROM dropship.dropship_product_listing_setting_revisions ORDER BY id`);
    expect(revisions.rows).toEqual([
      { id: 1, previous_revision_id: null, request_id: null, idempotency_key: key("chain-1"), shelf_ids: ["11"], text_above: null },
      { id: 2, previous_revision_id: 1, request_id: null, idempotency_key: key("chain-2"), shelf_ids: ["11"],
        text_above: "Shipped in a rigid mailer." },
    ]);
    const audits = await execute(`SELECT entity_type, entity_id, event_type, actor_type, actor_id, payload
      FROM dropship.dropship_audit_events ORDER BY id`);
    expect(audits.rows).toHaveLength(2);
    expect(audits.rows[1]).toMatchObject({
      entity_type: "dropship_product_listing_setting", entity_id: "7", event_type: "product_listing_settings_saved",
      actor_type: "vendor", actor_id: MEMBER,
      payload: { requestKey: key("chain-2"), revisionId: 2, previousRevisionId: 1, changedFields: ["textAbove"],
        before: { storeShelf: OWN_SHELF.storeShelf, textAbove: null }, after: { textAbove: { mode: "own" } } },
    });

    const before = await writeCounts();
    await expect(run("chain-3", async (tx) => {
      await tx.saveProduct({ productId: PRODUCT, expectedRevisionId: 2, patch: SHELF_NONE, requestHash: hash("chain-3"), now: NOW });
      throw new Error("a later step of the request failed");
    })).rejects.toThrow("a later step of the request failed");
    expect(await writeCounts()).toEqual(before);
    expect(await count("dropship.dropship_product_listing_settings", "revision_id = 2")).toBe(1);
  });

  it("writes nothing for a stale expected revision", async () => {
    await saveProduct("stale-1", SHELF_NONE);
    const before = await writeCounts();

    const error = await expectDropshipError(saveProduct("stale-2", OWN_SHELF, null), "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT");

    expect(error.context).toMatchObject({
      conflicts: [{ productId: PRODUCT, expectedRevisionId: null, actualRevisionId: 1 }], conflictCount: 1,
      retryable: false, classification: "permanent",
    });
    expect(await writeCounts()).toEqual(before);
  });

  it("writes nothing for an unchanged patch, including a first save of only defaults", async () => {
    await expect(saveProduct("unchanged-0", { storeShelf: null, price: null })).resolves.toMatchObject({ outcome: "unchanged", row: null });
    expect(await writeCounts()).toMatchObject({ productRevisions: 0, productSettings: 0, audit: 0 });

    await saveProduct("unchanged-1", SHELF_NONE);
    const before = await writeCounts();
    await expect(saveProduct("unchanged-2", SHELF_NONE, 1)).resolves.toMatchObject({
      outcome: "unchanged", changedFields: [], row: { revisionId: 1 },
    });
    expect(await writeCounts()).toEqual(before);
  });

  it("replays a product save by key; another body or another store with the same key is refused", async () => {
    const requestHash = hash("replay-body");
    const first = await saveProduct("replay", SHELF_NONE, null, { requestHash });
    const before = await writeCounts();

    const replay = await saveProduct("replay", SHELF_NONE, null, { requestHash, now: LATER });
    expect(replay).toMatchObject({ outcome: "replayed", row: { revisionId: first.row?.revisionId, updatedAt: NOW.toISOString() } });
    expect(await writeCounts()).toEqual(before);

    await expectDropshipError(saveProduct("replay", OWN_SHELF, null, { requestHash: hash("another body") }), "DROPSHIP_IDEMPOTENCY_CONFLICT");
    await expectDropshipError(saveProduct("replay", SHELF_NONE, null, { requestHash, storeConnectionId: SECOND_STORE }),
      "DROPSHIP_IDEMPOTENCY_CONFLICT");
    await expectDropshipError(saveProduct("replay", SHELF_NONE, null, { requestHash, productId: SECOND_PRODUCT }),
      "DROPSHIP_IDEMPOTENCY_CONFLICT");
    expect(await writeCounts()).toEqual(before);
  });

  it("lets exactly one of two concurrent saves from the same revision win", async () => {
    const queue = await otherWriter();
    try {
      await queue.begin();
      await queue.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)", [STORE]);
      const saves = [saveProduct("race-a", SHELF_NONE), saveProduct("race-b", OWN_SHELF)];
      await waitUntilBlockedBy(queue.pid, 2);
      await queue.commit();
      const settled = await within(Promise.allSettled(saves), "the two concurrent saves");

      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ code: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT" });
      expect(await writeCounts()).toMatchObject({ productRevisions: 1, productSettings: 1, audit: 1 });
    } finally {
      await queue.end();
    }
  });

  it("writes 10,000 products set-based in one transaction", async () => {
    const productIds = await seedBulkProducts(BULK_PRODUCTS);
    const input = bulkInput("bulk-10000", productIds, OWN_SHELF);

    const result = await measure("bulk 10,000 products, shelf set, no stored values", () =>
      run("bulk-10000", (tx) => tx.saveProductsBulk(input)));

    expect(result.outcome).toBe("changed");
    expect(result.changed).toHaveLength(BULK_PRODUCTS);
    expect(result.unchangedProductIds).toEqual([]);
    const ledger = await execute(`SELECT id, operation, idempotency_key, request_hash, product_count, actor_type, actor_id
      FROM dropship.dropship_product_listing_setting_requests`);
    expect(ledger.rows).toEqual([{
      id: String(result.requestId), operation: "product_settings_bulk", idempotency_key: key("bulk-10000"),
      request_hash: input.requestHash, product_count: BULK_PRODUCTS, actor_type: "vendor", actor_id: MEMBER,
    }]);
    const revisions = await execute(`SELECT product_id, idempotency_key FROM dropship.dropship_product_listing_setting_revisions
      WHERE request_id = $1 AND request_hash = $2 AND shelf_ids = '["11"]'::jsonb ORDER BY product_id`,
    [result.requestId, input.requestHash]);
    expect(revisions.rows).toHaveLength(BULK_PRODUCTS);
    expect(revisions.rows.every((row) => row.idempotency_key === listingSettingChildKey(key("bulk-10000"), "product", row.product_id as number)))
      .toBe(true);
    expect(await count("dropship.dropship_product_listing_settings")).toBe(BULK_PRODUCTS);
    expect(await count("dropship.dropship_audit_events", "event_type = 'product_listing_settings_saved' AND payload->>'operation' = 'product_settings_bulk'"))
      .toBe(BULK_PRODUCTS);
  }, BULK_TEST_TIMEOUT_MS);

  it("measures a 10,000-product bulk over heavy stored text (R12)", async () => {
    const productIds = await seedBulkProducts(BULK_PRODUCTS);
    // Every product already holds its own 4,000-character text above and below.
    await execute(`INSERT INTO dropship.dropship_product_listing_setting_revisions
      (vendor_id, store_connection_id, product_id, text_above_mode, text_above, text_below_mode, text_below,
       idempotency_key, request_hash, actor_type, actor_id, created_at)
      SELECT 10, 22, g, 'own', rpad('Above ' || g, $3::int, 'a'), 'own', rpad('Below ' || g, $3::int, 'b'),
        'seed-heavy-text:' || g, $4, 'vendor', 'member-1', $5
      FROM generate_series($1::int, $2::int) g`,
    [BULK_FIRST_PRODUCT, BULK_FIRST_PRODUCT + BULK_PRODUCTS - 1, HEAVY_TEXT_LENGTH, "e".repeat(64), EARLIER]);
    await execute(`INSERT INTO dropship.dropship_product_listing_settings (vendor_id, store_connection_id, product_id, revision_id)
      SELECT vendor_id, store_connection_id, product_id, id FROM dropship.dropship_product_listing_setting_revisions
      WHERE idempotency_key LIKE 'seed-heavy-text:%'`);
    const seeded = await execute(`SELECT product_id, revision_id FROM dropship.dropship_product_listing_settings`);
    const revisionByProduct = new Map(seeded.rows.map((row): [number, number] => [row.product_id as number, row.revision_id as number]));
    const input = bulkInput("bulk-heavy-text", productIds, OWN_SHELF, (productId) => revisionByProduct.get(productId) ?? null);

    const result = await measure("bulk 10,000 products, shelf set, 2 x 4,000-character stored texts each", () =>
      run("bulk-heavy-text", (tx) => tx.saveProductsBulk(input)));

    expect(result.outcome).toBe("changed");
    expect(result.changed).toHaveLength(BULK_PRODUCTS);
    // The texts are copied into the new revisions unchanged.
    expect(await count("dropship.dropship_product_listing_setting_revisions", `request_id = $1
      AND text_above_mode = 'own' AND text_above = rpad('Above ' || product_id, $2::int, 'a')
      AND text_below_mode = 'own' AND text_below = rpad('Below ' || product_id, $2::int, 'b')
      AND shelf_ids = '["11"]'::jsonb AND previous_revision_id IS NOT NULL`, [result.requestId, HEAVY_TEXT_LENGTH])).toBe(BULK_PRODUCTS);
    // Audit rows carry the changed shelf only, never the texts.
    const audit = await execute(`SELECT max(length(payload::text))::int AS longest FROM dropship.dropship_audit_events`);
    expect((audit.rows[0] as { longest: number }).longest).toBeLessThan(HEAVY_TEXT_LENGTH);
  }, BULK_TEST_TIMEOUT_MS);

  it("rolls the whole bulk back when one product is stale, naming the first 100 and the count", async () => {
    const stale = await seedBulkProducts(150);
    await run("stale-seed", (tx) => tx.saveProductsBulk(bulkInput("stale-seed", stale, SHELF_NONE)));
    const before = await writeCounts();

    const error = await expectDropshipError(
      run("stale-bulk", (tx) => tx.saveProductsBulk(bulkInput("stale-bulk", [PRODUCT, ...stale], OWN_SHELF))),
      "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT");

    const conflicts = (error.context as { conflicts: Array<{ productId: number; actualRevisionId: number }> }).conflicts;
    expect(conflicts).toHaveLength(100);
    const firstCurrent = await execute("SELECT revision_id FROM dropship.dropship_product_listing_settings WHERE product_id = $1",
      [BULK_FIRST_PRODUCT]);
    expect(conflicts[0]).toEqual({ productId: BULK_FIRST_PRODUCT, expectedRevisionId: null, actualRevisionId: firstCurrent.rows[0].revision_id });
    expect(conflicts.map((conflict) => conflict.productId)).toEqual(stale.slice(0, 100));
    expect(error.context).toMatchObject({ conflictCount: 150, retryable: false, classification: "permanent" });
    expect(await writeCounts()).toEqual(before);
    expect(await count("dropship.dropship_product_listing_settings", "product_id = $1", [PRODUCT])).toBe(0);
  });

  it("replays a bulk request without writing; a missing child row is REPLAY_INCOMPLETE", async () => {
    const input = bulkInput("bulk-replay", [PRODUCT, SECOND_PRODUCT], SHELF_NONE);
    const first = await run("bulk-replay", (tx) => tx.saveProductsBulk(input));
    const before = await writeCounts();

    const replay = await run("bulk-replay", (tx) => tx.saveProductsBulk({ ...input, now: LATER }));
    expect(replay).toEqual({ ...first, outcome: "replayed" });
    expect(await writeCounts()).toEqual(before);
    await expectDropshipError(run("bulk-replay", (tx) => tx.saveProductsBulk({ ...input, requestHash: hash("another body") })),
      "DROPSHIP_IDEMPOTENCY_CONFLICT");

    // A ledger row whose revisions are missing: never written by the writer, here inserted by hand.
    const broken = bulkInput("bulk-broken", [PRODUCT, SECOND_PRODUCT], OWN_SHELF);
    await execute(`INSERT INTO dropship.dropship_product_listing_setting_requests
      (vendor_id, store_connection_id, operation, idempotency_key, request_hash, product_count, actor_type, actor_id, created_at)
      VALUES (10, 22, 'product_settings_bulk', $1, $2, 2, 'vendor', 'member-1', $3)`, [key("bulk-broken"), broken.requestHash, NOW]);
    const incomplete = await expectDropshipError(run("bulk-broken", (tx) => tx.saveProductsBulk(broken)),
      "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE");
    expect(incomplete.context).toMatchObject({ expectedCount: 2, foundCount: 0, classification: "fatal" });
  });

  it("keeps a category's name at save, keyed by id across a Card Shellz rename", async () => {
    const saved = await run("category-1", (tx) => tx.saveCategory({
      categoryId: TOPLOADERS, expectedRevisionId: null, patch: OWN_SHELF, requestHash: hash("category-1"), now: NOW,
    }));
    expect(saved).toMatchObject({ outcome: "changed", categoryName: "Toploaders", row: { categoryId: TOPLOADERS, revisionId: 1 } });

    await execute("UPDATE catalog.product_categories SET name = 'Top loaders' WHERE id = 3");
    const loaded = await run("category-read", (tx) => tx.loadCategories([TOPLOADERS]));
    expect(loaded.get(TOPLOADERS)).toMatchObject({ revisionId: 1, values: { storeShelf: OWN_SHELF.storeShelf } });

    const renamed = await run("category-2", (tx) => tx.saveCategory({
      categoryId: TOPLOADERS, expectedRevisionId: 1, patch: SHELF_NONE, requestHash: hash("category-2"), now: LATER,
    }));
    expect(renamed).toMatchObject({ outcome: "changed", categoryName: "Top loaders", row: { revisionId: 2 } });
    const names = await execute("SELECT id, category_name FROM dropship.dropship_category_listing_setting_revisions ORDER BY id");
    expect(names.rows).toEqual([{ id: 1, category_name: "Toploaders" }, { id: 2, category_name: "Top loaders" }]);
    const audit = await execute(`SELECT payload->>'categoryName' AS name FROM dropship.dropship_audit_events
      WHERE event_type = 'category_listing_settings_saved' ORDER BY id`);
    expect(audit.rows).toEqual([{ name: "Toploaders" }, { name: "Top loaders" }]);
  });

  it("commits a category save and its cleared products together, and rolls both back together", async () => {
    await saveProduct("clear-seed", OWN_SHELF, null, { productId: SECOND_PRODUCT });
    const before = await writeCounts();

    // "Also clear theirs" with a stale product: nothing of the request is kept.
    await expectDropshipError(run("clear-stale", async (tx) => {
      await tx.lockCatalog({ categoryIds: [TOPLOADERS], productIds: [PRODUCT, SECOND_PRODUCT] });
      await tx.saveCategory({ categoryId: TOPLOADERS, expectedRevisionId: null, patch: OWN_SHELF, requestHash: hash("clear-stale"), now: NOW });
      await tx.saveProductsBulk(bulkInput("clear-stale", [PRODUCT, SECOND_PRODUCT], { storeShelf: null }, () => null, "category_settings_clear"));
    }), "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT");
    expect(await writeCounts()).toEqual(before);

    const result = await run("clear-current", async (tx) => {
      await tx.lockCatalog({ categoryIds: [TOPLOADERS], productIds: [PRODUCT, SECOND_PRODUCT] });
      const category = await tx.saveCategory({
        categoryId: TOPLOADERS, expectedRevisionId: null, patch: OWN_SHELF, requestHash: hash("clear-current"), now: NOW,
      });
      const cleared = await tx.saveProductsBulk(bulkInput("clear-current", [PRODUCT, SECOND_PRODUCT], { storeShelf: null },
        (productId) => (productId === SECOND_PRODUCT ? 1 : null), "category_settings_clear"));
      return { category, cleared };
    });
    // Identity values used by the rolled-back attempt are not reused, so the ids are read back, not assumed.
    const current = await execute(`SELECT 'category' AS kind, revision_id FROM dropship.dropship_category_listing_settings
      UNION ALL SELECT 'product', revision_id FROM dropship.dropship_product_listing_settings WHERE product_id = $1 ORDER BY 1`,
    [SECOND_PRODUCT]);
    const [categoryRevision, productRevision] = current.rows.map((row) => row.revision_id as number);
    expect(result.category).toMatchObject({ outcome: "changed", before: null, row: { revisionId: categoryRevision } });
    expect(result.cleared).toMatchObject({ outcome: "changed", changed: [{ productId: SECOND_PRODUCT, revisionId: productRevision }],
      unchangedProductIds: [PRODUCT] });
    expect(await count("dropship.dropship_product_listing_setting_revisions", "id = $1 AND shelf_mode IS NULL AND previous_revision_id = 1",
      [productRevision])).toBe(1);
    expect(await execute("SELECT operation, product_count FROM dropship.dropship_product_listing_setting_requests"))
      .toMatchObject({ rows: [{ operation: "category_settings_clear", product_count: 1 }] });
  });

  it("maps a missing product or category to …_NOT_FOUND", async () => {
    const product = await expectDropshipError(saveProduct("missing-product", SHELF_NONE, null, { productId: MISSING }),
      "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND");
    expect(product.context).toMatchObject({ productId: MISSING, constraint: "dropship_product_listing_setting_revision_product_fk" });
    const bulk = await expectDropshipError(run("missing-bulk", (tx) => tx.saveProductsBulk(bulkInput("missing-bulk", [PRODUCT, MISSING], SHELF_NONE))),
      "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND");
    expect(bulk.context).toMatchObject({ productId: MISSING });
    await expectDropshipError(run("missing-category", (tx) => tx.saveCategory({
      categoryId: MISSING, expectedRevisionId: null, patch: SHELF_NONE, requestHash: hash("missing-category"), now: NOW,
    })), "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND");
    expect(await writeCounts()).toMatchObject({ ledger: 0, productRevisions: 0, categoryRevisions: 0, audit: 0 });
  });

  describe("category marks (W13)", () => {
    const JOB = "category-marks:first";
    const firstMarks = (productIds: number[], now = NOW) => repository().executeForSystem({ storeConnectionId: STORE, jobKey: JOB },
      (tx) => tx.insertFirstCategoryMarks({ productIds, jobKey: JOB, now }));
    const marks = async () => (await execute(`SELECT product_id, category_id, seen_at FROM dropship.dropship_product_category_seen
      ORDER BY product_id`)).rows;
    const acknowledgeMoves = (label: string, items: Array<{ productId: number; shownCategoryId: number | null }>, now = LATER) =>
      run(label, (tx) => tx.acknowledgeCategoryMoves({ items, requestHash: hash({ label, items }), now }));

    it("inserts only missing marks and never changes one", async () => {
      await expect(firstMarks([PRODUCT, SECOND_PRODUCT, THIRD_PRODUCT, MISSING])).resolves.toEqual({
        insertedProductIds: [PRODUCT, SECOND_PRODUCT, THIRD_PRODUCT],
      });
      await execute("UPDATE catalog.products SET category_id = 5 WHERE id = 7");
      await expect(firstMarks([PRODUCT, SECOND_PRODUCT, THIRD_PRODUCT], LATER)).resolves.toEqual({ insertedProductIds: [] });

      expect(await marks()).toEqual([
        { product_id: PRODUCT, category_id: TOPLOADERS, seen_at: NOW },
        { product_id: SECOND_PRODUCT, category_id: TOPLOADERS, seen_at: NOW },
        { product_id: THIRD_PRODUCT, category_id: SLEEVES, seen_at: NOW },
      ]);
      const audit = await execute("SELECT entity_type, entity_id, event_type, actor_type, actor_id, payload FROM dropship.dropship_audit_events");
      expect(audit.rows).toEqual([{
        entity_type: "dropship_store_connection", entity_id: "22", event_type: "category_marks_seeded", actor_type: "system",
        actor_id: JOB, payload: { jobKey: JOB, insertedCount: 3, productIds: [PRODUCT, SECOND_PRODUCT, THIRD_PRODUCT] },
      }]);
    });

    it("keeps the mark of a product that moved again before Got it", async () => {
      await firstMarks([PRODUCT, SECOND_PRODUCT]);
      await execute("UPDATE catalog.products SET category_id = 5 WHERE id IN (7, 8)");
      // The vendor was shown both in Sleeves; product 8 moves again before they confirm.
      await execute("UPDATE catalog.products SET category_id = NULL WHERE id = 8");

      await expect(acknowledgeMoves("got-it", [
        { productId: PRODUCT, shownCategoryId: SLEEVES }, { productId: SECOND_PRODUCT, shownCategoryId: SLEEVES },
      ])).resolves.toEqual({ outcome: "acknowledged", acknowledgedProductIds: [PRODUCT], movedAgainProductIds: [SECOND_PRODUCT] });

      expect(await marks()).toEqual([
        { product_id: PRODUCT, category_id: SLEEVES, seen_at: LATER },
        { product_id: SECOND_PRODUCT, category_id: TOPLOADERS, seen_at: NOW },
      ]);
      expect(await execute("SELECT operation, product_count FROM dropship.dropship_product_listing_setting_requests"))
        .toMatchObject({ rows: [{ operation: "category_moves_acknowledge", product_count: 1 }] });
    });

    it("never moves seen_at back, writes nothing on a replayed Got it, and keeps every mark", async () => {
      await firstMarks([PRODUCT], LATER);
      await execute("UPDATE catalog.products SET category_id = 5 WHERE id = 7");
      const items = [{ productId: PRODUCT, shownCategoryId: SLEEVES }];

      // Acknowledged with a clock behind the mark: the category moves, the time stays.
      await acknowledgeMoves("got-it-early", items, EARLIER);
      expect(await marks()).toEqual([{ product_id: PRODUCT, category_id: SLEEVES, seen_at: LATER }]);
      const before = await writeCounts();
      await expect(acknowledgeMoves("got-it-early", items, EARLIER)).resolves.toEqual({
        outcome: "replayed", acknowledgedProductIds: [], movedAgainProductIds: [],
      });
      expect(await writeCounts()).toEqual(before);

      await expectSqlState(execute("UPDATE dropship.dropship_product_category_seen SET seen_at = $1", [EARLIER]), "23514");
      await expectSqlState(execute("UPDATE dropship.dropship_product_category_seen SET product_id = 8"), "23514");
      await expectSqlState(execute("DELETE FROM dropship.dropship_product_category_seen"), "23514");
      expect(await marks()).toHaveLength(1);
    });

    it("lets a product with only a mark be deleted, never one with settings (F16)", async () => {
      await firstMarks([SECOND_PRODUCT, THIRD_PRODUCT]);
      await saveProduct("delete-guard", SHELF_NONE, null, { productId: SECOND_PRODUCT });

      await execute("DELETE FROM catalog.products WHERE id = 9");
      expect(await count("catalog.products", "id = 9")).toBe(0);
      expect(await count("dropship.dropship_product_category_seen", "product_id = 9")).toBe(1);
      await expectSqlState(execute("DELETE FROM catalog.products WHERE id = 8"), "23503");
      expect(await count("catalog.products", "id = 8")).toBe(1);
    });
  });

  it("answers another vendor's store, or an unknown one, as DROPSHIP_STORE_CONNECTION_REQUIRED", async () => {
    await expectDropshipError(saveProduct("other-vendor", SHELF_NONE, null, { storeConnectionId: OTHER_VENDOR_STORE }),
      "DROPSHIP_STORE_CONNECTION_REQUIRED");
    await expectDropshipError(repository().executeForSystem({ storeConnectionId: MISSING, jobKey: "category-marks:first" },
      async () => undefined), "DROPSHIP_STORE_CONNECTION_REQUIRED");
    expect(await writeCounts()).toMatchObject({ productRevisions: 0, audit: 0 });
  });

  it("makes a settings write wait for a queue holding the store lock", async () => {
    const queue = await otherWriter();
    try {
      await queue.begin();
      await queue.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)", [STORE]);
      const save = saveProduct("after-queue", SHELF_NONE);
      const waiting = await waitUntilBlockedBy(queue.pid, 1);
      expect(waiting[0]).toContain("dropship_listing_push_job");
      expect(await writeCounts()).toMatchObject({ productRevisions: 0, audit: 0 });

      await queue.commit();
      await expect(within(save, "the save after the queue")).resolves.toMatchObject({ outcome: "changed" });
    } finally {
      await queue.end();
    }
  });

  it("writes a size price through sizePrice only with its child key and lockCatalog lock, audited as listing_price_saved (F4)", async () => {
    const childKey = listingSettingChildKey(key("size-price"), "size", 101);
    const priceSave = (idempotencyKey: string) => ({
      idempotencyKey, priceCents: 1299, expectedRevisionId: null, requestHash: hash({ idempotencyKey }), now: NOW,
    });

    await expectDropshipError(run("size-price", async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101] });
      return tx.sizePrice(102).save(priceSave(listingSettingChildKey(key("size-price"), "size", 102)));
    }), "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    // A size lockCatalog was given but the catalog does not have: not available (permanent), not a fault.
    const missingSize = await expectDropshipError(run("size-price", async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101, MISSING] });
      return tx.sizePrice(MISSING).save(priceSave(listingSettingChildKey(key("size-price"), "size", MISSING)));
    }), "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE");
    expect(missingSize.context).toMatchObject({ productVariantId: MISSING, classification: "permanent" });
    await expectDropshipError(run("size-price", async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101] });
      return tx.sizePrice(101).save(priceSave(key("size-price")));
    }), "DROPSHIP_IDEMPOTENCY_CONFLICT");
    expect(await count("dropship.dropship_listing_price_revisions")).toBe(0);

    const saved = await run("size-price", async (tx) => {
      await tx.lockCatalog({ productIds: [PRODUCT], productVariantIds: [101] });
      return tx.sizePrice(101).save(priceSave(childKey));
    });

    expect(saved).toMatchObject({ idempotentReplay: false, saved: { productVariantId: 101, overridePriceCents: 1299, pricingMode: "fixed" } });
    expect((await execute("SELECT idempotency_key, actor_id FROM dropship.dropship_listing_price_revisions")).rows)
      .toEqual([{ idempotency_key: childKey, actor_id: MEMBER }]);
    expect((await execute("SELECT entity_id, event_type, actor_type, actor_id FROM dropship.dropship_audit_events")).rows)
      .toEqual([{ entity_id: "101", event_type: "listing_price_saved", actor_type: "vendor", actor_id: MEMBER }]);
  });

  it("keeps the store pricing review loader to store default reviews (0738)", async () => {
    const storeReviewId = "1f6f2b0e-6c55-4a39-9a51-6f1f0f6f5b10";
    const productReviewId = "2a7e3c1f-7d66-4b4a-8b62-7a2a1a7a6c21";
    const input = { expectedRevisionId: null, releaseFixedOverrides: false,
      profile: { defaultRecipe: { basis: "product_cost", markupBps: 3000, flatCents: 100, rounding: "cent" }, groups: [] } };
    await execute(`INSERT INTO dropship.dropship_pricing_reviews (id, vendor_id, store_connection_id, input, rows, review_hash, actor_id, created_at, kind)
      VALUES ($1, 10, 22, $3::jsonb, '[]'::jsonb, $4, 'member-1', $5, 'store_default'),
             ($2, 10, 22, '{"productId":7}'::jsonb, '[]'::jsonb, $4, 'member-1', $5, 'product_prices')`,
    [storeReviewId, productReviewId, JSON.stringify(input), "d".repeat(64), NOW]);
    const reviews = new PgDropshipPricingRulesRepository(scopedPool());

    await expect(reviews.execute(MEMBER, STORE, (tx) => tx.loadReview(productReviewId))).resolves.toBeNull();
    await expect(reviews.execute(MEMBER, STORE, (tx) => tx.loadReview(storeReviewId))).resolves.toMatchObject({ id: storeReviewId, input });
  });
});
