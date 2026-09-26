/** Database definitions only; no customer rows, apply mode or application runtime. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { captureCleanupTriggerHash, CLEANUP_WRITTEN_TABLES } from "./inventory-cutover-records-execution-20260925";

const tables = [...CLEANUP_WRITTEN_TABLES,
  "inventory.cutover_admission_fence", "inventory.availability_runtime_authority",
  "wms.orders", "wms.order_items", "wms.outbound_shipments", "wms.outbound_shipment_items", "wms.reconciliation_exceptions",
  "inventory.inventory_levels", "inventory.inventory_lots", "inventory.inventory_transactions",
  "oms.order_item_costs", "oms.channel_fulfillment_receipts", "oms.channel_fulfillment_pushes",
];

async function main(): Promise<void> {
  const raw = process.env.ECHELON_CUTOVER_READONLY_URL;
  delete process.env.ECHELON_CUTOVER_READONLY_URL;
  delete process.env.DATABASE_URL;
  delete process.env.EXTERNAL_DATABASE_URL;
  if (!raw) throw new Error("READONLY_CONNECTION_REQUIRED");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("INVALID_CONNECTION");
  const pool = new pg.Pool({ host: url.hostname, port: Number(url.port || "5432"), user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)),
    ssl: { rejectUnauthorized: true }, max: 1, connectionTimeoutMillis: 15_000,
    options: "-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=1000",
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const guard = (await client.query("SELECT transaction_timestamp() AS checked_at,current_setting('transaction_read_only') AS read_only")).rows[0];
    if (guard.read_only !== "on") throw new Error("READONLY_REQUIRED");
    const columns = (await client.query(`SELECT n.nspname AS schema,c.relname AS table,a.attname AS name,a.attnum AS ordinal,
      format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,a.attidentity AS identity,
      a.attgenerated AS generated,pg_get_expr(d.adbin,d.adrelid) AS default_expression
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname||'.'||c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY n.nspname,c.relname,a.attnum`, [tables])).rows;
    if (new Set(columns.map(row => `${row.schema}.${row.table}`)).size !== tables.length) throw new Error("SCHEMA_TABLE_MISSING");
    const constraints = (await client.query(`SELECT n.nspname||'.'||c.relname AS table,k.conname AS name,k.contype AS type,
      pg_get_constraintdef(k.oid,true) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname||'.'||c.relname=ANY($1::text[])
      ORDER BY 1,2`, [tables])).rows;
    const indexes = (await client.query(`SELECT schemaname||'.'||tablename AS table,indexname AS name,indexdef AS definition
      FROM pg_indexes WHERE schemaname||'.'||tablename=ANY($1::text[]) ORDER BY 1,2`, [tables])).rows;
    const triggers = (await client.query(`SELECT n.nspname||'.'||c.relname AS table,t.tgname AS name,
      pg_get_triggerdef(t.oid) AS definition,pg_get_functiondef(t.tgfoid) AS function_definition,
      t.tgfoid::text AS function_id,t.tgenabled AS enabled FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname||'.'||c.relname=ANY($1::text[]) ORDER BY 1,2`, [CLEANUP_WRITTEN_TABLES])).rows;
    const enums = (await client.query(`SELECT n.nspname AS schema,t.typname AS name,array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
      WHERE t.oid IN (SELECT a.atttypid FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace cn ON cn.oid=c.relnamespace WHERE cn.nspname||'.'||c.relname=ANY($1::text[]))
      GROUP BY n.nspname,t.typname ORDER BY 1,2`, [tables])).rows;
    const triggerHash = await captureCleanupTriggerHash(client);
    const authority = (await client.query("SELECT authority,revision::text FROM inventory.availability_runtime_authority WHERE singleton_key=true")).rows;
    await client.query("ROLLBACK");
    const directory = resolve("artifacts/inventory-cutover-20260924");
    mkdirSync(directory, { recursive: true });
    const file = resolve(directory, `records-schema-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const content = JSON.stringify({ ...guard, productionWrites: false, tables, columns, constraints, indexes, triggers, enums, triggerHash, authority }, null, 2) + "\n";
    writeFileSync(file, content, { flag: "wx" });
    console.log(JSON.stringify({ file, sha256: createHash("sha256").update(content).digest("hex"),
      tables: tables.length, triggers: triggers.length, triggerHash, authority, productionWrites: false }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); await pool.end(); }
}
main().catch(error => {
  const code = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "READONLY_SCHEMA_CAPTURE_FAILED";
  console.error(JSON.stringify({ code, productionWrites: false }));
  process.exitCode = 1;
});
