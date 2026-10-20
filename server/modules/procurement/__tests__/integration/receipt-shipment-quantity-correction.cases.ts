import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type pg from "pg";
import type { AmendmentDatabase } from "../../po-quantity-amendment.repository";
import type { ShipmentTrackingService } from "../../shipment-tracking.service";
import {
  createReceiptShipmentQuantityCorrectionService,
  quantityCorrectionScope,
} from "../../receipt-shipment-quantity-correction.service";
import {
  costFingerprint,
  recordReceiptCostOrigin,
} from "../../../inventory/infrastructure/cost-evidence.repository";
import { quantityCorrectionContextSchema } from "@shared/procurement/receipt-shipment-quantity-correction";

export function registerQuantityCorrectionCases(fixture: {
  pool: () => pg.Pool;
  database: () => AmendmentDatabase;
  shipments: () => ShipmentTrackingService;
  at: Date;
  receive: () => Promise<{ receiptId: number; lineId: number }>;
  transferAndSell: () => Promise<void>;
  approveSupplier: () => Promise<unknown>;
}) {
  const service = () =>
    createReceiptShipmentQuantityCorrectionService(
      fixture.database(),
      fixture.shipments(),
      () => fixture.at,
    );
  const query = (text: string) => fixture.pool().query(text);
  async function prepare(knownOrigin = true) {
    await query(`UPDATE procurement.purchase_order_lines SET order_qty=2000,received_qty=100,status='partially_received' WHERE id=21;
      UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1;
      UPDATE procurement.inbound_shipment_lines SET units_per_variant_snapshot=50 WHERE id=11;
      INSERT INTO procurement.receiving_orders(id,receipt_number,source_type,status,purchase_order_id,inbound_shipment_id)
        VALUES(60,'CORRECTION-RECEIPT','shipment','closed',10,1);
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,inbound_shipment_line_id,product_variant_id,
        sku,expected_qty,received_qty,units_per_variant_snapshot,cost_source_kind)
        VALUES(62,60,21,11,200,'AUDIT-CASE',2,2,50,'purchase_order_line');
      INSERT INTO procurement.po_receipts(purchase_order_id,purchase_order_line_id,receiving_order_id,receiving_line_id,qty_received)
        VALUES(10,21,60,62,100);
      INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,
        purchase_order_id,po_line_id,inbound_shipment_id,receiving_order_id,cost_source,received_at)
        VALUES(501,'CORRECTION-LOT',200,99,2,${knownOrigin ? 2 : 0},10,21,1,60,'po','2026-09-01');
      INSERT INTO inventory.inventory_transactions(transaction_type,product_variant_id,to_location_id,variant_qty_delta,
        inventory_lot_id,receiving_order_id,receiving_line_id,reference_type,reference_id)
        VALUES('receipt',200,99,2,501,60,62,'receiving','60');`);
    if (knownOrigin)
      await fixture.database().transaction((tx) =>
        recordReceiptCostOrigin(
          tx,
          {
            inventoryLotId: 501,
            receivingLineId: 62,
            purchaseOrderLineId: 21,
            inboundShipmentLineId: 11,
            unitsPerVariantSnapshot: 50,
            receivedVariantQty: 2,
          },
          "admin-user",
          fixture.at,
        ),
      );
    await fixture
      .database()
      .transaction((tx) =>
        fixture
          .shipments()
          .updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at),
      );
  }
  async function request() {
    const current = await service().context(11, "admin-user");
    return {
      sourceVersion: current.sourceVersion,
      shippedPieces: 1000,
      receipts: [{ receiptLineId: 62, receivedPieces: 1000 }],
      historicalCostDestination: null,
      reason: "Packing slip confirms 500 pieces per received case",
      evidenceConfirmed: true as const,
    };
  }
  const descriptor = (
    body: unknown,
    key = randomUUID(),
    actorId = "admin-user",
  ) => ({
    ...quantityCorrectionScope(11),
    actorType: "user" as const,
    actorId,
    contractVersion: 1,
    idempotencyKey: key,
    requestHash: costFingerprint(body),
  });
  const snapshot = async () => ({
    receipt: (
      await query("SELECT * FROM procurement.receiving_lines ORDER BY id")
    ).rows,
    po: (
      await query("SELECT * FROM procurement.purchase_order_lines ORDER BY id")
    ).rows,
    shipment: (
      await query(
        "SELECT * FROM procurement.inbound_shipment_lines ORDER BY id",
      )
    ).rows,
    lots: (await query("SELECT * FROM inventory.inventory_lots ORDER BY id"))
      .rows,
    transactions: (
      await query("SELECT * FROM inventory.inventory_transactions ORDER BY id")
    ).rows,
    origin: (
      await query(
        "SELECT * FROM inventory.lot_cost_origins ORDER BY inventory_lot_id",
      )
    ).rows,
    ledger: (
      await query(
        "SELECT * FROM inventory.cost_reconciliation_postings ORDER BY id",
      )
    ).rows,
    audit: (
      await query(
        "SELECT * FROM procurement.receipt_shipment_quantity_amendments ORDER BY id",
      )
    ).rows,
  });
  it("quantity correction previews without writes, approves atomically, and replays the same command", async () => {
    await prepare();
    const before = await snapshot(),
      body = await request();
    const preview = await service().preview(11, body, "admin-user");
    expect(await snapshot()).toEqual(before);
    expect(preview.summary).toMatchObject({
      shipmentPieces: { before: 100, after: 1000 },
      stockUnitChange: 0,
      shipmentChargeCents: { before: 5000, after: 5000 },
      chargePerPiece: { before: "0.500000", after: "0.050000" },
    });
    const input = { ...body, previewVersion: preview.previewVersion },
      command = descriptor(input);
    const result = await service().approve(11, input, "admin-user", command);
    expect(result.httpStatus, JSON.stringify(result.body)).toBe(200);
    const response = quantityCorrectionContextSchema.parse(result.body);
    expect(response.receipts[0]).toMatchObject({
      receivedUnits: 2,
      receivedPieces: 1000,
      piecesPerUnit: 500,
    });
    expect(response.history[0]).toMatchObject({
      sourceVersion: body.sourceVersion,
      approvedBy: expect.any(String),
      reason: body.reason,
    });
    const after = await snapshot();
    expect(after.transactions).toEqual(before.transactions);
    expect(after.origin).toEqual(before.origin);
    expect(
      after.lots.map((lot) => [lot.id, lot.qty_received, lot.qty_on_hand]),
    ).toEqual(
      before.lots.map((lot) => [lot.id, lot.qty_received, lot.qty_on_hand]),
    );
    expect(
      (
        await query(
          "SELECT units_per_variant_snapshot FROM inventory.effective_lot_cost_origins WHERE inventory_lot_id=501",
        )
      ).rows[0].units_per_variant_snapshot,
    ).toBe(500);
    const replay = await service().approve(11, input, "admin-user", command);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(result.body);
    expect(await snapshot()).toEqual(after);
    expect(
      (await service().receiptContext(62, "admin-user")).shippedPieces,
    ).toBe(1000);
    expect(await service().options(10)).toEqual([
      {
        shipmentLineId: 11,
        shipmentNumber: "AUDIT-SHIP",
        sku: "AUDIT-PRODUCT",
        shippedPieces: 1000,
      },
    ]);
    await expect(
      query(
        "UPDATE inventory.lot_cost_origin_amendments SET units_per_variant_snapshot=1",
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      query("TRUNCATE procurement.receipt_shipment_quantity_results"),
    ).rejects.toMatchObject({ code: "55000" });
  });
  it("quantity correction rejects stale evidence and revoked admin authority without partial writes", async () => {
    await prepare();
    const body = await request(),
      preview = await service().preview(11, body, "admin-user");
    await query(
      "UPDATE procurement.inbound_freight_costs SET actual_cents=5001 WHERE id=31",
    );
    const input = { ...body, previewVersion: preview.previewVersion },
      before = await snapshot();
    expect(
      (await service().approve(11, input, "admin-user", descriptor(input)))
        .httpStatus,
    ).toBe(409);
    expect(await snapshot()).toEqual(before);
    const fresh = await request();
    await query("UPDATE identity.users SET active=0 WHERE id='admin-user'");
    await expect(
      service().preview(11, fresh, "admin-user"),
    ).rejects.toMatchObject({ code: "QUANTITY_CORRECTION_ADMIN" });
    expect(await snapshot()).toEqual(before);
  });
  it.each(["lead-user", "custom-user", "scoped-user"])(
    "quantity correction denies %s despite purchasing grants",
    async (actor) => {
      await prepare();
      expect((await service().context(11, actor)).canApprove).toBe(false);
      await expect(
        service().preview(11, await request(), actor),
      ).rejects.toMatchObject({ code: "QUANTITY_CORRECTION_ADMIN" });
    },
  );
  it("quantity correction rolls back all owners on a downstream cost failure", async () => {
    await prepare();
    const body = await request(),
      before = await snapshot();
    const failing = createReceiptShipmentQuantityCorrectionService(
      fixture.database(),
      {
        updateCostsInTransaction: fixture.shipments().updateCostsInTransaction,
        refreshQuantityAllocationInTransaction: async () => {
          throw new Error("Injected cost failure");
        },
      },
      () => fixture.at,
    );
    await expect(failing.preview(11, body, "admin-user")).rejects.toThrow(
      "Injected cost failure",
    );
    expect(await snapshot()).toEqual(before);
    await expect(
      failing.approve(
        11,
        { ...body, previewVersion: "a".repeat(64) },
        "admin-user",
        descriptor(body),
      ),
    ).rejects.toThrow("Injected cost failure");
    expect(await snapshot()).toEqual(before);
  });
  it("quantity correction handles concurrent approvals exactly once", async () => {
    await prepare();
    const body = await request(),
      preview = await service().preview(11, body, "admin-user");
    const input = { ...body, previewVersion: preview.previewVersion };
    const results = await Promise.all([
      service().approve(11, input, "admin-user", descriptor(input)),
      service().approve(11, input, "admin-user", descriptor(input)),
    ]);
    expect(results.map((result) => result.httpStatus).sort()).toEqual([
      200, 409,
    ]);
    expect(
      (
        await query(
          "SELECT count(*)::int AS count FROM procurement.receipt_shipment_quantity_amendments",
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("quantity correction can post explicitly approved historical freight without inventing stock or sales", async () => {
    await prepare(false);
    const body = {
      ...(await request()),
      historicalCostDestination: "historical_cogs" as const,
    };
    const before = await snapshot(),
      preview = await service().preview(11, body, "admin-user");
    expect(preview.summary.historicalCost).toMatchObject({
      requiresDecision: false,
      beforeMills: 0,
      afterMills: 500000,
      destination: "historical_cogs",
    });
    expect(await snapshot()).toEqual(before);
    const input = { ...body, previewVersion: preview.previewVersion };
    const result = await service().approve(
      11,
      input,
      "admin-user",
      descriptor(input),
    );
    expect(result.httpStatus, JSON.stringify(result.body)).toBe(200);
    expect((await snapshot()).transactions).toEqual(before.transactions);
    expect(
      (
        await query(
          "SELECT count(*)::int AS count FROM inventory.cost_reconciliation_postings WHERE destination='historical_cogs'",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await query(
          "SELECT count(*)::int AS count FROM inventory.lot_cost_origins",
        )
      ).rows[0].count,
    ).toBe(0);
    const ledger = (await snapshot()).ledger;
    const next = {
      ...(await request()),
      shippedPieces: 2000,
      receipts: [{ receiptLineId: 62, receivedPieces: 2000 }],
    };
    const repeated = await service().preview(11, next, "admin-user");
    expect(repeated.summary.historicalCost).toMatchObject({
      requiresDecision: false,
      beforeMills: 500000,
      afterMills: 500000,
      destination: "historical_cogs",
    });
    const nextInput = { ...next, previewVersion: repeated.previewVersion };
    expect(
      (
        await service().approve(
          11,
          nextInput,
          "admin-user",
          descriptor(nextInput),
        )
      ).httpStatus,
    ).toBe(200);
    expect(
      (await snapshot()).ledger.filter((row) =>
        ledger.some((original) => original.id === row.id),
      ),
    ).toEqual(ledger);
    expect(
      (
        await query(
          "SELECT sum(delta_mills)::text AS amount FROM inventory.cost_reconciliation_postings WHERE destination='historical_cogs'",
        )
      ).rows,
    ).toEqual([{ amount: "500000" }]);
  });
  it("quantity correction requires the historical accounting decision on the server", async () => {
    await prepare(false);
    const body = await request(),
      before = await snapshot();
    const preview = await service().preview(11, body, "admin-user");
    expect(preview.summary.historicalCost.requiresDecision).toBe(true);
    const input = { ...body, previewVersion: preview.previewVersion };
    expect(
      await service().approve(11, input, "admin-user", descriptor(input)),
    ).toMatchObject({
      httpStatus: 409,
      body: { code: "QUANTITY_CORRECTION_DESTINATION_REQUIRED" },
    });
    expect(await snapshot()).toEqual(before);
  });
  it("quantity correction refreshes open shipment allocation without posting its stale cost snapshot", async () => {
    await prepare();
    await query(
      "UPDATE procurement.inbound_shipments SET status='delivered' WHERE id=1",
    );
    const body = await request();
    const beforeRevisions = (
      await query(
        "SELECT * FROM procurement.cost_source_revisions WHERE component='landed' ORDER BY id",
      )
    ).rows;
    const preview = await service().preview(11, body, "admin-user");
    expect(preview.summary.landedCostCents.after).toBeNull();
    expect(preview.summary.costResults).toContainEqual(
      expect.objectContaining({
        component: "landed",
        status: "review_required",
        issues: [
          {
            code: "SHIPMENT_COST_FINALIZATION_PENDING",
            message: expect.any(String),
          },
        ],
      }),
    );
    const input = { ...body, previewVersion: preview.previewVersion };
    expect(
      (await service().approve(11, input, "admin-user", descriptor(input)))
        .httpStatus,
    ).toBe(200);
    expect(
      (
        await query(
          "SELECT * FROM procurement.cost_source_revisions WHERE component='landed' ORDER BY id",
        )
      ).rows,
    ).toEqual(beforeRevisions);
  });
  it("quantity correction preserves origin gaps and later receipts append beyond the corrected intervals", async () => {
    await prepare();
    await query(`UPDATE procurement.purchase_order_lines SET received_qty=200 WHERE id=21;
      UPDATE procurement.inbound_shipment_lines SET qty_shipped=200 WHERE id=11;
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,inbound_shipment_line_id,product_variant_id,
        sku,expected_qty,received_qty,units_per_variant_snapshot,cost_source_kind)
        VALUES(63,60,21,11,200,'AUDIT-CASE',1,1,50,'purchase_order_line');
      INSERT INTO procurement.po_receipts(purchase_order_id,purchase_order_line_id,receiving_order_id,receiving_line_id,qty_received)
        VALUES(10,21,60,63,50);
      INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,
        purchase_order_id,po_line_id,inbound_shipment_id,receiving_order_id,cost_source,received_at)
        VALUES(502,'CORRECTION-GAP',200,99,1,1,10,21,1,60,'po','2026-09-01');
      INSERT INTO inventory.lot_cost_origins(inventory_lot_id,receiving_line_id,purchase_order_line_id,inbound_shipment_line_id,
        units_per_variant_snapshot,received_variant_qty,purchase_start_base_piece,shipment_start_base_piece,recorded_by,recorded_at)
        VALUES(502,63,21,11,50,1,150,150,'fixture','2026-09-01');`);
    const body = {
      ...(await request()),
      shippedPieces: 1100,
      receipts: [
        { receiptLineId: 62, receivedPieces: 1000 },
        { receiptLineId: 63, receivedPieces: 50 },
      ],
    };
    const preview = await service().preview(11, body, "admin-user");
    const input = { ...body, previewVersion: preview.previewVersion };
    expect(
      (await service().approve(11, input, "admin-user", descriptor(input)))
        .httpStatus,
    ).toBe(200);
    await query(`INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,inbound_shipment_line_id,product_variant_id,
      sku,expected_qty,received_qty,units_per_variant_snapshot,cost_source_kind)
      VALUES(64,60,21,11,200,'AUDIT-CASE',1,1,50,'purchase_order_line');
      INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,
        purchase_order_id,po_line_id,inbound_shipment_id,receiving_order_id,cost_source,received_at)
        VALUES(503,'CORRECTION-LATER',200,99,1,1,10,21,1,60,'po','2026-09-01');`);
    await fixture.database().transaction((tx) =>
      recordReceiptCostOrigin(
        tx,
        {
          inventoryLotId: 503,
          receivingLineId: 64,
          purchaseOrderLineId: 21,
          inboundShipmentLineId: 11,
          unitsPerVariantSnapshot: 50,
          receivedVariantQty: 1,
        },
        "admin-user",
        fixture.at,
      ),
    );
    expect(
      (
        await query(
          "SELECT purchase_start_base_piece::text AS purchase,shipment_start_base_piece::text AS shipment FROM inventory.lot_cost_origins WHERE inventory_lot_id=503",
        )
      ).rows,
    ).toEqual([{ purchase: "1100", shipment: "1100" }]);
  });
  it("quantity correction revalues transferred stock and sold COGS through the real owners", async () => {
    const receipt = await fixture.receive();
    await fixture.transferAndSell();
    await fixture.approveSupplier();
    await query(
      "UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1",
    );
    await fixture
      .database()
      .transaction((tx) =>
        fixture
          .shipments()
          .updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at),
      );
    const soldBefore = (
      await query(
        "SELECT total_cost_mills::text AS total FROM oms.order_item_costs",
      )
    ).rows;
    expect(soldBefore).toEqual([{ total: "900000" }]);
    const before = await snapshot(),
      current = await service().context(11, "admin-user");
    const body = {
      ...(await request()),
      sourceVersion: current.sourceVersion,
      shippedPieces: 200,
      receipts: [{ receiptLineId: receipt.lineId, receivedPieces: 200 }],
    };
    const preview = await service().preview(11, body, "admin-user");
    expect(
      preview.summary.costResults.reduce(
        (sum, row) => sum + row.orderCostDeltaCents,
        0,
      ),
    ).toBe(6500);
    expect(await snapshot()).toEqual(before);
    const input = { ...body, previewVersion: preview.previewVersion };
    const approved = await service().approve(
      11,
      input,
      "admin-user",
      descriptor(input),
    );
    expect(approved.httpStatus, JSON.stringify(approved.body)).toBe(200);
    expect(
      (
        await query(
          "SELECT total_cost_mills::text AS total FROM oms.order_item_costs",
        )
      ).rows,
    ).toEqual([{ total: "1550000" }]);
    expect((await snapshot()).transactions).toEqual(before.transactions);
    expect(
      (
        await query(
          "SELECT total_unit_cost_mills::text AS total FROM inventory.inventory_lots ORDER BY id",
        )
      ).rows,
    ).toEqual([{ total: "1550000" }, { total: "1550000" }]);
    expect((await snapshot()).origin).toEqual(before.origin);
    const posted = await service().context(11, "admin-user");
    expect(
      posted.history[0].summary.costResults.every(
        (row) => row.status === "applied",
      ),
    ).toBe(true);
    const poHistory = (
      await query(
        "SELECT notes FROM procurement.po_status_history WHERE notes LIKE 'Administrator approved receipt%'",
      )
    ).rows;
    expect(poHistory).toHaveLength(1);
  });
}
