import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import { registerInvoiceCostReviewRoute } from "../../invoice-cost-review.routes";
import { registerInvoiceCostReviewPreviewRoute } from "../../invoice-cost-review-preview.routes";
import { runTransactionalFinancialCommand } from "../../../../platform/commands/transactional-command.service";
import type pg from "pg";
import type { AmendmentDatabase } from "../../po-quantity-amendment.repository";
import { createInvoiceCostReviewPreviewService } from "../../invoice-cost-review-preview.service";
import { createInvoiceCostReviewCommands } from "../../invoice-cost-review.service";
import { createDrizzleFinancialCommandRepository } from "../../../../platform/commands/command-results.repository";
import { invoiceCostReviewVersion } from "../../ap-ledger.service";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import { readPurchaseCostStatus } from "../../purchase-cost-status.repository";
import { supplierCostReviewTasks } from "@shared/procurement/cost-review-tasks";
import type { InvoiceCostReview } from "@shared/procurement/invoice-cost-review";

export function registerInvoiceCostTaskReviewCases(fixture: {
  pool: () => pg.Pool; database: () => AmendmentDatabase; at: Date; actorId: string;
  receive: () => Promise<unknown>; sell: () => Promise<unknown>;
}) {
  const query = (text: string, values?: unknown[]) => fixture.pool().query(text, values);
  const preview = () => createInvoiceCostReviewPreviewService(fixture.database(), () => fixture.at);
  const commands = () => createInvoiceCostReviewCommands(createDrizzleFinancialCommandRepository(fixture.database()), () => fixture.at);
  async function source() {
    const row = (await query("SELECT * FROM procurement.vendor_invoice_lines WHERE id=72")).rows[0];
    return invoiceCostReviewVersion({ id: row.id, qtyInvoiced: row.qty_invoiced, unitCostCents: Number(row.unit_cost_cents), unitCostMills: Number(row.unit_cost_mills), lineTotalCents: Number(row.line_total_cents), costComponentEvidence: row.cost_component_evidence });
  }
  async function input(): Promise<InvoiceCostReview> { return { expectedVersion: await source(), packagingTreatment: "separate", productMills: 1200000, packagingMills: 100000, adjustmentMills: 0, reason: "Final supplier document checked against this product" }; }
  async function prepare() {
    await fixture.receive();
    // A synthetic close-short purchase: 100 pieces received, the unshipped
    // balance cancelled, and an approved final invoice whose split is missing.
    await query("UPDATE procurement.purchase_order_lines SET status='closed',cancelled_qty=100 WHERE id=21");
    await query("UPDATE procurement.vendor_invoices SET status='approved',invoiced_amount_cents=13000,balance_cents=13000 WHERE id=71");
    await query("UPDATE procurement.vendor_invoice_lines SET qty_invoiced=100,line_total_cents=13000,cost_component_evidence=NULL WHERE id=72");
  }
  async function snapshot() {
    const tables = ["procurement.vendor_invoice_lines", "procurement.vendor_invoices", "procurement.purchase_order_lines", "procurement.receiving_lines", "inventory.inventory_lots", "oms.order_item_costs", "procurement.cost_source_revisions", "inventory.cost_applications", "inventory.cost_reconciliation_approvals", "inventory.cost_reconciliation_postings", "public.audit_events", "procurement.po_events"];
    return Promise.all(tables.map(async table => (await query(`SELECT * FROM ${table} ORDER BY id`)).rows));
  }
  function save(body: InvoiceCostReview, key = randomUUID(), actorId = fixture.actorId) {
    const scope = { method: "POST", routeTemplate: "/api/vendor-invoice-lines/:lineId/cost-components", resourceKey: "vendor_invoice_line:72" };
    return commands().review(72, body, actorId, { ...scope, commandName: "ap.invoice.cost_components", actorType: "user", actorId, idempotencyKey: key, contractVersion: 1, requestHash: hashHttpFinancialCommand({ ...scope, body }) });
  }
  async function current() { return fixture.database().transaction(tx => readPurchaseCostStatus(tx, [21])); }

  describe("supplier cost tasks and real before/after review", () => {
    let server: Server, endpoint: string;
    beforeAll(async () => {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { user: { id: req.header("X-Test-Actor") ?? fixture.actorId, role: "admin" } }; next(); });
      registerInvoiceCostReviewRoute(app, commands());
      registerInvoiceCostReviewPreviewRoute(app, preview());
      server = createServer(app);
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/vendor-invoice-lines`;
    });
    afterAll(async () => { if (server) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); });
    async function post(body: unknown, options: { operation?: string; actor?: string; key?: string; id?: string } = {}) {
      const response = await requestLocalHttp(`${endpoint}/${options.id ?? "72"}/cost-components${options.operation ?? ""}`, { method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": options.key ?? randomUUID(),
          ...(options.actor ? { "X-Test-Actor": options.actor } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json(), replayed: response.headers.get("Idempotency-Replayed") };
    }
    it("explains missing invoice amounts with exact quantities without changing any saved financial source", async () => {
      await prepare(); const before = await snapshot();
      const status = await current();
      expect(status.lines[0].reviewFacts).toMatchObject({ quantityBasis: "received", expectedPieces: 100, invoicedPieces: 100, quantityMatches: true, missingAmountLineIds: [72], invoiceAmountCents: 13000 });
      expect(supplierCostReviewTasks(status.lines[0]).map(task => task.action)).toEqual(["invoice_amounts"]);
      expect(await snapshot()).toEqual(before);
    });
    it("previews the existing cost owner and rolls back invoice, audit, inventory and order writes", async () => {
      await prepare(); const before = await snapshot(), body = await input();
      const result = await preview()(72, body, fixture.actorId);
      expect(result.preview).toMatchObject({ lineId: 72, before: null, after: { productMills: 1200000, packagingMills: 100000 } });
      expect(result.preview.impact.lots.some(row => row.unitCostMills.before !== row.unitCostMills.after)).toBe(true);
      expect(result.preview.inventoryValues).toEqual([expect.objectContaining({ onHandUnits: 2, beforeMills: 1100000, afterMills: 1300000, reviewReason: null })]);
      expect(await snapshot()).toEqual(before);
    });
    it("applies the reviewed change once and moves the shared tasks to completed with the actor and time", async () => {
      await prepare(); const body = await input(), reviewed = await preview()(72, body, fixture.actorId);
      const request = { ...body, previewVersion: reviewed.preview.previewVersion }, key = randomUUID();
      expect(await save(request, key)).toMatchObject({ httpStatus: 200 });
      const saved = await snapshot();
      expect(await save(request, key)).toMatchObject({ httpStatus: 200, replayed: true });
      expect(await snapshot()).toEqual(saved);
      const status = await current();
      expect(supplierCostReviewTasks(status.lines[0])).toEqual([]);
      expect(status.lines[0].components).toEqual(expect.arrayContaining([expect.objectContaining({ status: "applied", postingReceipt: expect.objectContaining({ actorName: "cost-audit-owner", recordedAt: fixture.at.toISOString() }) })]));
      expect((await query("SELECT * FROM inventory.cost_reconciliation_postings")).rows).toEqual([]);
      const approval = (await query("SELECT payload_json FROM procurement.po_events WHERE event_type='invoice_cost_components_approved'")).rows;
      expect(approval).toEqual([{ payload_json: expect.objectContaining({ actorName: "cost-audit-owner", approvedAt: fixture.at.toISOString(),
        commandKey: key, reason: body.reason, preview: reviewed.preview, authority: expect.objectContaining({ userId: fixture.actorId, active: true }) }) }]);
    });
    it("rejects a changed stock graph after preview rather than applying an unseen impact", async () => {
      await prepare(); const body = await input(), reviewed = await preview()(72, body, fixture.actorId);
      await fixture.sell(); const before = await snapshot();
      expect(await save({ ...body, previewVersion: reviewed.preview.previewVersion })).toMatchObject({ httpStatus: 409, body: { details: { code: "INVOICE_COST_REVIEW_STALE" } } });
      expect(await snapshot()).toEqual(before);
    });
    it("serializes competing approvals of the same preview", async () => {
      await prepare(); const body = await input(), reviewed = await preview()(72, body, fixture.actorId);
      const results = await Promise.all([save({ ...body, previewVersion: reviewed.preview.previewVersion }), save({ ...body, previewVersion: reviewed.preview.previewVersion })]);
      expect(results.map(result => result.httpStatus).sort()).toEqual([200, 409]);
      expect((await query("SELECT count(*)::int AS count FROM public.audit_events WHERE action='procurement.invoice.cost_components' AND target='invoice-line:72'")).rows[0].count).toBe(1);
    });
    it("rolls back the complete approved change when its final audit cannot be recorded", async () => {
      await prepare(); const body = await input(), reviewed = await preview()(72, body, fixture.actorId), before = await snapshot();
      await query(`CREATE FUNCTION procurement.reject_cost_task_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='procurement.invoice.cost_components' THEN RAISE EXCEPTION 'injected cost task audit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_cost_task_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION procurement.reject_cost_task_audit()`);
      try { await expect(save({ ...body, previewVersion: reviewed.preview.previewVersion })).rejects.toThrow(); }
      finally { await query("DROP TRIGGER reject_cost_task_audit ON public.audit_events; DROP FUNCTION procurement.reject_cost_task_audit()"); }
      expect(await snapshot()).toEqual(before);
    });
    it("requires a measured preview at the public save route before any financial write", async () => {
      await prepare(); const body = await input(), before = await snapshot();
      expect(await post(body)).toMatchObject({ status: 409, body: { details: { code: "INVOICE_COST_REVIEW_PREVIEW_REQUIRED" } } });
      expect(await snapshot()).toEqual(before);
    });
    it.each(["0", "-1", "72x", "00072", "72.5", "2147483648"])("rejects noncanonical invoice line %s", async id => {
      expect(await post({}, { id })).toMatchObject({ status: 400 });
    });
    it.each(["lead-user", "custom-user"])("rejects the session admin label for persisted actor %s", async actor => {
      await prepare(); const body = await input(), before = await snapshot();
      expect(await post(body, { operation: "/preview", actor })).toMatchObject({ status: 403, body: { details: { code: "INVOICE_COST_REVIEW_ADMIN_REQUIRED" } } });
      expect(await post({ ...body, previewVersion: "f".repeat(64) }, { actor })).toMatchObject({ status: 403 });
      expect(await snapshot()).toEqual(before);
    });
    it("rejects scoped approval grants at HTTP and in direct cost preview and approval", async () => {
      await prepare(); const body = await input(), before = await snapshot(), actor = "scoped-user";
      const request = { ...body, previewVersion: "f".repeat(64) };
      const denied = { status: 403, body: { error: "Permission denied: purchasing:approve" } };
      expect(await post(body, { operation: "/preview", actor })).toMatchObject(denied);
      expect(await post(request, { actor })).toMatchObject(denied);
      expect(await snapshot()).toEqual(before);
      await expect(preview()(72, body, actor)).rejects.toMatchObject({
        statusCode: 403, details: { code: "INVOICE_COST_REVIEW_ADMIN_REQUIRED" },
      });
      expect(await snapshot()).toEqual(before);
      expect(await save(request, randomUUID(), actor)).toMatchObject({
        httpStatus: 403, body: { details: { code: "INVOICE_COST_REVIEW_ADMIN_REQUIRED" } }, terminalState: "rejected",
      });
      expect(await snapshot()).toEqual(before);
    });
    it.each(["active", "role", "grant"])("rejects revoked %s authority between preview and approval", async revoked => {
      await prepare(); const body = await input(), reviewed = await preview()(72, body, fixture.actorId);
      if (revoked === "active") await query("UPDATE identity.users SET active=0 WHERE id=$1", [fixture.actorId]);
      if (revoked === "role") await query("DELETE FROM identity.auth_user_roles WHERE user_id=$1", [fixture.actorId]);
      if (revoked === "grant") await query("DELETE FROM identity.auth_role_permissions WHERE role_id=1 AND permission_id=1");
      const before = await snapshot();
      expect(await post({ ...body, previewVersion: reviewed.preview.previewVersion })).toMatchObject({ status: 403 });
      expect(await snapshot()).toEqual(before);
    });
    it("posts the public reviewed effect once and retains its immutable approval after the operational copy is removed", async () => {
      await prepare(); const body = await input(), before = await snapshot();
      const result = await post(body, { operation: "/preview" });
      expect(result.status).toBe(200); expect(await snapshot()).toEqual(before);
      const request = { ...body, previewVersion: result.body.preview.previewVersion }, key = randomUUID();
      const saved = await post(request, { key });
      expect(saved).toMatchObject({ status: 200, replayed: "false", body: { preview: result.body.preview } });
      const committed = await snapshot();
      expect(await post(request, { key })).toEqual({ ...saved, replayed: "true" }); expect(await snapshot()).toEqual(committed);
      const approval = (await query("SELECT * FROM procurement.po_events WHERE event_type='invoice_cost_components_approved'")).rows;
      expect(approval).toHaveLength(1);
      await query("DELETE FROM public.audit_events WHERE action='procurement.invoice.cost_components'");
      expect((await query("SELECT * FROM procurement.po_events WHERE event_type='invoice_cost_components_approved'")).rows).toEqual(approval);
    });
    it("keeps approved costing authority stable when only payment status progresses", async () => {
      await prepare(); const body = await input(), reviewed = await preview()(72, body, fixture.actorId);
      // Settlement owner is covered separately; this isolates a status change
      // in the AP record from a source amount, quantity or authority change.
      await query("UPDATE procurement.vendor_invoices SET status='partially_paid' WHERE id=71");
      expect(await save({ ...body, previewVersion: reviewed.preview.previewVersion })).toMatchObject({ httpStatus: 200 });
    });
    it("rejects a changed invoice approval state even when its line amounts are unchanged", async () => {
      await prepare(); const body = await input(), reviewed = await preview()(72, body, fixture.actorId);
      await query("UPDATE procurement.vendor_invoices SET status='disputed' WHERE id=71");
      const before = await snapshot();
      expect(await save({ ...body, previewVersion: reviewed.preview.previewVersion })).toMatchObject({ httpStatus: 409, body: { details: { code: "INVOICE_COST_REVIEW_STALE" } } });
      expect(await snapshot()).toEqual(before);
    });
    it("rolls back stock, source, command and operational audit when immutable approval retention fails", async () => {
      await prepare(); const body = await input(), reviewed = await preview()(72, body, fixture.actorId), before = await snapshot();
      await query(`CREATE FUNCTION procurement.reject_supplier_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type='invoice_cost_components_approved' THEN RAISE EXCEPTION 'private injected database detail'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_supplier_approval BEFORE INSERT ON procurement.po_events FOR EACH ROW EXECUTE FUNCTION procurement.reject_supplier_approval()`);
      try {
        const result = await post({ ...body, previewVersion: reviewed.preview.previewVersion });
        expect(result.status).toBe(503); expect(JSON.stringify(result.body)).not.toContain("private injected");
      } finally { await query("DROP TRIGGER reject_supplier_approval ON procurement.po_events; DROP FUNCTION procurement.reject_supplier_approval()"); }
      expect(await snapshot()).toEqual(before);
    });
    it("replays a committed pre-preview command without acquiring new costing authority", async () => {
      await prepare(); const body = await input(), key = randomUUID();
      const scope = { method: "POST", routeTemplate: "/api/vendor-invoice-lines/:lineId/cost-components", resourceKey: "vendor_invoice_line:72" };
      const evidence = { contractVersion: 1, source: "operator_review", packagingTreatment: body.packagingTreatment,
        productMills: body.productMills, packagingMills: body.packagingMills, adjustmentMills: body.adjustmentMills };
      await query("UPDATE procurement.vendor_invoice_lines SET cost_component_evidence=$1::jsonb WHERE id=72", [JSON.stringify(evidence)]);
      const legacy = { id: 72, costReviewVersion: await source(), costComponentEvidence: evidence, application: null };
      await runTransactionalFinancialCommand({ repository: createDrizzleFinancialCommandRepository(fixture.database()),
        descriptor: { ...scope, commandName: "ap.invoice.cost_components", actorType: "user", actorId: fixture.actorId, idempotencyKey: key, contractVersion: 1,
          requestHash: hashHttpFinancialCommand({ ...scope, params: { lineId: "72" }, query: {}, body }) },
        classifyFailure: () => ({ kind: "retryable", errorCode: "LEGACY_REVIEW_FIXTURE_FAILED", errorMessage: "Cannot seed disposable legacy command receipt." }),
        work: async () => ({ httpStatus: 200, body: legacy, resultType: "vendor_invoice_line", resultId: 72 }) });
      const before = await snapshot();
      expect(await post(body, { key })).toEqual({ status: 200, replayed: "true", body: legacy });
      expect(await snapshot()).toEqual(before);
    });
  });
}
