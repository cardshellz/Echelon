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
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import { receiptReversalCommandResultSchema, type ReceiptReversalAction } from "@shared/procurement/receipt-reversal-command";
import { readClosedShipmentReceivedBaseQtyByLine } from "../../receiving-shipment-coverage";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";
import { resetFixtureWithEmptyReceivingCustody } from "./receiving-custody-fixture";
import { installPreOpeningQuantityAuthorityFixture } from "../../../inventory/__tests__/fixtures/pre-opening-quantity-authority.fixture";

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
  let commandsReady = false;
  let reversalCommands: typeof import("../../receipt-reversal.commands");
  let commandRepository: typeof import("../../../../platform/commands/command-results.repository").createDrizzleFinancialCommandRepository;
  const commandKeys = new Set<string>();
  let migrationEvidence: { before: unknown; after: unknown; replay: unknown };

  function executeReversal(name: string, input: {
    action?: ReceiptReversalAction;
    targetId?: number;
    body?: unknown;
    actorId?: string;
    key?: string;
  } = {}) {
    const action = input.action ?? "line";
    const targetId = input.targetId ?? (action === "line" ? 51 : 50);
    const body = input.body ?? (action === "line"
      ? { qty: 1, reason: "Correct duplicate receipt paperwork" }
      : { reason: "Correct duplicate receipt paperwork" });
    const operator = input.actorId ?? actorId;
    const idempotencyKey = input.key ?? `${actorId}:${name}`;
    commandKeys.add(idempotencyKey);
    const scope = reversalCommands.receiptReversalCommandScope();
    const descriptor: FinancialCommandDescriptor = {
      ...scope, actorType: "service", actorId: reversalCommands.RECEIPT_REVERSAL_COMMAND_PRINCIPAL,
      idempotencyKey, requestHash: reversalCommands.hashReceiptReversalCommandIdentity({ action, targetId, body, actorId: operator }),
      contractVersion: 1,
    };
    return reversalCommands.createReceiptReversalCommands(reversal, commandRepository(database))
      .execute(action, targetId, body, operator, descriptor);
  }

  async function clearCommands() {
    if (!commandsReady || commandKeys.size === 0) return;
    await pool.query("DELETE FROM public.financial_command_results WHERE actor_id=$1 AND idempotency_key=ANY($2::text[])",
      [reversalCommands.RECEIPT_REVERSAL_COMMAND_PRINCIPAL, [...commandKeys]]);
    commandKeys.clear();
  }

  async function retryDue(name: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await pool.query("SELECT next_attempt_at <= clock_timestamp() AS due FROM public.financial_command_results WHERE actor_id=$1 AND idempotency_key=$2",
        [reversalCommands.RECEIPT_REVERSAL_COMMAND_PRINCIPAL, `${actorId}:${name}`]);
      if (result.rows[0]?.due === true) return;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error("The failed receipt reversal did not reach its first retry window");
  }

  async function waitForGraphBlockedBy(holderPid: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const blocked = await pool.query(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
          AND query LIKE '%inventory.cost_graph%'`, [holderPid]);
      if (blocked.rows.length === 1) return;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error("Receipt reversal did not reach its inventory graph lock");
  }

  async function seedSecondReceiptLine() {
    await pool.query(`INSERT INTO procurement.receiving_lines(id,receiving_order_id,product_id,product_variant_id,sku,
      expected_qty,received_qty,damaged_qty,units_per_variant_snapshot,putaway_location_id,unit_cost,unit_cost_mills,status)
      VALUES(52,50,100,200,'TEST-CASE-SECOND',1,1,0,250,99,4,375,'received')`);
  }

  async function linkClosedReceiptToMatchedPo() {
    await pool.query(`UPDATE procurement.receiving_orders SET purchase_order_id=10 WHERE id=50;
      UPDATE procurement.receiving_lines SET purchase_order_line_id=21 WHERE id=51;
      UPDATE procurement.purchase_orders SET status='received',physical_status='received' WHERE id=10;
      UPDATE procurement.purchase_order_lines SET order_qty=500,received_qty=500,status='received' WHERE id=21;
      INSERT INTO procurement.po_receipts(purchase_order_id,purchase_order_line_id,receiving_order_id,receiving_line_id,qty_received)
        VALUES(10,21,50,51,500);
      INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,invoiced_amount_cents,balance_cents)
        VALUES(70,'REVERSAL-FIXTURE',5,2000,2000);
      INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,purchase_order_line_id,line_number,qty_invoiced,unit_cost_cents,line_total_cents,match_status)
        VALUES(71,70,21,1,500,4,2000,'matched')`);
  }

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

  async function failingWrite(table: "public.audit_events" | "inventory.inventory_transactions" | "procurement.receipt_reversals" | "procurement.receiving_orders", event: "INSERT" | "UPDATE", work: () => Promise<void>) {
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
    const result = outcome(work(observer));
    return { pid: Promise.race([pid, result.then(() => {
      throw new Error("Observed receiving command finished before entering its transaction");
    })]), result };
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
    await installPreOpeningQuantityAuthorityFixture(pool);
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
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/222_procurement_cost_evidence.sql"), "utf8"));
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/900000017000018590001_receipt_shipment_quantity_amendments.sql"), "utf8"));
    for (const statement of fixtureForeignKeys(TABLES)) await pool.query(statement);
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/900000004000017890001_receiving_quarantine.sql"), "utf8"));
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
    for (const migration of ["136_financial_command_results.sql", "140_financial_command_operations.sql"]) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", migration), "utf8"));
    }
    commandsReady = true;
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
        getSetting: async () => "true",
        getAllProducts: () => database.select().from(schema.products),
        getAllProductVariants: () => database.select().from(schema.productVariants),
        getAllWarehouseLocations: () => database.select().from(schema.warehouseLocations),
        bulkCreateReceivingLines: (lines, tx = database) => methods.bulkCreateReceivingLines(lines, tx),
        getReceivingOrderById: (id, tx = database) => methods.getReceivingOrderById(id, tx),
        getReceivingLineById: (id, tx = database) => methods.getReceivingLineById(id, tx),
        getReceivingLines: (id, tx = database) => methods.getReceivingLines(id, tx),
        updateReceivingLine: (id, patch, tx = database) => methods.updateReceivingLine(id, patch, tx),
        updateReceivingOrder: (id, patch, tx = database) => methods.updateReceivingOrder(id, patch, tx),
        getPurchaseOrderLineById: (id, tx = database) => methods.getPurchaseOrderLineById(id, tx),
      };
      // The legacy inventory port permits caller-selected generic rows. Supply
      // the real Drizzle executor; the PostgreSQL tests never substitute results.
      const inventoryDatabase = database as unknown as ConstructorParameters<typeof inventoryModule.InventoryUseCases>[0];
      inventory = new inventoryModule.InventoryUseCases(inventoryDatabase, repositoryModule.createInventoryMethods(database), new lotsModule.InventoryLotService(database));
      service = createService();
      reversal = new Reversal(database, inventory);
      reversalCommands = await import("../../receipt-reversal.commands");
      commandRepository = (await import("../../../../platform/commands/command-results.repository")).createDrizzleFinancialCommandRepository;
    } finally {
      if (oldDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldDatabase;
      if (oldExternal === undefined) delete process.env.EXTERNAL_DATABASE_URL; else process.env.EXTERNAL_DATABASE_URL = oldExternal;
    }
  });

  beforeEach(async () => {
    if (ownedSchemas.length !== 4) throw new Error("Receiving fixture schema ownership not established");
    await resetFixtureWithEmptyReceivingCustody(pool, `TRUNCATE ${TABLES.map(qualifiedTable).join(",")} RESTART IDENTITY CASCADE`);
    await pool.query("DELETE FROM public.audit_events WHERE actor=$1", [actorId]);
    await clearCommands();
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
        VALUES(51,50,100,200,'TEST-CASE',4,2,0,250,99,4,375,'partial','2026-09-05T12:00:00Z')`);
  });

  afterAll(async () => {
    try {
      if (pool) {
        await clearCommands();
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
    await pool.query("UPDATE procurement.receiving_lines SET damaged_qty=1 WHERE id=51");
    const result = await service.updateLine(51, { productVariantId: 201, expectedUnitVersion: receivingUnitVersion(await line()) }, actorId);
    expect(result).toMatchObject({ expectedQty: 1000, receivedQty: 500, damagedQty: 250, unitsPerVariantSnapshot: 1, unitCost: 4, unitCostMills: 375, updatedAt: NOW });
    const audit = (await pool.query("SELECT timestamp,actor,changes FROM public.audit_events WHERE actor=$1", [actorId])).rows;
    expect(audit).toEqual([{ timestamp: NOW, actor: actorId, changes: { before: expect.objectContaining({ receivedQty: 2, unitsPerVariantSnapshot: 250 }), after: expect.objectContaining({ receivedQty: 500, unitsPerVariantSnapshot: 1 }) } }]);
  });

  it("opens a 525-case receipt with usable frozen versions and posts 525,000 pieces exactly once", async () => {
    await pool.query(`UPDATE catalog.product_variants SET units_per_variant=1000 WHERE id=200;
      UPDATE procurement.receiving_orders SET status='draft' WHERE id=50;
      UPDATE procurement.receiving_lines SET expected_qty=525,received_qty=0,damaged_qty=0,units_per_variant_snapshot=1000 WHERE id=51`);
    const original = await line();

    const opened = await service.open(50, actorId);

    expect(opened).toMatchObject({ status: "open", receivedBy: actorId, receivedDate: NOW,
      lines: [{ ...original, unitVersion: receivingUnitVersion(original) }] });
    expect(await line()).toEqual(original);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions")).rows[0].count).toBe(0);
    const saved = await service.updateLine(51, { receivedQty: 525, expectedUnitVersion: opened.lines[0].unitVersion }, actorId);
    expect(saved).toMatchObject({ receivedQty: 525, unitsPerVariantSnapshot: 1000, status: "complete" });
    const afterSave = await state();
    await expect(service.updateLine(51, { receivedQty: 524, expectedUnitVersion: opened.lines[0].unitVersion }, actorId))
      .rejects.toMatchObject({ details: { code: "RECEIVING_UNIT_VERSION_CONFLICT" } });
    expect(await state()).toEqual(afterSave);

    await service.close(50, actorId);
    await service.close(50, actorId);
    expect((await pool.query("SELECT variant_qty FROM inventory.inventory_levels")).rows).toEqual([{ variant_qty: 525 }]);
    expect((await pool.query("SELECT qty_received,qty_on_hand,unit_cost_mills FROM inventory.inventory_lots")).rows)
      .toEqual([{ qty_received: 525, qty_on_hand: 525, unit_cost_mills: "375000" }]);
    expect((await pool.query("SELECT receiving_line_id,variant_qty_delta FROM inventory.inventory_transactions")).rows)
      .toEqual([{ receiving_line_id: 51, variant_qty_delta: 525 }]);
    expect((await line()).receivedQty * (await line()).unitsPerVariantSnapshot!).toBe(525000);
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

  it.each(["empty", "one", "multiple"] as const)("rejects duplicate CSV identities on an %s receipt without changing any financial or physical evidence", async (shape) => {
    if (shape === "empty") await pool.query("DELETE FROM procurement.receiving_lines WHERE receiving_order_id=50");
    if (shape === "multiple") await pool.query(`INSERT INTO procurement.receiving_lines(id,receiving_order_id,sku,expected_qty,received_qty,putaway_location_id)
      VALUES(52,50,'TEST-CASE',7,7,99)`);
    const before = await state();
    await expect(service.bulkImportLines(50, [
      { sku: "TEST-CASE", qty: "5", location: "TEST-DOCK" },
      { sku: " test-case ", qty: "7", location: "test-dock" },
      { sku: "TEST-EACH", qty: "4", location: "TEST-DOCK" },
    ], actorId)).rejects.toMatchObject({ details: { code: "RECEIVING_IMPORT_IDENTITY_REVIEW_REQUIRED" } });
    expect(await state()).toEqual(before);
  });

  it("preserves separately recorded physical rows and rejects a CSV replacement that cannot select one", async () => {
    await pool.query(`INSERT INTO procurement.receiving_lines(id,receiving_order_id,sku,expected_qty,received_qty,putaway_location_id)
      VALUES(52,50,'TEST-CASE',7,7,99)`);
    const before = await state();
    await expect(service.bulkImportLines(50, [{ sku: "TEST-CASE", qty: "5", location: "TEST-DOCK" }], actorId))
      .rejects.toMatchObject({ details: { rowErrors: [{ code: "RECEIVING_IMPORT_AMBIGUOUS_EXISTING_LINE" }] } });
    expect(await state()).toEqual(before);
    await expect(service.bulkImportLines(50, [{ sku: "TEST-EACH", qty: "4", location: "TEST-DOCK" }], actorId))
      .resolves.toMatchObject({ created: 1, updated: 0 });
    expect((await pool.query("SELECT id,received_qty FROM procurement.receiving_lines WHERE sku='TEST-CASE' ORDER BY id")).rows)
      .toEqual([{ id: 51, received_qty: 2 }, { id: 52, received_qty: 7 }]);
  });

  it("replays a unique CSV as one total count and freezes the selected receive unit", async () => {
    await pool.query("DELETE FROM procurement.receiving_lines WHERE receiving_order_id=50");
    const rows = [{ sku: "TEST-CASE", qty: "5", damaged_qty: "1", location: "TEST-DOCK" }];
    await expect(service.bulkImportLines(50, rows, actorId)).resolves.toMatchObject({ created: 1, updated: 0 });
    const first = (await pool.query("SELECT id,received_qty,damaged_qty,units_per_variant_snapshot FROM procurement.receiving_lines")).rows;
    await expect(service.bulkImportLines(50, rows, actorId)).resolves.toMatchObject({ created: 0, updated: 1 });
    expect((await pool.query("SELECT id,received_qty,damaged_qty,units_per_variant_snapshot FROM procurement.receiving_lines")).rows).toEqual(first);
    expect(first).toEqual([{ id: expect.any(Number), received_qty: 5, damaged_qty: 1, units_per_variant_snapshot: 250 }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions")).rows[0].count).toBe(0);
  });

  it("rolls back both replacement and creation when final import totals cannot be saved", async () => {
    const before = await state();
    await failingWrite("procurement.receiving_orders", "UPDATE", async () => {
      await expect(service.bulkImportLines(50, [
        { sku: "TEST-CASE", qty: "5", location: "TEST-DOCK" },
        { sku: "TEST-EACH", qty: "4", location: "TEST-DOCK" },
      ], actorId)).rejects.toThrow(/receiving fixture injected write failure/);
    });
    expect(await state()).toEqual(before);
  });

  it("rejects piece overflow without saving earlier valid import rows", async () => {
    const before = await state();
    await expect(service.bulkImportLines(50, [
      { sku: "TEST-EACH", qty: "4", location: "TEST-DOCK" },
      { sku: "TEST-CASE", qty: "2147483647", location: "TEST-DOCK" },
    ], actorId)).rejects.toMatchObject({ statusCode: 400, details: { field: "expectedQty in pieces" } });
    expect(await state()).toEqual(before);
  });

  it.each(["header", "line", "added matching line"] as const)("rejects a concurrent %s change after CSV preparation without overwriting it", async (change) => {
    const holder = await pool.connect();
    let open = false;
    let pending: ReturnType<typeof observed> | undefined;
    try {
      await holder.query("BEGIN"); open = true;
      await holder.query("SELECT id FROM procurement.receiving_orders WHERE id=50 FOR UPDATE");
      pending = observed((target) => target.bulkImportLines(50, [{ sku: "TEST-CASE", qty: "5", location: "TEST-DOCK" }], actorId));
      await waitUntilBlocked(await pending.pid);
      if (change === "header") await holder.query("UPDATE procurement.receiving_orders SET notes='Concurrent reviewed note' WHERE id=50");
      else if (change === "line") await holder.query("UPDATE procurement.receiving_lines SET received_qty=3 WHERE id=51");
      else await holder.query(`INSERT INTO procurement.receiving_lines(id,receiving_order_id,sku,expected_qty,received_qty,putaway_location_id)
        VALUES(52,50,'TEST-CASE',7,7,99)`);
      await holder.query("COMMIT"); open = false;
      expect(await pending.result).toMatchObject({ ok: false, error: { details: { code: "RECEIVING_IMPORT_SNAPSHOT_CHANGED" } } });
      expect((await line()).receivedQty).toBe(change === "line" ? 3 : 2);
      expect((await pool.query("SELECT count(*)::int AS count FROM procurement.receiving_lines")).rows[0].count).toBe(change === "added matching line" ? 2 : 1);
      expect((await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions")).rows[0].count).toBe(0);
    } finally { if (open) await holder.query("ROLLBACK"); holder.release(); if (pending) await pending.result; }
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

  it.each(["cutover_admission_fence", "quantity_ledger_opening"] as const)(
    "rejects a missing %s without posting receipt, quantity or audit changes", async (table) => {
      const before = await state();
      // Rename only the table owned by this disposable fixture, and restore it
      // even if an assertion fails. Missing schema is not pre-opening consent.
      await pool.query(`ALTER TABLE inventory.${table} RENAME TO receiving_fixture_hidden_authority`);
      try {
        await expect(service.close(50, actorId)).rejects.toMatchObject({ code: "42P01" });
        expect(await state()).toEqual(before);
      } finally {
        await pool.query(`ALTER TABLE inventory.receiving_fixture_hidden_authority RENAME TO ${table}`);
      }
    },
  );

  it("rolls back all physical receipt changes while the PO reconciliation owner is unavailable", async () => {
    await pool.query(`UPDATE procurement.inbound_shipments SET status='delivered' WHERE id=1;
      UPDATE procurement.receiving_orders SET source_type='shipment',inbound_shipment_id=1,purchase_order_id=10 WHERE id=50;
      UPDATE procurement.receiving_lines SET product_variant_id=201,units_per_variant_snapshot=1,expected_qty=501,received_qty=501,damaged_qty=0,purchase_order_line_id=21,inbound_shipment_line_id=11 WHERE id=51`);
    // The purchasing owner participates in the physical receipt transaction.
    // Its absence must leave the entire command retryable with no committed
    // inventory, lot, header, audit, or cost-request changes.
    const before = await state();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(service.close(50, actorId)).rejects.toMatchObject({
        statusCode: 409, details: { reason: "purchasing_unavailable" },
      });
      expect(await state()).toEqual(before);
    }
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

  describe("durable reversal retry identity", () => {
    it("replays the exact committed line response after later changes without repeating compensation", async () => {
      await service.close(50, actorId);
      await linkClosedReceiptToMatchedPo();
      await pool.query("UPDATE catalog.product_variants SET units_per_variant=500 WHERE id=200");
      const first = await executeReversal("lost-response");
      const response = receiptReversalCommandResultSchema.parse(first.body);
      expect(first).toMatchObject({ httpStatus: 200, terminalState: "succeeded", replayed: false });
      expect(response).toMatchObject({ action: "line", targetId: 51, receivingOrderId: 50, receivingLineId: 51,
        actorId, qty: 1, baseUnitsReversed: 250, lotUnitCostMills: 93750, apReconciliationReopened: true });
      expect((await pool.query("SELECT received_qty,status FROM procurement.purchase_order_lines WHERE id=21")).rows)
        .toEqual([{ received_qty: 250, status: "partially_received" }]);
      expect((await pool.query("SELECT match_status FROM procurement.vendor_invoice_lines WHERE id=71")).rows)
        .toEqual([{ match_status: "pending" }]);
      expect((await pool.query("SELECT qty_on_hand,unit_cost_mills FROM inventory.inventory_lots")).rows)
        .toEqual([{ qty_on_hand: 1, unit_cost_mills: "93750" }]);
      await executeReversal("later-reversal");
      await pool.query("UPDATE procurement.vendor_invoice_lines SET match_status='matched' WHERE id=71");
      const beforeReplay = await state();
      expect(await executeReversal("lost-response")).toEqual({ ...first, replayed: true });
      expect(await state()).toEqual(beforeReplay);
      expect((await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions WHERE transaction_type='receipt_reversal'")).rows[0].count).toBe(2);
    });

    it.each([
      ["operator", { actorId: "different-receiving-operator" }],
      ["action", { action: "order" as const, targetId: 50, body: { reason: "Correct duplicate receipt paperwork" } }],
      ["target", { targetId: 999 }],
      ["quantity", { body: { qty: 2, reason: "Correct duplicate receipt paperwork" } }],
      ["reason", { body: { qty: 1, reason: "A different correction" } }],
      ["override", { body: { qty: 1, reason: "Correct duplicate receipt paperwork", allowNegative: true } }],
      ["raw whitespace", { body: { qty: 1, reason: " Correct duplicate receipt paperwork " } }],
    ] as const)("rejects changed %s under a completed key without any business writes", async (_label, changed) => {
      await service.close(50, actorId);
      await executeReversal("identity");
      const before = await state();
      await expect(executeReversal("identity", changed)).rejects.toMatchObject({ code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
      expect(await state()).toEqual(before);
    });

    it("preserves whole-order group and PO transition in the durable response", async () => {
      await seedSecondReceiptLine();
      await service.close(50, actorId);
      await linkClosedReceiptToMatchedPo();
      const first = await executeReversal("whole-order", { action: "order" });
      const response = receiptReversalCommandResultSchema.parse(first.body);
      expect(response).toMatchObject({ action: "order", receivingOrderId: 50, targetId: 50, actorId,
        poStatusUpdate: { purchaseOrderId: 10, legacyStatus: "partially_received", physicalStatus: "receiving" } });
      if (response.action !== "order") throw new Error("Expected whole-order reversal response");
      expect(response.reversals.map(({ receivingLineId, qty, baseUnitsReversed }) => ({ receivingLineId, qty, baseUnitsReversed })))
        .toEqual([{ receivingLineId: 51, qty: 2, baseUnitsReversed: 500 }, { receivingLineId: 52, qty: 1, baseUnitsReversed: 250 }]);
      const rows = (await pool.query("SELECT id,order_reversal_id,reversal_scope FROM procurement.receipt_reversals ORDER BY id")).rows;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.order_reversal_id === rows[0].id && row.reversal_scope === "order")).toBe(true);
      const beforeReplay = await state();
      expect(await executeReversal("whole-order", { action: "order" })).toEqual({ ...first, replayed: true });
      expect(await state()).toEqual(beforeReplay);
    });

    it("rolls back every order line when a later line has insufficient original stock", async () => {
      await seedSecondReceiptLine();
      await service.close(50, actorId);
      await pool.query(`UPDATE inventory.inventory_lots SET qty_on_hand=0 WHERE id IN (
        SELECT inventory_lot_id FROM inventory.inventory_transactions WHERE receiving_line_id=52 AND transaction_type='receipt')`);
      const before = await state();
      const rejected = await executeReversal("whole-rollback", { action: "order" });
      expect(rejected).toMatchObject({ httpStatus: 409, terminalState: "rejected", body: { code: "REVERSAL_INSUFFICIENT_ON_HAND" } });
      expect(await state()).toEqual(before);
      expect(await executeReversal("whole-rollback", { action: "order" })).toEqual({ ...rejected, replayed: true });
      expect(await state()).toEqual(before);
    });

    it("rolls back inventory, PO, AP and reversal records when final response persistence fails, then retries once", async () => {
      await service.close(50, actorId);
      await linkClosedReceiptToMatchedPo();
      const before = await state();
      await pool.query("ALTER TABLE public.financial_command_results ADD CONSTRAINT fixture_reversal_result_failure CHECK(status <> 'succeeded') NOT VALID");
      try { await expect(executeReversal("result-failure")).rejects.toBeDefined(); }
      finally { await pool.query("ALTER TABLE public.financial_command_results DROP CONSTRAINT fixture_reversal_result_failure"); }
      expect(await state()).toEqual(before);
      await retryDue("result-failure");
      const first = await executeReversal("result-failure");
      expect(first).toMatchObject({ httpStatus: 200, terminalState: "succeeded", body: { qty: 1, apReconciliationReopened: true } });
      expect(await executeReversal("result-failure")).toEqual({ ...first, replayed: true });
      expect((await pool.query("SELECT count(*)::int AS count FROM procurement.receipt_reversals")).rows[0].count).toBe(1);
      expect((await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions WHERE transaction_type='receipt_reversal'")).rows[0].count).toBe(1);
    });

    it("rolls back physical compensation after a final reversal-row failure and recovers the same command", async () => {
      await service.close(50, actorId);
      const before = await state();
      await failingWrite("procurement.receipt_reversals", "UPDATE", async () => {
        await expect(executeReversal("backfill-failure")).rejects.toThrow(/receiving fixture injected write failure/);
      });
      expect(await state()).toEqual(before);
      await retryDue("backfill-failure");
      expect(await executeReversal("backfill-failure")).toMatchObject({ httpStatus: 200, body: { qty: 1 } });
      expect((await pool.query("SELECT variant_qty FROM inventory.inventory_levels")).rows).toEqual([{ variant_qty: 1 }]);
    });

    it("retains definitive rejection after stock changes and requires a newly reviewed key", async () => {
      await service.close(50, actorId);
      await pool.query("UPDATE inventory.inventory_lots SET qty_on_hand=0");
      const rejected = await executeReversal("insufficient");
      expect(rejected).toMatchObject({ httpStatus: 409, terminalState: "rejected", body: { code: "REVERSAL_INSUFFICIENT_ON_HAND" } });
      await pool.query("UPDATE inventory.inventory_lots SET qty_on_hand=2");
      const beforeReplay = await state();
      expect(await executeReversal("insufficient")).toEqual({ ...rejected, replayed: true });
      expect(await state()).toEqual(beforeReplay);
      expect(await executeReversal("stock-reviewed")).toMatchObject({ httpStatus: 200, terminalState: "succeeded" });
    });

    it("accepts a 200-character order command key without overflowing the legacy per-line key column", async () => {
      await seedSecondReceiptLine();
      await service.close(50, actorId);
      const key = `${actorId}:long-key:`.padEnd(200, "x");
      const first = await executeReversal("long-key", { action: "order", key });
      expect(first).toMatchObject({ httpStatus: 200, body: { action: "order", idempotencyKey: key } });
      expect((await pool.query("SELECT length(idempotency_key) AS length FROM procurement.receipt_reversals")).rows)
        .toEqual([expect.objectContaining({ length: expect.any(Number) }), expect.objectContaining({ length: expect.any(Number) })]);
      const lengths = (await pool.query("SELECT max(length(idempotency_key))::int AS length FROM procurement.receipt_reversals")).rows;
      expect(lengths[0].length).toBeLessThanOrEqual(100);
      expect(await executeReversal("long-key", { action: "order", key })).toEqual({ ...first, replayed: true });
    });

    it("takes the graph lock before receipt and PO rows, exposes in-flight recovery, then replays the winner", async () => {
      await service.close(50, actorId);
      await linkClosedReceiptToMatchedPo();
      const holder = await pool.connect();
      let open = false;
      let pending: ReturnType<typeof executeReversal> | undefined;
      try {
        await holder.query("BEGIN"); open = true;
        const holderPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await holder.query("SELECT pg_advisory_xact_lock(hashtext('inventory.cost_graph'),hashtext('version_1'))");
        pending = executeReversal("held-graph");
        await waitForGraphBlockedBy(holderPid);
        // If reversal takes source rows before graph, this NOWAIT fails and
        // demonstrates the deadlock cycle with existing graph-first owners.
        await holder.query("SELECT id FROM procurement.receiving_orders WHERE id=50 FOR UPDATE NOWAIT");
        await holder.query("SELECT id FROM procurement.purchase_orders WHERE id=10 FOR UPDATE NOWAIT");
        await holder.query("SELECT id FROM procurement.purchase_order_lines WHERE id=21 FOR UPDATE NOWAIT");
        await expect(executeReversal("held-graph")).rejects.toMatchObject({ code: "FINANCIAL_COMMAND_IN_PROGRESS" });
        await holder.query("COMMIT"); open = false;
        const first = await pending;
        expect(first).toMatchObject({ httpStatus: 200 });
        expect(await executeReversal("held-graph")).toEqual({ ...first, replayed: true });
        expect((await pool.query("SELECT count(*)::int AS count FROM procurement.receipt_reversals")).rows[0].count).toBe(1);
      } finally { if (open) await holder.query("ROLLBACK"); holder.release(); if (pending) await pending; }
    });

    it("serializes distinct keys without reversing more than the original receipt", async () => {
      await service.close(50, actorId);
      const body = { qty: 2, reason: "Full correction after review" };
      const results = await Promise.all([executeReversal("race-a", { body }), executeReversal("race-b", { body })]);
      expect(results.map((result) => result.terminalState).sort()).toEqual(["rejected", "succeeded"]);
      expect(results.find((result) => result.terminalState === "rejected"))
        .toMatchObject({ httpStatus: 409, body: { code: "REVERSAL_QTY_EXCEEDS_REMAINING" } });
      expect((await pool.query("SELECT reversed_qty FROM procurement.receiving_lines WHERE id=51")).rows).toEqual([{ reversed_qty: 2 }]);
      expect((await pool.query("SELECT variant_qty FROM inventory.inventory_levels")).rows).toEqual([{ variant_qty: 0 }]);
      expect((await pool.query("SELECT count(*)::int AS count FROM procurement.receipt_reversals")).rows[0].count).toBe(1);
    });

    it.each(["line", "order"] as const)("blocks historical %s evidence without inventing an original command response", async (action) => {
      await service.close(50, actorId);
      const key = `${actorId}:legacy-${action}`;
      if (action === "line") await reversal.reverseReceivingLine({ receivingLineId: 51, qty: 1, reason: "Historical correction", idempotencyKey: key, userId: actorId });
      else await reversal.reverseReceivingOrder({ receivingOrderId: 50, reason: "Historical correction", idempotencyKey: key, userId: actorId });
      const before = await state();
      const rejected = await executeReversal("legacy", { action, key, body: action === "line" ? { qty: 1, reason: "Historical correction" } : { reason: "Historical correction" } });
      expect(rejected).toMatchObject({ httpStatus: 409, terminalState: "rejected", body: { code: "RECEIPT_REVERSAL_EVIDENCE_REVIEW_REQUIRED" } });
      expect(await state()).toEqual(before);
    });

    it("treats underscores literally in a command key when checking historical evidence", async () => {
      await service.close(50, actorId);
      const prefix = `${actorId}:literal`;
      await reversal.reverseReceivingLine({ receivingLineId: 51, qty: 1, reason: "Different historical request",
        idempotencyKey: `${prefix}x:line:51`, userId: actorId });
      const first = await executeReversal("literal", { key: `${prefix}_` });
      expect(first).toMatchObject({ httpStatus: 200, terminalState: "succeeded", body: { qty: 1 } });
      expect((await pool.query("SELECT reversed_qty FROM procurement.receiving_lines WHERE id=51")).rows).toEqual([{ reversed_qty: 2 }]);
    });

    it("does not interpret historical percent keys as SQL wildcards", async () => {
      await service.close(50, actorId);
      const prefix = `${actorId}:percent`;
      await reversal.reverseReceivingLine({ receivingLineId: 51, qty: 1, reason: "Different historical request",
        idempotencyKey: `${prefix}x:line:51`, userId: actorId });
      const { readReversalKeyEvidence } = await import("../../receipt-reversal.repository");
      expect(await database.transaction((tx) => readReversalKeyEvidence(tx, `${prefix}%`))).toEqual([]);
      expect(await database.transaction((tx) => readReversalKeyEvidence(tx, `${prefix}x`))).toHaveLength(1);
    });

    it("blocks reapplication when retained reversal evidence outlives its command result", async () => {
      await service.close(50, actorId);
      await executeReversal("retained-evidence");
      const before = await state();
      await pool.query("DELETE FROM public.financial_command_results WHERE actor_id=$1 AND idempotency_key=$2",
        [reversalCommands.RECEIPT_REVERSAL_COMMAND_PRINCIPAL, `${actorId}:retained-evidence`]);
      const rejected = await executeReversal("retained-evidence");
      expect(rejected).toMatchObject({ httpStatus: 409, terminalState: "rejected", body: { code: "RECEIPT_REVERSAL_EVIDENCE_REVIEW_REQUIRED" } });
      expect(await state()).toEqual(before);
    });
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
    await pool.query("UPDATE procurement.receiving_lines SET units_per_variant_snapshot=NULL,damaged_qty=1 WHERE id=51");
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
    await pool.query("UPDATE procurement.receiving_lines SET units_per_variant_snapshot=NULL,damaged_qty=1 WHERE id=51");
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
