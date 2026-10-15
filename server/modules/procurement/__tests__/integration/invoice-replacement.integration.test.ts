import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vendorInvoiceAttachments } from "@shared/schema";
import { createDrizzleFinancialCommandRepository } from "../../../../platform/commands/command-results.repository";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import { createApInvoiceReplacementCommands } from "../../ap-invoice-replacement.commands";
import { readInvoiceReplacementDetail } from "../../ap-invoice-replacement.service";
import { recordShipmentCostRevisions } from "../../shipment-cost-application.service";
import { readPoShipmentCosts } from "../../po-shipment-cost-summary.repository";
import { fixtureTable } from "./shipment-line-fixture";
import { createFlowCostHarness, seedFlowMasterData, FLOW_ACTOR, FLOW_AT, type FlowCostHarness } from "./procurement-flow-cost.fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const integration = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const NUMBER = "SAME-SUPPLIER-NUMBER";

integration.sequential("voided shipment invoice replacement through real PostgreSQL owners", () => {
  let harness: FlowCostHarness;
  let originalId: number;

  beforeEach(async () => {
    harness = await createFlowCostHarness(url!);
    await harness.pool.query(fixtureTable(vendorInvoiceAttachments));
    await harness.pool.query(readFileSync(resolve(process.cwd(), "migrations/900000006000017980001_invoice_replacement_lineage.sql"), "utf8"));
    await seedFlowMasterData(harness);
    await harness.pool.query(`
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,physical_status,warehouse_id,currency,total_cents)
        VALUES(10,'REPLACEMENT-PO',5,'sent','sent',1,'USD',10000);
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,product_variant_id,
        expected_receive_variant_id,expected_receive_units_per_variant,sku,product_name,order_qty,
        unit_cost_cents,unit_cost_mills,total_product_cost_cents,packaging_cost_cents,line_total_cents,status)
        VALUES(21,10,1,100,200,200,100,'REPLACEMENT-A','Replacement product',1000,10,1000,10000,0,10000,'open');
      INSERT INTO procurement.inbound_shipments(id,shipment_number,status,allocation_method_default,warehouse_id)
        VALUES(1,'REPLACEMENT-SHIP','costing','by_line_count',1);
      INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,
        product_variant_id,sku,qty_shipped,carton_count,allocated_cost_cents)
        VALUES(11,1,10,21,200,'REPLACEMENT-A',1000,10,0);
      INSERT INTO procurement.inbound_freight_costs(id,inbound_shipment_id,cost_type,actual_cents,
        allocation_method,cost_status,currency,exchange_rate,vendor_id)
        VALUES(31,1,'freight',990,'by_line_count','finalized','USD',1,6)`);
    const invoice = await harness.ap.createInvoiceFromShipmentCosts(1, { vendorId: 6, invoiceNumber: NUMBER, costRowIds: [31], invoiceDate: FLOW_AT }, FLOW_ACTOR);
    originalId = invoice.id;
    await harness.ap.voidInvoice(originalId, "Original correction reason", FLOW_ACTOR);
  });
  afterEach(async () => { await harness?.dispose(); });

  async function preview(id = originalId) { return readInvoiceReplacementDetail(harness.database, id); }
  async function request(id = originalId) { return { expectedVersion: (await preview(id)).replacementCapability.expectedVersion, reason: "Correct shipment invoice" }; }
  function descriptor(key: string, id: number, input: Awaited<ReturnType<typeof request>>): FinancialCommandDescriptor {
    return { actorType: "user", actorId: FLOW_ACTOR, method: "POST", routeTemplate: "/api/vendor-invoices/:id/replacement",
      resourceKey: `vendor_invoice:${id}`, idempotencyKey: key, requestHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      commandName: "ap.invoice.replacement", contractVersion: 1 };
  }
  function execute(key: string, input: Awaited<ReturnType<typeof request>>, id = originalId) {
    return createApInvoiceReplacementCommands(createDrizzleFinancialCommandRepository(harness.database), () => FLOW_AT)
      .createReplacement(id, { ...input, userId: FLOW_ACTOR }, descriptor(key, id, input));
  }
  async function snapshot() {
    const tables = ["vendor_invoices", "vendor_invoice_lines", "vendor_invoice_po_links", "vendor_invoice_attachments", "inbound_freight_costs"];
    return Promise.all(tables.map(async table => (await harness.pool.query(`SELECT * FROM procurement.${table} ORDER BY id`)).rows));
  }

  it("retains the exact original and same supplier number, resets approval, clones valid PO links, and replays the durable result once", async () => {
    await harness.pool.query("INSERT INTO procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id,allocated_amount_cents) VALUES($1,10,990)", [originalId]);
    const before = await snapshot();
    const input = await request();
    expect((await preview()).replacementCapability.allowed).toBe(true);
    const result = await execute("replacement-success", input);
    expect(result.httpStatus).toBe(201);
    const body = result.body as { invoiceId: number };
    const repeated = await execute("replacement-success", input);
    expect(repeated).toMatchObject({ replayed: true, body: result.body });
    const after = await snapshot();
    expect(after[0].find(row => row.id === originalId)).toEqual(before[0][0]);
    expect(after[1].filter(row => row.vendor_invoice_id === originalId)).toEqual(before[1]);
    expect(after[2].filter(row => row.vendor_invoice_id === originalId)).toEqual(before[2]);
    expect(after[0].find(row => row.id === body.invoiceId)).toMatchObject({ status: "received", replaces_invoice_id: originalId,
      invoice_number: NUMBER, paid_amount_cents: "0", approved_at: null, approved_by: null });
    expect((await harness.pool.query("SELECT to_char(received_date, 'YYYY-MM-DD HH24:MI:SS') AS recorded FROM procurement.vendor_invoices WHERE id=$1", [body.invoiceId])).rows[0].recorded)
      .toBe("2026-09-10 12:00:00");
    expect(after[1].find(row => row.vendor_invoice_id === body.invoiceId)).toMatchObject({ freight_cost_id: 31, match_status: "pending", line_total_cents: "990" });
    expect(after[2].find(row => row.vendor_invoice_id === body.invoiceId)).toMatchObject({ purchase_order_id: 10, allocated_amount_cents: "990" });
    expect(after[4][0]).toMatchObject({ vendor_invoice_id: body.invoiceId, actual_cents: "990", cost_status: "invoiced" });
    expect((await preview()).replacementCapability).toMatchObject({ allowed: false, code: "AP_INVOICE_REPLACEMENT_EXISTS", successorInvoiceId: body.invoiceId });
    expect((await preview(body.invoiceId)).replacementHistory.map(row => row.id)).toEqual([originalId, body.invoiceId]);
    expect((await harness.pool.query("SELECT * FROM public.audit_events WHERE action='ap_ledger.invoice_replaced'")).rows).toHaveLength(1);
  });

  it("rolls back successor, cloned rows, links and assignments on an audit failure, then retries the same key", async () => {
    const before = await snapshot(), input = await request();
    await harness.pool.query(`CREATE FUNCTION public.fail_replacement_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='ap_ledger.invoice_replaced' THEN RAISE EXCEPTION 'injected replacement audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_replacement_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_replacement_audit()`);
    try {
      await expect(execute("replacement-rollback", input)).rejects.toThrow("injected replacement audit failure");
      expect(await snapshot()).toEqual(before);
    } finally {
      await harness.pool.query("DROP TRIGGER fail_replacement_audit ON public.audit_events; DROP FUNCTION public.fail_replacement_audit()");
    }
    await expect(execute("replacement-rollback", input)).rejects.toMatchObject({ code: "FINANCIAL_COMMAND_IN_PROGRESS" });
    // Honor the real owner's first retry boundary (two seconds), without
    // bypassing the immutable command ledger or relying on a guessed sleep.
    await harness.pool.query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (next_attempt_at-clock_timestamp()))) + 0.01) FROM public.financial_command_results WHERE idempotency_key='replacement-rollback' AND status='retryable'");
    expect((await execute("replacement-rollback", input)).httpStatus).toBe(201);
    expect((await harness.pool.query("SELECT * FROM procurement.vendor_invoices WHERE replaces_invoice_id=$1", [originalId])).rows).toHaveLength(1);
  });

  it("rejects a stale preview and concurrent requests create exactly one successor", async () => {
    const stale = await request();
    await harness.pool.query("UPDATE procurement.vendor_invoices SET notes='Changed after preview' WHERE id=$1", [originalId]);
    expect(await execute("replacement-stale", stale)).toMatchObject({ httpStatus: 409, body: { details: { code: "AP_INVOICE_REPLACEMENT_STALE" } } });
    const input = await request();
    const results = await Promise.all([execute("replacement-race-a", input), execute("replacement-race-b", input)]);
    expect(results.map(result => result.httpStatus).sort()).toEqual([201, 409]);
    expect((await harness.pool.query("SELECT count(*)::int AS count FROM procurement.vendor_invoices WHERE replaces_invoice_id=$1", [originalId])).rows[0].count).toBe(1);
  });

  it("preserves generic duplicate-number protection before and after replacement and freezes lineage identity", async () => {
    await expect(harness.ap.createInvoice({ vendorId: 6, invoiceNumber: NUMBER, createdBy: FLOW_ACTOR })).rejects.toMatchObject({ statusCode: 409, details: { code: "AP_INVOICE_DUPLICATE" } });
    const created = await execute("replacement-identity", await request());
    const successor = (created.body as { invoiceId: number }).invoiceId;
    await expect(harness.ap.updateInvoice(successor, { invoiceNumber: "RENAMED" }, FLOW_ACTOR)).rejects.toMatchObject({ statusCode: 409, details: { code: "AP_INVOICE_REPLACEMENT_IDENTITY_IMMUTABLE" } });
    await expect(harness.pool.query("UPDATE procurement.vendor_invoices SET currency='EUR' WHERE id=$1", [successor])).rejects.toMatchObject({ code: "23514" });
    await expect(harness.pool.query("DELETE FROM procurement.vendor_invoices WHERE id=$1", [successor])).rejects.toMatchObject({ code: "23514" });
    await expect(harness.pool.query("UPDATE procurement.vendor_invoices SET notes='erase history' WHERE id=$1", [originalId])).rejects.toMatchObject({ code: "23514" });
    await harness.ap.voidInvoice(successor, "second correction", FLOW_ACTOR);
    await expect(harness.ap.createInvoice({ vendorId: 6, invoiceNumber: NUMBER, createdBy: FLOW_ACTOR })).rejects.toMatchObject({ statusCode: 409 });
    const unrelated = await harness.ap.createInvoice({ vendorId: 6, invoiceNumber: "UNRELATED", createdBy: FLOW_ACTOR });
    await expect(harness.ap.updateInvoice(unrelated.id, { invoiceNumber: NUMBER }, FLOW_ACTOR)).rejects.toMatchObject({ statusCode: 409, details: { code: "AP_INVOICE_DUPLICATE" } });
  });

  it("retains original attachments and line evidence after replacement without cloning shared file ownership", async () => {
    const attachment = await harness.ap.addAttachment(originalId, { fileName: "supplier.pdf", filePath: "fixture-only/supplier.pdf", uploadedBy: FLOW_ACTOR });
    const result = await execute("replacement-documents", await request());
    const successor = (result.body as { invoiceId: number }).invoiceId;
    await expect(harness.ap.removeAttachment(attachment.id, FLOW_ACTOR)).rejects.toMatchObject({ statusCode: 409, details: { code: "AP_INVOICE_REPLACEMENT_HISTORY_IMMUTABLE" } });
    await expect(harness.pool.query("DELETE FROM procurement.vendor_invoice_lines WHERE vendor_invoice_id=$1", [originalId])).rejects.toMatchObject({ code: "23514" });
    await expect(harness.pool.query("DELETE FROM procurement.vendor_invoice_attachments WHERE vendor_invoice_id=$1", [originalId])).rejects.toMatchObject({ code: "23514" });
    expect((await harness.ap.getInvoiceById(originalId))?.attachments).toHaveLength(1);
    expect((await harness.ap.getInvoiceById(successor))?.attachments).toHaveLength(0);
  });

  it.each([
    ["status", "UPDATE procurement.vendor_invoices SET status='received'", "AP_INVOICE_REPLACEMENT_NOT_VOIDED"],
    ["paid", "UPDATE procurement.vendor_invoices SET paid_amount_cents=1", "AP_INVOICE_REPLACEMENT_PAYMENT_HISTORY"],
    ["cancelled", "UPDATE procurement.inbound_shipments SET status='cancelled'", "AP_INVOICE_REPLACEMENT_SHIPMENT_REVIEW"],
    ["unmapped", "UPDATE procurement.vendor_invoice_lines SET freight_cost_id=NULL", "AP_INVOICE_REPLACEMENT_SOURCE_REVIEW"],
    ["mixed", "UPDATE procurement.vendor_invoice_lines SET purchase_order_line_id=21", "AP_INVOICE_REPLACEMENT_SOURCE_REVIEW"],
    ["vendor", "UPDATE procurement.inbound_freight_costs SET vendor_id=5", "AP_INVOICE_REPLACEMENT_SOURCE_REVIEW"],
    ["assignment", "UPDATE procurement.inbound_freight_costs SET vendor_invoice_id=NULL", "AP_INVOICE_REPLACEMENT_SOURCE_REVIEW"],
    ["charge drift", "UPDATE procurement.inbound_freight_costs SET actual_cents=991", "AP_INVOICE_REPLACEMENT_TOTAL_REVIEW"],
    ["total drift", "UPDATE procurement.vendor_invoice_lines SET line_total_cents=991", "AP_INVOICE_REPLACEMENT_TOTAL_REVIEW"],
  ])("rejects %s source evidence without any clone", async (_label, sql, code) => {
    await harness.pool.query(sql);
    const detail = await preview();
    expect(detail.replacementCapability).toMatchObject({ allowed: false, code });
    const before = await snapshot();
    expect(await execute(`replacement-invalid-${_label}`, await request())).toMatchObject({ httpStatus: 409, body: { details: { code } } });
    expect(await snapshot()).toEqual(before);
  });

  it("allows a closed shipment but retains zero charge amounts and does not apply inventory", async () => {
    await harness.pool.query(`UPDATE procurement.inbound_shipments SET status='closed';
      UPDATE procurement.inbound_freight_costs SET actual_cents=0;
      UPDATE procurement.vendor_invoice_lines SET unit_cost_cents=0,unit_cost_mills=0,line_total_cents=0;
      UPDATE procurement.vendor_invoices SET invoiced_amount_cents=0,balance_cents=0`);
    expect((await execute("replacement-zero", await request())).httpStatus).toBe(201);
    expect((await harness.pool.query("SELECT * FROM inventory.cost_applications")).rows).toEqual([]);
    expect((await harness.pool.query("SELECT * FROM inventory.inventory_transactions")).rows).toEqual([]);
  });

  it("rejects retained voided-payment history despite a zero paid header", async () => {
    await harness.pool.query(`INSERT INTO procurement.ap_payments(id,payment_number,vendor_id,payment_date,payment_method,total_amount_cents,status)
      VALUES(1,'REPLACEMENT-VOIDED-PAYMENT',6,'2026-09-01','wire',990,'voided')`);
    await harness.pool.query(`INSERT INTO procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id,applied_amount_cents)
      VALUES(1,$1,990)`, [originalId]);
    expect((await preview()).replacementCapability).toMatchObject({ allowed: false, code: "AP_INVOICE_REPLACEMENT_PAYMENT_HISTORY" });
    expect(await execute("replacement-payment-history", await request())).toMatchObject({ httpStatus: 409 });
  });

  it("rejects forged replacement lineage and extra request fields at their boundaries", async () => {
    await expect(harness.pool.query(`INSERT INTO procurement.vendor_invoices(invoice_number,vendor_id,inbound_shipment_id,replaces_invoice_id,status)
      VALUES('FORGED-NUMBER',6,1,$1,'received')`, [originalId])).rejects.toMatchObject({ code: "23514" });
    const input = { ...await request(), vendorId: 5 };
    expect(await execute("replacement-extra-input", input)).toMatchObject({ httpStatus: 400,
      body: { details: { code: "AP_INVOICE_REPLACEMENT_INPUT_INVALID" } } });
  });

  it("keeps the rendered invoice and replacement version in one database snapshot during a concurrent edit", async () => {
    const before = await preview();
    const { pool: modulePool } = await import("../../../../db");
    const originalConnect = modulePool.connect;
    const connect = originalConnect as unknown as () => Promise<import("pg").PoolClient>;
    let changed = false;
    modulePool.connect = (async () => {
      const client = await connect.call(modulePool);
      const originalQuery = client.query, originalRelease = client.release;
      client.query = (async (...args: unknown[]) => {
        const first = args[0];
        const text = typeof first === "string" ? first : typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
        const result: unknown = await Reflect.apply(originalQuery, client, args);
        // Pause precisely after the real initial header SELECT has established
        // the snapshot, then commit a separate writer before the next detail read.
        if (!changed && text.includes('from "procurement"."vendor_invoices"')) {
          changed = true;
          await harness.pool.query("UPDATE procurement.vendor_invoices SET notes='Committed during detail read' WHERE id=$1", [originalId]);
        }
        return result;
      }) as typeof client.query;
      client.release = error => { client.query = originalQuery; client.release = originalRelease; originalRelease(error); };
      return client;
    }) as typeof modulePool.connect;
    try {
      const detail = await harness.ap.getInvoiceById(originalId);
      expect(changed).toBe(true);
      expect(detail?.notes).toBeNull();
      expect(detail?.replacementCapability.expectedVersion).toBe(before.replacementCapability.expectedVersion);
    } finally {
      modulePool.connect = originalConnect;
    }
    const after = await harness.ap.getInvoiceById(originalId);
    expect(after?.notes).toBe("Committed during detail read");
    expect(after?.replacementCapability.expectedVersion).not.toBe(before.replacementCapability.expectedVersion);
  });

  it("supports multiple voided generations and current approved lines resolve retained historical cost evidence", async () => {
    await harness.shipment.finalizeAllocations(1, FLOW_ACTOR);
    const first = await execute("replacement-generation-1", await request());
    const firstId = (first.body as { invoiceId: number }).invoiceId;
    await harness.ap.voidInvoice(firstId, "Correct again", FLOW_ACTOR);
    const second = await execute("replacement-generation-2", await request(firstId), firstId);
    const secondId = (second.body as { invoiceId: number }).invoiceId;
    await harness.ap.approveInvoice(secondId, FLOW_ACTOR);
    const recorded = await harness.database.transaction(tx => recordShipmentCostRevisions(tx, 1, FLOW_ACTOR, FLOW_AT));
    expect(recorded.revisions).toHaveLength(1);
    const row = (await harness.pool.query("SELECT contract,source_evidence FROM procurement.cost_source_revisions ORDER BY id DESC LIMIT 1")).rows[0];
    expect(row.contract).toMatchObject({ evidence: "confirmed", issue: null });
    expect(row.source_evidence.invoices.map((line: { vendor_invoice_id: number }) => line.vendor_invoice_id)).toEqual([originalId, firstId, secondId]);
    expect(row.contract.sources.filter((source: { kind: string }) => source.kind === "vendor_invoice_line").map((source: { documentId: number }) => source.documentId)).toEqual([secondId]);
    expect((await preview(secondId)).replacementHistory.map(invoice => invoice.id)).toEqual([originalId, firstId, secondId]);
    const summary = await readPoShipmentCosts(harness.database, 10);
    expect(summary?.summary).toMatchObject({ totalCents: 990, estimatedCents: 0 });
    expect(summary?.lines.flatMap(line => line.issues).filter(issue => issue.code.startsWith("LANDED_INVOICE"))).toEqual([]);
    expect((await harness.pool.query("SELECT * FROM inventory.cost_applications")).rows).toEqual([]);
  });
});
