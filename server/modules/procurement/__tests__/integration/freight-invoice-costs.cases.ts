import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import { freightInvoiceContextSchema, freightInvoicePreviewSchema } from "@shared/procurement/freight-invoice-costs";
import { createFreightInvoiceCostService } from "../../freight-invoice-costs.service";
import { registerFreightInvoiceCostRoutes } from "../../freight-invoice-costs.routes";
import { createInvoiceFromShipmentCostsInTransaction, executeApInvoiceCommandInTransaction } from "../../ap-ledger.service";
import type { ShipmentTrackingService } from "../../shipment-tracking.service";
import type { AmendmentDatabase } from "../../po-quantity-amendment.repository";

export function registerFreightInvoiceCostCases(fixture: {
  pool: () => pg.Pool; database: () => AmendmentDatabase; shipments: () => ShipmentTrackingService;
  receive: () => Promise<unknown>; consume: () => Promise<unknown>; actorId: string; at: Date;
}) {
  const query = (text: string, values?: unknown[]) => fixture.pool().query(text, values);
  let server: Server, endpoint: string;
  async function context(id: number) {
    const response = await requestLocalHttp(`${endpoint}/${id}/shipment-cost-review`);
    expect(response.status).toBe(200);
    return freightInvoiceContextSchema.parse(await response.json());
  }
  async function post(id: number, operation: "preview" | "approve", body: unknown, key?: string, actor?: string) {
    const response = await requestLocalHttp(`${endpoint}/${id}/shipment-cost-review/${operation}`, { method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}), ...(actor ? { "X-Test-Actor": actor } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), replayed: response.headers.get("Idempotency-Replayed"), retryAfter: response.headers.get("Retry-After") };
  }
  async function setup(options: { consume?: boolean; close?: boolean } = {}) {
    await fixture.receive();
    if (options.consume) await fixture.consume();
    if (options.close !== false) await fixture.shipments().close(1, fixture.actorId);
    await query("UPDATE procurement.inbound_freight_costs SET vendor_id=5,estimated_cents=5000 WHERE id=31");
    const invoice = await fixture.database().transaction(tx => createInvoiceFromShipmentCostsInTransaction(tx, 1, {
      vendorId: 5, invoiceNumber: "FINAL-FREIGHT", costRowIds: [31],
      lineOverrides: [{ freightCostId: 31, qtyInvoiced: 1, unitCostCents: 5500 }],
    }, fixture.actorId, fixture.at));
    return invoice.id as number;
  }
  async function review(id: number) {
    const loaded = await context(id), result = await post(id, "preview", { sourceVersion: loaded.sourceVersion });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const preview = freightInvoicePreviewSchema.parse(result.body);
    return { preview, body: { sourceVersion: loaded.sourceVersion, previewVersion: preview.previewVersion,
      reason: "Checked final freight bill and its exact shipment charge lines", approvalConfirmed: true } };
  }
  async function state() {
    const tables = ["procurement.vendor_invoices", "procurement.vendor_invoice_lines", "procurement.inbound_freight_costs",
      "procurement.inbound_freight_allocations", "procurement.landed_cost_snapshots", "procurement.landed_cost_adjustments",
      "procurement.cost_source_revisions", "inventory.cost_applications", "inventory.inventory_lots", "oms.order_item_costs",
      "inventory.cost_reconciliation_postings", "inventory.cost_reporting_events", "procurement.po_events", "public.audit_events"];
    return Promise.all(tables.map(async table => ({ table, rows: (await query(`SELECT to_jsonb(row) AS row FROM ${table} row ORDER BY to_jsonb(row)::text`)).rows })));
  }
  async function physical() {
    const tables = ["procurement.receiving_lines", "procurement.po_receipts", "procurement.ap_payments", "procurement.ap_payment_allocations"];
    return Promise.all(tables.map(async table => ({ table, rows: (await query(`SELECT to_jsonb(row) AS row FROM ${table} row ORDER BY to_jsonb(row)::text`)).rows })));
  }
  describe("freight invoice cost approval through public routes and real cost owners", () => {
    beforeAll(async () => {
      await query(readFileSync(resolve(process.cwd(), "migrations/900000048000019830001_freight_invoice_approval_history_lookup.sql"), "utf8"));
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { user: { id: req.header("X-Test-Actor") ?? fixture.actorId, role: "admin" } }; next(); });
      registerFreightInvoiceCostRoutes(app, createFreightInvoiceCostService(fixture.database(), fixture.shipments(), () => fixture.at));
      server = createServer(app);
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/vendor-invoices`;
    });
    afterAll(async () => { if (server) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); });
    it.each(["0", "-1", "17.5", "17x", "00017", "2147483648"])("rejects noncanonical invoice identifier %s before reading source data", async id => {
      const response = await requestLocalHttp(`${endpoint}/${id}/shipment-cost-review`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "FREIGHT_INVOICE_INPUT_INVALID" });
    });
    it("previews the exact bill, inventory and order basis without writes, then posts once", async () => {
      const id = await setup({ consume: true }), before = await state(), counts = await physical();
      const { preview, body } = await review(id);
      expect(await state()).toEqual(before);
      expect(preview.charges).toEqual([{ chargeId: 31, shipmentId: 1, label: "freight", estimatedCents: 5000, actualCents: 5000, invoiceCents: 5500 }]);
      expect(preview.allocations.map(row => row.amountCents)).toEqual([{ before: 5000, after: 5500 }]);
      expect(preview.inventoryValues.map(row => [row.beforeMills, row.afterMills])).toEqual([[800000, 825000]]);
      expect(preview.impact.orderCosts.map(row => row.totalMills)).toEqual([{ before: 800000, after: 825000 }]);
      expect(preview.impact.historicalCosts).toEqual([]);
      const key = randomUUID(), saved = await post(id, "approve", body, key);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200); expect(saved.body.preview).toEqual(preview);
      expect(await physical()).toEqual(counts);
      expect((await query("SELECT actual_cents,estimated_cents FROM procurement.inbound_freight_costs WHERE id=31")).rows).toEqual([{ actual_cents: "5500", estimated_cents: "5000" }]);
      expect((await query("SELECT status,invoiced_amount_cents,paid_amount_cents,balance_cents FROM procurement.vendor_invoices WHERE id=$1", [id])).rows)
        .toEqual([{ status: "approved", invoiced_amount_cents: "5500", paid_amount_cents: "0", balance_cents: "5500" }]);
      const posted = await state(), replay = await post(id, "approve", body, key);
      expect(replay.status).toBe(200); expect(replay.replayed).toBe("true"); expect(replay.body).toEqual(saved.body); expect(await state()).toEqual(posted);
      const current = await context(id); expect(current.requiresChange).toBe(false); expect(current.history).toHaveLength(1);
      expect(current.history[0].preview).toEqual(preview); expect(current.history[0].reason).toBe(body.reason);
      // The base fixture gives this non-admin approval permission but no view
      // permission. Define an explicit reader; do not weaken the route gate.
      await query("DELETE FROM identity.auth_role_permissions WHERE role_id=2 AND permission_id=1; INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES(2,2,NULL)");
      const viewerResponse = await requestLocalHttp(`${endpoint}/${id}/shipment-cost-review`, { headers: { "X-Test-Actor": "lead-user" } });
      expect(viewerResponse.status).toBe(200);
      const viewer = freightInvoiceContextSchema.parse(await viewerResponse.json());
      expect(viewer.canApprove).toBe(false); expect(viewer.requiresChange).toBe(false);
      expect(viewer.blockedReason).toBeNull(); expect(viewer.history).toEqual(current.history);
    });
    it("preserves the original AP approval when reconciling an already-approved bill", async () => {
      const id = await setup();
      await fixture.database().transaction(tx => executeApInvoiceCommandInTransaction("approve_invoice", { invoiceId: id, userId: fixture.actorId, now: fixture.at }, tx));
      const original = (await query("SELECT approved_at,approved_by FROM procurement.vendor_invoices WHERE id=$1", [id])).rows;
      const { body } = await review(id), result = await post(id, "approve", body, randomUUID());
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect((await query("SELECT approved_at,approved_by FROM procurement.vendor_invoices WHERE id=$1", [id])).rows).toEqual(original);
    });
    it("rejects a changed invoice after preview without changing charge or inventory costs", async () => {
      const id = await setup(), { body } = await review(id);
      await query("UPDATE procurement.vendor_invoices SET invoiced_amount_cents=5600,balance_cents=5600 WHERE id=$1", [id]);
      await query("UPDATE procurement.vendor_invoice_lines SET unit_cost_cents=5600,unit_cost_mills=560000,line_total_cents=5600 WHERE vendor_invoice_id=$1", [id]);
      const before = await state(), result = await post(id, "approve", body, randomUUID());
      expect(result.status).toBe(409); expect(result.body.code).toBe("FREIGHT_INVOICE_STALE"); expect(await state()).toEqual(before);
    });
    it.each(["lead-user", "custom-user", "scoped-user"])("requires a persisted unscoped Administrator, not %s", async actor => {
      const id = await setup(), { body } = await review(id), before = await state();
      const result = await post(id, "approve", body, randomUUID(), actor);
      expect(result.status).toBe(403); expect(await state()).toEqual(before);
    });
    it("rejects revoked authority after a review", async () => {
      const id = await setup(), { body } = await review(id);
      await query("DELETE FROM identity.auth_user_roles WHERE user_id=$1", [fixture.actorId]);
      const before = await state(), result = await post(id, "approve", body, randomUUID());
      expect(result.status).toBe(403); expect(await state()).toEqual(before);
    });
    it("rolls back the document, allocation, inventory and order updates when audit fails", async () => {
      const id = await setup({ consume: true }), { body } = await review(id), before = await state();
      await query(`CREATE FUNCTION public.reject_freight_invoice_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='procurement.freight_invoice_costs.approved' THEN RAISE EXCEPTION 'freight invoice audit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_freight_invoice_test_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_freight_invoice_test_audit()`);
      const key = randomUUID();
      try { const result = await post(id, "approve", body, key); expect(result.status).toBe(500); expect(await state()).toEqual(before); }
      finally { await query("DROP TRIGGER reject_freight_invoice_test_audit ON public.audit_events; DROP FUNCTION public.reject_freight_invoice_test_audit()"); }
      const waiting = await post(id, "approve", body, key);
      expect(waiting.status).toBe(409); expect(waiting.body.code).toBe("FINANCIAL_COMMAND_IN_PROGRESS");
      expect(waiting.retryAfter).toMatch(/^[1-9]\d*$/);
      // Follow the durable owner's real database backoff instead of changing
      // its recorded retry time or creating a second financial command.
      await new Promise(done => setTimeout(done, Number(waiting.retryAfter) * 1000));
      const retry = await post(id, "approve", body, key); expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect((await context(id)).history).toHaveLength(1);
    });
    it("serializes independent approvals of the same reviewed invoice", async () => {
      const id = await setup(), { body } = await review(id);
      const results = await Promise.all([post(id, "approve", body, randomUUID()), post(id, "approve", body, randomUUID())]);
      expect(results.map(row => row.status).sort()).toEqual([200, 409]);
      expect(results.find(row => row.status === 409)!.body.code).toBe("FREIGHT_INVOICE_STALE");
      expect((await context(id)).history).toHaveLength(1);
    });
    it("allocates the billed total across multiple POs without creating stock for unreceived goods", async () => {
      await query(`INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,warehouse_id) VALUES(20,'OTHER-PO',5,'sent',1);
        INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,product_variant_id,sku,order_qty,unit_cost_cents,unit_cost_mills,total_product_cost_cents,packaging_cost_cents,line_total_cents,status)
          VALUES(22,20,1,100,201,'OTHER-ITEM',100,100,10000,10000,0,10000,'open');
        INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,product_variant_id,sku,qty_shipped,carton_count,allocated_cost_cents)
          VALUES(12,1,20,22,201,'OTHER-ITEM',100,1,0)`);
      const id = await setup(), { preview, body } = await review(id);
      expect(preview.allocations.map(row => [row.purchaseOrderId, row.amountCents.after])).toEqual([[10,2750],[20,2750]]);
      expect((await post(id, "approve", body, randomUUID())).status).toBe(200);
      expect((await query("SELECT count(*)::int AS n FROM inventory.inventory_lots WHERE po_line_id=22")).rows[0].n).toBe(0);
      expect((await query("SELECT po_id FROM procurement.po_events WHERE event_type='freight_invoice_costs_approved' ORDER BY po_id")).rows).toEqual([{ po_id: 10 }, { po_id: 20 }]);
      expect((await context(id)).history).toHaveLength(1);
    });
    it("leaves costs visibly pending finalization on an open shipment", async () => {
      const id = await setup({ close: false });
      await query("UPDATE procurement.inbound_shipments SET status='in_transit' WHERE id=1");
      const { preview, body } = await review(id);
      expect(preview.shipmentStates).toEqual([{ shipmentId: 1, shipmentNumber: "AUDIT-SHIP", state: "pending_finalization" }]);
      expect(preview.impact.orderCosts).toEqual([]);
      expect((await post(id, "approve", body, randomUUID())).status).toBe(200);
      expect((await query("SELECT status FROM procurement.inbound_shipments WHERE id=1")).rows[0].status).toBe("in_transit");
    });
    it("keeps unassigned receipt-specific supplier quantities provisional after freight is confirmed", async () => {
      await query("UPDATE procurement.purchase_order_lines SET receipt_costing_enabled=1 WHERE id=21");
      const id = await setup(), { body } = await review(id);
      expect((await post(id, "approve", body, randomUUID())).status).toBe(200);
      expect((await query("SELECT cost_provisional FROM inventory.inventory_lots ORDER BY id")).rows).toEqual([{ cost_provisional: 1 }]);
      expect((await query("SELECT count(*)::int AS n FROM procurement.receipt_invoice_cost_allocations")).rows[0].n).toBe(0);
    });
    it("retains the same approval in both views after the operational audit copy is removed", async () => {
      const id = await setup(), { body } = await review(id);
      const key = randomUUID(), saved = await post(id, "approve", body, key);
      expect(saved.status).toBe(200);
      const approved = await context(id), original = approved.history;
      await query("DELETE FROM public.audit_events WHERE action='procurement.freight_invoice_costs.approved' AND target=$1", [`vendor_invoice:${id}`]);
      const retained = await context(id);
      expect(retained.history).toEqual(original); expect(retained.sourceVersion).toBe(approved.sourceVersion);
      const replay = await post(id, "approve", body, key);
      expect(replay.replayed).toBe("true"); expect(replay.body).toEqual(saved.body);
      const response = await requestLocalHttp(`${endpoint.replace('/vendor-invoices','/purchase-orders')}/10/freight-invoice-cost-approvals`);
      expect(response.status).toBe(200); expect(await response.json()).toEqual(original);
      const row = (await query("SELECT id,payload_json FROM procurement.po_events WHERE event_type='freight_invoice_costs_approved'")).rows[0];
      expect(row.id).toBe(String(saved.body.approvalEventId));
      const event = row.payload_json;
      expect(event.authority).toBeDefined(); expect(event.preview).toEqual(original[0].preview); expect(event.commandKey).toBeDefined();
      await query("UPDATE procurement.inbound_shipment_lines SET purchase_order_id=NULL,purchase_order_line_id=NULL WHERE id=11");
      expect((await context(id)).history).toEqual(original);
    });
    it("requires a purchase relationship before a cost approval can be retained", async () => {
      const id = await setup();
      await query("UPDATE procurement.inbound_shipment_lines SET purchase_order_id=NULL,purchase_order_line_id=NULL WHERE id=11");
      const loaded = await context(id), before = await state();
      expect(loaded.blockedReason).toContain("Link this shipment to its purchase order");
      expect((await post(id, "preview", { sourceVersion: loaded.sourceVersion })).status).toBe(409);
      expect(await state()).toEqual(before);
    });
    it("retains distinct approvals when different administrators use the same client key", async () => {
      const id = await setup(), { body } = await review(id), key = randomUUID();
      expect((await post(id, "approve", body, key)).status).toBe(200);
      // A subsequent, independently recorded bill correction creates a new
      // variance. The second actor's key belongs to a separate command scope.
      await query("UPDATE procurement.vendor_invoices SET invoiced_amount_cents=5600,balance_cents=5600 WHERE id=$1", [id]);
      await query("UPDATE procurement.vendor_invoice_lines SET unit_cost_cents=5600,unit_cost_mills=560000,line_total_cents=5600 WHERE vendor_invoice_id=$1", [id]);
      const loaded = freightInvoiceContextSchema.parse(await (await requestLocalHttp(`${endpoint}/${id}/shipment-cost-review`, { headers: { "X-Test-Actor": "admin-user" } })).json());
      const measured = await post(id, "preview", { sourceVersion: loaded.sourceVersion }, undefined, "admin-user");
      expect(measured.status).toBe(200);
      const result = await post(id, "approve", { ...body, sourceVersion: loaded.sourceVersion, previewVersion: measured.body.previewVersion }, key, "admin-user");
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect((await context(id)).history).toHaveLength(2);
    });
    it("returns the exact canonical approval reference beyond a 32-bit event identifier", async () => {
      const id = await setup(), firstLargeEventId = 2_147_483_648;
      await query("SELECT setval(pg_get_serial_sequence('procurement.po_events','id'),$1::bigint,false)", [firstLargeEventId]);
      const { body } = await review(id), saved = await post(id, "approve", body, randomUUID());
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.approvalEventId).toBeGreaterThanOrEqual(firstLargeEventId);
      const row = (await query("SELECT id::text AS id FROM procurement.po_events WHERE event_type='freight_invoice_costs_approved'")).rows[0];
      expect(String(saved.body.approvalEventId)).toBe(row.id);
      expect((await context(id)).history).toHaveLength(1);
    });
  });
}
