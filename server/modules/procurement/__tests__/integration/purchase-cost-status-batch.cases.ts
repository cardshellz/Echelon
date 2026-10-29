import type pg from "pg";
import { it, expect } from "vitest";
import type { PurchaseCostStatus } from "@shared/procurement/purchase-cost-status";
import type { AmendmentDatabase } from "../../po-quantity-amendment.repository";
import { readPurchaseCostStatus } from "../../purchase-cost-status.repository";
import { visitPurchaseCostStatusScopes } from "../../purchase-cost-status-batch.repository";
import { readShipmentCostReviewInTransaction, readShipmentCostReviewsInTransaction } from "../../shipment-cost-review.repository";

export function registerPurchaseCostStatusBatchCases(fixture: { pool: () => pg.Pool; database: () => AmendmentDatabase }) {
  async function additionalScope() {
    await fixture.pool().query(`INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,line_type,status,
      product_id,product_variant_id,sku,order_qty,unit_cost_cents,unit_cost_mills,total_product_cost_cents,line_total_cents,packaging_cost_cents)
      SELECT 22,purchase_order_id,2,line_type,status,product_id,product_variant_id,'SECOND-COST-SCOPE',order_qty,
        unit_cost_cents,unit_cost_mills,total_product_cost_cents,line_total_cents,packaging_cost_cents
      FROM procurement.purchase_order_lines WHERE id=21;
      INSERT INTO procurement.inbound_shipments(id,shipment_number,status) VALUES(2,'SECOND-COST-SCOPE','closed');
      INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,
        product_variant_id,sku,qty_shipped) VALUES(12,2,10,22,200,'SECOND-COST-SCOPE',100)`);
  }
  async function lots(lineId: number, count: number, start: number) {
    await fixture.pool().query(`INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,
      po_line_id,inbound_shipment_id,qty_received,qty_on_hand,cost_provisional,received_at)
      SELECT $1::int+n,'BATCH-COST-'||($1::int+n),200,99,$2,$3,1,0,1,'2026-09-06T12:00:00Z'
      FROM generate_series(1,$4::int) n`, [start, lineId, lineId === 21 ? 1 : 2, count]);
  }
  it("keeps two independently valid 5001-lot shipments complete when their combined graph exceeds the existing limit", async () => {
    await additionalScope(); await lots(21, 5001, 1_000_000); await lots(22, 5001, 2_000_000);
    await fixture.database().transaction(async tx => {
      const first = await readShipmentCostReviewInTransaction(tx, 1), second = await readShipmentCostReviewInTransaction(tx, 2);
      expect(first?.supplierCosts?.lines[0].lots).toHaveLength(5001);
      expect(second?.supplierCosts?.lines[0].lots).toHaveLength(5001);
      const batched = await readShipmentCostReviewsInTransaction(tx, [2, 1]);
      expect([...batched]).toEqual([[2, second], [1, first]]);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  });
  it("retains the real 10000-lot boundary for one shipment instead of splitting its evidence", async () => {
    await additionalScope(); await lots(21, 10001, 1_000_000);
    await expect(fixture.database().transaction(tx => readPurchaseCostStatus(tx, [21]),
      { isolationLevel: "repeatable read", accessMode: "read only" })).rejects.toMatchObject({ code: "COST_REVIEW_LIMIT" });
    await expect(fixture.database().transaction(tx => visitPurchaseCostStatusScopes(tx, new Map([[1, [21]], [2, [22]]]), () => undefined),
      { isolationLevel: "repeatable read", accessMode: "read only" })).rejects.toMatchObject({ code: "COST_REVIEW_LIMIT" });
  });
  it("uses one repeatable-read snapshot across a concurrently committed supplier approval and refreshes in a new snapshot", async () => {
    let prior!: PurchaseCostStatus;
    await fixture.database().transaction(async tx => {
      prior = await readPurchaseCostStatus(tx, [21]);
      await fixture.pool().query("UPDATE procurement.vendor_invoices SET status='approved' WHERE id=71");
      const projected = new Map<number, PurchaseCostStatus>();
      await visitPurchaseCostStatusScopes(tx, new Map([[1, [21]], [2, [21]]]), (id, value) => { projected.set(id, value); });
      expect([...projected]).toEqual([[1, prior], [2, prior]]);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    const current = await fixture.database().transaction(tx => readPurchaseCostStatus(tx, [21]),
      { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(current).not.toEqual(prior);
    expect(current.lines[0].invoices).toHaveLength(1);
  });
}
