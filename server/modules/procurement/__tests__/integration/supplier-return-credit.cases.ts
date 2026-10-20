import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CostReportingRepository } from "../../cost-reporting.repository";
import { expect, it } from "vitest";
import type { SupplierReturnStockFixture } from "./supplier-return-stock.cases";
import type { SourceLineInput } from "@shared/procurement/supplier-credit";
import { previewSupplierReturnStock } from "../../../inventory/application/supplier-return-stock";
import { createSupplierReturnReader, recordSupplierReturn } from "../../supplier-return.service";
import { loadSupplierCreditSource, readSupplierCreditDetail, readSupplierCreditOptions } from "../../supplier-credit.repository";
import { executeSupplierCreditCommand } from "../../supplier-credit.service";
import { readSupplierReturnEntitlementReview } from "../../supplier-return-credit-review.service";
import { recordSupplierReturnDifferenceReview } from "../../supplier-return-difference.service";
export function registerSupplierReturnCreditCases(fixture: SupplierReturnStockFixture) {
    const query = (text: string, values: unknown[] = []) => fixture.pool().query(text, values);
    const context = { actorId: fixture.actorId, at: fixture.at };
    const cents = (mills: number) => { expect(BigInt(mills) % BigInt(100)).toBe(BigInt(0)); return Number(BigInt(mills) / BigInt(100)); };
    async function prepare() {
        await query("INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES(501,'purchasing','edit','purchasing'); INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES(1,501,NULL)");
        await fixture.receive();
        await fixture.approveInvoice();
        const inventoryLotId = Number((await query("SELECT id FROM inventory.inventory_lots ORDER BY id LIMIT 1")).rows[0].id);
        const preview = await fixture.database().transaction(tx => previewSupplierReturnStock(tx, { vendorId: 5, lines: [{ inventoryLotId, quantity: 1 }] }));
        const document = await fixture.database().transaction(tx => recordSupplierReturn(tx, { ...context, commandKey: randomUUID(), requestFingerprint: "d".repeat(64),
            raw: { vendorId: 5, lines: [{ inventoryLotId, quantity: 1 }], expectedSourceFingerprint: preview.sourceFingerprint,
                returnCalendarDate: "2026-09-06", evidenceReference: "RETURN-COLLECTION-1", reason: "Supplier physically collected accepted stock" } }));
        return { document, line: document.lines[0] };
    }
    async function draft(lines: SourceLineInput[], supplierReference = randomUUID(), replacesCreditId?: number, sourceInvoiceId = 71) {
        return fixture.database().transaction(async (tx) => {
            const source = await loadSupplierCreditSource(tx, sourceInvoiceId);
            return executeSupplierCreditCommand(tx, { ...context, command: "create", raw: { sourceInvoiceId, expectedSourceVersion: source.version,
                    supplierReference, ...(replacesCreditId ? { replacesCreditId } : {}), creditCalendarDate: "2026-09-06", reason: "Supplier issued credit for collected goods", lines } });
        });
    }
    async function change(creditId: number, command: "approve" | "void") {
        return fixture.database().transaction(async (tx) => {
            const current = await readSupplierCreditDetail(tx, creditId, true);
            return executeSupplierCreditCommand(tx, { ...context, command, creditId,
                raw: { expectedVersion: current.version, reason: "Reviewed original supplier document and physical collection" } });
        });
    }
    function creditLine(returnLineId: number, amountCents: number, component: "product" | "packaging" | "landed" | "unassigned", entitlementId?: number, invoiceLineId = 72): SourceLineInput {
        return { invoiceLineId, amountCents, disposition: { kind: "accepted_stock_return", supplierReturnLineId: returnLineId, quantity: 1,
                evidenceReference: "RETURN-COLLECTION-1", component, ...(entitlementId ? { entitlementId } : {}) } };
    }
    async function physical() {
        return (await query(`SELECT
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM inventory.inventory_lots row) AS lots,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM inventory.inventory_levels row) AS levels,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM procurement.receiving_lines row) AS receipt,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM procurement.purchase_order_lines row) AS po,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM inventory.supplier_return_allocations row) AS returned,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM inventory.supplier_return_cost_entries row) AS value,
      (SELECT count(*)::int FROM procurement.cost_source_revisions) AS revisions,
      (SELECT count(*)::int FROM inventory.inventory_transactions) AS movements`)).rows[0];
    }
    async function entitlement(returnLineId: number) {
        return Number((await query("SELECT id FROM procurement.supplier_return_credit_entitlements WHERE supplier_return_line_id=$1 ORDER BY id", [returnLineId])).rows[0].id);
    }
    async function review(id: number, patch: Record<string, unknown> = {}) {
        return fixture.database().transaction(async (tx) => {
            const current = await readSupplierReturnEntitlementReview(tx, id);
            return recordSupplierReturnDifferenceReview(tx, { ...context, entitlementId: id, commandKey: randomUUID(), raw: {
                    expectedVersion: current.version, reason: "Reviewed supplier correspondence and component values", evidenceReference: "SUPPLIER-EMAIL-1",
                    disposition: "awaiting_supplier_note", assignments: [], ...patch,
                } });
        });
    }
    it("accepted-return short credit and top-up share one physical entitlement and never reprice retained stock", async () => {
        const { document, line } = await prepare();
        const before = await physical();
        const productCents = cents(line.currentCosts.productMills);
        expect(Number.isInteger(productCents)).toBe(true);
        const short = await draft([creditLine(line.id, productCents - 100, "product")]);
        expect((await change(short.creditId, "approve")).credit.costStatus).toBe("review_required");
        const id = await entitlement(line.id);
        const topup = await draft([creditLine(line.id, 100, "product", id)]);
        expect((await change(topup.creditId, "approve")).credit.costStatus).toBe("posted");
        expect((await query("SELECT count(*)::int AS count FROM procurement.supplier_return_credit_entitlements")).rows[0].count).toBe(1);
        expect(await physical()).toEqual(before);
        const detail = await createSupplierReturnReader(fixture.database()).detail(document.id, fixture.actorId);
        expect(detail?.lines[0].creditLinks).toHaveLength(2);
        expect(detail?.lines[0].sourceInvoices).toContainEqual(expect.objectContaining({ sourceInvoiceId: 71, invoiceLineId: 72 }));
        expect((await fixture.database().transaction(tx => readSupplierCreditDetail(tx, short.creditId, true))).costStatus).toBe("posted");
    });
    it("accepted-return product and packaging lines on one note share the reviewed returned quantity", async () => {
        const { line } = await prepare();
        const created = await draft([creditLine(line.id, cents(line.currentCosts.productMills), "product"), creditLine(line.id, cents(line.currentCosts.packagingMills), "packaging")]);
        expect((await change(created.creditId, "approve")).credit.costStatus).toBe("posted");
        expect((await query("SELECT quantity FROM procurement.supplier_return_credit_entitlements")).rows).toEqual([{ quantity: 1 }]);
        expect((await query("SELECT count(DISTINCT entitlement_id)::int AS count FROM procurement.supplier_return_credit_links")).rows[0].count).toBe(1);
    });
    it("accepted-return combined credit attribution retains money, exposes late freight and invalidates the prior review", async () => {
        const { document, line } = await prepare();
        const amount = cents(line.currentCosts.productMills + line.currentCosts.packagingMills);
        const created = await draft([creditLine(line.id, amount, "unassigned")]);
        await change(created.creditId, "approve");
        const id = await entitlement(line.id), before = await physical();
        const linkId = Number((await query("SELECT id FROM procurement.supplier_return_credit_links ORDER BY id")).rows[0].id);
        const saved = await review(id, { disposition: "attribution_only", assignments: [{ creditLinkId: linkId,
                    productCents: cents(line.currentCosts.productMills), packagingCents: cents(line.currentCosts.packagingMills), landedCents: 0 }] });
        expect(saved.reviewCurrent).toBe(true);
        expect(saved.differences.totalMills).toBe(0);
        expect((await createSupplierReturnReader(fixture.database()).detail(document.id, fixture.actorId))?.lines[0].creditState).toBe("matched");
        expect(await physical()).toEqual(before);
        await fixture.updateFreight();
        const changed = await fixture.database().transaction(tx => readSupplierReturnEntitlementReview(tx, id));
        expect(changed.reviewCurrent).toBe(false);
        expect(changed.differences.landedMills).toBeGreaterThan(0);
        expect(changed.latestReview).toEqual(saved.latestReview);
        expect((await createSupplierReturnReader(fixture.database()).detail(document.id, fixture.actorId))?.lines[0].creditIssues)
            .toContainEqual(expect.objectContaining({ code: "RETURN_CREDIT_REVIEW_STALE" }));
        const declined = await review(id, { disposition: "supplier_declined", assignments: saved.latestReview!.assignments });
        expect(declined.reviewCurrent).toBe(true);
        expect(declined.differences.totalMills).toBeGreaterThan(0);
        expect(declined.reviewHistory).toHaveLength(2);
        expect((await query("SELECT count(*)::int AS count FROM procurement.supplier_return_credit_links")).rows[0].count).toBe(1);
    });
    it("accepted-return void preserves entitlement and explicit replacement reuses it without another stock removal", async () => {
        const { line } = await prepare();
        const reference = randomUUID();
        const original = await draft([creditLine(line.id, cents(line.currentCosts.productMills), "product")], reference);
        await change(original.creditId, "approve");
        const id = await entitlement(line.id), before = await physical();
        await change(original.creditId, "void");
        const replacement = await draft([creditLine(line.id, cents(line.currentCosts.productMills), "product", id)], reference, original.creditId);
        await change(replacement.creditId, "approve");
        expect((await query("SELECT quantity FROM procurement.supplier_return_credit_entitlements")).rows).toEqual([{ quantity: 1 }]);
        expect((await query("SELECT count(*)::int AS count FROM procurement.supplier_return_credit_links")).rows[0].count).toBe(2);
        expect(await physical()).toEqual(before);
    });
    it("accepted-return competing independent drafts cannot silently join the same physical slice", async () => {
        const { line } = await prepare();
        const first = await draft([creditLine(line.id, 100, "product")]);
        const second = await draft([creditLine(line.id, 100, "packaging")]);
        const results = await Promise.allSettled([change(first.creditId, "approve"), change(second.creditId, "approve")]);
        expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
        const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
        expect(rejected.reason).toMatchObject({ code: "RETURN_CREDIT_QUANTITY_EXCEEDED" });
        expect((await query("SELECT count(*)::int AS count FROM procurement.supplier_return_credit_entitlements")).rows[0].count).toBe(1);
    });
    it("accepted-return credit rejects unsupported freight and wrong collection evidence without creating a draft", async () => {
        const { line } = await prepare();
        await expect(draft([creditLine(line.id, 100, "landed")])).rejects.toMatchObject({ code: "RETURN_CREDIT_SOURCE_MISMATCH" });
        const wrong = creditLine(line.id, 100, "product");
        if (wrong.disposition.kind !== "accepted_stock_return")
            throw new Error("Wrong fixture disposition");
        wrong.disposition.evidenceReference = "another supplier collection";
        await expect(draft([wrong])).rejects.toMatchObject({ code: "RETURN_CREDIT_SOURCE_MISMATCH" });
        expect((await query("SELECT count(*)::int AS count FROM procurement.supplier_credits")).rows[0].count).toBe(0);
    });
    it("accepted-return late value adjustments reach delivery with the exact immutable entries and separate sold COGS", async () => {
        const { line } = await prepare();
        await fixture.updateFreight();
        const source = (await query(`SELECT event.application_id,event.payload FROM inventory.cost_reporting_events event
          WHERE jsonb_array_length(COALESCE(event.payload->'supplierReturnAdjustments','[]'::jsonb))>0 ORDER BY event.id DESC LIMIT 1`)).rows[0];
        expect(source).toBeDefined();
        expect(source.payload.supplierReturnAdjustments).toContainEqual(expect.objectContaining({ returnLineId: line.id, component: "landed" }));
        expect(source.payload.cogsDeltaCents).toBe(0);
        const reportingTables = ["cost_reporting_destinations", "cost_report_deliveries", "cost_report_delivery_audit", "cost_report_retry_intents"];
        for (const table of reportingTables) {
            expect((await query("SELECT to_regclass($1) AS relation", [`procurement.${table}`])).rows[0].relation).toBeNull();
        }
        await query(readFileSync(resolve(process.cwd(), "migrations/230_procurement_cost_reporting_delivery.sql"), "utf8"));
        try {
            const destination = { id: randomUUID(), sourceSystemId: "synthetic-return-acceptance",
                endpoint: "https://reports.example.com/api/integrations/procurement-cost-reports", enabled: true };
            const reporting = new CostReportingRepository(fixture.pool());
            await reporting.enqueue(destination, fixture.at, randomUUID);
            const delivery = (await query("SELECT state,envelope,last_error_code FROM procurement.cost_report_deliveries WHERE application_id=$1", [source.application_id])).rows[0];
            expect(delivery).toMatchObject({ state: "queued", last_error_code: null });
            expect(delivery.envelope.payload.supplierReturnAdjustments).toEqual(source.payload.supplierReturnAdjustments);
            expect(delivery.envelope.payload.cogsDeltaCents).toBe(0);
            expect(await reporting.enqueue(destination, fixture.at, randomUUID)).toBe(0);
        } finally {
            // This fixture exclusively created these four tables above; dropping
            // them restores its schema before the ordinary immutable-data reset.
            await query("DROP TABLE procurement.cost_report_retry_intents,procurement.cost_report_delivery_audit,procurement.cost_report_deliveries,procurement.cost_reporting_destinations");
        }
    });
    it("accepted-return partial invoices retain explicit source choices without guessing which invoice funded a lot", async () => {
        const { document, line } = await prepare();
        // Invoice quantity is base pieces. These three approved partial invoices
        // conserve the original 200 pieces and component totals. They do not
        // establish a separate lot-funding relationship that the schema lacks.
        await query(`UPDATE procurement.vendor_invoices SET invoiced_amount_cents=13000,balance_cents=13000 WHERE id=71;
          UPDATE procurement.vendor_invoice_lines SET qty_invoiced=100,line_total_cents=13000,
            cost_component_evidence='{"contractVersion":1,"packagingTreatment":"separate","productMills":1200000,"packagingMills":100000,"adjustmentMills":0,"source":"operator_review"}'::jsonb WHERE id=72;
          INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,status,invoiced_amount_cents,balance_cents)
            VALUES(73,'PARTIAL-INVOICE-A',5,'approved',6500,6500),(75,'PARTIAL-INVOICE-B',5,'approved',6500,6500);
          INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,purchase_order_line_id,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents,cost_component_evidence)
            VALUES(74,73,1,21,50,120,12000,6500,'{"contractVersion":1,"packagingTreatment":"separate","productMills":600000,"packagingMills":50000,"adjustmentMills":0,"source":"operator_review"}'::jsonb),
              (76,75,1,21,50,120,12000,6500,'{"contractVersion":1,"packagingTreatment":"separate","productMills":600000,"packagingMills":50000,"adjustmentMills":0,"source":"operator_review"}'::jsonb)`);
        const before = await physical();
        const detail = await createSupplierReturnReader(fixture.database()).detail(document.id, fixture.actorId);
        expect(detail?.lines[0].sourceInvoices?.map(row => row.sourceInvoiceId)).toEqual([71,73,75]);
        const selected = await draft([creditLine(line.id, cents(line.currentCosts.productMills), "product", undefined, 74)], randomUUID(), undefined, 73);
        const approved = await change(selected.creditId, "approve");
        expect(approved.credit.sourceInvoiceId).toBe(73);
        expect(approved.credit.lines[0].invoiceLineId).toBe(74);
        expect((await query("SELECT line.invoice_line_id FROM procurement.supplier_return_credit_links link JOIN procurement.supplier_credit_lines line ON line.id=link.supplier_credit_line_id")).rows).toEqual([{ invoice_line_id: 74 }]);
        expect(await physical()).toEqual(before);
    });
    it("accepted-return source quantity uses frozen base pieces and refuses a smaller partial invoice", async () => {
        const { line } = await prepare();
        await query(`INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,status,invoiced_amount_cents,balance_cents)
            VALUES(73,'SMALL-PARTIAL-INVOICE',5,'approved',6370,6370);
          INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,purchase_order_line_id,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents,cost_component_evidence)
            VALUES(74,73,1,21,49,120,12000,6370,'{"contractVersion":1,"packagingTreatment":"separate","productMills":588000,"packagingMills":49000,"adjustmentMills":0,"source":"operator_review"}'::jsonb)`);
        const before = await physical();
        expect(line.source.unitsPerVariant).toBe(50);
        const options = await fixture.database().transaction(tx => readSupplierCreditOptions(tx, 73, fixture.actorId, true, fixture.at));
        expect(options.lines[0].acceptedReturns).toContainEqual(expect.objectContaining({ supplierReturnLineId: line.id, quantityAvailable: 0, entitlements: [] }));
        await expect(draft([creditLine(line.id, 100, "product", undefined, 74)], randomUUID(), undefined, 73))
            .rejects.toMatchObject({ code: "RETURN_CREDIT_INVOICE_QUANTITY" });
        expect((await query("SELECT count(*)::int AS count FROM procurement.supplier_credits")).rows[0].count).toBe(0);
        expect(await physical()).toEqual(before);
    });
    it("accepted-return credit refuses a different supplier invoice even when its row names the same PO line", async () => {
        const { line } = await prepare();
        await query(`INSERT INTO procurement.vendors(id,code,name) VALUES(6,'OTHER-SUPPLIER','Different supplier');
          INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,status,invoiced_amount_cents,balance_cents)
            VALUES(73,'OTHER-SUPPLIER-INVOICE',6,'approved',6500,6500);
          INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,purchase_order_line_id,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents,cost_component_evidence)
            VALUES(74,73,1,21,50,120,12000,6500,'{"contractVersion":1,"packagingTreatment":"separate","productMills":600000,"packagingMills":50000,"adjustmentMills":0,"source":"operator_review"}'::jsonb)`);
        const before = await physical();
        await expect(draft([creditLine(line.id, 100, "product", undefined, 74)], randomUUID(), undefined, 73))
            .rejects.toMatchObject({ code: "RETURN_CREDIT_SOURCE_MISMATCH" });
        expect((await query("SELECT count(*)::int AS count FROM procurement.supplier_credits")).rows[0].count).toBe(0);
        expect(await physical()).toEqual(before);
    });
    it("accepted-return difference audit failure rolls back the new review and preserves all stock and credit evidence", async () => {
        const { line } = await prepare();
        const created = await draft([creditLine(line.id, 100, "product")]);
        await change(created.creditId, "approve");
        const id = await entitlement(line.id), before = await physical();
        await query(`CREATE FUNCTION public.fail_supplier_return_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='procurement.supplier_return.review_credit_difference' THEN RAISE EXCEPTION 'return review audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_supplier_return_review_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_supplier_return_review_audit()`);
        try {
            await expect(review(id)).rejects.toThrow("return review audit unavailable");
        }
        finally {
            await query("DROP TRIGGER fail_supplier_return_review_audit ON public.audit_events; DROP FUNCTION public.fail_supplier_return_review_audit()");
        }
        expect((await query("SELECT count(*)::int AS count FROM procurement.supplier_return_credit_reviews")).rows[0].count).toBe(0);
        expect(await physical()).toEqual(before);
        expect((await review(id)).reviewCurrent).toBe(true);
    });
}
