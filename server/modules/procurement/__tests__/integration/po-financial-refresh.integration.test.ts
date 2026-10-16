import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PoFinancialRefreshFixture, REFRESH_ACTOR } from "./po-financial-refresh.fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const databaseTests = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;

// These are the existing whole-linked-invoice context caches. Refreshing them
// does not establish PO ownership of a combined invoice or split its payments.
databaseTests.sequential("Shared-invoice PO financial context refresh (real PostgreSQL)", () => {
  const fixture = new PoFinancialRefreshFixture();
  beforeAll(() => fixture.start(url!));
  beforeEach(() => fixture.seed());
  afterAll(() => fixture.stop());

  it("refreshes every linked PO after linking and importing a second PO", async () => {
    const invoiceId = await fixture.createInvoice([10]);
    await fixture.service.linkPoToInvoice(invoiceId, 20, undefined, "Add the second PO", REFRESH_ACTOR);
    expect(await fixture.amounts()).toEqual([
      { id: 10, invoiced: "3000", paid: "0", outstanding: "3000" },
      { id: 20, invoiced: "3000", paid: "0", outstanding: "3000" },
      { id: 30, invoiced: "0", paid: "0", outstanding: "0" },
    ]);
  });

  it("refreshes remaining POs and the removed PO when unlinking", async () => {
    const invoiceId = await fixture.createInvoice([10, 20]);
    await fixture.service.unlinkPoFromInvoice(invoiceId, 20, REFRESH_ACTOR);
    expect(await fixture.amounts()).toEqual([
      { id: 10, invoiced: "1000", paid: "0", outstanding: "1000" },
      { id: 20, invoiced: "0", paid: "0", outstanding: "0" },
      { id: 30, invoiced: "0", paid: "0", outstanding: "0" },
    ]);
  });

  it("refreshes other linked POs when importing missing source lines", async () => {
    const invoiceId = await fixture.createInvoice([10, 20]);
    await fixture.removeBLine(invoiceId);
    await fixture.service.importLinesFromPO(invoiceId, 20, REFRESH_ACTOR);
    expect(await fixture.amounts()).toEqual([
      { id: 10, invoiced: "3000", paid: "0", outstanding: "3000" },
      { id: 20, invoiced: "3000", paid: "0", outstanding: "3000" },
      { id: 30, invoiced: "0", paid: "0", outstanding: "0" },
    ]);
  });


  it("inserts and repeats a link without optional metadata or duplicate imported lines", async () => {
    const invoiceId = await fixture.createInvoice([10]);
    const first = await fixture.service.linkPoToInvoice(invoiceId, 20, undefined, undefined, REFRESH_ACTOR);
    const repeat = await fixture.service.linkPoToInvoice(invoiceId, 20, undefined, undefined, REFRESH_ACTOR);
    expect(repeat).toEqual(first);
    expect(first).toMatchObject({ vendorInvoiceId: invoiceId, purchaseOrderId: 20,
      allocatedAmountCents: null, notes: null });
    const lines = await fixture.pool.query("SELECT purchase_order_line_id FROM procurement.vendor_invoice_lines ORDER BY purchase_order_line_id");
    expect(lines.rows).toEqual([{ purchase_order_line_id: 21 }, { purchase_order_line_id: 22 }]);
    expect((await fixture.amounts()).slice(0, 2)).toEqual([
      { id: 10, invoiced: "3000", paid: "0", outstanding: "3000" },
      { id: 20, invoiced: "3000", paid: "0", outstanding: "3000" },
    ]);
  });

  it("preserves omitted metadata and accepts an explicit zero allocation", async () => {
    const invoiceId = await fixture.createInvoice([10]);
    const original = await fixture.service.linkPoToInvoice(invoiceId, 20, 2000, "Keep this note", REFRESH_ACTOR);
    expect(await fixture.service.linkPoToInvoice(invoiceId, 20, undefined, undefined, REFRESH_ACTOR)).toEqual(original);
    expect(await fixture.service.linkPoToInvoice(invoiceId, 20, 0, undefined, REFRESH_ACTOR))
      .toMatchObject({ id: original.id, allocatedAmountCents: 0, notes: "Keep this note" });
    expect(await fixture.service.linkPoToInvoice(invoiceId, 20, undefined, "Revised note", REFRESH_ACTOR))
      .toMatchObject({ id: original.id, allocatedAmountCents: 0, notes: "Revised note" });
  });

  it("leaves a missing relationship unlink as a no-op", async () => {
    const invoiceId = await fixture.createInvoice([10, 20]);
    expect(await fixture.service.unlinkPoFromInvoice(invoiceId, 20, REFRESH_ACTOR)).toEqual({ ok: true, changed: true });
    const before = await fixture.snapshot();
    expect(await fixture.service.unlinkPoFromInvoice(invoiceId, 20, REFRESH_ACTOR)).toEqual({ ok: true, changed: false });
    expect(await fixture.snapshot()).toEqual(before);
  });

  it("repeated import keeps line identities and whole-invoice context amounts stable", async () => {
    const invoiceId = await fixture.createInvoice([10, 20]);
    const beforeLines = (await fixture.pool.query("SELECT * FROM procurement.vendor_invoice_lines ORDER BY id")).rows;
    const beforeAmounts = await fixture.amounts();
    expect(await fixture.service.importLinesFromPO(invoiceId, 20, REFRESH_ACTOR)).toEqual([]);
    expect((await fixture.pool.query("SELECT * FROM procurement.vendor_invoice_lines ORDER BY id")).rows).toEqual(beforeLines);
    expect(await fixture.amounts()).toEqual(beforeAmounts);
    const audit = await fixture.pool.query("SELECT context FROM public.audit_events WHERE action='ap_ledger.invoice_lines_imported' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0].context).toMatchObject({ affectedPurchaseOrderIds: [10, 20], importedLineIds: [] });
  });

  it("serializes two concurrent links and refreshes every final relationship", async () => {
    const invoiceId = await fixture.createInvoice([10]);
    const blocker = await fixture.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext('inventory.cost_graph'), hashtext('version_1'))");
    const changes = Promise.all([
      fixture.service.linkPoToInvoice(invoiceId, 20, undefined, undefined, REFRESH_ACTOR),
      fixture.service.linkPoToInvoice(invoiceId, 30, undefined, undefined, REFRESH_ACTOR),
    ]);
    let bothBlocked = false;
    try {
      bothBlocked = await fixture.waitForBlockedGraphWriters(2);
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
      await changes;
    }
    expect(bothBlocked, "both writers must actually overlap at the PostgreSQL graph lock").toBe(true);
    expect(await fixture.amounts()).toEqual([10, 20, 30].map(id => ({
      id, invoiced: "6000", paid: "0", outstanding: "6000",
    })));
    const lines = (await fixture.pool.query<{ purchase_order_line_id: number; line_number: number }>(
      "SELECT purchase_order_line_id,line_number FROM procurement.vendor_invoice_lines ORDER BY purchase_order_line_id")).rows;
    expect(lines).toEqual([
        { purchase_order_line_id: 21, line_number: 1 },
        { purchase_order_line_id: 22, line_number: expect.any(Number) },
        { purchase_order_line_id: 23, line_number: expect.any(Number) },
      ]);
    expect(lines.map(line => line.line_number).sort((left, right) => left - right)).toEqual([1, 2, 3]);
    const finalAudit = await fixture.pool.query("SELECT context FROM public.audit_events WHERE action='ap_ledger.invoice_po_linked' ORDER BY id DESC LIMIT 1");
    expect(finalAudit.rows[0].context.affectedPurchaseOrderIds).toEqual([10, 20, 30]);
  });

  type Change = "link" | "unlink" | "import";
  const actions: Record<Change, string> = {
    link: "ap_ledger.invoice_po_linked", unlink: "ap_ledger.invoice_po_unlinked", import: "ap_ledger.invoice_lines_imported",
  };
  async function prepareChange(change: Change): Promise<{ invoiceId: number; run: () => Promise<unknown> }> {
    const invoiceId = await fixture.createInvoice(change === "link" ? [10] : [10, 20]);
    if (change === "import") await fixture.removeBLine(invoiceId);
    return { invoiceId, run: () => change === "link"
      ? fixture.service.linkPoToInvoice(invoiceId, 20, undefined, undefined, REFRESH_ACTOR)
      : change === "unlink"
        ? fixture.service.unlinkPoFromInvoice(invoiceId, 20, REFRESH_ACTOR)
        : fixture.service.importLinesFromPO(invoiceId, 20, REFRESH_ACTOR) };
  }

  it.each(["link", "unlink", "import"] as const)("records all affected POs and runs their postcommit detection after %s", async change => {
    const { run, invoiceId } = await prepareChange(change);
    // A recorded old invoice due date makes the other PO detection observable.
    await fixture.pool.query("UPDATE procurement.vendor_invoices SET due_date='2000-01-01' WHERE id=$1", [invoiceId]);
    await run();
    const expectedTotal = change === "unlink" ? 1000 : 3000;
    const audit = await fixture.pool.query("SELECT actor,context FROM public.audit_events WHERE action=$1 ORDER BY id DESC LIMIT 1", [actions[change]]);
    expect(audit.rows[0]).toMatchObject({ actor: REFRESH_ACTOR, context: { affectedPurchaseOrderIds: [10, 20] } });
    const detected = await fixture.pool.query("SELECT po_id,payload FROM procurement.po_exceptions WHERE po_id=10 AND kind='past_due'");
    expect(detected.rows).toEqual([{ po_id: 10, payload: expect.objectContaining({ outstandingCents: expectedTotal }) }]);
  });

  it.each(["link", "unlink", "import"] as const)("rolls back invoice, relationships, lines, all PO caches and history on final %s audit failure", async change => {
    const { run } = await prepareChange(change);
    await fixture.pool.query(`
      CREATE OR REPLACE FUNCTION procurement.reject_refresh_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action=TG_ARGV[0] THEN RAISE EXCEPTION 'injected final PO refresh audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_refresh_audit BEFORE INSERT ON public.audit_events FOR EACH ROW
        EXECUTE FUNCTION procurement.reject_refresh_audit('${actions[change]}');
    `);
    const before = await fixture.snapshot();
    await expect(run()).rejects.toMatchObject({ code: "P0001", message: "injected final PO refresh audit failure" });
    expect(await fixture.snapshot()).toEqual(before);
  });

});
