import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
    const tables = ["procurement.vendor_invoice_lines", "procurement.vendor_invoices", "procurement.purchase_order_lines", "procurement.receiving_lines", "inventory.inventory_lots", "oms.order_item_costs", "procurement.cost_source_revisions", "inventory.cost_applications", "inventory.cost_reconciliation_approvals", "inventory.cost_reconciliation_postings", "public.audit_events"];
    return Promise.all(tables.map(async table => (await query(`SELECT * FROM ${table} ORDER BY id`)).rows));
  }
  function save(body: InvoiceCostReview, key = randomUUID()) {
    const scope = { method: "POST", routeTemplate: "/api/vendor-invoice-lines/:lineId/cost-components", resourceKey: "vendor_invoice_line:72" };
    return commands().review(72, body, fixture.actorId, { ...scope, commandName: "ap.invoice.cost_components", actorType: "user", actorId: fixture.actorId, idempotencyKey: key, contractVersion: 1, requestHash: hashHttpFinancialCommand({ ...scope, body }) });
  }
  async function current() { return fixture.database().transaction(tx => readPurchaseCostStatus(tx, [21])); }

  describe("supplier cost tasks and real before/after review", () => {
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
  });
}
