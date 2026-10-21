import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type pg from "pg";
import type { AmendmentDatabase } from "../../po-quantity-amendment.repository";
import type { ShipmentTrackingService } from "../../shipment-tracking.service";
import {
  createReceiptShipmentQuantityCorrectionService,
  quantityCorrectionScope,
} from "../../receipt-shipment-quantity-correction.service";
import { costFingerprint } from "../../../inventory/infrastructure/cost-evidence-values";
import {
  readUnresolvedCostQuantities,
  restoreHistoricalCostAllocation,
  ensureLotCostQuantityBasis,
} from "../../../inventory/infrastructure/cost-quantity.repository";
import { sql } from "drizzle-orm";
import { costForQuantityIntervals } from "../../../inventory/domain/cost-quantity-intervals";
import { readPurchaseCostStatus } from "../../purchase-cost-status.repository";

export function registerCostLinkRepairCases(fixture: {
  pool: () => pg.Pool;
  database: () => AmendmentDatabase;
  shipments: () => ShipmentTrackingService;
  at: Date;
  prepare: (known?: boolean, pieces?: number, units?: number) => Promise<void>;
}) {
  const query = (text: string) => fixture.pool().query(text);
  const service = () =>
    createReceiptShipmentQuantityCorrectionService(
      fixture.database(),
      fixture.shipments(),
      () => fixture.at,
    );
  async function prepare(gap = 0) {
    await fixture.prepare(false, 20000, 20);
    await query(`UPDATE procurement.purchase_order_lines SET order_qty=200000 WHERE id=21;
      UPDATE procurement.inbound_shipment_lines SET qty_shipped=20000,carton_count=20,dimension_basis='carton' WHERE id=11;
      UPDATE procurement.receiving_lines SET units_per_variant_snapshot=NULL,cost_source_kind=NULL WHERE id=62;
      UPDATE procurement.inbound_freight_costs SET actual_cents=129838 WHERE id=31;
      UPDATE inventory.inventory_lots SET created_at='2026-07-23 10:00:00' WHERE id=501;
      UPDATE inventory.inventory_transactions SET created_at='2026-07-23 10:00:00' WHERE inventory_lot_id=501;
      UPDATE catalog.product_variants SET units_per_variant=10000 WHERE id=200;
      UPDATE catalog.product_variants SET units_per_variant=100 WHERE id=201;
      INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant,uom_type,is_base_unit)
        VALUES(202,100,'AUDIT-CASE-10000','Correct case SKU',10000,'case',false);
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(100,1,'STORAGE'),(101,1,'PICK');
      INSERT INTO inventory.cycle_counts(id,name,status,warehouse_id) VALUES(1,'Case SKU correction','completed',1),(2,'Pack count correction','completed',1);
      INSERT INTO inventory.cycle_count_items(cycle_count_id,warehouse_location_id,product_variant_id,variance_qty,status,approved_by,approved_at)
        VALUES(1,100,200,-19,'approved','admin-user','2026-07-23 10:00:03'),(1,100,202,19,'approved','admin-user','2026-07-23 10:00:03'),
        (2,101,201,90,'approved','admin-user','2026-07-23 10:00:04');
      INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,cost_source,created_at,received_at)
        VALUES(502,'TRANSFER-LOT',200,100,20,0,'po','2026-07-23 10:00:01','2026-07-23'),
        (503,'TEN-PACKS',201,101,10,0,'po','2026-07-23 10:00:02','2026-07-23'),
        (504,'NINETEEN-CASES',202,100,19,19,'po','2026-07-23 10:00:03','2026-07-23'),
        (505,'NINETY-PACKS',201,101,90,0,'po','2026-07-23 10:00:04','2026-07-23');
      INSERT INTO inventory.inventory_transactions(id,transaction_type,product_variant_id,variant_qty_delta,from_location_id,to_location_id,created_at,notes,cycle_count_id)
        VALUES(801,'transfer',200,20,99,100,'2026-07-23 10:00:01','Transfer',NULL),
        (802,'adjustment',200,-1,100,NULL,'2026-07-23 10:00:02','Case break: case to packs',NULL),
        (803,'adjustment',201,10,NULL,101,'2026-07-23 10:00:02','Repacked output',NULL),
        (804,'adjustment',200,-19,100,NULL,'2026-07-23 10:00:03','Count correction',1),
        (805,'adjustment',202,19,NULL,100,'2026-07-23 10:00:03','Count correction',1),
        (806,'adjustment',201,90,NULL,101,'2026-07-23 10:00:04','Count correction',2);
      UPDATE wms.orders SET warehouse_status='shipped' WHERE id=1;
      INSERT INTO oms.order_item_costs(order_id,order_item_id,inventory_lot_id,product_variant_id,qty,unit_cost_cents,total_cost_cents)
        VALUES(1,1,503,201,10,0,0),(1,1,505,201,${90 - gap},0,0);`);
  }
  async function input() {
    return {
      sourceVersion: (await service().context(11, "admin-user")).sourceVersion,
      shippedPieces: 200000,
      receipts: [{ receiptLineId: 62, receivedPieces: 200000 }],
      repairCostLinks: true as const,
      historicalCostDestination: null,
      reason:
        "Verified the receipt, transfer, case break and approved count records",
      evidenceConfirmed: true as const,
    };
  }
  const descriptor = (body: unknown, key = randomUUID()) => ({
    ...quantityCorrectionScope(11),
    actorType: "user" as const,
    actorId: "admin-user",
    contractVersion: 1,
    idempotencyKey: key,
    requestHash: costFingerprint(body),
  });
  const physical = async () => ({
    lots: (
      await query(
        "SELECT id,qty_received,qty_on_hand,qty_consumed FROM inventory.inventory_lots ORDER BY id",
      )
    ).rows,
    transactions: (
      await query("SELECT * FROM inventory.inventory_transactions ORDER BY id")
    ).rows,
    orderQuantities: (
      await query(
        "SELECT id,order_id,order_item_id,inventory_lot_id,qty FROM oms.order_item_costs ORDER BY id",
      )
    ).rows,
  });
  const financial = async () => ({
    lots: (await query("SELECT * FROM inventory.inventory_lots ORDER BY id"))
      .rows,
    origins: (
      await query(
        "SELECT * FROM inventory.lot_cost_origins ORDER BY inventory_lot_id",
      )
    ).rows,
    links: (
      await query("SELECT * FROM inventory.lot_cost_contributions ORDER BY id")
    ).rows,
    allocations: (
      await query(
        "SELECT * FROM inventory.lot_cost_quantity_allocations ORDER BY id",
      )
    ).rows,
    expenses: (
      await query(
        "SELECT * FROM inventory.cost_reconciliation_postings ORDER BY id",
      )
    ).rows,
    orders: (await query("SELECT * FROM oms.order_item_costs ORDER BY id"))
      .rows,
    audits: (
      await query(
        "SELECT * FROM procurement.receipt_shipment_quantity_amendments ORDER BY id",
      )
    ).rows,
  });
  it("cost-link repair previews and posts receipt, transfer and split-repacking costs in one approval without an expense", async () => {
    await prepare();
    const body = await input(),
      before = await financial(),
      stock = await physical();
    const preview = await service().preview(11, body, "admin-user");
    expect(await financial()).toEqual(before);
    expect(await physical()).toEqual(stock);
    expect(preview.summary.costLinkRepair).toMatchObject({
      originsRestored: [{ lotId: 501, piecesPerUnit: 10000 }],
      operations: expect.any(Array),
      remainingIssues: [],
      stockUnitChange: 0,
      newExpensePostings: 0,
    });
    expect(
      preview.summary.costLinkRepair?.operations.map((row) => row.movementIds),
    ).toEqual([[801], [802, 803, 806], [804, 805]]);
    expect(
      preview.summary.costResults.every((row) => row.status === "applied"),
    ).toBe(true);
    const approved = {
      ...body,
      previewVersion: preview.previewVersion,
      costLinksConfirmed: true as const,
    };
    const key = descriptor(approved),
      result = await service().approve(11, approved, "admin-user", key);
    expect(result.httpStatus).toBe(200);
    expect(await physical()).toEqual(stock);
    const saved = await financial();
    expect(saved.expenses).toEqual([]);
    expect(saved.origins).toHaveLength(1);
    expect(saved.links).toHaveLength(4);
    expect(
      saved.lots
        .filter((row) => [503, 504, 505].includes(row.id))
        .reduce(
          (sum, row) => sum + BigInt(row.landed_total_cost_mills),
          BigInt(0),
        ),
    ).toBe(BigInt(12983800));
    expect(saved.orders.every((row) => Number(row.total_cost_cents) > 0)).toBe(
      true,
    );
    expect(
      saved.audits[0].evidence.costLinkRepairEvidence.movements,
    ).toHaveLength(7);
    expect(
      (await service().context(11, "admin-user")).history[0].summary,
    ).toEqual(preview.summary);
    expect(
      (await service().approve(11, approved, "admin-user", key)).replayed,
    ).toBe(true);
    expect(await financial()).toEqual(saved);
    expect(
      await fixture
        .database()
        .transaction((tx) => readUnresolvedCostQuantities(tx, 501)),
    ).toEqual([]);
    expect(
      await fixture
        .database()
        .transaction((tx) => readUnresolvedCostQuantities(tx, 502)),
    ).toEqual([]);
    const status = await fixture
      .database()
      .transaction((tx) => readPurchaseCostStatus(tx, [21]));
    expect(JSON.stringify(status)).not.toContain(
      "COST_HISTORICAL_LINEAGE_MISSING",
    );
  });
  it("cost-link repair prices known stock and order destinations while retaining an unsupported 3-pack gap", async () => {
    await prepare(3);
    const body = await input(),
      preview = await service().preview(11, body, "admin-user");
    expect(preview.summary.costLinkRepair?.remainingIssues).toHaveLength(1);
    expect(preview.summary.costLinkRepair?.remainingIssues[0]).toContain(
      "3 AUDIT-EACH units",
    );
    expect(
      preview.summary.costResults
        .flatMap((row) => row.issues)
        .filter((issue) => issue.code === "COST_UNRESOLVED_QUANTITY_RETAINED"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ costLinksAlreadyReviewed: true }),
      ]),
    );
    expect(
      preview.summary.costResults.find((row) => row.component === "landed")
        ?.lotsUpdated,
    ).toBe(5);
    const approved = {
      ...body,
      previewVersion: preview.previewVersion,
      costLinksConfirmed: true as const,
    };
    expect(
      (
        await service().approve(
          11,
          approved,
          "admin-user",
          descriptor(approved),
        )
      ).httpStatus,
    ).toBe(200);
    expect((await financial()).expenses).toEqual([]);
    expect(
      (
        await fixture
          .database()
          .transaction((tx) => readUnresolvedCostQuantities(tx, 505))
      )[0].snapshot.unresolvedQuantity,
    ).toBe(3);
  });
  it("cost-link repair rejects changed unlinked history without partially saving quantities or costs", async () => {
    await prepare();
    const body = await input(),
      preview = await service().preview(11, body, "admin-user");
    await query(
      "UPDATE inventory.inventory_transactions SET voided_at='2026-09-01' WHERE id=806",
    );
    const before = await financial(),
      stock = await physical();
    const approved = {
      ...body,
      previewVersion: preview.previewVersion,
      costLinksConfirmed: true as const,
    };
    expect(
      (
        await service().approve(
          11,
          approved,
          "admin-user",
          descriptor(approved),
        )
      ).httpStatus,
    ).toBe(409);
    expect(await financial()).toEqual(before);
    expect(await physical()).toEqual(stock);
    expect(
      (
        await query(
          "SELECT qty_shipped FROM procurement.inbound_shipment_lines WHERE id=11",
        )
      ).rows[0].qty_shipped,
    ).toBe(20000);
  });
  it("cost-link repair requires explicit confirmation and an active purchasing administrator", async () => {
    await prepare();
    const body = await input(),
      preview = await service().preview(11, body, "admin-user");
    const approved = { ...body, previewVersion: preview.previewVersion };
    await expect(
      service().approve(11, approved, "admin-user", descriptor(approved)),
    ).rejects.toThrow("Confirm the transfer");
    await expect(
      service().preview(11, body, "lead-user"),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await financial()).links).toEqual([]);
  });
  it("cost-link repair preserves cancelled-order COGS until a recorded sale is verified, including later cost updates", async () => {
    await prepare();
    await query(
      "UPDATE wms.orders SET warehouse_status='cancelled' WHERE id=1",
    );
    const body = await input(),
      preview = await service().preview(11, body, "admin-user");
    expect(
      preview.summary.costResults.every((row) => row.orderCostsUpdated === 0),
    ).toBe(true);
    expect(
      preview.summary.costLinkRepair?.remainingIssues.some((row) =>
        row.includes("cancelled order"),
      ),
    ).toBe(true);
    const approved = {
      ...body,
      previewVersion: preview.previewVersion,
      costLinksConfirmed: true as const,
    };
    expect(
      (
        await service().approve(
          11,
          approved,
          "admin-user",
          descriptor(approved),
        )
      ).httpStatus,
    ).toBe(200);
    expect(
      (await financial()).orders.every(
        (row) => Number(row.total_cost_cents) === 0,
      ),
    ).toBe(true);
    await fixture
      .database()
      .transaction((tx) =>
        fixture
          .shipments()
          .updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at),
      );
    expect(
      (await financial()).orders.every(
        (row) => Number(row.total_cost_cents) === 0,
      ),
    ).toBe(true);
    await query("UPDATE wms.orders SET warehouse_status='shipped' WHERE id=1");
    await fixture
      .database()
      .transaction((tx) =>
        fixture
          .shipments()
          .updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at),
      );
    expect(
      (await financial()).orders.every(
        (row) => Number(row.total_cost_cents) > 0,
      ),
    ).toBe(true);
    expect((await financial()).expenses).toEqual([]);
  });
  it("cost-link repair requires recorded outbound coverage for a completed picking order", async () => {
    await prepare();
    await query(
      "UPDATE wms.orders SET warehouse_status='completed' WHERE id=1; UPDATE wms.order_items SET quantity=100 WHERE id=1",
    );
    const body = await input();
    expect(
      (
        await service().preview(11, body, "admin-user")
      ).summary.costResults.every((row) => row.orderCostsUpdated === 0),
    ).toBe(true);
    await query(`INSERT INTO wms.outbound_shipments(id,order_id,status) VALUES(1,1,'shipped');
      INSERT INTO wms.outbound_shipment_items(shipment_id,order_item_id,product_variant_id,qty) VALUES(1,1,201,99)`);
    expect(
      (
        await service().preview(11, body, "admin-user")
      ).summary.costResults.every((row) => row.orderCostsUpdated === 0),
    ).toBe(true);
    await query(
      "UPDATE wms.outbound_shipment_items SET qty=100 WHERE shipment_id=1",
    );
    const preview = await service().preview(11, body, "admin-user");
    expect(
      preview.summary.costResults.some((row) => row.orderCostsUpdated > 0),
    ).toBe(true);
    const approved = {
      ...body,
      previewVersion: preview.previewVersion,
      costLinksConfirmed: true as const,
    };
    expect(
      (
        await service().approve(
          11,
          approved,
          "admin-user",
          descriptor(approved),
        )
      ).httpStatus,
    ).toBe(200);
    expect(
      (await financial()).orders.every(
        (row) => Number(row.total_cost_cents) > 0,
      ),
    ).toBe(true);
    expect((await financial()).expenses).toEqual([]);
  });
  it("cost-link repair serializes competing approvals so only one can add custody or recost", async () => {
    await prepare();
    const body = await input(),
      preview = await service().preview(11, body, "admin-user");
    const approved = {
      ...body,
      previewVersion: preview.previewVersion,
      costLinksConfirmed: true as const,
    };
    const results = await Promise.all([
      service().approve(11, approved, "admin-user", descriptor(approved)),
      service().approve(11, approved, "admin-user", descriptor(approved)),
    ]);
    expect(results.map((row) => row.httpStatus).sort()).toEqual([200, 409]);
    expect((await financial()).links).toHaveLength(4);
    expect((await financial()).audits).toHaveLength(1);
  });
  it("cost-link repair supports the full 23-lot shape, preserves existing split operations, and accounts for every shipment-cost mill", async () => {
    await prepare(3);
    await query(
      "UPDATE inventory.inventory_lots SET qty_on_hand=0 WHERE id=504",
    );
    // Eleven old case breaks are missing their links; five later operations
    // already have seven output layers, including two split-output operations.
    for (let index = 0; index < 16; index++) {
      const at = `2026-08-${String(index + 1).padStart(2, "0")} 10:00:00`;
      const outputs =
        index < 14
          ? [{ id: 600 + index, quantity: 100, onHand: 0 }]
          : index === 14
            ? [
                { id: 614, quantity: 59, onHand: 0 },
                { id: 615, quantity: 41, onHand: 41 },
              ]
            : [
                { id: 616, quantity: 2, onHand: 0 },
                { id: 617, quantity: 98, onHand: 10 },
              ];
      if (index < 11)
        await query(`INSERT INTO inventory.inventory_transactions(transaction_type,product_variant_id,variant_qty_delta,from_location_id,to_location_id,created_at,notes)
        VALUES('adjustment',202,-1,100,NULL,'${at}','Case break: recorded'),('adjustment',201,100,NULL,101,'${at}','Pack output');`);
      let offset = 0;
      for (const output of outputs) {
        await query(`INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,cost_source,created_at,received_at)
          VALUES(${output.id},'PACK-${output.id}',201,101,${output.quantity},${output.onHand},'po','${at}','${at}');`);
        if (index >= 11)
          await query(`INSERT INTO inventory.lot_cost_contributions(source_lot_id,output_lot_id,source_qty,output_qty,output_start_qty,operation_key,operation_kind,recorded_by,recorded_at)
          VALUES(504,${output.id},1,100,${offset},'existing_case:${index}','conversion','admin-user','${at}');`);
        const sold =
          output.quantity -
          output.onHand -
          (index === 0 ? 15 : index === 1 ? 8 : 0);
        if (sold)
          await query(`INSERT INTO oms.order_item_costs(order_id,order_item_id,inventory_lot_id,product_variant_id,qty,unit_cost_cents,total_cost_cents)
          VALUES(1,1,${output.id},201,${sold},0,0);`);
        offset += output.quantity;
      }
    }
    const existingLinks = (await financial()).links,
      stock = await physical(),
      body = await input();
    const preview = await service().preview(11, body, "admin-user");
    expect(preview.summary.costLinkRepair?.operations).toHaveLength(14);
    expect(preview.summary.costLinkRepair?.lots).toHaveLength(23);
    expect(preview.summary.costLinkRepair?.remainingIssues).toHaveLength(4);
    const approved = {
      ...body,
      previewVersion: preview.previewVersion,
      costLinksConfirmed: true as const,
    };
    expect(
      (
        await service().approve(
          11,
          approved,
          "admin-user",
          descriptor(approved),
        )
      ).httpStatus,
    ).toBe(200);
    expect(await physical()).toEqual(stock);
    const saved = await financial();
    expect(saved.links).toHaveLength(22);
    expect(saved.expenses).toEqual([]);
    expect(
      saved.links.filter((row) =>
        row.operation_key.startsWith("existing_case:"),
      ),
    ).toEqual(existingLinks);
    const terminal = saved.lots.filter(
      (row) => row.id === 503 || row.id === 505 || row.id >= 600,
    );
    const caseLot = saved.lots.find((row) => row.id === 504)!;
    const held = await fixture.database().transaction(async (tx) => {
      const entries = await readUnresolvedCostQuantities(tx, 504);
      expect(entries[0].snapshot.unresolvedQuantity).toBe(3);
      return costForQuantityIntervals(
        BigInt(caseLot.landed_total_cost_mills),
        19,
        entries[0].intervals,
      );
    });
    expect(
      terminal.reduce(
        (sum, row) => sum + BigInt(row.landed_total_cost_mills),
        held,
      ),
    ).toBe(BigInt(12983800));
    expect(
      (await service().context(11, "admin-user")).history[0].summary,
    ).toEqual(preview.summary);
  });
  it("cost-link repair can restore a previous unresolved cost hold after quantities were already corrected", async () => {
    await prepare();
    const { repairCostLinks: _, ...quantityOnly } = await input();
    const preview = await service().preview(11, quantityOnly, "admin-user");
    const approved = {
      ...quantityOnly,
      previewVersion: preview.previewVersion,
    };
    expect(
      (
        await service().approve(
          11,
          approved,
          "admin-user",
          descriptor(approved),
        )
      ).httpStatus,
    ).toBe(200);
    await fixture.database().transaction(async (tx) => {
      const lot = (
        await tx.execute(
          sql`SELECT * FROM inventory.inventory_lots WHERE id=501`,
        )
      ).rows[0];
      await ensureLotCostQuantityBasis(
        tx,
        { ...lot, id: 501 },
        "admin-user",
        fixture.at,
        {
          retainUnresolvedQuantity: true,
          verifyOnHand: true,
        },
      );
    });
    const held = (await financial()).allocations;
    const body = await input(),
      repairPreview = await service().preview(11, body, "admin-user");
    expect(repairPreview.summary.shipmentPieces).toEqual({
      before: 200000,
      after: 200000,
    });
    const laterService = createReceiptShipmentQuantityCorrectionService(
      fixture.database(),
      fixture.shipments(),
      () => new Date(fixture.at.getTime() + 60000),
    );
    const repair = {
      ...body,
      previewVersion: repairPreview.previewVersion,
      costLinksConfirmed: true as const,
    };
    expect(
      (await laterService.approve(11, repair, "admin-user", descriptor(repair)))
        .httpStatus,
    ).toBe(200);
    expect(
      (await financial()).allocations.filter((row) =>
        held.some((old) => old.id === row.id),
      ),
    ).toEqual(held);
    expect(
      await fixture
        .database()
        .transaction((tx) => readUnresolvedCostQuantities(tx, 501)),
    ).toEqual([]);
    expect((await financial()).expenses).toEqual([]);
  });
  it("historical financial custody releases only the approved amount and rejects reuse, changed evidence and invalid quantities", async () => {
    await prepare();
    const restore = (
      quantity: number,
      key = "test-repair",
      evidence = { movementId: 801 },
    ) =>
      fixture
        .database()
        .transaction((tx) =>
          restoreHistoricalCostAllocation(
            tx,
            501,
            quantity,
            key,
            evidence,
            "admin-user",
            fixture.at,
          ),
        );
    const id = await restore(5);
    expect(
      (
        await fixture
          .database()
          .transaction((tx) => readUnresolvedCostQuantities(tx, 501))
      )[0].snapshot.unresolvedQuantity,
    ).toBe(15);
    const before = await financial();
    expect(await restore(5)).toBe(id);
    expect(await financial()).toEqual(before);
    await expect(
      restore(5, "test-repair", { movementId: 802 }),
    ).rejects.toThrow("different cost evidence");
    await expect(restore(16, "too-many")).rejects.toThrow("reuse costs");
    await expect(restore(0, "zero")).rejects.toThrow();
    await expect(restore(-1, "negative")).rejects.toThrow();
    expect(await financial()).toEqual(before);
  });
}
