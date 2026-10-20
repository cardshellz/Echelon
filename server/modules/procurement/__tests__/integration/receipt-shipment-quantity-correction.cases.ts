import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
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
  const service = (purpose: "receipt" | "shipment" = "receipt") =>
    createReceiptShipmentQuantityCorrectionService(
      fixture.database(),
      fixture.shipments(),
      () => fixture.at,
      purpose,
    );
  const query = (text: string) => fixture.pool().query(text);
  async function prepare(
    knownOrigin = true,
    receivedPieces = 100,
    receivedUnits = 2,
  ) {
    await query(`UPDATE procurement.purchase_order_lines SET order_qty=${Math.max(2000, receivedPieces)},received_qty=${receivedPieces},status='partially_received' WHERE id=21;
      UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1;
      UPDATE procurement.inbound_shipment_lines SET units_per_variant_snapshot=50 WHERE id=11;
      INSERT INTO procurement.receiving_orders(id,receipt_number,source_type,status,purchase_order_id,inbound_shipment_id)
        VALUES(60,'CORRECTION-RECEIPT','shipment','closed',10,1);
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,inbound_shipment_line_id,product_variant_id,
        sku,expected_qty,received_qty,units_per_variant_snapshot,cost_source_kind)
        VALUES(62,60,21,11,200,'AUDIT-CASE',${receivedUnits},${receivedUnits},${receivedPieces / receivedUnits},'purchase_order_line');
      INSERT INTO procurement.po_receipts(purchase_order_id,purchase_order_line_id,receiving_order_id,receiving_line_id,qty_received)
        VALUES(10,21,60,62,${receivedPieces});
      INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,
        purchase_order_id,po_line_id,inbound_shipment_id,receiving_order_id,cost_source,received_at)
        VALUES(501,'CORRECTION-LOT',200,99,${receivedUnits},${knownOrigin ? receivedUnits : 0},10,21,1,60,'po','2026-09-01');
      INSERT INTO inventory.inventory_transactions(transaction_type,product_variant_id,to_location_id,variant_qty_delta,
        inventory_lot_id,receiving_order_id,receiving_line_id,reference_type,reference_id)
        VALUES('receipt',200,99,${receivedUnits},501,60,62,'receiving','60');`);
    if (knownOrigin)
      await fixture.database().transaction((tx) =>
        recordReceiptCostOrigin(
          tx,
          {
            inventoryLotId: 501,
            receivingLineId: 62,
            purchaseOrderLineId: 21,
            inboundShipmentLineId: 11,
            unitsPerVariantSnapshot: receivedPieces / receivedUnits,
            receivedVariantQty: receivedUnits,
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
  const shipmentDescriptor = (body: unknown, key = randomUUID()) => ({
    ...descriptor(body, key),
    ...quantityCorrectionScope(11, "shipment"),
  });
  async function shipmentRequest(shippedPieces = 1000) {
    const current = await service("shipment").context(11, "admin-user");
    return {
      sourceVersion: current.sourceVersion,
      shippedPieces,
      historicalCostDestination: null,
      reason: "Verified shipped pieces against the original packing list",
      evidenceConfirmed: true as const,
    };
  }
  it("combined shipment entry corrects both 20,000-piece records to 200,000 with one exact cost and audit transaction", async () => {
    await prepare(true, 20000, 20);
    await query(`UPDATE procurement.purchase_order_lines SET order_qty=200000 WHERE id=21;
      UPDATE procurement.inbound_shipment_lines SET qty_shipped=20000,carton_count=20,dimension_basis='carton' WHERE id=11;
      UPDATE procurement.receiving_lines SET units_per_variant_snapshot=NULL WHERE id=62;
      UPDATE procurement.inbound_freight_costs SET actual_cents=129838 WHERE id=31`);
    await fixture
      .database()
      .transaction((tx) =>
        fixture
          .shipments()
          .updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at),
      );
    const shipmentContext = await service("shipment").context(11, "admin-user");
    // Both entry points fingerprint the same locked source graph. Opting into
    // receipt correction must not silently rebase or use a different authority.
    expect(shipmentContext.sourceVersion).toBe(
      (await service().context(11, "admin-user")).sourceVersion,
    );
    const body = {
      ...(await request()),
      sourceVersion: shipmentContext.sourceVersion,
      shippedPieces: 200000,
      receipts: [{ receiptLineId: 62, receivedPieces: 200000 }],
    };
    const invoicesBefore = (
      await query(
        "SELECT id,qty_invoiced,line_total_cents FROM procurement.vendor_invoice_lines ORDER BY id",
      )
    ).rows;
    const before = await snapshot();
    const preview = await service().preview(11, body, "admin-user");
    expect(await snapshot()).toEqual(before);
    expect(preview.summary).toMatchObject({
      purpose: "receipt",
      shipmentPieces: { before: 20000, after: 200000 },
      poReceivedPieces: { before: 20000, after: 200000 },
      poRemainingPieces: { before: 180000, after: 0 },
      shipmentChargeCents: { before: 129838, after: 129838 },
      chargePerPiece: { before: "0.064919", after: "0.006492" },
      stockUnitChange: 0,
    });
    expect(preview.summary.receipts).toEqual([
      expect.objectContaining({
        receivedUnits: 20,
        receivedPieces: 20000,
        afterPieces: 200000,
        piecesPerUnit: 1000,
        afterPiecesPerUnit: 10000,
        unitWasRecorded: false,
      }),
    ]);
    const input = { ...body, previewVersion: preview.previewVersion },
      command = descriptor(input);
    const approved = await service().approve(11, input, "admin-user", command);
    expect(approved.httpStatus, JSON.stringify(approved.body)).toBe(200);
    const after = await snapshot();
    expect(after.receipt[0]).toMatchObject({
      received_qty: 20,
      expected_qty: 20,
      units_per_variant_snapshot: 10000,
    });
    expect(after.shipment[0]).toMatchObject({
      qty_shipped: 200000,
      carton_count: 20,
      units_per_variant_snapshot: 10000,
    });
    expect(after.po[0]).toMatchObject({
      order_qty: 200000,
      received_qty: 200000,
      status: "received",
    });
    expect(after.transactions).toEqual(before.transactions);
    expect(after.origin).toEqual(before.origin);
    expect(
      after.lots.map((row) => [row.id, row.qty_received, row.qty_on_hand]),
    ).toEqual(
      before.lots.map((row) => [row.id, row.qty_received, row.qty_on_hand]),
    );
    expect(after.audit).toHaveLength(1);
    expect(
      (
        await query(
          "SELECT qty_received FROM procurement.po_receipts WHERE receiving_line_id=62",
        )
      ).rows,
    ).toEqual([{ qty_received: 200000 }]);
    expect(
      (
        await query(
          "SELECT total_pieces FROM procurement.inbound_shipments WHERE id=1",
        )
      ).rows,
    ).toEqual([{ total_pieces: 200000 }]);
    expect(
      (
        await query(
          "SELECT units_per_variant_snapshot FROM inventory.effective_lot_cost_origins WHERE inventory_lot_id=501",
        )
      ).rows,
    ).toEqual([{ units_per_variant_snapshot: 10000 }]);
    expect(
      (
        await query(
          "SELECT landed_total_cost_mills::text AS amount FROM inventory.inventory_lots WHERE id=501",
        )
      ).rows,
    ).toEqual([{ amount: "12983800" }]);
    expect(
      (
        await query(
          "SELECT id,qty_invoiced,line_total_cents FROM procurement.vendor_invoice_lines ORDER BY id",
        )
      ).rows,
    ).toEqual(invoicesBefore);
    for (const readback of [
      await service("shipment").context(11, "admin-user"),
      await service().receiptContext(62, "admin-user"),
    ]) {
      expect(readback.shippedPieces).toBe(200000);
      expect(readback.receipts[0].receivedPieces).toBe(200000);
      expect(readback.history).toHaveLength(1);
      expect(readback.history[0].summary).toEqual(preview.summary);
    }
    for (const table of [
      "po_status_history",
      "inbound_shipment_status_history",
    ]) {
      expect(
        (
          await query(
            `SELECT notes FROM procurement.${table} WHERE notes LIKE 'Administrator approved receipt and shipment correction%'`,
          )
        ).rows,
      ).toEqual([
        expect.objectContaining({
          notes: expect.stringContaining("20000 → 200000"),
        }),
      ]);
    }
    expect(
      (await service().approve(11, input, "admin-user", command)).replayed,
    ).toBe(true);
    expect(await snapshot()).toEqual(after);
  });
  it("combined corrections cannot change receipt conversions protected by quarantine custody", async () => {
    await prepare();
    await query(`UPDATE procurement.receiving_orders SET warehouse_id=1 WHERE id=60;
      UPDATE procurement.receiving_lines SET product_id=100 WHERE id=62`);
    const body = await request(),
      preview = await service().preview(11, body, "admin-user");
    const before = await snapshot(),
      rollback = new Error("Roll back posted custody fixture");
    await expect(
      fixture.database().transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO procurement.receiving_quarantine_observations
        (receiving_order_id,receiving_line_id,warehouse_id,holding_location_id,product_id,product_variant_id,
         units_per_variant_snapshot,purchase_order_line_id,inbound_shipment_line_id,description,unit_label,
         condition,observed_qty,reason,evidence_reference,actor_id,recorded_at,command_key,source_evidence)
        VALUES(60,62,1,99,100,200,50,21,11,'Held carton','case','damaged',1,'Damage found','PACKING-SLIP',
         'admin-user','2026-09-01','combined-correction-custody','{}'::jsonb)`);
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        const guarded = createReceiptShipmentQuantityCorrectionService(
          tx,
          fixture.shipments(),
          () => fixture.at,
        );
        const current = await guarded.context(11, "admin-user");
        await expect(
          guarded.preview(
            11,
            { ...body, sourceVersion: current.sourceVersion },
            "admin-user",
          ),
        ).rejects.toMatchObject({
          code: "RECEIVING_CUSTODY_HISTORY_PROTECTED",
        });
        const input = { ...body, previewVersion: preview.previewVersion };
        expect(
          (await guarded.approve(11, input, "admin-user", descriptor(input)))
            .httpStatus,
        ).toBe(409);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await snapshot()).toEqual(before);
  });
  it("shipment edit fixes the 20,000 to 200,000 manifest while preserving the already-correct receipt and posting exact costs", async () => {
    await prepare(true, 200000);
    await query(`UPDATE procurement.inbound_shipment_lines SET qty_shipped=20000,carton_count=20,dimension_basis='carton' WHERE id=11;
      UPDATE procurement.inbound_freight_costs SET actual_cents=129838 WHERE id=31`);
    await fixture
      .database()
      .transaction((tx) =>
        fixture
          .shipments()
          .updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at),
      );
    const before = await snapshot();
    const body = await shipmentRequest(200000);
    const preview = await service("shipment").preview(11, body, "admin-user");
    expect(await snapshot()).toEqual(before);
    expect(preview.summary).toMatchObject({
      purpose: "shipment",
      shipmentPieces: { before: 20000, after: 200000 },
      poReceivedPieces: { before: 200000, after: 200000 },
      shipmentChargeCents: { before: 129838, after: 129838 },
      stockUnitChange: 0,
      chargePerPiece: { before: "0.064919", after: "0.006492" },
    });
    expect(preview.summary.receipts[0]).toMatchObject({
      receivedPieces: 200000,
      afterPieces: 200000,
    });
    const input = { ...body, previewVersion: preview.previewVersion },
      command = shipmentDescriptor(input);
    const result = await service("shipment").approve(
      11,
      input,
      "admin-user",
      command,
    );
    expect(result.httpStatus, JSON.stringify(result.body)).toBe(200);
    const after = await snapshot();
    expect(after.receipt).toEqual(before.receipt);
    expect(after.origin).toEqual(before.origin);
    expect(after.transactions).toEqual(before.transactions);
    expect(
      after.lots.map((row) => [row.id, row.qty_received, row.qty_on_hand]),
    ).toEqual(
      before.lots.map((row) => [row.id, row.qty_received, row.qty_on_hand]),
    );
    expect(after.shipment.find((row) => row.id === 11)).toMatchObject({
      qty_shipped: 200000,
      carton_count: 20,
    });
    expect(
      (
        await query(
          "SELECT total_pieces FROM procurement.inbound_shipments WHERE id=1",
        )
      ).rows[0].total_pieces,
    ).toBe(200000);
    expect(
      (
        await service("shipment").context(11, "admin-user")
      ).history[0].summary.costResults
        .filter((row) => row.component === "landed")
        .every((row) => row.status === "applied"),
    ).toBe(true);
    expect(
      (
        await query(
          "SELECT landed_total_cost_mills::text AS amount FROM inventory.inventory_lots WHERE id=501",
        )
      ).rows,
    ).toEqual([{ amount: "12983800" }]);
    expect(
      (await service("shipment").approve(11, input, "admin-user", command))
        .replayed,
    ).toBe(true);
    expect(await snapshot()).toEqual(after);
  });
  it("shipment edit updates a pending receipt's expectation and physical totals without changing entered counts", async () => {
    await query(`UPDATE procurement.purchase_order_lines SET order_qty=2000 WHERE id=21;
      UPDATE procurement.inbound_shipments SET status='delivered' WHERE id=1;
      UPDATE procurement.inbound_shipment_lines SET dimension_basis='piece',carton_count=NULL,weight_kg='0.1',
        length_cm='10',width_cm='10',height_cm='10' WHERE id=11;
      INSERT INTO procurement.receiving_orders(id,receipt_number,source_type,status,purchase_order_id,inbound_shipment_id,warehouse_id)
        VALUES(60,'OPEN-RECEIPT','shipment','draft',10,1,1);
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,inbound_shipment_line_id,product_id,product_variant_id,
        expected_qty,received_qty,units_per_variant_snapshot) VALUES(62,60,21,11,100,200,2,1,50);`);
    const before = await snapshot(),
      body = await shipmentRequest();
    const preview = await service("shipment").preview(11, body, "admin-user");
    expect(preview.summary.pendingReceipts).toEqual([
      expect.objectContaining({
        expectedUnits: 2,
        afterExpectedUnits: 20,
        receivedUnits: 1,
      }),
    ]);
    expect(await snapshot()).toEqual(before);
    const input = { ...body, previewVersion: preview.previewVersion };
    const result = await service("shipment").approve(
      11,
      input,
      "admin-user",
      shipmentDescriptor(input),
    );
    expect(result.httpStatus, JSON.stringify(result.body)).toBe(200);
    const after = await snapshot();
    expect(after.receipt[0]).toMatchObject({
      expected_qty: 20,
      received_qty: 1,
      units_per_variant_snapshot: 50,
      status: "partial",
    });
    expect(
      (
        await query(
          "SELECT expected_total_units FROM procurement.receiving_orders WHERE id=60",
        )
      ).rows[0].expected_total_units,
    ).toBe(20);
    expect(after.shipment[0]).toMatchObject({
      total_weight_kg: "100.000",
      total_volume_cbm: "1.000000",
      qty_shipped: 1000,
    });
    expect(after.lots).toEqual(before.lots);
    expect(after.transactions).toEqual(before.transactions);
    // A later custody decision must remain protected even if the shipment edit
    // was reviewed before the receiving operator recorded that history.
    const next = await shipmentRequest(1500);
    const reviewed = await service("shipment").preview(11, next, "admin-user");
    const protectedBefore = await snapshot();
    // Keep this immutable custody fixture inside a rolled-back transaction;
    // the surrounding suite deliberately refuses to erase committed custody.
    const rollbackFixture = new Error("Roll back custody fixture");
    await expect(
      fixture.database().transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO procurement.receiving_quarantine_observations
          (receiving_order_id,receiving_line_id,warehouse_id,holding_location_id,product_id,product_variant_id,
           units_per_variant_snapshot,purchase_order_line_id,inbound_shipment_line_id,description,unit_label,
           condition,observed_qty,reason,evidence_reference,actor_id,recorded_at,command_key,source_evidence)
          VALUES(60,62,1,99,100,200,50,21,11,'Held carton','case','damaged',1,'Damage found','PACKING-SLIP',
           'admin-user','2026-09-01','shipment-edit-custody','{}'::jsonb)`);
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        const guardedService = createReceiptShipmentQuantityCorrectionService(
          tx,
          fixture.shipments(),
          () => fixture.at,
          "shipment",
        );
        const protectedInput = {
          ...next,
          previewVersion: reviewed.previewVersion,
        };
        expect(
          (
            await guardedService.approve(
              11,
              protectedInput,
              "admin-user",
              shipmentDescriptor(protectedInput),
            )
          ).httpStatus,
        ).toBe(409);
        const current = await guardedService.context(11, "admin-user");
        await expect(
          guardedService.preview(
            11,
            { ...next, sourceVersion: current.sourceVersion },
            "admin-user",
          ),
        ).rejects.toMatchObject({
          code: "RECEIVING_CUSTODY_HISTORY_PROTECTED",
        });
        throw rollbackFixture;
      }),
    ).rejects.toBe(rollbackFixture);
    expect(await snapshot()).toEqual(protectedBefore);
  });
  it("shipment edit reallocates the exact charge across every affected shipment line", async () => {
    await prepare();
    await query(`INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,
      product_variant_id,sku,qty_shipped,carton_count) VALUES(12,1,10,21,200,'SECOND-LINE',100,2);
      UPDATE procurement.inbound_freight_costs SET allocation_method='by_value' WHERE id=31`);
    await fixture
      .database()
      .transaction((tx) =>
        fixture
          .shipments()
          .updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at),
      );
    expect(
      (
        await query(
          "SELECT id,allocated_cost_cents FROM procurement.inbound_shipment_lines ORDER BY id",
        )
      ).rows,
    ).toEqual([
      { id: 11, allocated_cost_cents: "2500" },
      { id: 12, allocated_cost_cents: "2500" },
    ]);
    const body = await shipmentRequest(),
      preview = await service("shipment").preview(11, body, "admin-user");
    const input = { ...body, previewVersion: preview.previewVersion };
    const result = await service("shipment").approve(
      11,
      input,
      "admin-user",
      shipmentDescriptor(input),
    );
    expect(result.httpStatus, JSON.stringify(result.body)).toBe(200);
    expect(
      (
        await query(
          "SELECT id,allocated_cost_cents FROM procurement.inbound_shipment_lines ORDER BY id",
        )
      ).rows,
    ).toEqual([
      { id: 11, allocated_cost_cents: "4545" },
      { id: 12, allocated_cost_cents: "455" },
    ]);
    expect(
      (
        await query(
          "SELECT actual_cents FROM procurement.inbound_freight_costs WHERE id=31",
        )
      ).rows[0].actual_cents,
    ).toBe("5000");
  });
  it("shipment edit supports an unreceived shipment without creating receipt or inventory records", async () => {
    await query(`UPDATE procurement.purchase_order_lines SET order_qty=2000 WHERE id=21;
      UPDATE procurement.inbound_shipments SET status='in_transit' WHERE id=1`);
    const before = await snapshot(),
      body = await shipmentRequest();
    expect(
      (await service("shipment").context(11, "admin-user")).blockedReason,
    ).toBeNull();
    const preview = await service("shipment").preview(11, body, "admin-user");
    const input = { ...body, previewVersion: preview.previewVersion };
    expect(
      (
        await service("shipment").approve(
          11,
          input,
          "admin-user",
          shipmentDescriptor(input),
        )
      ).httpStatus,
    ).toBe(200);
    const after = await snapshot();
    expect(after.receipt).toEqual(before.receipt);
    expect(after.lots).toEqual(before.lots);
    expect(after.transactions).toEqual(before.transactions);
    expect(after.shipment[0].qty_shipped).toBe(1000);
  });
  it("shipment edit requires fresh approval and rolls back if a downstream cost owner fails", async () => {
    await prepare();
    const body = await shipmentRequest();
    await expect(
      service("shipment").preview(11, { ...body, receipts: [] }, "admin-user"),
    ).rejects.toThrow();
    const preview = await service("shipment").preview(11, body, "admin-user");
    const failing = createReceiptShipmentQuantityCorrectionService(
      fixture.database(),
      {
        ...fixture.shipments(),
        refreshQuantityAllocationInTransaction: async () => {
          throw new Error("Cost writer unavailable");
        },
      },
      () => fixture.at,
      "shipment",
    );
    const before = await snapshot(),
      input = { ...body, previewVersion: preview.previewVersion };
    await expect(
      failing.approve(11, input, "admin-user", shipmentDescriptor(input)),
    ).rejects.toThrow("Cost writer unavailable");
    expect(await snapshot()).toEqual(before);
    await query(
      "UPDATE procurement.receiving_lines SET updated_at=updated_at+interval '1 second' WHERE id=62",
    );
    const staleBefore = await snapshot();
    expect(
      (
        await service("shipment").approve(
          11,
          input,
          "admin-user",
          shipmentDescriptor(input),
        )
      ).httpStatus,
    ).toBe(409);
    expect(await snapshot()).toEqual(staleBefore);
  });
  it.each(["lead-user", "custom-user", "scoped-user"])(
    "shipment edit denies %s without current administrator authority",
    async (actor) => {
      await prepare();
      const body = await shipmentRequest();
      expect((await service("shipment").context(11, actor)).canApprove).toBe(
        false,
      );
      await expect(
        service("shipment").preview(11, body, actor),
      ).rejects.toMatchObject({ code: "QUANTITY_CORRECTION_ADMIN" });
    },
  );
  it("shipment edits serialize competing approvals and retain only one before/after record", async () => {
    await prepare();
    const body = await shipmentRequest(),
      preview = await service("shipment").preview(11, body, "admin-user");
    const input = { ...body, previewVersion: preview.previewVersion };
    const results = await Promise.all([
      service("shipment").approve(
        11,
        input,
        "admin-user",
        shipmentDescriptor(input),
      ),
      service("shipment").approve(
        11,
        input,
        "admin-user",
        shipmentDescriptor(input),
      ),
    ]);
    expect(results.map((row) => row.httpStatus).sort()).toEqual([200, 409]);
    expect((await snapshot()).audit).toHaveLength(1);
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
  it("quantity correction blocks cancelled and returned purchase lines", async () => {
    await prepare();
    for (const statement of [
      "UPDATE procurement.purchase_order_lines SET status='cancelled' WHERE id=21",
      "UPDATE procurement.purchase_order_lines SET status='received',returned_qty=1 WHERE id=21",
      "UPDATE procurement.purchase_order_lines SET returned_qty=0 WHERE id=21; UPDATE procurement.purchase_orders SET physical_status='cancelled' WHERE id=10",
    ]) {
      await query(statement);
      const current = await service().context(11, "admin-user");
      expect(current.blockedReason).toContain("reversal workflow");
      const body = await request(),
        before = await snapshot();
      await expect(
        service().preview(11, body, "admin-user"),
      ).rejects.toMatchObject({ code: "QUANTITY_CORRECTION_BLOCKED" });
      expect(await snapshot()).toEqual(before);
    }
  });
  it("quantity correction can post explicitly approved historical freight without inventing stock or sales", async () => {
    await prepare(false);
    // Historical receipt and manifest links can be incomplete. The saved PO
    // receipt posting proves the prior pieces; today's catalog is not authority.
    await query(`UPDATE procurement.receiving_lines SET units_per_variant_snapshot=NULL,inbound_shipment_line_id=NULL WHERE id=62;
      UPDATE procurement.inbound_shipment_lines SET product_variant_id=NULL,units_per_variant_snapshot=NULL WHERE id=11;
      UPDATE catalog.product_variants SET units_per_variant=5000 WHERE id=200;`);
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
    expect(
      quantityCorrectionContextSchema.parse(result.body).receipts[0],
    ).toMatchObject({
      receivedPieces: 1000,
      piecesPerUnit: 500,
      receivedUnits: 2,
      unitWasRecorded: true,
    });
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
  it.each([
    { purpose: "receipt" as const, total: "1550000", delta: 6500 },
    { purpose: "shipment" as const, total: "775000", delta: -1250 },
  ])(
    "$purpose correction revalues transferred stock and sold COGS through the real owners",
    async ({ purpose, total, delta }) => {
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
        current = await service(purpose).context(11, "admin-user");
      const body = {
        ...(await shipmentRequest(200)),
        sourceVersion: current.sourceVersion,
        shippedPieces: 200,
        ...(purpose === "receipt"
          ? {
              receipts: [
                { receiptLineId: receipt.lineId, receivedPieces: 200 },
              ],
            }
          : {}),
      };
      const preview = await service(purpose).preview(11, body, "admin-user");
      expect(
        preview.summary.costResults.reduce(
          (sum, row) => sum + row.orderCostDeltaCents,
          0,
        ),
      ).toBe(delta);
      expect(await snapshot()).toEqual(before);
      const input = { ...body, previewVersion: preview.previewVersion };
      const approved = await service(purpose).approve(
        11,
        input,
        "admin-user",
        purpose === "shipment" ? shipmentDescriptor(input) : descriptor(input),
      );
      expect(approved.httpStatus, JSON.stringify(approved.body)).toBe(200);
      expect(
        (
          await query(
            "SELECT total_cost_mills::text AS total FROM oms.order_item_costs",
          )
        ).rows,
      ).toEqual([{ total }]);
      expect((await snapshot()).transactions).toEqual(before.transactions);
      expect(
        (
          await query(
            "SELECT total_unit_cost_mills::text AS total FROM inventory.inventory_lots ORDER BY id",
          )
        ).rows,
      ).toEqual([{ total }, { total }]);
      expect((await snapshot()).origin).toEqual(before.origin);
      if (purpose === "shipment")
        expect((await snapshot()).receipt).toEqual(before.receipt);
      const posted = await service(purpose).context(11, "admin-user");
      expect(
        posted.history[0].summary.costResults.every(
          (row) => row.status === "applied",
        ),
      ).toBe(true);
      const poHistory = (
        await query(
          "SELECT notes FROM procurement.po_status_history WHERE notes LIKE 'Administrator approved %'",
        )
      ).rows;
      expect(poHistory).toHaveLength(1);
    },
  );
}
