import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { receivingUnitVersion } from "../../receiving-unit-contract";
import { readClosedShipmentReceivedBaseQtyByLine } from "../../receiving-shipment-coverage";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";

config({ path: resolve(process.cwd(), ".env.test") });
const DATABASE_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const databaseTests = DATABASE_URL && DISPOSABLE ? describe : describe.skip;
const NOW = new Date("2026-09-06T12:00:00.000Z");
const TABLES = [schema.products, schema.productVariants, schema.vendors,
  schema.purchaseOrders, schema.purchaseOrderLines, schema.inboundShipments, schema.inboundShipmentLines,
  schema.receivingOrders, schema.receivingLines, schema.poReceipts, schema.receiptReversals,
  schema.vendorInvoices, schema.vendorInvoiceLines, schema.poStatusHistory,
  schema.warehouses, schema.warehouseLocations, schema.inventoryLevels, schema.inventoryLots, schema.inventoryTransactions] as const;
type ReceivingService = import("../../receiving.service").ReceivingService;
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
const outcome = (work: Promise<unknown>): Promise<Outcome> => work.then(
  (value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }));

databaseTests.sequential("receiving frozen units PostgreSQL guarantees", () => {
  const actorId = `receiving-unit-test-${randomUUID()}`;
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let Receiving: typeof import("../../receiving.service").ReceivingService;
  let Reversal: typeof import("../../receipt-reversal.service").ReceiptReversalService;
  let inventory: import("../../../inventory/application/inventory.use-cases").InventoryUseCases;
  let service: ReceivingService;
  let reversal: InstanceType<typeof Reversal>;
  let storage: Record<string, (...args: any[]) => Promise<any>>;
  let defaultModulePool: pg.Pool | undefined;
  const ownedSchemas: string[] = [];
  let ownsAudit = false;
  let auditReady = false;
  let migrationEvidence: { before: unknown; after: unknown; replay: unknown };

  function createService(db: any = database, ownerStorage = storage) {
    return new Receiving(db, inventory as any, { queueSyncAfterInventoryChange: async () => undefined } as any,
      ownerStorage as any, null, null, null, null, null, null, () => NOW);
  }

  async function line(id = 51) {
    const [value] = await database.select().from(schema.receivingLines).where(eq(schema.receivingLines.id, id));
    if (!value) throw new Error(`Fixture receiving line ${id} missing`);
    return value;
  }

  async function versions() {
    const values = await database.select().from(schema.receivingLines).where(eq(schema.receivingLines.receivingOrderId, 50));
    return { expectedUnitVersions: values.map((value) => ({ lineId: value.id, unitVersion: receivingUnitVersion(value) })) };
  }

  async function state() {
    const values = await Promise.all(TABLES.map((table) => pool.query(`SELECT * FROM ${qualifiedTable(table)} ORDER BY id`)));
    const audit = await pool.query("SELECT * FROM public.audit_events WHERE actor=$1 ORDER BY id", [actorId]);
    return [...values.map((value) => value.rows), audit.rows];
  }

  async function reverse(key: string, target = reversal) {
    return target.reverseReceivingLine({ receivingLineId: 51, qty: 1, reason: "Fixture receipt correction",
      idempotencyKey: `receiving-${key}`, userId: actorId });
  }

  async function failingWrite(table: "public.audit_events" | "inventory.inventory_transactions" | "procurement.receipt_reversals", event: "INSERT" | "UPDATE", work: () => Promise<void>) {
    await pool.query(`CREATE FUNCTION procurement.receiving_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receiving fixture injected write failure'; END $$;
      CREATE TRIGGER receiving_test_failure BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION procurement.receiving_test_failure()`);
    try { await work(); }
    finally {
      await pool.query(`DROP TRIGGER receiving_test_failure ON ${table}; DROP FUNCTION procurement.receiving_test_failure()`);
    }
  }

  async function waitUntilBlocked(pid: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await pool.query<{ blocked: boolean }>("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [pid])).rows[0]?.blocked) return;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error(`Receiving backend ${pid} did not reach its expected PostgreSQL lock`);
  }

  function observed(work: (target: ReceivingService) => Promise<unknown>) {
    let reportPid!: (pid: number) => void;
    const pid = new Promise<number>((ready) => { reportPid = ready; });
    const observer = createService({ transaction: (callback: (tx: any) => Promise<unknown>) => database.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '8s'`);
      const backend = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      reportPid(Number(backend.rows[0].pid));
      return callback(tx);
    }) });
    return { pid, result: outcome(work(observer)) };
  }

  beforeAll(async () => {
    if ([process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(DATABASE_URL!)) {
      throw new Error("Receiving tests require a separate explicitly disposable database");
    }
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8,
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL!) ? false : { rejectUnauthorized: false } });
    for (const name of ["catalog", "procurement", "warehouse", "inventory"]) {
      await pool.query(`CREATE SCHEMA ${name}`);
      ownedSchemas.push(name);
    }
    for (const table of TABLES) await pool.query(fixtureTable(table));
    // Start from real pre-221 column shape and preserve a historical line. No
    // application backfill is run, and replay uses the same migration text.
    await pool.query(`ALTER TABLE procurement.receiving_lines DROP COLUMN units_per_variant_snapshot, DROP COLUMN inbound_shipment_line_id;
      INSERT INTO procurement.receiving_orders(id,receipt_number,source_type,status) VALUES(900,'LEGACY-MIGRATION','blind','closed');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,sku,expected_qty,received_qty) VALUES(901,900,'LEGACY',3,3)`);
    const before = (await pool.query("SELECT id,receiving_order_id,sku,expected_qty,received_qty FROM procurement.receiving_lines WHERE id=901")).rows[0];
    const migration = readFileSync(resolve(process.cwd(), "migrations/221_receiving_unit_snapshots.sql"), "utf8");
    await pool.query(migration);
    const after = (await pool.query("SELECT id,receiving_order_id,sku,expected_qty,received_qty,units_per_variant_snapshot,inbound_shipment_line_id FROM procurement.receiving_lines WHERE id=901")).rows[0];
    await pool.query(migration);
    const replay = (await pool.query("SELECT id,receiving_order_id,sku,expected_qty,received_qty,units_per_variant_snapshot,inbound_shipment_line_id FROM procurement.receiving_lines WHERE id=901")).rows[0];
    migrationEvidence = { before, after, replay };
    for (const statement of fixtureForeignKeys(TABLES)) await pool.query(statement);
    await pool.query(`
      CREATE UNIQUE INDEX po_receipts_po_line_rcv_line_idx ON procurement.po_receipts(purchase_order_line_id,receiving_line_id);
      CREATE UNIQUE INDEX receipt_reversals_idempotency_key_idx ON procurement.receipt_reversals(idempotency_key);
      ALTER TABLE procurement.receiving_lines ADD CHECK(reversed_qty >= 0 AND reversed_qty <= received_qty);
      CREATE UNIQUE INDEX receiving_fixture_inventory_level_idx ON inventory.inventory_levels(product_variant_id,warehouse_location_id)`);
    if (!(await pool.query("SELECT to_regclass('public.audit_events') AS relation")).rows[0].relation) {
      await pool.query(fixtureTable(schema.auditEvents));
      ownsAudit = true;
    }
    auditReady = true;
    database = drizzle(pool, { schema });
    const oldDatabase = process.env.DATABASE_URL;
    const oldExternal = process.env.EXTERNAL_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.EXTERNAL_DATABASE_URL;
    try {
      const [receivingModule, reversalModule, procurementModule, inventoryModule, repositoryModule, lotsModule, dbModule] = await Promise.all([
        import("../../receiving.service"), import("../../receipt-reversal.service"), import("../../procurement.storage"),
        import("../../../inventory/application/inventory.use-cases"), import("../../../inventory/infrastructure/inventory.repository"),
        import("../../../inventory/lots.service"), import("../../../../db"),
      ]);
      Receiving = receivingModule.ReceivingService;
      Reversal = reversalModule.ReceiptReversalService;
      defaultModulePool = dbModule.pool;
      const methods = procurementModule.procurementMethods;
      storage = {
        getReceivingOrderById: (id, tx = database) => methods.getReceivingOrderById(id, tx),
        getReceivingLineById: (id, tx = database) => methods.getReceivingLineById(id, tx),
        getReceivingLines: (id, tx = database) => methods.getReceivingLines(id, tx),
        updateReceivingLine: (id, patch, tx = database) => methods.updateReceivingLine(id, patch, tx),
        updateReceivingOrder: (id, patch, tx = database) => methods.updateReceivingOrder(id, patch, tx),
        getPurchaseOrderLineById: (id, tx = database) => methods.getPurchaseOrderLineById(id, tx),
      };
      inventory = new inventoryModule.InventoryUseCases(database, repositoryModule.createInventoryMethods(database), new lotsModule.InventoryLotService(database));
      service = createService();
      reversal = new Reversal(database, inventory);
    } finally {
      if (oldDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldDatabase;
      if (oldExternal === undefined) delete process.env.EXTERNAL_DATABASE_URL; else process.env.EXTERNAL_DATABASE_URL = oldExternal;
    }
  });

  beforeEach(async () => {
    if (ownedSchemas.length !== 4) throw new Error("Receiving fixture schema ownership not established");
    await pool.query(`TRUNCATE ${TABLES.map(qualifiedTable).join(",")} RESTART IDENTITY CASCADE`);
    await pool.query("DELETE FROM public.audit_events WHERE actor=$1", [actorId]);
    await pool.query(`
      INSERT INTO catalog.products(id,sku,name) VALUES(100,'TEST-PRODUCT','Receiving test product');
      INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant,uom_type,is_base_unit)
        VALUES(200,100,'TEST-CASE','Case of 250',250,'case',false),(201,100,'TEST-EACH','Single piece',1,'piece',true);
      INSERT INTO procurement.vendors(id,code,name) VALUES(5,'TEST-VENDOR','Receiving fixture vendor');
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status) VALUES(10,'TEST-PO',5,'sent');
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,product_variant_id,sku,order_qty,unit_cost_cents,unit_cost_mills,status)
        VALUES(21,10,1,100,200,'TEST-PRODUCT',1000,4,375,'open');
      INSERT INTO procurement.inbound_shipments(id,shipment_number,status) VALUES(1,'TEST-SHIP','in_transit');
      INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,product_variant_id,sku,qty_shipped,carton_count)
        VALUES(11,1,10,21,200,'TEST-PRODUCT',501,3);
      INSERT INTO warehouse.warehouses(id,code,name) VALUES(1,'TEST-WAREHOUSE','Fixture warehouse');
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(99,1,'TEST-DOCK');
      INSERT INTO procurement.receiving_orders(id,receipt_number,source_type,status,warehouse_id,updated_at)
        VALUES(50,'TEST-RECEIPT','blind','open',1,'2026-09-05T12:00:00Z');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,product_id,product_variant_id,sku,expected_qty,received_qty,damaged_qty,units_per_variant_snapshot,putaway_location_id,unit_cost,unit_cost_mills,status,updated_at)
        VALUES(51,50,100,200,'TEST-CASE',4,2,1,250,99,4,375,'partial','2026-09-05T12:00:00Z')`);
  });

  afterAll(async () => {
    try {
      if (pool) {
        if (ownsAudit) await pool.query("DROP TABLE public.audit_events");
        else if (auditReady) await pool.query("DELETE FROM public.audit_events WHERE actor=$1", [actorId]);
        for (const name of [...ownedSchemas].reverse()) await pool.query(`DROP SCHEMA ${name} CASCADE`);
      }
    } finally { await pool?.end(); await defaultModulePool?.end(); }
  });

  it("applies and replays migration 221 without reinterpreting historical rows", async () => {
    expect(migrationEvidence.after).toEqual({ ...migrationEvidence.before as object, units_per_variant_snapshot: null, inbound_shipment_line_id: null });
    expect(migrationEvidence.replay).toEqual(migrationEvidence.after);
    await expect(pool.query("UPDATE procurement.receiving_lines SET units_per_variant_snapshot=0 WHERE id=51")).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE procurement.receiving_lines SET inbound_shipment_line_id=999 WHERE id=51")).rejects.toMatchObject({ code: "23503" });
    await pool.query("UPDATE procurement.receiving_lines SET inbound_shipment_line_id=11 WHERE id=51");
    await expect(pool.query("DELETE FROM procurement.inbound_shipment_lines WHERE id=11")).rejects.toMatchObject({ code: "23503" });
  });

  it("converts exact units atomically with unchanged per-piece cost and matching audit actor/time", async () => {
    const result = await service.updateLine(51, { productVariantId: 201, expectedUnitVersion: receivingUnitVersion(await line()) }, actorId);
    expect(result).toMatchObject({ expectedQty: 1000, receivedQty: 500, damagedQty: 250, unitsPerVariantSnapshot: 1, unitCost: 4, unitCostMills: 375, updatedAt: NOW });
    const audit = (await pool.query("SELECT timestamp,actor,changes FROM public.audit_events WHERE actor=$1", [actorId])).rows;
    expect(audit).toEqual([{ timestamp: NOW, actor: actorId, changes: { before: expect.objectContaining({ receivedQty: 2, unitsPerVariantSnapshot: 250 }), after: expect.objectContaining({ receivedQty: 500, unitsPerVariantSnapshot: 1 }) } }]);
  });

  it.each(["update", "complete-all"])("rolls back %s line/header writes when its audit insert fails", async (operation) => {
    await pool.query("UPDATE procurement.receiving_lines SET received_qty=0 WHERE id=51");
    const before = await state();
    await failingWrite("public.audit_events", "INSERT", async () => {
      const work = operation === "update"
        ? service.updateLine(51, { receivedQty: 1, expectedUnitVersion: receivingUnitVersion(await line()) }, actorId)
        : service.completeAllLines(50, await versions(), actorId);
      await expect(work).rejects.toThrow(/receiving fixture injected write failure/);
    });
    expect(await state()).toEqual(before);
  });

  it("allows only one of two conflicting unit/count edits using the same reviewed version", async () => {
    const token = receivingUnitVersion(await line());
    const holder = await pool.connect();
    const pending: ReturnType<typeof observed>[] = [];
    let open = false;
    try {
      await holder.query("BEGIN"); open = true;
      await holder.query("SELECT id FROM procurement.receiving_orders WHERE id=50 FOR UPDATE");
      pending.push(observed((target) => target.updateLine(51, { productVariantId: 201, expectedUnitVersion: token }, actorId)),
        observed((target) => target.updateLine(51, { receivedQty: 3, expectedUnitVersion: token }, actorId)));
      await Promise.all(pending.map(async (command) => waitUntilBlocked(await command.pid)));
      await holder.query("COMMIT"); open = false;
      const results = await Promise.all(pending.map((command) => command.result));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)).toMatchObject({ error: { details: { code: "RECEIVING_UNIT_VERSION_CONFLICT" } } });
      expect((await pool.query("SELECT count(*)::int AS count FROM public.audit_events WHERE actor=$1", [actorId])).rows[0].count).toBe(1);
    } finally { if (open) await holder.query("ROLLBACK"); holder.release(); await Promise.all(pending.map((command) => command.result)); }
  });

  it.each(["changed timestamp", "same timestamp"])("rejects a close with concurrent count changes and %s", async (timestampCase) => {
    const holder = await pool.connect();
    let open = false;
    let pending: ReturnType<typeof observed> | undefined;
    try {
      await holder.query("BEGIN"); open = true;
      await holder.query("SELECT id FROM procurement.receiving_orders WHERE id=50 FOR UPDATE");
      pending = observed((target) => target.close(50, actorId));
      await waitUntilBlocked(await pending.pid);
      await holder.query("UPDATE procurement.receiving_lines SET received_qty=3,updated_at=$1 WHERE id=51", [timestampCase === "same timestamp" ? "2026-09-05T12:00:00Z" : "2026-09-06T12:00:00Z"]);
      await holder.query("COMMIT"); open = false;
      expect(await pending.result).toMatchObject({ ok: false, error: { details: { code: "RECEIVING_CLOSE_SNAPSHOT_CHANGED" } } });
      expect((await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions")).rows[0].count).toBe(0);
    } finally { if (open) await holder.query("ROLLBACK"); holder.release(); if (pending) await pending.result; }
  });

  it("posts exactly 501 pieces once while unavailable PO reconciliation remains explicitly retryable", async () => {
    await pool.query(`UPDATE procurement.receiving_orders SET source_type='shipment',inbound_shipment_id=1,purchase_order_id=10 WHERE id=50;
      UPDATE procurement.receiving_lines SET product_variant_id=201,units_per_variant_snapshot=1,expected_qty=501,received_qty=501,damaged_qty=0,purchase_order_line_id=21,inbound_shipment_line_id=11 WHERE id=51`);
    // This fixture deliberately omits the post-commit purchasing owner. Physical
    // posting commits once, while both initial close and replay report that gap.
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(service.close(50, actorId)).rejects.toMatchObject({
        statusCode: 409, details: { reason: "purchasing_unavailable" },
      });
    }
    expect((await pool.query("SELECT status FROM procurement.receiving_orders WHERE id=50")).rows).toEqual([{ status: "closed" }]);
    expect((await pool.query("SELECT variant_qty FROM inventory.inventory_levels")).rows).toEqual([{ variant_qty: 501 }]);
    expect((await pool.query("SELECT qty_received,qty_on_hand,unit_cost_mills FROM inventory.inventory_lots")).rows).toEqual([{ qty_received: 501, qty_on_hand: 501, unit_cost_mills: "375" }]);
    expect((await pool.query("SELECT receiving_line_id,variant_qty_delta FROM inventory.inventory_transactions")).rows).toEqual([{ receiving_line_id: 51, variant_qty_delta: 501 }]);
  });

  it.each(["purchase_order_line_id", "purchase_order_id", "inbound_shipment_id"] as const)(
    "rejects an exact shipment link missing %s before physical posting", async (missingField) => {
      await pool.query(`UPDATE procurement.receiving_orders SET source_type='shipment',inbound_shipment_id=1,purchase_order_id=10 WHERE id=50;
        UPDATE procurement.receiving_lines SET purchase_order_line_id=21,inbound_shipment_line_id=11 WHERE id=51`);
      const target = missingField === "purchase_order_line_id"
        ? "procurement.receiving_lines" : "procurement.receiving_orders";
      await pool.query(`UPDATE ${target} SET ${missingField}=NULL`);
      const before = await state();
      await expect(service.close(50, actorId)).rejects.toMatchObject({
        statusCode: 409, details: { code: "RECEIVING_SHIPMENT_SOURCE_MISMATCH" },
      });
      expect(await state()).toEqual(before);
    },
  );

  it("rolls back actual inventory balance and lot writes when the receipt ledger fails", async () => {
    const before = await state();
    await failingWrite("inventory.inventory_transactions", "INSERT", async () => {
      await expect(service.close(50, actorId)).rejects.toThrow(/receiving fixture injected write failure/);
    });
    expect(await state()).toEqual(before);
  });

  it("reverses a frozen standalone receipt using original units after a catalog factor change", async () => {
    await service.close(50, actorId);
    await pool.query("UPDATE catalog.product_variants SET units_per_variant=500 WHERE id=200");
    expect(await reverse("standalone")).toMatchObject({ baseUnitsReversed: 250, qty: 1, lotUnitCostMills: 93750, idempotentReplay: false });
    expect(await reverse("standalone")).toMatchObject({ baseUnitsReversed: 250, idempotentReplay: true });
    expect((await pool.query("SELECT variant_qty FROM inventory.inventory_levels")).rows).toEqual([{ variant_qty: 1 }]);
    expect((await pool.query("SELECT qty_on_hand,unit_cost_mills FROM inventory.inventory_lots")).rows).toEqual([{ qty_on_hand: 1, unit_cost_mills: "93750" }]);
    expect((await pool.query("SELECT base_units_reversed FROM procurement.receipt_reversals")).rows).toEqual([{ base_units_reversed: 250 }]);
  });

  it("rejects contradictory frozen and original PO quantities before inventory compensation", async () => {
    await service.close(50, actorId);
    await pool.query(`UPDATE procurement.receiving_orders SET purchase_order_id=10 WHERE id=50;
      UPDATE procurement.receiving_lines SET purchase_order_line_id=21 WHERE id=51;
      UPDATE procurement.purchase_order_lines SET received_qty=750 WHERE id=21;
      INSERT INTO procurement.po_receipts(purchase_order_id,purchase_order_line_id,receiving_order_id,receiving_line_id,qty_received) VALUES(10,21,50,51,750)`);
    const before = await state();
    await expect(reverse("contradictory")).rejects.toMatchObject({ details: { code: "RECEIVING_UNIT_SNAPSHOT_REVIEW_REQUIRED" } });
    expect(await state()).toEqual(before);
  });

  it("reconciles a legacy reversal from exact original PO posting, never current catalog units", async () => {
    await service.close(50, actorId);
    await pool.query(`UPDATE procurement.receiving_orders SET purchase_order_id=10 WHERE id=50;
      UPDATE procurement.receiving_lines SET purchase_order_line_id=21,units_per_variant_snapshot=NULL WHERE id=51;
      UPDATE procurement.purchase_order_lines SET received_qty=500,status='partially_received' WHERE id=21;
      UPDATE catalog.product_variants SET units_per_variant=500 WHERE id=200;
      INSERT INTO procurement.po_receipts(purchase_order_id,purchase_order_line_id,receiving_order_id,receiving_line_id,qty_received) VALUES(10,21,50,51,500)`);
    expect(await reverse("legacy")).toMatchObject({ baseUnitsReversed: 250 });
    expect((await pool.query("SELECT received_qty FROM procurement.purchase_order_lines WHERE id=21")).rows).toEqual([{ received_qty: 250 }]);
  });

  it("rolls back reversal tally, record, lot, level and ledger after a final backfill failure", async () => {
    await service.close(50, actorId);
    const before = await state();
    await failingWrite("procurement.receipt_reversals", "UPDATE", async () => {
      await expect(reverse("rollback")).rejects.toThrow(/receiving fixture injected write failure/);
    });
    expect(await state()).toEqual(before);
  });

  async function coverageSources() {
    return database.select().from(schema.inboundShipmentLines).where(eq(schema.inboundShipmentLines.inboundShipmentId, 1));
  }

  it("maps duplicate PO sources only by exact shipment line and counts new closed rows before PO reconciliation", async () => {
    await pool.query(`INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,sku,qty_shipped) VALUES(12,1,10,21,'SECOND',250);
      UPDATE procurement.receiving_orders SET source_type='shipment',inbound_shipment_id=1,purchase_order_id=10,status='closed' WHERE id=50;
      UPDATE procurement.receiving_lines SET purchase_order_line_id=21,inbound_shipment_line_id=11,units_per_variant_snapshot=1,received_qty=251,expected_qty=251,damaged_qty=0 WHERE id=51`);
    const result = await database.transaction(async (tx) => readClosedShipmentReceivedBaseQtyByLine(tx,
      { purchaseOrderId: 10, inboundShipmentId: 1, shipmentLines: await coverageSources() }));
    expect(result.get(11)).toBe(251);
    expect(result.get(12) ?? 0).toBe(0);
  });

  it("rejects an ambiguous legacy receipt across duplicate shipment sources", async () => {
    await pool.query(`INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,sku,qty_shipped) VALUES(12,1,10,21,'SECOND',250);
      UPDATE procurement.receiving_orders SET source_type='shipment',inbound_shipment_id=1,purchase_order_id=10,status='closed' WHERE id=50;
      UPDATE procurement.receiving_lines SET purchase_order_line_id=21,units_per_variant_snapshot=NULL WHERE id=51;
      INSERT INTO procurement.po_receipts(purchase_order_id,purchase_order_line_id,receiving_order_id,receiving_line_id,qty_received) VALUES(10,21,50,51,500)`);
    await expect(database.transaction(async (tx) => readClosedShipmentReceivedBaseQtyByLine(tx,
      { purchaseOrderId: 10, inboundShipmentId: 1, shipmentLines: await coverageSources() })))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("explicitly confirms an unposted legacy unit without changing any recorded count", async () => {
    await pool.query("UPDATE procurement.receiving_lines SET units_per_variant_snapshot=NULL WHERE id=51");
    const token = receivingUnitVersion(await line());
    const before = await state();
    await expect(service.updateLine(51, { productVariantId: 200, expectedUnitVersion: token }, actorId))
      .rejects.toMatchObject({ details: { code: "RECEIVING_UNIT_CONFIRMATION_REQUIRED" } });
    expect(await state()).toEqual(before);
    expect(await service.updateLine(51, { productVariantId: 200, expectedUnitVersion: token, confirmLegacyUnit: true, expectedUnitsPerVariant: 250 }, actorId))
      .toMatchObject({ expectedQty: 4, receivedQty: 2, damagedQty: 1, unitsPerVariantSnapshot: 250 });
  });

  it("blocks standalone legacy reversal without frozen or original posting evidence", async () => {
    await service.close(50, actorId);
    await pool.query("UPDATE procurement.receiving_lines SET units_per_variant_snapshot=NULL WHERE id=51");
    const before = await state();
    await expect(reverse("missing-evidence")).rejects.toMatchObject({ details: { code: "RECEIVING_UNIT_SNAPSHOT_REVIEW_REQUIRED" } });
    expect(await state()).toEqual(before);
  });

  it("nets exact reversal evidence against the original shipment source without live catalog lookup", async () => {
    await pool.query(`UPDATE procurement.receiving_orders SET source_type='shipment',inbound_shipment_id=1,purchase_order_id=10,status='closed' WHERE id=50;
      UPDATE procurement.receiving_lines SET purchase_order_line_id=21,inbound_shipment_line_id=11,reversed_qty=1 WHERE id=51;
      INSERT INTO procurement.receipt_reversals(receiving_order_id,receiving_line_id,qty,base_units_reversed,reason,idempotency_key)
        VALUES(50,51,1,250,'Recorded correction','coverage-net');
      UPDATE catalog.product_variants SET units_per_variant=1000 WHERE id=200`);
    const sources = await coverageSources();
    const result = await database.transaction((tx) => readClosedShipmentReceivedBaseQtyByLine(tx,
      { purchaseOrderId: 10, inboundShipmentId: 1, shipmentLines: sources }));
    expect(result.get(11)).toBe(250);
    await pool.query("UPDATE procurement.receipt_reversals SET base_units_reversed=1000");
    await expect(database.transaction((tx) => readClosedShipmentReceivedBaseQtyByLine(tx,
      { purchaseOrderId: 10, inboundShipmentId: 1, shipmentLines: sources })))
      .rejects.toMatchObject({ details: { code: "SHIPMENT_RECEIPT_COVERAGE_REVIEW_REQUIRED" } });
  });

  it("rejects a receipt pointing at a source line under the wrong shipment header", async () => {
    await pool.query(`INSERT INTO procurement.inbound_shipments(id,shipment_number,status) VALUES(2,'OTHER-SHIP','in_transit');
      UPDATE procurement.receiving_orders SET source_type='shipment',inbound_shipment_id=2,purchase_order_id=10,status='closed' WHERE id=50;
      UPDATE procurement.receiving_lines SET purchase_order_line_id=21,inbound_shipment_line_id=11 WHERE id=51`);
    const sources = await coverageSources();
    await expect(database.transaction((tx) => readClosedShipmentReceivedBaseQtyByLine(tx,
      { purchaseOrderId: 10, inboundShipmentId: 1, shipmentLines: sources })))
      .rejects.toMatchObject({ details: { code: "SHIPMENT_RECEIPT_COVERAGE_REVIEW_REQUIRED" } });
  });

  it("rejects legacy confirmation when the displayed catalog pack changes before its shared lock", async () => {
    await pool.query("UPDATE procurement.receiving_lines SET units_per_variant_snapshot=NULL WHERE id=51");
    const token = receivingUnitVersion(await line());
    const holder = await pool.connect();
    let open = false;
    let pending: ReturnType<typeof observed> | undefined;
    try {
      await holder.query("BEGIN"); open = true;
      await holder.query("UPDATE catalog.product_variants SET units_per_variant=500 WHERE id=200");
      pending = observed((target) => target.updateLine(51, { productVariantId: 200, expectedUnitVersion: token,
        confirmLegacyUnit: true, expectedUnitsPerVariant: 250 }, actorId));
      await waitUntilBlocked(await pending.pid);
      await holder.query("COMMIT"); open = false;
      expect(await pending.result).toMatchObject({ ok: false, error: { statusCode: 409, details: { code: "RECEIVING_UNIT_CHANGED" } } });
      expect(await line()).toMatchObject({ unitsPerVariantSnapshot: null, expectedQty: 4, receivedQty: 2, damagedQty: 1 });
      expect((await pool.query("SELECT count(*)::int AS count FROM public.audit_events WHERE actor=$1", [actorId])).rows[0].count).toBe(0);
    } finally { if (open) await holder.query("ROLLBACK"); holder.release(); if (pending) await pending.result; }
  });
});
