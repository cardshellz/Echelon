import { readFile } from "node:fs/promises";
import { recordCostRevision } from "../../cost-source-revision.repository";
import { resolve } from "node:path";
import { config } from "dotenv";
import { getTableColumns, sql, type Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { createPurchaseWorkspaceRepository, PURCHASE_WORKSPACE_RECORD_LIMIT } from "../../purchase-workspace.repository";
import { createPurchaseWorkspaceService } from "../../purchase-workspace.service";

config({ path: resolve(process.cwd(), ".env.test") });
const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const databaseTests = TEST_DB_URL && disposable ? describe : describe.skip;

// Build the selected fixture columns from the real Drizzle schema, so a
// misspelled/stale query column cannot be hidden by a matching handwritten DDL.
function fixtureTable(table: Parameters<typeof getTableConfig>[0], keys: readonly string[]): string {
  const definition = getTableConfig(table);
  const columns = getTableColumns(table as Table);
  const selected = keys.map((key) => {
    const column = columns[key];
    if (!column) throw new Error(`Unknown fixture column ${definition.name}.${key}`);
    return `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE "${definition.schema}"."${definition.name}" (${selected.join(", ")})`;
}

databaseTests.sequential("purchase workspace PostgreSQL read model", () => {
  let pool: pg.Pool;
  let ownsSchema = false;
  let ownsInventorySchema = false;
  let database: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    if ([process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(TEST_DB_URL!)) {
      throw new Error("Workspace integration requires a separate explicitly disposable database.");
    }
    pool = new pg.Pool({
      connectionString: TEST_DB_URL,
      ssl: /localhost|127\.0\.0\.1/.test(TEST_DB_URL!) ? false : { rejectUnauthorized: false },
    });
    await pool.query("CREATE SCHEMA procurement");
    ownsSchema = true;
    await pool.query("CREATE SCHEMA inventory");
    ownsInventorySchema = true;
    const tables = [
      fixtureTable(schema.vendors, ["id", "name"]),
      fixtureTable(schema.purchaseOrders, ["id", "poNumber", "vendorId", "status", "physicalStatus", "financialStatus", "currency", "totalCents", "invoicedTotalCents", "paidTotalCents", "outstandingCents", "expectedDeliveryDate", "confirmedDeliveryDate", "actualDeliveryDate"]),
      fixtureTable(schema.purchaseOrderLines, Object.keys(getTableColumns(schema.purchaseOrderLines))),
      fixtureTable(schema.receivingOrders, ["id", "receiptNumber", "status", "purchaseOrderId", "inboundShipmentId", "expectedDate", "receivedDate", "closedDate", "createdAt"]),
      fixtureTable(schema.receivingLines, Object.keys(getTableColumns(schema.receivingLines))),
      fixtureTable(schema.poReceipts, ["id", "receivingOrderId", "purchaseOrderId"]),
      fixtureTable(schema.inboundShipments, ["id", "shipmentNumber", "status", "mode", "containerNumber", "eta", "deliveredDate", "estimatedTotalCostCents", "actualTotalCostCents", "createdAt"]),
      fixtureTable(schema.inboundShipmentLines, ["id", "inboundShipmentId", "purchaseOrderId", "purchaseOrderLineId", "sku", "qtyShipped", "allocatedCostCents"]),
      fixtureTable(schema.vendorInvoices, ["id", "invoiceNumber", "status", "currency", "invoiceDate", "dueDate", "inboundShipmentId", "invoicedAmountCents", "paidAmountCents", "balanceCents"]),
      fixtureTable(schema.vendorInvoicePoLinks, ["id", "vendorInvoiceId", "purchaseOrderId", "allocatedAmountCents"]),
      fixtureTable(schema.inboundFreightCosts, Object.keys(getTableColumns(schema.inboundFreightCosts))),
      fixtureTable(schema.vendorInvoiceLines, Object.keys(getTableColumns(schema.vendorInvoiceLines))),
      fixtureTable(schema.inboundFreightAllocations, Object.keys(getTableColumns(schema.inboundFreightAllocations))),
      fixtureTable(schema.inventoryTransactions, Object.keys(getTableColumns(schema.inventoryTransactions))),
      fixtureTable(schema.inventoryLots, Object.keys(getTableColumns(schema.inventoryLots))),
    ];
    for (const ddl of tables) await pool.query(ddl);
    await pool.query(await readFile(resolve(process.cwd(), "migrations/222_procurement_cost_evidence.sql"), "utf8"));
    await pool.query(`
      INSERT INTO procurement.vendors(id,name) VALUES (1,'Fixture supplier');
      INSERT INTO procurement.purchase_orders
        (id,po_number,vendor_id,status,physical_status,financial_status,currency,total_cents,invoiced_total_cents,paid_total_cents,outstanding_cents,expected_delivery_date)
        VALUES (1,'PO-001',1,'sent','sent','partially_paid','USD',100000,40000,20000,20000,'2026-10-01'),
               (2,'PO-002',1,'sent','sent','unbilled','USD',60000,0,0,0,NULL);
      INSERT INTO procurement.purchase_order_lines
        (id,purchase_order_id,line_number,sku,product_name,line_type,order_qty,received_qty,cancelled_qty)
        VALUES (11,1,1,'SKU-A','Product A','product',100,25,0),
               (12,1,2,NULL,'Fee','fee',1,0,0),
               (21,2,1,'SKU-B','Product B','product',50,0,0);
      INSERT INTO procurement.inbound_shipments
        (id,shipment_number,status,mode,container_number,eta,estimated_total_cost_cents,actual_total_cost_cents,created_at)
        VALUES (7,'SHIP-007','in_transit','ocean','CONT-7','2026-10-03',9000,NULL,'2026-09-01'),
               (8,'SHIP-008','cancelled','ocean',NULL,NULL,NULL,0,'2026-09-02'),
               (9,'UNRELATED','draft',NULL,NULL,NULL,NULL,NULL,'2026-09-03');
      INSERT INTO procurement.inbound_shipment_lines
        (id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,sku,qty_shipped,allocated_cost_cents)
        VALUES (71,7,1,11,'SKU-A',60,5400),(72,7,2,21,'SKU-B',50,3600),
               (73,7,NULL,NULL,'UNKNOWN',5,NULL),(81,8,1,11,'SKU-A',40,NULL);
      INSERT INTO procurement.receiving_orders
        (id,receipt_number,status,purchase_order_id,inbound_shipment_id,created_at)
        VALUES (31,'RCV-DRAFT','draft',1,7,'2026-09-01'),
               (32,'RCV-CANCELLED','cancelled',1,8,'2026-09-02'),
               (33,'RCV-LEGACY','closed',NULL,NULL,'2026-09-03'),
               (34,'RCV-LINE-LINK','open',NULL,NULL,'2026-09-04'),
               (35,'RCV-OTHER-PO','draft',2,7,'2026-09-05'),
               (99,'UNRELATED','draft',NULL,9,'2026-09-06');
      INSERT INTO procurement.po_receipts (id,receiving_order_id,purchase_order_id) VALUES (331,33,1);
      INSERT INTO procurement.receiving_lines (id,receiving_order_id,purchase_order_line_id) VALUES (341,34,11);
      INSERT INTO procurement.vendor_invoices
        (id,invoice_number,status,currency,invoice_date,inbound_shipment_id,invoiced_amount_cents,paid_amount_cents,balance_cents)
        VALUES (41,'INV-SHARED','partially_paid','USD','2026-09-01',7,100000,50000,50000),
               (42,'INV-FREIGHT','received','USD','2026-09-02',NULL,9000,0,9000),
               (43,'INV-VOID','voided','USD','2026-09-03',NULL,-1000,0,0),
               (99,'INV-UNRELATED','received','USD','2026-09-04',9,9999,0,9999);
      INSERT INTO procurement.vendor_invoice_po_links (id,vendor_invoice_id,purchase_order_id,allocated_amount_cents)
        VALUES (411,41,1,40000),(412,41,2,60000),(431,43,1,NULL);
      INSERT INTO procurement.inbound_freight_costs (id,inbound_shipment_id,vendor_invoice_id) VALUES (421,7,42),(422,7,41);
    `);
    await pool.query(`
      UPDATE procurement.purchase_order_lines SET status='open', pricing_basis='extended_total',
        pricing_source='manual', total_product_cost_cents=10000, packaging_cost_cents=1800,
        discount_cents=0, tax_cents=0, line_total_cents=11800, unit_cost_mills=10000, pricing_remainder_mills=0,
        product_id=CASE WHEN line_type='product' THEN id+100 ELSE NULL END;
      UPDATE procurement.receiving_lines SET received_qty=1, reversed_qty=0;
      UPDATE procurement.inbound_freight_costs SET cost_type='freight',currency='USD',exchange_rate=1,
        cost_status='estimated', estimated_cents=9000;
      INSERT INTO procurement.vendor_invoice_lines
        (id,vendor_invoice_id,purchase_order_line_id,line_number,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents,match_status)
        VALUES (4111,41,11,1,100,100,10000,11800,'matched');
      INSERT INTO procurement.inbound_freight_allocations
        (id,shipment_cost_id,inbound_shipment_line_id,allocated_cents,allocation_basis_value,allocation_basis_total)
        VALUES (4211,421,71,5400,60,110),(4212,421,72,3600,50,110);
    `);
    database = drizzle(pool, { schema });
  });

  afterAll(async () => {
    if (pool) {
      if (ownsInventorySchema) await pool.query("DROP SCHEMA inventory CASCADE");
      if (ownsSchema) await pool.query("DROP SCHEMA procurement CASCADE");
      await pool.end();
    }
  });

  const workspace = () => createPurchaseWorkspaceService(createPurchaseWorkspaceRepository(database)).getPurchaseWorkspace(1);

  it("executes the real bounded SQL and retains draft, cancelled and legacy receipt relationships", async () => {
    const result = await workspace();
    expect(result.shipments.map((record) => record.id)).toEqual([7, 8]);
    expect(result.receipts.map((record) => record.id).sort()).toEqual([31, 32, 33, 34, 35]);
    expect(result.receipts.find((record) => record.id === 31)?.status).toBe("draft");
    expect(result.receipts.find((record) => record.id === 32)?.status).toBe("cancelled");
    expect(result.edges.filter((edge) => edge.relationship === "purchase_receipt").map((edge) => edge.to.id).sort()).toEqual([31, 32, 33, 34]);
    expect(result.edges).toContainEqual({ from: { kind: "shipment", id: 7 }, to: { kind: "receipt", id: 35 }, relationship: "shipment_receipt" });
    expect(result.purchase.lines.map((line) => line.quantityBasis)).toEqual(["pieces", "not_applicable"]);
    expect(result.purchase.expectedDeliveryDate).toMatch(/^2026-10-01T/);
  });

  it("keeps split/shared shipment lines and invoice costs at their recorded document scope", async () => {
    const result = await workspace();
    const shared = result.shipments.find((record) => record.id === 7)!;
    expect(shared.purchaseOrderIds).toEqual([1, 2]);
    expect(shared.unlinkedLineCount).toBe(1);
    expect(shared.lines.map((line) => line.qtyShipped)).toEqual([60, 50, 5]);
    expect(shared.estimatedTotalCostCents).toBe(9000);
    expect(shared.actualTotalCostCents).toBeNull();
    expect(result.invoices.map((invoice) => invoice.id)).toEqual([41, 42, 43]);
    expect(result.invoices[0]).toMatchObject({ invoicedAmountCents: 100000, paidAmountCents: 50000, allocatedToPurchaseCents: 40000, amountScope: "whole_invoice", purchaseOrderIds: [1, 2] });
    expect(result.invoices[1].allocatedToPurchaseCents).toBeNull();
    expect(result.invoices[2]).toMatchObject({ status: "voided", invoicedAmountCents: -1000 });
    expect(result.edges.filter((edge) => edge.relationship === "shipment_invoice" && edge.to.id === 41)).toHaveLength(1);
    expect(result.edges.some((edge) => edge.relationship === "purchase_invoice" && edge.to.id === 42)).toBe(false);
    expect(result.purchase.paidTotalCents).toBe(20000);
  });

  it("reads quote components and exact purchase allocations without assigning whole charges or invoice residuals", async () => {
    const result = await workspace();
    expect(result.costTrace?.purchaseLines[0]).toMatchObject({
      id: 11, productCents: 10000, packagingCents: 1800, outstandingPieces: 75, unreceivedQuoteCents: 8850,
    });
    expect(result.costTrace?.invoiceLines).toEqual([expect.objectContaining({
      id: 4111, invoiceId: 41, purchaseOrderLineId: 11, componentEvidence: "unclassified", lineTotalCents: 11800,
    })]);
    expect(result.costTrace?.shipmentCharges.find((row) => row.id === 421)).toMatchObject({
      amountEvidence: "estimated", amountScope: "whole_shipment_charge", estimatedCents: 9000, actualCents: null,
      allocations: [expect.objectContaining({ id: 4211, shipmentLineId: 71, purchaseOrderLineId: 11, allocatedCents: 5400, currency: null })],
    });
    expect(result.costTrace?.receiptLines[0]).toMatchObject({ id: 341, frozenPiecesPerUnit: null, lineageEvidence: "review_required" });
    expect(result.costTrace?.applicationEvidence).toBe("not_verified");
  });

  it("retains an actual zero and a signed shipment credit without inferring application", async () => {
    await pool.query("UPDATE procurement.inbound_freight_costs SET actual_cents=0,cost_status='finalized' WHERE id=421");
    await pool.query("UPDATE procurement.inbound_freight_costs SET actual_cents=-500 WHERE id=422");
    try {
      const result = await workspace();
      expect(result.costTrace?.shipmentCharges.map((row) => [row.actualCents, row.amountEvidence])).toEqual([[0, "actual_recorded"], [-500, "actual_recorded"]]);
      expect(result.costTrace?.applicationEvidence).toBe("not_verified");
    } finally {
      await pool.query("UPDATE procurement.inbound_freight_costs SET actual_cents=NULL,cost_status='estimated'");
    }
  });

  it("follows exact receipt transaction identity to current lot components while retaining unknown currency", async () => {
    await pool.query(`
      UPDATE procurement.receiving_orders SET purchase_order_id=1,inbound_shipment_id=7,status='closed' WHERE id=34;
      UPDATE procurement.receiving_lines SET product_variant_id=201,product_id=111,
        units_per_variant_snapshot=50,inbound_shipment_line_id=71 WHERE id=341;
      INSERT INTO inventory.inventory_lots
        (id,lot_number,product_variant_id,warehouse_location_id,receiving_order_id,purchase_order_id,po_line_id,inbound_shipment_id,
         qty_on_hand,qty_reserved,qty_picked,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills,cost_provisional)
        VALUES (901,'LOT-EXACT-RECEIPT',201,9,34,1,11,7,1,0,0,500000,90000,25000,615000,0);
      INSERT INTO inventory.inventory_transactions
        (id,product_variant_id,transaction_type,variant_qty_delta,receiving_order_id,receiving_line_id,inventory_lot_id,created_at)
        VALUES (9001,201,'receipt',1,34,341,901,'2026-09-03T12:00:00Z');
    `);
    try {
      const result = await workspace();
      expect(result.costTrace?.receiptLines[0]).toMatchObject({
        id: 341, shipmentLineId: 71, frozenPiecesPerUnit: 50, lineageEvidence: "original_receipt_proven",
        postings: [expect.objectContaining({ id: 9001, variantQuantity: 1, lot: expect.objectContaining({
          id: 901, productUnitMills: 500000, packagingUnitMills: 90000, landedUnitMills: 25000,
          totalUnitMills: 615000, currency: null, recordedProvisional: false,
        }) })],
      });
      await pool.query("UPDATE inventory.inventory_lots SET inbound_shipment_id=8 WHERE id=901");
      expect((await workspace()).costTrace?.receiptLines[0].lineageEvidence).toBe("review_required");
    } finally {
      await pool.query("DELETE FROM inventory.inventory_transactions WHERE id=9001");
      await pool.query("DELETE FROM inventory.inventory_lots WHERE id=901");
      await pool.query("UPDATE procurement.receiving_orders SET purchase_order_id=NULL,inbound_shipment_id=NULL,status='open' WHERE id=34");
      await pool.query("UPDATE procurement.receiving_lines SET product_variant_id=NULL,product_id=NULL,units_per_variant_snapshot=NULL,inbound_shipment_line_id=NULL WHERE id=341");
    }
  });
  it("uses a real read-only repeatable-read transaction", async () => {
    let observed: Record<string, unknown> | undefined;
    const repository = createPurchaseWorkspaceRepository({
      transaction: (callback, options) => database.transaction(async (tx) => {
        observed = (await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly, current_setting('transaction_isolation') AS isolation`)).rows[0];
        return callback(tx);
      }, options),
    });
    await repository.read(1);
    expect(observed).toEqual({ readonly: "on", isolation: "repeatable read" });
  });

  it("fails rather than rounding an unsafe PostgreSQL bigint", async () => {
    await pool.query("UPDATE procurement.purchase_orders SET total_cents=9007199254740993 WHERE id=1");
    try {
      await expect(workspace()).rejects.toMatchObject({ code: "PURCHASE_WORKSPACE_MONEY_INVALID", statusCode: 500 });
    } finally {
      await pool.query("UPDATE procurement.purchase_orders SET total_cents=100000 WHERE id=1");
    }
  });

  it("preserves missing and zero amounts as different values", async () => {
    await pool.query("UPDATE procurement.purchase_orders SET total_cents=NULL WHERE id=1");
    try {
      const result = await workspace();
      expect(result.purchase.totalCents).toBeNull();
      expect(result.shipments.find((shipment) => shipment.id === 8)?.actualTotalCostCents).toBe(0);
    } finally {
      await pool.query("UPDATE procurement.purchase_orders SET total_cents=100000 WHERE id=1");
    }
  });

  it("rejects oversized history explicitly instead of returning partial records", async () => {
    await pool.query(`
      INSERT INTO procurement.receiving_orders(id,receipt_number,status,purchase_order_id)
      SELECT 10000+n, 'LIMIT-' || n, 'draft', 1 FROM generate_series(1,$1::int) n
    `, [PURCHASE_WORKSPACE_RECORD_LIMIT + 1]);
    try {
      await expect(workspace()).rejects.toMatchObject({ code: "PURCHASE_WORKSPACE_TOO_LARGE", statusCode: 422 });
    } finally {
      await pool.query("DELETE FROM procurement.receiving_orders WHERE id>=10000");
    }
  });

  it("reads immutable applications and receipt cost attempts with exact PO scope and snapshot lineage", async () => {
    const now = new Date("2026-09-07T12:00:00.000Z");
    try {
      await pool.query(`
        UPDATE procurement.receiving_orders SET status='closed' WHERE id=34;
        INSERT INTO inventory.inventory_lots
          (id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,qty_reserved,qty_picked,
           po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills,cost_provisional)
          VALUES (901,'ORIGIN-901',201,9,1,0,0,0,500000,90000,25000,615000,0),
                 (902,'TRANSFER-902',201,10,1,0,0,0,500000,90000,25000,615000,0);
        INSERT INTO inventory.lot_cost_origins(inventory_lot_id,receiving_line_id,purchase_order_line_id,
          units_per_variant_snapshot,received_variant_qty,purchase_start_base_piece,recorded_by,recorded_at)
          VALUES (901,341,11,50,1,0,'fixture-owner','2026-09-07T12:00:00Z');
        INSERT INTO inventory.lot_cost_contributions(source_lot_id,output_lot_id,operation_kind,operation_key,
          source_qty,output_qty,output_start_qty,recorded_by,recorded_at)
          VALUES (901,902,'transfer','fixture-transfer',1,1,0,'fixture-owner','2026-09-07T12:00:00Z');
      `);
      const source = await database.transaction((tx) => recordCostRevision(tx, {
        contractVersion: 1, component: "product", scope: { kind: "purchase_order_line", purchaseOrderId: 1, purchaseOrderLineId: 11 },
        sources: [{ kind: "vendor_invoice_line", documentId: 41, lineId: 4111, version: "a".repeat(64) }],
        currency: "USD", totalMills: 1000000, basePieces: 100, evidence: "confirmed", packagingTreatment: "separate", issue: null, manualOverride: null,
      }, "fixture-owner", now, { purchaseOrderLine: { id: 11 }, approvedInvoices: [{ id: 4111, productMills: 1000000 }] }));
      const outcome = { status: "applied", lotsUpdated: 2, cogsRowsUpdated: 1, totalCogsDeltaCents: -500, issues: [] };
      const applicationId = Number((await pool.query(`INSERT INTO inventory.cost_applications(application_key,source_revision_id,status,evidence,recorded_by,recorded_at)
        VALUES ($1,$2,'applied',$3,'fixture-owner',$4) RETURNING id`, ["b".repeat(64), source.id, { result: outcome }, now])).rows[0].id);
      const before = { productMills: 550000, packagingMills: 90000, landedMills: 25000 };
      const after = { productMills: 500000, packagingMills: 90000, landedMills: 25000, totalMills: 615000,
        component: "product", allocatedMills: 500000, quantity: 1, remainderMills: 0 };
      await pool.query(`INSERT INTO inventory.cost_application_lots(application_id,inventory_lot_id,before_state,after_state)
        VALUES ($1,901,$2,$3),($1,902,$2,$3)`, [applicationId, before, after]);
      await pool.query(`INSERT INTO inventory.cost_reporting_events(application_id,contract_version,payload,recorded_at)
        VALUES ($1,1,$2,$3)`, [applicationId, { contractVersion: 1, sourceRevisionId: source.id, sourceFingerprint: source.contract.fingerprint,
        component: "product", currency: "USD", cogsDeltaCents: -500, changes: [901,902].map((lotId) => ({ lotId, before, after })) }, now]);
      const requestId = Number((await pool.query(`INSERT INTO procurement.receipt_cost_requests(receiving_order_id,purchase_order_line_id,requested_by,requested_at)
        VALUES (34,11,'fixture-owner',$1) RETURNING id`, [now])).rows[0].id);
      await pool.query(`INSERT INTO procurement.cost_source_revisions(purchase_order_line_id,component,revision,fingerprint,contract,recorded_by,recorded_at)
        VALUES (21,'product',1,$1,'{}','unrelated-fixture',$2)`, ["c".repeat(64), now]);
      const result = await workspace();
      expect(result.costTrace?.applicationEvidence).toBe("recorded");
      const revisions = result.costTrace!.applicationHistory!.revisions;
      expect(revisions).toHaveLength(1); expect(revisions[0].id).toBe(source.id);
      expect(revisions[0].applications[0]).toMatchObject({ id: applicationId, evidenceState: "verified_record", outcome: { totalCogsDeltaCents: -500 },
        reportingEvent: { evidenceState: "verified_record", externalDelivery: "not_verified" } });
      expect(revisions[0].applications[0].lotChanges.map((change) => [change.lotId, change.lineage])).toEqual([[901,"original_receipt"],[902,"transformed"]]);
      expect(result.costTrace?.receiptCostRequests).toEqual([expect.objectContaining({ id: requestId, state: "pending", receiptStatus: "closed" })]);
      await pool.query(`INSERT INTO procurement.receipt_cost_attempts(request_id,state,result,recorded_by,recorded_at)
        VALUES ($1,'retry_required',$2,'fixture-owner',$3)`, [requestId, { summary: { requestId, purchaseOrderLineId: 11, state: "retry_required", attemptRecorded: true,
        issues: [{ code: "RECEIPT_COST_RETRY_REQUIRED", message: "Synthetic transaction failure." }] } }, now]);
      await pool.query(`INSERT INTO procurement.receipt_cost_attempts(request_id,state,result,recorded_by,recorded_at)
        VALUES ($1,'applied',$2,'fixture-owner',$3)`, [requestId, { summary: { requestId, purchaseOrderLineId: 11, state: "applied", attemptRecorded: true, issues: [] },
        reconciliation: { costApplications: [{ ...outcome, applicationId }] } }, now]);
      const queue = (await workspace()).costTrace!.receiptCostRequests!;
      expect(queue[0].state).toBe("applied"); expect(queue[0].attempts).toHaveLength(2);
      expect(queue[0].attempts[0]).toMatchObject({ evidenceState: "verified_record", applicationIds: [applicationId] });
      expect(queue[0].attempts[1].state).toBe("retry_required");
    } finally {
      await pool.query(`TRUNCATE inventory.cost_applications,procurement.cost_source_revisions,inventory.lot_cost_origins,
        inventory.lot_cost_contributions,procurement.receipt_cost_requests RESTART IDENTITY CASCADE`);
      await pool.query("DELETE FROM inventory.inventory_lots WHERE id IN (901,902)");
      await pool.query("UPDATE procurement.receiving_orders SET status='open' WHERE id=34");
    }
  });

  it("rejects excess cost revision history instead of hiding older evidence", async () => {
    await pool.query(`INSERT INTO procurement.cost_source_revisions(purchase_order_line_id,component,revision,fingerprint,contract,recorded_by,recorded_at)
      SELECT 11,'packaging',n,$1,'{}','limit-fixture','2026-09-07T12:00:00Z' FROM generate_series(1,1001) n`, ["d".repeat(64)]);
    try {
      await expect(workspace()).rejects.toMatchObject({ code: "PURCHASE_WORKSPACE_TOO_LARGE", statusCode: 422 });
    } finally {
      await pool.query("TRUNCATE procurement.cost_source_revisions CASCADE");
    }
  });
  it("returns not found for an absent purchase without reading an unrelated graph", async () => {
    await expect(createPurchaseWorkspaceService(createPurchaseWorkspaceRepository(database)).getPurchaseWorkspace(987654))
      .rejects.toMatchObject({ code: "PURCHASE_WORKSPACE_NOT_FOUND", statusCode: 404 });
  });
});
