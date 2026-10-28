import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createFlowCostHarness, seedFlowMasterData, FLOW_AT, FLOW_ACTOR, type FlowCostHarness } from "./procurement-flow-cost.fixture";
import { prepareShipmentCostRevisions, prepareShipmentCostRevisionBatch } from "../../shipment-cost-application.service";
import { readCurrentShipmentSourceFingerprintBatch } from "../../shipment-cost-exception.repository";
import { readShipmentCostReviewsInTransaction, readShipmentCostReviewInTransaction } from "../../shipment-cost-review.repository";
import { readSupplierCreditCostRows, readShipmentSupplierCreditCostRows } from "../../supplier-credit-source.repository";
import { readShipmentProvisionalLotCounts } from "../../shipment-health-evidence.repository";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const enabled = Boolean(url) && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const snapshot = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
(enabled ? describe : describe.skip).sequential("complete batched shipment cost reads", () => {
  let harness: FlowCostHarness;
  beforeEach(async () => {
    harness = await createFlowCostHarness(url!);
    await seedFlowMasterData(harness);
    await harness.pool.query(`
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,physical_status,source,currency,total_cents,line_count,created_at,updated_at)
        VALUES(11,'BATCH-PO-11',5,'acknowledged','in_transit','manual','USD',1000000,1,$1,$1),
          (12,'BATCH-PO-12',5,'acknowledged','in_transit','manual','USD',1000000,1,$1,$1);`, [FLOW_AT]);
    await harness.pool.query(`INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,line_type,status,product_id,product_variant_id,sku,
        order_qty,unit_cost_cents,unit_cost_mills,total_product_cost_cents,line_total_cents,packaging_cost_cents,discount_cents,tax_cents)
        VALUES(111,11,1,'product','open',100,201,'PROC-UAT-FLOW-A-EACH',10000,100,10000,1000000,1000000,0,0,0),
          (121,12,1,'product','open',100,201,'PROC-UAT-FLOW-A-EACH',10000,100,10000,1000000,1000000,0,0,0);`);
    await seedShipments(2);
    await harness.pool.query(`INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,status,invoiced_amount_cents,balance_cents,currency)
      VALUES(301,'BATCH-SHARED-FREIGHT',6,'approved',3000,3000,'USD');
      INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,freight_cost_id,qty_invoiced,unit_cost_cents,line_total_cents)
      VALUES(401,301,1,41,1,1000,1000),(402,301,2,42,1,2000,2000);
      UPDATE procurement.inbound_freight_costs SET vendor_id=6,vendor_invoice_id=301 WHERE id IN(41,42);`);
  });
  afterEach(async () => { await harness?.dispose(); });
  async function seedShipments(count: number) {
    await harness.pool.query(`INSERT INTO procurement.inbound_shipments(id,shipment_number,status,mode,warehouse_id,allocation_method_default,total_pieces,created_at,updated_at)
      SELECT 30+n,'BATCH-SHIP-'||n,'costing','ocean',1,'by_line_count',10,$1,$1 FROM generate_series(1,$2::int) n ON CONFLICT DO NOTHING;`, [FLOW_AT, count]);
    await harness.pool.query(`INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,product_variant_id,sku,qty_shipped)
      SELECT 300+n,30+n,CASE WHEN n=2 THEN 12 ELSE 11 END,CASE WHEN n=2 THEN 121 ELSE 111 END,201,'PROC-UAT-FLOW-A-EACH',10
      FROM generate_series(1,$1::int) n ON CONFLICT DO NOTHING;`, [count]);
    await harness.pool.query(`INSERT INTO procurement.inbound_freight_costs(id,inbound_shipment_id,cost_type,estimated_cents,currency,allocation_method,cost_status)
      SELECT 40+n,30+n,'freight',CASE WHEN n=2 THEN 2000 ELSE 1000 END,'USD','by_line_count','estimated'
      FROM generate_series(1,$1::int) n ON CONFLICT DO NOTHING;`, [count]);
  }
  it("preserves full shared invoice documents, totals, source identities and independent PO scopes", async () => {
    await harness.database.transaction(async tx => {
      const batch = await prepareShipmentCostRevisionBatch(tx, [31, 32]);
      for (const id of [31, 32]) {
        expect(batch.get(id)).toEqual(await prepareShipmentCostRevisions(tx, id));
        const proposal = batch.get(id)!.proposals[0];
        const evidence = proposal.sourceEvidence as { invoices: Array<{ document_lines_total_cents: string; id: number }> };
        expect(evidence.invoices.map(row => row.id)).toEqual([401, 402]);
        expect(evidence.invoices.map(row => row.document_lines_total_cents)).toEqual(["3000", "3000"]);
        expect(proposal.input.scope).toMatchObject({ inboundShipmentId: id, purchaseOrderId: id === 31 ? 11 : 12 });
      }
      const reviews = await readShipmentCostReviewsInTransaction(tx, [31, 32]);
      expect(reviews.get(31)).toEqual(await readShipmentCostReviewInTransaction(tx, 31));
      expect(reviews.get(32)).toEqual(await readShipmentCostReviewInTransaction(tx, 32));
    }, snapshot);
  });
  it("uses bounded six-query economic batches over more than two header pages", async () => {
    await seedShipments(201);
    await harness.database.transaction(async tx => {
      let reads = 0;
      const reader = { execute: async (query: unknown) => { reads++; return tx.execute(query as Parameters<typeof tx.execute>[0]); } };
      const ids = Array.from({ length: 201 }, (_, i) => 31 + i);
      const result = await readCurrentShipmentSourceFingerprintBatch(reader, ids);
      expect(result.size).toBe(201); expect([...result.values()].every(value => value.size === 1)).toBe(true);
      expect(reads).toBe(18);
    }, snapshot);
  });
  it("retains one reader snapshot during a concurrent source change and refreshes on the next request", async () => {
    let before: Map<number, Map<number, string>>;
    await harness.database.transaction(async tx => {
      before = await readCurrentShipmentSourceFingerprintBatch(tx, [31, 32]);
      await harness.pool.query("UPDATE procurement.inbound_freight_costs SET estimated_cents=1100 WHERE id=41");
      expect(await readCurrentShipmentSourceFingerprintBatch(tx, [31, 32])).toEqual(before);
    }, snapshot);
    const after = await harness.database.transaction(tx => readCurrentShipmentSourceFingerprintBatch(tx, [31, 32]), snapshot);
    expect(after.get(31)).not.toEqual(before!.get(31)); expect(after.get(32)).toEqual(before!.get(32));
  });
  it("keeps the original credit filters and per-shipment evidence, including approved void history", async () => {
    await harness.pool.query(`INSERT INTO procurement.supplier_credits(id,source_invoice_id,vendor_id,source_snapshot,supplier_reference,
      credit_calendar_date,total_amount_cents,status,reason,created_by,created_at,approved_at)
      SELECT n,301,6,'{}'::jsonb,'BATCH-CREDIT-'||n,'2026-09-10',1,
        CASE WHEN n=3 THEN 'draft' WHEN n IN(2,4) THEN 'voided' ELSE 'approved' END,'Read fixture',$1,$2,
        CASE WHEN n IN(1,2,5) THEN $2::timestamptz ELSE NULL END FROM generate_series(1,5) n;`, [FLOW_ACTOR, FLOW_AT]);
    await harness.pool.query(`INSERT INTO procurement.supplier_credit_lines(id,supplier_credit_id,invoice_line_id,amount_cents,source_key,disposition,created_at)
      SELECT n,n,CASE WHEN n=2 THEN 402 ELSE 401 END,1,'batch-'||n,
        CASE WHEN n=5 THEN '{"kind":"accepted_stock_return"}'::jsonb ELSE '{"kind":"landed_adjustment"}'::jsonb END,$1
      FROM generate_series(1,5) n;`, [FLOW_AT]);
    await harness.database.transaction(async tx => {
      const result = await readShipmentSupplierCreditCostRows(tx, [31, 32]);
      expect(result.get(31)).toEqual(await readSupplierCreditCostRows(tx, { freightCostIds: [41] }));
      expect(result.get(32)).toEqual(await readSupplierCreditCostRows(tx, { freightCostIds: [42] }));
      expect(result.get(31)!.map(row => Number(row.id))).toEqual([1]);
      expect(result.get(32)!.map(row => Number(row.id))).toEqual([2]);
    }, snapshot);
  });
  it("counts every provisional child without confusing another shipment's traced identity", async () => {
    await harness.pool.query(`INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,inbound_shipment_id,
      qty_received,qty_on_hand,cost_provisional,received_at)
      SELECT 1000+n,'BATCH-UNTRACED-'||n,201,99,CASE WHEN n=1 THEN 32 ELSE 31 END,0,0,1,$1
      FROM generate_series(1,10006) n;`, [FLOW_AT]);
    const before = (await harness.pool.query("SELECT count(*)::text AS count FROM inventory.inventory_lots")).rows;
    const result = await harness.database.transaction(tx => readShipmentProvisionalLotCounts(tx, [
      { shipmentId: 31, tracedLotIds: [1001, 1001] }, { shipmentId: 32, tracedLotIds: [1001, 1001] },
    ]), snapshot);
    expect(result.get(31)).toEqual({ provisionalLotCount: 10005, untracedProvisionalLotCount: 10005 });
    expect(result.get(32)).toEqual({ provisionalLotCount: 1, untracedProvisionalLotCount: 0 });
    expect((await harness.pool.query("SELECT count(*)::text AS count FROM inventory.inventory_lots")).rows).toEqual(before);
  });
  it("does not hide a PostgreSQL read failure or write through its read-only transaction", async () => {
    await expect(harness.database.transaction(tx => tx.execute(sql`SELECT 1/0`), snapshot)).rejects.toMatchObject({ code: "22012" });
    await expect(harness.database.transaction(tx => tx.execute(sql`UPDATE procurement.inbound_freight_costs SET estimated_cents=1`), snapshot)).rejects.toMatchObject({ code: "25006" });
    expect(await harness.database.transaction(tx => readCurrentShipmentSourceFingerprintBatch(tx, [31, 32]), snapshot)).toHaveProperty("size", 2);
  });
});
