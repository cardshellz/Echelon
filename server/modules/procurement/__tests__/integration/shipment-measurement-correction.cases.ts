import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { AmendmentDatabase, AmendmentTransaction } from "../../po-quantity-amendment.repository";
import type { ShipmentTrackingService } from "../../shipment-tracking.service";
import { createShipmentMeasurementCorrectionService } from "../../shipment-measurement-correction.service";
import { createShipmentCostUpdateCommands, shipmentCostUpdateScope } from "../../shipment-cost-update.commands";
import { createDrizzleFinancialCommandRepository } from "../../../../platform/commands/command-results.repository";
import { costFingerprint } from "../../../inventory/infrastructure/cost-evidence-values";
import type { ShipmentMeasurementApproval, ShipmentMeasurementReviewRequest } from "@shared/procurement/shipment-measurement-correction";
import { createShipmentCostReconciliationService, shipmentReconciliationScope } from "../../shipment-cost-reconciliation.service";
import { isShipmentCostLinePosted } from "@shared/procurement/shipment-cost-workflow";
import type { ReconciliationDestination } from "@shared/procurement/cost-reconciliation";
import { readPoShipmentCosts } from "../../po-shipment-cost-summary.repository";

export function registerShipmentMeasurementCorrectionCases(fixture: {
  pool: () => pg.Pool; database: () => AmendmentDatabase & Pick<AmendmentTransaction, "execute">; shipments: () => ShipmentTrackingService; at: Date;
  receive: () => Promise<unknown>; approveSupplier: () => Promise<unknown>; sell: () => Promise<unknown>;
  historicalGaps: () => Promise<void>;
}) {
  describe("shipment measurement corrections", () => {
  const service = () => createShipmentMeasurementCorrectionService(fixture.database(), fixture.shipments(), () => fixture.at);
  const query = (text: string) => fixture.pool().query(text);
  // The parent fixture deliberately retains admin audit history for other cost
  // scenarios; these fictional shipment IDs are recreated for every case.
  beforeEach(async () => { await query("DELETE FROM public.audit_events WHERE action='procurement.shipment.measurements_corrected' AND target='shipment:1'"); });
  const commands = () => createShipmentCostUpdateCommands(fixture.shipments(), createDrizzleFinancialCommandRepository(fixture.database()), () => fixture.at);
  async function approve(request: ShipmentMeasurementApproval, key = randomUUID(), actor = "admin-user") {
    return commands().execute(1, { measurementCorrection: request }, actor, { ...shipmentCostUpdateScope(1),
      actorType: "user", actorId: actor, idempotencyKey: key, requestHash: costFingerprint(request), contractVersion: 1 });
  }
  async function snapshot() {
    const tables = ["procurement.inbound_shipments", "procurement.inbound_shipment_lines", "procurement.inbound_freight_allocations",
      "procurement.landed_cost_snapshots", "procurement.landed_cost_adjustments", "procurement.cost_source_revisions", "inventory.cost_applications",
      "inventory.inventory_lots", "oms.order_item_costs", "inventory.cost_reconciliation_approvals", "inventory.cost_reconciliation_postings", "public.audit_events"];
    return Promise.all(tables.map(async table => (await query(`SELECT * FROM ${table} ORDER BY id`)).rows));
  }
  async function physical() {
    return Promise.all([
      "SELECT id,qty_shipped,units_per_variant_snapshot FROM procurement.inbound_shipment_lines ORDER BY id",
      "SELECT id,expected_qty,received_qty,units_per_variant_snapshot FROM procurement.receiving_lines ORDER BY id",
      "SELECT id,qty_received,qty_on_hand FROM inventory.inventory_lots ORDER BY id",
      "SELECT id,order_qty,received_qty FROM procurement.purchase_order_lines ORDER BY id",
      "SELECT id,qty_invoiced,line_total_cents FROM procurement.vendor_invoice_lines ORDER BY id",
      "SELECT * FROM procurement.inbound_freight_costs ORDER BY id",
    ].map(async sql => (await query(sql)).rows));
  }
  async function addSecondPo() {
    await query(`INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,warehouse_id) VALUES(20,'MEASUREMENT-SECOND-PO',5,'sent',1);
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,product_variant_id,expected_receive_variant_id,expected_receive_units_per_variant,sku,
        order_qty,unit_cost_cents,unit_cost_mills,total_product_cost_cents,packaging_cost_cents,line_total_cents,status)
        VALUES(22,20,1,100,200,200,50,'SECOND-PO-PRODUCT',100,100,10000,10000,1000,11000,'open');
      INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,product_variant_id,sku,qty_shipped,carton_count)
        VALUES(12,1,20,22,200,'SECOND-PO-PRODUCT',100,2)`);
  }
  async function prepare(status = "closed", secondPo = true) {
    await fixture.receive(); await fixture.approveSupplier();
    if (secondPo) await addSecondPo();
    await query(`UPDATE procurement.inbound_shipments SET status='${status}' WHERE id=1;
      UPDATE procurement.inbound_shipment_lines SET dimension_basis='carton',weight_kg=5,length_cm=10,width_cm=10,height_cm=10 WHERE inbound_shipment_id=1;
      UPDATE procurement.inbound_freight_costs SET allocation_method='by_volume' WHERE id=31`);
    await fixture.database().transaction(tx => fixture.shipments().updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at));
  }
  async function request(): Promise<ShipmentMeasurementReviewRequest> {
    const current = await service().context(1, "admin-user");
    return { sourceVersion: current.sourceVersion, reason: "Packing document confirms the corrected shipping carton dimensions",
      lines: [{ lineId: 11, measurements: { ...current.lines[0].measurements, dimensionBasis: "carton", lengthCm: "30" } }] };
  }
  async function review(requested?: ShipmentMeasurementReviewRequest) {
    const input = requested ?? await request();
    const preview = await service().preview(1, input, "admin-user");
    return { input, preview, approval: { ...input, previewVersion: preview.previewVersion, evidenceConfirmed: true as const } };
  }
  async function approveHistoricalDestination(destination: ReconciliationDestination) {
    const reconciliation = createShipmentCostReconciliationService(fixture.database(), () => fixture.at);
    const context = await reconciliation.context(11, "admin-user");
    const request = { sourceVersion: context.sourceVersion, destination,
      reason: "Synthetic historical destination evidence was checked and approved" };
    const response = await reconciliation.reconcile(11, request, "admin-user", { ...shipmentReconciliationScope(11), actorType: "user", actorId: "admin-user",
      contractVersion: 1, idempotencyKey: randomUUID(), requestHash: costFingerprint(request) });
    expect(response.httpStatus).toBe(200);
    return reconciliation;
  }
  async function prepareHistoricalShares() {
    await fixture.historicalGaps(); await addSecondPo();
    await query(`UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1;
      UPDATE procurement.inbound_shipment_lines SET dimension_basis='carton',weight_kg=5,length_cm=10,width_cm=10,height_cm=10 WHERE inbound_shipment_id=1;
      UPDATE procurement.inbound_freight_costs SET allocation_method='by_volume' WHERE id=31`);
    await fixture.database().transaction(tx => fixture.shipments().updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at));
  }

  it.each(["costing", "closed"])("corrects measurements after receiving in %s, updates multi-PO shares, and preserves physical and commercial facts", async status => {
    await prepare(status);
    const counts = await physical(), before = await snapshot();
    const { preview, approval } = await review();
    expect(await snapshot()).toEqual(before);
    expect(preview.lines.map(line => ({ po: line.purchaseOrderId, share: line.allocatedCents }))).toEqual([
      { po: 10, share: { before: 2500, after: 3750 } }, { po: 20, share: { before: 2500, after: 1250 } },
    ]);
    expect(preview.lines[0].physicalTotals).toMatchObject({ before: { totalVolumeCbm: "0.002000" }, after: { totalVolumeCbm: "0.006000" } });
    const saved = await approve(approval);
    expect(saved).toMatchObject({ httpStatus: 200, body: { shipmentId: 1, measurementCorrection: { actorId: "admin-user", preview } } });
    expect(await physical()).toEqual(counts);
    expect((await query("SELECT status FROM procurement.inbound_shipments WHERE id=1")).rows[0].status).toBe(status);
    const context = await service().context(1, "admin-user");
    expect(context.approvals).toHaveLength(1);
    expect(context.approvals[0]).toMatchObject({ actorId: "admin-user", preview });
    expect((await query("SELECT * FROM inventory.cost_reconciliation_postings")).rows).toEqual([]);
    expect((await fixture.shipments().getAllocationStatus(1)).unallocatedCents).toBe(0);
  });

  it("uses entered measurements to clear missing-dimensional evidence and permits the existing full closing flow", async () => {
    await prepare("costing", false);
    await query("UPDATE procurement.inbound_shipment_lines SET weight_kg=NULL,length_cm=NULL,width_cm=NULL,height_cm=NULL WHERE id=11");
    expect((await fixture.shipments().getAllocationStatus(1)).issues.some(issue => issue.code === "missing_dimensions")).toBe(true);
    const current = await service().context(1, "admin-user");
    const input: ShipmentMeasurementReviewRequest = { sourceVersion: current.sourceVersion, reason: "Confirmed original packing list measurements",
      lines: [{ lineId: 11, measurements: { cartonCount: 2, dimensionBasis: "carton", weightKg: "5", lengthCm: "30", widthCm: "10", heightCm: "10" } }] };
    const reviewed = await review(input);
    expect((await approve(reviewed.approval)).httpStatus).toBe(200);
    expect((await fixture.shipments().getAllocationStatus(1)).issues.filter(issue => issue.code === "missing_dimensions")).toEqual([]);
    await fixture.shipments().close(1, "admin-user");
    expect((await query("SELECT status FROM procurement.inbound_shipments WHERE id=1")).rows[0].status).toBe("closed");
  });

  it("changes linked sold-order costs through the existing COGS owner and never records an invented expense", async () => {
    await prepare(); await fixture.sell();
    const reviewed = await review();
    expect(reviewed.preview.impact.orderCosts.some(row => row.totalMills.before !== row.totalMills.after)).toBe(true);
    expect((await approve(reviewed.approval)).httpStatus).toBe(200);
    expect((await query("SELECT * FROM inventory.cost_reconciliation_postings")).rows).toEqual([]);
  });
  it("reuses prior historical approvals without changing balanced postings or reopening resolved warnings", async () => {
    await fixture.historicalGaps();
    await query("UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1");
    await fixture.database().transaction(tx => fixture.shipments().updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at));
    await approveHistoricalDestination("historical_cogs");
    const historical = (await query("SELECT * FROM inventory.cost_reconciliation_postings ORDER BY id")).rows;
    const approvals = (await query("SELECT * FROM inventory.cost_reconciliation_approvals ORDER BY id")).rows;
    // Establish that the ordinary updater and approved measurement edit have
    // the same posting semantics when this line-count charge stays unchanged.
    await query("UPDATE procurement.inbound_shipment_lines SET dimension_basis='carton',weight_kg=5,length_cm=30,width_cm=10,height_cm=10 WHERE id=11");
    for (let attempt = 0; attempt < 2; attempt++) {
      await fixture.database().transaction(tx => fixture.shipments().updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at));
      expect((await query("SELECT * FROM inventory.cost_reconciliation_postings ORDER BY id")).rows).toEqual(historical);
      expect((await query("SELECT * FROM inventory.cost_reconciliation_approvals ORDER BY id")).rows).toEqual(approvals);
      expect((await fixture.shipments().getCostReview(1))?.lines.every(isShipmentCostLinePosted)).toBe(true);
    }
    const changed = await request(); changed.lines[0].measurements.lengthCm = "45";
    const reviewed = await review(changed), before = await snapshot();
    expect(reviewed.preview.impact.applications.every(row => row.status === "applied" && row.issues.length === 0)).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(await approve(reviewed.approval)).toMatchObject({ httpStatus: 200, body: { status: "applied" } });
    expect((await query("SELECT * FROM inventory.cost_reconciliation_postings ORDER BY id")).rows).toEqual(historical);
    expect((await query("SELECT * FROM inventory.cost_reconciliation_approvals ORDER BY id")).rows).toEqual(approvals);
  });

  it.each(["historical_cogs", "inventory_variance"] as const)("posts only the reviewed %s delta to its original approval when multi-PO cost shares change", async destination => {
    await prepareHistoricalShares();
    const reconciliation = await approveHistoricalDestination(destination);
    const oldPostings = (await query("SELECT * FROM inventory.cost_reconciliation_postings ORDER BY id")).rows;
    const oldApprovals = (await query("SELECT * FROM inventory.cost_reconciliation_approvals ORDER BY id")).rows;
    expect(oldPostings).toHaveLength(1);
    const before = await snapshot(), counts = await physical();
    const reviewed = await review(), key = randomUUID();
    expect(await snapshot()).toEqual(before);
    const impact = reviewed.preview.impact.historicalCosts.find(row => row.destination === destination && row.shipmentLineId === 11)!;
    expect(impact).toBeDefined();
    expect(impact.totalMills.before).toBe(Number(oldPostings[0].after_mills));
    expect(impact.totalMills.after).toBeGreaterThan(impact.totalMills.before);
    expect(reviewed.preview.lines.reduce((sum, line) => sum + BigInt(line.allocatedCents.after!), BigInt(0))).toBe(BigInt(reviewed.preview.chargeCents));
    expect(reviewed.preview.impact.applications.find(row => row.shipmentLineId === 11)).toMatchObject({ status: "applied", issues: [] });
    expect((await approve(reviewed.approval, key)).httpStatus).toBe(200);
    expect(await physical()).toEqual(counts);
    const saved = (await query("SELECT * FROM inventory.cost_reconciliation_postings ORDER BY id")).rows;
    expect(saved).toHaveLength(2);
    expect(saved[0]).toEqual(oldPostings[0]);
    expect(saved[1]).toMatchObject({ destination, previous_posting_id: oldPostings[0].id, approval_id: oldPostings[0].approval_id });
    expect(BigInt(saved[1].before_mills)).toBe(BigInt(impact.totalMills.before));
    expect(BigInt(saved[1].after_mills)).toBe(BigInt(impact.totalMills.after));
    expect(BigInt(saved[1].delta_mills)).toBe(BigInt(impact.totalMills.after) - BigInt(impact.totalMills.before));
    expect(BigInt(saved[1].delta_mills) + BigInt(saved[1].unassigned_delta_mills)).toBe(BigInt(0));
    expect((await query("SELECT * FROM inventory.cost_reconciliation_approvals ORDER BY id")).rows).toEqual(oldApprovals);
    expect(await approve(reviewed.approval, key)).toMatchObject({ httpStatus: 200, replayed: true });
    await fixture.database().transaction(tx => fixture.shipments().updateCostsInTransaction(tx, 1, {}, "admin-user", fixture.at));
    expect((await query("SELECT * FROM inventory.cost_reconciliation_postings ORDER BY id")).rows).toEqual(saved);
    expect((await fixture.shipments().getCostReview(1))?.lines.find(line => line.lineId === 11)).toSatisfy(isShipmentCostLinePosted);
    expect((await readPoShipmentCosts(fixture.database(), 10))?.lines.find(line => line.lineId === 11)?.status).toBe("applied");
    expect((await reconciliation.context(11, "admin-user")).state).toMatchObject({ status: "posted", unassignedMills: 0, destination, postedMills: impact.totalMills.after });
  });

  it("retains unresolved history without creating an unapproved historical expense", async () => {
    await prepareHistoricalShares();
    const reviewed = await review();
    expect(reviewed.preview.impact.historicalCosts).toEqual([]);
    expect(reviewed.preview.impact.applications.find(row => row.shipmentLineId === 11)?.status).toBe("review_required");
    expect((await approve(reviewed.approval)).httpStatus).toBe(200);
    expect((await query("SELECT * FROM inventory.cost_reconciliation_approvals")).rows).toEqual([]);
    expect((await query("SELECT * FROM inventory.cost_reconciliation_postings")).rows).toEqual([]);
    expect((await fixture.shipments().getCostReview(1))?.lines.find(line => line.lineId === 11)).not.toSatisfy(isShipmentCostLinePosted);
  });

  it("invalidates a measurement approval when the historical destination changes after preview", async () => {
    await prepareHistoricalShares(); await approveHistoricalDestination("historical_cogs");
    const reviewed = await review();
    await approveHistoricalDestination("inventory_variance");
    const before = await snapshot();
    expect(await approve(reviewed.approval)).toMatchObject({ httpStatus: 409, body: { code: "SHIPMENT_MEASUREMENTS_STALE" } });
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back historical posting deltas with measurement, snapshot and inventory writes when the approval audit fails", async () => {
    await prepareHistoricalShares(); await approveHistoricalDestination("historical_cogs");
    const reviewed = await review(), before = await snapshot();
    await query(`CREATE FUNCTION procurement.reject_historical_measurement_approval() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='procurement.shipment.measurements_corrected' THEN RAISE EXCEPTION 'injected historical approval failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_historical_measurement_approval BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION procurement.reject_historical_measurement_approval()`);
    try { await expect(approve(reviewed.approval)).rejects.toThrow(); }
    finally { await query("DROP TRIGGER reject_historical_measurement_approval ON public.audit_events; DROP FUNCTION procurement.reject_historical_measurement_approval()"); }
    expect(await snapshot()).toEqual(before);
  });

  it.each(["lead-user", "custom-user", "scoped-user"])("rejects %s despite session role strings or scoped purchasing grants", async actor => {
    await prepare(); const input = await request(); const before = await snapshot();
    await expect(service().preview(1, input, actor)).rejects.toMatchObject({ code: "SHIPMENT_MEASUREMENTS_ADMIN_REQUIRED", statusCode: 403 });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects a changed charge after preview without saving measurements or cost writes", async () => {
    await prepare(); const reviewed = await review();
    await query("UPDATE procurement.inbound_freight_costs SET actual_cents=5100 WHERE id=31");
    const before = await snapshot();
    expect(await approve(reviewed.approval)).toMatchObject({ httpStatus: 409, body: { code: "SHIPMENT_MEASUREMENTS_STALE" } });
    expect(await snapshot()).toEqual(before);
  });
  it("rechecks live administrator membership after preview", async () => {
    await prepare(); const reviewed = await review();
    await query("DELETE FROM identity.auth_user_roles WHERE user_id='admin-user'");
    const before = await snapshot();
    expect(await approve(reviewed.approval)).toMatchObject({ httpStatus: 403, body: { code: "SHIPMENT_MEASUREMENTS_ADMIN_REQUIRED" } });
    expect(await snapshot()).toEqual(before);
  });
  it("cannot edit a line belonging to another shipment", async () => {
    await prepare(); const input = await request(); input.lines[0].lineId = 999;
    const before = await snapshot();
    await expect(service().preview(1, input, "admin-user")).rejects.toMatchObject({ code: "SHIPMENT_MEASUREMENTS_LINE_INVALID" });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects changed cost impact even with a current source token", async () => {
    await prepare(); const reviewed = await review();
    reviewed.approval.previewVersion = "0".repeat(64);
    const before = await snapshot();
    expect(await approve(reviewed.approval)).toMatchObject({ httpStatus: 409, body: { code: "SHIPMENT_MEASUREMENTS_STALE" } });
    expect(await snapshot()).toEqual(before);
  });

  it("replays a lost response without applying the correction, adjustment or admin approval twice", async () => {
    await prepare(); const reviewed = await review(), key = randomUUID();
    expect((await approve(reviewed.approval, key)).httpStatus).toBe(200);
    const saved = await snapshot();
    expect(await approve(reviewed.approval, key)).toMatchObject({ httpStatus: 200, replayed: true });
    expect(await snapshot()).toEqual(saved);
  });

  it("serializes competing approvals and rejects the stale edit", async () => {
    await prepare(); const reviewed = await review();
    const results = await Promise.all([approve(reviewed.approval), approve(reviewed.approval)]);
    expect(results.map(result => result.httpStatus).sort()).toEqual([200, 409]);
    expect((await service().context(1, "admin-user")).approvals).toHaveLength(1);
  });

  it("rolls all measurement, allocation and downstream writes back when approval audit persistence fails", async () => {
    await prepare(); const reviewed = await review(), before = await snapshot();
    await query(`CREATE FUNCTION procurement.reject_measurement_approval() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='procurement.shipment.measurements_corrected' THEN RAISE EXCEPTION 'injected approval failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_measurement_approval BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION procurement.reject_measurement_approval()`);
    try { await expect(approve(reviewed.approval)).rejects.toThrow(); }
    finally { await query("DROP TRIGGER reject_measurement_approval ON public.audit_events; DROP FUNCTION procurement.reject_measurement_approval()"); }
    expect(await snapshot()).toEqual(before);
  });
  });
}
