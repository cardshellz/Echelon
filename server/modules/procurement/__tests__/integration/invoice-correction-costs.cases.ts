import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import { invoiceQuantityContextSchema, invoiceQuantityPreviewSchema, invoiceQuantityResultSchema,
  type InvoiceQuantityApprovalRequest, type InvoiceQuantityPreviewRequest } from "@shared/procurement/invoice-quantity-correction";
import { createInvoiceQuantityCorrectionService } from "../../invoice-quantity-correction.service";
import { registerInvoiceQuantityCorrectionRoutes } from "../../invoice-quantity-correction.routes";
import { readPurchaseCostStatus } from "../../purchase-cost-status.repository";
import type { AmendmentDatabase } from "../../po-quantity-amendment.repository";
import { createDrizzleFinancialCommandRepository } from "../../../../platform/commands/command-results.repository";
import { runTransactionalFinancialCommand } from "../../../../platform/commands/transactional-command.service";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";

export function registerInvoiceCorrectionCostCases(fixture: {
  pool: () => pg.Pool; database: () => AmendmentDatabase; actorId: string; at: Date;
  receive: () => Promise<unknown>; consume: () => Promise<unknown>;
}) {
  const query = (text: string, values?: unknown[]) => fixture.pool().query(text, values);
  let server: Server, endpoint: string, actorId: string;
  async function prepare(paid = false) {
    actorId = fixture.actorId;
    await fixture.receive();
    // A complete 100-piece receipt with a wrong invoice count. The saved
    // supplier document is $120 product + $10 packaging, not a guessed split.
    await query(`UPDATE procurement.purchase_order_lines SET order_qty=100,received_qty=100,status='received',
      total_product_cost_cents=10000,packaging_cost_cents=1000,line_total_cents=11000 WHERE id=21;
      UPDATE procurement.purchase_orders SET status='received',physical_status='received',line_count=1,received_line_count=1,
        subtotal_cents=11000,total_cents=11000 WHERE id=10;
      UPDATE procurement.vendor_invoices SET status='approved',currency='USD',invoiced_amount_cents=13000,paid_amount_cents=0,balance_cents=13000 WHERE id=71;
      UPDATE procurement.vendor_invoice_lines SET qty_invoiced=50,line_total_cents=13000,
        cost_component_evidence='{"contractVersion":1,"packagingTreatment":"separate","productMills":1200000,"packagingMills":100000,"adjustmentMills":0,"source":"operator_review"}'::jsonb WHERE id=72;
      INSERT INTO procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id,allocated_amount_cents) VALUES(71,10,13000);
      INSERT INTO inventory.warehouse_settings(warehouse_code,require_approval) VALUES('DEFAULT',false)`);
    if (paid) {
      const { recordPayment } = await import("../../ap-ledger.service");
      await recordPayment({ vendorId: 5, currency: "USD", status: "completed", totalAmountCents: 13000,
        paymentDate: fixture.at, paymentMethod: "wire", createdBy: actorId,
        allocations: [{ vendorInvoiceId: 71, appliedAmountCents: 13000 }] }, { now: fixture.at });
    }
  }
  async function read() {
    const response = await requestLocalHttp(endpoint);
    expect(response.status).toBe(200);
    return invoiceQuantityContextSchema.parse(await response.json());
  }
  async function draft(overrides: Partial<InvoiceQuantityPreviewRequest> = {}): Promise<InvoiceQuantityPreviewRequest> {
    const context = await read();
    return { sourceVersion: context.sourceVersion, quantityPieces: 100, unitCostMills: 12000, lineTotalCents: 13000,
      ...(context.closedPurchaseOrder ? { closedPurchaseOrderConfirmed: true } : {}), ...overrides };
  }
  async function post(path: string, body: unknown, key?: string) {
    const response = await requestLocalHttp(endpoint + path, { method: "POST", headers: {
      "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}),
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), replayed: response.headers.get("Idempotency-Replayed") };
  }
  async function reviewed(overrides: Partial<InvoiceQuantityPreviewRequest> = {}) {
    const body = await draft(overrides), response = await post("/preview", body);
    expect(response.status).toBe(200);
    const preview = invoiceQuantityPreviewSchema.parse(response.body);
    expect(preview.previewVersion).toMatch(/^[a-f0-9]{64}$/);
    const request: InvoiceQuantityApprovalRequest = { ...body, previewVersion: preview.previewVersion,
      reason: "Supplier document and recorded receipt checked together", approvalConfirmed: true };
    return { preview, request };
  }
  async function snapshot() {
    const tables = ["procurement.vendor_invoices", "procurement.vendor_invoice_lines", "procurement.vendor_invoice_po_links",
      "procurement.purchase_orders", "procurement.purchase_order_lines", "procurement.receiving_orders", "procurement.receiving_lines",
      "procurement.po_receipts", "procurement.po_events", "procurement.po_status_history", "procurement.po_exceptions",
      "inventory.inventory_lots", "inventory.inventory_transactions", "oms.order_item_costs", "procurement.ap_payments",
      "procurement.ap_payment_allocations", "procurement.cost_source_revisions", "inventory.cost_applications",
      "inventory.cost_application_lots", "inventory.cost_reporting_events", "inventory.cost_reconciliation_approvals",
      "inventory.cost_reconciliation_postings", "inventory.lot_cost_quantity_bases", "inventory.lot_cost_quantity_allocations"];
    const data = await Promise.all(tables.map(async table => ({ table,
      rows: (await query(`SELECT to_jsonb(record) AS value FROM ${table} record ORDER BY to_jsonb(record)::text`)).rows })));
    return { data, audit: (await query("SELECT * FROM public.audit_events WHERE actor=$1 ORDER BY id", [fixture.actorId])).rows };
  }
  async function physical() {
    return {
      stock: (await query("SELECT id,product_variant_id,qty_received,qty_on_hand,qty_picked,qty_packed,warehouse_location_id FROM inventory.inventory_lots ORDER BY id")).rows,
      receipts: (await query("SELECT * FROM procurement.po_receipts ORDER BY id")).rows,
      receiving: (await query("SELECT * FROM procurement.receiving_lines ORDER BY id")).rows,
      shipping: (await query("SELECT * FROM procurement.inbound_shipment_lines ORDER BY id")).rows,
      payments: (await query("SELECT * FROM procurement.ap_payments ORDER BY id")).rows,
      allocations: (await query("SELECT * FROM procurement.ap_payment_allocations ORDER BY id")).rows,
    };
  }

  describe("invoice correction through HTTP and real cost owners", () => {
    beforeAll(async () => {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { user: { id: actorId, role: "admin" } }; next(); });
      registerInvoiceQuantityCorrectionRoutes(app, createInvoiceQuantityCorrectionService(fixture.database(), () => fixture.at));
      server = createServer(app);
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/vendor-invoice-lines/72/quantity-correction`;
    });
    afterAll(async () => { if (server) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); });

    it("measures the exact stock cost change and rolls back every preview write", async () => {
      await prepare(); const before = await snapshot(), result = await reviewed();
      expect(result.preview.costing).toMatchObject({ purchaseOrderLineId: 21, inventoryValues: [{
        onHandUnits: 2, onHandValueMills: { before: 1100000, after: 1300000 },
      }], applications: [{ status: "applied" }, { status: "applied" }] });
      expect(await snapshot()).toEqual(before);
    });

    it("updates quantity and supplier costs with one approval and replays the same posting after a lost response", async () => {
      await prepare(); const unchanged = await physical(), { preview, request } = await reviewed(), key = randomUUID();
      const first = await post("", request, key); expect(first.status).toBe(200);
      expect(invoiceQuantityResultSchema.parse(first.body).preview).toEqual(preview);
      const saved = await snapshot(), replay = await post("", request, key);
      expect(replay).toMatchObject({ status: 200, replayed: "true", body: first.body });
      expect(await snapshot()).toEqual(saved); expect(await physical()).toEqual(unchanged);
      expect((await query("SELECT qty_invoiced FROM procurement.vendor_invoice_lines WHERE id=72")).rows[0].qty_invoiced).toBe(100);
      const status = await fixture.database().transaction(tx => readPurchaseCostStatus(tx, [21]));
      expect(status.lines[0].components.every(row => row.status === "applied" && row.sourceEvidence === "confirmed")).toBe(true);
      const audit = await query("SELECT context FROM public.audit_events WHERE actor=$1 AND action='procurement.invoice.quantity_corrected'", [fixture.actorId]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].context).toMatchObject({ reviewedSourceVersion: request.sourceVersion, preview: { previewVersion: preview.previewVersion }, costApplication: { costApplications: [{ status: "applied" }, { status: "applied" }] } });
      expect((await query("SELECT count(*)::int AS count FROM inventory.cost_reconciliation_postings")).rows[0].count).toBe(0);
    });

    it("replays a committed legacy correction without granting a new cost application", async () => {
      await prepare();
      const { preview, request } = await reviewed();
      const { previewVersion: _requestedVersion, ...legacyRequest } = request;
      const { previewVersion: _version, costing: _costing, beforeCostComponents: _before, afterCostComponents: _after,
        costComponentsReviewed: _reviewed, ...legacyPreview } = preview;
      // Import an old-format command receipt into the disposable fixture using
      // the real command owner. It represents a document-only historical save.
      await query("UPDATE procurement.vendor_invoice_lines SET qty_invoiced=100 WHERE id=72");
      const audit = await query(`INSERT INTO public.audit_events(timestamp,level,actor,action,target)
        VALUES($1,'AUDIT',$2,'procurement.invoice.quantity_corrected','invoice-line:72') RETURNING id`, [fixture.at, fixture.actorId]);
      const body = { invoiceLineId: 72, auditEventId: audit.rows[0].id, preview: legacyPreview };
      const key = randomUUID(), routeTemplate = "/api/vendor-invoice-lines/:lineId/quantity-correction", resourceKey = "vendor_invoice_line:72";
      await runTransactionalFinancialCommand({ repository: createDrizzleFinancialCommandRepository(fixture.database()),
        classifyFailure: () => ({ kind: "retryable", errorCode: "LEGACY_CORRECTION_FIXTURE_IMPORT_FAILED",
          errorMessage: "The disposable legacy correction receipt could not be imported." }),
        descriptor: { actorType: "user", actorId: fixture.actorId, method: "POST", routeTemplate, resourceKey,
          commandName: "ap.invoice.quantity_correction", contractVersion: 1, idempotencyKey: key,
          requestHash: hashHttpFinancialCommand({ method: "POST", routeTemplate, resourceKey, params: { lineId: "72" }, query: {}, body: legacyRequest }) },
        work: async () => ({ httpStatus: 200, body, resultType: "invoice_quantity_correction", resultId: audit.rows[0].id }),
      });
      const before = await snapshot();
      expect(await post("", legacyRequest, key)).toMatchObject({ status: 200, replayed: "true", body });
      expect(await snapshot()).toEqual(before);
      expect((await query("SELECT product_total_cost_mills FROM inventory.inventory_lots")).rows[0].product_total_cost_mills).toBe("1000000");
    });

    it.each(["direct_charge", "freight_line"])("preserves all records when a %s links this bill to shipment costing", async link => {
      await prepare(); const body = await draft();
      if (link === "direct_charge") await query("UPDATE procurement.inbound_freight_costs SET vendor_invoice_id=71 WHERE id=31");
      else await query(`INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,freight_cost_id,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents)
        VALUES(73,71,2,31,1,0,0,0)`);
      const before = await snapshot();
      expect((await read()).blockedReason).toContain("combined invoice and freight review");
      expect(await post("/preview", { ...body, sourceVersion: (await read()).sourceVersion }))
        .toMatchObject({ status: 409, body: { code: "INVOICE_QUANTITY_BLOCKED" } });
      expect(await snapshot()).toEqual(before);
    });

    it("corrects billed amount and cost breakdown on a closed paid PO while preserving cash and physical facts", async () => {
      await prepare(true); await query("UPDATE procurement.purchase_orders SET status='closed',physical_status='closed',closed_at='2026-10-01' WHERE id=10");
      const unchanged = await physical(), { preview, request } = await reviewed({ lineTotalCents: 15000, unitCostMills: 14000,
        costComponents: { packagingTreatment: "separate", productMills: 1400000, packagingMills: 100000, adjustmentMills: 0 } });
      expect(preview).toMatchObject({ closedPurchaseOrder: true, afterInvoiceAmountCents: 15000, paidAmountCents: 13000, afterBalanceCents: 2000,
        costing: { inventoryValues: [{ onHandValueMills: { before: 1100000, after: 1500000 } }] } });
      expect((await post("", request, randomUUID())).status).toBe(200); expect(await physical()).toEqual(unchanged);
      expect((await query("SELECT status,physical_status FROM procurement.purchase_orders WHERE id=10")).rows[0]).toEqual({ status: "closed", physical_status: "closed" });
      expect((await query("SELECT paid_amount_cents,balance_cents,status FROM procurement.vendor_invoices WHERE id=71")).rows[0]).toEqual({ paid_amount_cents: "13000", balance_cents: "2000", status: "partially_paid" });
    });

    it("updates tracked order cost basis and remaining stock without creating an unapproved historical expense", async () => {
      await prepare(); await fixture.consume(); const unchanged = await physical(), { preview, request } = await reviewed();
      expect(preview.costing).toMatchObject({ inventoryValues: [{ onHandUnits: 1, onHandValueMills: { before: 550000, after: 650000 } }],
        orderCosts: [{ totalMills: { before: 550000, after: 650000 } }], historicalCosts: [] });
      expect((await post("", request, randomUUID())).status).toBe(200); expect(await physical()).toEqual(unchanged);
      expect((await query("SELECT count(*)::int AS count FROM inventory.cost_reconciliation_postings")).rows[0].count).toBe(0);
    });

    it("keeps a bill with missing supplier amounts as a durable cost review instead of pricing unknown costs", async () => {
      await prepare(); const unchanged = await physical(), { preview, request } = await reviewed({ lineTotalCents: 15000 });
      expect(preview).toMatchObject({ afterCostComponents: null, costing: { applications: [{ status: "review_required" }, { status: "review_required" }] } });
      expect(preview.costing?.inventoryValues.every(row => row.onHandValueMills.before === row.onHandValueMills.after)).toBe(true);
      expect((await post("", request, randomUUID())).status).toBe(200); expect(await physical()).toEqual(unchanged);
      expect((await query("SELECT line_total_cents,cost_component_evidence FROM procurement.vendor_invoice_lines WHERE id=72")).rows[0])
        .toEqual({ line_total_cents: "15000", cost_component_evidence: null });
    });

    it("saves the invoice while keeping a genuine receipt-origin issue separate from its costs", async () => {
      await prepare();
      await query("UPDATE procurement.receiving_lines SET cost_source_kind='legacy_unverified' WHERE purchase_order_line_id=21");
      const unchanged = await physical(), { preview, request } = await reviewed();
      expect(preview.costing?.applications.every(row => row.status === "review_required"
        && row.issues.some(issue => issue.code === "COST_ROOT_REVIEW_REQUIRED"))).toBe(true);
      expect((await post("", request, randomUUID())).status).toBe(200);
      expect(await physical()).toEqual(unchanged);
      expect((await query("SELECT count(*)::int AS count FROM inventory.cost_reconciliation_postings")).rows[0].count).toBe(0);
    });

    it("previews exact stock and order values without multiplying rounded cost-per-unit mirrors", async () => {
      await prepare(); await fixture.consume();
      const { preview, request } = await reviewed({ unitCostMills: 1, lineTotalCents: 2,
        costComponents: { packagingTreatment: "separate", productMills: 101, packagingMills: 99, adjustmentMills: 0 } });
      expect(preview.costing).toMatchObject({ inventoryValues: [{ originalLotTotalMills: { after: 200 }, onHandValueMills: { after: 101 } }],
        orderCosts: [{ totalMills: { after: 99 } }] });
      expect((await post("", request, randomUUID())).status).toBe(200);
      expect((await query("SELECT total_unit_cost_mills,product_total_cost_mills,packaging_total_cost_mills FROM inventory.inventory_lots")).rows)
        .toEqual([{ total_unit_cost_mills: "101", product_total_cost_mills: "101", packaging_total_cost_mills: "99" }]);
    });

    it("rejects a new approval that never reviewed its downstream cost effects", async () => {
      await prepare(); const body = { ...await draft(), reason: "Supplier quantity correction without preview", approvalConfirmed: true }, before = await snapshot();
      expect(await post("", body, randomUUID())).toMatchObject({ status: 409, body: { code: "INVOICE_QUANTITY_PREVIEW_REQUIRED" } });
      expect(await snapshot()).toEqual(before);
    });

    it("rejects a changed impact fingerprint atomically", async () => {
      await prepare(); const { request } = await reviewed(), before = await snapshot();
      expect(await post("", { ...request, previewVersion: "f".repeat(64) }, randomUUID())).toMatchObject({ status: 409, body: { code: "INVOICE_QUANTITY_STALE" } });
      expect(await snapshot()).toEqual(before);
    });

    it("rejects stock changes after preview before changing either document or costs", async () => {
      await prepare(); const { request } = await reviewed(); await fixture.consume(); const before = await snapshot();
      expect(await post("", request, randomUUID())).toMatchObject({ status: 409, body: { code: "INVOICE_QUANTITY_STALE" } });
      expect(await snapshot()).toEqual(before);
    });

    it("rechecks administrator authority after preview", async () => {
      await prepare(); const { request } = await reviewed();
      await query("UPDATE identity.auth_user_roles SET role_id=2 WHERE user_id=$1", [fixture.actorId]); const before = await snapshot();
      expect((await post("", request, randomUUID())).status).toBe(403); expect(await snapshot()).toEqual(before);
    });

    it("allows one of two concurrently approved, separately reviewed corrections", async () => {
      await prepare(); const first = await reviewed(), second = await reviewed({ lineTotalCents: 15000,
        costComponents: { packagingTreatment: "separate", productMills: 1400000, packagingMills: 100000, adjustmentMills: 0 } });
      const results = await Promise.all([post("", first.request, randomUUID()), post("", second.request, randomUUID())]);
      expect(results.map(row => row.status).sort()).toEqual([200, 409]);
      expect((await query("SELECT count(*)::int AS count FROM public.audit_events WHERE actor=$1 AND action IN('procurement.invoice.line_corrected','procurement.invoice.quantity_corrected')", [fixture.actorId])).rows[0].count).toBe(1);
    });

    it.each(["cost_reporting", "correction_audit"])("rolls back document, inventory and history together when %s fails", async failure => {
      await prepare(); const { request } = await reviewed(), before = await snapshot(), key = randomUUID();
      const table = failure === "cost_reporting" ? "inventory.cost_reporting_events" : "public.audit_events";
      const condition = failure === "cost_reporting" ? "TRUE" : "NEW.action IN('procurement.invoice.quantity_corrected','procurement.invoice.line_corrected')";
      await query(`CREATE FUNCTION public.invoice_correction_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF ${condition} THEN RAISE EXCEPTION 'invoice correction injected failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER invoice_correction_test_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.invoice_correction_test_failure()`);
      try {
        expect((await post("", request, key)).status).toBe(500); expect(await snapshot()).toEqual(before);
      } finally { await query(`DROP TRIGGER invoice_correction_test_failure ON ${table}; DROP FUNCTION public.invoice_correction_test_failure()`); }
      await query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM next_attempt_at-clock_timestamp()))+0.01) FROM public.financial_command_results WHERE idempotency_key=$1", [key]);
      expect((await post("", request, key)).status).toBe(200);
    });

    it("refuses legacy averaging when multiple invoices need a receipt-specific assignment", async () => {
      await prepare(); await query(`INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,status,currency,invoiced_amount_cents,balance_cents)
        VALUES(73,'SECOND-SUPPLIER-INVOICE',5,'approved','USD',3000,3000);
        INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,purchase_order_line_id,line_number,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents,cost_component_evidence)
        VALUES(74,73,21,1,50,60,6000,3000,'{"contractVersion":1,"packagingTreatment":"included_in_product","productMills":300000,"packagingMills":0,"adjustmentMills":0,"source":"operator_review"}'::jsonb);
        INSERT INTO procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id,allocated_amount_cents) VALUES(73,10,3000)`);
      const before = await snapshot();
      expect(await post("/preview", await draft({ quantityPieces: 50, lineTotalCents: 5000, unitCostMills: 9000,
        costComponents: { packagingTreatment: "separate", productMills: 450000, packagingMills: 50000, adjustmentMills: 0 } })))
        .toMatchObject({ status: 409, body: { code: "INVOICE_CORRECTION_RECEIPT_ALLOCATION_REQUIRED" } });
      expect(await snapshot()).toEqual(before);
    });

    it("posts explicit zero-cost goods without falling back to a positive PO quote", async () => {
      await prepare(); const { preview, request } = await reviewed({ unitCostMills: 0, lineTotalCents: 0,
        costComponents: { packagingTreatment: "included_in_product", productMills: 0, packagingMills: 0, adjustmentMills: 0 } });
      expect(preview.costing?.inventoryValues[0].onHandValueMills.after).toBe(0);
      expect((await post("", request, randomUUID())).status).toBe(200);
      expect((await query("SELECT product_total_cost_mills,packaging_total_cost_mills FROM inventory.inventory_lots")).rows)
        .toEqual([{ product_total_cost_mills: "0", packaging_total_cost_mills: "0" }]);
    });
  });
}
