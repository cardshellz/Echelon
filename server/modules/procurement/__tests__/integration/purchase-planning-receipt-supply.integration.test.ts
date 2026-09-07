import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { purchaseInventorySnapshotQuery } from "../../purchase-inventory-snapshot.query";
import { readPurchasePlanningSnapshot, type PurchasePlanningDatabase } from "../../purchase-planning-snapshot.repository";
import { buildPurchaseSupplyTiming } from "../../purchase-supply-timing";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const suite = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
type StockRow = { product_id: number; total_pieces: string; total_reserved_pieces: string };

suite.sequential("receipt-aware planning source PostgreSQL guarantees", () => {
  let pool: pg.Pool;
  let lease: pg.PoolClient | undefined;
  let ownsSchemas = false;
  let database: PurchasePlanningDatabase;
  const schemas = ["procurement", "inventory", "catalog", "warehouse"];

  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
      || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(url)) {
      throw new Error("Use a separate explicitly disposable local planning test database.");
    }
    pool = new pg.Pool({ connectionString: url, max: 5, statement_timeout: 10_000 });
    lease = await pool.connect();
    const lock = await lease.query("SELECT pg_try_advisory_lock(hashtext('echelon.procurement.cost-audit-fixture')) AS acquired");
    if (!lock.rows[0].acquired) throw new Error("Another procurement fixture owns the schema lease.");
    const existing = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])", [schemas]);
    if (existing.rowCount !== 0) throw new Error("The planning fixture refuses to replace existing owner schemas.");
    const setup = await pool.connect();
    try {
      await setup.query("BEGIN");
      await setup.query([
        "CREATE SCHEMA procurement",
        "CREATE SCHEMA inventory",
        "CREATE SCHEMA catalog",
        "CREATE SCHEMA warehouse",
        "CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer NOT NULL,units_per_variant integer NOT NULL,is_active boolean NOT NULL)",
        "CREATE TABLE warehouse.warehouse_locations(id integer PRIMARY KEY,location_type text)",
        "CREATE TABLE inventory.inventory_levels(product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),warehouse_location_id integer REFERENCES warehouse.warehouse_locations(id),variant_qty integer NOT NULL,reserved_qty integer NOT NULL DEFAULT 0)",
        "CREATE TABLE procurement.purchase_orders(id integer PRIMARY KEY,po_number text NOT NULL,status text NOT NULL,confirmed_delivery_date date,expected_delivery_date date)",
        "CREATE TABLE procurement.purchase_order_lines(id integer PRIMARY KEY,purchase_order_id integer NOT NULL REFERENCES procurement.purchase_orders(id),product_id integer,line_type text NOT NULL DEFAULT 'product',status text NOT NULL DEFAULT 'open',order_qty integer NOT NULL,received_qty integer NOT NULL DEFAULT 0,cancelled_qty integer NOT NULL DEFAULT 0,promised_date date,expected_delivery_date date)",
        "CREATE TABLE procurement.inbound_shipment_lines(id integer PRIMARY KEY,inbound_shipment_id integer NOT NULL,purchase_order_id integer,purchase_order_line_id integer)",
        "CREATE TABLE procurement.receiving_orders(id integer PRIMARY KEY,purchase_order_id integer,inbound_shipment_id integer,status text NOT NULL)",
        "CREATE TABLE procurement.receiving_lines(id integer PRIMARY KEY,receiving_order_id integer NOT NULL REFERENCES procurement.receiving_orders(id),purchase_order_line_id integer,inbound_shipment_line_id integer,received_qty integer NOT NULL,reversed_qty integer NOT NULL DEFAULT 0,units_per_variant_snapshot integer)",
        "CREATE TABLE procurement.po_receipts(id integer PRIMARY KEY,receiving_line_id integer NOT NULL,receiving_order_id integer NOT NULL,purchase_order_id integer NOT NULL,purchase_order_line_id integer NOT NULL,qty_received integer NOT NULL)",
        "CREATE TABLE procurement.receipt_reversals(id integer PRIMARY KEY,receiving_line_id integer NOT NULL,receiving_order_id integer NOT NULL,qty integer NOT NULL,base_units_reversed integer)"
      ].join(";"));
      await setup.query("COMMIT");
      ownsSchemas = true;
    } catch (error) {
      await setup.query("ROLLBACK");
      throw error;
    } finally {
      setup.release();
    }
    database = drizzle(pool) as unknown as PurchasePlanningDatabase;
  });

  afterAll(async () => {
    try {
      if (ownsSchemas) await pool.query("DROP SCHEMA procurement, inventory, catalog, warehouse CASCADE");
    } finally {
      lease?.release();
      await pool?.end();
    }
  });

  beforeEach(async () => {
    await pool.query([
      "TRUNCATE procurement.receipt_reversals,procurement.po_receipts,procurement.receiving_lines,procurement.receiving_orders,procurement.inbound_shipment_lines,procurement.purchase_order_lines,procurement.purchase_orders,inventory.inventory_levels,catalog.product_variants,warehouse.warehouse_locations",
      "INSERT INTO catalog.product_variants VALUES(101,10,1,true),(202,20,1,true)",
      "INSERT INTO warehouse.warehouse_locations VALUES(1,'pickable')",
      "INSERT INTO inventory.inventory_levels VALUES(101,1,0,0),(202,1,0,0)",
      "INSERT INTO procurement.purchase_orders VALUES(1,'TEST-PO-1','sent',NULL,'2026-09-30')",
      "INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,product_id,order_qty) VALUES(11,1,10,100)"
    ].join(";"));
  });

  async function snapshot() {
    return readPurchasePlanningSnapshot(database, async (tx) => {
      const result = await tx.execute(purchaseInventorySnapshotQuery());
      return result.rows as StockRow[];
    });
  }
  async function position() {
    const rows = await snapshot();
    const row = rows.find((value) => value.product_id === 10);
    if (!row) throw new Error("Product fixture was not returned by the actual inventory snapshot query.");
    return row;
  }
  async function physicalReceipt() {
    await pool.query([
      "INSERT INTO procurement.receiving_orders VALUES(3,1,NULL,'closed')",
      "INSERT INTO procurement.receiving_lines VALUES(31,3,11,NULL,2,0,10)",
      "UPDATE inventory.inventory_levels SET variant_qty=20 WHERE product_variant_id=101"
    ].join(";"));
  }
  function timing(row: Awaited<ReturnType<typeof position>>) {
    return buildPurchaseSupplyTiming({
      asOfDate: "2026-09-01", availablePieces: Number(row.total_pieces), dailyPieces: 2,
      leadTimeDays: 30, safetyStockDays: 0,
      onOrderPieces: row.on_order_pieces, rawSchedule: row.inbound_schedule,
      rawReceiptEvidence: row.receipt_supply_evidence,
    });
  }

  it("subtracts committed physical receipts before the PO mirror is reconciled", async () => {
    await physicalReceipt();
    const row = await position();
    expect(Number(row.total_pieces)).toBe(20);
    expect(row.on_order_pieces).toBe(80);
    expect(Number(row.total_pieces) + row.on_order_pieces).toBe(100);
    expect(Math.max(0, 120 - Number(row.total_pieces) - row.on_order_pieces)).toBe(20);
    expect(row.receipt_supply_evidence.lines[0]).toMatchObject({
      poReceivedPieces: 0, closedReceivedPieces: 20, remainingPieces: 80, reviewIssues: [],
    });
    expect((await pool.query("SELECT received_qty FROM procurement.purchase_order_lines WHERE id=11")).rows[0].received_qty).toBe(0);
  });

  it("does not subtract the same receipt twice after exact PO posting", async () => {
    await physicalReceipt();
    await pool.query("INSERT INTO procurement.po_receipts VALUES(41,31,3,1,11,20); UPDATE procurement.purchase_order_lines SET received_qty=20 WHERE id=11");
    const row = await position();
    expect(row.on_order_pieces).toBe(80);
    expect(row.receipt_supply_evidence.lines[0].reviewIssues).toEqual([]);
  });

  it("uses proven net reversal pieces and requires the atomic PO reversal mirror", async () => {
    await physicalReceipt();
    await pool.query([
      "INSERT INTO procurement.po_receipts VALUES(41,31,3,1,11,20)",
      "INSERT INTO procurement.receipt_reversals VALUES(51,31,3,1,10)",
      "UPDATE procurement.receiving_lines SET reversed_qty=1 WHERE id=31",
      "UPDATE procurement.purchase_order_lines SET received_qty=10 WHERE id=11",
      "UPDATE inventory.inventory_levels SET variant_qty=10 WHERE product_variant_id=101"
    ].join(";"));
    const row = await position();
    expect(row.on_order_pieces).toBe(90);
    expect(row.receipt_supply_evidence.lines[0]).toMatchObject({ closedReceivedPieces: 10, reviewIssues: [] });
    await pool.query("UPDATE procurement.purchase_order_lines SET received_qty=20 WHERE id=11");
    const inconsistent = await position();
    expect(inconsistent.receipt_supply_evidence.lines[0].reviewIssues.length).toBeGreaterThan(0);
    expect(timing(inconsistent)).toMatchObject({ reviewRequired: true, signal: "unverified_receipts" });
  });

  it("retains unknown frozen units as review instead of using the current catalog factor", async () => {
    await physicalReceipt();
    await pool.query("UPDATE procurement.receiving_lines SET units_per_variant_snapshot=NULL WHERE id=31");
    const row = await position();
    expect(row.on_order_pieces).toBe(100);
    expect(row.receipt_supply_evidence.lines[0].closedReceivedPieces).toBeNull();
    expect(timing(row)).toMatchObject({ reviewRequired: true, signal: "unverified_receipts", scheduleComplete: false });
  });

  it("recovers a missing legacy factor only from its exact original posting without rewriting it", async () => {
    await physicalReceipt();
    await pool.query("UPDATE procurement.receiving_lines SET units_per_variant_snapshot=NULL WHERE id=31; INSERT INTO procurement.po_receipts VALUES(41,31,3,1,11,20); UPDATE procurement.purchase_order_lines SET received_qty=20 WHERE id=11");
    const row = await position();
    expect(row.on_order_pieces).toBe(80);
    expect(row.receipt_supply_evidence.lines[0].reviewIssues).toEqual([]);
    expect((await pool.query("SELECT units_per_variant_snapshot FROM procurement.receiving_lines WHERE id=31")).rows[0].units_per_variant_snapshot).toBeNull();
  });
  it("does not let a larger new unposted receipt conceal unsupported older received history", async () => {
    await physicalReceipt();
    await pool.query("UPDATE procurement.purchase_order_lines SET order_qty=1000,received_qty=100 WHERE id=11; UPDATE procurement.receiving_lines SET received_qty=20 WHERE id=31; UPDATE inventory.inventory_levels SET variant_qty=300 WHERE product_variant_id=101");
    const row = await position();
    expect(row.on_order_pieces).toBe(900);
    expect(row.receipt_supply_evidence.lines[0].reviewIssues.length).toBeGreaterThan(0);
    expect(timing(row)).toMatchObject({ signal: "unverified_receipts", reviewRequired: true, scheduleComplete: false });
  });

  it("separates consolidated purchases and counts split receipt pieces once per exact line", async () => {
    await pool.query([
      "INSERT INTO procurement.purchase_orders VALUES(2,'TEST-PO-2','acknowledged',NULL,'2026-10-10')",
      "INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,product_id,order_qty) VALUES(22,2,20,50)",
      "INSERT INTO procurement.inbound_shipment_lines VALUES(111,7,1,11),(222,7,2,22),(113,8,1,11)",
      "INSERT INTO procurement.receiving_orders VALUES(3,NULL,7,'closed'),(4,1,8,'closed')",
      "INSERT INTO procurement.receiving_lines VALUES(31,3,11,111,2,0,10),(32,3,22,222,1,0,5),(33,4,11,113,3,0,10)",
      "UPDATE inventory.inventory_levels SET variant_qty=50 WHERE product_variant_id=101",
      "UPDATE inventory.inventory_levels SET variant_qty=5 WHERE product_variant_id=202"
    ].join(";"));
    const rows = await snapshot();
    const first = rows.find((row) => row.product_id === 10)!;
    const second = rows.find((row) => row.product_id === 20)!;
    expect(first.on_order_pieces).toBe(50);
    expect(second.on_order_pieces).toBe(45);
    expect(first.receipt_supply_evidence.lines[0]).toMatchObject({ receivingLineIds: [31, 33], closedReceivedPieces: 50, reviewIssues: [] });
    expect(second.receipt_supply_evidence.lines[0]).toMatchObject({ receivingLineIds: [32], closedReceivedPieces: 5, reviewIssues: [] });
  });

  it("uses supplier promises and confirmed header dates ahead of the general request", async () => {
    await pool.query("UPDATE inventory.inventory_levels SET variant_qty=20 WHERE product_variant_id=101; UPDATE procurement.purchase_orders SET expected_delivery_date='2026-09-05',confirmed_delivery_date='2026-10-15' WHERE id=1");
    const confirmed = await position();
    expect(confirmed.inbound_schedule[0]).toMatchObject({ expectedDate: "2026-10-15", expectedDateSource: "purchase_confirmed" });
    expect(timing(confirmed)).toMatchObject({ firstGapDate: "2026-09-11", reviewRequired: true });
    await pool.query("UPDATE procurement.purchase_order_lines SET promised_date='2026-11-01',expected_delivery_date='2026-09-10' WHERE id=11");
    expect((await position()).inbound_schedule[0]).toMatchObject({ expectedDate: "2026-11-01", expectedDateSource: "line_promised" });
  });

  it("removes a fully closed receipt from inbound supply before PO reconciliation", async () => {
    await physicalReceipt();
    await pool.query("UPDATE procurement.receiving_lines SET received_qty=10 WHERE id=31; UPDATE inventory.inventory_levels SET variant_qty=100 WHERE product_variant_id=101");
    const row = await position();
    expect(row).toMatchObject({ on_order_pieces: 0, open_po_count: 0, earliest_expected: null, inbound_schedule: [] });
    expect(row.receipt_supply_evidence.lines[0]).toMatchObject({ closedReceivedPieces: 100, remainingPieces: 0, reviewIssues: [] });
  });

  it("keeps an unlinked closed receipt in review without allocating by product or SKU", async () => {
    await physicalReceipt();
    await pool.query("UPDATE procurement.receiving_lines SET purchase_order_line_id=NULL WHERE id=31");
    const row = await position();
    expect(row.on_order_pieces).toBe(100);
    expect(row.receipt_supply_evidence.lines[0].receivingLineIds).toEqual([31]);
    expect(timing(row)).toMatchObject({ signal: "unverified_receipts", reviewRequired: true });
  });

  it("requires recorded reversal identities rather than trusting a reversal counter alone", async () => {
    await physicalReceipt();
    await pool.query("UPDATE procurement.receiving_lines SET reversed_qty=1 WHERE id=31; UPDATE inventory.inventory_levels SET variant_qty=10 WHERE product_variant_id=101");
    const row = await position();
    expect(row.receipt_supply_evidence.lines[0].closedReceivedPieces).toBeNull();
    expect(timing(row)).toMatchObject({ signal: "unverified_receipts", reviewRequired: true });
  });

  it("keeps a coherent stock and receipt snapshot across a concurrent physical close", async () => {
    let isolation = "";
    let readOnly = "";
    const during = await readPurchasePlanningSnapshot(database, async (tx) => {
      const settings = await tx.execute(sql.raw("SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only"));
      isolation = String(settings.rows[0].isolation);
      readOnly = String(settings.rows[0].read_only);
      const stock = await tx.execute(purchaseInventorySnapshotQuery());
      // A second connection commits physical stock and its closed receipt while
      // the reader is between stock and inbound-supply reads. PO sync is later.
      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("UPDATE inventory.inventory_levels SET variant_qty=20 WHERE product_variant_id=101");
        await writer.query("INSERT INTO procurement.receiving_orders VALUES(3,1,NULL,'closed'); INSERT INTO procurement.receiving_lines VALUES(31,3,11,NULL,2,0,10)");
        await writer.query("COMMIT");
      } catch (error) {
        await writer.query("ROLLBACK");
        throw error;
      } finally {
        writer.release();
      }
      return stock.rows as StockRow[];
    });
    expect(isolation).toBe("repeatable read");
    expect(readOnly).toBe("on");
    const before = during.find((row) => row.product_id === 10)!;
    expect(Number(before.total_pieces)).toBe(0);
    expect(before.on_order_pieces).toBe(100);
    const after = await position();
    expect(Number(after.total_pieces)).toBe(20);
    expect(after.on_order_pieces).toBe(80);
    expect(Number(before.total_pieces) + before.on_order_pieces).toBe(Number(after.total_pieces) + after.on_order_pieces);
  });

  it("lets PostgreSQL enforce the read-only planning boundary", async () => {
    try {
      await readPurchasePlanningSnapshot(database, async (tx) => {
        await tx.execute(sql.raw("UPDATE inventory.inventory_levels SET variant_qty=999 WHERE product_variant_id=101"));
        return [] as StockRow[];
      });
      throw new Error("The read-only planning transaction unexpectedly allowed a stock write.");
    } catch (error) {
      const rejected = error as { code?: string; cause?: { code?: string } };
      expect(rejected.code ?? rejected.cause?.code).toBe("25006");
    }
    expect(Number((await position()).total_pieces)).toBe(0);
  });
});
