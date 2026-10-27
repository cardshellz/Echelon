import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { expect, it } from "vitest";
import type * as schema from "@shared/schema";
import { ReceiveValidationService } from "../../receive-validation.service";
import { RETIRED_RECEIVE_EXCEPTION_KINDS } from "../../receive-warning-policy";
import { receivingUnitVersion } from "../../receiving-unit-contract";
import type { ReceivingService, ReceiveWarningEvaluator, ReceiveWarningReporter } from "../../receiving.service";
import type { PurchasingService } from "../../purchasing.service";
import type { ShipmentTrackingService } from "../../shipment-tracking.service";

const migration = readFileSync(resolve(process.cwd(),
  "migrations/900000035000019280001_retire_obsolete_receive_pack_warnings.sql"), "utf8");

export function registerReceiptConfigurationAuthorityCases(fixture: {
  pool: () => pg.Pool;
  database: () => NodePgDatabase<typeof schema>;
  purchasing: () => PurchasingService;
  shipments: () => ShipmentTrackingService;
  receivingLines: (id: number) => Promise<schema.ReceivingLine[]>;
  receivingWithWarnings: (evaluator: ReceiveWarningEvaluator, reporter: ReceiveWarningReporter) => ReceivingService;
  prepareReceipt: () => Promise<{ receiptId: number; lineId: number }>;
  approveSupplier: () => Promise<unknown>;
  actorId: string;
}) {
  async function owners() {
    const warnings = new ReceiveValidationService(fixture.database());
    const { recordReceiveValidationWarnings } = await import("../../po-exceptions.service");
    return { warnings, receiving: fixture.receivingWithWarnings(warnings, recordReceiveValidationWarnings) };
  }

  it.each([1, 100, 10000])("posts the saved %s-piece configuration through stock, lots, PO totals and exact costs", async packSize => {
    const pool = fixture.pool();
    const pieces = 800000;
    const sku = `AUTH-PACK-${packSize}`;
    await pool.query(`UPDATE procurement.purchase_order_lines SET order_qty=$1,unit_cost_cents=0,unit_cost_mills=10,
      total_product_cost_cents=80000,packaging_cost_cents=8000,line_total_cents=88000,
      expected_receive_variant_id=201,expected_receive_units_per_variant=1,units_per_uom=1 WHERE id=21`, [pieces]);
    await pool.query("UPDATE procurement.inbound_shipment_lines SET qty_shipped=$1 WHERE id=11", [pieces]);
    await pool.query(`INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant,uom_type,is_base_unit)
      VALUES(202,100,$1,'Reviewed receive configuration',$2,'case',false)`, [sku, packSize]);
    const receipt = await fixture.purchasing().createReceiptFromShipment(1, fixture.actorId, { purchaseOrderId: 10,
      receiptUnitSelections: [{ shipmentLineId: 11, productVariantId: 201, unitsPerVariant: 1, expectedBaseQty: pieces }] });
    const { receiving, warnings } = await owners();
    await receiving.open(receipt.id, fixture.actorId);
    let [line] = await fixture.receivingLines(receipt.id);
    await receiving.updateLine(line.id, { receivedQty: pieces, putawayLocationId: 99,
      expectedUnitVersion: receivingUnitVersion(line) }, fixture.actorId);
    [line] = await fixture.receivingLines(receipt.id);
    const saved = await receiving.updateLine(line.id, { productVariantId: 202,
      expectedUnitVersion: receivingUnitVersion(line) }, fixture.actorId);
    const packs = pieces / packSize;
    expect(saved).toMatchObject({ expectedQty: packs, receivedQty: packs, damagedQty: 0,
      productVariantId: 202, unitsPerVariantSnapshot: packSize, sku });
    expect(await warnings.evaluateOrder(receipt.id)).toEqual([]);
    await receiving.close(receipt.id, fixture.actorId);

    expect((await pool.query("SELECT order_qty,received_qty,expected_receive_units_per_variant FROM procurement.purchase_order_lines WHERE id=21")).rows)
      .toEqual([{ order_qty: pieces, received_qty: pieces, expected_receive_units_per_variant: 1 }]);
    expect((await pool.query("SELECT qty_received FROM procurement.po_receipts WHERE receiving_order_id=$1", [receipt.id])).rows)
      .toEqual([{ qty_received: pieces }]);
    expect((await pool.query("SELECT product_variant_id,variant_qty FROM inventory.inventory_levels WHERE product_variant_id=202 AND warehouse_location_id=99")).rows)
      .toEqual([{ product_variant_id: 202, variant_qty: packs }]);
    expect((await pool.query(`SELECT lot.product_variant_id,lot.qty_received,lot.qty_on_hand,origin.units_per_variant_snapshot,
      origin.received_variant_qty,(lot.total_unit_cost_mills*lot.qty_received)::text AS extended_mills
      FROM inventory.inventory_lots lot JOIN inventory.lot_cost_origins origin ON origin.inventory_lot_id=lot.id
      WHERE lot.receiving_order_id=$1`, [receipt.id])).rows)
      .toEqual([{ product_variant_id: 202, qty_received: packs, qty_on_hand: packs,
        units_per_variant_snapshot: packSize, received_variant_qty: packs, extended_mills: "8800000" }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.order_line_costs")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.po_exceptions")).rows[0].count).toBe(0);
    expect(await warnings.evaluateOrder(receipt.id)).toEqual([]);
    await receiving.close(receipt.id, fixture.actorId);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions WHERE receiving_order_id=$1 AND transaction_type='receipt'", [receipt.id])).rows[0].count).toBe(1);
    expect((await pool.query("SELECT received_qty FROM procurement.purchase_order_lines WHERE id=21")).rows[0].received_qty).toBe(pieces);
  });

  it("preserves the saved receive factor through later supplier and shipment cost updates", async () => {
    const pool = fixture.pool();
    const { receiptId, lineId } = await fixture.prepareReceipt();
    await pool.query(`INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant,uom_type,is_base_unit)
      VALUES(202,100,'AUTH-C100','Case of 100',100,'case',false)`);
    const { receiving, warnings } = await owners();
    const [line] = await fixture.receivingLines(receiptId);
    expect(await receiving.updateLine(lineId, { productVariantId: 202, expectedUnitVersion: receivingUnitVersion(line) }, fixture.actorId))
      .toMatchObject({ expectedQty: 1, receivedQty: 1, unitsPerVariantSnapshot: 100, sku: "AUTH-C100" });
    await receiving.close(receiptId, fixture.actorId);
    await fixture.approveSupplier();
    await fixture.shipments().close(1, fixture.actorId);
    expect((await pool.query(`SELECT origin.units_per_variant_snapshot,origin.received_variant_qty,
      lot.po_unit_cost_mills::text AS product,lot.packaging_cost_mills::text AS packaging,
      lot.landed_cost_mills::text AS freight,lot.total_unit_cost_mills::text AS total
      FROM inventory.inventory_lots lot JOIN inventory.lot_cost_origins origin ON origin.inventory_lot_id=lot.id
      WHERE lot.receiving_order_id=$1`, [receiptId])).rows)
      .toEqual([{ units_per_variant_snapshot: 100, received_variant_qty: 1,
        product: "1200000", packaging: "100000", freight: "500000", total: "1800000" }]);
    expect((await pool.query("SELECT received_qty FROM procurement.purchase_order_lines WHERE id=21")).rows[0].received_qty).toBe(100);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.order_line_costs")).rows[0].count).toBe(0);
    expect(await warnings.evaluateOrder(receiptId)).toEqual([]);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.po_exceptions")).rows[0].count).toBe(0);
  });

  it("still records a genuine per-piece cost discrepancy after a valid receiving configuration", async () => {
    const { receiptId, lineId } = await fixture.prepareReceipt();
    const { receiving, warnings } = await owners();
    await receiving.updateLine(lineId, { unitCostMills: 14000 }, fixture.actorId);
    expect(await warnings.evaluateOrder(receiptId)).toMatchObject([{ kind: "cost_variance_soft", receivingLineId: lineId }]);
    await receiving.close(receiptId, fixture.actorId);
    expect((await fixture.pool().query("SELECT kind,status FROM procurement.po_exceptions")).rows)
      .toEqual([{ kind: "receive_cost_variance_soft", status: "open" }]);
  });

  async function legacyExceptions() {
    const pool = fixture.pool();
    await pool.query("ALTER TABLE procurement.po_exceptions DROP CONSTRAINT retired_receive_pack_warnings_archival_only_chk");
    for (const [index, kind] of RETIRED_RECEIVE_EXCEPTION_KINDS.entries()) {
      await pool.query(`INSERT INTO procurement.po_exceptions(po_id,kind,severity,status,title,payload,payload_hash)
        VALUES(10,$1,'warn',$2,'Historical pack comparison','{"receivingLineId":1}',$3)`,
      [kind, index % 2 === 0 ? "open" : "acknowledged", `retired-${index}`]);
    }
    await pool.query(`INSERT INTO procurement.po_exceptions(po_id,kind,severity,status,title,payload_hash)
      VALUES(10,'receive_cost_variance_soft','warn','open','Genuine cost review','cost-review'),
        (10,'receive_uom_disagreement','warn','resolved','Earlier completed review','already-resolved'),
        (10,'receive_base_unit_pack_conflict','warn','dismissed','Earlier dismissal','already-dismissed')`);
    return (await pool.query("SELECT * FROM procurement.po_exceptions ORDER BY id")).rows;
  }

  it("retires only obsolete active warnings with an idempotent audit and prevents older workers reopening them", async () => {
    const pool = fixture.pool();
    const before = await legacyExceptions();
    await pool.query(migration);
    const after = (await pool.query("SELECT * FROM procurement.po_exceptions ORDER BY id")).rows;
    expect(after.slice(4)).toEqual(before.slice(4));
    for (const exception of after.slice(0, 4)) {
      expect(exception).toMatchObject({ status: "dismissed", dismissed_by: "system:receipt-config-authority" });
      expect(exception.dismiss_note).toContain("No quantity, cost or financial approval was changed");
    }
    const audits = (await pool.query("SELECT notes::jsonb AS event FROM procurement.po_status_history ORDER BY id")).rows;
    expect(audits).toHaveLength(4);
    for (const { event } of audits) {
      expect(event).toMatchObject({ action: "retire_obsolete_receive_pack_warning", actor: "system:receipt-config-authority",
        after: { status: "dismissed" } });
      expect(["open", "acknowledged"]).toContain(event.before.status);
    }
    await pool.query(migration);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.po_status_history")).rows[0].count).toBe(4);
    await expect(pool.query(`INSERT INTO procurement.po_exceptions(po_id,kind,severity,status,title,payload_hash)
      VALUES(10,'receive_uom_disagreement','warn','open','Old worker retry','old-worker')`))
      .rejects.toMatchObject({ constraint: "retired_receive_pack_warnings_archival_only_chk" });
    expect((await pool.query("SELECT order_qty,received_qty FROM procurement.purchase_order_lines WHERE id=21")).rows)
      .toEqual([{ order_qty: 200, received_qty: 0 }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_lots")).rows[0].count).toBe(0);
  });

  it("rolls back warning retirement when its audit cannot be recorded", async () => {
    const pool = fixture.pool();
    const before = await legacyExceptions();
    const client = await pool.connect();
    try {
      await client.query(`CREATE FUNCTION procurement.reject_retirement_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF strpos(COALESCE(NEW.notes,''),'retire_obsolete_receive_pack_warning')>0 THEN
          RAISE EXCEPTION 'retirement audit unavailable'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_retirement_audit BEFORE INSERT ON procurement.po_status_history
        FOR EACH ROW EXECUTE FUNCTION procurement.reject_retirement_audit()`);
      await expect(client.query(migration)).rejects.toThrow("retirement audit unavailable");
      await client.query("ROLLBACK");
      expect((await client.query("SELECT * FROM procurement.po_exceptions ORDER BY id")).rows).toEqual(before);
      expect((await client.query("SELECT count(*)::int AS count FROM procurement.po_status_history")).rows[0].count).toBe(0);
    } finally {
      try {
        await client.query("ROLLBACK");
        await client.query("DROP TRIGGER IF EXISTS reject_retirement_audit ON procurement.po_status_history; DROP FUNCTION IF EXISTS procurement.reject_retirement_audit()");
        await client.query(migration);
      } finally {
        client.release();
      }
    }
  });
}
