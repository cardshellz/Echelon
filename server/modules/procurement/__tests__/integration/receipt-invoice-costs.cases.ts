import type { ShipmentTrackingService } from "../../shipment-tracking.service";
import type { ReceivingLine } from "@shared/schema/procurement.schema";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import {
  receiptInvoiceContextSchema,
  receiptInvoicePreviewSchema,
  type ReceiptInvoiceAllocation,
} from "@shared/procurement/receipt-invoice-costs";
import { registerReceiptInvoiceCostRoutes } from "../../receipt-invoice-costs.routes";
import { createReceiptInvoiceCostService } from "../../receipt-invoice-costs.service";
import { receivingUnitVersion } from "../../receiving-unit-contract";
import { readPurchaseCostStatus } from "../../purchase-cost-status.repository";
import type { AmendmentDatabase } from "../../po-quantity-amendment.repository";
import type { ReceivingService } from "../../receiving.service";
import type { createPurchasingService } from "../../purchasing.service";
import { createSupplierCreditCommands } from "../../supplier-credit.commands";
import { createSupplierCreditCostPreview } from "../../supplier-credit.service";
import { loadSupplierCreditSource, readSupplierCreditDetail } from "../../supplier-credit.repository";
import { createDrizzleFinancialCommandRepository } from "../../../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import type { SupplierCreditCommand, SupplierCreditDetail } from "@shared/procurement/supplier-credit";
import { createInvoiceCostReviewPreviewService } from "../../invoice-cost-review-preview.service";
import { createInvoiceCostReviewCommands } from "../../invoice-cost-review.service";
import { invoiceCostReviewVersion } from "../../ap-ledger.service";

export function registerReceiptInvoiceCostCases(fixture: {
  shipments: () => ShipmentTrackingService;
  pool: () => pg.Pool;
  database: () => AmendmentDatabase;
  actorId: string;
  at: Date;
  receive: () => Promise<unknown>;
  consume: () => Promise<unknown>;
  transferFirstAndSell: () => Promise<void>;
  breakFirst: () => Promise<void>;
  receivingLines: (receiptId: number) => Promise<ReceivingLine[]>;
  receiving: () => ReceivingService;
  purchasing: () => ReturnType<typeof createPurchasingService>;
}) {
  const query = (text: string, values?: unknown[]) =>
    fixture.pool().query(text, values);
  let server: Server, endpoint: string;
  async function post(path: string, body: unknown, key?: string) {
    const response = await requestLocalHttp(`${endpoint}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json(),
      replayed: response.headers.get("Idempotency-Replayed"),
      retryAfter: response.headers.get("Retry-After"),
    };
  }
  async function context() {
    const response = await requestLocalHttp(`${endpoint}/21`);
    expect(response.status).toBe(200);
    return receiptInvoiceContextSchema.parse(await response.json());
  }
  async function secondReceipt() {
    const receipt = await fixture
      .purchasing()
      .createReceiptFromPO(10, fixture.actorId);
    await fixture.receiving().open(receipt.id, fixture.actorId);
    const [line] = await fixture.receivingLines(receipt.id);
    await fixture.receiving().updateLine(
      line.id,
      {
        receivedQty: line.expectedQty,
        putawayLocationId: 99,
        expectedUnitVersion: receivingUnitVersion(line),
      },
      fixture.actorId,
    );
    await fixture.receiving().close(receipt.id, fixture.actorId);
    return receipt;
  }
  async function setup(twoReceipts = true) {
    await fixture.receive();
    if (twoReceipts) await secondReceipt();
    await query(`UPDATE procurement.vendor_invoices SET status='approved',invoiced_amount_cents=13000,balance_cents=13000 WHERE id=71;
      UPDATE procurement.vendor_invoice_lines SET qty_invoiced=100,line_total_cents=13000,cost_component_evidence='{"contractVersion":1,"source":"operator_review","packagingTreatment":"separate","productMills":1200000,"packagingMills":100000,"adjustmentMills":0}' WHERE id=72;
      INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,status,invoiced_amount_cents,balance_cents,currency)
        VALUES(81,'SECOND-INVOICE',5,'approved',17000,17000,'USD');
      INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,purchase_order_line_id,qty_invoiced,unit_cost_cents,line_total_cents,cost_component_evidence)
        VALUES(82,81,1,21,100,150,17000,'{"contractVersion":1,"source":"operator_review","packagingTreatment":"separate","productMills":1500000,"packagingMills":200000,"adjustmentMills":0}')`);
    const loaded = await context();
    const rows = loaded.receipts.map((row, index) => ({
      receivingLineId: row.receivingLineId,
      invoiceLineId: index === 0 ? 72 : 82,
      receiptStartPiece: 0,
      invoiceStartPiece: 0,
      pieces: 100,
    }));
    return { loaded, rows };
  }
  async function review(rows: ReceiptInvoiceAllocation[]) {
    const loaded = await context(),
      draft = {
        sourceVersion: loaded.sourceVersion,
        change: { purchaseOrderLineId: 21, allocations: rows },
      };
    const result = await post("/preview", draft);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const preview = receiptInvoicePreviewSchema.parse(result.body);
    return {
      preview,
      body: {
        ...draft,
        previewVersion: preview.previewVersion,
        reason: "Checked batch receipt and supplier invoice references",
        approvalConfirmed: true,
      },
    };
  }
  async function state() {
    return Promise.all(
      [
        "procurement.receipt_invoice_cost_allocations",
        "procurement.purchase_order_lines",
        "inventory.inventory_lots",
        "oms.order_item_costs",
        "procurement.cost_source_revisions",
        "inventory.cost_applications",
        "inventory.cost_application_lots",
        "inventory.cost_reporting_events",
        "procurement.po_events",
      ].map(async (table) => ({
        table,
        rows: (
          await query(
            `SELECT to_jsonb(row) AS row FROM ${table} row ORDER BY to_jsonb(row)::text`,
          )
        ).rows,
      })),
    );
  }
  async function physical() {
    return Promise.all(
      [
        "procurement.receiving_lines",
        "procurement.po_receipts",
        "procurement.vendor_invoices",
        "procurement.vendor_invoice_lines",
        "procurement.ap_payments",
        "procurement.ap_payment_allocations",
      ].map(async (table) => ({
        table,
        rows: (
          await query(
            `SELECT to_jsonb(row) AS row FROM ${table} row ORDER BY to_jsonb(row)::text`,
          )
        ).rows,
      })),
    );
  }
  async function totals() {
    return (
      await query(
        "SELECT receiving_order_id,product_total_cost_mills::text AS product,packaging_total_cost_mills::text AS packaging,qty_received,qty_on_hand FROM inventory.inventory_lots ORDER BY id",
      )
    ).rows;
  }
  function creditCommand(command: SupplierCreditCommand, body: unknown, creditId?: number, options: { actor?: string; key?: string } = {}) {
    const routeTemplate = command === "create" ? "/api/supplier-credits" : `/api/supplier-credits/:id/${command}`;
    const scope = { method: "POST", routeTemplate, resourceKey: `supplier-credit:${creditId ?? "new"}:document` };
    return createSupplierCreditCommands(createDrizzleFinancialCommandRepository(fixture.database()), () => fixture.at).execute(command, body, {
      ...scope, actorType: "user", actorId: options.actor ?? fixture.actorId, commandName: `supplier_credit.${command}`,
      idempotencyKey: options.key ?? randomUUID(), contractVersion: 1,
      requestHash: hashHttpFinancialCommand({ ...scope, params: creditId === undefined ? {} : { id: String(creditId) }, query: {}, body }),
    }, creditId);
  }
  async function draftCredit(row: ReceiptInvoiceAllocation, amountCents = 1000) {
    await query("INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES(3,'purchasing','edit','purchasing') ON CONFLICT DO NOTHING; INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES(1,3) ON CONFLICT DO NOTHING");
    const source = await fixture.database().transaction(tx => loadSupplierCreditSource(tx, row.invoiceLineId === 72 ? 71 : 81));
    const { invoiceLineId, ...receiptAllocation } = row;
    return creditCommand("create", { sourceInvoiceId: source.invoice.id, expectedSourceVersion: source.version,
      supplierReference: randomUUID(), creditCalendarDate: "2026-09-06", reason: "Supplier credit for the first receipt only",
      lines: [{ invoiceLineId, amountCents, disposition: { kind: "price_reduction", component: "product", receiptAllocation } }] });
  }
  async function creditReview(id: number, action: "approve" | "void" | "reconcile_costs" = "approve", actor = fixture.actorId) {
    const credit = await fixture.database().transaction(tx => readSupplierCreditDetail(tx, id, true));
    const request = { expectedVersion: credit.version, reason: "Checked the exact supplier credit and billed receipt" };
    const preview = await createSupplierCreditCostPreview(fixture.database(), () => fixture.at)(id, action, request, actor);
    return { preview, body: { ...request, previewVersion: preview.previewVersion } };
  }
  describe("receipt-specific invoice costs through public approval and real receiving", () => {
    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { session: unknown }).session = {
          user: { id: fixture.actorId, role: "admin" },
        };
        next();
      });
      registerReceiptInvoiceCostRoutes(
        app,
        createReceiptInvoiceCostService(fixture.database(), () => fixture.at),
      );
      server = createServer(app);
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/purchasing/receipt-invoice-costs`;
    });
    afterAll(async () => {
      if (server)
        await new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done())),
        );
    });
    it("receipt credit previews actual costs, applies only to its billed receipt, retains approval and safely reverses", async () => {
      const { rows } = await setup(), { body } = await review(rows);
      expect((await post("", body, randomUUID())).status).toBe(200);
      const created = await draftCredit(rows[0]); expect(created.httpStatus, JSON.stringify(created.body)).toBe(201);
      const id = (created.body as { credit: SupplierCreditDetail }).credit.id, before = await state(), counts = await physical();
      const measured = await creditReview(id);
      expect(measured.preview.inventoryValues).toEqual([
        expect.objectContaining({ beforeMills: 1300000, afterMills: 1200000 }),
        expect.objectContaining({ beforeMills: 1700000, afterMills: 1700000 }),
      ]);
      expect(measured.preview.receipts).toEqual([expect.objectContaining({ beforeMills: 1300000, afterMills: 1200000, pieces: 100 }),
        expect.objectContaining({ beforeMills: 1700000, afterMills: 1700000, pieces: 100 })]);
      expect(await state()).toEqual(before);
      const key = randomUUID(), approved = await creditCommand("approve", measured.body, id, { key });
      expect(approved.httpStatus, JSON.stringify(approved.body)).toBe(200);
      expect((approved.body as { credit: SupplierCreditDetail }).credit).toMatchObject({ costStatus: "posted", costApprovals: [expect.objectContaining({ actorId: fixture.actorId, reason: measured.body.reason })] });
      expect(await totals()).toEqual([expect.objectContaining({ product: "1100000", packaging: "100000" }), expect.objectContaining({ product: "1500000", packaging: "200000" })]);
      expect(await physical()).toEqual(counts);
      const after = await state();
      expect(await creditCommand("approve", measured.body, id, { key })).toMatchObject({ httpStatus: 200, replayed: true, body: approved.body });
      expect(await state()).toEqual(after);
      const reversed = await creditReview(id, "void");
      const voided = await creditCommand("void", reversed.body, id);
      expect(voided.httpStatus, JSON.stringify(voided.body)).toBe(200);
      expect((voided.body as { credit: SupplierCreditDetail }).credit.costApprovals).toHaveLength(2);
      expect(await totals()).toEqual([expect.objectContaining({ product: "1200000", packaging: "100000" }), expect.objectContaining({ product: "1500000", packaging: "200000" })]);
      expect(await physical()).toEqual(counts);
    });
    it("receipt credit requires a current admin preview and does not post after permission revocation or a stale source", async () => {
      const { rows } = await setup(), { body } = await review(rows);
      expect((await post("", body, randomUUID())).status).toBe(200);
      const created = await draftCredit(rows[0]), id = (created.body as { credit: SupplierCreditDetail }).credit.id;
      const measured = await creditReview(id), before = await totals();
      expect(await creditCommand("approve", { expectedVersion: measured.body.expectedVersion, reason: measured.body.reason }, id)).toMatchObject({ httpStatus: 409 });
      await expect(creditReview(id, "approve", "lead-user")).rejects.toMatchObject({ code: "SUPPLIER_CREDIT_COST_ADMIN_REQUIRED" });
      await query("UPDATE procurement.purchase_order_lines SET packaging_cost_cents=packaging_cost_cents+1 WHERE id=21");
      expect(await creditCommand("approve", measured.body, id)).toMatchObject({ httpStatus: 409 });
      const fresh = await creditReview(id);
      await query("DELETE FROM identity.auth_role_permissions WHERE role_id=1 AND permission_id=1");
      expect(await creditCommand("approve", fresh.body, id)).toMatchObject({ httpStatus: 403 });
      expect(await totals()).toEqual(before);
      expect((await query("SELECT status FROM procurement.supplier_credits WHERE id=$1", [id])).rows[0].status).toBe("draft");
    });
    it("receipt credit follows a transferred receipt's stock and order cost basis without inventing an expense", async () => {
      const { rows } = await setup(), { body } = await review(rows);
      expect((await post("", body, randomUUID())).status).toBe(200);
      await fixture.transferFirstAndSell();
      const counts = (await query("SELECT id,qty_received,qty_on_hand,qty_picked,qty_packed FROM inventory.inventory_lots ORDER BY id")).rows;
      const otherReceipt = (await totals())[1], bills = await physical();
      const created = await draftCredit(rows[0]), id = (created.body as { credit: SupplierCreditDetail }).credit.id;
      const measured = await creditReview(id);
      expect(measured.preview.impact.orderCosts.some(row => row.totalMills.before !== row.totalMills.after)).toBe(true);
      const approved = await creditCommand("approve", measured.body, id);
      expect(approved.httpStatus, JSON.stringify(approved.body)).toBe(200);
      expect((approved.body as { credit: SupplierCreditDetail }).credit.costStatus).toBe("posted");
      expect((await query("SELECT id,qty_received,qty_on_hand,qty_picked,qty_packed FROM inventory.inventory_lots ORDER BY id")).rows).toEqual(counts);
      expect((await totals())[1]).toEqual(otherReceipt);
      expect(await physical()).toEqual(bills);
      expect((await query("SELECT count(*)::int AS count FROM inventory.cost_reconciliation_postings")).rows[0].count).toBe(0);
    });
    it("receipt credit rejects a wrong receipt and cumulative credit over its exact assigned value", async () => {
      const { rows } = await setup(), { body } = await review(rows);
      expect((await post("", body, randomUUID())).status).toBe(200);
      const wrong = await draftCredit({ ...rows[0], receivingLineId: rows[1].receivingLineId });
      expect(wrong).toMatchObject({ httpStatus: 409 });
      const created = await draftCredit(rows[0], 7000), id = (created.body as { credit: SupplierCreditDetail }).credit.id;
      const measured = await creditReview(id); expect((await creditCommand("approve", measured.body, id)).httpStatus).toBe(200);
      const second = await draftCredit(rows[0], 5500);
      expect(second).toMatchObject({ httpStatus: 409 });
    });
    it("receipt credit concurrent approvals post once; a failed immutable approval rolls back every cost", async () => {
      const { rows } = await setup(), { body } = await review(rows);
      expect((await post("", body, randomUUID())).status).toBe(200);
      const created = await draftCredit(rows[0]), id = (created.body as { credit: SupplierCreditDetail }).credit.id;
      const measured = await creditReview(id), before = await state(), key = randomUUID();
      await query(`CREATE FUNCTION procurement.receipt_credit_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.event_type='supplier_credit_costs_approved' THEN RAISE EXCEPTION 'Synthetic receipt credit approval failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER receipt_credit_fail BEFORE INSERT ON procurement.po_events FOR EACH ROW EXECUTE FUNCTION procurement.receipt_credit_fail()`);
      try { await expect(creditCommand("approve", measured.body, id, { key })).rejects.toThrow(); }
      finally { await query("DROP TRIGGER receipt_credit_fail ON procurement.po_events; DROP FUNCTION procurement.receipt_credit_fail()"); }
      expect(await state()).toEqual(before);
      await query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM next_attempt_at-clock_timestamp())) + 0.01) FROM public.financial_command_results WHERE idempotency_key=$1", [key]);
      const results = await Promise.all([creditCommand("approve", measured.body, id, { key }), creditCommand("approve", measured.body, id)]);
      expect(results.map(result => result.httpStatus).sort()).toEqual([200, 409]);
      expect((await query("SELECT count(*)::int AS count FROM procurement.po_events WHERE event_type='supplier_credit_costs_approved'")).rows[0].count).toBe(1);
      expect((await query("SELECT approved_by FROM procurement.supplier_credits WHERE id=$1", [id])).rows[0].approved_by).toBe(fixture.actorId);
    });
    it("billed adjustments use the reviewed invoice owner, conserve the gross bill and leave other receipts unchanged", async () => {
      const { rows } = await setup(), { body } = await review(rows);
      expect((await post("", body, randomUUID())).status).toBe(200);
      const invoice = (await query("SELECT * FROM procurement.vendor_invoice_lines WHERE id=72")).rows[0];
      const request = { expectedVersion: invoiceCostReviewVersion({ id: 72, qtyInvoiced: Number(invoice.qty_invoiced), unitCostCents: Number(invoice.unit_cost_cents),
        unitCostMills: invoice.unit_cost_mills === null ? null : Number(invoice.unit_cost_mills), lineTotalCents: Number(invoice.line_total_cents), costComponentEvidence: invoice.cost_component_evidence }),
        packagingTreatment: "separate" as const, productMills: 1300000, packagingMills: 100000, adjustmentMills: -100000,
        adjustments: [{ key: "discount", label: "Supplier goods discount", category: "discount" as const, amountMills: -200000, destination: "product" as const },
          { key: "outside", label: "Billed service outside inventory", category: "other" as const, amountMills: 100000, destination: "excluded" as const }], reason: "Checked supplier billed discount and excluded service" };
      const before = await state(), counts = await physical();
      const measured = await createInvoiceCostReviewPreviewService(fixture.database(), () => fixture.at)(72, request, fixture.actorId);
      expect(await state()).toEqual(before);
      expect(measured.preview.inventoryValues).toEqual([expect.objectContaining({ beforeMills: 1300000, afterMills: 1200000 }), expect.objectContaining({ beforeMills: 1700000, afterMills: 1700000 })]);
      const raw = { ...request, previewVersion: measured.preview.previewVersion }, scope = { method: "POST", routeTemplate: "/api/vendor-invoice-lines/:lineId/cost-components", resourceKey: "vendor_invoice_line:72" };
      const saved = await createInvoiceCostReviewCommands(createDrizzleFinancialCommandRepository(fixture.database()), () => fixture.at).review(72, raw, fixture.actorId,
        { ...scope, actorType: "user", actorId: fixture.actorId, idempotencyKey: randomUUID(), commandName: "ap.invoice.cost_components", contractVersion: 1, requestHash: hashHttpFinancialCommand({ ...scope, body: raw }) });
      expect(saved.httpStatus).toBe(200);
      expect(await totals()).toEqual([expect.objectContaining({ product: "1100000", packaging: "100000" }), expect.objectContaining({ product: "1500000", packaging: "200000" })]);
      const after = await physical();
      // Only the explicitly reviewed line composition changes; gross bills,
      // invoice quantities, cash, receipts and physical inventory are preserved.
      expect(after.slice(0, 3)).toEqual(counts.slice(0, 3));
      expect((await query("SELECT qty_invoiced,line_total_cents FROM procurement.vendor_invoice_lines WHERE id=72")).rows).toEqual([{ qty_invoiced: invoice.qty_invoiced, line_total_cents: invoice.line_total_cents }]);
      expect((await query("SELECT payload_json->'preview'->'after'->'adjustments' AS adjustments FROM procurement.po_events WHERE event_type='invoice_cost_components_approved'")).rows[0].adjustments).toEqual(request.adjustments);
    });
    it("previews without mutation, then posts each receipt's own invoice once", async () => {
      const { rows } = await setup(),
        before = await state(),
        quantities = await physical();
      const { preview, body } = await review(rows);
      expect(await state()).toEqual(before);
      expect(
        preview.after.map((row) => [
          row.supplierMills,
          row.confirmedPieces,
          row.provisionalPieces,
        ]),
      ).toEqual([
        [1300000, 100, 0],
        [1700000, 100, 0],
      ]);
      const key = randomUUID(),
        saved = await post("", body, key);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.replayed).toBe("false");
      expect(await totals()).toEqual([
        expect.objectContaining({ product: "1200000", packaging: "100000" }),
        expect.objectContaining({ product: "1500000", packaging: "200000" }),
      ]);
      expect(await physical()).toEqual(quantities);
      const posted = await state();
      const replay = await post("", body, key);
      expect(replay).toMatchObject({
        status: 200,
        replayed: "true",
        body: saved.body,
      });
      expect(await state()).toEqual(posted);
      const current = await fixture
        .database()
        .transaction((tx) => readPurchaseCostStatus(tx, [21]));
      expect(
        current.lines[0].components.every((row) => row.status === "applied"),
      ).toBe(true);
      expect((await context()).approvals).toEqual([
        expect.objectContaining({ reason: body.reason }),
      ]);
    });
    it.each(["receiptCostingEnabled", "receipt_costing_enabled"])(
      "rejects changing %s through an ordinary PO edit",
      async (field) => {
        await setup();
        const before = await state();
        await expect(
          fixture.purchasing().updateLine(21, { [field]: 0 }, fixture.actorId),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(await state()).toEqual(before);
      },
    );
    it("updates actual and provisional inventory flags separately after freight is posted", async () => {
      const { rows } = await setup(),
        { body } = await review([rows[0]]);
      expect((await post("", body, randomUUID())).status).toBe(200);
      await fixture.shipments().finalizeAllocations(1, fixture.actorId);
      await fixture.shipments().pushLandedCostsToLots(1, fixture.actorId);
      expect(
        (
          await query(
            "SELECT cost_provisional FROM inventory.inventory_lots ORDER BY id",
          )
        ).rows,
      ).toEqual([{ cost_provisional: 0 }, { cost_provisional: 1 }]);
      const final = await review(rows);
      expect((await post("", final.body, randomUUID())).status).toBe(200);
      expect(
        (
          await query(
            "SELECT cost_provisional FROM inventory.inventory_lots ORDER BY id",
          )
        ).rows,
      ).toEqual([{ cost_provisional: 0 }, { cost_provisional: 0 }]);
    });
    it("marks inventory provisional when a real invoice void invalidates saved receipt coverage without changing posted amounts", async () => {
      const { rows } = await setup(),
        reviewed = await review(rows);
      expect((await post("", reviewed.body, randomUUID())).status).toBe(200);
      await fixture.shipments().finalizeAllocations(1, fixture.actorId);
      await fixture.shipments().pushLandedCostsToLots(1, fixture.actorId);
      const before = (
        await query(
          "SELECT id,qty_on_hand,product_total_cost_mills,packaging_total_cost_mills,cost_provisional FROM inventory.inventory_lots ORDER BY id",
        )
      ).rows;
      expect(before.map((row) => row.cost_provisional)).toEqual([0, 0]);
      const approvals = (await context()).approvals;
      const { voidInvoice } = await import("../../ap-ledger.service");
      await voidInvoice(
        71,
        "Supplier withdrew this invoice; replace its original receipt coverage",
        fixture.actorId,
      );
      const after = (
        await query(
          "SELECT id,qty_on_hand,product_total_cost_mills,packaging_total_cost_mills,cost_provisional FROM inventory.inventory_lots ORDER BY id",
        )
      ).rows;
      expect(after.map(({ cost_provisional, ...row }) => row)).toEqual(
        before.map(({ cost_provisional, ...row }) => row),
      );
      expect(after.map((row) => row.cost_provisional)).toEqual([1, 1]);
      const current = await fixture
        .database()
        .transaction((tx) => readPurchaseCostStatus(tx, [21]));
      expect(
        current.lines[0].components.every(
          (row) => row.status === "review_required",
        ),
      ).toBe(true);
      expect((await context()).approvals).toEqual(approvals);
      const coverageReview = await review([rows[1]]);
      expect((await post("", coverageReview.body, randomUUID())).status).toBe(
        200,
      );
      expect(
        (
          await query(
            "SELECT cost_provisional FROM inventory.inventory_lots ORDER BY id",
          )
        ).rows,
      ).toEqual([{ cost_provisional: 1 }, { cost_provisional: 0 }]);
      expect((await context()).approvals[1]).toEqual(approvals[0]);
    });
    it("keeps a second received batch provisional until its own invoice is assigned", async () => {
      const { rows } = await setup();
      const first = await review([rows[0]]);
      expect((await post("", first.body, randomUUID())).status).toBe(200);
      expect(await totals()).toEqual([
        expect.objectContaining({ product: "1200000", packaging: "100000" }),
        expect.objectContaining({ product: "1000000", packaging: "100000" }),
      ]);
      expect(
        (await context()).costs.map((row) => row.provisionalPieces),
      ).toEqual([0, 100]);
      const before = (await totals())[0],
        second = await review(rows);
      expect((await post("", second.body, randomUUID())).status).toBe(200);
      expect((await totals())[0]).toEqual(before);
      expect((await totals())[1]).toMatchObject({
        product: "1500000",
        packaging: "200000",
      });
    });
    it("keeps receipt assignments and the provisional PO quote through real AP invoice approvals", async () => {
      const { rows } = await setup();
      await query(
        "UPDATE procurement.vendor_invoices SET status='received' WHERE id IN (71,81)",
      );
      const quote = (
        await query(
          "SELECT order_qty,total_product_cost_cents,packaging_cost_cents FROM procurement.purchase_order_lines WHERE id=21",
        )
      ).rows;
      const { approveInvoice } = await import("../../ap-ledger.service");
      await approveInvoice(71, fixture.actorId);
      const first = await review([rows[0]]);
      expect((await post("", first.body, randomUUID())).status).toBe(200);
      const assigned = (await totals())[0],
        approvals = (await context()).approvals;
      await approveInvoice(81, fixture.actorId);
      expect((await totals())[0]).toEqual(assigned);
      expect((await totals())[1]).toMatchObject({
        product: "1000000",
        packaging: "100000",
      });
      expect((await context()).approvals).toEqual(approvals);
      expect(
        (
          await query(
            "SELECT order_qty,total_product_cost_cents,packaging_cost_cents FROM procurement.purchase_order_lines WHERE id=21",
          )
        ).rows,
      ).toEqual(quote);
    });
    it("receives a later batch at provisional PO cost without borrowing the first invoice price", async () => {
      const { rows } = await setup(false),
        first = await review(rows);
      expect((await post("", first.body, randomUUID())).status).toBe(200);
      const approved = (await context()).approvals;
      await secondReceipt();
      expect(await totals()).toEqual([
        expect.objectContaining({ product: "1200000", packaging: "100000" }),
        expect.objectContaining({ product: "1000000", packaging: "100000" }),
      ]);
      expect((await context()).approvals).toEqual(approved);
    });
    it("keeps the uncovered part of a single receipt provisional", async () => {
      const { rows } = await setup(),
        reviewed = await review([{ ...rows[0], pieces: 50 }]);
      expect(reviewed.preview.after[0]).toMatchObject({
        supplierMills: 1200000,
        confirmedPieces: 50,
        provisionalPieces: 50,
      });
      expect((await post("", reviewed.body, randomUUID())).status).toBe(200);
      expect((await totals())[0]).toMatchObject({
        product: "1100000",
        packaging: "100000",
      });
    });
    it.each([
      "receipt overlap",
      "invoice overlap",
      "excess quantity",
      "wrong receipt",
      "wrong invoice",
    ])("rejects %s without financial changes", async (kind) => {
      const { rows } = await setup(),
        loaded = await context(),
        before = await state();
      let invalid: ReceiptInvoiceAllocation[];
      if (kind === "receipt overlap")
        invalid = [
          rows[0],
          { ...rows[0], invoiceLineId: 82, receiptStartPiece: 50, pieces: 50 },
        ];
      else if (kind === "invoice overlap")
        invalid = [rows[0], { ...rows[1], invoiceLineId: 72 }];
      else
        invalid = [
          {
            ...rows[0],
            ...(kind === "excess quantity"
              ? { pieces: 101 }
              : kind === "wrong receipt"
                ? { receivingLineId: 999 }
                : { invoiceLineId: 999 }),
          },
        ];
      expect(
        (
          await post("/preview", {
            sourceVersion: loaded.sourceVersion,
            change: { purchaseOrderLineId: 21, allocations: invalid },
          })
        ).status,
      ).toBe(409);
      expect(await state()).toEqual(before);
    });
    it.each(["invoice", "stock", "role"])(
      "rejects a stale %s review and does not reuse approval",
      async (changed) => {
        const { rows } = await setup(),
          { body } = await review(rows);
        if (changed === "invoice")
          await query(
            "UPDATE procurement.vendor_invoice_lines SET line_total_cents=line_total_cents+1 WHERE id=72",
          );
        if (changed === "stock")
          await query(
            "UPDATE inventory.inventory_lots SET qty_on_hand=qty_on_hand-1 WHERE id=(SELECT min(id) FROM inventory.inventory_lots)",
          );
        if (changed === "role")
          await query("DELETE FROM identity.auth_user_roles WHERE user_id=$1", [
            fixture.actorId,
          ]);
        const before = await state(),
          result = await post("", body, randomUUID());
        expect(result.status).toBe(changed === "role" ? 403 : 409);
        expect(await state()).toEqual(before);
      },
    );
    it("rolls back mappings, source revisions and inventory if immutable approval audit fails", async () => {
      const { rows } = await setup(),
        { body } = await review(rows),
        before = await state();
      await query(`CREATE FUNCTION public.reject_receipt_invoice_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='procurement.receipt_invoice_costs.approved' THEN RAISE EXCEPTION 'injected receipt approval failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_receipt_invoice_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_receipt_invoice_audit()`);
      try {
        expect((await post("", body, randomUUID())).status).toBe(500);
        expect(await state()).toEqual(before);
      } finally {
        await query(
          "DROP TRIGGER reject_receipt_invoice_audit ON public.audit_events; DROP FUNCTION public.reject_receipt_invoice_audit()",
        );
      }
    });
    it("serializes competing approvals and never posts two assignment versions", async () => {
      const { rows } = await setup(),
        { body } = await review(rows);
      const results = await Promise.all([
        post("", body, randomUUID()),
        post("", body, randomUUID()),
      ]);
      expect(results.map((row) => row.status).sort()).toEqual([200, 409]);
      expect(
        (
          await query(
            "SELECT count(*)::int AS count FROM public.audit_events WHERE action='procurement.receipt_invoice_costs.approved' AND actor=$1",
            [fixture.actorId],
          )
        ).rows[0].count,
      ).toBe(1);
      expect((await context()).allocations).toHaveLength(2);
    });
    it("follows a receipt's own price through an actual transfer and linked order cost", async () => {
      const { rows } = await setup();
      await fixture.transferFirstAndSell();
      const quantities = (
        await query(
          "SELECT id,qty_on_hand,qty_picked FROM inventory.inventory_lots ORDER BY id",
        )
      ).rows;
      const reviewed = await review(rows);
      expect(
        reviewed.preview.impact.orderCosts.some(
          (row) => row.totalMills.before !== row.totalMills.after,
        ),
      ).toBe(true);
      expect((await post("", reviewed.body, randomUUID())).status).toBe(200);
      expect(
        (
          await query(
            "SELECT total_cost_mills::text AS total FROM oms.order_item_costs ORDER BY id",
          )
        ).rows,
      ).toEqual([{ total: "650000" }]);
      expect(
        (
          await query(
            "SELECT id,qty_on_hand,qty_picked FROM inventory.inventory_lots ORDER BY id",
          )
        ).rows,
      ).toEqual(quantities);
      expect(
        (
          await query(
            "SELECT count(*)::int AS count FROM inventory.cost_reconciliation_postings",
          )
        ).rows[0].count,
      ).toBe(0);
    });
    it("follows a receipt's own price through the package conversion owner without an expense", async () => {
      const { rows } = await setup();
      await fixture.breakFirst();
      const quantities = (
        await query(
          "SELECT id,qty_received,qty_on_hand FROM inventory.inventory_lots ORDER BY id",
        )
      ).rows;
      const reviewed = await review(rows);
      expect((await post("", reviewed.body, randomUUID())).status).toBe(200);
      const converted = (
        await query(
          "SELECT qty_received,product_total_cost_mills::text AS product,packaging_total_cost_mills::text AS packaging FROM inventory.inventory_lots WHERE product_variant_id=201 ORDER BY id",
        )
      ).rows;
      expect(converted).toEqual([
        expect.objectContaining({
          qty_received: 50,
          product: "600000",
          packaging: "50000",
        }),
      ]);
      expect(
        (
          await query(
            "SELECT id,qty_received,qty_on_hand FROM inventory.inventory_lots ORDER BY id",
          )
        ).rows,
      ).toEqual(quantities);
      expect(
        (
          await query(
            "SELECT count(*)::int AS count FROM inventory.cost_reconciliation_postings",
          )
        ).rows[0].count,
      ).toBe(0);
    });
    it("shows order cost changes from the existing owner without changing physical stock", async () => {
      const { rows } = await setup();
      await fixture.consume();
      const physicalBefore = await physical(),
        { preview, body } = await review(rows);
      expect(
        preview.impact.orderCosts.some(
          (row) => row.totalMills.before !== row.totalMills.after,
        ),
      ).toBe(true);
      expect((await post("", body, randomUUID())).status).toBe(200);
      expect(await physical()).toEqual(physicalBefore);
      expect(
        (
          await query(
            "SELECT count(*)::int AS count FROM inventory.cost_reconciliation_postings",
          )
        ).rows[0].count,
      ).toBe(0);
    });
  });
}
