import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { apInvoiceTransitionPreviewSchema, type ApInvoiceTransitionAction } from "@shared/procurement/ap-invoice-transition";
import { createInvoiceTransitionPreview, createInvoiceTransitionHistory } from "../../ap-invoice-transition.service";
import { createApInvoiceCommands } from "../../ap-invoice-commands";
import { createDrizzleFinancialCommandRepository } from "../../../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import type { AmendmentDatabase } from "../../po-quantity-amendment.repository";
import { createReceiptInvoiceCostService, receiptInvoiceCommandScope } from "../../receipt-invoice-costs.service";

export function registerApInvoiceTransitionCases(fixture: {
  pool: () => pg.Pool; database: () => AmendmentDatabase; actorId: string; at: Date;
  receive: () => Promise<unknown>; consume: () => Promise<unknown>;
  finalizeFreight: () => Promise<unknown>;
}) {
  const query = (text: string, values?: unknown[]) => fixture.pool().query(text, values);
  const preview = () => createInvoiceTransitionPreview(fixture.database(), () => fixture.at);
  const commands = (at = fixture.at) => createApInvoiceCommands(createDrizzleFinancialCommandRepository(fixture.database()), () => at);
  async function prepare() {
    await fixture.receive();
    await query("INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES(3,'purchasing','edit','purchasing'); INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES(1,3)");
    await query(`UPDATE procurement.purchase_order_lines SET order_qty=100,total_product_cost_cents=10000,
      packaging_cost_cents=1000,line_total_cents=11000,status='received' WHERE id=21;
      UPDATE procurement.vendor_invoices SET invoiced_amount_cents=13000,balance_cents=13000 WHERE id=71;
      UPDATE procurement.vendor_invoice_lines SET qty_invoiced=100,line_total_cents=13000,
        cost_component_evidence='{"contractVersion":1,"packagingTreatment":"separate","productMills":1200000,"packagingMills":100000,"adjustmentMills":0,"source":"operator_review"}'::jsonb WHERE id=72;
      INSERT INTO procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id) VALUES(71,10)`);
  }
  async function snapshot() {
    const tables = ["procurement.vendor_invoices", "procurement.vendor_invoice_lines", "procurement.purchase_orders", "procurement.purchase_order_lines",
      "procurement.receiving_lines", "procurement.inbound_shipment_lines", "procurement.po_receipts", "inventory.inventory_lots", "oms.order_item_costs",
      "procurement.cost_source_revisions", "inventory.cost_applications", "inventory.cost_reporting_events", "inventory.cost_reconciliation_approvals",
      "inventory.cost_reconciliation_postings", "procurement.ap_invoice_transition_reviews", "procurement.po_events", "procurement.ap_payments", "procurement.ap_payment_allocations"];
    return Promise.all(tables.map(async table => ({ table, rows: (await query(`SELECT to_jsonb(r) AS row FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows })));
  }
  async function physical() {
    return Promise.all(["SELECT id,qty_received,qty_on_hand,qty_picked,qty_packed,product_variant_id,warehouse_location_id FROM inventory.inventory_lots ORDER BY id",
      "SELECT * FROM procurement.receiving_lines ORDER BY id", "SELECT * FROM procurement.inbound_shipment_lines ORDER BY id",
      "SELECT * FROM procurement.vendor_invoice_lines ORDER BY id", "SELECT * FROM procurement.ap_payments ORDER BY id",
      "SELECT * FROM procurement.ap_payment_allocations ORDER BY id"].map(async text => (await query(text)).rows));
  }
  const reason = "Supplier document and the recorded receipt checked";
  function save(action: ApInvoiceTransitionAction, body: unknown, options: { key?: string; actor?: string; at?: Date } = {}) {
    const actor = options.actor ?? fixture.actorId;
    const scope = { method: "POST", routeTemplate: `/api/vendor-invoices/:id/${action}`, resourceKey: "vendor_invoice:71" };
    const descriptor = { ...scope, commandName: `ap.invoice.${action}`, actorId: actor, actorType: "user" as const,
      idempotencyKey: options.key ?? randomUUID(), contractVersion: 1, requestHash: hashHttpFinancialCommand({ ...scope, body }) };
    const method = action === "approve" ? "approveInvoice" : action === "dispute" ? "disputeInvoice" : "voidInvoice";
    return commands(options.at)[method](71, { userId: actor, transitionReview: body }, descriptor);
  }
  async function review(action: ApInvoiceTransitionAction, actor = fixture.actorId) {
    const result = apInvoiceTransitionPreviewSchema.parse(await preview()(71, action, { reason }, actor));
    return { preview: result, body: { reason, previewVersion: result.previewVersion } };
  }
  async function approve() { const reviewed = await review("approve"); return save("approve", reviewed.body); }

  describe("reviewed AP invoice authority transitions", () => {
    it("runs the real approval preview without committing any document, inventory, source or history writes", async () => {
      await prepare(); const before = await snapshot();
      const reviewed = await review("approve");
      expect(reviewed.preview).toMatchObject({ before: { status: "received", amountCents: 13000, paidCents: 0 }, after: { status: "approved", amountCents: 13000, paidCents: 0 } });
      expect(reviewed.preview.inventoryValues).toEqual([expect.objectContaining({ beforeMills: 1100000, afterMills: 1300000, onHandUnits: 2 })]);
      expect(await snapshot()).toEqual(before);
    });
    it("approves through the existing cost owner, retains exact impact and original document and physical facts, then replays safely", async () => {
      await prepare(); const stock = await physical(), reviewed = await review("approve"), key = randomUUID();
      const approvedAt = new Date(fixture.at.getTime() + 123);
      const result = await save("approve", reviewed.body, { key, at: approvedAt });
      expect(result).toMatchObject({ httpStatus: 200, replayed: false, body: { status: "approved", transitionReview: { actorId: fixture.actorId, preview: { previewVersion: reviewed.preview.previewVersion } } } });
      expect(await physical()).toEqual(stock);
      const after = await snapshot();
      expect(await save("approve", reviewed.body, { key })).toMatchObject({ httpStatus: 200, replayed: true, body: JSON.parse(JSON.stringify(result.body)) });
      expect(await snapshot()).toEqual(after);
      const history = await createInvoiceTransitionHistory(fixture.database())(71);
      expect(history).toHaveLength(1); expect(history[0].approvedAt).toBe(approvedAt.toISOString());
      expect((await query("SELECT payload_json FROM procurement.po_events WHERE event_type='invoice_transition_reviewed'")).rows[0].payload_json.preview).toMatchObject({ action: "approve", before: { status: "received" }, after: { status: "approved" } });
      for (const text of ["UPDATE procurement.ap_invoice_transition_reviews SET reason='changed'", "DELETE FROM procurement.ap_invoice_transition_reviews", "TRUNCATE procurement.ap_invoice_transition_reviews"])
        await expect(query(text)).rejects.toMatchObject({ code: "23514" });
    });
    it("withdraws disputed invoice cost authority and restores it with the original approval intact", async () => {
      await prepare(); await approve();
      const original = (await query("SELECT approved_by,approved_at FROM procurement.vendor_invoices WHERE id=71")).rows[0];
      const stock = await physical(), dispute = await review("dispute");
      expect(dispute.preview.inventoryValues[0]).toMatchObject({ beforeMills: 1300000, afterMills: 1100000 });
      expect(await save("dispute", dispute.body)).toMatchObject({ httpStatus: 200, body: { status: "disputed" } });
      const restored = await review("approve", "lead-user");
      expect(restored.preview.inventoryValues[0]).toMatchObject({ beforeMills: 1100000, afterMills: 1300000 });
      await save("approve", restored.body, { actor: "lead-user" });
      expect((await query("SELECT approved_by,approved_at FROM procurement.vendor_invoices WHERE id=71")).rows[0]).toEqual(original);
      expect(await physical()).toEqual(stock);
      expect(await createInvoiceTransitionHistory(fixture.database())(71)).toHaveLength(3);
    });
    it("voids an unpaid approved invoice with reviewed source withdrawal and no invented cash, stock or historical expense", async () => {
      await prepare(); await approve(); const stock = await physical(), reviewed = await review("void");
      expect(reviewed.preview.inventoryValues[0]).toMatchObject({ beforeMills: 1300000, afterMills: 1100000 });
      expect(await save("void", reviewed.body)).toMatchObject({ httpStatus: 200, body: { status: "voided", invoicedAmountCents: 13000, paidAmountCents: 0 } });
      expect(await physical()).toEqual(stock);
      expect((await query("SELECT * FROM inventory.cost_reconciliation_postings")).rows).toEqual([]);
    });
    it("shows changed order cost basis without inventing a verified sale or expense", async () => {
      await prepare(); await fixture.consume(); const reviewed = await review("approve");
      expect(reviewed.preview.impact.orderCosts).toEqual([expect.objectContaining({ quantity: 1, totalMills: { before: 550000, after: 650000 } })]);
      await save("approve", reviewed.body);
      expect((await query("SELECT total_cost_mills::text FROM oms.order_item_costs")).rows).toEqual([{ total_cost_mills: "650000" }]);
      expect((await query("SELECT * FROM inventory.cost_reconciliation_postings")).rows).toEqual([]);
    });
    it("requires a measured preview for every new public command", async () => {
      await prepare(); const before = await snapshot();
      expect(await save("approve", { reason })).toMatchObject({ httpStatus: 409, body: { details: { code: "AP_INVOICE_TRANSITION_PREVIEW_REQUIRED" } } });
      expect(await snapshot()).toEqual(before);
    });
    it("classifies an unavailable application clock as retryable infrastructure without blaming the supplied invoice reason", async () => {
      await prepare(); const before = await snapshot();
      await expect(createInvoiceTransitionPreview(fixture.database(), () => new Date(Number.NaN))(71, "approve", { reason }, fixture.actorId))
        .rejects.toMatchObject({ statusCode: 503, details: { code: "AP_INVOICE_TRANSITION_CLOCK_INVALID" } });
      expect(await snapshot()).toEqual(before);
    });
    it.each(["document", "stock", "permission"])("rejects stale %s evidence and rolls back every financial write", async kind => {
      await prepare(); const reviewed = await review("approve");
      if (kind === "document") await query("UPDATE procurement.vendor_invoice_lines SET notes='new supplier evidence' WHERE id=72");
      if (kind === "stock") await query("UPDATE inventory.inventory_lots SET notes='new stock evidence'");
      if (kind === "permission") await query("DELETE FROM identity.auth_role_permissions WHERE role_id=1 AND permission_id=1");
      const before = await snapshot(), result = await save("approve", reviewed.body);
      expect(result).toMatchObject({ httpStatus: kind === "permission" ? 403 : 409 });
      expect(await snapshot()).toEqual(before);
    });
    it("retains ordinary purchasing approval permission without inventing an Administrator requirement", async () => {
      await prepare(); const reviewed = await review("approve", "lead-user");
      expect(await save("approve", reviewed.body, { actor: "lead-user" })).toMatchObject({ httpStatus: 200, body: { approvedBy: "lead-user" } });
    });
    it("does not promote a scoped grant into global invoice authority", async () => {
      await prepare(); await expect(review("approve", "scoped-user")).rejects.toMatchObject({ statusCode: 403 });
    });
    it("serializes competing approvals and retains a single approved impact", async () => {
      await prepare(); const reviewed = await review("approve");
      const results = await Promise.all([save("approve", reviewed.body), save("approve", reviewed.body)]);
      expect(results.map(result => result.httpStatus).sort()).toEqual([200, 409]);
      expect(await createInvoiceTransitionHistory(fixture.database())(71)).toHaveLength(1);
    });
    it("rolls back AP, source and inventory changes if immutable review retention fails", async () => {
      await prepare(); const reviewed = await review("approve"), before = await snapshot();
      await query(`CREATE FUNCTION procurement.fail_transition_history_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected history failure'; END $$;
        CREATE TRIGGER fail_transition_history_fixture BEFORE INSERT ON procurement.ap_invoice_transition_reviews FOR EACH ROW EXECUTE FUNCTION procurement.fail_transition_history_fixture()`);
      try { await expect(save("approve", reviewed.body)).rejects.toThrow(); }
      finally { await query("DROP TRIGGER fail_transition_history_fixture ON procurement.ap_invoice_transition_reviews; DROP FUNCTION procurement.fail_transition_history_fixture()"); }
      expect(await snapshot()).toEqual(before);
    });
    it.each(["approve", "dispute", "void"] as const)("preserves the existing invalid-state guard for %s", async action => {
      await prepare(); await query("UPDATE procurement.vendor_invoices SET status='voided' WHERE id=71");
      await expect(review(action)).rejects.toMatchObject({ statusCode: 409 });
    });
    it("keeps paid invoice approval idempotent and blocks paid dispute/void without changing settlement", async () => {
      await prepare(); await approve();
      const { recordPayment } = await import("../../ap-ledger.service");
      await recordPayment({ vendorId: 5, currency: "USD", status: "completed", totalAmountCents: 13000, paymentDate: fixture.at,
        paymentMethod: "wire", createdBy: fixture.actorId, allocations: [{ vendorInvoiceId: 71, appliedAmountCents: 13000 }] }, { now: fixture.at });
      const before = await physical(), original = (await query("SELECT approved_by,approved_at FROM procurement.vendor_invoices WHERE id=71")).rows[0];
      const reviewed = await review("approve"); expect(reviewed.preview.after).toMatchObject({ status: "paid", paidCents: 13000, balanceCents: 0 });
      await save("approve", reviewed.body);
      await expect(review("void")).rejects.toMatchObject({ statusCode: 409 });
      await expect(review("dispute")).rejects.toMatchObject({ statusCode: 409 });
      expect(await physical()).toEqual(before);
      expect((await query("SELECT approved_by,approved_at FROM procurement.vendor_invoices WHERE id=71")).rows[0]).toEqual(original);
    });
    it("restores a partially paid disputed invoice without erasing settlement status or original approval", async () => {
      await prepare(); await approve();
      const { recordPayment } = await import("../../ap-ledger.service");
      await recordPayment({ vendorId: 5, currency: "USD", status: "completed", totalAmountCents: 1000, paymentDate: fixture.at,
        paymentMethod: "wire", createdBy: fixture.actorId, allocations: [{ vendorInvoiceId: 71, appliedAmountCents: 1000 }] }, { now: fixture.at });
      const original = (await query("SELECT approved_by,approved_at FROM procurement.vendor_invoices WHERE id=71")).rows[0];
      const stock = await physical(), dispute = await review("dispute"); await save("dispute", dispute.body);
      const restored = await review("approve", "lead-user");
      expect(restored.preview.after).toMatchObject({ status: "partially_paid", amountCents: 13000, paidCents: 1000, balanceCents: 12000 });
      expect(await save("approve", restored.body, { actor: "lead-user" })).toMatchObject({ httpStatus: 200, body: { status: "partially_paid", paidAmountCents: 1000 } });
      expect((await query("SELECT approved_by,approved_at FROM procurement.vendor_invoices WHERE id=71")).rows[0]).toEqual(original);
      expect(await physical()).toEqual(stock);
    });
    it("retains immutable review evidence for a manual invoice without PO relationships", async () => {
      await prepare();
      await query("UPDATE procurement.vendor_invoice_lines SET purchase_order_line_id=NULL WHERE id=72; DELETE FROM procurement.vendor_invoice_po_links WHERE vendor_invoice_id=71");
      const reviewed = await review("approve"); expect(reviewed.preview.inventoryValues).toEqual([]);
      expect(await save("approve", reviewed.body)).toMatchObject({ httpStatus: 200 });
      expect(await createInvoiceTransitionHistory(fixture.database())(71)).toHaveLength(1);
      expect((await query("SELECT * FROM procurement.po_events WHERE event_type='invoice_transition_reviewed'")).rows).toEqual([]);
    });
    it("retains receipt-specific assignments across dispute and approval, making withdrawn coverage provisional without guessing a new receipt cost", async () => {
      await prepare(); await fixture.finalizeFreight(); await approve();
      const owner = createReceiptInvoiceCostService(fixture.database(), () => fixture.at);
      const context = await owner.context(21, fixture.actorId);
      const draft = { sourceVersion: context.sourceVersion, change: { purchaseOrderLineId: 21, allocations: [{
        receivingLineId: context.receipts[0].receivingLineId, invoiceLineId: 72, receiptStartPiece: 0, invoiceStartPiece: 0, pieces: 100 }] } };
      const measured = await owner.preview(draft, fixture.actorId);
      const body = { ...draft, previewVersion: measured.previewVersion, reason, approvalConfirmed: true };
      const scope = { method: "POST", ...receiptInvoiceCommandScope(21) };
      expect(await owner.approve(body, fixture.actorId, { ...scope, actorId: fixture.actorId, actorType: "user", contractVersion: 1,
        idempotencyKey: randomUUID(), requestHash: hashHttpFinancialCommand({ ...scope, body }) })).toMatchObject({ httpStatus: 200 });
      const assignments = (await query("SELECT * FROM procurement.receipt_invoice_cost_allocations ORDER BY id")).rows;
      const approved = (await query("SELECT product_total_cost_mills::text,cost_provisional FROM inventory.inventory_lots ORDER BY id")).rows;
      expect(approved).toEqual([{ product_total_cost_mills: "1200000", cost_provisional: 0 }]);
      const dispute = await review("dispute");
      expect(dispute.preview.costReviews[0]).toMatchObject({ state: "review_required", issues: expect.arrayContaining([expect.objectContaining({ code: "RECEIPT_INVOICE_ALLOCATION_REVIEW" })]) });
      await save("dispute", dispute.body);
      expect((await query("SELECT product_total_cost_mills::text,cost_provisional FROM inventory.inventory_lots ORDER BY id")).rows)
        .toEqual([{ product_total_cost_mills: "1200000", cost_provisional: 1 }]);
      await approve();
      expect((await query("SELECT product_total_cost_mills::text,cost_provisional FROM inventory.inventory_lots ORDER BY id")).rows).toEqual(approved);
      expect((await query("SELECT * FROM procurement.receipt_invoice_cost_allocations ORDER BY id")).rows).toEqual(assignments);
      expect((await query("SELECT * FROM inventory.cost_reconciliation_postings")).rows).toEqual([]);
    });
    it.each([{ reason: null }, { reason: 10 }, { reason, previewVersion: "invalid" }, { reason, invoiceAmountCents: 1 }])(
      "rejects malformed or extra public action fields without a financial mutation", async body => {
        await prepare(); const before = await snapshot();
        expect(await save("approve", body)).toMatchObject({ httpStatus: 400 });
        expect(await snapshot()).toEqual(before);
      });

    describe("actual AP HTTP routes", () => {
      let server: Server, endpoint: string;
      beforeAll(async () => {
        const { registerApLedgerRoutes } = await import("../../ap-ledger.routes");
        const app = express(); app.use(express.json());
        app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { user: { id: fixture.actorId } }; next(); });
        registerApLedgerRoutes(app); server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/vendor-invoices`;
      });
      afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
      it("requires and commits the actual reviewed body through the public approval route and reads the retained history", async () => {
        await prepare();
        const post = async (path: string, body: unknown) => { const response = await requestLocalHttp(endpoint + path, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
        expect(await post("/71/approve", {})).toMatchObject({ status: 400 });
        const response = await post("/71/approve/preview", { reason });
        expect(response.status).toBe(200); const reviewed = apInvoiceTransitionPreviewSchema.parse(response.body);
        expect(await post("/71/approve", { reason, previewVersion: reviewed.previewVersion })).toMatchObject({ status: 200, body: { transitionReview: { preview: { action: "approve" } } } });
        const history = await requestLocalHttp(endpoint + "/71/transition-history"); expect(history.status).toBe(200); expect(await history.json()).toHaveLength(1);
        expect(await post("/071/approve/preview", { reason })).toMatchObject({ status: 400 });
      });
    });
  });
}
