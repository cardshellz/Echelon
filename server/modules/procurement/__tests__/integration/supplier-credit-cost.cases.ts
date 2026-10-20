import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import type { AmendmentDatabase, AmendmentTransaction } from "../../po-quantity-amendment.repository";
import type { SourceLineInput } from "@shared/procurement/supplier-credit";
import { approveSupplierCreditSources, voidSupplierCreditSources, validateSupplierCreditSourceLines, readSupplierCreditCostStatus } from "../../supplier-credit-source.service";
import { readPoShipmentCosts } from "../../po-shipment-cost-summary.repository";
import { readPurchaseCostStatus } from "../../purchase-cost-status.repository";
import { executeReceivingCustodyCommand } from "../../receiving-quarantine.service";
import type { ReceivingService } from "../../receiving.service";
import { receivingUnitVersion, type ReceiptUnitLine } from "../../receiving-unit-contract";
import { prepareShipmentCostRevisions } from "../../shipment-cost-application.service";
import { loadSupplierCreditSource } from "../../supplier-credit.repository";
import { purchaseCostNextAction } from "@shared/procurement/purchase-cost-status";

export function registerSupplierCreditCostCases(fixture: {
  pool: () => pg.Pool;
  database: () => AmendmentDatabase & Pick<AmendmentTransaction, "execute">;
  at: Date; actorId: string;
  receive: () => Promise<unknown>;
  approveInvoice: () => Promise<unknown>;
  transferAndSell: () => Promise<void>;
  physicalSnapshot: () => Promise<unknown>;
  receiving: () => ReceivingService;
  prepareQuarantineReceipt: (scope?: { shipmentId: number; purchaseOrderId: number }) => Promise<{ receiptId: number; line: ReceiptUnitLine }>;
  closeShort: () => Promise<unknown>;
  updateFreight: () => Promise<unknown>;
}) {
  const query = (text: string, values: unknown[] = []) => fixture.pool().query(text, values);
  const context = { actorId: fixture.actorId, at: fixture.at };
  async function approve(lines: SourceLineInput[], invoiceId = 71) {
    return fixture.database().transaction(async tx => {
      const validated = await validateSupplierCreditSourceLines(tx, { ...context, invoiceId, lines });
      const source = await loadSupplierCreditSource(tx, invoiceId);
      const inserted = await tx.execute(sql`INSERT INTO procurement.supplier_credits
        (source_invoice_id,vendor_id,source_snapshot,supplier_reference,credit_calendar_date,total_amount_cents,currency,status,reason,created_by,created_at)
        VALUES(${invoiceId},5,${JSON.stringify(source.sourceSnapshot)}::jsonb,${randomUUID()},'2026-09-06',${lines.reduce((sum, line) => sum + line.amountCents, 0)},'USD','draft','Supplier document received',${context.actorId},${context.at}) RETURNING id`);
      const creditId = Number(inserted.rows[0].id);
      for (const [index, line] of lines.entries()) {
        const sourceKey = line.disposition.kind === "price_reduction" ? `price_reduction:${line.disposition.component}` : `quarantine_return:${line.disposition.returnDispositionId}`;
        await tx.execute(sql`INSERT INTO procurement.supplier_credit_lines
          (supplier_credit_id,invoice_line_id,source_key,amount_cents,disposition,source_evidence,cost_state,cost_issues,created_at)
          VALUES(${creditId},${line.invoiceLineId},${sourceKey},${line.amountCents},${JSON.stringify(line.disposition)}::jsonb,
            ${JSON.stringify(validated[index].sourceEvidence)}::jsonb,${validated[index].costState},${JSON.stringify(validated[index].costIssues)}::jsonb,${context.at})`);
      }
      await tx.execute(sql`UPDATE procurement.supplier_credits SET status='approved',approved_by=${context.actorId},approved_at=${context.at},version=version+1 WHERE id=${creditId}`);
      return { creditId, result: await approveSupplierCreditSources(tx, { ...context, creditId }) };
    });
  }
  async function voidCredit(creditId: number) {
    return fixture.database().transaction(async tx => {
      await tx.execute(sql`UPDATE procurement.supplier_credits SET status='voided',voided_by=${context.actorId},voided_at=${context.at},void_reason='Supplier corrected credit',version=version+1 WHERE id=${creditId}`);
      return voidSupplierCreditSources(tx, { ...context, creditId });
    });
  }
  const price: SourceLineInput = { invoiceLineId: 72, amountCents: 2000, disposition: { kind: "price_reduction", component: "product" } };

  it("supplier credit reduces product and packaging through transferred stock and sold COGS, and void compensates once", async () => {
    await fixture.receive(); await fixture.transferAndSell(); await fixture.approveInvoice();
    const physical = await fixture.physicalSnapshot();
    const gross = (await query("SELECT line_total_cents,cost_component_evidence FROM procurement.vendor_invoice_lines WHERE id=72")).rows;
    const result = await approve([price, { ...price, amountCents: 200, disposition: { kind: "price_reduction", component: "packaging" } }]);
    expect(result.result.costStatus).toBe("posted");
    expect((await query("SELECT po_unit_cost_mills::text AS product,packaging_cost_mills::text AS packaging FROM inventory.inventory_lots ORDER BY id")).rows)
      .toEqual([{ product: "550000", packaging: "45000" }, { product: "550000", packaging: "45000" }]);
    expect((await query("SELECT total_cost_mills::text AS amount FROM oms.order_item_costs")).rows).toEqual([{ amount: "595000" }]);
    expect((await query("SELECT line_total_cents,cost_component_evidence FROM procurement.vendor_invoice_lines WHERE id=72")).rows).toEqual(gross);
    expect(await fixture.physicalSnapshot()).toEqual(physical);
    const beforeReplay = (await query("SELECT count(*)::int AS count FROM procurement.cost_source_revisions")).rows;
    await fixture.database().transaction(tx => approveSupplierCreditSources(tx, { ...context, creditId: result.creditId }));
    expect((await query("SELECT count(*)::int AS count FROM procurement.cost_source_revisions")).rows).toEqual(beforeReplay);
    expect((await voidCredit(result.creditId)).costStatus).toBe("posted");
    expect((await query("SELECT total_cost_mills::text AS amount FROM oms.order_item_costs")).rows).toEqual([{ amount: "650000" }]);
    expect(await fixture.physicalSnapshot()).toEqual(physical);
    const current = await fixture.database().transaction(tx => readPurchaseCostStatus(tx, [21]));
    expect(current.lines[0].components.every(component => component.status === "applied")).toBe(true);
  });

  it("supplier credit component cap rejects cumulative approvals without partial cost effects", async () => {
    await fixture.receive(); await fixture.approveInvoice();
    const first = await approve([{ ...price, amountCents: 13000 }]);
    const before = (await query("SELECT * FROM inventory.cost_applications ORDER BY id")).rows;
    await expect(approve([{ ...price, amountCents: 13000 }])).rejects.toMatchObject({ code: "CREDIT_SOURCE_EXCEEDED" });
    expect((await query("SELECT * FROM inventory.cost_applications ORDER BY id")).rows).toEqual(before);
    expect((await query("SELECT count(*)::int AS count FROM procurement.supplier_credits")).rows[0].count).toBe(1);
    expect(first.result.costStatus).toBe("posted");
  });

  it("supplier credit cost write failure rolls back credit, source revisions and sold COGS together", async () => {
    await fixture.receive(); await fixture.transferAndSell(); await fixture.approveInvoice();
    const before = (await query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows;
    const revisions = (await query("SELECT * FROM procurement.cost_source_revisions ORDER BY id")).rows;
    await query(`CREATE FUNCTION inventory.credit_cost_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'credit cost audit failure'; END $$;
      CREATE TRIGGER credit_cost_failure BEFORE INSERT ON inventory.cost_reporting_events FOR EACH ROW EXECUTE FUNCTION inventory.credit_cost_failure()`);
    try { await expect(approve([price])).rejects.toThrow("credit cost audit failure"); }
    finally { await query("DROP TRIGGER credit_cost_failure ON inventory.cost_reporting_events; DROP FUNCTION inventory.credit_cost_failure()"); }
    expect((await query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows).toEqual(before);
    expect((await query("SELECT * FROM procurement.cost_source_revisions ORDER BY id")).rows).toEqual(revisions);
    expect((await query("SELECT count(*)::int AS count FROM procurement.supplier_credits")).rows[0].count).toBe(0);
  });

  it("supplier credit status detects changed invoice evidence after a successful application", async () => {
    await fixture.receive(); await fixture.approveInvoice();
    const result = await approve([price]);
    await query(`UPDATE procurement.vendor_invoice_lines SET cost_component_evidence=jsonb_set(jsonb_set(cost_component_evidence,'{productMills}','2300000'),'{packagingMills}','300000') WHERE id=72`);
    const current = await fixture.database().transaction(tx => readSupplierCreditCostStatus(tx, { creditId: result.creditId }));
    expect(current.costStatus).toBe("review_required");
    expect(current.costIssues.some(issue => issue.code === "CREDIT_SOURCE_CHANGED")).toBe(true);
    const evidence = (await query("SELECT source_evidence FROM procurement.supplier_credit_lines WHERE supplier_credit_id=$1", [result.creditId])).rows;
    await expect(fixture.database().transaction(tx => approveSupplierCreditSources(tx, { ...context, creditId: result.creditId })))
      .rejects.toMatchObject({ code: "CREDIT_SOURCE_CHANGED" });
    expect((await query("SELECT source_evidence FROM procurement.supplier_credit_lines WHERE supplier_credit_id=$1", [result.creditId])).rows).toEqual(evidence);
  });

  it("landed supplier credit posts net source across shipment and PO screens without rewriting gross charge allocations", async () => {
    await fixture.receive(); await fixture.approveInvoice();
    await query(`INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,inbound_shipment_id,status,invoiced_amount_cents,balance_cents)
      VALUES(73,'FREIGHT-SOURCE',5,1,'approved',5000,5000);
      INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,freight_cost_id,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents)
      VALUES(74,73,1,31,1,5000,500000,5000);
      UPDATE procurement.inbound_freight_costs SET vendor_id=5,vendor_invoice_id=73 WHERE id=31`);
    await fixture.updateFreight();
    const gross = (await query("SELECT * FROM procurement.inbound_freight_allocations ORDER BY id")).rows;
    const result = await approve([{ invoiceLineId: 74, amountCents: 1000, disposition: { kind: "price_reduction", component: "landed" } }], 73);
    expect(result.result.costStatus).toBe("posted");
    const po = await readPoShipmentCosts(fixture.database(), 10);
    expect(po?.lines[0]).toMatchObject({ status: "applied", allocatedCents: 4000 });
    expect(po?.summary.freightCents).toBe(4000);
    expect((await query("SELECT landed_cost_mills::text AS freight FROM inventory.inventory_lots")).rows[0].freight).toBe("200000");
    expect((await query("SELECT * FROM procurement.inbound_freight_allocations ORDER BY id")).rows).toEqual(gross);
    expect((await voidCredit(result.creditId)).costStatus).toBe("posted");
    expect((await readPoShipmentCosts(fixture.database(), 10))?.lines[0]).toMatchObject({ status: "applied", allocatedCents: 5000 });
  });

  it("legacy positive-plus-negative shipment charges remain explicit review rather than an invented supplier-credit disposition", async () => {
    await fixture.receive(); await fixture.updateFreight();
    await query(`INSERT INTO procurement.inbound_freight_costs(id,inbound_shipment_id,cost_type,actual_cents,allocation_method,cost_status,currency,exchange_rate)
      VALUES(32,1,'freight',-1000,'by_line_count','finalized','USD',1);
      INSERT INTO procurement.inbound_freight_allocations(shipment_cost_id,inbound_shipment_line_id,allocated_cents,allocation_basis_value,allocation_basis_total)
      VALUES(32,11,-1000,1,1);
      UPDATE procurement.landed_cost_snapshots SET freight_allocated_cents=4000 WHERE inbound_shipment_line_id=11`);
    const result = await fixture.database().transaction(tx => prepareShipmentCostRevisions(tx, 1));
    expect(result.proposals[0].input).toMatchObject({ totalMills: 400000, evidence: "review_required", issue: { code: "LANDED_ALLOCATION_STALE" } });
  });

  it("quarantine return credits prove partial posting, full-return review and custody caps without another physical movement", async () => {
    await query(`UPDATE procurement.purchase_order_lines SET order_qty=100,total_product_cost_cents=10000,packaging_cost_cents=1000,line_total_cents=11000 WHERE id=21;
      UPDATE procurement.vendor_invoice_lines SET qty_invoiced=100,line_total_cents=13000,cost_component_evidence='{"contractVersion":1,"packagingTreatment":"separate","productMills":1200000,"packagingMills":100000,"adjustmentMills":0,"source":"operator_review"}' WHERE id=72;
      UPDATE procurement.vendor_invoices SET invoiced_amount_cents=13000,balance_cents=13000,status='approved' WHERE id=71;
      INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES(2,'inventory','adjust','inventory');
      INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES(1,2);
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code,location_type) VALUES(100,1,'CREDIT-QUARANTINE','quarantine')`);
    const receipt = await fixture.prepareQuarantineReceipt();
    const intake = await fixture.database().transaction(tx => executeReceivingCustodyCommand(tx, fixture.receiving(), {
      command: "intake", resourceId: receipt.receiptId, actorId: "admin-user", at: fixture.at, commandKey: randomUUID(),
      body: { kind: "receipt_line", receivingLineId: Number(receipt.line.id), expectedUnitVersion: receivingUnitVersion(receipt.line),
        acceptedQty: 1, heldQty: 1, countsReviewed: true, holdingLocationId: 100, condition: "damaged", reason: "Damaged outer case", evidenceReference: "INSPECT-1" },
    }));
    const observationId = intake.observation.id;
    await fixture.database().transaction(tx => executeReceivingCustodyCommand(tx, fixture.receiving(), {
      command: "return", resourceId: observationId, actorId: "admin-user", at: fixture.at, commandKey: randomUUID(),
      body: { expectedVersion: 0, observationQty: 1, reason: "Collected by supplier", evidenceReference: "COLLECT-1" },
    }));
    await fixture.receiving().close(receipt.receiptId, fixture.actorId);
    await fixture.closeShort();
    const source = (await query("SELECT id FROM procurement.receiving_quarantine_dispositions WHERE kind='return'")).rows[0];
    const physical = await fixture.physicalSnapshot();
    const returnLine: SourceLineInput = { invoiceLineId: 72, amountCents: 6500,
      disposition: { kind: "quarantine_return", returnDispositionId: Number(source.id), quantity: 1, evidenceReference: "COLLECT-1" } };
    const competing = await Promise.allSettled([approve([returnLine]), approve([returnLine])]);
    expect(competing.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(competing.filter(value => value.status === "rejected")).toMatchObject([{ reason: { code: "CREDIT_RETURN_QUANTITY_EXCEEDED" } }]);
    const success = competing.find(value => value.status === "fulfilled");
    if (!success || success.status !== "fulfilled") throw new Error("One physical return credit must win");
    const result = success.value;
    expect(result.result.costStatus).toBe("posted");
    expect((await query("SELECT po_unit_cost_mills::text AS product,packaging_cost_mills::text AS packaging FROM inventory.inventory_lots")).rows)
      .toEqual([{ product: "600000", packaging: "50000" }]);
    expect(await fixture.physicalSnapshot()).toEqual(physical);
    await expect(approve([{ invoiceLineId: 72, amountCents: 6500,
      disposition: { kind: "quarantine_return", returnDispositionId: Number(source.id), quantity: 1, evidenceReference: "COLLECT-1" } }]))
      .rejects.toMatchObject({ code: "CREDIT_RETURN_QUANTITY_EXCEEDED" });
    await voidCredit(result.creditId);
    expect(await fixture.physicalSnapshot()).toEqual(physical);
    const difference = await approve([{ ...returnLine, amountCents: 6400 }]);
    expect(difference.result.costStatus).toBe("review_required");
    expect(difference.result.costIssues.some(issue => issue.code === "CREDIT_RETURN_VALUE_REVIEW")).toBe(true);
    expect(await fixture.physicalSnapshot()).toEqual(physical);

    // Keep the second custody scenario in this final fixture case: the existing
    // shared reset must never erase the first immutable return's history.
    await query(`INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,warehouse_id)
        VALUES(20,'FULL-RETURN-PO',5,'sent',1);
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,product_variant_id,expected_receive_variant_id,expected_receive_units_per_variant,sku,
        order_qty,unit_cost_cents,unit_cost_mills,total_product_cost_cents,packaging_cost_cents,line_total_cents,status)
        VALUES(22,20,1,100,200,200,50,'AUDIT-PRODUCT',100,100,10000,10000,1000,11000,'open');
      INSERT INTO procurement.inbound_shipments(id,shipment_number,status,allocation_method_default)
        VALUES(2,'FULL-RETURN-SHIP','costing','by_line_count');
      INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,product_variant_id,sku,qty_shipped,carton_count,allocated_cost_cents)
        VALUES(12,2,20,22,200,'AUDIT-PRODUCT',100,2,0);
      INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,status,invoiced_amount_cents,balance_cents)
        VALUES(75,'FULL-RETURN-INVOICE',5,'approved',13000,13000);
      INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,purchase_order_line_id,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents,cost_component_evidence)
        VALUES(76,75,1,22,100,120,12000,13000,'{"contractVersion":1,"packagingTreatment":"separate","productMills":1200000,"packagingMills":100000,"adjustmentMills":0,"source":"operator_review"}'::jsonb)`);
    const fullReceipt = await fixture.prepareQuarantineReceipt({ shipmentId: 2, purchaseOrderId: 20 });
    const fullIntake = await fixture.database().transaction(tx => executeReceivingCustodyCommand(tx, fixture.receiving(), {
      command: "intake", resourceId: fullReceipt.receiptId, actorId: "admin-user", at: fixture.at, commandKey: randomUUID(),
      body: { kind: "receipt_line", receivingLineId: Number(fullReceipt.line.id), expectedUnitVersion: receivingUnitVersion(fullReceipt.line),
        acceptedQty: 0, heldQty: 2, countsReviewed: true, holdingLocationId: 100, condition: "damaged", reason: "All cases damaged", evidenceReference: "INSPECT-FULL" },
    }));
    await fixture.database().transaction(tx => executeReceivingCustodyCommand(tx, fixture.receiving(), {
      command: "return", resourceId: fullIntake.observation.id, actorId: "admin-user", at: fixture.at, commandKey: randomUUID(),
      body: { expectedVersion: 0, observationQty: 2, reason: "Supplier collected every case", evidenceReference: "COLLECT-FULL" },
    }));
    await fixture.receiving().close(fullReceipt.receiptId, fixture.actorId);
    const fullDisposition = (await query("SELECT id FROM procurement.receiving_quarantine_dispositions WHERE observation_id=$1 AND kind='return'", [fullIntake.observation.id])).rows[0];
    const fullPhysical = await fixture.physicalSnapshot();
    const soldCosts = (await query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows;
    const fullCredit = await approve([{ invoiceLineId: 76, amountCents: 13000,
      disposition: { kind: "quarantine_return", returnDispositionId: Number(fullDisposition.id), quantity: 2, evidenceReference: "COLLECT-FULL" } }], 75);
    expect(fullCredit.result.costStatus).toBe("review_required");
    expect(fullCredit.result.costIssues.every(issue => issue.code === "CREDIT_FULL_QUARANTINE_RETURN_COST_REVIEW")).toBe(true);
    expect((await query("SELECT status FROM procurement.supplier_credits WHERE id=$1", [fullCredit.creditId])).rows).toEqual([{ status: "approved" }]);
    expect((await query("SELECT count(*)::int AS count FROM inventory.inventory_lots WHERE po_line_id=22")).rows[0].count).toBe(0);
    expect((await query("SELECT count(*)::int AS count FROM inventory.lot_cost_origins WHERE purchase_order_line_id=22")).rows[0].count).toBe(0);
    const fullCosts = await fixture.database().transaction(tx => readPurchaseCostStatus(tx, [22]));
    expect(fullCosts.lines[0].components.every(component => component.status === "review_required")).toBe(true);
    expect(purchaseCostNextAction(fullCosts.lines[0])).toBe("review");
    const fullApplications = (await query(`SELECT application.* FROM inventory.cost_applications application
      JOIN procurement.cost_source_revisions revision ON revision.id=application.source_revision_id WHERE revision.purchase_order_line_id=22 ORDER BY application.id`)).rows;
    expect(fullApplications).toHaveLength(2);
    expect(fullApplications.every(application => application.status === "review_required" && application.evidence.result.lotsUpdated === 0 && application.evidence.result.cogsRowsUpdated === 0)).toBe(true);
    expect((await query(`SELECT count(*)::int AS count FROM inventory.cost_reporting_events event
      JOIN inventory.cost_applications application ON application.id=event.application_id
      JOIN procurement.cost_source_revisions revision ON revision.id=application.source_revision_id WHERE revision.purchase_order_line_id=22`)).rows[0].count).toBe(0);
    await fixture.database().transaction(tx => approveSupplierCreditSources(tx, { ...context, creditId: fullCredit.creditId }));
    expect((await query(`SELECT application.* FROM inventory.cost_applications application
      JOIN procurement.cost_source_revisions revision ON revision.id=application.source_revision_id WHERE revision.purchase_order_line_id=22 ORDER BY application.id`)).rows).toEqual(fullApplications);
    expect(await fixture.physicalSnapshot()).toEqual(fullPhysical);
    expect((await query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows).toEqual(soldCosts);
    expect((await query("SELECT invoiced_amount_cents,balance_cents FROM procurement.vendor_invoices WHERE id=75")).rows)
      .toEqual([{ invoiced_amount_cents: "13000", balance_cents: "13000" }]);
  });
}
