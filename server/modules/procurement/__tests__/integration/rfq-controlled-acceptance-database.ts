import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { fixtureForeignKeys, fixtureTable } from "./shipment-line-fixture";
import { RFQ_CONTROLLED_MIGRATIONS } from "./rfq-controlled-acceptance-helper";

const TABLES = [schema.products, schema.productVariants, schema.warehouses, schema.echelonSettings, schema.vendors,
  schema.vendorProducts, schema.purchaseOrders, schema.purchaseOrderLines, schema.poStatusHistory,
  schema.poEvents, schema.purchasingRecommendationDecisions, schema.purchasingRecommendationPoHandoffs];
const SCHEMAS = ["catalog", "warehouse", "procurement"] as const;
const PUBLIC_TABLES = ["financial_command_recoveries", "financial_command_results", "audit_events"] as const;

/** Dedicated local database only; no application migrations or database URLs are loaded. */
export async function createControlledRfqDatabase(url: string, at: Date) {
  if (process.env.ECHELON_TEST_DATABASE_DISPOSABLE !== "true"
    || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)
    || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(url)) {
    throw new Error("Controlled RFQ tests require a separate, explicitly disposable local database");
  }
  const pool = new pg.Pool({ connectionString: url, ssl: false, max: 8, statement_timeout: 15_000 });
  const ownedSchemas: string[] = [];
  let ownsPublicTables = false;
  let lease: pg.PoolClient | undefined;
  let modulePool: pg.Pool | undefined;
  let restoreModulePool: (() => void) | undefined;

  async function close() {
    try {
      if (ownsPublicTables) {
        for (const table of PUBLIC_TABLES) await pool.query(`DROP TABLE IF EXISTS public.${table}`);
      }
      for (const name of [...ownedSchemas].reverse()) await pool.query(`DROP SCHEMA ${name} CASCADE`);
    } finally {
      restoreModulePool?.();
      if (lease) {
        await lease.query("SELECT pg_advisory_unlock(hashtext('echelon.procurement.cost-audit-fixture'))");
        lease.release();
      }
      await pool.end();
      await modulePool?.end();
    }
  }

  try {
    lease = await pool.connect();
    const lock = await lease.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('echelon.procurement.cost-audit-fixture')) AS acquired",
    );
    if (!lock.rows[0].acquired) throw new Error("Another procurement fixture owns this database");
    const existing = await pool.query<{ name: string }>(
      "SELECT nspname AS name FROM pg_namespace WHERE nspname = ANY($1::text[])", [SCHEMAS],
    );
    if (existing.rows.length) throw new Error("Controlled RFQ tests refuse an existing application schema");
    for (const table of PUBLIC_TABLES) {
      if ((await pool.query<{ relation: string | null }>("SELECT to_regclass($1) AS relation", [`public.${table}`])).rows[0].relation) {
        throw new Error(`Controlled RFQ tests refuse an existing public.${table}`);
      }
    }
    for (const name of SCHEMAS) { await pool.query(`CREATE SCHEMA ${name}`); ownedSchemas.push(name); }
    for (const table of TABLES) await pool.query(fixtureTable(table));
    await pool.query("CREATE UNIQUE INDEX purch_rec_decisions_id_rec_kind_uidx ON procurement.purchasing_recommendation_decisions(id,recommendation_id,kind)");
    await pool.query("CREATE UNIQUE INDEX purchase_order_lines_po_id_line_id_uidx ON procurement.purchase_order_lines(purchase_order_id,id)");
    await pool.query("CREATE UNIQUE INDEX purchase_orders_po_number_unique ON procurement.purchase_orders(po_number)");
    // Migration 159 supplies this composite identity for migration 162's FK;
    // the unrelated demand-event tables are outside this fixture's owner path.
    await pool.query("CREATE UNIQUE INDEX product_variants_id_product_uidx ON catalog.product_variants(id,product_id)");
    for (const statement of fixtureForeignKeys(TABLES)) await pool.query(statement);
    ownsPublicTables = true;
    await pool.query(fixtureTable(schema.auditEvents));
    for (const migration of RFQ_CONTROLLED_MIGRATIONS) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", migration), "utf8"));
    }
    const database = drizzle(pool, { schema });
    const priorDatabase = process.env.DATABASE_URL;
    const priorExternal = process.env.EXTERNAL_DATABASE_URL;
    delete process.env.DATABASE_URL; delete process.env.EXTERNAL_DATABASE_URL;
    try {
      const [dbModule, procurement, catalog, purchasing, warehouse] = await Promise.all([
        import("../../../../db"), import("../../procurement.storage"),
        import("../../../catalog/catalog.storage"), import("../../purchasing.service"),
        import("../../../warehouse/infrastructure/warehouse.repository"),
      ]);
      // Existing legacy storage imports the module pool. Redirect its transport
      // to this same disposable SQL database; business services stay unmodified.
      modulePool = dbModule.pool;
      const originalQuery = modulePool.query;
      const originalConnect = modulePool.connect;
      restoreModulePool = () => { dbModule.pool.query = originalQuery; dbModule.pool.connect = originalConnect; };
      modulePool.query = pool.query.bind(pool) as typeof modulePool.query;
      modulePool.connect = pool.connect.bind(pool) as typeof modulePool.connect;
      const storage = { ...procurement.procurementMethods, ...catalog.productMethods,
        getSetting: (key: string) => warehouse.getSetting(key, database) };
      const purchasingOwner = purchasing.createPurchasingService(database, storage, { now: () => at });
      return { pool, database, purchasingOwner, close };
    } finally {
      if (priorDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabase;
      if (priorExternal === undefined) delete process.env.EXTERNAL_DATABASE_URL; else process.env.EXTERNAL_DATABASE_URL = priorExternal;
    }
  } catch (error) {
    await close();
    throw error;
  }
}
