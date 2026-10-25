import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { createQuantityLedgerTestContext, QUANTITY_TEST_TIME, type QuantityLedgerTestContext } from "../fixtures/quantity-ledger-database";
import { fixtureTable, fixtureColumnDefinitions, qualifiedTable } from "../../../procurement/__tests__/integration/shipment-line-fixture";
import { installSupplierReturnCompletionFixture } from "../../../procurement/__tests__/integration/supplier-return-fixture";
import { recordSupplierReturn } from "../../../procurement/supplier-return.service";
import { previewSupplierReturnStock, readSupplierReturnInventoryEvidence } from "../../application/supplier-return-stock";
import { ensureLotCostQuantityBasis, allocateLotQuantityCost, readUnallocatedLotCosts } from "../../infrastructure/cost-quantity.repository";
import { recordReceiptCostOrigin } from "../../infrastructure/cost-evidence.repository";
import { openOperationalQuantityPosting } from "../../infrastructure/operational-quantity-posting";
import { COGSService } from "../../cogs.service";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const suite = url && disposable ? describe : describe.skip;
const at = new Date(QUANTITY_TEST_TIME);

suite.sequential("supplier return under activated quantity authority", () => {
  let context: QuantityLedgerTestContext;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  beforeEach(async () => {
    context = await createQuantityLedgerTestContext(url, disposable);
    const pool = context.pool;
    await pool.query("CREATE SCHEMA IF NOT EXISTS identity");
    for (const table of [schema.users, schema.authRoles, schema.authPermissions, schema.authUserRoles, schema.authRolePermissions,
      schema.vendors, schema.purchaseOrders, schema.purchaseOrderLines, schema.receivingOrders, schema.receivingLines,
      schema.receiptReversals, schema.inboundShipments, schema.inboundShipmentLines, schema.inboundFreightCosts, schema.inboundFreightAllocations,
      schema.vendorInvoices, schema.vendorInvoiceLines, schema.supplierCredits, schema.supplierCreditLines,
      schema.supplierCreditApplications, schema.supplierCreditApplicationReversals]) {
      const exists = (await pool.query("SELECT to_regclass($1) AS relation", [qualifiedTable(table)])).rows[0].relation;
      if (exists !== null) throw new Error(`Supplier return fixture unexpectedly inherited ${qualifiedTable(table)}`);
      await pool.query(fixtureTable(table));
    }
    // Upgrade only empty compatibility tables to the actual cost migrations.
    // The quantity opening, admission and journal remain the real fixture owners.
    await pool.query(`DROP TABLE inventory.lot_cost_follow_up_attempts,inventory.lot_cost_follow_ups;
      DROP TABLE inventory.lot_cost_origins,inventory.lot_cost_contributions,inventory.cost_component_protections,
        inventory.cost_applications,inventory.cost_application_lots,inventory.cost_reporting_events CASCADE`);
    for (const name of ["222_procurement_cost_evidence.sql", "0751_exact_inventory_cost_totals.sql", "0725_inventory_cost_admission_evidence.sql",
      "900000017000018590001_receipt_shipment_quantity_amendments.sql"]) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", name), "utf8"));
    }
    for (const name of ["lot_cost_origins", "lot_cost_contributions", "cost_component_protections", "cost_applications", "cost_application_lots", "cost_reporting_events"]) {
      await pool.query(`CREATE TRIGGER aa_cutover_writer_admission BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON inventory.${name}
        FOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission()`);
    }
    for (const table of [schema.inventoryTransactions, schema.inventoryLots, schema.orderItemCosts]) {
      const existing = (await pool.query("SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped", [qualifiedTable(table)])).rows;
      const names = new Set(existing.map(row => row.attname));
      for (const column of fixtureColumnDefinitions(table)) {
        if (!names.has(column.name)) await pool.query(`ALTER TABLE ${qualifiedTable(table)} ADD COLUMN ${column.definition}`);
      }
    }
    await pool.query(`CREATE TABLE inventory.cost_adjustment_log(id serial PRIMARY KEY,lot_id integer,lot_number varchar(50),
      product_variant_id integer,sku varchar(100),old_cost_cents bigint,new_cost_cents bigint,delta_cents bigint,reason varchar(100),created_at timestamp);
      INSERT INTO identity.users(id,username,password,role,active) VALUES('operator','supplier-return-operator','unused','picker',1);
      INSERT INTO identity.auth_roles(id,name) VALUES(1,'Supplier return operator');
      INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES(1,'purchasing','approve','purchasing'),(2,'purchasing','view','purchasing');
      INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES('operator',1);
      INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES(1,1),(1,2);
      INSERT INTO procurement.vendors(id,code,name) VALUES(5,'RETURN-SUPPLIER','Supplier');
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,warehouse_id) VALUES(10,'RETURN-PO',5,'received',1);
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,product_variant_id,order_qty,received_qty)
        VALUES(21,10,1,20,101,100,100);
      INSERT INTO procurement.receiving_orders(id,receipt_number,purchase_order_id,warehouse_id,status) VALUES(50,'RETURN-RECEIPT',10,1,'closed');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,product_id,product_variant_id,
        expected_qty,received_qty,units_per_variant_snapshot,cost_source_kind,putaway_location_id)
        VALUES(51,50,21,20,101,20,20,5,'purchase_order_line',100);
      DELETE FROM oms.order_item_costs;
      DELETE FROM inventory.inventory_transactions WHERE transaction_type='pick';
      UPDATE inventory.inventory_transactions SET reserved_qty_delta=3 WHERE transaction_type='reserve';
      UPDATE inventory.inventory_lots SET lot_number='RETURN-LOT',qty_received=20,qty_on_hand=20,qty_reserved=3,qty_picked=0,qty_consumed=0,
        purchase_order_id=10,po_line_id=21,receiving_order_id=50,cost_precision_version=1,cost_basis_qty=20,
        product_total_cost_mills=2000,packaging_total_cost_mills=200,landed_total_cost_mills=0,
        po_unit_cost_mills=100,packaging_cost_mills=10,landed_cost_mills=0,total_unit_cost_mills=110,unit_cost_mills=110,
        cost_provisional=0,cost_source='purchase_order' WHERE id=4;
      UPDATE inventory.inventory_levels SET variant_qty=20,reserved_qty=3,picked_qty=0,packed_qty=0 WHERE id=10`);
    await installSupplierReturnCompletionFixture(pool);
    database = drizzle(pool, { schema });
    await database.transaction(async tx => {
      await recordReceiptCostOrigin(tx, { inventoryLotId: 4, receivingLineId: 51, purchaseOrderLineId: 21,
        inboundShipmentLineId: null, unitsPerVariantSnapshot: 5, receivedVariantQty: 20 }, "operator", at);
      const lot = (await tx.execute(sql`SELECT * FROM inventory.inventory_lots WHERE id=4`)).rows[0];
      await ensureLotCostQuantityBasis(tx, { ...lot, id: lot.id }, "operator", at);
    });
    try { await context.open(true, { onHand: 20, reserved: 3, picked: 0, ordered: 8 }); }
    catch (error) {
      throw new Error(`Supplier return fixture opening failed: ${JSON.stringify(error)}`, { cause: error });
    }
  }, 30_000);
  afterEach(async () => { await context?.close(); });

  async function reviewed(quantity: number) {
    return database.transaction(tx => previewSupplierReturnStock(tx, { vendorId: 5, lines: [{ inventoryLotId: 4, quantity }] }));
  }
  async function record(quantity: number) {
    const preview = await reviewed(quantity);
    const input = { raw: { vendorId: 5, lines: [{ inventoryLotId: 4, quantity }], expectedSourceFingerprint: preview.sourceFingerprint,
      returnCalendarDate: "2026-09-10", evidenceReference: "Signed supplier collection", reason: "Return proven stock to supplier" },
    actorId: "operator", at, commandKey: randomUUID(), requestFingerprint: "f".repeat(64) };
    return { document: await database.transaction(tx => recordSupplierReturn(tx, input)), input };
  }

  it("posts one supplier-return journal and preserves returned, sold and remaining value through late revaluation", async () => {
    const saved = await record(3);
    expect((await context.pool.query("SELECT kind FROM inventory.quantity_commands ORDER BY id")).rows).toEqual([{ kind: "opening" }, { kind: "supplier_return" }]);
    expect((await context.pool.query("SELECT qty_on_hand,qty_reserved,qty_picked FROM inventory.inventory_lots WHERE id=4")).rows[0])
      .toEqual({ qty_on_hand: 17, qty_reserved: 3, qty_picked: 0 });
    expect(await database.transaction(tx => recordSupplierReturn(tx, saved.input))).toEqual(saved.document);
    await database.transaction(async tx => {
      const posting = await openOperationalQuantityPosting(tx);
      expect(posting).not.toBeNull();
      const allocation = await allocateLotQuantityCost(tx, 4, 2, "operator", at, { orderId: 1, orderItemId: 11 }, "supplier-return-sale");
      await tx.insert(schema.orderItemCosts).values({ orderId: 1, orderItemId: 11, inventoryLotId: 4, productVariantId: 101,
        qty: 2, unitCostCents: 1, totalCostCents: 2, unitCostMills: 110, totalCostMills: 220, costPrecisionVersion: 1,
        costQuantityAllocationId: allocation.id, productTotalCostMills: 200, packagingTotalCostMills: 20, landedTotalCostMills: 0 });
      await posting!.addLot(4, { onHand: -2, reserved: 0, picked: 2, packed: 0 });
      await posting!.post({ idempotencyKey: "supplier-return-sale", kind: "pick", actor: "operator",
        reason: "Record separately sold units", reference: { type: "order", id: "1" }, occurredAt: at.toISOString() });
    });
    const writer = new COGSService(database);
    await database.transaction(async tx => {
      await writer.revalueExactComponent(4, "product", 6000, 20, "Approved supplier price", "operator", tx, at);
      await writer.revalueExactComponent(4, "packaging", 600, 20, "Approved packaging price", "operator", tx, at);
      await writer.revalueExactComponent(4, "landed", 1000, 20, "Late freight", "operator", tx, at);
    });
    const returned = await database.transaction(tx => readSupplierReturnInventoryEvidence(tx, saved.document.id));
    expect(returned.lines[0].currentCosts).toEqual({ productMills: 900, packagingMills: 90, landedMills: 150, totalMills: 1140 });
    const sold = (await context.pool.query("SELECT total_cost_mills FROM oms.order_item_costs")).rows[0];
    expect(BigInt(sold.total_cost_mills)).toBe(BigInt(760));
    const remaining = await database.transaction(async tx => readUnallocatedLotCosts(tx, (await tx.execute(sql`SELECT * FROM inventory.inventory_lots WHERE id=4`)).rows.map(row => ({ ...row, id: row.id }))));
    expect(remaining.get(4)?.costs.totalMills).toBe(BigInt(5700));
    expect(BigInt(returned.lines[0].currentCosts.totalMills) + BigInt(sold.total_cost_mills) + remaining.get(4)!.costs.totalMills).toBe(BigInt(7600));
    expect((await context.pool.query("SELECT received_qty FROM procurement.receiving_lines WHERE id=51")).rows[0].received_qty).toBe(20);
    expect((await context.pool.query("SELECT received_qty FROM procurement.purchase_order_lines WHERE id=21")).rows[0].received_qty).toBe(100);
    expect((await context.pool.query("SELECT count(*)::int AS count FROM inventory.inventory_publication_outbox")).rows[0].count).toBe(0);
    expect((await context.pool.query("SELECT completed_at FROM inventory.supplier_return_followups")).rows[0].completed_at).toBeNull();
  });

  it("rolls back the active journal with failed reporting and never consumes reserved stock", async () => {
    const before = await context.state();
    await expect(database.transaction(tx => previewSupplierReturnStock(tx, { vendorId: 99, lines: [{ inventoryLotId: 4, quantity: 3 }] })))
      .rejects.toMatchObject({ code: "SUPPLIER_RETURN_VENDOR_MISMATCH" });
    expect(await context.state()).toEqual(before);
    await context.pool.query(`CREATE FUNCTION procurement.reject_test_return_report() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'supplier return reporting unavailable'; END; $$;
      CREATE TRIGGER reject_test_return_report BEFORE INSERT ON procurement.supplier_return_reporting_events
        FOR EACH ROW EXECUTE FUNCTION procurement.reject_test_return_report()`);
    try { await expect(record(3)).rejects.toThrow("supplier return reporting unavailable"); }
    finally { await context.pool.query("DROP TRIGGER reject_test_return_report ON procurement.supplier_return_reporting_events; DROP FUNCTION procurement.reject_test_return_report()"); }
    expect(await context.state()).toEqual(before);
    await context.transaction(client => context.ledger.postInsideTransaction(client, {
      contractVersion: "inventory_quantity_v1", idempotencyKey: "reserve-before-return", kind: "reserve", actor: "operator",
      reason: "Stock belongs to an existing customer order", reference: { type: "order", id: "1" },
      occurredAt: at.toISOString(), reversesCommandId: null,
      movements: [{ inventoryLotId: 4, inventoryLevelId: 10, warehouseLocationId: 100, warehouseId: 1,
        productVariantId: 101, delta: { onHand: 0, reserved: 16, picked: 0, packed: 0 } }],
    }));
    const reserved = await context.state();
    await expect(record(2)).rejects.toMatchObject({ code: "SUPPLIER_RETURN_RESERVED_OR_UNAVAILABLE" });
    expect(await context.state()).toEqual(reserved);
  });
});
