import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { type SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { executeMigrationWithRetry } from "../../../../../migrations/migration-executor";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { allocateDocumentNumber, readSuggestedInvoiceNumber } from "../../../../platform/document-numbering/document-number.repository";
import { fixtureTable } from "./shipment-line-fixture";

const TEST_URL = process.env.ECHELON_TEST_DATABASE_URL;
const databaseTests = TEST_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const MIGRATION = readFileSync(resolve(process.cwd(), "docs/sql/procurement-document-number-prefix-indexes.sql"), "utf8");
const MIGRATION_HASH = createHash("sha256").update(MIGRATION).digest("hex");
const SOURCES = [
  { kind: "purchase_order", label: "PO", table: "procurement.purchase_orders", column: "po_number", schema: schema.purchaseOrders,
    index: "purchase_orders_po_number_prefix_idx", columns: "vendor_id,status", values: "1,CASE WHEN n%10=0 THEN 'cancelled' ELSE 'draft' END" },
  { kind: "receipt", label: "RCV", table: "procurement.receiving_orders", column: "receipt_number", schema: schema.receivingOrders,
    index: "receiving_orders_receipt_number_prefix_idx", columns: "status", values: "CASE WHEN n%10=0 THEN 'cancelled' ELSE 'draft' END" },
  { kind: "payment", label: "PAY", table: "procurement.ap_payments", column: "payment_number", schema: schema.apPayments,
    index: "ap_payments_payment_number_prefix_idx", columns: "vendor_id,payment_date,payment_method,total_amount_cents,status,voided_at",
    values: "1,TIMESTAMP '2026-10-25 12:00:00','wire',1,CASE WHEN n%10=0 THEN 'voided' ELSE 'completed' END,CASE WHEN n%10=0 THEN TIMESTAMP '2026-10-25 13:00:00' ELSE NULL END" },
  { kind: "lot", label: "LOT", table: "inventory.inventory_lots", column: "lot_number", schema: schema.inventoryLots,
    index: "inventory_lots_lot_number_prefix_idx", columns: "product_variant_id,warehouse_location_id,received_at,status",
    values: "1,1,TIMESTAMP '2026-10-25 12:00:00',CASE WHEN n%10=0 THEN 'depleted' ELSE 'active' END" },
  { kind: "invoice_suggestion", label: "INV", table: "procurement.vendor_invoices", column: "invoice_number", schema: schema.vendorInvoices,
    index: "vendor_invoices_invoice_number_prefix_idx", columns: "vendor_id,status", values: "1,CASE WHEN n%10=0 THEN 'voided' ELSE 'received' END" },
] as const;
const PREEXISTING_INDEXES = [
  "CREATE UNIQUE INDEX purchase_orders_po_number_active_uidx ON procurement.purchase_orders(po_number) WHERE status <> 'cancelled'",
  "CREATE UNIQUE INDEX receiving_orders_receipt_number_active_uidx ON procurement.receiving_orders(receipt_number) WHERE status <> 'cancelled'",
  "CREATE UNIQUE INDEX ap_payments_payment_number_active_uidx ON procurement.ap_payments(payment_number) WHERE voided_at IS NULL",
  "CREATE UNIQUE INDEX vendor_invoices_vendor_invoice_idx ON procurement.vendor_invoices(vendor_id,invoice_number) WHERE status <> 'voided'",
  "CREATE UNIQUE INDEX vendor_invoices_root_number_idx ON procurement.vendor_invoices(vendor_id,invoice_number) WHERE replaces_invoice_id IS NULL",
  "CREATE UNIQUE INDEX vendor_invoices_one_successor_idx ON procurement.vendor_invoices(replaces_invoice_id) WHERE replaces_invoice_id IS NOT NULL",
];
const dialect = new PgDialect();
interface PlanNode { "Index Name"?: string; Plans?: PlanNode[] }
function usedIndexes(plan: PlanNode): string[] {
  return [...(plan["Index Name"] ? [plan["Index Name"]] : []), ...(plan.Plans ?? []).flatMap(usedIndexes)];
}

databaseTests.sequential("document number prefix index migration", () => {
  let pool: pg.Pool;
  let ownsProcurement = false, ownsInventory = false, ownsMigrations = false;

  beforeAll(async () => {
    validatePostgresTestEnvironment(process.env);
    pool = new pg.Pool({ connectionString: TEST_URL, ssl: false, max: 2, statement_timeout: 20000 });
    await pool.query("CREATE SCHEMA procurement"); ownsProcurement = true;
    await pool.query("CREATE SCHEMA inventory"); ownsInventory = true;
    await pool.query("CREATE TABLE public._migrations(filename text PRIMARY KEY,content_hash text NOT NULL)"); ownsMigrations = true;
    for (const source of SOURCES) await pool.query(fixtureTable(source.schema));
    for (const statement of PREEXISTING_INDEXES) await pool.query(statement);
  });

  beforeEach(async () => {
    if (!ownsProcurement || !ownsInventory || !ownsMigrations) throw new Error("Number index fixture ownership missing");
    for (const source of SOURCES) await pool.query(`DROP INDEX IF EXISTS ${source.table.split(".")[0]}.${source.index}`);
    await pool.query(`TRUNCATE ${SOURCES.map(source => source.table).join(",")},public._migrations RESTART IDENTITY`);
    for (const source of SOURCES) {
      await pool.query(`INSERT INTO ${source.table}(${source.column},${source.columns})
        SELECT $1||'20260101-'||n::text,${source.values} FROM generate_series(1,5000) n`, [source.label + "-"]);
      await pool.query(`INSERT INTO ${source.table}(${source.column},${source.columns})
        SELECT $1||lpad(n::text,3,'0'),${source.values} FROM generate_series(1,10) n`, [source.label + "-20261025-"]);
      // A manual reference matching the date prefix is preserved but is not a numeric suffix.
      await pool.query(`INSERT INTO ${source.table}(${source.column},${source.columns})
        SELECT $1,${source.values} FROM (SELECT 1 AS n) seed`, [source.label + "-20261025-9999-manual"]);
    }
  });

  afterAll(async () => {
    try {
      if (ownsProcurement) await pool.query("DROP SCHEMA procurement CASCADE");
      if (ownsInventory) await pool.query("DROP SCHEMA inventory CASCADE");
      if (ownsMigrations) await pool.query("DROP TABLE public._migrations");
    } finally { await pool?.end(); }
  });

  async function migrate(filename = "synthetic-document-number-indexes.sql") {
    const client = await pool.connect();
    try {
      return await executeMigrationWithRetry({ client, file: filename, sql: MIGRATION, contentHash: MIGRATION_HASH,
        options: { maxAttempts: 1, retryBaseDelayMs: 0, retryMaxDelayMs: 0, lockTimeoutMs: 1000 } });
    } finally { client.release(); }
  }

  async function records() {
    const result: Record<string, unknown> = {};
    for (const source of SOURCES) result[source.kind] = (await pool.query(`SELECT count(*)::integer AS count,
      md5(string_agg(md5(to_jsonb(row)::text),'' ORDER BY id)) AS digest FROM ${source.table} row`)).rows[0];
    return result;
  }

  async function indexes() {
    return (await pool.query(`SELECT namespace.nspname AS schema_name,source.relname AS table_name,relation.relname AS index_name,
      attribute.attname AS column_name,definition.indisunique AS is_unique,definition.indisvalid AS valid,definition.indisready AS ready,
      definition.indnkeyatts AS key_count,definition.indnatts AS total_count,definition.indpred IS NULL AS is_full,
      definition.indexprs IS NULL AS is_column,method.amname AS method,operator.opcname AS operator_class
      FROM pg_index definition JOIN pg_class relation ON relation.oid=definition.indexrelid
      JOIN pg_class source ON source.oid=definition.indrelid JOIN pg_namespace namespace ON namespace.oid=source.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid=source.oid AND attribute.attnum=definition.indkey[0]
      JOIN pg_opclass operator ON operator.oid=definition.indclass[0] JOIN pg_am method ON method.oid=relation.relam
      WHERE relation.relname=ANY($1::text[]) ORDER BY relation.relname`, [SOURCES.map(source => source.index)])).rows;
  }

  it("applies through the release runner twice without altering any business record or uniqueness rule", async () => {
    const before = await records();
    const oldIndexes = (await pool.query("SELECT schemaname,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('procurement','inventory') ORDER BY indexname")).rows;
    expect(await migrate()).toEqual({ attempts: 1 });
    // Distinct synthetic ledger names deliberately exercise the same SQL twice.
    expect(await migrate("synthetic-document-number-indexes-second-pass.sql")).toEqual({ attempts: 1 });
    expect(await records()).toEqual(before);
    const after = (await pool.query("SELECT schemaname,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('procurement','inventory') ORDER BY indexname")).rows;
    expect(after.filter(row => !SOURCES.some(source => source.index === row.indexname))).toEqual(oldIndexes);
    expect(await indexes()).toEqual([...SOURCES].sort((a, b) => a.index.localeCompare(b.index)).map(source => ({
      schema_name: source.table.split(".")[0], table_name: source.table.split(".")[1], index_name: source.index,
      column_name: source.column, is_unique: false, valid: true, ready: true, key_count: 1, total_count: 1,
      is_full: true, is_column: true, method: "btree", operator_class: "varchar_pattern_ops",
    })));
    expect((await pool.query("SELECT content_hash FROM public._migrations ORDER BY filename")).rows)
      .toEqual([{ content_hash: MIGRATION_HASH }, { content_hash: MIGRATION_HASH }]);
  });

  it("keeps schema declarations aligned with the full nonunique migration indexes", () => {
    for (const source of SOURCES) {
      const definitions = getTableConfig(source.schema).indexes.filter(index => index.config.name === source.index);
      expect(definitions).toHaveLength(1);
      expect(definitions[0].config).toMatchObject({ unique: false, columns: [{ name: source.column, indexConfig: { opClass: "varchar_pattern_ops" } }] });
      expect(definitions[0].config.where).toBeUndefined();
      expect(definitions[0].config.concurrently).not.toBe(true);
    }
  });

  it.each(SOURCES)("uses the $kind prefix index with the actual numeric allocator query and inactive history", async source => {
    await migrate();
    await pool.query(`ANALYZE ${source.table}`);
    const client = await pool.connect();
    const queries: { sql: string; params: unknown[] }[] = [];
    try {
      await client.query("BEGIN");
      const executor = { execute: async (statement: SQL) => {
        const query = dialect.sqlToQuery(statement); queries.push(query);
        return client.query(query.sql, query.params);
      } };
      const prefix = source.label + "-20261025-";
      const next = source.kind === "invoice_suggestion" ? await readSuggestedInvoiceNumber(executor, prefix)
        : await allocateDocumentNumber(executor, { kind: source.kind, prefix });
      expect(next).toBe(prefix + "011");
      const read = queries.find(query => query.sql.includes("MAX(CASE WHEN"));
      if (!read) throw new Error("Document number query was not captured");
      const plan = (await client.query("EXPLAIN (FORMAT JSON) " + read.sql, read.params)).rows[0]["QUERY PLAN"][0].Plan as PlanNode;
      expect(usedIndexes(plan)).toContain(source.index);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it.each([
    { kind: "receipt", label: "RCV", legacyLock: "procurement.generate_receipt_number" },
    { kind: "payment", label: "PAY", legacyLock: "ap_payment_number" },
  ] as const)("waits for an in-flight legacy $kind writer and reads its committed number after release", async document => {
    await migrate();
    const legacyWriter = await pool.connect();
    const newWriter = await pool.connect();
    const source = SOURCES.find(candidate => candidate.kind === document.kind);
    if (!source) throw new Error("Legacy document source fixture is missing");
    const prefix = document.label + "-20261025-";
    const executor = { execute: async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      return newWriter.query(query.sql, query.params);
    } };
    try {
      await legacyWriter.query("BEGIN");
      await legacyWriter.query("SELECT pg_advisory_xact_lock(hashtext($1))", [document.legacyLock]);
      // Model a prior-version writer holding its existing lock through insert.
      // The new allocator must not race this uncommitted number.
      await legacyWriter.query(`INSERT INTO ${source.table}(${source.column},${source.columns})
        SELECT $1,${source.values} FROM (SELECT 1 AS n) seed`, [prefix + "011"]);
      await newWriter.query("BEGIN");
      await newWriter.query("SET LOCAL lock_timeout='100ms'");
      await expect(allocateDocumentNumber(executor, { kind: document.kind, prefix })).rejects.toMatchObject({ code: "55P03" });
      await newWriter.query("ROLLBACK");

      await legacyWriter.query("COMMIT");
      await newWriter.query("BEGIN");
      await newWriter.query("SET LOCAL lock_timeout='100ms'");
      expect(await allocateDocumentNumber(executor, { kind: document.kind, prefix })).toBe(prefix + "012");
    } finally {
      try { await legacyWriter.query("ROLLBACK"); } finally { legacyWriter.release(); }
      try { await newWriter.query("ROLLBACK"); } finally { newWriter.release(); }
    }
  });
  it("rejects an incompatible same-name index and rolls back every newly created index and migration receipt", async () => {
    // The invalid final index ensures the preceding four CREATE INDEX statements
    // have run before the guard fails; all four must roll back with the receipt.
    await pool.query("CREATE INDEX vendor_invoices_invoice_number_prefix_idx ON procurement.vendor_invoices(invoice_number)");
    const before = await records();
    await expect(migrate()).rejects.toMatchObject({ code: "55000" });
    expect(await records()).toEqual(before);
    expect(await indexes()).toEqual([expect.objectContaining({ index_name: "vendor_invoices_invoice_number_prefix_idx", operator_class: "text_ops" })]);
    expect((await pool.query("SELECT * FROM public._migrations")).rows).toEqual([]);
  });
});
