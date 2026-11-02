import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import { purchaseTaxContextSchema, purchaseTaxPreviewSchema, purchaseTaxResultSchema,
  type PurchaseTaxChange, type PurchaseTaxTarget } from "@shared/procurement/purchase-tax";
import { createPurchaseTaxChangeService } from "../../purchase-tax-change.service";
import { registerPurchaseTaxRoutes } from "../../purchase-tax.routes";
import { readPurchaseCostStatus } from "../../purchase-cost-status.repository";
import { readPoShipmentCosts } from "../../po-shipment-cost-summary.repository";
import type { AmendmentDatabase, AmendmentTransaction } from "../../po-quantity-amendment.repository";
import type { ShipmentTrackingService } from "../../shipment-tracking.service";
import { createShipmentCostReconciliationService, shipmentReconciliationScope } from "../../shipment-cost-reconciliation.service";
import { costFingerprint, lockInventoryCostGraph } from "../../../inventory/infrastructure/cost-evidence.repository";
import { readPoTaxEvidence } from "../../purchase-tax-evidence.repository";
import { purchaseTaxAmounts } from "../../domain/purchase-tax";

/** Registered inside the existing real receipt/AP/freight fixture. HTTP, IAM,
 * commands, SQL, receiving and cost owners are real; only the clock is fixed. */
export function registerPurchaseTaxCases(fixture: {
  pool: () => pg.Pool; database: () => AmendmentDatabase & Pick<AmendmentTransaction, "execute">; actorId: string; at: Date;
  receive: () => Promise<unknown>; consume: () => Promise<unknown>; shipments: () => ShipmentTrackingService;
  historicalGaps: () => Promise<unknown>;
}) {
  const query = (text: string, values?: unknown[]) => fixture.pool().query(text, values);
  let server: Server, endpoint: string, actorId: string;
  const po = { kind: "purchase_order", id: 10 } as const;
  async function setup(treatment: "inventory" | "recoverable" = "inventory") {
    actorId = fixture.actorId;
    await query(`INSERT INTO procurement.purchase_tax_types(id,code,name,treatment,revision,created_at,updated_at,updated_by)
      VALUES(1,'TAX','Supplier tax',$1,1,$2,$2,$3),(2,'OTHER','Other tax','recoverable',1,$2,$2,$3)`, [treatment, fixture.at, actorId]);
    await query(`UPDATE procurement.purchase_order_lines SET order_qty=100,total_product_cost_cents=10000,packaging_cost_cents=1000,line_total_cents=11000 WHERE id=21;
      UPDATE procurement.purchase_orders SET tax_type_id=1,tax_cents=1000,subtotal_cents=11000,total_cents=12000 WHERE id=10;
      UPDATE procurement.inbound_freight_costs SET actual_cents=0 WHERE id=31`);
  }
  async function context(target: PurchaseTaxTarget) {
    const response = await requestLocalHttp(`${endpoint}/tax-review/${target.kind}/${target.id ?? "new"}`);
    expect(response.status).toBe(200); return purchaseTaxContextSchema.parse(await response.json());
  }
  async function post(path: string, body: unknown, key?: string) {
    const response = await requestLocalHttp(`${endpoint}/tax-changes${path}`, { method: "POST", headers: {
      "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}),
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), replayed: response.headers.get("Idempotency-Replayed"),
      retryAfter: response.headers.get("Retry-After") };
  }
  async function review(change: PurchaseTaxChange) {
    const current = await context({ kind: change.kind, id: change.id } as PurchaseTaxTarget);
    const draft = { sourceVersion: current.sourceVersion, change }, response = await post("/preview", draft);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const preview = purchaseTaxPreviewSchema.parse(response.body);
    return { preview, request: { ...draft, previewVersion: preview.previewVersion, reason: "Supplier invoice and tax treatment verified", approvalConfirmed: true } };
  }
  const typeChange = (treatment: "inventory" | "recoverable"): Extract<PurchaseTaxChange, { kind: "tax_type" }> => ({ kind: "tax_type", id: 1, code: "TAX", name: "Supplier tax", treatment });
  async function state() {
    const tables = ["procurement.purchase_tax_types", "procurement.vendor_invoice_line_taxes", "procurement.purchase_orders", "procurement.purchase_order_lines",
      "procurement.vendor_invoice_lines", "procurement.vendor_invoices", "procurement.inbound_freight_costs", "procurement.inbound_freight_allocations",
      "procurement.landed_cost_snapshots", "procurement.landed_cost_adjustments", "procurement.po_events", "inventory.inventory_lots",
      "inventory.cost_applications", "procurement.cost_source_revisions", "inventory.cost_reporting_events", "inventory.cost_reconciliation_approvals",
      "inventory.cost_reconciliation_postings", "inventory.lot_cost_quantity_bases", "inventory.lot_cost_quantity_allocations", "oms.order_item_costs"];
    return Promise.all(tables.map(async table => ({ table, rows: (await query(`SELECT to_jsonb(row) AS value FROM ${table} row ORDER BY to_jsonb(row)::text`)).rows })));
  }
  async function physical() {
    const tables = ["procurement.po_receipts", "procurement.receiving_lines", "procurement.ap_payments", "procurement.ap_payment_allocations"];
    return { rows: await Promise.all(tables.map(async table => ({ table, rows: (await query(`SELECT to_jsonb(row) AS value FROM ${table} row ORDER BY to_jsonb(row)::text`)).rows }))),
      shipping: (await query("SELECT id,qty_shipped,carton_count,total_weight_kg,total_volume_cbm FROM procurement.inbound_shipment_lines ORDER BY id")).rows,
      stock: (await query("SELECT id,qty_received,qty_on_hand,qty_picked,qty_packed FROM inventory.inventory_lots ORDER BY id")).rows,
      bills: (await query("SELECT id,invoiced_amount_cents,paid_amount_cents,balance_cents FROM procurement.vendor_invoices ORDER BY id")).rows };
  }
  async function lotTotals() {
    return (await query("SELECT product_total_cost_mills,packaging_total_cost_mills,landed_total_cost_mills FROM inventory.inventory_lots ORDER BY id")).rows;
  }
  async function applyShipment() {
    await fixture.shipments().finalizeAllocations(1, actorId); await fixture.shipments().pushLandedCostsToLots(1, actorId);
  }
  describe("configured purchase tax through HTTP, receiving and existing cost owners", () => {
    beforeAll(async () => {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { user: { id: actorId, role: "admin" } }; next(); });
      registerPurchaseTaxRoutes(app, createPurchaseTaxChangeService(fixture.database(), fixture.shipments(), () => fixture.at));
      server = createServer(app); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/purchasing`;
    });
    afterAll(async () => { if (server) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); });

    it("creates a tax type only after an admin reviews it and replays a lost response", async () => {
      actorId = fixture.actorId; const before = await state();
      const { preview, request } = await review({ kind: "tax_type", id: null, code: "VAT", name: "Supplier VAT", treatment: "recoverable" });
      expect(await state()).toEqual(before); expect(preview.impact.applications).toEqual([]);
      const key = randomUUID(), first = await post("", request, key); expect(first.status, JSON.stringify(first.body)).toBe(200);
      purchaseTaxResultSchema.parse(first.body); const saved = await state();
      expect(await post("", request, key)).toMatchObject({ status: 200, replayed: "true", body: first.body });
      expect(await state()).toEqual(saved);
      expect((await query("SELECT code,treatment,revision FROM procurement.purchase_tax_types")).rows).toEqual([{ code: "VAT", treatment: "recoverable", revision: 1 }]);
    });

    it("rejects a duplicate tax code before changing any source or posting", async () => {
      await setup(); const current = await context({ kind: "tax_type", id: null }), before = await state();
      expect(await post("/preview", { sourceVersion: current.sourceVersion, change: { kind: "tax_type", id: null, code: "TAX", name: "Duplicate", treatment: "recoverable" } }))
        .toMatchObject({ status: 409, body: { code: "PURCHASE_TAX_CODE_EXISTS" } });
      expect(await state()).toEqual(before);
    });

    it.each(["inventory", "recoverable"] as const)("uses %s PO tax when receiving saved 50-piece packs", async treatment => {
      await setup(treatment); await fixture.receive();
      expect(await lotTotals()).toEqual([{ product_total_cost_mills: treatment === "inventory" ? "1100000" : "1000000", packaging_total_cost_mills: "100000", landed_total_cost_mills: "0" }]);
      expect((await query("SELECT qty_received FROM procurement.po_receipts")).rows).toEqual([{ qty_received: 100 }]);
      expect((await query("SELECT qty_received FROM inventory.inventory_lots")).rows).toEqual([{ qty_received: 2 }]);
      expect((await fixture.shipments().getEnrichedLines(1))[0].landedUnitCostMills).toBe(treatment === "inventory" ? 12000 : 11000);
    });

    it("approves the tax rule before receipt and inherits it without a second receiving choice or approval", async () => {
      await setup(); const current = await context(po);
      if (current.current?.kind !== "purchase_order") throw new Error("Missing PO tax context");
      const { preview, request } = await review({ ...current.current, taxTypeId: 2 });
      expect(preview.impact.inventoryValues).toEqual([]);
      expect((await query("SELECT count(*)::int AS count FROM inventory.inventory_lots")).rows[0].count).toBe(0);
      const saved = await post("", request, randomUUID()); expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      await fixture.receive(); expect(await lotTotals()).toMatchObject([{ product_total_cost_mills: "1000000", packaging_total_cost_mills: "100000" }]);
      expect((await query("SELECT count(*)::int AS count FROM public.audit_events WHERE action='procurement.tax.approved' AND actor=$1", [actorId])).rows[0].count).toBe(1);
    });

    it("measures and posts an approved global treatment change without changing documents or stock", async () => {
      await setup(); await fixture.receive(); await applyShipment(); const before = await state(), unchanged = await physical();
      const { preview, request } = await review(typeChange("recoverable"));
      expect(await state()).toEqual(before);
      expect(preview.before.find(row => row.kind === "purchase_order")).toMatchObject({ taxMills: 100000, inventoryMills: 100000, recoverableMills: 0 });
      expect(preview.after.find(row => row.kind === "purchase_order")).toMatchObject({ taxMills: 100000, inventoryMills: 0, recoverableMills: 100000 });
      expect(preview.impact.inventoryValues).toMatchObject([{ onHandUnits: 2, onHandValueMills: { before: 1200000, after: 1100000 } }]);
      expect((await post("", request, randomUUID())).status).toBe(200); expect(await physical()).toEqual(unchanged);
      expect(await lotTotals()).toEqual([{ product_total_cost_mills: "1000000", packaging_total_cost_mills: "100000", landed_total_cost_mills: "0" }]);
      const costs = await readPoShipmentCosts(fixture.database(), 10);
      expect(costs?.taxCosts).toMatchObject({ supplierInventoryCents: 11000, recoverableSupplierTaxCents: 1000, inventoryLandedCents: 11000 });
      expect((await context({ kind: "tax_type", id: 1 })).approvals).toMatchObject([{ actorName: expect.any(String), reason: request.reason }]);
      expect((await query("SELECT payload_json FROM procurement.po_events WHERE event_type='tax_treatment_approved'")).rows[0].payload_json.preview).toMatchObject({ previewVersion: preview.previewVersion });
    });

    it("uses the same approval for PO defaults and inherited line treatments", async () => {
      await setup(); await fixture.receive(); await applyShipment(); const current = await context(po);
      if (current.current?.kind !== "purchase_order") throw new Error("Missing PO tax context");
      const { request } = await review({ ...current.current, taxTypeId: 2 });
      expect((await post("", request, randomUUID())).status).toBe(200);
      expect((await query("SELECT tax_type_id FROM procurement.purchase_order_lines WHERE id=21")).rows[0].tax_type_id).toBeNull();
      expect(await lotTotals()).toMatchObject([{ product_total_cost_mills: "1000000" }]);
    });

    it("uses actual invoice tax instead of adding the PO tax twice", async () => {
      await setup(); await fixture.receive(); await applyShipment();
      await query(`UPDATE procurement.vendor_invoices SET status='approved',invoiced_amount_cents=13000,balance_cents=13000 WHERE id=71;
        UPDATE procurement.vendor_invoice_lines SET qty_invoiced=100,line_total_cents=13000,cost_component_evidence=NULL WHERE id=72`);
      const unchanged = await physical(), { preview, request } = await review({ kind: "invoice_line", id: 72, taxes: [{ taxTypeId: 2, amountMills: 100000 }],
        components: { contractVersion: 1, source: "operator_review", productMills: 1100000, packagingMills: 100000, adjustmentMills: 100000, packagingTreatment: "separate" } });
      expect(preview.impact.inventoryValues).toMatchObject([{ onHandValueMills: { after: 1200000 } }]);
      expect((await post("", request, randomUUID())).status).toBe(200); expect(await physical()).toEqual(unchanged);
      expect(await lotTotals()).toMatchObject([{ product_total_cost_mills: "1100000", packaging_total_cost_mills: "100000" }]);
      const costs = await readPoShipmentCosts(fixture.database(), 10);
      expect(costs?.taxCosts).toMatchObject({ supplierInventoryCents: 12000, recoverableSupplierTaxCents: 1000 });
      expect((await fixture.shipments().getEnrichedLines(1))[0].landedUnitCostMills).toBe(12000);
    });

    it("changes tracked order cost basis without inventing a historical expense", async () => {
      await setup(); await fixture.receive(); await applyShipment(); await fixture.consume(); const unchanged = await physical();
      const { preview, request } = await review(typeChange("recoverable"));
      expect(preview.impact).toMatchObject({ orderCosts: [{ totalMills: { before: 600000, after: 550000 } }], historicalCosts: [] });
      expect((await post("", request, randomUUID())).status).toBe(200); expect(await physical()).toEqual(unchanged);
      expect((await query("SELECT count(*)::int AS count FROM inventory.cost_reconciliation_postings")).rows[0].count).toBe(0);
    });

    it("keeps gross shipment charge shares while excluding recoverable tax from landed costs", async () => {
      await setup(); await query("UPDATE procurement.purchase_orders SET tax_cents=0,total_cents=11000 WHERE id=10; UPDATE procurement.inbound_freight_costs SET cost_type='duty',actual_cents=1000,tax_type_id=1 WHERE id=31");
      await fixture.receive(); await applyShipment(); const unchanged = await physical();
      const { preview, request } = await review(typeChange("recoverable"));
      expect(preview.impact.inventoryValues).toMatchObject([{ onHandValueMills: { before: 1200000, after: 1100000 } }]);
      expect((await post("", request, randomUUID())).status).toBe(200); expect(await physical()).toEqual(unchanged);
      expect((await query("SELECT allocated_cents FROM procurement.inbound_freight_allocations")).rows).toEqual([{ allocated_cents: "1000" }]);
      expect((await query("SELECT recoverable_tax_allocated_cents FROM procurement.landed_cost_snapshots")).rows[0].recoverable_tax_allocated_cents).toBe("1000");
      expect(await lotTotals()).toMatchObject([{ landed_total_cost_mills: "0" }]);
      expect((await readPoShipmentCosts(fixture.database(), 10))?.taxCosts).toMatchObject({ shipmentInventoryCents: 0, recoverableShipmentTaxCents: 1000 });
      expect((await fixture.shipments().getEnrichedLines(1))[0]).toMatchObject({ allocatedCostCents: 1000, inventoryAllocatedCostCents: 0, recoverableTaxCents: 1000, landedUnitCostMills: 11000 });
    });

    it.each(["source", "preview", "stock", "role"])("rejects changed %s evidence and rolls back the complete approval", async changed => {
      await setup(); await fixture.receive(); await applyShipment(); const { request } = await review(typeChange("recoverable"));
      if (changed === "source") await query("UPDATE procurement.purchase_orders SET tax_cents=900 WHERE id=10");
      if (changed === "stock") await fixture.consume();
      if (changed === "role") await query("DELETE FROM identity.auth_user_roles WHERE user_id=$1", [actorId]);
      if (changed === "preview") request.previewVersion = "a".repeat(64);
      const before = await state(), response = await post("", request, randomUUID());
      expect(response.status).toBe(changed === "role" ? 403 : 409); expect(await state()).toEqual(before);
    });

    it("serializes concurrent approvals into one save and one stale rejection", async () => {
      await setup(); await fixture.receive(); await applyShipment(); const { request } = await review(typeChange("recoverable"));
      const results = await Promise.all([post("", request, randomUUID()), post("", request, randomUUID())]);
      expect(results.map(row => row.status).sort()).toEqual([200, 409]);
      expect((await query("SELECT count(*)::int AS count FROM public.audit_events WHERE action='procurement.tax.approved' AND actor=$1", [actorId])).rows[0].count).toBe(1);
    });

    it("rolls back tax rules, stock, costs and history when final audit fails, then safely retries", async () => {
      await setup(); await fixture.receive(); await applyShipment(); const { request } = await review(typeChange("recoverable")), key = randomUUID(), before = await state();
      await query(`CREATE FUNCTION public.tax_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='procurement.tax.approved' THEN RAISE EXCEPTION 'injected tax audit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER tax_test_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.tax_test_audit_failure()`);
      try { expect((await post("", request, key)).status).toBe(500); expect(await state()).toEqual(before); }
      finally { await query("DROP TRIGGER tax_test_audit_failure ON public.audit_events; DROP FUNCTION public.tax_test_audit_failure()"); }
      await expect.poll(async () => (await post("", request, key)).status, { timeout: 5000, interval: 250 }).toBe(200);
    });

    it("does not average separately invoiced receipt prices to approve tax changes", async () => {
      await setup(); await fixture.receive(); await applyShipment();
      await query(`UPDATE procurement.vendor_invoices SET status='approved',invoiced_amount_cents=12000,balance_cents=12000 WHERE id=71;
        UPDATE procurement.vendor_invoice_lines SET qty_invoiced=50,line_total_cents=6000,cost_component_evidence='{"contractVersion":1,"source":"operator_review","packagingTreatment":"separate","productMills":500000,"packagingMills":50000,"adjustmentMills":50000}' WHERE id=72;
        INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,purchase_order_line_id,qty_invoiced,unit_cost_cents,line_total_cents,cost_component_evidence)
          SELECT 73,71,2,21,50,100,6000,cost_component_evidence FROM procurement.vendor_invoice_lines WHERE id=72;
        INSERT INTO procurement.vendor_invoice_line_taxes(vendor_invoice_line_id,tax_type_id,amount_mills) VALUES(72,1,50000),(73,1,50000)`);
      const current = await context({ kind: "tax_type", id: 1 }), before = await state();
      expect(await post("/preview", { sourceVersion: current.sourceVersion, change: typeChange("recoverable") })).toMatchObject({ status: 409, body: { code: "PURCHASE_TAX_RECEIPT_ALLOCATION_REQUIRED" } });
      expect(await state()).toEqual(before);
    });

    it("does not apply an unchanged multi-invoice price when only superseded PO tax settings change", async () => {
      await setup(); await fixture.receive(); await applyShipment();
      await query(`UPDATE procurement.vendor_invoices SET status='approved',invoiced_amount_cents=12500,balance_cents=12500 WHERE id=71;
        UPDATE procurement.vendor_invoice_lines SET qty_invoiced=50,line_total_cents=6000,cost_component_evidence='{"contractVersion":1,"source":"operator_review","packagingTreatment":"separate","productMills":500000,"packagingMills":50000,"adjustmentMills":50000}' WHERE id=72;
        INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,purchase_order_line_id,qty_invoiced,unit_cost_cents,line_total_cents,cost_component_evidence)
          VALUES(73,71,2,21,50,110,6500,'{"contractVersion":1,"source":"operator_review","packagingTreatment":"separate","productMills":550000,"packagingMills":50000,"adjustmentMills":50000}');
        INSERT INTO procurement.vendor_invoice_line_taxes(vendor_invoice_line_id,tax_type_id,amount_mills) VALUES(72,2,50000),(73,2,50000)`);
      const costs = await lotTotals(), current = await context(po);
      if (current.current?.kind !== "purchase_order") throw new Error("Missing PO tax context");
      const { preview, request } = await review({ ...current.current, taxTypeId: 2 });
      expect(preview.impact.inventoryValues.every(row => row.onHandValueMills.before === row.onHandValueMills.after)).toBe(true);
      expect(preview.impact.applications.every(row => row.component === "landed")).toBe(true);
      expect((await post("", request, randomUUID())).status).toBe(200); expect(await lotTotals()).toEqual(costs);
    });

    it("preserves economic revisions and approvals when only a tax type label changes", async () => {
      await setup(); await fixture.receive(); await applyShipment();
      const before = (await query("SELECT id,fingerprint FROM procurement.cost_source_revisions ORDER BY id")).rows;
      const { request } = await review({ ...typeChange("inventory"), name: "Supplier sales tax" });
      expect((await post("", request, randomUUID())).status).toBe(200);
      expect((await query("SELECT id,fingerprint FROM procurement.cost_source_revisions ORDER BY id")).rows).toEqual(before);
      const status = await fixture.database().transaction(tx => readPurchaseCostStatus(tx, [21]));
      expect(status.lines[0].components.every(row => row.status === "applied")).toBe(true);
    });

    it("adjusts an already approved historical destination without granting a second expense approval", async () => {
      await setup(); await query(`UPDATE procurement.purchase_orders SET tax_cents=0,total_cents=11000 WHERE id=10;
        UPDATE procurement.inbound_freight_costs SET cost_type='duty',actual_cents=1000,tax_type_id=1 WHERE id=31;
        INSERT INTO procurement.receiving_orders(id,receipt_number,source_type,status) VALUES(60,'TAX-HISTORICAL','shipment','closed');
        INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,sku,product_variant_id,expected_qty,received_qty)
          VALUES(61,60,21,'AUDIT-PRODUCT',200,2,2);
        INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,
          po_line_id,inbound_shipment_id,receiving_order_id,unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills,cost_precision_version,cost_source,received_at)
          VALUES(501,'TAX-HISTORICAL-DEPLETED',200,99,2,0,21,1,60,500000,500000,0,0,500000,1,'po','2026-01-01');
        UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1`);
      await applyShipment();
      const reconciliation = createShipmentCostReconciliationService(fixture.database(), () => fixture.at);
      const initial = await reconciliation.context(11, actorId);
      const request = { sourceVersion: initial.sourceVersion, destination: "historical_cogs" as const, reason: "Administrator verified historical sales from retained supplier and sales documents" };
      expect(await reconciliation.reconcile(11, request, actorId, { ...shipmentReconciliationScope(11), actorType: "user", actorId, contractVersion: 1, idempotencyKey: randomUUID(), requestHash: costFingerprint(request) }))
        .toMatchObject({ httpStatus: 200, body: { state: { status: "posted", postedMills: 100000 } } });
      const approvals = (await query("SELECT * FROM inventory.cost_reconciliation_approvals ORDER BY id")).rows, unchanged = await physical();
      const { preview, request: taxApproval } = await review(typeChange("recoverable"));
      expect(preview.impact.historicalCosts).toMatchObject([{ component: "landed", destination: "historical_cogs", totalMills: { before: 100000, after: 0 } }]);
      expect((await post("", taxApproval, randomUUID())).status).toBe(200); expect(await physical()).toEqual(unchanged);
      expect((await query("SELECT * FROM inventory.cost_reconciliation_approvals ORDER BY id")).rows).toEqual(approvals);
      expect((await query("SELECT SUM(delta_mills)::text AS amount FROM inventory.cost_reconciliation_postings WHERE destination='historical_cogs'")).rows[0].amount).toBe("0");
    });

    it("retains a real measurement task instead of inventing allocation or losing the financial tax decision", async () => {
      await setup(); await query("UPDATE procurement.purchase_orders SET tax_cents=0,total_cents=11000 WHERE id=10; UPDATE procurement.inbound_freight_costs SET cost_type='duty',actual_cents=1000,tax_type_id=1 WHERE id=31");
      await fixture.receive(); await applyShipment();
      await query("UPDATE procurement.inbound_freight_costs SET cost_type='freight',tax_type_id=NULL,allocation_method='by_volume' WHERE id=31; UPDATE procurement.purchase_orders SET tax_cents=1000 WHERE id=10");
      const shares = (await query("SELECT * FROM procurement.inbound_freight_allocations ORDER BY id")).rows, unchanged = await physical();
      const { preview, request } = await review(typeChange("recoverable"));
      expect(preview.warnings.join(" ")).toMatch(/measurement|shipping cost|split/i);
      expect((await post("", request, randomUUID())).status).toBe(200); expect(await physical()).toEqual(unchanged);
      expect((await query("SELECT treatment FROM procurement.purchase_tax_types WHERE id=1")).rows[0].treatment).toBe("recoverable");
      expect((await query("SELECT * FROM procurement.inbound_freight_allocations ORDER BY id")).rows).toEqual(shares);
      expect(preview.impact.applications.some(row => row.component === "landed" && row.status === "review_required")).toBe(true);
    });

    it("retries concurrent identical approvals through one financial command", async () => {
      await setup(); await fixture.receive(); await applyShipment(); const { request } = await review(typeChange("recoverable")), key = randomUUID();
      const responses = await Promise.all([post("", request, key), post("", request, key)]);
      const completed = responses.find(row => row.status === 200);
      expect(completed, JSON.stringify(responses)).toBeDefined();
      purchaseTaxResultSchema.parse(completed!.body);
      for (const response of responses) {
        if (response.status === 409) {
          expect(response.body).toMatchObject({ code: "FINANCIAL_COMMAND_IN_PROGRESS" });
          expect(response.retryAfter).toMatch(/^[1-9]\d*$/);
        } else {
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(response.body).toEqual(completed!.body);
        }
      }
      expect(responses.filter(row => row.status === 200 && row.replayed === "false")).toHaveLength(1);
      const saved = await state();
      expect(await post("", request, key)).toMatchObject({ status: 200, replayed: "true", body: completed!.body });
      expect(await state()).toEqual(saved);
      expect((await query("SELECT count(*)::int AS count FROM public.audit_events WHERE action='procurement.tax.approved' AND context->>'commandKey'=$1", [key])).rows[0].count).toBe(1);
    });

    it("returns a retryable busy receipt while an identical approval is running and replays its single posting", async () => {
      await setup(); await fixture.receive(); await applyShipment();
      const { request } = await review(typeChange("recoverable")), key = randomUUID();
      let unlock!: () => void, announce!: () => void;
      const released = new Promise<void>(resolve => { unlock = resolve; });
      const ready = new Promise<void>(resolve => { announce = resolve; });
      // Hold the real graph lock so the first durable command cannot finish
      // before its duplicate arrives. No timing or cost-owner mock is needed.
      const blocker = fixture.database().transaction(async tx => {
        await lockInventoryCostGraph(tx); announce(); await released;
      });
      await Promise.race([ready, blocker]);
      const first = post("", request, key);
      void first.catch(() => {}); // Observed again below after releasing the blocker.
      let completed: Awaited<typeof first>;
      try {
        const commandClaimTimeoutMs = 10_000;
        await expect.poll(async () => (await query("SELECT status FROM public.financial_command_results WHERE idempotency_key=$1", [key])).rows[0]?.status,
          { timeout: commandClaimTimeoutMs }).toBe("claimed");
        const duplicate = await post("", request, key);
        expect(duplicate).toMatchObject({ status: 409, body: { code: "FINANCIAL_COMMAND_IN_PROGRESS" } });
        expect(duplicate.retryAfter).toMatch(/^[1-9]\d*$/);
      } finally {
        unlock(); completed = (await Promise.all([blocker, first]))[1];
      }
      expect(completed.status, JSON.stringify(completed.body)).toBe(200);
      purchaseTaxResultSchema.parse(completed.body);
      const saved = await state();
      expect(await post("", request, key)).toMatchObject({ status: 200, replayed: "true", body: completed.body });
      expect(await state()).toEqual(saved);
      expect((await query("SELECT revision FROM procurement.purchase_tax_types WHERE id=1")).rows[0].revision).toBe(2);
      expect(await lotTotals()).toMatchObject([{ product_total_cost_mills: "1000000", packaging_total_cost_mills: "100000" }]);
      expect((await query("SELECT count(*)::int AS count FROM public.audit_events WHERE action='procurement.tax.approved' AND context->>'commandKey'=$1", [key])).rows[0].count).toBe(1);
    });

    it("retains a terminal authority rejection and requires a new reviewed key after authority is restored", async () => {
      await setup(); await fixture.receive(); await applyShipment();
      const { request } = await review(typeChange("recoverable")), key = randomUUID(), before = await state();
      const roles = (await query(`SELECT role.id FROM identity.auth_roles role JOIN identity.auth_user_roles assignment ON assignment.role_id=role.id
        WHERE assignment.user_id=$1 AND role.is_system=1`, [actorId])).rows;
      expect(roles.length).toBeGreaterThan(0);
      for (const role of roles) await query("UPDATE identity.auth_roles SET is_system=0 WHERE id=$1", [role.id]);
      const rejected = await post("", request, key);
      expect(rejected).toMatchObject({ status: 403, replayed: "false", body: { code: "INVOICE_QUANTITY_ADMIN_REQUIRED" } });
      for (const role of roles) await query("UPDATE identity.auth_roles SET is_system=1 WHERE id=$1", [role.id]);
      expect(await post("", request, key)).toMatchObject({ status: 403, replayed: "true", body: rejected.body });
      expect(await state()).toEqual(before);
      const fresh = await review(typeChange("recoverable"));
      expect((await post("", fresh.request, randomUUID())).status).toBe(200);
      expect(await lotTotals()).toMatchObject([{ product_total_cost_mills: "1000000", packaging_total_cost_mills: "100000" }]);
      expect((await query("SELECT count(*)::int AS count FROM public.audit_events WHERE action='procurement.tax.approved'")).rows[0].count).toBe(1);
    });

    it("records mixed invoice tax treatments once with exact billed conservation", async () => {
      await setup(); await fixture.receive(); await applyShipment();
      await query("UPDATE procurement.vendor_invoices SET status='approved',invoiced_amount_cents=13000,balance_cents=13000 WHERE id=71; UPDATE procurement.vendor_invoice_lines SET qty_invoiced=100,line_total_cents=13000,cost_component_evidence=NULL WHERE id=72");
      const { request } = await review({ kind: "invoice_line", id: 72, taxes: [{ taxTypeId: 1, amountMills: 40000 }, { taxTypeId: 2, amountMills: 60000 }],
        components: { contractVersion: 1, source: "operator_review", packagingTreatment: "separate", productMills: 1100000, packagingMills: 100000, adjustmentMills: 100000 } });
      expect((await post("", request, randomUUID())).status).toBe(200);
      expect(await lotTotals()).toMatchObject([{ product_total_cost_mills: "1140000", packaging_total_cost_mills: "100000" }]);
      expect((await readPoShipmentCosts(fixture.database(), 10))?.taxCosts).toMatchObject({ supplierInventoryCents: 12400, recoverableSupplierTaxCents: 600 });
    });

    it.each([false, true])("saves tax costs with visible quantity gaps without inventing an expense (previously applied: %s)", async previouslyApplied => {
      await setup(); await fixture.historicalGaps(); if (previouslyApplied) await fixture.shipments().pushLandedCostsToLots(1, actorId);
      const unchanged = await physical(), { preview, request } = await review(typeChange("recoverable"));
      expect(preview.warnings.length).toBeGreaterThan(0);
      const response = await post("", request, randomUUID()); expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(await physical()).toEqual(unchanged);
      expect((await query("SELECT count(*)::int AS count FROM inventory.cost_reconciliation_postings")).rows[0].count).toBe(0);
    });

    it("allocates header and independent tax cents exactly while preserving explicit line and parent tax types", async () => {
      await setup(); await query(`UPDATE procurement.purchase_orders SET tax_cents=1 WHERE id=10;
        UPDATE procurement.purchase_order_lines SET tax_cents=3,tax_type_id=2 WHERE id=21;
        INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,line_type,product_id,sku,order_qty,unit_cost_cents,total_product_cost_cents,packaging_cost_cents,tax_cents,line_total_cents,status)
          VALUES(22,10,2,'product',100,'SECOND-PRODUCT',100,100,10000,1000,4,11004,'open');
        INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,line_type,parent_line_id,tax_type_id,sku,order_qty,unit_cost_cents,line_total_cents,status)
          VALUES(23,10,3,'tax',21,2,'PARENT-TAX',0,0,2,'open'),(24,10,4,'tax',NULL,1,'SHARED-TAX',0,0,1,'open')`);
      const result = await fixture.database().transaction(tx => readPoTaxEvidence(tx, [10]));
      expect(purchaseTaxAmounts(result.get(21))).toEqual({ taxMills: 700, inventoryMills: 200, recoverableMills: 500, unclassifiedMills: 0 });
      expect(purchaseTaxAmounts(result.get(22))).toEqual({ taxMills: 400, inventoryMills: 400, recoverableMills: 0, unclassifiedMills: 0 });
      await query("UPDATE procurement.purchase_order_lines SET status='cancelled' WHERE id=22");
      const cancelled = await fixture.database().transaction(tx => readPoTaxEvidence(tx, [10]));
      expect(cancelled.has(22)).toBe(false); expect(purchaseTaxAmounts(cancelled.get(21)).taxMills).toBe(700);
    });
  });
}
