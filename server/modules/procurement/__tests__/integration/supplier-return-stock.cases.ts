import { randomUUID } from "node:crypto";
import type pg from "pg";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import type { AmendmentDatabase, AmendmentTransaction } from "../../po-quantity-amendment.repository";
import type { InventoryUseCases } from "../../../inventory/application/inventory.use-cases";
import type { ReceivingService } from "../../receiving.service";
import { previewSupplierReturnStock, readSupplierReturnInventoryEvidence } from "../../../inventory/application/supplier-return-stock";
import { readUnallocatedLotCosts } from "../../../inventory/infrastructure/cost-quantity.repository";
import { InventoryLotService } from "../../../inventory/lots.service";
import { recordSupplierReturn, createSupplierReturnReader } from "../../supplier-return.service";
import { SupplierReturnFollowupService } from "../../../inventory/application/supplier-return-followup.service";

export interface SupplierReturnStockFixture {
  pool: () => pg.Pool;
  database: () => AmendmentDatabase & Pick<AmendmentTransaction, "execute">;
  at: Date; actorId: string;
  receive: () => Promise<{ receiptId: number; lineId: number }>;
  approveInvoice: () => Promise<unknown>;
  inventory: () => InventoryUseCases;
  receiving: () => ReceivingService;
  updateFreight: () => Promise<unknown>;
}

export function registerSupplierReturnStockCases(fixture: SupplierReturnStockFixture) {
  const query = (text: string, values: unknown[] = []) => fixture.pool().query(text, values);
  async function rootLot() { return Number((await query("SELECT id FROM inventory.inventory_lots ORDER BY id LIMIT 1")).rows[0].id); }
  async function preview(lotId: number, quantity = 1) {
    return fixture.database().transaction(tx => previewSupplierReturnStock(tx, { vendorId: 5, lines: [{ inventoryLotId: lotId, quantity }] }));
  }
  async function record(lotId: number, quantity = 1, key = randomUUID()) {
    const reviewed = await preview(lotId, quantity);
    const input = { raw: { vendorId: 5, lines: [{ inventoryLotId: lotId, quantity }],
      expectedSourceFingerprint: reviewed.sourceFingerprint, returnCalendarDate: "2026-09-06",
      evidenceReference: "Supplier collection docket RETURN-100", reason: "Supplier collected verified unsold stock" },
    actorId: fixture.actorId, at: fixture.at, commandKey: key, requestFingerprint: "c".repeat(64) };
    return { document: await fixture.database().transaction(tx => recordSupplierReturn(tx, input)), input };
  }
  async function evidence() {
    return (await query(`SELECT
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM inventory.inventory_lots row) AS lots,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM inventory.inventory_levels row) AS levels,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM procurement.receiving_lines row) AS receipt,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM procurement.purchase_order_lines row) AS po,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM procurement.po_receipts row) AS receipt_history,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM procurement.vendor_invoices row) AS invoices,
      (SELECT count(*)::int FROM procurement.supplier_returns) AS returns,
      (SELECT count(*)::int FROM inventory.supplier_return_cost_entries) AS return_entries,
      (SELECT count(*)::int FROM inventory.lot_cost_quantity_allocations) AS allocations,
      (SELECT count(*)::int FROM inventory.inventory_transactions) AS movements`)).rows[0];
  }

  for (const transferred of [false, true]) it(`supplier stock return preserves receipt history and conserves late costs with ${transferred ? "a proven transfer descendant" : "a direct receipt lot"}`, async () => {
    const receipt = await fixture.receive();
    const originalLot = await rootLot();
    let selectedLot = originalLot;
    if (transferred) {
      await query("INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(100,1,'RETURN-TRANSFER')");
      await fixture.inventory().transfer({ productVariantId: 200, fromLocationId: 99, toLocationId: 100, qty: 1,
        userId: fixture.actorId, commandKey: randomUUID() });
      selectedLot = Number((await query("SELECT id FROM inventory.inventory_lots WHERE warehouse_location_id=100")).rows[0].id);
    }
    const before = await evidence();
    const saved = await record(selectedLot);
    expect(saved.document.inventoryReceipt.replayed).toBe(false);
    expect(saved.document.lines[0].source.sourceProof.transfers).toHaveLength(transferred ? 1 : 0);
    expect(saved.document.lines[0].source.costs).toEqual({ productMills: 500000, packagingMills: 50000, landedMills: 0, totalMills: 550000 });
    const after = await evidence();
    for (const key of ["receipt", "po", "receipt_history", "invoices"]) expect(after[key]).toEqual(before[key]);
    expect(after.returns).toBe(1); expect(after.return_entries).toBe(3);
    expect((await query("SELECT qty_on_hand FROM inventory.inventory_lots WHERE id=$1", [selectedLot])).rows[0].qty_on_hand).toBe(transferred ? 0 : 1);
    const replay = await fixture.database().transaction(tx => recordSupplierReturn(tx, saved.input));
    expect(replay).toEqual(saved.document);
    expect(await evidence()).toEqual(after);
    const { ReceiptReversalService } = await import("../../receipt-reversal.service");
    const reversal = new ReceiptReversalService(fixture.database() as ConstructorParameters<typeof ReceiptReversalService>[0]);
    for (const operation of [
      () => reversal.reverseReceivingLine({ receivingLineId: receipt.lineId, qty: 1, reason: "Incorrect attempt to correct returned stock", idempotencyKey: randomUUID(), userId: fixture.actorId }),
      () => reversal.reverseReceivingOrder({ receivingOrderId: receipt.receiptId, reason: "Incorrect attempt to correct returned stock", idempotencyKey: randomUUID(), userId: fixture.actorId }),
    ]) await expect(operation()).rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIPT_REVERSAL_SUPPLIER_RETURN_HISTORY" } });
    expect(await evidence()).toEqual(after);

    await fixture.database().transaction(tx => new InventoryLotService(tx, () => fixture.at).pickFromLots({
      productVariantId: 200, warehouseLocationId: 99, qty: 1, orderId: 1, orderItemId: 1,
    }));
    await fixture.approveInvoice();
    await fixture.updateFreight();
    const current = await fixture.database().transaction(tx => readSupplierReturnInventoryEvidence(tx, saved.document.id));
    expect(current.lines[0].currentCosts).toEqual({ productMills: 600000, packagingMills: 50000, landedMills: 250000, totalMills: 900000 });
    expect(current.lines[0].costEntries).toHaveLength(5);
    const sale = (await query("SELECT product_total_cost_mills,packaging_total_cost_mills,landed_total_cost_mills FROM oms.order_item_costs WHERE qty>0")).rows;
    expect(sale).toHaveLength(1);
    const soldMills = BigInt(sale[0].product_total_cost_mills) + BigInt(sale[0].packaging_total_cost_mills) + BigInt(sale[0].landed_total_cost_mills);
    expect(soldMills).toBe(BigInt(900000));
    const unallocated = await fixture.database().transaction(async tx => readUnallocatedLotCosts(tx,
      (await tx.execute(sql`SELECT * FROM inventory.inventory_lots`)).rows.map(row => ({ ...row, id: row.id }))));
    const remainingMills = [...unallocated.values()].reduce((sum, value) => sum + value.costs.totalMills, BigInt(0));
    expect(remainingMills).toBe(BigInt(0));
    expect(remainingMills + soldMills + BigInt(current.lines[0].currentCosts.totalMills)).toBe(BigInt(1800000));
    const count = current.lines[0].costEntries.length;
    await fixture.approveInvoice(); await fixture.updateFreight();
    expect((await fixture.database().transaction(tx => readSupplierReturnInventoryEvidence(tx, saved.document.id))).lines[0].costEntries).toHaveLength(count);
    const detail = await createSupplierReturnReader(fixture.database()).detail(saved.document.id, fixture.actorId);
    expect(detail?.lines[0].currentCosts).toEqual(current.lines[0].currentCosts);
    expect(detail?.lines[0].source.costs.totalMills).toBe(550000);
  });

  it("supplier stock return blocks wrong supplier, reservations, freeze and stale preview without mutation", async () => {
    await fixture.receive(); const lotId = await rootLot();
    await expect(fixture.database().transaction(tx => previewSupplierReturnStock(tx, { vendorId: 99, lines: [{ inventoryLotId: lotId, quantity: 1 }] })))
      .rejects.toMatchObject({ code: "SUPPLIER_RETURN_VENDOR_MISMATCH" });
    const reviewed = await preview(lotId);
    await query("UPDATE inventory.inventory_lots SET qty_reserved=2 WHERE id=$1", [lotId]);
    await query("UPDATE inventory.inventory_levels SET reserved_qty=2");
    const reserved = await evidence();
    await expect(preview(lotId)).rejects.toMatchObject({ code: "SUPPLIER_RETURN_RESERVED_OR_UNAVAILABLE" });
    expect(await evidence()).toEqual(reserved);
    await query("UPDATE inventory.inventory_lots SET qty_reserved=1 WHERE id=$1", [lotId]);
    await query("UPDATE inventory.inventory_levels SET reserved_qty=1");
    const changed = await evidence();
    await expect(fixture.database().transaction(tx => recordSupplierReturn(tx, {
      raw: { vendorId: 5, lines: [{ inventoryLotId: lotId, quantity: 1 }], expectedSourceFingerprint: reviewed.sourceFingerprint,
        returnCalendarDate: "2026-09-06", evidenceReference: "Old reviewed collection", reason: "Return previously reviewed stock" },
      actorId: fixture.actorId, at: fixture.at, commandKey: randomUUID(), requestFingerprint: "d".repeat(64),
    }))).rejects.toMatchObject({ code: "SUPPLIER_RETURN_SOURCE_STALE" });
    expect(await evidence()).toEqual(changed);
    await query("UPDATE warehouse.warehouse_locations SET cycle_count_freeze_id=123 WHERE id=99");
    await expect(preview(lotId)).rejects.toMatchObject({ code: "SUPPLIER_RETURN_LOCATION_FROZEN" });
  });

  it("supplier stock return audit failure rolls back physical stock, document, value and publication work", async () => {
    await fixture.receive(); const lotId = await rootLot(); const before = await evidence();
    await query(`CREATE FUNCTION procurement.fail_supplier_return_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='procurement.supplier_return.record' THEN RAISE EXCEPTION 'injected supplier return audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_supplier_return_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION procurement.fail_supplier_return_audit()`);
    try { await expect(record(lotId)).rejects.toThrow("injected supplier return audit failure"); }
    finally { await query("DROP TRIGGER fail_supplier_return_audit ON public.audit_events; DROP FUNCTION procurement.fail_supplier_return_audit()"); }
    expect(await evidence()).toEqual(before);
    expect((await query("SELECT count(*)::int AS count FROM inventory.supplier_return_followups")).rows[0].count).toBe(0);
  });

  it("supplier stock return retries failed availability delivery without another physical return", async () => {
    await fixture.receive(); const saved = await record(await rootLot()); const before = await evidence();
    let calls = 0;
    const worker = new SupplierReturnFollowupService(fixture.database(), async (variantId, trigger) => {
      expect(variantId).toBe(200); expect(trigger).toBe("supplier_return");
      if (++calls === 1) throw new Error("Publication admission temporarily unavailable");
    }, () => fixture.at);
    expect(await worker.recover(saved.document.id, 200)).toBe(false);
    expect((await query("SELECT completed_at FROM inventory.supplier_return_followups")).rows[0].completed_at).toBeNull();
    await worker.recoverPending();
    expect((await query("SELECT completed_at FROM inventory.supplier_return_followups")).rows[0].completed_at).toEqual(fixture.at);
    await worker.recoverPending(); expect(calls).toBe(2);
    expect(await evidence()).toEqual(before);
  });
}
