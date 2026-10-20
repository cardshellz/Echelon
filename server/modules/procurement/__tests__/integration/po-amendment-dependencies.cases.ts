import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type pg from "pg";
import { createPoQuantityAmendmentService } from "../../po-quantity-amendment.service";
import type { AmendmentDatabase } from "../../po-quantity-amendment.repository";
import type { ShipmentTrackingService } from "../../shipment-tracking.service";
import { costFingerprint } from "../../../inventory/infrastructure/cost-evidence-values";
import {
  poQuantityAmendmentResultSchema,
  type PoQuantityPreviewRequest,
} from "@shared/procurement/po-quantity-amendment";
import { readPoShipmentCosts } from "../../po-shipment-cost-summary.repository";
import { readPurchaseCostStatus } from "../../purchase-cost-status.repository";
import {
  createShipmentCostReconciliationService,
  shipmentReconciliationScope,
} from "../../shipment-cost-reconciliation.service";
import { createPurchasePipelineRepository } from "../../purchase-pipeline.repository";
import { projectPurchasePipeline } from "../../purchase-pipeline.service";

export function registerPoAmendmentDependencyCases(fixture: {
  pool: () => pg.Pool;
  database: () => AmendmentDatabase & Parameters<typeof readPoShipmentCosts>[0];
  shipments: () => ShipmentTrackingService;
  at: Date;
  receive: () => Promise<unknown>;
  receiveDirect: () => Promise<void>;
  transferAndSell: () => Promise<void>;
  expectedReceipts: () => Promise<unknown[]>;
  historicalGaps: () => Promise<void>;
}) {
  const service = () =>
    createPoQuantityAmendmentService(
      fixture.database(),
      () => fixture.at,
      fixture.shipments(),
    );
  const query = (text: string) => fixture.pool().query(text);
  async function prepare() {
    await query(`UPDATE procurement.purchase_orders SET subtotal_cents=22000,total_cents=22000,line_count=1 WHERE id=10;
      UPDATE procurement.purchase_order_lines SET product_name='Synthetic product',pricing_basis='per_piece',pricing_source='manual',quoted_unit_cost_mills=10000 WHERE id=21;
      INSERT INTO inventory.warehouse_settings(warehouse_code,require_approval) VALUES('DEFAULT',false);
      INSERT INTO procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id,allocated_amount_cents) VALUES(71,10,26000);`);
    await fixture.receive();
    await fixture
      .database()
      .transaction((tx) =>
        fixture
          .shipments()
          .updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at),
      );
    await fixture.transferAndSell();
  }
  async function draft(
    quantityPieces = 400,
  ): Promise<PoQuantityPreviewRequest> {
    return {
      sourceVersion: (await service().context(10, "admin-user")).sourceVersion,
      changes: [
        { lineId: 21, quantityPieces, priceTreatment: "keep_product_total" },
      ],
      reason: "Supplier confirmed the revised ordered quantity",
    };
  }
  async function reviewed(request = draft()) {
    const body = await request;
    const preview = await service().preview(10, body, "admin-user");
    return {
      ...body,
      previewVersion: preview.previewVersion,
      approvalConfirmed: true as const,
    };
  }
  const descriptor = (body: unknown, key = randomUUID()) => ({
    actorType: "user" as const,
    actorId: "admin-user",
    method: "POST",
    routeTemplate: "/api/purchase-orders/:id/quantity-amendment",
    resourceKey: "purchase_order:10",
    commandName: "purchase_order.quantity_amendment.approve",
    contractVersion: 1,
    requestHash: costFingerprint(body),
    idempotencyKey: key,
  });
  async function actuals() {
    const tables: Record<string, string> = {
      lots: "SELECT id,qty_received,qty_on_hand,product_variant_id,warehouse_location_id FROM inventory.inventory_lots ORDER BY id",
      stock: "SELECT * FROM inventory.inventory_levels ORDER BY id",
      movements: "SELECT * FROM inventory.inventory_transactions ORDER BY id",
      receipts: "SELECT * FROM procurement.po_receipts ORDER BY id",
      receiving: "SELECT * FROM procurement.receiving_lines ORDER BY id",
      shipments:
        "SELECT id,qty_shipped,carton_count,total_weight_kg,total_volume_cbm,units_per_variant_snapshot FROM procurement.inbound_shipment_lines ORDER BY id",
      invoices:
        "SELECT id,vendor_invoice_id,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents,cost_component_evidence FROM procurement.vendor_invoice_lines ORDER BY id",
      bills: "SELECT * FROM procurement.vendor_invoices ORDER BY id",
      sold: "SELECT id,order_id,qty,inventory_lot_id FROM oms.order_item_costs ORDER BY id",
      approvals:
        "SELECT * FROM inventory.cost_reconciliation_approvals ORDER BY id",
      charges: "SELECT * FROM procurement.inbound_freight_costs ORDER BY id",
    };
    const result: Record<string, unknown[]> = {};
    for (const [name, sql] of Object.entries(tables))
      result[name] = (await query(sql)).rows;
    return result;
  }
  async function financialState() {
    const result: Record<string, unknown[]> = {};
    for (const table of [
      "procurement.purchase_orders",
      "procurement.purchase_order_lines",
      "procurement.po_events",
      "procurement.po_revisions",
      "procurement.po_status_history",
      "procurement.po_exceptions",
      "procurement.cost_source_revisions",
      "inventory.cost_applications",
      "inventory.inventory_lots",
      "oms.order_item_costs",
      "procurement.inbound_freight_allocations",
      "procurement.landed_cost_snapshots",
      "procurement.landed_cost_adjustments",
      "inventory.cost_reconciliation_postings",
    ])
      result[table] = (await query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    return result;
  }

  it("PO edit previews and commits receipt, transfer, sold-cost and shipment dependencies without changing actual quantities", async () => {
    await prepare();
    const preserved = await actuals(),
      original = await financialState(),
      request = await draft();
    expect((await fixture.expectedReceipts())[0]).toMatchObject({
      pending_units: "100",
      pending_value_cents: "10000",
    });
    const preview = await service().preview(10, request, "admin-user");
    expect(await financialState()).toEqual(original);
    expect(await actuals()).toEqual(preserved);
    expect(preview.impact?.quantities).toEqual([
      expect.objectContaining({
        ordered: { before: 200, after: 400 },
        received: 100,
        shipped: 100,
        invoiced: 200,
        remainingToReceive: { before: 100, after: 300 },
        remainingToShip: { before: 100, after: 300 },
        remainingToInvoice: { before: 0, after: 200 },
      }),
    ]);
    expect(preview.impact?.shipments[0].lines[0]).toMatchObject({
      shippedPieces: 100,
      allocatedCents: { before: 5000, after: 5000 },
      landedTotalCents: { before: 15000, after: 10000 },
    });
    expect(preview.impact?.lots).toHaveLength(2);
    expect(
      preview.impact?.lots.every(
        (lot) =>
          lot.unitCostMills.before === 800000 &&
          lot.unitCostMills.after === 525000,
      ),
    ).toBe(true);
    expect(preview.impact?.orderCosts).toEqual([
      expect.objectContaining({
        quantity: 1,
        totalMills: { before: 800000, after: 525000 },
      }),
    ]);
    expect(
      preview.impact?.applications.every(
        (application) => application.status === "applied",
      ),
    ).toBe(true);
    const body = {
        ...request,
        previewVersion: preview.previewVersion,
        approvalConfirmed: true as const,
      },
      command = descriptor(body);
    const first = await service().approve(10, body, "admin-user", command);
    expect(first.httpStatus).toBe(200);
    const saved = poQuantityAmendmentResultSchema.parse(first.body);
    expect(saved.preview).toEqual(preview);
    expect(await actuals()).toEqual(preserved);
    const committed = await financialState();
    expect(
      (await service().approve(10, body, "admin-user", command)).replayed,
    ).toBe(true);
    expect(await financialState()).toEqual(committed);
    expect((await service().history(10, null)).entries[0]).toMatchObject({
      actorId: "admin-user",
      revisionNumber: 1,
      preview,
    });
    const status = await fixture
      .database()
      .transaction((tx) => readPurchaseCostStatus(tx, [21]));
    expect(JSON.stringify(status)).not.toContain('"review_required"');
    const costs = await readPoShipmentCosts(fixture.database(), 10);
    expect(costs?.lines.every((line) => line.status === "applied")).toBe(true);
    expect(
      (await fixture.shipments().getCostReview(1))?.lines.every(
        (line) => line.application?.status === "applied",
      ),
    ).toBe(true);
    expect((await fixture.expectedReceipts())[0]).toMatchObject({
      pending_units: "300",
      pending_value_cents: "15000",
    });
    const pipeline = projectPurchasePipeline(
      await createPurchasePipelineRepository(fixture.database()).read(),
      fixture.at,
      90,
    );
    expect(pipeline.rows.length).toBeGreaterThan(0);
    expect(
      pipeline.rows.every(
        (row) =>
          row.orderedPieces === 400 &&
          row.receivedPieces === 100 &&
          row.remainingPieces === 300,
      ),
    ).toBe(true);
  });

  it("PO quantity changes reallocate an entire shared shipment including another PO", async () => {
    await prepare();
    await query(`INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,total_cents) VALUES(20,'OTHER-PO',5,'sent',22000);
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,order_qty,unit_cost_cents,unit_cost_mills,total_product_cost_cents,packaging_cost_cents,line_total_cents,status)
      VALUES(22,20,1,100,200,100,10000,20000,2000,22000,'open');
      INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,product_variant_id,sku,qty_shipped)
      VALUES(12,1,20,22,200,'OTHER-PO-PRODUCT',100);
      UPDATE procurement.inbound_freight_costs SET allocation_method='by_value';
      UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1;`);
    await fixture
      .database()
      .transaction((tx) =>
        fixture
          .shipments()
          .updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at),
      );
    const preserved = await actuals(),
      body = await reviewed();
    const result = await service().approve(
      10,
      body,
      "admin-user",
      descriptor(body),
    );
    expect(result.httpStatus).toBe(200);
    const impact = poQuantityAmendmentResultSchema.parse(result.body).preview
      .impact!;
    expect(
      impact.shipments[0].lines.map((line) => line.allocatedCents),
    ).toEqual([
      { before: 2500, after: 1667 },
      { before: 2500, after: 3333 },
    ]);
    expect(
      (
        await query(
          "SELECT sum(allocated_cents)::int AS total FROM procurement.inbound_freight_allocations",
        )
      ).rows[0].total,
    ).toBe(5000);
    expect(
      (
        await query(
          "SELECT status FROM procurement.inbound_shipments WHERE id=1",
        )
      ).rows[0].status,
    ).toBe("closed");
    expect(await actuals()).toEqual(preserved);
  });

  it("approved supplier amounts remain authoritative when the PO order quantity changes", async () => {
    await prepare();
    await query(`UPDATE procurement.vendor_invoices SET status='paid',paid_amount_cents=invoiced_amount_cents,balance_cents=0 WHERE id=71;
      UPDATE procurement.vendor_invoice_lines SET qty_invoiced=100,line_total_cents=13000,
        cost_component_evidence='{"contractVersion":1,"packagingTreatment":"separate","productMills":1200000,"packagingMills":100000,"adjustmentMills":0,"source":"operator_review"}' WHERE id=72;
      UPDATE procurement.purchase_orders SET status='received',physical_status='received' WHERE id=10;
      UPDATE procurement.purchase_order_lines SET order_qty=100,status='received' WHERE id=21;`);
    const request = await draft(100);
    request.changes[0] = {
      lineId: 21,
      quantityPieces: 100,
      priceTreatment: "edit_line",
      pricing: {
        basis: "per_piece",
        quantityPieces: 100,
        unitCostMills: 20000,
      },
      packagingCostCents: 2000,
      discountCents: 0,
      taxCents: 0,
    };
    const body = await reviewed(Promise.resolve(request)),
      preserved = await actuals();
    expect(
      (await service().approve(10, body, "admin-user", descriptor(body)))
        .httpStatus,
    ).toBe(200);
    expect(await actuals()).toEqual(preserved);
    expect(
      (
        await query(
          "SELECT po_unit_cost_mills::int AS product FROM inventory.inventory_lots ORDER BY id",
        )
      ).rows.every((lot) => lot.product === 600000),
    ).toBe(true);
  });

  it("PO edit uses posted direct receipts as well as shipments when calculating remaining shipping capacity", async () => {
    await prepare();
    await fixture.receiveDirect();
    const preserved = await actuals(),
      request = await draft();
    const preview = await service().preview(10, request, "admin-user");
    expect(preview.impact?.quantities[0]).toMatchObject({
      received: 150,
      shipped: 100,
      remainingToShip: { before: 50, after: 250 },
      remainingToReceive: { before: 50, after: 250 },
    });
    const body = {
      ...request,
      previewVersion: preview.previewVersion,
      approvalConfirmed: true as const,
    };
    expect(
      (await service().approve(10, body, "admin-user", descriptor(body)))
        .httpStatus,
    ).toBe(200);
    expect(await actuals()).toEqual(preserved);
  });

  it("PO edit preserves historical COGS approvals and exposes independent missing evidence", async () => {
    await fixture.historicalGaps();
    await query(`UPDATE procurement.purchase_orders SET subtotal_cents=22000,total_cents=22000,line_count=1 WHERE id=10;
      INSERT INTO inventory.warehouse_settings(warehouse_code,require_approval) VALUES('DEFAULT',false);
      UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1;`);
    await fixture
      .database()
      .transaction((tx) =>
        fixture
          .shipments()
          .updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at),
      );
    const reconciliation = createShipmentCostReconciliationService(
      fixture.database(),
      () => fixture.at,
    );
    const context = await reconciliation.context(11, "admin-user");
    const approval = {
      sourceVersion: context.sourceVersion,
      destination: "historical_cogs" as const,
      reason:
        "Historical goods were sold, reviewed by the purchasing administrator.",
    };
    expect(
      await reconciliation.reconcile(11, approval, "admin-user", {
        ...shipmentReconciliationScope(11),
        actorType: "user",
        actorId: "admin-user",
        contractVersion: 1,
        idempotencyKey: randomUUID(),
        requestHash: costFingerprint(approval),
      }),
    ).toMatchObject({ httpStatus: 200, body: { state: { status: "posted" } } });
    const preserved = await actuals(),
      body = await reviewed(draft(4400000));
    const saved = await service().approve(
      10,
      body,
      "admin-user",
      descriptor(body),
    );
    expect(saved.httpStatus).toBe(200);
    const impact = poQuantityAmendmentResultSchema.parse(saved.body).preview
      .impact!;
    expect(impact.historicalCosts).toContainEqual(
      expect.objectContaining({
        shipmentLineId: 11,
        destination: "historical_cogs",
        totalMills: {
          before: context.historicalAmountMills,
          after: context.historicalAmountMills,
        },
      }),
    );
    expect(
      (await reconciliation.context(11, "admin-user")).state,
    ).toMatchObject({ status: "posted", unassignedMills: 0 });
    expect(
      impact.applications.some(
        (application) =>
          application.component === "product" &&
          application.status === "review_required",
      ),
    ).toBe(true);
    expect(
      impact.applications
        .filter((application) => application.component === "landed")
        .every(
          (application) =>
            application.status === "applied" && application.issues.length === 0,
        ),
    ).toBe(true);
    expect(await actuals()).toEqual(preserved);
  });

  it("PO edit can approve its first cost application when preview creates temporary allocation identities", async () => {
    await fixture.historicalGaps();
    await query(`UPDATE procurement.purchase_orders SET subtotal_cents=22000,total_cents=22000,line_count=1 WHERE id=10;
      INSERT INTO inventory.warehouse_settings(warehouse_code,require_approval) VALUES('DEFAULT',false);`);
    const before = await financialState(),
      preserved = await actuals(),
      request = await draft(4400000);
    const preview = await service().preview(10, request, "admin-user");
    expect(
      preview.impact?.applications.some(
        (application) => application.status === "review_required",
      ),
    ).toBe(true);
    expect(await financialState()).toEqual(before);
    expect(await service().preview(10, request, "admin-user")).toEqual(preview);
    const body = {
      ...request,
      previewVersion: preview.previewVersion,
      approvalConfirmed: true as const,
    };
    const result = await service().approve(
      10,
      body,
      "admin-user",
      descriptor(body),
    );
    expect(result.httpStatus).toBe(200);
    expect(poQuantityAmendmentResultSchema.parse(result.body).preview).toEqual(
      preview,
    );
    expect(await actuals()).toEqual(preserved);
  });

  it("PO edit refreshes open-shipment allocation without pretending inventory costs are finalized", async () => {
    await query(`UPDATE procurement.purchase_orders SET subtotal_cents=22000,total_cents=22000,line_count=1 WHERE id=10;
      INSERT INTO inventory.warehouse_settings(warehouse_code,require_approval) VALUES('DEFAULT',false);
      UPDATE procurement.inbound_shipments SET status='in_transit' WHERE id=1;`);
    const body = await reviewed(),
      preserved = await actuals();
    const saved = await service().approve(
      10,
      body,
      "admin-user",
      descriptor(body),
    );
    expect(saved.httpStatus).toBe(200);
    const impact = poQuantityAmendmentResultSchema.parse(saved.body).preview
      .impact!;
    expect(impact.applications).toContainEqual(
      expect.objectContaining({
        shipmentId: 1,
        status: "pending_finalization",
      }),
    );
    expect(impact.shipments[0].lines[0].allocatedCents).toEqual({
      before: 0,
      after: 5000,
    });
    expect(
      (
        await query(
          "SELECT count(*)::int AS count FROM procurement.landed_cost_snapshots",
        )
      ).rows[0].count,
    ).toBe(0);
    expect(await actuals()).toEqual(preserved);
  });

  it.each(["stock", "shipment", "invoice"])(
    "PO edit rejects %s changes after its approved preview",
    async (kind) => {
      await prepare();
      const body = await reviewed();
      await query(
        kind === "stock"
          ? "UPDATE inventory.inventory_lots SET qty_on_hand=0 WHERE qty_on_hand=1"
          : kind === "shipment"
            ? "UPDATE procurement.inbound_freight_costs SET actual_cents=6000 WHERE id=31"
            : "UPDATE procurement.vendor_invoice_lines SET qty_invoiced=201 WHERE id=72",
      );
      const before = await financialState();
      expect(
        await service().approve(10, body, "admin-user", descriptor(body)),
      ).toMatchObject({
        httpStatus: 409,
        body: { code: "PO_AMENDMENT_STALE" },
      });
      expect(await financialState()).toEqual(before);
    },
  );

  it("PO edit requires the measured preview and rolls back a forged impact", async () => {
    await prepare();
    const body = await reviewed(),
      before = await financialState();
    const forged = { ...body, previewVersion: "f".repeat(64) };
    expect(
      await service().approve(10, forged, "admin-user", descriptor(forged)),
    ).toMatchObject({ httpStatus: 409, body: { code: "PO_AMENDMENT_STALE" } });
    const missing = { ...body, previewVersion: undefined };
    expect(
      await service().approve(10, missing, "admin-user", descriptor(missing)),
    ).toMatchObject({
      httpStatus: 409,
      body: { code: "PO_AMENDMENT_PREVIEW_REQUIRED" },
    });
    expect(await financialState()).toEqual(before);
  });

  it("PO edit rolls back costs, COGS, allocations and quantity when audit append fails", async () => {
    await prepare();
    const body = await reviewed(),
      before = await financialState();
    await query(`CREATE FUNCTION procurement.reject_amendment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected amendment audit failure'; END $$;
      CREATE TRIGGER reject_amendment BEFORE INSERT ON procurement.po_events FOR EACH ROW EXECUTE FUNCTION procurement.reject_amendment()`);
    try {
      await expect(
        service().approve(10, body, "admin-user", descriptor(body)),
      ).rejects.toThrow();
    } finally {
      await query(
        "DROP TRIGGER reject_amendment ON procurement.po_events; DROP FUNCTION procurement.reject_amendment()",
      );
    }
    expect(await financialState()).toEqual(before);
  });

  it("PO edit refreshes quantity exceptions and retains their original evidence", async () => {
    await prepare();
    await query(`INSERT INTO procurement.po_exceptions(po_id,kind,severity,status,payload,payload_hash,title)
      VALUES(10,'qty_short','warn','open','{"lineId":21,"orderedQty":200,"receivedQty":100}','old-shortage','Old shortage')`);
    const body = await reviewed(draft(100));
    expect(
      (await service().approve(10, body, "admin-user", descriptor(body)))
        .httpStatus,
    ).toBe(200);
    expect(
      (
        await query(
          "SELECT status,payload FROM procurement.po_exceptions WHERE kind='qty_short'",
        )
      ).rows,
    ).toEqual([
      {
        status: "dismissed",
        payload: { lineId: 21, orderedQty: 200, receivedQty: 100 },
      },
    ]);
    expect(
      (
        await query(
          "SELECT status,order_qty,received_qty FROM procurement.purchase_order_lines WHERE id=21",
        )
      ).rows[0],
    ).toEqual({ status: "received", order_qty: 100, received_qty: 100 });
  });
}
