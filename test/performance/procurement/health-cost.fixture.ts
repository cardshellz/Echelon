import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type pg from "pg";
import * as schema from "../../../shared/schema";
import { createFlowCostHarness, seedFlowMasterData, FLOW_AT, FLOW_ACTOR, FLOW_IDS, type FlowCostHarness } from "../../../server/modules/procurement/__tests__/integration/procurement-flow-cost.fixture";
import { fixtureTable, identifier, qualifiedTable } from "../../../server/modules/procurement/__tests__/integration/shipment-line-fixture";
import { receivingUnitVersion } from "../../../server/modules/procurement/receiving-unit-contract";
import { isShipmentCostLinePosted } from "../../../shared/procurement/shipment-cost-workflow";

export const PERFORMANCE_AS_OF = new Date("2026-10-25T12:00:00.000Z");
export const PERFORMANCE_LINES_PER_SHIPMENT = 5;
export const PERFORMANCE_FANOUT_LIMIT = 100;
export const PERFORMANCE_ID_BASE = 10_000;
const schemas = ["identity", "catalog", "procurement", "warehouse", "inventory", "wms", "oms", "public"];
const additionalTables = [schema.reorderExclusionRules, schema.productLines, schema.productLineProducts,
  schema.demandEvents, schema.demandEventLines, schema.omsOrderLines,
  schema.purchasePipelineJobRuns, schema.purchaseForecastEvaluations];

/** Actual indexes from migration 027 (with the table names established by the
 * later shipment-cost rename). The fixture does not pretend to replay all
 * historical migrations. The report retains the entire installed index catalog.
 */
const shipmentIndexDdl = `
 CREATE INDEX IF NOT EXISTS idx_inbound_shipment_lines_shipment ON procurement.inbound_shipment_lines(inbound_shipment_id);
 CREATE INDEX IF NOT EXISTS idx_inbound_shipment_lines_po ON procurement.inbound_shipment_lines(purchase_order_id);
 CREATE INDEX IF NOT EXISTS idx_inbound_shipment_lines_po_line ON procurement.inbound_shipment_lines(purchase_order_line_id);
 CREATE INDEX IF NOT EXISTS idx_shipment_costs_shipment ON procurement.inbound_freight_costs(inbound_shipment_id);
 CREATE INDEX IF NOT EXISTS idx_shipment_cost_alloc_cost ON procurement.inbound_freight_allocations(shipment_cost_id);
 CREATE INDEX IF NOT EXISTS idx_shipment_cost_alloc_line ON procurement.inbound_freight_allocations(inbound_shipment_line_id);
 CREATE INDEX IF NOT EXISTS idx_landed_cost_snapshots_line ON procurement.landed_cost_snapshots(inbound_shipment_line_id);
 CREATE INDEX IF NOT EXISTS idx_landed_cost_snapshots_variant ON procurement.landed_cost_snapshots(product_variant_id);`;

export async function createProcurementPerformanceFixture(url: string, mode: "unresolved" | "posted" = "unresolved") {
  if ([".env", ".env.test"].some(file => existsSync(resolve(process.cwd(), file)))) throw new Error("Performance verification refuses local dotenv files");
  const parsed = new URL(url);
  if (process.env.ECHELON_TEST_DATABASE_DISPOSABLE !== "true"
    || !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.search !== "" || parsed.hash !== ""
    || !/^procurement_(?:recovery|performance)_[a-z0-9_]+$/.test(decodeURIComponent(parsed.pathname.slice(1)))
    || process.env.DATABASE_URL || process.env.EXTERNAL_DATABASE_URL) {
    throw new Error("Performance verification requires an explicitly disposable, uniquely named local database and cleared live database variables");
  }
  const harness = await createFlowCostHarness(url);
  const publicTables: string[] = [];
  let seededShipments = 0;
  try {
    const identity = await harness.pool.query("SELECT current_database() AS database, host(inet_server_addr()) AS address, current_user AS username");
    assert.equal(identity.rows[0].database, decodeURIComponent(parsed.pathname.slice(1)));
    assert.ok(["127.0.0.1", "::1"].includes(identity.rows[0].address));
    for (const table of additionalTables) {
      const name = qualifiedTable(table);
      if ((await harness.pool.query("SELECT to_regclass($1) AS relation", [name])).rows[0].relation) continue;
      await harness.pool.query(fixtureTable(table));
      if (name.startsWith('"public".')) publicTables.push(name);
    }
    // These three legacy runtime columns are in migration 052 but are not
    // declared on the current Drizzle warehouseSettings table.
    const dashboardMigration = readFileSync(resolve(process.cwd(), "migrations/052_purchasing_dashboard.sql"), "utf8");
    const settingsStatements = dashboardMigration.match(/ALTER TABLE warehouse_settings[\s\S]*?;/g);
    if (settingsStatements?.length !== 1) throw new Error("Purchasing dashboard settings migration boundary changed");
    await harness.pool.query(settingsStatements[0].replace("ALTER TABLE warehouse_settings", "ALTER TABLE inventory.warehouse_settings"));
    await harness.pool.query(shipmentIndexDdl);
    for (const migration of ["156_landed_cost_current_row_uniqueness.sql", "068_invoice_line_freight_cost_link.sql",
      "900000031000019120001_procurement_document_number_prefix_indexes.sql"]) {
      await harness.pool.query(readFileSync(resolve(process.cwd(), "migrations", migration), "utf8"));
    }
    await seedFlowMasterData(harness);
    // Empty historical demand is intentional. This measures cost/health fanout,
    // not a large orders/forecast corpus; recommendation owners still execute.
    await harness.pool.query("UPDATE wms.orders SET order_placed_at=$1,created_at=$1,updated_at=$1", [FLOW_AT]);
    return {
      harness,
      identity: identity.rows[0] as { database: string; address: string; username: string },
      async seedTo(shipments: number): Promise<void> {
        if (!Number.isSafeInteger(shipments) || shipments <= seededShipments || shipments > (mode === "posted" ? 100 : 500)) throw new Error("Invalid bounded performance fixture size");
        const previousShipments = seededShipments;
        const client = await harness.pool.connect();
        try {
          await client.query("BEGIN");
          if (seededShipments === 0) {
            await client.query(`INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,physical_status,source,currency,total_cents,line_count,created_at,updated_at)
              VALUES($1,'PERF-PO-FANOUT',5,'acknowledged','in_transit','manual','USD',5000000,5,$2,$2)`, [PERFORMANCE_ID_BASE + 1, FLOW_AT]);
            await seedPurchaseLines(client, PERFORMANCE_ID_BASE + 1, 10_000);
          }
          for (let index = seededShipments + 1; index <= shipments; index++) {
            const id = PERFORMANCE_ID_BASE + index;
            const purchaseId = index <= PERFORMANCE_FANOUT_LIMIT ? PERFORMANCE_ID_BASE + 1 : id;
            if (index > PERFORMANCE_FANOUT_LIMIT) {
              await client.query(`INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,physical_status,source,currency,total_cents,line_count,created_at,updated_at)
                VALUES($1,$2,5,'acknowledged','in_transit','manual','USD',50000,5,$3,$3)`, [id, `PERF-PO-${index}`, FLOW_AT]);
              await seedPurchaseLines(client, purchaseId, 100);
            }
            await client.query(`INSERT INTO procurement.inbound_shipments(id,shipment_number,status,mode,warehouse_id,allocation_method_default,total_pieces,created_at,updated_at)
              VALUES($1,$2,'closed','ocean',1,'by_line_count',500,$3,$3)`, [id, `PERF-SHIP-${index}`, FLOW_AT]);
            await client.query(`INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,product_variant_id,sku,qty_shipped)
              SELECT $1 * 10 + line,$1,$2,$2 * 10 + line,201,'PROC-UAT-FLOW-A-EACH',100 FROM generate_series(1,5) AS line`, [id, purchaseId]);
            await client.query(`INSERT INTO procurement.inbound_freight_costs(id,inbound_shipment_id,cost_type,estimated_cents,currency,allocation_method,cost_status)
              VALUES($1,$1,'freight',1000,'USD','by_line_count','estimated')`, [id]);
          }
          await client.query("COMMIT");
          seededShipments = shipments;
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
        if (mode === "posted") {
          // Construct real receipt/lot lineage and cost applications outside the
          // timed reads. No application result or posting status is fabricated.
          for (let index = previousShipments + 1; index <= shipments; index++) {
            const shipmentId = PERFORMANCE_ID_BASE + index;
            const receipt = await harness.purchasing.createReceiptFromShipment(shipmentId, FLOW_ACTOR,
              { purchaseOrderId: PERFORMANCE_ID_BASE + 1 });
            await harness.receiving.open(receipt.id, FLOW_ACTOR);
            await harness.receiving.updateOrderDetails(receipt.id, { warehouseId: FLOW_IDS.warehouse }, FLOW_ACTOR);
            const lines = await harness.storage.getReceivingLines(receipt.id);
            assert.equal(lines.length, PERFORMANCE_LINES_PER_SHIPMENT);
            for (const line of lines) {
              assert.equal(line.expectedQty, 100);
              await harness.receiving.updateLine(line.id, { receivedQty: 100, putawayLocationId: FLOW_IDS.locationX,
                expectedUnitVersion: receivingUnitVersion(line) }, FLOW_ACTOR);
            }
            await harness.receiving.close(receipt.id, FLOW_ACTOR);
            await harness.database.transaction(tx => harness.shipment.updateCostsInTransaction(tx, shipmentId, {}, FLOW_ACTOR, FLOW_AT));
            const review = await harness.shipment.getCostReview(shipmentId);
            assert.ok(review);
            assert.equal(review.lines.length, PERFORMANCE_LINES_PER_SHIPMENT);
            assert.ok(review.lines.every(isShipmentCostLinePosted), "Posted performance fixture must have actual current applied evidence");
            assert.ok(review.lines.every(line => line.application?.status === "applied"), "Posting must come from actual lot applications");
          }
        }
        await harness.pool.query("ANALYZE");
      },
      fingerprint: () => fingerprintTables(harness.pool),
      metadata: async () => ({
        database: (await harness.pool.query("SELECT version() AS version,current_setting('shared_buffers') AS shared_buffers,current_setting('work_mem') AS work_mem,current_setting('max_connections') AS max_connections")).rows[0],
        indexes: (await harness.pool.query("SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=ANY($1::text[]) ORDER BY schemaname,tablename,indexname", [schemas])).rows,
        tables: (await harness.pool.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname=ANY($1::text[]) ORDER BY schemaname,tablename", [schemas])).rows,
      }),
      /** Reserve every usable pool connection (the FLOW lease owns the tenth),
       * set PostgreSQL read-only defaults, then release them. New connections inherit
       * the same startup default. A disconnect is reported
       * by node-postgres; the runner must abort instead of silently retrying.
       */
      readOnly: (enabled: boolean) => configurePoolReadOnly(harness, enabled),
      async dispose(): Promise<void> {
        try {
          await configurePoolReadOnly(harness, false);
          for (const table of [...publicTables].reverse()) await harness.pool.query(`DROP TABLE ${table}`);
        } finally { await harness.dispose(); }
      },
    };
  } catch (error) {
    for (const table of [...publicTables].reverse()) await harness.pool.query(`DROP TABLE ${table}`);
    await harness.dispose();
    throw error;
  }
}
async function seedPurchaseLines(client: pg.PoolClient, poId: number, quantity: number): Promise<void> {
  await client.query(`INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,line_type,status,product_id,product_variant_id,sku,order_qty,unit_cost_cents,unit_cost_mills,total_product_cost_cents,line_total_cents,packaging_cost_cents,discount_cents,tax_cents)
    SELECT $1 * 10 + line,$1,line,'product','open',100,201,'PROC-UAT-FLOW-A-EACH',$2,100,10000,$2 * 100,$2 * 100,0,0,0
    FROM generate_series(1,5) AS line`, [poId, quantity]);
}
async function configurePoolReadOnly(harness: FlowCostHarness, enabled: boolean): Promise<void> {
  // pg-pool constructs new clients from this options object (pg-pool/index.js).
  // Validate the runtime property because @types/pg does not expose it.
  const poolOptions: unknown = Reflect.get(harness.pool, "options");
  if (!poolOptions || typeof poolOptions !== "object") throw new Error("Expected pg-pool options are unavailable");
  const prior: unknown = Reflect.get(poolOptions, "options");
  if (prior !== undefined && typeof prior !== "string") throw new Error("Unexpected PostgreSQL startup options");
  Reflect.set(poolOptions, "options", (prior ?? "").replace(/\s*-c default_transaction_read_only=(?:on|off)/g, "") + ` -c default_transaction_read_only=${enabled ? "on" : "off"}`);
  const clients: pg.PoolClient[] = [];
  try {
    for (let index = 0; index < 9; index++) clients.push(await harness.pool.connect());
    for (const client of clients) await client.query(`SET default_transaction_read_only = ${enabled ? "on" : "off"}`);
  } finally { for (const client of clients) client.release(); }
}
async function fingerprintTables(pool: pg.Pool) {
  const tables = await pool.query<{ schemaname: string; tablename: string }>(
    "SELECT schemaname,tablename FROM pg_tables WHERE schemaname=ANY($1::text[]) ORDER BY schemaname,tablename", [schemas]);
  const result: { table: string; rows: string; digest: string }[] = [];
  for (const table of tables.rows) {
    const name = `${identifier(table.schemaname)}.${identifier(table.tablename)}`;
    const digest = await pool.query(`SELECT count(*)::text AS rows,md5(COALESCE(string_agg(to_jsonb(row)::text,E'\\n' ORDER BY to_jsonb(row)::text),'')) AS digest FROM ${name} AS row`);
    result.push({ table: name, ...digest.rows[0] });
  }
  return result;
}
export type ProcurementPerformanceFixture = Awaited<ReturnType<typeof createProcurementPerformanceFixture>>;
