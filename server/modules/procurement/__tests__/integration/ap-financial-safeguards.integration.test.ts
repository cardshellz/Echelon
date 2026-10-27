import { supplierReturnReadFixtureTables } from "./supplier-return-fixture";
import { createApSummaryReadBarrier } from "./ap-summary-read-barrier";
import pg from "pg";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";

// Regression fixture: actual participating columns/FKs, unique indexes and financial triggers.
// Current payment authority uses real Identity rows; unrelated WMS tables and
// the full production migration chain remain outside this fixture.
// Actual SQL and application owners; only the module-global DB transport is redirected.
const url = process.env.ECHELON_TEST_DATABASE_URL;
const databaseTests = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const tables = [schema.users, schema.authRoles, schema.authPermissions, schema.authUserRoles, schema.authRolePermissions,
  schema.vendors, schema.inboundShipments, schema.purchaseOrders, schema.purchaseOrderLines,
  schema.vendorInvoices, schema.supplierCredits, schema.supplierCreditLines,
  ...supplierReturnReadFixtureTables, schema.supplierCreditApplications, schema.supplierCreditApplicationReversals, schema.vendorInvoiceLines, schema.vendorInvoicePoLinks, schema.inboundFreightCosts,
  schema.apPayments, schema.apPaymentAllocations, schema.poStatusHistory, schema.vendorInvoiceAttachments];
databaseTests.sequential("AP financial safeguards with actual0620 and status constraint (real PostgreSQL)", () => {
  let pool: pg.Pool; let modulePool: pg.Pool; let db: any;
  let service: typeof import("../../ap-ledger.service");
  let ownsSchema = false; let ownsIdentitySchema = false; let ownsAuditTable = false;
  const actor = "review-ap-unhappy-path";
  let ownsSupplierReturnInventory = false;
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
      || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(url)) {
      throw new Error("Probe requires a separate explicitly disposable local database");
    }
    pool = new pg.Pool({ connectionString: url, ssl: false, max: 6, statement_timeout: 10000 });
    await pool.query("CREATE SCHEMA identity"); ownsIdentitySchema = true;
    await pool.query("CREATE SCHEMA inventory"); ownsSupplierReturnInventory = true;
    await pool.query("CREATE SCHEMA procurement"); ownsSchema = true;
    for (const table of tables) await pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(tables)) await pool.query(statement);
    await pool.query(fixtureTable(schema.auditEvents)); ownsAuditTable = true;
    // Relevant actual constraints (schema's status columns have no enum/check).
    await pool.query(`
      CREATE UNIQUE INDEX vendor_invoices_vendor_invoice_idx ON procurement.vendor_invoices(vendor_id,invoice_number);
      ALTER TABLE procurement.vendor_invoices ADD CHECK(currency='USD');
      ALTER TABLE procurement.ap_payments ADD CHECK(currency='USD');
      CREATE UNIQUE INDEX ap_payments_payment_number_active_uidx ON procurement.ap_payments(payment_number) WHERE voided_at IS NULL;
      CREATE UNIQUE INDEX ap_payment_allocations_pay_inv_idx ON procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id);
      CREATE UNIQUE INDEX vendor_invoice_po_links_inv_po_idx ON procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id)`);
    await pool.query(readFileSync("migrations/0620_vendor_invoice_unit_cost_mills_repair.sql", "utf8"));
    await pool.query(readFileSync("migrations/900000001000017780001_ap_payment_completed_status_guard.sql", "utf8"));
    const guards = (await pool.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid='procurement.vendor_invoice_lines'::regclass AND NOT tgisinternal AND tgenabled='O' AND tgname IN ('vendor_invoice_lines_require_mills_on_insert','vendor_invoice_lines_require_mills_on_financial_update')")).rows[0].count;
    expect(guards).toBe(2);
    if (process.env.DATABASE_URL || process.env.EXTERNAL_DATABASE_URL) throw new Error("Unexpected application database URL in probe process");
    const dbModule = await import("../../../../db");
    modulePool = dbModule.pool; db = dbModule.db;
    modulePool.query = pool.query.bind(pool) as any;
    modulePool.connect = pool.connect.bind(pool) as any;
    service = await import("../../ap-ledger.service");
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE ${tables.map(qualifiedTable).join(",")} RESTART IDENTITY CASCADE`);
    await pool.query("TRUNCATE public.audit_events RESTART IDENTITY");
    // The real command owner rechecks active account and current grants after
    // acquiring its transaction lock. A role label alone is not authority.
    await pool.query(`INSERT INTO identity.users(id,username,password,role,active)
        VALUES('${actor}','ap-safeguards-operator','unused','picker',1);
      INSERT INTO identity.auth_roles(id,name) VALUES(1,'AP safeguards approver');
      INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES(1,'purchasing','approve','purchasing');
      INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES('${actor}',1);
      INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES(1,1)`);
    await pool.query(`INSERT INTO procurement.vendors(id,code,name) VALUES(5,'AP-PROBE','Synthetic vendor');
      INSERT INTO procurement.inbound_shipments(id,shipment_number,status) VALUES(9,'AP-PROBE-SHIP','costing');
      INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,status,invoiced_amount_cents,balance_cents,due_date)
        VALUES(71,'AP-PROBE-INV',5,'approved',10000,10000,'2026-09-01')`);
  });
  afterAll(async () => {
    if (ownsSupplierReturnInventory) await pool!.query("DROP SCHEMA inventory CASCADE");
    // Attempt every owned cleanup even when setup stopped partway through.
    const failures: unknown[] = [];
    for (const cleanup of [
      async () => { if (ownsSchema) await pool.query("DROP SCHEMA procurement CASCADE"); },
      async () => { if (ownsAuditTable) await pool.query("DROP TABLE public.audit_events"); },
      async () => { if (ownsIdentitySchema) await pool.query("DROP SCHEMA identity CASCADE"); },
      async () => { await pool?.end(); },
      async () => { await modulePool?.end(); },
    ]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "AP safeguards fixture cleanup failed");
  });
  const pay = (amount: number, status = "completed") => db.transaction((tx: any) =>
    service.executeApPaymentCommandInTransaction("record_payment", { now: new Date("2026-10-25T12:00:00.000Z"), userId: actor, payment: {
      vendorId: 5, paymentDate: new Date("2026-10-13T12:00:00Z"), paymentMethod: "ach",
      totalAmountCents: amount, status, allocations: [{ vendorInvoiceId: 71, appliedAmountCents: amount }], createdBy: actor,
    } }, tx));
  const invoiceCommand = (command: "dispute_invoice" | "void_invoice" | "approve_invoice") => db.transaction((tx: any) =>
    service.executeApInvoiceCommandInTransaction(command, { invoiceId: 71, userId: actor, reason: "Synthetic review reason" }, tx));
  const invoice = async () => (await pool.query("SELECT status,invoiced_amount_cents,paid_amount_cents,balance_cents FROM procurement.vendor_invoices WHERE id=71")).rows[0];

  async function unrecognized() {
    await pool.query("UPDATE procurement.vendor_invoices SET status='received',approved_at=NULL,approved_by=NULL WHERE id=71");
  }
  async function recognizedDispute() {
    await unrecognized();
    await invoiceCommand("approve_invoice");
    await invoiceCommand("dispute_invoice");
  }
  async function lineAndLinks() {
    await pool.query(`INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,total_cents) VALUES(10,'PO-A',5,'received',10000);
      INSERT INTO procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id) VALUES(71,10);
      INSERT INTO procurement.inbound_freight_costs(id,inbound_shipment_id,cost_type,vendor_id,actual_cents,vendor_invoice_id,cost_status) VALUES(81,9,'freight',5,10000,71,'invoiced');
      INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents) VALUES(72,71,1,1,10000,1000000,10000)`);
  }
  const historyRejection = { statusCode: 409, details: { code: "AP_INVOICE_FINANCIAL_HISTORY" } };

  it.each(["returned", "scheduled", "arbitrary_status", "voided"])("rejects new %s payment atomically", async status => {
    await expect(pay(10000, status)).rejects.toMatchObject({ statusCode: 400, details: { code: "AP_PAYMENT_STATUS_INVALID" } });
    expect(await invoice()).toMatchObject({ paid_amount_cents: "0", balance_cents: "10000" });
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.ap_payments")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM public.audit_events")).rows[0].count).toBe(0);
  });
  it("rejects a revoked real permission before changing settlement or audit history", async () => {
    await pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=1 AND permission_id=1");
    await expect(pay(8000)).rejects.toMatchObject({ statusCode: 403, details: { code: "AP_PAYMENT_AUTHORITY_REQUIRED" } });
    expect(await invoice()).toMatchObject({ paid_amount_cents: "0", balance_cents: "10000" });
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.ap_payments")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM public.audit_events")).rows[0].count).toBe(0);
  });
  it("keeps completed settlement and dashboard totals consistent", async () => {
    await pool.query(`INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,total_cents) VALUES(10,'PO-A',5,'received',10000);
      INSERT INTO procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id) VALUES(71,10)`);
    await pay(8000);
    expect(await invoice()).toMatchObject({ status: "partially_paid", paid_amount_cents: "8000", balance_cents: "2000" });
    expect(await service.getApSummary({ now: new Date("2026-10-13T12:00:00Z") })).toMatchObject({ paidAllTimeCents: 8000, paidThisMonthCents: 8000, totalOutstandingCents: 2000 });
    expect(await service.getPaymentsForPo(10)).toEqual([expect.objectContaining({ appliedAmountCents: 8000, paymentStatus: "completed" })]);
  });
  async function summaryFinancialState() {
    const tables = ["procurement.vendor_invoices", "procurement.ap_payments",
      "procurement.ap_payment_allocations", "public.audit_events"];
    return Promise.all(tables.map(table => pool.query(`SELECT * FROM ${table} ORDER BY id`).then(result => result.rows)));
  }

  it.each(["record", "void"] as const)("keeps AP summary snapshot coherent during a concurrent %s payment commit", async command => {
    const at = new Date("2026-10-13T12:00:00Z");
    const existingPayment = command === "void" ? await pay(10000) : undefined;
    const before = await service.getApSummary({ now: at });
    const barrier = createApSummaryReadBarrier(modulePool);
    const pending = service.getApSummary({ now: at });
    try {
      await barrier.waitForRead(pending);
      if (existingPayment) {
        await db.transaction((tx: any) => service.executeApPaymentCommandInTransaction("void_payment", {
          now: new Date("2026-10-25T13:00:00Z"), paymentId: existingPayment.id,
          reason: "Synthetic concurrent snapshot reversal", userId: actor,
        }, tx));
      } else {
        await pay(10000);
      }
      const afterCommit = await service.getApSummary({ now: at });
      const committedState = await summaryFinancialState();
      expect(afterCommit).toMatchObject(command === "record"
        ? { totalOutstandingCents: 0, openInvoiceCount: 0, paidAllTimeCents: 10000, paidThisMonthCents: 10000 }
        : { totalOutstandingCents: 10000, openInvoiceCount: 1, paidAllTimeCents: 0, paidThisMonthCents: 0 });
      expect(afterCommit).not.toEqual(before);
      barrier.resume();
      // The entire response, including recent payment/invoice activity, belongs
      // to the pre-commit reader snapshot, not a mixture of old/new sections.
      expect(await pending).toEqual(before);
      expect(barrier.snapshot).toMatchObject({ isolation: "repeatable read", readOnly: "on" });
      expect(barrier.readerReleaseCount).toBe(1);
      expect(await service.getApSummary({ now: at })).toEqual(afterCommit);
      expect(await summaryFinancialState()).toEqual(committedState);
    } finally { await barrier.close(pending); }
  });

  it("captures AP summary clock before a caller mutates its Date", async () => {
    await pay(3000);
    const originalTime = "2026-10-13T12:00:00Z";
    let sourceClockReads = 0;
    class ObservedDate extends Date {
      override getTime(): number { sourceClockReads += 1; return super.getTime(); }
    }
    const suppliedClock = new ObservedDate(originalTime);
    const before = await service.getApSummary({ now: new Date(originalTime) });
    const state = await summaryFinancialState();
    const barrier = createApSummaryReadBarrier(modulePool);
    const pending = service.getApSummary({ now: suppliedClock });
    try {
      await barrier.waitForRead(pending);
      suppliedClock.setTime(new Date("2027-03-13T12:00:00Z").getTime());
      barrier.resume();
      expect(await pending).toEqual(before);
      expect(barrier.snapshot).toMatchObject({ isolation: "repeatable read", readOnly: "on" });
      expect(barrier.readerReleaseCount).toBe(1);
      expect(suppliedClock.toISOString()).toBe("2027-03-13T12:00:00.000Z");
      expect(sourceClockReads).toBe(1);
      expect(await service.getApSummary({ now: new Date(originalTime) })).toEqual(before);
      expect(await summaryFinancialState()).toEqual(state);
    } finally { await barrier.close(pending); }
  });

  it.each([{ label: "invalid Date", clock: new Date(Number.NaN) }, { label: "non-Date", clock: "2026-10-13T12:00:00Z" }])("rejects a $label AP summary clock before attempting any database transport", async ({ clock }) => {
    const barrier = createApSummaryReadBarrier(modulePool);
    const pending = service.getApSummary({ now: clock as Date });
    try {
      await expect(pending).rejects.toMatchObject({
        statusCode: 500, details: { code: "AP_SUMMARY_CLOCK_INVALID" },
      });
      expect(barrier.transportAttempts).toEqual({ directQueries: 0, connections: 0 });
      expect(barrier.statements).toEqual([]);
      expect(barrier.readerReleaseCount).toBe(0);
    } finally { await barrier.close(pending); }
  });

  it("accepts a finite zero-epoch AP summary clock without replacing it with system time", async () => {
    const clock = new Date(0);
    const barrier = createApSummaryReadBarrier(modulePool);
    const pending = service.getApSummary({ now: clock });
    try {
      await barrier.waitForRead(pending);
      barrier.resume();
      expect(await pending).toMatchObject({ totalOutstandingCents: 10000, openInvoiceCount: 1,
        overdueCents: 0, dueSoonCents: 0, paidThisMonthCents: 0,
        agingBuckets: { current: 10000, days1_30: 0, days31_60: 0, days61_90: 0, days90plus: 0 } });
      expect(barrier.snapshot).toMatchObject({ isolation: "repeatable read", readOnly: "on" });
      expect(barrier.readerReleaseCount).toBe(1);
      expect(clock.getTime()).toBe(0);
    } finally { await barrier.close(pending); }
  });

  it("rolls back and releases an AP summary reader after a PostgreSQL read failure", async () => {
    const at = new Date("2026-10-13T12:00:00Z");
    const before = await service.getApSummary({ now: at });
    const state = await summaryFinancialState();
    const barrier = createApSummaryReadBarrier(modulePool, { failAfterRead: true });
    const pending = service.getApSummary({ now: at });
    try {
      await barrier.waitForRead(pending);
      barrier.resume();
      await expect(pending).rejects.toMatchObject({ code: "22012" });
      expect(barrier.snapshot).toMatchObject({ isolation: "repeatable read", readOnly: "on" });
      expect(barrier.statements.some(statement => /^rollback\b/i.test(statement))).toBe(true);
      expect(barrier.readerReleaseCount).toBe(1);
    } finally { await barrier.close(pending); }
    expect(await service.getApSummary({ now: at })).toEqual(before);
    expect(await summaryFinancialState()).toEqual(state);
    expect(pool.waitingCount).toBe(0);
  });

  it("rejects header reduction after payment and dispute without changing balances or adding mutation audit", async () => {
    await pay(8000); await invoiceCommand("dispute_invoice");
    await expect(service.updateInvoice(71, { invoicedAmountCents: 5000 }, actor)).rejects.toMatchObject(historyRejection);
    expect(await invoice()).toEqual({ status: "disputed", invoiced_amount_cents: "10000", paid_amount_cents: "8000", balance_cents: "2000" });
    expect((await pool.query("SELECT count(*)::int AS count FROM public.audit_events WHERE action='ap_ledger.invoice_updated'")).rows[0].count).toBe(0);
  });
  it("rejects removal of the last valid-mills line after payment and dispute", async () => {
    await pool.query("INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents) VALUES(72,71,1,1,10000,1000000,10000)");
    await pay(8000); await invoiceCommand("dispute_invoice");
    await expect(service.removeInvoiceLine(72, actor)).rejects.toMatchObject(historyRejection);
    expect((await pool.query("SELECT line_total_cents FROM procurement.vendor_invoice_lines WHERE id=72")).rows[0].line_total_cents).toBe("10000");
    expect((await invoice()).invoiced_amount_cents).toBe("10000");
  });
  it("approval evidence survives dispute and blocks every generic financial edit owner", async () => {
    await recognizedDispute(); await lineAndLinks();
    const operations = [
      () => service.updateInvoice(71, { notes: "rewrite" }, actor),
      () => service.addInvoiceLine(71, { qtyInvoiced: 1, unitCostMills: 10000 }, actor),
      () => service.updateInvoiceLine(72, { description: "rewrite" }, actor),
      () => service.removeInvoiceLine(72, actor),
      () => service.linkPoToInvoice(71, 10, undefined, undefined, actor),
      () => service.unlinkPoFromInvoice(71, 10, actor),
      () => service.importLinesFromPO(71, 10, actor),
      () => service.linkCostToInvoice(81, 71, actor),
      () => service.unlinkCostFromInvoice(81, actor),
    ];
    for (const operation of operations) await expect(operation()).rejects.toMatchObject(historyRejection);
    expect((await invoice()).invoiced_amount_cents).toBe("10000");
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.vendor_invoice_po_links")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT vendor_invoice_id FROM procurement.inbound_freight_costs WHERE id=81")).rows[0].vendor_invoice_id).toBe(71);
  });
  it("voided payment allocations still lock generic editing even without approval markers", async () => {
    const payment = await pay(8000);
    await db.transaction((tx: any) => service.executeApPaymentCommandInTransaction("void_payment", { now: new Date("2026-10-25T13:00:00.000Z"), paymentId: payment.id, reason: "Synthetic reversal", userId: actor }, tx));
    await invoiceCommand("dispute_invoice");
    expect((await invoice()).paid_amount_cents).toBe("0");
    await expect(service.updateInvoice(71, { invoicedAmountCents: 5000 }, actor)).rejects.toMatchObject(historyRejection);
    expect(await service.getInvoiceById(71)).toMatchObject({ capabilities: { edit: { allowed: false, code: "AP_INVOICE_FINANCIAL_HISTORY" } }, paymentReviewRequired: false,
      payments: [expect.objectContaining({ paymentStatus: "voided" })] });
  });
  it("unrecognized invoices remain editable before and after dispute", async () => {
    await unrecognized();
    expect(await service.getInvoiceById(71)).toMatchObject({ capabilities: { edit: { allowed: true, code: "AP_INVOICE_EDITABLE" } } });
    await service.updateInvoice(71, { invoicedAmountCents: 9000 }, actor);
    await invoiceCommand("dispute_invoice");
    await service.updateInvoice(71, { invoicedAmountCents: 8000 }, actor);
    expect(await invoice()).toMatchObject({ status: "disputed", invoiced_amount_cents: "8000", balance_cents: "8000" });
  });
  it("keeps disputed debt in outstanding, overdue, aging and explicit dispute totals", async () => {
    await pay(3000); await invoiceCommand("dispute_invoice");
    const summary = await service.getApSummary({ now: new Date("2026-10-13T12:00:00Z") });
    expect(summary).toMatchObject({ totalOutstandingCents: 7000, openInvoiceCount: 1, overdueCents: 7000, disputedOutstandingCents: 7000, disputedInvoiceCount: 1 });
    expect(summary.vendorAging[0].total).toBe(7000);
    expect(summary.agingBuckets.days31_60).toBe(7000);
  });
  it("serializes payment, dispute and generic edit without erasing the obligation", async () => {
    await unrecognized(); await invoiceCommand("approve_invoice");
    const outcomes = await Promise.allSettled([pay(8000), invoiceCommand("dispute_invoice"), service.updateInvoice(71, { invoicedAmountCents: 5000 }, actor)]);
    // Losing the payment/dispute race is valid only for the domain rejection;
    // schema/authority failures must not masquerade as a safe concurrent result.
    if (outcomes[0].status === "rejected") expect(outcomes[0].reason).toMatchObject({
      statusCode: 409, details: { code: "AP_PAYMENT_ALLOCATION_INVOICE_NOT_PAYABLE" },
    });
    expect(outcomes[1].status).toBe("fulfilled");
    expect(outcomes[2].status).toBe("rejected");
    const current = await invoice();
    expect(current.status).toBe("disputed");
    expect(current.invoiced_amount_cents).toBe("10000");
    const paid = (await pool.query("SELECT COALESCE(sum(a.applied_amount_cents),0)::text AS total FROM procurement.ap_payment_allocations a JOIN procurement.ap_payments p ON p.id=a.ap_payment_id WHERE p.status='completed'")).rows[0].total;
    expect(current.paid_amount_cents).toBe(paid);
    expect(BigInt(current.balance_cents)).toBe(BigInt(10000) - BigInt(paid));
  });
  it("actual NOT VALID constraint preserves legacy records while blocking new unsupported states", async () => {
    await pool.query("ALTER TABLE procurement.ap_payments DROP CONSTRAINT ap_payments_recorded_status_check");
    await pool.query(`INSERT INTO procurement.ap_payments(id,payment_number,vendor_id,payment_date,payment_method,total_amount_cents,status) VALUES(90,'LEGACY',5,'2026-10-01','ach',2000,'scheduled');
      INSERT INTO procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id,applied_amount_cents) VALUES(90,71,2000);
      UPDATE procurement.vendor_invoices SET paid_amount_cents=2000,balance_cents=8000,status='partially_paid' WHERE id=71`);
    await pool.query(readFileSync("migrations/900000001000017780001_ap_payment_completed_status_guard.sql", "utf8"));
    await expect(pool.query("INSERT INTO procurement.ap_payments(payment_number,vendor_id,payment_date,payment_method,total_amount_cents,status) VALUES('BAD',5,'2026-10-01','ach',1,'returned')")).rejects.toMatchObject({ code: "23514" });
    await expect(pay(1000)).rejects.toMatchObject({ details: { code: "AP_PAYMENT_STATUS_REVIEW_REQUIRED" } });
    await expect(service.voidPayment(90, "Synthetic change", actor)).rejects.toMatchObject({ details: { code: "AP_PAYMENT_STATUS_REVIEW_REQUIRED" } });
    expect(await invoice()).toMatchObject({ paid_amount_cents: "2000", balance_cents: "8000" });
    expect((await pool.query("SELECT status FROM procurement.ap_payments WHERE id=90")).rows[0].status).toBe("scheduled");
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.ap_payments")).rows[0].count).toBe(1);
    expect(await service.getInvoiceById(71)).toMatchObject({ capabilities: { edit: { allowed: false } }, paymentReviewRequired: true,
      payments: [expect.objectContaining({ paymentStatus: "scheduled" })] });
    await pool.query(`INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,total_cents) VALUES(10,'PO-LEGACY',5,'received',10000);
      INSERT INTO procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id) VALUES(71,10)`);
    expect(await service.getPaymentsForPo(10)).toEqual([]);
  });
});
