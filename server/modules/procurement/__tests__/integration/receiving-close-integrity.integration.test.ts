import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { createQuantityLedgerTestContext, prepareQuantityLotCreationMetadata, type QuantityLedgerTestContext } from "../../../inventory/__tests__/fixtures/quantity-ledger-database";
import { fixtureTable, fixtureForeignKeys } from "./shipment-line-fixture";
import { ReceivingService } from "../../receiving.service";
import { createPurchasingService } from "../../purchasing.service";
import { procurementMethods } from "../../procurement.storage";
import { InventoryUseCases } from "../../../inventory/application/inventory.use-cases";
import { createInventoryMethods } from "../../../inventory/infrastructure/inventory.repository";
import { InventoryLotService } from "../../../inventory/lots.service";
import { receivingUnitVersion } from "../../receiving-unit-contract";
import { lockReceivingCustodyFence } from "../../receiving-custody-public";
import { insertCustodyObservation } from "../../receiving-quarantine.repository";
import { ReceiptReversalService } from "../../receipt-reversal.service";
import { createReceiptReversalCommands, hashReceiptReversalCommandIdentity, receiptReversalCommandScope, RECEIPT_REVERSAL_COMMAND_PRINCIPAL } from "../../receipt-reversal.commands";
import { createDrizzleFinancialCommandRepository } from "../../../../platform/commands/command-results.repository";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import { RECEIPT_REVERSAL_MAX_REASON_LENGTH, receiptReversalCommandResultSchema, type ReceiptReversalAction } from "@shared/procurement/receipt-reversal-command";

// Same module-global exclusion as the existing active-ledger integration suite.
// Every storage operation used below is bound to the dedicated real SQL executor.
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
const enabled = !!process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const run = enabled ? describe : describe.skip;
const ACTOR = "receiving-integrity-operator";
const NOW = new Date("2026-10-13T12:00:00Z");
const tables = [schema.vendors, schema.purchaseOrders, schema.purchaseOrderLines, schema.inboundShipments,
  schema.inboundShipmentLines, schema.receivingOrders, schema.receivingLines, schema.poReceipts,
  schema.poStatusHistory, schema.vendorInvoices, schema.supplierCredits, schema.supplierCreditLines,
  schema.supplierCreditApplications, schema.supplierCreditApplicationReversals, schema.vendorInvoiceLines, schema.supplierReturnLines, schema.receiptReversals] as const;

run.sequential("Receipt integrity with the activated quantity ledger", () => {
  let context: QuantityLedgerTestContext;
  let service: ReceivingService;
  let reversal: ReceiptReversalService;
  beforeEach(async () => {
    context = await createQuantityLedgerTestContext(process.env.ECHELON_TEST_DATABASE_URL, true);
    const pool = context.pool;
    await prepareQuantityLotCreationMetadata(pool);
    await pool.query(`ALTER TABLE inventory.inventory_lots ALTER COLUMN received_at TYPE timestamp USING received_at AT TIME ZONE 'UTC'`);
    // The quantity fixture installs an empty custody reader prerequisite. This
    // suite replaces only those proven-empty tables with the actual migration.
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.receiving_quarantine_observations")).rows[0].count).toBe(0);
    await pool.query("DROP TABLE procurement.receiving_quarantine_observations, procurement.receiving_custody_fence");
    for (const table of tables) await pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(tables)) await pool.query(statement);
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/900000004000017890001_receiving_quarantine.sql"), "utf8"));
    await pool.query(`CREATE UNIQUE INDEX review_po_receipt_identity ON procurement.po_receipts(purchase_order_line_id,receiving_line_id);
      INSERT INTO warehouse.warehouses(id,code,name,is_active) VALUES(2,'OTHER','Other warehouse',1);
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(105,1,'DEFAULT-DOCK');
      INSERT INTO catalog.products(id,sku) VALUES(21,'ORDERED-PRODUCT');
      INSERT INTO catalog.product_variants(id,product_id,sku,units_per_variant,is_active) VALUES(102,21,'ORDERED-EACH',1,true);
      INSERT INTO procurement.vendors(id,code,name) VALUES(5,'REVIEW-VENDOR','Review vendor');
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status) VALUES(10,'REVIEW-PO',5,'sent');
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,product_variant_id,sku,order_qty,status)
        VALUES(21,10,1,21,102,'ORDERED-EACH',100,'open');
      INSERT INTO procurement.receiving_orders(id,receipt_number,source_type,status,warehouse_id)
        VALUES(50,'REVIEW-RECEIPT','blind','open',1);
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,product_id,product_variant_id,sku,expected_qty,received_qty,damaged_qty,
        units_per_variant_snapshot,putaway_location_id,unit_cost,unit_cost_mills,status)
        VALUES(51,50,20,101,'P5',2,2,0,5,100,2,200,'complete')`);
    // Install the actual receipt queue and immutable origin tables. Financial
    // revision/AP application remains covered by its dedicated owner suite.
    const evidence = readFileSync(resolve(process.cwd(), "migrations/222_procurement_cost_evidence.sql"), "utf8");
    const start = evidence.indexOf("CREATE TABLE IF NOT EXISTS procurement.receipt_cost_requests (");
    const end = evidence.indexOf("CREATE OR REPLACE FUNCTION inventory.reject_cost_evidence_mutation", start);
    if (start < 0 || end < start) throw new Error("Receipt queue migration boundary changed");
    await pool.query(evidence.slice(start, end));
    const originStart = evidence.indexOf("CREATE TABLE IF NOT EXISTS inventory.lot_cost_origins (");
    const originEnd = evidence.indexOf("CREATE TABLE IF NOT EXISTS inventory.lot_cost_contributions (", originStart);
    if (originStart < 0 || originEnd < originStart) throw new Error("Receipt cost origin migration boundary changed");
    // The cutover admission fixture creates a marker-only origin relation.
    // Replace that owned empty prerequisite with migration222's actual schema.
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.lot_cost_origins")).rows[0].count).toBe(0);
    await pool.query("DROP TABLE inventory.lot_cost_origins");
    await pool.query(evidence.slice(originStart, originEnd));
    await pool.query(`CREATE TRIGGER aa_cutover_writer_admission BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON inventory.lot_cost_origins
      FOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission();
      CREATE TRIGGER cost_evidence_immutable BEFORE UPDATE OR DELETE ON inventory.lot_cost_origins
      FOR EACH ROW EXECUTE FUNCTION inventory.reject_cost_evidence_mutation()`);

    // Real reviewed opening + authority switch and quantity journal guards.
    // Existing fixture keeps unrelated initial stock at20 and reservations3.
    await context.open();
    expect((await pool.query(`SELECT (SELECT count(*)::int FROM inventory.quantity_ledger_opening) AS openings,
      (SELECT authority FROM inventory.availability_runtime_authority WHERE singleton_key=true) AS authority`)).rows)
      .toEqual([{ openings: 1, authority: "canonical" }]);
    for (const migration of ["136_financial_command_results.sql", "140_financial_command_operations.sql"]) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", migration), "utf8"));
    }
    await pool.query(`CREATE UNIQUE INDEX review_receipt_reversal_identity ON procurement.receipt_reversals(idempotency_key);
      ALTER TABLE procurement.receiving_lines ADD CHECK(reversed_qty >= 0 AND reversed_qty <= received_qty)`);
    const database = drizzle(pool, { schema });
    const storage = {
      getReceivingOrderById: (id: number, tx = database) => procurementMethods.getReceivingOrderById(id, tx),
      getReceivingLineById: (id: number, tx = database) => procurementMethods.getReceivingLineById(id, tx),
      getReceivingLines: (id: number, tx = database) => procurementMethods.getReceivingLines(id, tx),
      updateReceivingLine: (id: number, patch: Parameters<typeof procurementMethods.updateReceivingLine>[1], tx = database) => procurementMethods.updateReceivingLine(id, patch, tx),
      updateReceivingOrder: (id: number, patch: Parameters<typeof procurementMethods.updateReceivingOrder>[1], tx = database) => procurementMethods.updateReceivingOrder(id, patch, tx),
      getPurchaseOrderById: (id: number, tx = database) => procurementMethods.getPurchaseOrderById(id, tx),
      getPurchaseOrderLines: (id: number, tx = database) => procurementMethods.getPurchaseOrderLines(id, tx),
      getPurchaseOrderLineById: (id: number, tx = database) => procurementMethods.getPurchaseOrderLineById(id, tx),
      updatePurchaseOrder: (id: number, patch: Parameters<typeof procurementMethods.updatePurchaseOrder>[1], tx = database) => procurementMethods.updatePurchaseOrder(id, patch, tx),
      updatePurchaseOrderLine: (id: number, patch: Parameters<typeof procurementMethods.updatePurchaseOrderLine>[1], tx = database) => procurementMethods.updatePurchaseOrderLine(id, patch, tx),
      reconcilePoReceiptLine: (input: Parameters<typeof procurementMethods.reconcilePoReceiptLine>[0], tx = database) => procurementMethods.reconcilePoReceiptLine(input, tx),
      updatePurchaseOrderStatusWithHistory: (id: number, patch: Parameters<typeof procurementMethods.updatePurchaseOrderStatusWithHistory>[1], history: Parameters<typeof procurementMethods.updatePurchaseOrderStatusWithHistory>[2], tx = database) => procurementMethods.updatePurchaseOrderStatusWithHistory(id, patch, history, tx),
    };
    // Existing legacy ports disagree on execute generics; adapt actual executor
    // and storage signatures only. No query results or owner methods are mocked.
    const inventory = new InventoryUseCases(database as unknown as ConstructorParameters<typeof InventoryUseCases>[0],
      createInventoryMethods(database), new InventoryLotService(database));
    reversal = new ReceiptReversalService(database, inventory);
    const purchasing = createPurchasingService(database, storage as unknown as Parameters<typeof createPurchasingService>[1]);
    service = new ReceivingService(database, inventory, { queueSyncAfterInventoryChange: async () => undefined },
      storage as unknown as ConstructorParameters<typeof ReceivingService>[3], purchasing, null, null, null, null, null, () => NOW);
  }, 60_000);
  afterEach(async () => { await context?.close(); });

  async function physicalState() {
    return (await context.pool.query(`SELECT ro.status AS receipt_status,ro.warehouse_id AS header_warehouse,
      wl.warehouse_id AS stock_warehouse,rl.received_qty,rl.damaged_qty,l.qty_on_hand,l.status AS lot_status,
      q.kind,e.on_hand_delta,e.warehouse_id AS journal_warehouse
      FROM procurement.receiving_orders ro JOIN procurement.receiving_lines rl ON rl.receiving_order_id=ro.id
      JOIN inventory.inventory_transactions t ON t.receiving_line_id=rl.id AND t.transaction_type='receipt'
      JOIN inventory.inventory_lots l ON l.id=t.inventory_lot_id
      JOIN warehouse.warehouse_locations wl ON wl.id=l.warehouse_location_id
      JOIN inventory.quantity_entries e ON e.inventory_lot_id=l.id
      JOIN inventory.quantity_commands q ON q.id=e.command_id WHERE ro.id=50`)).rows;
  }

  async function state() {
    const inventory = await context.state();
    const receipt = (await context.pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM procurement.receiving_orders r) AS receipts,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM procurement.receiving_lines l) AS lines,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM procurement.purchase_orders p) AS purchase_orders,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM procurement.purchase_order_lines p) AS purchase_lines,
      (SELECT count(*)::int FROM procurement.po_receipts) AS po_receipts,
      (SELECT count(*)::int FROM procurement.po_status_history) AS po_history,
      (SELECT count(*)::int FROM inventory.inventory_transactions) AS inventory_transactions,
      (SELECT count(*)::int FROM inventory.lot_cost_origins) AS cost_origins,
      (SELECT count(*)::int FROM procurement.receipt_cost_requests) AS cost_requests,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM procurement.receipt_reversals r) AS reversals,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY idempotency_key) FROM inventory.quantity_operation_receipts r) AS quantity_receipts,
      (SELECT count(*)::int FROM public.audit_events WHERE actor=$1) AS audits`, [ACTOR])).rows[0];
    return { inventory, receipt };
  }

  function executeReversal(name: string, body: unknown, action: ReceiptReversalAction = "line") {
    const targetId = action === "line" ? 51 : 50;
    const scope = receiptReversalCommandScope();
    const descriptor: FinancialCommandDescriptor = { ...scope, actorType: "service", actorId: RECEIPT_REVERSAL_COMMAND_PRINCIPAL,
      idempotencyKey: `active-receipt-reversal:${name}`, contractVersion: 1,
      requestHash: hashReceiptReversalCommandIdentity({ action, targetId, body, actorId: ACTOR }) };
    return createReceiptReversalCommands(reversal, createDrizzleFinancialCommandRepository(drizzle(context.pool, { schema })))
      .execute(action, targetId, body, ACTOR, descriptor);
  }

  async function retryDue(name: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await context.pool.query("SELECT next_attempt_at <= clock_timestamp() AS due FROM public.financial_command_results WHERE actor_id=$1 AND idempotency_key=$2",
        [RECEIPT_REVERSAL_COMMAND_PRINCIPAL, `active-receipt-reversal:${name}`]);
      if (result.rows[0]?.due === true) return;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error("The active-ledger reversal did not reach its first retry window");
  }

  async function linkReceiptToMatchingPO() {
    await context.pool.query(`UPDATE procurement.receiving_orders SET source_type='po',purchase_order_id=10 WHERE id=50;
      UPDATE procurement.purchase_order_lines SET product_id=20,product_variant_id=101 WHERE id=21`);
  }

  async function addUnassignedLine() {
    await context.pool.query(`INSERT INTO procurement.receiving_lines(id,receiving_order_id,sku,expected_qty,received_qty,damaged_qty,status)
      VALUES(52,50,'UNASSIGNED',0,0,0,'pending')`);
  }

  it("posts only explicitly accepted packs while keeping held custody outside the activated quantity ledger", async () => {
    const database = drizzle(context.pool, { schema });
    const before = await context.state();
    const observationId = await database.transaction(async tx => {
      await lockReceivingCustodyFence(tx, "write");
      const line = (await procurementMethods.getReceivingLineById(51, tx))!;
      const reviewed = await service.reviewQuarantineIntakeInTransaction(tx, {
        receivingOrderId: 50, receivingLineId: 51, expectedUnitVersion: receivingUnitVersion(line),
        acceptedQty: 1, heldQty: 1, holdingLocationId: 105,
      }, ACTOR, NOW);
      return insertCustodyObservation(tx, {
        receivingOrderId: 50, receivingLineId: 51, warehouseId: 1, holdingLocationId: 105,
        productId: reviewed.productId, productVariantId: reviewed.productVariantId, unitsPerVariant: reviewed.unitsPerVariantSnapshot,
        purchaseOrderLineId: reviewed.lineAfter.purchaseOrderLineId, inboundShipmentLineId: reviewed.lineAfter.inboundShipmentLineId,
        description: "One damaged pack physically held", observedSku: "P5", unitLabel: "Pack of five", condition: "damaged",
        observedQty: 1, reason: "Independent physical recount", evidenceReference: "activated-ledger-photo",
        actorId: ACTOR, recordedAt: NOW.toISOString(),
      }, "activated-custody-intake", { before: reviewed.lineBefore, after: reviewed.lineAfter, countsReviewed: true });
    });
    expect(await context.state()).toEqual(before);
    await service.close(50, ACTOR);
    expect((await context.pool.query(`SELECT t.variant_qty_delta,l.qty_received,l.qty_on_hand,e.on_hand_delta
      FROM inventory.inventory_transactions t JOIN inventory.inventory_lots l ON l.id=t.inventory_lot_id
      JOIN inventory.quantity_entries e ON e.inventory_lot_id=l.id
      WHERE t.receiving_line_id=51 AND t.transaction_type='receipt'`)).rows)
      .toEqual([{ variant_qty_delta: 1, qty_received: 1, qty_on_hand: 1, on_hand_delta: 1 }]);
    expect((await context.pool.query(`SELECT observed_qty,awaiting_receipt_qty,received_qty,returned_qty,version
      FROM procurement.receiving_quarantine_observations WHERE id=$1`, [observationId])).rows)
      .toEqual([{ observed_qty: 1, awaiting_receipt_qty: 0, received_qty: 0, returned_qty: 0, version: 0 }]);
    const posted = await context.state();
    await service.close(50, ACTOR);
    expect(await context.state()).toEqual(posted);
  });

  it("applies a default only to unassigned lines in one audited command and replays without changes", async () => {
    await addUnassignedLine();
    await service.updateOrderDetails(50, { receivingLocationId: 105, applyDefaultToUnassigned: true }, ACTOR);
    expect((await context.pool.query("SELECT id,putaway_location_id FROM procurement.receiving_lines ORDER BY id")).rows)
      .toEqual([{ id: 51, putaway_location_id: 100 }, { id: 52, putaway_location_id: 105 }]);
    expect((await context.pool.query("SELECT changes FROM public.audit_events WHERE actor=$1", [ACTOR])).rows)
      .toEqual([{ changes: { before: { receivingLocationId: null }, after: { receivingLocationId: 105 },
        lines: [{ receivingLineId: 52, before: null, after: 105 }] } }]);
    const after = await state();
    await service.updateOrderDetails(50, { receivingLocationId: 105, applyDefaultToUnassigned: true }, ACTOR);
    expect(await state()).toEqual(after);
  });

  it("rolls back default header and all assignments when the audit insert fails", async () => {
    await addUnassignedLine();
    await context.pool.query(`CREATE FUNCTION procurement.reject_receipt_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'receipt integrity injected audit failure'; END $$;
      CREATE TRIGGER reject_receipt_test_audit BEFORE INSERT ON public.audit_events
      FOR EACH ROW EXECUTE FUNCTION procurement.reject_receipt_test_audit()`);
    const before = await state();
    await expect(service.updateOrderDetails(50, { receivingLocationId: 105, applyDefaultToUnassigned: true }, ACTOR))
      .rejects.toThrow(/receipt integrity injected audit failure/);
    expect(await state()).toEqual(before);
  });

  async function waitForBlockedBy(pid: number, count: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      // PostgreSQL queues tuple locks: a later waiter may be blocked by the
      // first waiter rather than directly by our holder. Observe the complete
      // blocker chain, not an assumed flat lock queue.
      const blocked = (await context.pool.query(`WITH RECURSIVE blocked(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
        UNION
        SELECT activity.pid FROM pg_stat_activity activity JOIN blocked prior ON prior.pid=ANY(pg_blocking_pids(activity.pid))
          WHERE activity.datname=current_database()
      ) SELECT count(*)::int AS count FROM blocked`, [pid])).rows[0].count;
      if (blocked >= count) return;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error(`Expected ${count} receipt commands blocked by backend ${pid}`);
  }
  const observed = (promise: Promise<unknown>) => promise.then((value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }));

  it("serializes two closes prepared before either posts, creating one canonical receipt", async () => {
    const holder = await context.pool.connect();
    const pending: Array<ReturnType<typeof observed>> = [];
    let open = false;
    try {
      await holder.query("BEGIN"); open = true;
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('inventory.cost_graph'),hashtext('version_1'))");
      pending.push(observed(service.close(50, ACTOR)), observed(service.close(50, ACTOR)));
      await waitForBlockedBy(pid, 2);
      await holder.query("COMMIT"); open = false;
      expect((await Promise.all(pending)).map((result) => result.ok)).toEqual([true, true]);
      expect(await physicalState()).toHaveLength(1);
      expect((await context.pool.query("SELECT count(*)::int AS count FROM inventory.quantity_commands WHERE kind='receive'")).rows[0].count).toBe(1);
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
      await Promise.all(pending);
    }
  });

  it("preserves a concurrent explicit line location before applying the default to still-unassigned lines", async () => {
    await addUnassignedLine();
    const holder = await context.pool.connect();
    const pending: Array<ReturnType<typeof observed>> = [];
    let open = false;
    try {
      await holder.query("BEGIN"); open = true;
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await holder.query("SELECT id FROM procurement.receiving_orders WHERE id=50 FOR UPDATE");
      pending.push(observed(service.updateLine(52, { putawayLocationId: 100 }, ACTOR)));
      await waitForBlockedBy(pid, 1);
      pending.push(observed(service.updateOrderDetails(50, { receivingLocationId: 105, applyDefaultToUnassigned: true }, ACTOR)));
      await waitForBlockedBy(pid, 2);
      await holder.query("COMMIT"); open = false;
      expect((await Promise.all(pending)).map((result) => result.ok)).toEqual([true, true]);
      expect((await context.pool.query("SELECT id,putaway_location_id FROM procurement.receiving_lines ORDER BY id")).rows)
        .toEqual([{ id: 51, putaway_location_id: 100 }, { id: 52, putaway_location_id: 100 }]);
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
      await Promise.all(pending);
    }
  });

  it("rejects compatibility deletion of a counted open receipt without changing any evidence", async () => {
    const before = await state();
    await expect(service.deleteOrder(50, ACTOR)).rejects.toMatchObject({ statusCode: 409,
      details: { code: "RECEIVING_DISCARD_STARTED" } });
    expect(await state()).toEqual(before);
  });

  it("preserves damaged-only draft counts through both discard entry points", async () => {
    await context.pool.query("UPDATE procurement.receiving_orders SET status='draft' WHERE id=50; UPDATE procurement.receiving_lines SET received_qty=0,damaged_qty=2 WHERE id=51");
    const before = await state();
    await expect(service.deleteOrder(50, ACTOR)).rejects.toMatchObject({ statusCode: 409,
      details: { code: "RECEIVING_DISCARD_ACTIVITY_EXISTS" } });
    await expect(service.discardDraftReceivingOrder(50, ACTOR)).rejects.toMatchObject({ statusCode: 409 });
    expect(await state()).toEqual(before);
  });

  it("deletes an unused draft atomically and keeps the actor, time and before state", async () => {
    await context.pool.query("UPDATE procurement.receiving_orders SET status='draft' WHERE id=50; UPDATE procurement.receiving_lines SET received_qty=0,damaged_qty=0 WHERE id=51");
    await expect(service.deleteOrder(50, ACTOR)).resolves.toBe(true);
    expect((await context.pool.query("SELECT id FROM procurement.receiving_orders WHERE id=50")).rows).toEqual([]);
    expect((await context.pool.query("SELECT id FROM procurement.receiving_lines WHERE id=51")).rows).toEqual([]);
    const audits = (await context.pool.query("SELECT timestamp,actor,target,changes FROM public.audit_events WHERE action='procurement.receiving.discard'")).rows;
    expect(audits).toEqual([expect.objectContaining({ timestamp: NOW, actor: ACTOR, target: "receiving-order:50",
      changes: { before: { order: expect.objectContaining({ id: 50, status: "draft" }), lines: [expect.objectContaining({ id: 51 })] }, after: null } })]);
    await expect(service.deleteOrder(50, ACTOR)).rejects.toMatchObject({ statusCode: 404 });
    expect((await context.pool.query("SELECT count(*)::int AS count FROM public.audit_events WHERE action='procurement.receiving.discard'")).rows[0].count).toBe(1);
  });

  it("keeps linked PO history at the same injected command time as the discard audit", async () => {
    await context.pool.query("UPDATE procurement.receiving_orders SET status='draft',purchase_order_id=10 WHERE id=50; UPDATE procurement.receiving_lines SET received_qty=0,damaged_qty=0 WHERE id=51");
    await service.discardDraftReceivingOrder(50, ACTOR);
    const history = await drizzle(context.pool).select().from(schema.poStatusHistory);
    expect(history).toEqual([expect.objectContaining({ purchaseOrderId: 10, changedBy: ACTOR, changedAt: NOW,
      notes: "Unused draft receipt REVIEW-RECEIPT discarded" })]);
  });

  it("rolls back discard and its audit if linked PO history cannot be written", async () => {
    await context.pool.query(`UPDATE procurement.receiving_orders SET status='draft',purchase_order_id=10 WHERE id=50;
      UPDATE procurement.receiving_lines SET received_qty=0,damaged_qty=0 WHERE id=51;
      CREATE FUNCTION procurement.reject_discard_history() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'discard history injected failure'; END $$;
      CREATE TRIGGER reject_discard_history BEFORE INSERT ON procurement.po_status_history
        FOR EACH ROW EXECUTE FUNCTION procurement.reject_discard_history()`);
    const before = await state();
    await expect(service.deleteOrder(50, ACTOR)).rejects.toThrow("discard history injected failure");
    expect(await state()).toEqual(before);
  });

  it("rechecks activity committed by a writer while deletion waits for the receipt lock", async () => {
    await context.pool.query("UPDATE procurement.receiving_orders SET status='draft' WHERE id=50; UPDATE procurement.receiving_lines SET received_qty=0,damaged_qty=0 WHERE id=51");
    const holder = await context.pool.connect();
    let pending: ReturnType<typeof observed> | undefined;
    let open = false;
    try {
      await holder.query("BEGIN"); open = true;
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await holder.query("SELECT id FROM procurement.receiving_orders WHERE id=50 FOR UPDATE");
      pending = observed(service.deleteOrder(50, ACTOR));
      await waitForBlockedBy(pid, 1);
      await holder.query("UPDATE procurement.receiving_orders SET status='open' WHERE id=50; UPDATE procurement.receiving_lines SET received_qty=2 WHERE id=51");
      await holder.query("COMMIT"); open = false;
      expect(await pending).toMatchObject({ ok: false, error: { statusCode: 409 } });
      expect((await context.pool.query("SELECT received_qty FROM procurement.receiving_lines WHERE id=51")).rows).toEqual([{ received_qty: 2 }]);
      expect((await context.pool.query("SELECT count(*)::int AS count FROM public.audit_events WHERE action='procurement.receiving.discard'")).rows[0].count).toBe(0);
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
      await pending;
    }
  });

  it("posts a standalone receipt exactly once through actual ledger on close retry", async () => {
    await service.close(50, ACTOR);
    const after = await state();
    await service.close(50, ACTOR);
    expect(await state()).toEqual(after);
    expect(await physicalState()).toEqual([{ receipt_status: "closed", header_warehouse: 1, stock_warehouse: 1,
      received_qty: 2, damaged_qty: 0, qty_on_hand: 2, lot_status: "active", kind: "receive", on_hand_delta: 2, journal_warehouse: 1 }]);
  });

  describe("durable receipt reversals through active quantity authority", () => {
    it("posts one exact reversal with the longest supported reason and replays without new journal or PO effects", async () => {
      await linkReceiptToMatchingPO();
      await context.pool.query("UPDATE procurement.purchase_order_lines SET unit_cost_mills=200,unit_cost_cents=2 WHERE id=21");
      await service.close(50, ACTOR);
      const body = { qty: 1, reason: "R".repeat(RECEIPT_REVERSAL_MAX_REASON_LENGTH) };
      const first = await executeReversal("long-reason", body);
      expect(first).toMatchObject({ httpStatus: 200, terminalState: "succeeded", replayed: false });
      const response = receiptReversalCommandResultSchema.parse(first.body);
      expect(response).toMatchObject({ action: "line", actorId: ACTOR, receivingOrderId: 50, receivingLineId: 51,
        qty: 1, baseUnitsReversed: 5, lotUnitCostMills: 1000 });
      if (response.action !== "line") throw new Error("Expected line reversal response");
      const journal = (await context.pool.query(`SELECT q.actor,q.reason,e.on_hand_delta,e.reserved_delta,e.picked_delta,e.packed_delta
        FROM inventory.quantity_commands q JOIN inventory.quantity_entries e ON e.command_id=q.id
        WHERE q.kind='receipt_reversal'`)).rows;
      expect(journal).toEqual([{ actor: ACTOR, reason: `Reversal #${response.reversalId} of receipt REVIEW-RECEIPT: ${body.reason}`,
        on_hand_delta: -1, reserved_delta: 0, picked_delta: 0, packed_delta: 0 }]);
      expect(journal[0].reason.length).toBeLessThanOrEqual(1000);
      expect((await context.pool.query("SELECT received_qty FROM procurement.purchase_order_lines WHERE id=21")).rows).toEqual([{ received_qty: 5 }]);
      expect((await context.pool.query("SELECT received_qty,reversed_qty FROM procurement.receiving_lines WHERE id=51")).rows).toEqual([{ received_qty: 2, reversed_qty: 1 }]);
      expect((await context.pool.query("SELECT count(*)::int AS count FROM inventory.quantity_operation_receipts WHERE idempotency_key=$1",
        [`receipt_reversal:${response.reversalId}`])).rows[0].count).toBe(1);
      const after = await state();
      expect(await executeReversal("long-reason", body)).toEqual({ ...first, replayed: true });
      expect(await state()).toEqual(after);
    });

    it("records a durable negative-override rejection without changing canonical stock, audit or PO evidence", async () => {
      await linkReceiptToMatchingPO();
      await service.close(50, ACTOR);
      const before = await state();
      const body = { qty: 1, reason: "Reviewed operator override request", allowNegative: true };
      const rejected = await executeReversal("negative-override", body);
      expect(rejected).toMatchObject({ httpStatus: 400, terminalState: "rejected", body: { code: "VALIDATION_ERROR",
        details: { receiptReversalOutcome: "rejected", idempotencyKey: "active-receipt-reversal:negative-override" } } });
      expect(await state()).toEqual(before);
      expect(await executeReversal("negative-override", body)).toEqual({ ...rejected, replayed: true });
      expect(await state()).toEqual(before);
      expect((await context.pool.query("SELECT status FROM public.financial_command_results WHERE idempotency_key=$1",
        ["active-receipt-reversal:negative-override"])).rows).toEqual([{ status: "rejected" }]);
      await expect(executeReversal("negative-override", { ...body, allowNegative: false }))
        .rejects.toMatchObject({ code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
      expect(await executeReversal("reviewed-without-override", { ...body, allowNegative: false }))
        .toMatchObject({ httpStatus: 200, terminalState: "succeeded" });
    });

    it("rolls back quantity journal and operation receipts with PO and audit when final response storage fails", async () => {
      await linkReceiptToMatchingPO();
      await service.close(50, ACTOR);
      const before = await state();
      const body = { qty: 1, reason: "Correct duplicate receiving paperwork" };
      await context.pool.query("ALTER TABLE public.financial_command_results ADD CONSTRAINT active_reversal_result_failure CHECK(status <> 'succeeded') NOT VALID");
      try { await expect(executeReversal("result-failure", body)).rejects.toBeDefined(); }
      finally { await context.pool.query("ALTER TABLE public.financial_command_results DROP CONSTRAINT active_reversal_result_failure"); }
      expect(await state()).toEqual(before);
      expect((await context.pool.query("SELECT count(*)::int AS count FROM inventory.quantity_commands WHERE kind='receipt_reversal'")).rows[0].count).toBe(0);
      expect((await context.pool.query("SELECT status FROM public.financial_command_results WHERE idempotency_key=$1",
        ["active-receipt-reversal:result-failure"])).rows).toEqual([{ status: "retryable" }]);
      await retryDue("result-failure");
      const first = await executeReversal("result-failure", body);
      expect(first).toMatchObject({ httpStatus: 200, terminalState: "succeeded" });
      const after = await state();
      expect(await executeReversal("result-failure", body)).toEqual({ ...first, replayed: true });
      expect(await state()).toEqual(after);
      expect((await context.pool.query("SELECT count(*)::int AS count FROM inventory.quantity_commands WHERE kind='receipt_reversal'")).rows[0].count).toBe(1);
      expect((await context.pool.query("SELECT received_qty FROM procurement.purchase_order_lines WHERE id=21")).rows).toEqual([{ received_qty: 5 }]);
    });

    it("replays a completed whole receipt while a new all-already-reversed request is rejected without writes", async () => {
      await service.close(50, ACTOR);
      const body = { reason: "Void duplicate receipt in full" };
      const first = await executeReversal("whole-receipt", body, "order");
      expect(first).toMatchObject({ httpStatus: 200, terminalState: "succeeded", body: { action: "order", receivingOrderId: 50,
        reversals: [expect.objectContaining({ receivingLineId: 51, qty: 2, baseUnitsReversed: 10 })] } });
      const after = await state();
      const rejected = await executeReversal("already-reversed", body, "order");
      expect(rejected).toMatchObject({ httpStatus: 409, terminalState: "rejected", body: { code: "NOTHING_TO_REVERSE" } });
      expect(await state()).toEqual(after);
      expect(await executeReversal("already-reversed", body, "order")).toEqual({ ...rejected, replayed: true });
      expect(await executeReversal("whole-receipt", body, "order")).toEqual({ ...first, replayed: true });
      expect(await state()).toEqual(after);
    });
  });

  it("rejects a header warehouse change that strands assigned lines without writing", async () => {
    const before = await state();
    await expect(service.updateOrderDetails(50, { warehouseId: 2, receivingLocationId: null }, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { issues: [expect.objectContaining({ code: "RECEIVING_LOCATION_WAREHOUSE_MISMATCH", receivingLineId: 51 })] } });
    expect(await state()).toEqual(before);
  });

  it("rejects an already inconsistent line warehouse before canonical inventory writes", async () => {
    await context.pool.query("UPDATE procurement.receiving_orders SET warehouse_id=2 WHERE id=50");
    const before = await state();
    await expect(service.close(50, ACTOR)).rejects.toMatchObject({ statusCode: 409 });
    expect(await state()).toEqual(before);
  });

  it("rejects unmatched goods before physical receipt and preserves retry without writes", async () => {
    await context.pool.query("UPDATE procurement.receiving_orders SET source_type='po',purchase_order_id=10 WHERE id=50");
    const before = await state();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(service.close(50, ACTOR)).rejects.toMatchObject({ statusCode: 409,
        details: { issues: [expect.objectContaining({ code: "RECEIVING_SOURCE_UNMATCHED", receivingLineId: 51 })] } });
      expect(await state()).toEqual(before);
    }
  });

  it("rejects ambiguous product sources before any inventory or provenance writes", async () => {
    await linkReceiptToMatchingPO();
    await context.pool.query(`INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,product_variant_id,sku,order_qty,status)
      VALUES(22,10,2,20,101,'P5',100,'open')`);
    const before = await state();
    await expect(service.close(50, ACTOR)).rejects.toMatchObject({ statusCode: 409,
      details: { issues: [expect.objectContaining({ code: "RECEIVING_SOURCE_AMBIGUOUS", receivingLineId: 51 })] } });
    expect(await state()).toEqual(before);
  });

  it("persists unique PO provenance before lot origin and canonical stock, and replays once", async () => {
    await linkReceiptToMatchingPO();
    await service.close(50, ACTOR);
    expect((await context.pool.query(`SELECT rl.purchase_order_line_id,l.po_line_id,o.purchase_order_line_id AS origin_line_id,o.receiving_line_id
      FROM procurement.receiving_lines rl JOIN inventory.lot_cost_origins o ON o.receiving_line_id=rl.id
      JOIN inventory.inventory_lots l ON l.id=o.inventory_lot_id WHERE rl.id=51`)).rows)
      .toEqual([{ purchase_order_line_id: 21, po_line_id: 21, origin_line_id: 21, receiving_line_id: 51 }]);
    expect((await context.pool.query("SELECT received_qty FROM procurement.purchase_order_lines WHERE id=21")).rows).toEqual([{ received_qty: 10 }]);
    expect((await context.pool.query("SELECT count(*)::int AS count FROM procurement.po_receipts")).rows[0].count).toBe(1);
    const after = await state();
    await service.close(50, ACTOR);
    expect(await state()).toEqual(after);
  });

  it("rolls back source resolution, canonical stock, cost requests and header when PO history fails", async () => {
    await linkReceiptToMatchingPO();
    await context.pool.query(`CREATE FUNCTION procurement.reject_receipt_test_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'receipt integrity injected PO history failure'; END $$;
      CREATE TRIGGER reject_receipt_test_history BEFORE INSERT ON procurement.po_status_history
      FOR EACH ROW EXECUTE FUNCTION procurement.reject_receipt_test_history()`);
    const before = await state();
    await expect(service.close(50, ACTOR)).rejects.toThrow(/receipt integrity injected PO history failure/);
    expect(await state()).toEqual(before);
  });
});
