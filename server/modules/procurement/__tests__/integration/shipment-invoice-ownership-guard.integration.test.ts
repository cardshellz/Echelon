import { vendorInvoiceAttachments } from "@shared/schema";
import { fixtureTable } from "./shipment-line-fixture";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDrizzleFinancialCommandRepository } from "../../../../platform/commands/command-results.repository";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import { createShipmentInvoiceCommands, hashShipmentInvoiceCommandIdentity, shipmentInvoiceCommandScope, SHIPMENT_INVOICE_COMMAND_PRINCIPAL } from "../../shipment-invoice.commands";
import { createFlowCostHarness, seedFlowMasterData, FLOW_ACTOR, FLOW_AT, type FlowCostHarness } from "./procurement-flow-cost.fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const integration = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const ownershipSql = readFileSync(resolve(process.cwd(), "docs/procurement/shipment-invoice-ownership-guard.pending.sql"), "utf8");
const input = { vendorId: 6, invoiceNumber: "FREIGHT-OWNERSHIP-1", costRowIds: [31], invoiceDate: "2026-09-10" };

integration.sequential("freight invoice command recovery and SQL ownership guard", () => {
  let h: FlowCostHarness;
  beforeEach(async () => {
    h = await createFlowCostHarness(url!);
    await h.pool.query(fixtureTable(vendorInvoiceAttachments));
    await h.pool.query(readFileSync(resolve(process.cwd(), "migrations/900000006000017980001_invoice_replacement_lineage.sql"), "utf8"));
    await seedFlowMasterData(h);
    await h.pool.query(`INSERT INTO procurement.inbound_shipments(id,shipment_number,status,warehouse_id) VALUES(1,'BILLING-SHIP','costing',1);
      INSERT INTO procurement.inbound_freight_costs(id,inbound_shipment_id,cost_type,actual_cents,allocation_method,cost_status,currency,exchange_rate,vendor_id)
      VALUES(31,1,'freight',990,'by_line_count','finalized','USD',1,6)`);
  });
  afterEach(async () => { await h?.dispose(); });
  function descriptor(key: string, body: unknown = input, actorId = FLOW_ACTOR, shipmentId = 1): FinancialCommandDescriptor {
    return { ...shipmentInvoiceCommandScope(), actorType: "service", actorId: SHIPMENT_INVOICE_COMMAND_PRINCIPAL,
      contractVersion: 1, idempotencyKey: key, requestHash: hashShipmentInvoiceCommandIdentity({ shipmentId, body, actorId }) };
  }
  function command(key: string, body: unknown = input, actorId = FLOW_ACTOR, shipmentId = 1) {
    return createShipmentInvoiceCommands(h.ap, createDrizzleFinancialCommandRepository(h.database), () => FLOW_AT)
      .execute(shipmentId, body, actorId, descriptor(key, body, actorId, shipmentId));
  }
  async function install() { await h.pool.query(ownershipSql); }
  async function counts() {
    return (await h.pool.query(`SELECT (SELECT count(*)::int FROM procurement.vendor_invoices) AS invoices,
      (SELECT count(*)::int FROM procurement.vendor_invoice_lines) AS lines,
      (SELECT vendor_invoice_id FROM procurement.inbound_freight_costs WHERE id=31) AS pointer,
      (SELECT count(*)::int FROM public.audit_events WHERE action='ap_ledger.shipment_cost_invoice_created') AS audits`)).rows[0];
  }
  async function bareInvoice(number: string) {
    return (await h.pool.query(`INSERT INTO procurement.vendor_invoices(vendor_id,invoice_number,inbound_shipment_id,status,currency,invoiced_amount_cents,balance_cents)
      VALUES(6,$1,1,'received','USD',990,990) RETURNING id`, [number])).rows[0].id as number;
  }
  const insertSource = `INSERT INTO procurement.vendor_invoice_lines(vendor_invoice_id,line_number,freight_cost_id,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents)
    VALUES($1,1,31,1,990,9900,990)`;

  it("reapplies the migration safely and replays the original committed creation after later voiding", async () => {
    await install(); await install();
    const first = await command("freight-create-replay");
    expect(first).toMatchObject({ terminalState: "succeeded", httpStatus: 200, body: { vendorId: 6, shipmentId: 1, actorId: FLOW_ACTOR, costRowIds: [31], totalCents: 990 } });
    const invoiceId = (first.body as { invoiceId: number }).invoiceId;
    await h.ap.voidInvoice(invoiceId, "Reviewed correction", FLOW_ACTOR);
    expect(await command("freight-create-replay")).toMatchObject({ replayed: true, httpStatus: first.httpStatus, body: first.body });
    expect(await counts()).toEqual({ invoices: 1, lines: 1, pointer: invoiceId, audits: 1 });
  });
  it.each([
    ["actor", input, "another-operator", 1],
    ["shipment", input, FLOW_ACTOR, 2],
    ["raw body", { ...input, invoiceNumber: ` ${input.invoiceNumber}` }, FLOW_ACTOR, 1],
  ] as const)("binds a committed key to its original %s", async (_label, body, actor, shipment) => {
    await install(); await command("freight-create-identity");
    await expect(command("freight-create-identity", body, actor, shipment)).rejects.toMatchObject({ statusCode: 422, code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
    expect((await counts()).invoices).toBe(1);
  });
  it("durably rejects bad dates and duplicate selection without writing financial rows", async () => {
    await install();
    const invalid = { ...input, invoiceDate: "2026-02-30", costRowIds: [31,31] };
    const first = await command("freight-create-invalid", invalid);
    expect(first).toMatchObject({ terminalState: "rejected", httpStatus: 400, body: { code: "SHIPMENT_INVOICE_INPUT_INVALID", commandOutcome: "rejected", actorId: FLOW_ACTOR, shipmentId: 1, idempotencyKey: "freight-create-invalid" } });
    expect(await command("freight-create-invalid", invalid)).toMatchObject({ replayed: true, body: first.body });
    expect(await counts()).toEqual({ invoices: 0, lines: 0, pointer: null, audits: 0 });
  });
  it("competing command keys create one invoice and one retained source", async () => {
    await install();
    const results = await Promise.all([command("freight-create-race-a"), command("freight-create-race-b", { ...input, invoiceNumber: "FREIGHT-OWNERSHIP-2" })]);
    expect(results.map(result => result.httpStatus).sort()).toEqual([200,409]);
    expect(await counts()).toMatchObject({ invoices: 1, lines: 1, audits: 1 });
  });
  it("rolls back invoice, source, pointer and audit on failure and recovers with the same key", async () => {
    await install();
    await h.pool.query(`CREATE FUNCTION public.reject_freight_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='ap_ledger.shipment_cost_invoice_created' THEN RAISE EXCEPTION 'injected freight audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_freight_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_freight_audit()`);
    try {
      await expect(command("freight-create-rollback")).rejects.toThrow("injected freight audit failure");
      expect(await counts()).toEqual({ invoices: 0, lines: 0, pointer: null, audits: 0 });
    } finally { await h.pool.query("DROP TRIGGER reject_freight_audit ON public.audit_events; DROP FUNCTION public.reject_freight_audit()"); }
    await h.pool.query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (next_attempt_at-clock_timestamp()))) + 0.01) FROM public.financial_command_results WHERE idempotency_key='freight-create-rollback'");
    expect(await command("freight-create-rollback")).toMatchObject({ httpStatus: 200 });
    expect(await counts()).toMatchObject({ invoices: 1, lines: 1, audits: 1 });
  });
  it("rolls back a malformed owner response before saving success", async () => {
    await install();
    const owner = { createInvoiceFromShipmentCostsInTransaction: async (...args: Parameters<typeof h.ap.createInvoiceFromShipmentCostsInTransaction>) => ({
      ...await h.ap.createInvoiceFromShipmentCostsInTransaction(...args), vendorId: 5,
    }) };
    await expect(createShipmentInvoiceCommands(owner, createDrizzleFinancialCommandRepository(h.database), () => FLOW_AT)
      .execute(1,input,FLOW_ACTOR,descriptor("freight-create-corrupt"))).rejects.toMatchObject({ details: { code: "SHIPMENT_INVOICE_RESULT_INVALID" } });
    expect(await counts()).toEqual({ invoices: 0, lines: 0, pointer: null, audits: 0 });
  });
  it("rejects a pointer without line evidence and leaves existing records untouched", async () => {
    await install(); const invoiceId = await bareInvoice("POINTER-ONLY");
    await expect(h.pool.query("UPDATE procurement.inbound_freight_costs SET vendor_invoice_id=$1 WHERE id=31", [invoiceId])).rejects.toMatchObject({ code: "23514", constraint: "shipment_invoice_owner_consistency" });
    expect((await counts()).pointer).toBeNull();
  });
  it.each([
    ["delete", "DELETE FROM procurement.vendor_invoice_lines WHERE freight_cost_id=31"],
    ["truncate", "TRUNCATE procurement.vendor_invoice_lines CASCADE"],
    ["clear", "UPDATE procurement.vendor_invoice_lines SET freight_cost_id=NULL WHERE freight_cost_id=31"],
    ["pointer", "UPDATE procurement.inbound_freight_costs SET vendor_invoice_id=NULL WHERE id=31"],
    ["supplier", "UPDATE procurement.vendor_invoices SET vendor_id=5"],
    ["currency", "UPDATE procurement.inbound_freight_costs SET currency='EUR' WHERE id=31"],
  ])("prevents %s from erasing or contradicting owned freight history", async (_label, sql) => {
    await install(); await command("freight-source-preserve"); const before = await counts();
    await expect(h.pool.query(sql)).rejects.toMatchObject({ code: "23514" });
    expect(await counts()).toEqual(before);
  });
  it("rejects a separate product source added to an existing freight invoice", async () => {
    await install(); const first=await command("freight-no-mixed-product"); const id=(first.body as {invoiceId:number}).invoiceId;
    await expect(h.pool.query("INSERT INTO procurement.vendor_invoice_lines(vendor_invoice_id,line_number,product_variant_id,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents) VALUES($1,2,200,1,10,1000,10)",[id])).rejects.toMatchObject({code:"23514",constraint:"shipment_invoice_owner_consistency"});
    expect((await counts()).lines).toBe(1);
  });
  it("allows multiple lines for the same invoice owner and exact cost repricing", async () => {
    await install(); const first = await command("freight-multiple-lines"); const id = (first.body as { invoiceId: number }).invoiceId;
    await h.pool.query(insertSource.replace("VALUES($1,1,31", "VALUES($1,2,31"), [id]);
    await h.pool.query("UPDATE procurement.vendor_invoice_lines SET unit_cost_cents=500,unit_cost_mills=5000,line_total_cents=500 WHERE freight_cost_id=31");
    expect((await h.ap.enrichCostsWithInvoiceInfo(1))[0].billingOwnership).toMatchObject({ state: "billed", activeInvoiceId: id });
  });
  it("preserves preexisting ambiguous history on install and permits voiding without treating the charge as unbilled", async () => {
    const one = await bareInvoice("HISTORIC-ONE"), two = await bareInvoice("HISTORIC-TWO");
    await h.pool.query(insertSource, [one]); await h.pool.query(insertSource, [two]);
    await install(); const before = await counts();
    expect((await h.ap.enrichCostsWithInvoiceInfo(1))[0].billingOwnership).toMatchObject({ state: "review_required", canCreateInvoice: false });
    expect(await command("freight-legacy-rebill")).toMatchObject({ httpStatus: 409 });
    expect(await counts()).toEqual(before);
    await h.ap.voidInvoice(two,"Remove duplicate active liability",FLOW_ACTOR);
    expect((await h.ap.enrichCostsWithInvoiceInfo(1))[0].billingOwnership).toMatchObject({ state: "review_required", canCreateInvoice: false });
    expect((await counts()).lines).toBe(2);
  });
  it.each([
    ["clear", "UPDATE procurement.inbound_freight_costs SET vendor_invoice_id=NULL WHERE id=31"],
    ["delete", "DELETE FROM procurement.inbound_freight_costs WHERE id=31"],
  ])("preserves the last historical pointer on %s even without source lines", async (_label, sql) => {
    const invoiceId=await bareInvoice("LEGACY-ASSOCIATION");
    await h.pool.query("UPDATE procurement.inbound_freight_costs SET vendor_invoice_id=$1 WHERE id=31",[invoiceId]);
    await install(); const before=await counts();
    await expect(h.pool.query(sql)).rejects.toMatchObject({code:"23514",constraint:"shipment_invoice_source_immutable"});
    expect(await counts()).toEqual(before);
  });
  it("cannot move an unmapped historical pointer to a new correctly mapped invoice", async () => {
    const old=await bareInvoice("UNMAPPED-ORIGINAL"), replacement=await bareInvoice("UNRELATED-NEW");
    await h.pool.query("UPDATE procurement.inbound_freight_costs SET vendor_invoice_id=$1 WHERE id=31",[old]);
    await install(); const connection=await h.pool.connect();
    try {
      await connection.query("BEGIN"); await connection.query(insertSource,[replacement]);
      await expect(connection.query("UPDATE procurement.inbound_freight_costs SET vendor_invoice_id=$1 WHERE id=31",[replacement])).rejects.toMatchObject({code:"23514",constraint:"shipment_invoice_source_immutable"});
    } finally {await connection.query("ROLLBACK");connection.release();}
    expect(await counts()).toMatchObject({lines:0,pointer:old});
  });
  it("does not create new non-USD billing even when both source records agree", async () => {
    const invoiceId=await bareInvoice("FOREIGN-SOURCE");
    await h.pool.query("UPDATE procurement.vendor_invoices SET currency='EUR'; UPDATE procurement.inbound_freight_costs SET currency='EUR'");
    await install(); const connection=await h.pool.connect();
    try {
      await connection.query("BEGIN"); await connection.query(insertSource,[invoiceId]);
      await connection.query("UPDATE procurement.inbound_freight_costs SET vendor_invoice_id=$1 WHERE id=31",[invoiceId]);
      await expect(connection.query("COMMIT")).rejects.toMatchObject({code:"23514",constraint:"shipment_invoice_owner_consistency"});
    } finally {await connection.query("ROLLBACK");connection.release();}
    expect(await counts()).toMatchObject({lines:0,pointer:null});
  });
  it("serializes direct competing SQL before row locks and rejects the second owner at commit", async () => {
    await install(); const one = await bareInvoice("DIRECT-ONE"), two = await bareInvoice("DIRECT-TWO");
    const first = await h.pool.connect(), second = await h.pool.connect();
    let pending: Promise<{ ok: boolean; error?: unknown }> | undefined;
    try {
      await first.query("BEGIN"); await first.query(insertSource,[one]);
      await first.query("UPDATE procurement.inbound_freight_costs SET vendor_invoice_id=$1 WHERE id=31",[one]);
      await second.query("BEGIN"); const pid = (await second.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      pending = second.query(insertSource,[two]).then(() => ({ok:true}), error => ({ok:false,error}));
      let blocked = false;
      for (let attempt=0;attempt<60;attempt++) {
        if ((await h.pool.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",[pid])).rows[0].blocked) { blocked=true; break; }
        await new Promise(resolve => setTimeout(resolve,10));
      }
      expect(blocked).toBe(true); await first.query("COMMIT"); expect(await pending).toEqual({ok:true});
      await expect(second.query("COMMIT")).rejects.toMatchObject({code:"23514",constraint:"shipment_invoice_owner_consistency"});
      expect((await counts()).lines).toBe(1);
    } finally { await first.query("ROLLBACK"); await second.query("ROLLBACK"); await pending; first.release(); second.release(); }
  });
});
