import { randomUUID } from "node:crypto";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { supplierHeaderContextSchema, supplierHeaderPreviewSchema, supplierHeaderResultSchema, type SupplierHeaderEntry, type SupplierHeaderTarget } from "@shared/procurement/supplier-header-costs";
import { registerSupplierHeaderCostRoutes } from "../../supplier-header-costs.routes";
import { createSupplierHeaderCostService } from "../../supplier-header-cost-review.service";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import type { AmendmentDatabase } from "../../po-quantity-amendment.repository";
import type { ShipmentTrackingService } from "../../shipment-tracking.service";
import { createSupplierCreditCommands } from "../../supplier-credit.commands";
import { createSupplierCreditCostPreview } from "../../supplier-credit.service";
import { loadSupplierCreditSource, readSupplierCreditDetail } from "../../supplier-credit.repository";
import { createDrizzleFinancialCommandRepository } from "../../../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import type { SupplierCreditCommand, SupplierCreditDetail } from "@shared/procurement/supplier-credit";
import { createPurchaseTaxChangeService, purchaseTaxCommandScope } from "../../purchase-tax-change.service";
import { readPoShipmentCosts } from "../../po-shipment-cost-summary.repository";

export function registerSupplierHeaderCostCases(fixture: { pool: () => pg.Pool; database: () => AmendmentDatabase;
  shipments: () => ShipmentTrackingService; actorId: string; at: Date; receive: () => Promise<unknown>; consume: () => Promise<unknown> }) {
  const query = (text: string, values?: unknown[]) => fixture.pool().query(text, values);
  const target = { kind: "invoice", id: 71 } as const;
  let server: Server, endpoint: string, actorId: string;
  async function post(action: string, body: unknown, key?: string) {
    const response = await requestLocalHttp(`${endpoint}/${action}`, { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), replayed: response.headers.get("Idempotency-Replayed") };
  }
  async function context(scope: SupplierHeaderTarget = target) {
    const response = await requestLocalHttp(`${endpoint}?kind=${scope.kind}&id=${scope.id}`);
    expect(response.status).toBe(200); return supplierHeaderContextSchema.parse(await response.json());
  }
  async function setup() {
    actorId = fixture.actorId;
    await query(`UPDATE procurement.purchase_order_lines SET order_qty=100,total_product_cost_cents=10000,packaging_cost_cents=1000,line_total_cents=11000 WHERE id=21;
      UPDATE procurement.vendor_invoice_lines SET qty_invoiced=100,line_total_cents=13000,
       cost_component_evidence='{"contractVersion":1,"source":"operator_review","packagingTreatment":"combined","productMills":1300000,"packagingMills":0,"adjustmentMills":0}' WHERE id=72;
      UPDATE procurement.vendor_invoices SET status='received',invoiced_amount_cents=13200,balance_cents=13200 WHERE id=71`);
    await fixture.receive(); await fixture.consume();
    await query("UPDATE procurement.vendor_invoices SET status='approved' WHERE id=71");
  }
  async function review(entries?: SupplierHeaderEntry[], scope: SupplierHeaderTarget = target) {
    const loaded = await context(scope), request = { target: scope, sourceVersion: loaded.sourceVersion, entries: entries ?? loaded.proposed, reason: "Checked the original supplier header and exact line shares" };
    const result = await post("preview", request);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const preview = supplierHeaderPreviewSchema.parse(result.body);
    return { preview, request: { ...request, previewVersion: preview.previewVersion, approvalConfirmed: true } };
  }
  async function originalFacts() {
    return { bill: (await query("SELECT * FROM procurement.vendor_invoices WHERE id=71")).rows,
      lines: (await query("SELECT id,qty_invoiced,line_total_cents,cost_component_evidence FROM procurement.vendor_invoice_lines WHERE vendor_invoice_id=71 ORDER BY id")).rows,
      stock: (await query("SELECT id,qty_received,qty_on_hand,qty_picked,qty_packed FROM inventory.inventory_lots ORDER BY id")).rows,
      receipts: (await query("SELECT * FROM procurement.po_receipts ORDER BY id")).rows };
  }
  function creditCommand(command: SupplierCreditCommand, body: unknown, creditId?: number) {
    const scope = { method: "POST", routeTemplate: command === "create" ? "/api/supplier-credits" : `/api/supplier-credits/:id/${command}`, resourceKey: `supplier-credit:${creditId ?? "new"}:document` };
    return createSupplierCreditCommands(createDrizzleFinancialCommandRepository(fixture.database()), () => fixture.at).execute(command, body, {
      ...scope, actorType: "user", actorId: fixture.actorId, commandName: `supplier_credit.${command}`, idempotencyKey: randomUUID(), contractVersion: 1,
      requestHash: hashHttpFinancialCommand({ ...scope, params: creditId === undefined ? {} : { id: String(creditId) }, query: {}, body }),
    }, creditId);
  }
  describe("supplier header HTTP approval through existing financial and inventory owners", () => {
    beforeAll(async () => { const app = express(); app.use(express.json());
      app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { user: { id: actorId, role: "admin" } }; next(); });
      registerSupplierHeaderCostRoutes(app, createSupplierHeaderCostService(fixture.database(), fixture.shipments(), () => fixture.at));
      server = createServer(app); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/purchasing/supplier-header-costs`; });
    afterAll(async () => { if (server) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); });
    it("previews and applies a combined supplier total plus header once, preserving bills, cash and counts", async () => {
      await setup(); const facts = await originalFacts(), before = (await query("SELECT * FROM inventory.inventory_lots ORDER BY id")).rows;
      const reviewed = await review(); expect(await originalFacts()).toEqual(facts);
      expect((await query("SELECT * FROM inventory.inventory_lots ORDER BY id")).rows).toEqual(before);
      const key = randomUUID(), result = await post("approve", reviewed.request, key);
      expect(result.status, JSON.stringify(result.body)).toBe(200); supplierHeaderResultSchema.parse(result.body);
      expect(await originalFacts()).toEqual(facts);
      expect(reviewed.preview.impact.orderCosts.some(row => row.totalMills.after !== row.totalMills.before)).toBe(true);
      const retained = (await query("SELECT * FROM procurement.supplier_header_cost_reviews")).rows;
      expect(retained).toHaveLength(1);
      expect((await context()).approvals).toHaveLength(1);
      expect(await post("approve", reviewed.request, key)).toEqual({ ...result, replayed: "true" });
      expect((await query("SELECT * FROM procurement.supplier_header_cost_reviews")).rows).toEqual(retained);
    });
    it("uses explicit tax treatment and signed manual shares without rewriting the supplier bill", async () => {
      await setup(); await query("INSERT INTO procurement.purchase_tax_types(id,code,name,treatment,revision,created_at,updated_at,updated_by) VALUES(1,'VAT','Supplier VAT','recoverable',1,$1,$1,$2)", [fixture.at, fixture.actorId]);
      const entries: SupplierHeaderEntry[] = [
        { key: "discount", label: "Supplier discount", category: "discount", amountMills: -10000, destination: "product", taxTypeId: null, method: "manual", shares: [{ lineId: 72, amountMills: -10000 }] },
        { key: "vat", label: "VAT", category: "tax", amountMills: 30000, destination: "tax", taxTypeId: 1, method: "by_value", shares: [] }];
      const reviewed = await review(entries), facts = await originalFacts();
      expect(reviewed.preview.after).toEqual(expect.arrayContaining([expect.objectContaining({ amountMills: 30000, taxTreatment: "recoverable" })]));
      expect((await post("approve", reviewed.request, randomUUID())).status).toBe(200); expect(await originalFacts()).toEqual(facts);
    });
    it("keeps a mixed goods/freight bill gross while excluding only its reviewed recoverable header tax from inventory", async () => {
      await setup();
      await query(`INSERT INTO procurement.purchase_tax_types(id,code,name,treatment,revision,created_at,updated_at,updated_by)
        VALUES(1,'VAT','Supplier VAT','recoverable',1,$1,$1,$2)`, [fixture.at, fixture.actorId]);
      await query(`UPDATE procurement.vendor_invoices SET invoiced_amount_cents=18200,balance_cents=18200 WHERE id=71;
        UPDATE procurement.inbound_freight_costs SET vendor_id=5,vendor_invoice_id=71 WHERE id=31;
        INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,freight_cost_id,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents)
        VALUES(73,71,2,31,1,5000,500000,5000)`);
      const entries: SupplierHeaderEntry[] = [{ key: "vat", label: "Freight VAT", category: "tax", destination: "tax", taxTypeId: 1,
        amountMills: 20000, method: "manual", shares: [{ lineId: 73, amountMills: 20000 }] }];
      const before = await originalFacts(), reviewed = await review(entries);
      expect((await post("approve", reviewed.request, randomUUID())).status).toBe(200);
      expect(await originalFacts()).toEqual(before);
      expect((await query("SELECT actual_cents::text AS amount FROM procurement.inbound_freight_costs WHERE id=31")).rows).toEqual([{ amount: "5200" }]);
      expect((await query("SELECT allocated_cents::text AS amount FROM procurement.inbound_freight_allocations WHERE shipment_cost_id=31")).rows).toEqual([{ amount: "5200" }]);
      expect((await query("SELECT freight_allocated_cents::text AS freight,recoverable_tax_allocated_cents::text AS recoverable FROM procurement.landed_cost_snapshots WHERE inbound_shipment_line_id=11")).rows).toEqual([{ freight: "5200", recoverable: "200" }]);
      const displayed = await readPoShipmentCosts(fixture.database(), 10);
      expect(displayed?.taxCosts).toMatchObject({ supplierInventoryCents: 13000, shipmentInventoryCents: 5000, recoverableShipmentTaxCents: 200, inventoryLandedCents: 18000 });
      // Repeating the same approved rule records no second charge increase.
      const next = await review(entries);
      expect((await post("approve", next.request, randomUUID())).status).toBe(200);
      expect((await query("SELECT actual_cents::text AS amount FROM procurement.inbound_freight_costs WHERE id=31")).rows).toEqual([{ amount: "5200" }]);
    });
    it("rejects stale financial data and revoked current administrator permission", async () => {
      await setup(); const first = await review();
      await query("UPDATE procurement.vendor_invoices SET balance_cents=balance_cents-1 WHERE id=71");
      expect(await post("approve", first.request, randomUUID())).toMatchObject({ status: 409, body: { code: "SUPPLIER_HEADER_STALE" } });
      await query("UPDATE procurement.vendor_invoices SET balance_cents=balance_cents+1 WHERE id=71");
      const next = await review(); await query("DELETE FROM identity.auth_user_roles WHERE user_id=$1", [fixture.actorId]);
      expect((await post("approve", next.request, randomUUID())).status).toBe(403);
      expect((await query("SELECT count(*)::int AS count FROM procurement.supplier_header_cost_reviews")).rows[0].count).toBe(0);
    });
    it.each(["inventory", "recoverable"] as const)("attributes a %s header tax refund to its original source, approves the exact cost change and reverses it", async treatment => {
      await setup(); await query("INSERT INTO procurement.purchase_tax_types(id,code,name,treatment,revision,created_at,updated_at,updated_by) VALUES(1,'VAT','Supplier VAT',$1,1,$2,$2,$3)", [treatment, fixture.at, fixture.actorId]);
      const loaded = await context(), entries = [{ ...loaded.proposed[0], key: "vat", label: "Supplier VAT", category: "tax" as const, destination: "tax" as const, taxTypeId: 1 }];
      const reviewed = await review(entries); expect((await post("approve", reviewed.request, randomUUID())).status).toBe(200);
      await query("INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES(3,'purchasing','edit','purchasing'); INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES(1,3)");
      const facts = await originalFacts(), source = await fixture.database().transaction(tx => loadSupplierCreditSource(tx, 71));
      const created = await creditCommand("create", { sourceInvoiceId: 71, expectedSourceVersion: source.version, supplierReference: randomUUID(), creditCalendarDate: "2026-09-06", reason: "Supplier refunded part of original VAT",
        lines: [{ invoiceLineId: 72, amountCents: 100, disposition: { kind: "tax_reduction", taxSourceKey: "supplier_header:vat:1", taxTypeId: 1 } }] });
      expect(created.httpStatus, JSON.stringify(created.body)).toBe(201);
      const id = (created.body as { credit: SupplierCreditDetail }).credit.id;
      const credit = await fixture.database().transaction(tx => readSupplierCreditDetail(tx, id, true)), reason = "Reviewed the exact original VAT refund and cost effect";
      const preview = await createSupplierCreditCostPreview(fixture.database(), () => fixture.at)(id, "approve", { expectedVersion: credit.version, reason }, fixture.actorId);
      const approved = await creditCommand("approve", { expectedVersion: credit.version, reason, previewVersion: preview.previewVersion }, id);
      expect(approved.httpStatus, JSON.stringify(approved.body)).toBe(200);
      expect((approved.body as { credit: SupplierCreditDetail }).credit.costStatus).toBe("posted");
      expect(await originalFacts()).toEqual(facts);
      expect(preview.impact.orderCosts.some(row => row.totalMills.after !== row.totalMills.before)).toBe(treatment === "inventory");
      const savedCredit = (await query("SELECT * FROM procurement.supplier_credit_lines WHERE supplier_credit_id=$1 ORDER BY id", [id])).rows;
      const taxes = createPurchaseTaxChangeService(fixture.database(), fixture.shipments(), () => fixture.at);
      const taxSource = await taxes.context({ kind: "tax_type", id: 1 }, fixture.actorId);
      if (taxSource.current?.kind !== "tax_type") throw new Error("Original configured tax type is missing");
      const change = { ...taxSource.current, treatment: treatment === "inventory" ? "recoverable" as const : "inventory" as const };
      const taxDraft = { sourceVersion: taxSource.sourceVersion, change };
      const taxPreview = await taxes.preview(taxDraft, fixture.actorId);
      const taxBody = { ...taxDraft, previewVersion: taxPreview.previewVersion, reason: "Reviewed the configured tax treatment and existing refund", approvalConfirmed: true };
      const scope = { method: "POST", ...purchaseTaxCommandScope({ kind: "tax_type", id: 1 }) };
      expect((await taxes.approve(taxBody, fixture.actorId, { ...scope, actorType: "user", actorId: fixture.actorId,
        contractVersion: 1, idempotencyKey: randomUUID(), requestHash: hashHttpFinancialCommand({ ...scope, body: taxBody }) })).httpStatus).toBe(200);
      expect((await query("SELECT * FROM procurement.supplier_credit_lines WHERE supplier_credit_id=$1 ORDER BY id", [id])).rows).toEqual(savedCredit);
      expect((await fixture.database().transaction(tx => readSupplierCreditDetail(tx, id, true))).costStatus).toBe("posted");
      const current = await fixture.database().transaction(tx => readSupplierCreditDetail(tx, id, true));
      const undo = await createSupplierCreditCostPreview(fixture.database(), () => fixture.at)(id, "void", { expectedVersion: current.version, reason }, fixture.actorId);
      expect((await creditCommand("void", { expectedVersion: current.version, reason, previewVersion: undo.previewVersion }, id)).httpStatus).toBe(200);
      expect(await originalFacts()).toEqual(facts);
      expect((await query("SELECT count(*)::int AS count FROM inventory.cost_reconciliation_postings")).rows[0].count).toBe(0);
    });
    it("rejects competing approvals of the same preview and retains one immutable economic effect", async () => {
      await setup(); const reviewed = await review();
      const results = await Promise.all([post("approve", reviewed.request, randomUUID()), post("approve", reviewed.request, randomUUID())]);
      expect(results.map(row => row.status).sort()).toEqual([200, 409]);
      expect((await query("SELECT count(*)::int AS count FROM procurement.supplier_header_cost_reviews")).rows[0].count).toBe(1);
    });
    it("enforces immutable header history and exact conservation below the application boundary", async () => {
      await setup(); const reviewed = await review();
      expect((await post("approve", reviewed.request, randomUUID())).status).toBe(200);
      const original = (await query("SELECT * FROM procurement.supplier_header_cost_reviews")).rows;
      await expect(query("UPDATE procurement.supplier_header_cost_reviews SET reason='Changed original approval'")).rejects.toMatchObject({ code: "23514" });
      await expect(query("DELETE FROM procurement.supplier_header_cost_reviews")).rejects.toMatchObject({ code: "23514" });
      await expect(query("TRUNCATE procurement.supplier_header_cost_reviews")).rejects.toMatchObject({ code: "23514" });
      await expect(query(`INSERT INTO procurement.supplier_header_cost_reviews
        (vendor_invoice_id,source_fingerprint,source_version,entries_json,before_json,after_json,purchase_order_ids,actor_id,actor_name,reason,approved_at,command_key,preview_version)
        SELECT vendor_invoice_id,source_fingerprint,source_version,entries_json,before_json,
          jsonb_set(after_json,'{0,amountMills}','20100'::jsonb),purchase_order_ids,actor_id,actor_name,reason,approved_at,'tampered-command',preview_version
        FROM procurement.supplier_header_cost_reviews`)).rejects.toMatchObject({ code: "23514" });
      expect((await query("SELECT * FROM procurement.supplier_header_cost_reviews")).rows).toEqual(original);
    });
    it("rolls classification and all cost effects back when audit insertion fails, then safely retries", async () => {
      await setup(); const reviewed = await review(), facts = await originalFacts(), key = randomUUID();
      await query(`CREATE FUNCTION public.fail_header_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='procurement.supplier_header_costs.approved' THEN RAISE EXCEPTION 'injected header audit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fail_header_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_header_audit()`);
      try { expect((await post("approve", reviewed.request, key)).status).toBe(503);
        expect(await originalFacts()).toEqual(facts); expect((await query("SELECT count(*)::int AS count FROM procurement.supplier_header_cost_reviews")).rows[0].count).toBe(0);
      } finally { await query("DROP TRIGGER fail_header_audit ON public.audit_events; DROP FUNCTION public.fail_header_audit()"); }
      await query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM next_attempt_at-clock_timestamp())) + 0.01) FROM public.financial_command_results WHERE idempotency_key=$1", [key]);
      expect((await post("approve", reviewed.request, key)).status).toBe(200);
    });
  });
}
