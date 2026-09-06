import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { shipmentLineVersion } from "../../shipment-line-version";
import type { ShipmentLineCommand } from "../../shipment-line-commands";
import type { ShipmentTrackingService } from "../../shipment-tracking.service";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";

config({ path: resolve(process.cwd(), ".env.test") });
const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const databaseTests = TEST_DB_URL && DISPOSABLE ? describe : describe.skip;
const NOW = new Date("2026-09-06T16:00:00.000Z");

const TABLES = [
  schema.products, schema.productVariants, schema.vendors, schema.vendorProducts,
  schema.purchaseOrders, schema.purchaseOrderLines, schema.inboundShipments, schema.inboundShipmentLines,
  schema.receivingOrders, schema.receivingLines, schema.poReceipts, schema.receiptReversals,
  schema.vendorInvoices, schema.vendorInvoiceLines, schema.inboundFreightCosts, schema.inboundFreightAllocations,
  schema.landedCostSnapshots, schema.landedCostAdjustments, schema.inboundShipmentStatusHistory,
] as const;

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
const outcome = (work: Promise<unknown>): Promise<Outcome> => work.then(
  (value) => ({ ok: true as const, value }),
  (error: unknown) => ({ ok: false as const, error }),
);

databaseTests.sequential("shipment line command PostgreSQL guarantees", () => {
  const runId = randomUUID().replaceAll("-", "");
  const actorId = `shipment-line-test-${runId}`;
  const delegateId = `${actorId}-delegate`;
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let service: ShipmentTrackingService;
  let createService: typeof import("../../shipment-tracking.service").createShipmentTrackingService;
  let storage: typeof import("../../procurement.storage").procurementMethods & Pick<typeof import("../../../catalog/catalog.storage").productMethods, "getProductVariantById">;
  let commandModule: typeof import("../../shipment-line-commands");
  let repositoryFactory: typeof import("../../../../platform/commands/command-results.repository").createDrizzleFinancialCommandRepository;
  let defaultModulePool: pg.Pool | undefined;
  const ownedSchemas: string[] = [];
  let ownsAudit = false;
  let auditReady = false;
  let commandTablesReady = false;

  async function readLine(id = 11) {
    const [line] = await database.select().from(schema.inboundShipmentLines).where(eq(schema.inboundShipmentLines.id, id));
    if (!line) throw new Error(`Fixture line ${id} is missing`);
    return line;
  }

  async function patch(fields: Record<string, unknown>, id = 11): Promise<ShipmentLineCommand> {
    return { operation: "update", resourceId: id, body: { expectedVersion: shipmentLineVersion(await readLine(id)), ...fields } };
  }

  async function remove(id = 11): Promise<ShipmentLineCommand> {
    return { operation: "delete", resourceId: id, body: { expectedVersion: shipmentLineVersion(await readLine(id)) } };
  }

  function fromPo(shipmentId = 1, qty = 40, poLineId = 22): ShipmentLineCommand {
    return { operation: "add-from-po", resourceId: shipmentId, body: { purchaseOrderId: 10, lineSelections: [{ poLineId, qty }] } };
  }

  function execute(command: ShipmentLineCommand, target = service) {
    return database.transaction((tx) => target.executeLineCommandInTransaction(tx, command, actorId, NOW));
  }

  async function state() {
    const results = await Promise.all([
      ...TABLES.map((table) => pool.query(`SELECT * FROM ${qualifiedTable(table)} ORDER BY id`)),
      pool.query("SELECT * FROM public.audit_events WHERE actor = ANY($1::text[]) ORDER BY id", [[actorId, delegateId]]),
    ]);
    return results.map((result) => result.rows);
  }

  function descriptor(name: string, command: ShipmentLineCommand): FinancialCommandDescriptor {
    return {
      actorType: "service", actorId: commandModule.SHIPMENT_LINE_COMMAND_PRINCIPAL,
      ...commandModule.shipmentLineCommandScope(command),
      idempotencyKey: `${runId}-${name}`,
      requestHash: createHash("sha256").update(JSON.stringify(command)).digest("hex"),
      contractVersion: 1,
    };
  }

  function durableCommands(target = service) {
    return commandModule.createShipmentLineCommands(target, repositoryFactory(database), () => NOW);
  }

  /** Observe actual PostgreSQL blocking instead of interpreting a sleep as serialization. */
  async function waitUntilBlocked(pid: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ blocked: boolean }>("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [pid]);
      if (result.rows[0]?.blocked) return;
      await new Promise((resume) => setTimeout(resume, 20));
    }
    throw new Error(`Shipment command backend ${pid} did not reach the expected PostgreSQL lock`);
  }

  function startObserved(command: ShipmentLineCommand, target = service) {
    let reportPid!: (pid: number) => void;
    const pid = new Promise<number>((ready) => { reportPid = ready; });
    const result = outcome(database.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '8s'`);
      const backend = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      reportPid(Number(backend.rows[0].pid));
      return target.executeLineCommandInTransaction(tx, command, actorId, NOW);
    }));
    return { pid, result };
  }

  async function contend(command: ShipmentLineCommand, hold: (client: pg.PoolClient) => Promise<unknown>) {
    const holder = await pool.connect();
    let transactionOpen = false;
    let pending: ReturnType<typeof startObserved> | undefined;
    try {
      await holder.query("BEGIN");
      transactionOpen = true;
      await hold(holder);
      pending = startObserved(command);
      await waitUntilBlocked(await pending.pid);
      await holder.query("COMMIT");
      transactionOpen = false;
      return await pending.result;
    } finally {
      if (transactionOpen) await holder.query("ROLLBACK");
      holder.release();
      if (pending) await pending.result;
    }
  }

  beforeAll(async () => {
    if ([process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(TEST_DB_URL!)) {
      throw new Error("Shipment line tests require a separate explicitly disposable database");
    }
    pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 8, ssl: /localhost|127\.0\.0\.1/.test(TEST_DB_URL!) ? false : { rejectUnauthorized: false } });
    for (const name of ["catalog", "procurement"]) {
      await pool.query(`CREATE SCHEMA ${name}`);
      ownedSchemas.push(name);
    }
    for (const table of TABLES) await pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(TABLES)) await pool.query(statement);
    // Migrations 025/027 declare these links rather than schema.references().
    await pool.query(`
      ALTER TABLE procurement.receiving_orders
        ADD FOREIGN KEY (purchase_order_id) REFERENCES procurement.purchase_orders(id) ON DELETE SET NULL,
        ADD FOREIGN KEY (inbound_shipment_id) REFERENCES procurement.inbound_shipments(id) ON DELETE SET NULL;
      ALTER TABLE procurement.receiving_lines
        ADD FOREIGN KEY (purchase_order_line_id) REFERENCES procurement.purchase_order_lines(id) ON DELETE SET NULL;
      CREATE UNIQUE INDEX receiving_orders_shipment_po_active_uidx
        ON procurement.receiving_orders(inbound_shipment_id,purchase_order_id)
        WHERE inbound_shipment_id IS NOT NULL AND purchase_order_id IS NOT NULL AND status IN ('draft','open','receiving','verified');
      CREATE UNIQUE INDEX po_receipts_po_line_rcv_line_idx ON procurement.po_receipts(purchase_order_line_id,receiving_line_id);
      CREATE UNIQUE INDEX receipt_reversals_idempotency_key_idx ON procurement.receipt_reversals(idempotency_key);
      CREATE UNIQUE INDEX inbound_freight_allocations_cost_line_uidx ON procurement.inbound_freight_allocations(shipment_cost_id,inbound_shipment_line_id);
      CREATE UNIQUE INDEX landed_cost_snapshots_shipment_line_uidx ON procurement.landed_cost_snapshots(inbound_shipment_line_id) WHERE inbound_shipment_line_id IS NOT NULL;
    `);
    if (!(await pool.query("SELECT to_regclass('public.audit_events') AS relation")).rows[0].relation) {
      await pool.query(fixtureTable(schema.auditEvents));
      ownsAudit = true;
    }
    auditReady = true;
    for (const migration of ["136_financial_command_results.sql", "140_financial_command_operations.sql"]) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", migration), "utf8"));
    }
    commandTablesReady = true;
    database = drizzle(pool, { schema });

    // The app exports a default pool. Do not let module initialization receive a
    // production URL; every database operation in this suite uses this fixture.
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousExternalUrl = process.env.EXTERNAL_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.EXTERNAL_DATABASE_URL;
    try {
      const [serviceModule, storageModule, commands, repositoryModule, databaseModule, catalogModule] = await Promise.all([
        import("../../shipment-tracking.service"), import("../../procurement.storage"), import("../../shipment-line-commands"),
        import("../../../../platform/commands/command-results.repository"), import("../../../../db"), import("../../../catalog/catalog.storage"),
      ]);
      createService = serviceModule.createShipmentTrackingService;
      storage = { ...storageModule.procurementMethods, getProductVariantById: catalogModule.productMethods.getProductVariantById };
      commandModule = commands;
      repositoryFactory = repositoryModule.createDrizzleFinancialCommandRepository;
      defaultModulePool = databaseModule.pool;
      service = createService(database, storage as Parameters<typeof createService>[1], undefined, () => NOW);
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousExternalUrl === undefined) delete process.env.EXTERNAL_DATABASE_URL;
      else process.env.EXTERNAL_DATABASE_URL = previousExternalUrl;
    }
  });

  beforeEach(async () => {
    if (ownedSchemas.length !== 2) throw new Error("Fixture schema ownership was not established");
    await pool.query(`TRUNCATE ${TABLES.map(qualifiedTable).join(", ")} RESTART IDENTITY CASCADE`);
    await pool.query("DELETE FROM public.audit_events WHERE actor = ANY($1::text[])", [[actorId, delegateId]]);
    await pool.query(`
      INSERT INTO catalog.products(id,sku,name) VALUES(100,'TEST-PRODUCT','Fixture product'),(101,'TEST-OTHER','Other product');
      INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant,uom_type,is_base_unit)
        VALUES(200,100,'TEST-CASE','Case of 250',250,'case',false),(201,100,'TEST-EACH','Single piece',1,'piece',true),(300,101,'TEST-OTHER-PACK','Other pack',10,'pack',false);
      INSERT INTO procurement.vendors(id,code,name) VALUES(5,'TEST-VENDOR','Fixture supplier');
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status) VALUES(10,'TEST-PO',5,'sent'),(19,'TEST-OTHER-PO',5,'sent');
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,product_variant_id,expected_receive_variant_id,expected_receive_units_per_variant,units_per_uom,sku,order_qty,unit_cost_cents,unit_cost_mills,status)
        VALUES(21,10,1,100,200,200,250,250,'TEST-PRODUCT',1000,100,10000,'open'),
        (22,10,2,100,201,201,1,1,'TEST-EACH',100,100,10000,'open'),
        (29,19,1,101,300,300,10,10,'TEST-OTHER',100,100,10000,'open');
      INSERT INTO procurement.inbound_shipments(id,shipment_number,status,allocation_method_default,estimated_total_cost_cents,actual_total_cost_cents,total_pieces,total_cartons)
        VALUES(1,'TEST-SHIP-1','costing','by_line_count',500,500,500,2),(2,'TEST-SHIP-2','draft','by_line_count',0,0,0,0),(9,'TEST-SHIP-9','closed','by_line_count',0,0,0,0);
      INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,product_variant_id,sku,qty_shipped,carton_count,allocated_cost_cents,landed_unit_cost_cents)
        VALUES(11,1,10,21,200,'TEST-PRODUCT',500,2,500,101);
      INSERT INTO procurement.inbound_freight_costs(id,inbound_shipment_id,cost_type,estimated_cents,actual_cents,vendor_id,allocation_method,cost_status)
        VALUES(31,1,'freight',500,500,5,'by_line_count','finalized');
      INSERT INTO procurement.inbound_freight_allocations(id,shipment_cost_id,inbound_shipment_line_id,allocated_cents)
        VALUES(41,31,11,500);
    `);
  });

  afterAll(async () => {
    try {
      if (pool) {
        const cleanup: Array<() => Promise<unknown>> = [];
        if (commandTablesReady) cleanup.push(() => pool.query("DELETE FROM public.financial_command_results WHERE actor_id=$1 AND idempotency_key LIKE $2", ["procurement.shipment-line", `${runId}-%`]));
        if (ownsAudit) cleanup.push(() => pool.query("DROP TABLE public.audit_events"));
        else if (auditReady) cleanup.push(() => pool.query("DELETE FROM public.audit_events WHERE actor = ANY($1::text[])", [[actorId, delegateId]]));
        // Both schemas are created only by this suite; never drop pre-existing schemas.
        for (const name of [...ownedSchemas].reverse()) cleanup.push(() => pool.query(`DROP SCHEMA ${name} CASCADE`));
        // Cross-schema foreign keys make concurrent schema drops deadlock-prone.
        const failures: unknown[] = [];
        for (const clean of cleanup) { try { await clean(); } catch (error) { failures.push(error); } }
        if (failures.length) throw new AggregateError(failures, "Shipment line fixture cleanup failed");
      }
    } finally {
      await pool?.end();
      await defaultModulePool?.end();
    }
  });

  it("preserves 501 pieces and the recorded PO receive pack when the catalog pack has changed", async () => {
    await pool.query("DELETE FROM procurement.inbound_shipment_lines WHERE id=11");
    await pool.query("UPDATE catalog.product_variants SET units_per_variant=500 WHERE id=200");
    const result = await execute(fromPo(1, 501, 21));
    expect(result).toMatchObject([{ purchaseOrderId: 10, purchaseOrderLineId: 21, productVariantId: 200, qtyShipped: 501, cartonCount: 3, createdAt: NOW, updatedAt: NOW, version: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    const [line] = await database.select().from(schema.inboundShipmentLines);
    expect(line.qtyShipped).toBe(501);
    expect(line.cartonCount).toBe(3);
    expect((await pool.query("SELECT timestamp,actor FROM public.audit_events WHERE actor=$1", [actorId])).rows).toEqual([{ timestamp: NOW, actor: actorId }]);
  });

  it("allows only one of two shipments competing for the same remaining PO pieces", async () => {
    const holder = await pool.connect();
    let locked = false;
    const pending: ReturnType<typeof startObserved>[] = [];
    try {
      await holder.query("BEGIN");
      locked = true;
      await holder.query("SELECT id FROM procurement.purchase_order_lines WHERE id=22 FOR UPDATE");
      pending.push(startObserved(fromPo(1, 70)), startObserved(fromPo(2, 70)));
      await Promise.all(pending.map(async (command) => waitUntilBlocked(await command.pid)));
      await holder.query("COMMIT");
      locked = false;
      const results = await Promise.all(pending.map((command) => command.result));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)).toMatchObject({ error: { statusCode: 409, details: { code: "SHIPMENT_LINE_QUANTITY_EXCEEDED" } } });
      expect((await pool.query("SELECT SUM(qty_shipped)::int AS qty,COUNT(*)::int AS count FROM procurement.inbound_shipment_lines WHERE purchase_order_line_id=22")).rows).toEqual([{ qty: 70, count: 1 }]);
    } finally {
      if (locked) await holder.query("ROLLBACK");
      holder.release();
      await Promise.all(pending.map((command) => command.result));
    }
  });

  it("enforces the same remainder for legacy lineIds instead of reusing full order quantity", async () => {
    const result = await execute({ operation: "add-from-po", resourceId: 2, body: { purchaseOrderId: 10, lineIds: [21] } });
    expect(result).toMatchObject([{ purchaseOrderLineId: 21, qtyShipped: 500 }]);
    await pool.query("UPDATE procurement.inbound_shipments SET status='draft' WHERE id=9");
    const before = await state();
    await expect(execute(fromPo(9, 1, 21))).rejects.toMatchObject({ details: { code: "SHIPMENT_LINE_QUANTITY_EXCEEDED" } });
    expect(await state()).toEqual(before);
  });

  it("excludes cancelled shipments while retaining their historical lines", async () => {
    await pool.query("UPDATE procurement.inbound_shipments SET status='cancelled' WHERE id=1");
    expect(await execute(fromPo(2, 1000, 21))).toMatchObject([{ qtyShipped: 1000 }]);
    expect(await readLine()).toMatchObject({ qtyShipped: 500, inboundShipmentId: 1 });
  });

  it.each(["closed", "cancelled"])("rejects every line operation on a %s shipment", async (status) => {
    await pool.query("UPDATE procurement.inbound_shipments SET status=$1 WHERE id=1", [status]);
    const commands = [fromPo(), await patch({ notes: "No terminal correction" }), await remove(),
      { operation: "import", resourceId: 1, body: { rows: [{ productVariantId: 201, qtyShipped: 1 }] } },
      { operation: "resolve-dimensions", resourceId: 1, body: {} }] as ShipmentLineCommand[];
    const before = await state();
    for (const command of commands) await expect(execute(command)).rejects.toMatchObject({ details: { code: "SHIPMENT_LINE_TERMINAL" } });
    expect(await state()).toEqual(before);
  });

  it("rejects an outdated version without touching line, totals, allocation, or audit", async () => {
    const first = await patch({ notes: "First review" });
    const stale = await patch({ qtyShipped: 600 });
    await execute(first);
    const before = await state();
    await expect(execute(stale)).rejects.toMatchObject({ statusCode: 409, details: { code: "SHIPMENT_LINE_VERSION_CONFLICT" } });
    expect(await state()).toEqual(before);
  });

  it("rechecks terminal state after waiting for a shipment cancellation", async () => {
    const result = await contend(await patch({ qtyShipped: 600 }), (client) => client.query("UPDATE procurement.inbound_shipments SET status='cancelled' WHERE id=1"));
    expect(result).toMatchObject({ ok: false, error: { details: { code: "SHIPMENT_LINE_TERMINAL" } } });
    expect((await readLine()).qtyShipped).toBe(500);
  });

  it("clears dimensions explicitly without changing recorded piece quantity or carton count", async () => {
    await pool.query("UPDATE procurement.inbound_shipment_lines SET weight_kg=2,length_cm=20,width_cm=10,height_cm=10 WHERE id=11");
    expect(await execute(await patch({ weightKg: null, lengthCm: null, widthCm: null, heightCm: null }))).toMatchObject({ qtyShipped: 500, cartonCount: 2, weightKg: null, lengthCm: null, widthCm: null, heightCm: null, updatedAt: NOW });
    expect((await readLine()).qtyShipped).toBe(500);
  });

  it("does not recalculate allocation during a notes-only amendment", async () => {
    const beforeAllocations = (await pool.query("SELECT * FROM procurement.inbound_freight_allocations ORDER BY id")).rows;
    const beforeHeader = (await pool.query("SELECT * FROM procurement.inbound_shipments WHERE id=1")).rows;
    expect(await execute(await patch({ notes: "Supplier packing evidence" }))).toMatchObject({ notes: "Supplier packing evidence", updatedAt: NOW });
    expect((await pool.query("SELECT * FROM procurement.inbound_freight_allocations ORDER BY id")).rows).toEqual(beforeAllocations);
    expect((await pool.query("SELECT * FROM procurement.inbound_shipments WHERE id=1")).rows).toEqual(beforeHeader);
  });

  it.each(["draft", "closed", "cancelled"])("protects physical history when a %s receiving header references the shipment, even without lines", async (status) => {
    await pool.query("INSERT INTO procurement.receiving_orders(id,receipt_number,purchase_order_id,inbound_shipment_id,status) VALUES(51,'TEST-RCV',10,1,$1)", [status]);
    const before = await state();
    for (const command of [await patch({ qtyShipped: 600 }), await remove(), fromPo(), { operation: "resolve-dimensions", resourceId: 1, body: {} } as ShipmentLineCommand]) {
      await expect(execute(command)).rejects.toMatchObject({ details: { code: "SHIPMENT_LINE_HISTORY_PROTECTED" } });
    }
    expect(await state()).toEqual(before);
    expect(await execute(await patch({ notes: "Retained source evidence" }))).toMatchObject({ notes: "Retained source evidence" });
  });

  it.each(["snapshot", "adjustment"])("prevents deleting or physically changing %s source history", async (history) => {
    if (history === "snapshot") await pool.query("INSERT INTO procurement.landed_cost_snapshots(inbound_shipment_line_id,purchase_order_line_id,qty,finalized_at) VALUES(11,21,500,$1)", [NOW]);
    else await pool.query("INSERT INTO procurement.landed_cost_adjustments(inbound_shipment_line_id,purchase_order_line_id,adjustment_amount_cents,reason) VALUES(11,21,20,'Recorded correction')");
    const before = await state();
    await expect(execute(await remove())).rejects.toMatchObject({ details: { code: "SHIPMENT_LINE_HISTORY_PROTECTED" } });
    await expect(execute(await patch({ cartonCount: 3 }))).rejects.toMatchObject({ details: { code: "SHIPMENT_LINE_HISTORY_PROTECTED" } });
    expect(await state()).toEqual(before);
    const financialBefore = (await pool.query("SELECT * FROM procurement.inbound_freight_allocations ORDER BY id")).rows;
    const historyBefore = (await pool.query(`SELECT * FROM procurement.${history === "snapshot" ? "landed_cost_snapshots" : "landed_cost_adjustments"} ORDER BY id`)).rows;
    expect(await execute(await patch({ notes: "Retain immutable source history" }))).toMatchObject({ notes: "Retain immutable source history", updatedAt: NOW });
    expect((await pool.query("SELECT * FROM procurement.inbound_freight_allocations ORDER BY id")).rows).toEqual(financialBefore);
    expect((await pool.query(`SELECT * FROM procurement.${history === "snapshot" ? "landed_cost_snapshots" : "landed_cost_adjustments"} ORDER BY id`)).rows).toEqual(historyBefore);
  });

  it("rechecks receiving history after waiting for a parent lock", async () => {
    const command = await patch({ qtyShipped: 600 });
    const result = await contend(command, async (client) => {
      await client.query("SELECT id FROM procurement.inbound_shipments WHERE id=1 FOR UPDATE");
      await client.query("INSERT INTO procurement.receiving_orders(id,receipt_number,purchase_order_id,inbound_shipment_id,status) VALUES(51,'TEST-RCV',10,1,'draft')");
    });
    expect(result).toMatchObject({ ok: false, error: { details: { code: "SHIPMENT_LINE_HISTORY_PROTECTED" } } });
    expect((await readLine()).qtyShipped).toBe(500);
  });

  it("rolls back a line insert when updating shipment totals fails", async () => {
    const before = await state();
    await pool.query("ALTER TABLE procurement.inbound_shipments ADD CONSTRAINT shipment_line_test_totals CHECK(total_pieces <= 500)");
    try {
      await expect(execute(fromPo())).rejects.toThrow();
      expect(await state()).toEqual(before);
    } finally {
      await pool.query("ALTER TABLE procurement.inbound_shipments DROP CONSTRAINT shipment_line_test_totals");
    }
  });

  it("rolls back inserted lines and totals when allocation persistence fails", async () => {
    const failingStorage = { ...storage, async bulkCreateInboundFreightCostAllocations(...args: Parameters<typeof storage.bulkCreateInboundFreightCostAllocations>) {
      await storage.bulkCreateInboundFreightCostAllocations(...args);
      throw new Error("Injected failure after actual allocation insert");
    } };
    const failingService = createService(database, failingStorage as Parameters<typeof createService>[1], undefined, () => NOW);
    const before = await state();
    await expect(execute(fromPo(), failingService)).rejects.toThrow("Injected failure after actual allocation insert");
    expect(await state()).toEqual(before);
  });

  it("rolls back completed line, totals, and allocation writes when audit fails", async () => {
    const before = await state();
    await pool.query("ALTER TABLE public.audit_events ADD CONSTRAINT shipment_line_test_audit CHECK(action NOT LIKE 'procurement.shipment_line.%')");
    try {
      await expect(execute(fromPo())).rejects.toThrow();
      expect(await state()).toEqual(before);
    } finally {
      await pool.query("ALTER TABLE public.audit_events DROP CONSTRAINT shipment_line_test_audit");
    }
  });

  it("durably replays an add across delegated actors without creating another line or audit", async () => {
    const command = fromPo();
    const request = descriptor("add-replay", command);
    const commands = durableCommands();
    const first = await commands.execute(command, actorId, request);
    const savedState = await state();
    expect(first).toMatchObject({ httpStatus: 201, replayed: false, terminalState: "succeeded" });
    expect(await commands.execute(command, delegateId, request)).toMatchObject({ httpStatus: 201, replayed: true, body: JSON.parse(JSON.stringify(first.body)) });
    expect(await state()).toEqual(savedState);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM procurement.inbound_shipment_lines WHERE purchase_order_line_id=22")).rows).toEqual([{ count: 1 }]);
  });

  it("persists partial-import successes and row errors once, then replays the exact result", async () => {
    const command: ShipmentLineCommand = { operation: "import", resourceId: 1, body: { rows: [
      { productVariantId: 300, qtyShipped: 10 },
      { productVariantId: 201, qtyShipped: 0 },
      { purchaseOrderLineId: 999, qtyShipped: 3 },
      { purchaseOrderLineId: 22, productVariantId: 300, qtyShipped: 5 },
      { purchaseOrderLineId: 22, qtyShipped: 15 },
    ] } };
    const request = descriptor("partial-import", command);
    const commands = durableCommands();
    const first = await commands.execute(command, actorId, request);
    expect(first).toMatchObject({ httpStatus: 200, replayed: false, terminalState: "succeeded", body: { imported: 2, errors: [{ row: 2 }, { row: 3 }, { row: 4 }] } });
    const savedState = await state();
    expect(await commands.execute(command, delegateId, request)).toMatchObject({ httpStatus: 200, replayed: true, body: JSON.parse(JSON.stringify(first.body)) });
    expect(await state()).toEqual(savedState);
    expect((await pool.query("SELECT purchase_order_id,purchase_order_line_id,qty_shipped FROM procurement.inbound_shipment_lines WHERE purchase_order_line_id=22")).rows).toEqual([{ purchase_order_id: 10, purchase_order_line_id: 22, qty_shipped: 15 }]);
    const changed: ShipmentLineCommand = { ...command, body: { rows: [{ purchaseOrderLineId: 22, qtyShipped: 16 }] } };
    await expect(commands.execute(changed, actorId, { ...request, requestHash: descriptor("partial-import", changed).requestHash })).rejects.toMatchObject({ code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
  });

  it("uses immutable net receipt pieces and does not count shipment-linked receipts twice", async () => {
    await pool.query(`
      UPDATE catalog.product_variants SET units_per_variant=500 WHERE id=200;
      UPDATE procurement.purchase_order_lines SET received_qty=325,status='partially_received' WHERE id=21;
      INSERT INTO procurement.receiving_orders(id,receipt_number,purchase_order_id,inbound_shipment_id,status)
        VALUES(51,'TEST-DIRECT',10,NULL,'closed'),(52,'TEST-SHIPMENT',10,1,'closed');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,product_variant_id,expected_qty,received_qty,reversed_qty)
        VALUES(61,51,21,200,4,4,1),(62,52,21,200,1,1,0);
      INSERT INTO procurement.po_receipts(id,purchase_order_id,purchase_order_line_id,receiving_order_id,receiving_line_id,qty_received)
        VALUES(71,10,21,51,61,100),(72,10,21,52,62,250);
      INSERT INTO procurement.receipt_reversals(id,receiving_order_id,receiving_line_id,qty,base_units_reversed,reason,idempotency_key)
        VALUES(81,51,61,1,25,'Recorded return','TEST-REVERSAL');
    `);
    // 1,000 ordered - 500 committed - (100 direct - 25 reversed) = 425.
    // The 250 received against shipment 1 already overlaps its 500-piece commitment.
    expect(await execute(fromPo(2, 425, 21))).toMatchObject([{ qtyShipped: 425, purchaseOrderLineId: 21 }]);
    expect((await pool.query("SELECT received_qty FROM procurement.purchase_order_lines WHERE id=21")).rows).toEqual([{ received_qty: 325 }]);
  });

  it("rejects a legacy reversal without a recorded base-piece snapshot", async () => {
    await pool.query(`
      UPDATE procurement.purchase_order_lines SET received_qty=75,status='partially_received' WHERE id=21;
      INSERT INTO procurement.receiving_orders(id,receipt_number,purchase_order_id,status) VALUES(51,'TEST-DIRECT',10,'closed');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,product_variant_id,received_qty,reversed_qty) VALUES(61,51,21,200,4,1);
      INSERT INTO procurement.po_receipts(id,purchase_order_id,purchase_order_line_id,receiving_order_id,receiving_line_id,qty_received) VALUES(71,10,21,51,61,100);
      INSERT INTO procurement.receipt_reversals(id,receiving_order_id,receiving_line_id,qty,base_units_reversed,reason,idempotency_key) VALUES(81,51,61,1,NULL,'Legacy return','TEST-REVERSAL');
    `);
    const before = await state();
    await expect(execute(fromPo(2, 1, 21))).rejects.toMatchObject({ statusCode: 409, details: { code: "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED" } });
    expect(await state()).toEqual(before);
  });

  it("rejects closed receiving quantities without a base-piece PO posting", async () => {
    await pool.query(`
      UPDATE procurement.purchase_order_lines SET received_qty=25,status='partially_received' WHERE id=21;
      INSERT INTO procurement.receiving_orders(id,receipt_number,purchase_order_id,status) VALUES(51,'TEST-UNPOSTED',10,'closed');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,product_variant_id,received_qty) VALUES(61,51,21,200,1);
    `);
    const before = await state();
    await expect(execute(fromPo(2, 1, 21))).rejects.toMatchObject({ details: { code: "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED" } });
    expect(await state()).toEqual(before);
  });

  it("durably rejects contradictory source counters instead of treating them as retryable infrastructure failure", async () => {
    await pool.query("UPDATE procurement.purchase_order_lines SET received_qty=1 WHERE id=22");
    const before = await state();
    const command = fromPo();
    const request = descriptor("source-mismatch", command);
    const commands = durableCommands();
    const rejected = await commands.execute(command, actorId, request);
    expect(rejected).toMatchObject({ httpStatus: 409, terminalState: "rejected", replayed: false, body: { code: "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED" } });
    expect(await commands.execute(command, delegateId, request)).toMatchObject({ httpStatus: 409, replayed: true, body: rejected.body });
    expect(await state()).toEqual(before);
  });

  it("rejects unsupported physical-column totals before retaining any line or allocation change", async () => {
    const before = await state();
    await expect(execute(await patch({ weightKg: "9999999.999", cartonCount: 1000 }))).rejects.toMatchObject({ statusCode: 422, details: { code: "SHIPMENT_LINE_TOTAL_OVERFLOW" } });
    expect(await state()).toEqual(before);
  });

  it("rolls back all imported rows when individually valid pieces exceed the shipment integer total", async () => {
    const before = await state();
    await expect(execute({ operation: "import", resourceId: 2, body: { rows: [
      { productVariantId: 201, qtyShipped: 2_147_483_647 }, { productVariantId: 300, qtyShipped: 1 },
    ] } })).rejects.toMatchObject({ statusCode: 422, details: { code: "SHIPMENT_LINE_TOTAL_OVERFLOW" } });
    expect(await state()).toEqual(before);
  });

  it("commits actual close finalization before a waiting physical line amendment can proceed", async () => {
    const command = await patch({ qtyShipped: 600 });
    let reportLocked!: () => void;
    let releaseClose!: () => void;
    const locked = new Promise<void>((ready) => { reportLocked = ready; });
    const release = new Promise<void>((resume) => { releaseClose = resume; });
    let pause = true;
    const closingStorage = {
      ...storage,
      async getInboundShipmentLines(...args: Parameters<typeof storage.getInboundShipmentLines>) {
        const lines = await storage.getInboundShipmentLines(...args);
        if (pause) { pause = false; reportLocked(); await release; }
        return lines;
      },
      // This fixture proves procurement finalization; no inventory lots are posted.
      async getProvisionalLotsByShipment() { return []; },
    };
    const closingService = createService(database, closingStorage as Parameters<typeof createService>[1], undefined, () => NOW);
    const closing = outcome(closingService.close(1, actorId, "Fixture close"));
    let editing: ReturnType<typeof startObserved> | undefined;
    try {
      await Promise.race([locked, closing.then((result) => {
        if (!result.ok) throw result.error;
        throw new Error("Close completed without reaching its locked line read");
      })]);
      editing = startObserved(command);
      await waitUntilBlocked(await editing.pid);
      releaseClose();
      expect(await closing).toMatchObject({ ok: true, value: { status: "closed", closedBy: actorId, closedAt: NOW } });
      expect(await editing.result).toMatchObject({ ok: false, error: { details: { code: "SHIPMENT_LINE_TERMINAL" } } });
      expect((await readLine()).qtyShipped).toBe(500);
      expect(await database.select().from(schema.landedCostSnapshots)).toMatchObject([{ inboundShipmentLineId: 11, qty: 500, finalizedAt: NOW }]);
      expect(await database.select().from(schema.inboundShipmentStatusHistory)).toMatchObject([{ fromStatus: "costing", toStatus: "closed", changedBy: actorId, changedAt: NOW }]);
    } finally {
      releaseClose();
      await closing;
      if (editing) await editing.result;
    }
  });

  it("deletes an unprotected line and reallocates surviving lines within its audit transaction", async () => {
    await execute(fromPo());
    expect(await execute(await remove())).toEqual({ success: true });
    expect((await pool.query("SELECT purchase_order_line_id,qty_shipped,allocated_cost_cents FROM procurement.inbound_shipment_lines WHERE inbound_shipment_id=1")).rows).toEqual([
      { purchase_order_line_id: 22, qty_shipped: 40, allocated_cost_cents: "500" },
    ]);
    expect((await pool.query("SELECT total_pieces,total_cartons FROM procurement.inbound_shipments WHERE id=1")).rows).toEqual([{ total_pieces: 40, total_cartons: 0 }]);
    const audit = (await pool.query("SELECT timestamp,changes FROM public.audit_events WHERE actor=$1 AND action='procurement.shipment_line.delete'", [actorId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].timestamp).toEqual(NOW);
    expect(audit[0].changes.before).toEqual(expect.arrayContaining([expect.objectContaining({ id: 11, qtyShipped: 500 })]));
    expect(audit[0].changes.after).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 11 })]));
  });

  it("resolves only missing dimensions from real catalog data while preserving existing dimensions and pieces", async () => {
    await pool.query("UPDATE catalog.product_variants SET weight_grams=2000,length_mm=200,width_mm=100,height_mm=100 WHERE id=200");
    await pool.query("UPDATE procurement.inbound_shipment_lines SET weight_kg=7 WHERE id=11");
    expect(await execute({ operation: "resolve-dimensions", resourceId: 1, body: {} })).toEqual({ updated: 1, total: 1 });
    expect(await readLine()).toMatchObject({ weightKg: "7.000", lengthCm: "20.00", widthCm: "10.00", heightCm: "10.00", qtyShipped: 500, cartonCount: 2, totalWeightKg: "14.000", updatedAt: NOW });
  });

  it("rejects identity, derived financial fields and invalid pieces without any side effects", async () => {
    const before = await state();
    for (const fields of [
      { inboundShipmentId: 2 }, { purchaseOrderLineId: 29 }, { productVariantId: 300 },
      { allocatedCostCents: 999 }, { landedUnitCostCents: 999 }, { totalWeightKg: "100" },
      { qtyShipped: 0 }, { qtyShipped: 1.5 }, { qtyShipped: 2_147_483_648 }, { weightKg: "-1" },
    ]) await expect(execute(await patch(fields))).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it("applies the import capacity budget in row order without exceeding the PO", async () => {
    const result = await execute({ operation: "import", resourceId: 1, body: { rows: [
      { purchaseOrderLineId: 22, qtyShipped: 60 },
      { purchaseOrderLineId: 22, qtyShipped: 50 },
    ] } });
    expect(result).toMatchObject({ imported: 1, errors: [{ row: 2, code: "SHIPMENT_LINE_QUANTITY_EXCEEDED" }] });
    expect((await pool.query("SELECT SUM(qty_shipped)::int AS qty FROM procurement.inbound_shipment_lines WHERE purchase_order_line_id=22")).rows).toEqual([{ qty: 60 }]);
  });

  it("blocks unassigned closed receipt quantities linked only through the PO header", async () => {
    await pool.query(`
      INSERT INTO procurement.receiving_orders(id,receipt_number,purchase_order_id,status) VALUES(51,'TEST-UNASSIGNED',10,'closed');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,product_variant_id,received_qty) VALUES(61,51,NULL,201,3);
    `);
    const before = await state();
    await expect(execute(fromPo(2, 1, 21))).rejects.toMatchObject({ details: { code: "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED" } });
    expect(await state()).toEqual(before);
  });

  it("protects an empty draft parent that still has a receiving header", async () => {
    await pool.query("INSERT INTO procurement.receiving_orders(id,receipt_number,purchase_order_id,inbound_shipment_id,status) VALUES(51,'TEST-PARENT-HISTORY',10,2,'cancelled')");
    const before = await state();
    await expect(service.deleteShipment(2)).rejects.toMatchObject({ statusCode: 409, details: { code: "SHIPMENT_LINE_HISTORY_PROTECTED" } });
    expect(await state()).toEqual(before);
  });

  it("requires audited line removal before deleting a draft parent with no charges", async () => {
    await pool.query("DELETE FROM procurement.inbound_freight_costs WHERE inbound_shipment_id=1");
    await pool.query("UPDATE procurement.inbound_shipments SET status='draft' WHERE id=1");
    const before = await state();
    await expect(service.deleteShipment(1)).rejects.toMatchObject({ statusCode: 409, details: { code: "SHIPMENT_HAS_LINE_HISTORY" } });
    expect(await state()).toEqual(before);
  });

  it("deletes only a truly empty unreferenced draft shipment", async () => {
    expect(await service.deleteShipment(2)).toBe(true);
    expect((await pool.query("SELECT id FROM procurement.inbound_shipments WHERE id=2")).rows).toEqual([]);
    expect((await pool.query("SELECT id FROM procurement.inbound_shipments ORDER BY id")).rows).toEqual([{ id: 1 }, { id: 9 }]);
    expect(await readLine()).toMatchObject({ id: 11, inboundShipmentId: 1, qtyShipped: 500 });
  });

  it.each([
    ["zero cartons hide a negative weight", "carton_count=0,weight_kg=-5,length_cm=NULL,width_cm=NULL,height_cm=NULL", { heightCm: "1" }],
    ["two negative dimensions multiply to a positive volume", "length_cm=-10,width_cm=-20,height_cm=1", { weightKg: "1" }],
    ["a missing dimension hides a negative dimension in zero volume", "length_cm=-10,width_cm=NULL,height_cm=1", { weightKg: "1" }],
  ] as const)("rejects invalid recorded physical inputs even when %s", async (_label, legacyAssignment, correction) => {
    // SQL assignments are fixed test literals; this models historical rows that
    // PostgreSQL numeric columns permit but the current command contract rejects.
    await pool.query(`UPDATE procurement.inbound_shipment_lines SET ${legacyAssignment} WHERE id=11`);
    const before = await state();
    await expect(execute(await patch(correction))).rejects.toMatchObject({ statusCode: 422, details: { code: "SHIPMENT_LINE_INPUT_INVALID" } });
    expect(await state()).toEqual(before);
  });

  it("preserves legacy notes but rolls back newly added lines when a sibling has invalid physical evidence", async () => {
    await pool.query("UPDATE procurement.inbound_shipment_lines SET length_cm=-10,width_cm=NULL,height_cm=1 WHERE id=11");
    expect(await execute(await patch({ notes: "Legacy physical evidence needs correction" }))).toMatchObject({ notes: "Legacy physical evidence needs correction", lengthCm: "-10.00" });
    const before = await state();
    await expect(execute(fromPo())).rejects.toMatchObject({ details: { code: "SHIPMENT_LINE_INPUT_INVALID" } });
    expect(await state()).toEqual(before);
  });

  it.each(["draft", "open", "receiving", "verified"] as const)(
    "blocks a header-only unfinished direct receipt in %s before allocating shipment pieces",
    async (receiptStatus) => {
      await pool.query("INSERT INTO procurement.receiving_orders(id,receipt_number,purchase_order_id,status) VALUES(51,'TEST-PENDING-DIRECT',10,$1)", [receiptStatus]);
      const before = await state();
      await expect(execute(fromPo(2, 1, 21))).rejects.toMatchObject({
        statusCode: 409, details: { code: "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED", receivingOrderIds: [51] },
      });
      expect(await state()).toEqual(before);
    },
  );

  it("blocks zero-quantity pending receipt lines linked directly to the selected PO line", async () => {
    await pool.query(`
      INSERT INTO procurement.receiving_orders(id,receipt_number,status) VALUES(51,'TEST-PENDING-LINE','open');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,product_variant_id,received_qty) VALUES(61,51,21,200,0);
    `);
    const before = await state();
    await expect(execute(fromPo(2, 1, 21))).rejects.toMatchObject({
      statusCode: 409, details: { code: "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED", receivingOrderIds: [51] },
    });
    expect(await state()).toEqual(before);
  });

  it("does not block an unrelated PO line when an unfinished direct receipt has an exact line link", async () => {
    await pool.query(`
      INSERT INTO procurement.receiving_orders(id,receipt_number,purchase_order_id,status) VALUES(51,'TEST-PENDING-OTHER-LINE',10,'open');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,product_variant_id,received_qty) VALUES(61,51,22,201,0);
    `);
    expect(await execute(fromPo(2, 1, 21))).toMatchObject([{ purchaseOrderLineId: 21, qtyShipped: 1 }]);
  });

  it("allows reviewed source capacity after a zero-activity direct receipt is cancelled", async () => {
    await pool.query(`
      INSERT INTO procurement.receiving_orders(id,receipt_number,purchase_order_id,status) VALUES(51,'TEST-CANCELLED-DIRECT',10,'cancelled');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,product_variant_id,received_qty) VALUES(61,51,21,200,0);
    `);
    expect(await execute(fromPo(2, 1, 21))).toMatchObject([{ purchaseOrderLineId: 21, qtyShipped: 1 }]);
  });

  it("keeps an unfinished shipment-linked receipt inside the existing shipment commitment", async () => {
    await pool.query(`
      INSERT INTO procurement.receiving_orders(id,receipt_number,purchase_order_id,inbound_shipment_id,status) VALUES(51,'TEST-PENDING-SHIPMENT',10,1,'open');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,product_variant_id,received_qty) VALUES(61,51,21,200,0);
    `);
    expect(await execute(fromPo(2, 500, 21))).toMatchObject([{ purchaseOrderLineId: 21, qtyShipped: 500 }]);
    expect((await pool.query("SELECT SUM(qty_shipped)::int AS pieces FROM procurement.inbound_shipment_lines WHERE purchase_order_line_id=21")).rows).toEqual([{ pieces: 1000 }]);
  });

  it("projects trusted source availability and explicit receipt-review warnings without changing database state", async () => {
    const { getShippablePurchaseOrderLines } = await import("../../shipment-source-capacity");
    await pool.query(`
      INSERT INTO procurement.receiving_orders(id,receipt_number,purchase_order_id,status) VALUES(51,'TEST-READ-PROJECTION',10,'open');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,product_variant_id,received_qty) VALUES(61,51,21,200,0);
    `);
    const before = await state();
    expect(await getShippablePurchaseOrderLines(database, 10)).toMatchObject({
      lines: [{ id: 22, alreadyShippedQty: 0, directReceivedQty: 0, remainingQty: 100 }],
      reviewRequiredLines: [{ id: 21, remainingQty: null, code: "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED" }],
    });
    expect(await state()).toEqual(before);
    await pool.query("UPDATE procurement.receiving_orders SET status='cancelled' WHERE id=51");
    const afterCancellation = await state();
    expect(await getShippablePurchaseOrderLines(database, 10)).toMatchObject({
      lines: [
        { id: 21, alreadyShippedQty: 500, directReceivedQty: 0, remainingQty: 500 },
        { id: 22, alreadyShippedQty: 0, directReceivedQty: 0, remainingQty: 100 },
      ],
      reviewRequiredLines: [],
    });
    expect(await state()).toEqual(afterCancellation);
  });

  it("rejects a negative stored line basis even when another positive line masks the shipment aggregate", async () => {
    const added = await execute(fromPo()) as Array<{ id: number }>;
    await pool.query("UPDATE procurement.inbound_shipment_lines SET weight_kg=1,carton_count=10,total_weight_kg=10,chargeable_weight_kg=10 WHERE id=$1", [added[0].id]);
    await pool.query("UPDATE procurement.inbound_shipment_lines SET total_weight_kg=-5 WHERE id=11");
    expect((await pool.query("SELECT SUM(total_weight_kg)::text AS total FROM procurement.inbound_shipment_lines WHERE inbound_shipment_id=1")).rows).toEqual([{ total: "5.000" }]);
    const before = await state();
    await expect(execute({ operation: "import", resourceId: 1, body: { rows: [{ productVariantId: 300, qtyShipped: 1 }] } }))
      .rejects.toMatchObject({ statusCode: 422, details: { code: "SHIPMENT_LINE_TOTAL_OVERFLOW" } });
    expect(await state()).toEqual(before);
  });

  it("requires explicit repair of inconsistent positive line bases and resolves them without changing physical evidence", async () => {
    await pool.query("UPDATE procurement.inbound_shipment_lines SET weight_kg=2,length_cm=20,width_cm=10,height_cm=10,total_weight_kg=9,total_volume_cbm=0.004,chargeable_weight_kg=4 WHERE id=11");
    const before = await state();
    await expect(execute(fromPo())).rejects.toMatchObject({
      statusCode: 409, details: { code: "SHIPMENT_LINE_TOTALS_REVIEW_REQUIRED", lineId: 11, field: "totalWeightKg" },
    });
    expect(await state()).toEqual(before);
    expect(await execute({ operation: "resolve-dimensions", resourceId: 1, body: {} })).toEqual({ updated: 1, total: 1 });
    expect(await readLine()).toMatchObject({
      qtyShipped: 500, cartonCount: 2, weightKg: "2.000", lengthCm: "20.00", widthCm: "10.00", heightCm: "10.00",
      totalWeightKg: "4.000", totalVolumeCbm: "0.004000", chargeableWeightKg: "4.000", updatedAt: NOW,
    });
    expect((await pool.query("SELECT total_weight_kg,total_volume_cbm FROM procurement.inbound_shipments WHERE id=1")).rows)
      .toEqual([{ total_weight_kg: "4.000", total_volume_cbm: "0.004000" }]);
    const audit = (await pool.query("SELECT timestamp,changes FROM public.audit_events WHERE actor=$1 AND action='procurement.shipment_line.resolve-dimensions'", [actorId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      timestamp: NOW,
      changes: { before: [{ id: 11, totalWeightKg: "9.000" }], after: [{ id: 11, totalWeightKg: "4.000", qtyShipped: 500 }] },
    });
    expect(await execute(fromPo())).toMatchObject([{ purchaseOrderLineId: 22, qtyShipped: 40 }]);
  });

  it("uses the PO SKU as identity evidence when the source has no receive variant", async () => {
    await pool.query("UPDATE procurement.purchase_order_lines SET expected_receive_variant_id=NULL,product_variant_id=NULL,sku='TEST-PO-ONLY' WHERE id=22");
    expect(await execute({ operation: "import", resourceId: 2, body: { rows: [
      { purchaseOrderLineId: 22, sku: "TEST-WRONG-SKU", qtyShipped: 10 },
      { purchaseOrderLineId: 22, sku: "TEST-PO-ONLY", qtyShipped: 10 },
    ] } })).toMatchObject({
      imported: 1, errors: [{ row: 1, code: "SHIPMENT_LINE_REFERENCE_INVALID" }],
      lines: [{ purchaseOrderId: 10, purchaseOrderLineId: 22, productVariantId: null, sku: "TEST-PO-ONLY", qtyShipped: 10 }],
    });
    expect((await pool.query("SELECT SUM(qty_shipped)::int AS pieces FROM procurement.inbound_shipment_lines WHERE purchase_order_line_id=22")).rows)
      .toEqual([{ pieces: 10 }]);
  });
});
