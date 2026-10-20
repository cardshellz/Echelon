import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supplierCreditCommandResultSchema, supplierCreditDetailSchema, supplierCreditOptionsSchema, supplierCreditListSchema,
  type SupplierCreditCreateInput, type SupplierCreditDetail } from "@shared/procurement/supplier-credit";
import { PaymentAcceptanceFixture, PAYMENT_ACTORS, PAYMENT_FLOW, flowPayment,
  type PaymentHttpResult } from "./payment-controlled-acceptance.fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const databaseTests = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const migrationPath = "docs/procurement/supplier-credit-completion.pending.sql";

// Real HTTP + current PostgreSQL RBAC + command owner + migrations. Existing lots
// intentionally lack immutable receipt origins: credit settlement must work while
// their cost effect remains review-required, never manufacture posted cost proof.
databaseTests.sequential("supplier credit financial ownership and recovery", () => {
  const fixture = new PaymentAcceptanceFixture(migrationPath);
  beforeAll(() => fixture.start(url!));
  beforeEach(async () => {
    await fixture.reset();
    await fixture.pool.query(`UPDATE procurement.vendor_invoice_lines SET cost_component_evidence=
      '{"contractVersion":1,"packagingTreatment":"separate","productMills":20000000,"packagingMills":1000000,"adjustmentMills":0,"source":"operator_review"}'::jsonb`);
  });
  afterAll(() => fixture.stop());

  async function options(invoiceId: number = PAYMENT_FLOW.invoiceA) {
    const reply = await fixture.request(`/api/vendor-invoices/${invoiceId}/supplier-credit-options`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return supplierCreditOptionsSchema.parse(reply.body);
  }
  async function draftBody(cents = 10_000, reference = `CREDIT-${randomUUID()}`): Promise<SupplierCreditCreateInput> {
    const source = await options();
    return { sourceInvoiceId: source.sourceInvoiceId, expectedSourceVersion: source.sourceVersion,
      supplierReference: reference, creditCalendarDate: "2026-10-01", reason: "Supplier issued a documented price reduction",
      lines: [{ invoiceLineId: source.lines[0].invoiceLineId, amountCents: cents,
        disposition: { kind: "price_reduction", component: "product" } }] };
  }
  function result(reply: PaymentHttpResult) {
    expect([200, 201], JSON.stringify(reply.body)).toContain(reply.status);
    return supplierCreditCommandResultSchema.parse(reply.body);
  }
  async function detail(id: number): Promise<SupplierCreditDetail> {
    const reply = await fixture.request(`/api/supplier-credits/${id}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return supplierCreditDetailSchema.parse(reply.body);
  }
  async function create(cents = 10_000) {
    return result(await fixture.request("/api/supplier-credits", { key: randomUUID(), body: await draftBody(cents) })).credit;
  }
  async function approve(credit: SupplierCreditDetail) {
    return result(await fixture.request(`/api/supplier-credits/${credit.id}/approve`, { key: randomUUID(),
      body: { expectedVersion: credit.version, reason: "Verified original supplier credit and invoice" } })).credit;
  }
  async function approved(cents = 10_000) { return approve(await create(cents)); }
  function apply(credit: SupplierCreditDetail, cents: number, invoiceId: number = PAYMENT_FLOW.invoiceA, key = randomUUID()) {
    return fixture.request(`/api/supplier-credits/${credit.id}/applications`, { key, body: {
      expectedVersion: credit.version, reason: "Apply supplier credit to this payable",
      allocations: [{ vendorInvoiceId: invoiceId, appliedAmountCents: cents }],
    } });
  }
  async function creditGraph() {
    const records = await Promise.all(["supplier_credits", "supplier_credit_lines", "supplier_credit_applications",
      "supplier_credit_application_reversals"].map(table => fixture.pool.query(`SELECT * FROM procurement.${table} ORDER BY id`)));
    return { financial: await fixture.graph(), credits: records.map(record => record.rows) };
  }
  async function expectSettlement(paid: number, credited: number, balance: number, invoiceId: number = PAYMENT_FLOW.invoiceA) {
    const invoice = await fixture.request(`/api/vendor-invoices/${invoiceId}`);
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(200);
    expect(invoice.body).toMatchObject({ invoicedAmountCents: PAYMENT_FLOW.invoiceCents,
      paidAmountCents: paid, creditedAmountCents: credited, balanceCents: balance });
    const { db } = await import("../../../../db");
    const { createPoFinancialEvidenceService } = await import("../../po-financial-evidence.service");
    const poId = invoiceId === PAYMENT_FLOW.invoiceA ? PAYMENT_FLOW.poA : PAYMENT_FLOW.poB;
    expect(await createPoFinancialEvidenceService(db).readWorkflow(poId)).toMatchObject({
      state: balance === 0 ? "settled" : "payment_due", evidence: { state: "complete", invoicedAmountCents: PAYMENT_FLOW.invoiceCents,
        paidAmountCents: paid, creditedAmountCents: credited, outstandingAmountCents: balance, reviewReasons: [] },
    });
  }

  it("records a dated supplier document separately from cash and preserves unsupported inventory history", async () => {
    const before = await fixture.graph();
    const draft = await create();
    expect(draft).toMatchObject({ status: "draft", currency: "USD", totalAmountCents: 10_000, creditCalendarDate: "2026-10-01" });
    const credit = await approve(draft);
    expect(credit).toMatchObject({ status: "approved", appliedAmountCents: 0, unappliedAmountCents: 10_000,
      costStatus: "review_required" });
    expect(credit.costIssues.length).toBeGreaterThan(0);
    await expectSettlement(0, 0, 210_000);
    const after = await fixture.graph();
    expect(after.payments).toEqual(before.payments);
    expect(after.allocations).toEqual(before.allocations);
    expect(after.invoiceLines).toEqual(before.invoiceLines);
    expect(after.inventory).toEqual(before.inventory);
  });

  it("combines credit and cash settlement without relabelling credit as money paid", async () => {
    const credit = await approved(10_000);
    result(await apply(credit, 10_000));
    await expectSettlement(0, 10_000, 200_000);
    expect((await fixture.graph()).purchaseOrders[0].first_paid_at).toBeNull();
    expect(await fixture.request("/api/ap-payments", { key: randomUUID(), body: flowPayment(200_000) })).toMatchObject({ status: 201 });
    await expectSettlement(200_000, 10_000, 0);
    expect((await fixture.graph()).payments.map(row => row.total_amount_cents)).toEqual(["200000"]);
    expect((await detail(credit.id)).unappliedAmountCents).toBe(0);
  });

  it("can apply a supplier credit to another payable of the same supplier while retaining its original source", async () => {
    const credit = await approved();
    const applied = result(await apply(credit, 4_000, PAYMENT_FLOW.invoiceB));
    expect(applied.credit).toMatchObject({ sourceInvoiceId: 71, appliedAmountCents: 4_000, unappliedAmountCents: 6_000 });
    for (const invoiceId of [PAYMENT_FLOW.invoiceA, PAYMENT_FLOW.invoiceB]) {
      const invoice = await fixture.request(`/api/vendor-invoices/${invoiceId}`);
      expect(invoice.body).toMatchObject({ hasSupplierCreditHistory: true });
      const linked = await fixture.request(`/api/supplier-credits?invoiceId=${invoiceId}`);
      expect(linked.status, JSON.stringify(linked.body)).toBe(200);
      expect(supplierCreditListSchema.parse(linked.body).items.map(row => row.id)).toContain(credit.id);
    }
    await expectSettlement(0, 0, 210_000);
    await expectSettlement(0, 4_000, 206_000, PAYMENT_FLOW.invoiceB);
  });

  it("reverses an application explicitly, then voids by compensation while retaining original rows", async () => {
    let credit = result(await apply(await approved(), 10_000)).credit;
    const before = await creditGraph();
    const blocked = await fixture.request(`/api/supplier-credits/${credit.id}/void`, { key: randomUUID(),
      body: { expectedVersion: credit.version, reason: "Supplier withdrew this credit document" } });
    expect(blocked.status).toBe(409);
    expect(await creditGraph()).toEqual(before);
    const applicationId = credit.applications[0].id;
    credit = result(await fixture.request(`/api/supplier-credits/${credit.id}/applications/${applicationId}/reverse`, { key: randomUUID(),
      body: { expectedVersion: credit.version, reason: "Remove this application before voiding" } })).credit;
    await expectSettlement(0, 0, 210_000);
    expect(credit.applications[0]).toMatchObject({ id: applicationId, appliedAmountCents: 10_000, reversal: { reason: "Remove this application before voiding" } });
    const voided = result(await fixture.request(`/api/supplier-credits/${credit.id}/void`, { key: randomUUID(),
      body: { expectedVersion: credit.version, reason: "Supplier withdrew this credit document" } })).credit;
    expect(voided.status).toBe("voided");
    expect((await fixture.pool.query("SELECT count(*)::int AS count FROM procurement.supplier_credit_applications")).rows[0].count).toBe(1);
    expect((await fixture.pool.query("SELECT count(*)::int AS count FROM procurement.supplier_credit_application_reversals")).rows[0].count).toBe(1);
    expect((await fixture.graph()).payments).toEqual([]);
  });

  it("supports product and packaging reductions from one original invoice row in the same supplier document", async () => {
    const body = await draftBody(1_000);
    body.lines.push({ invoiceLineId: body.lines[0].invoiceLineId, amountCents: 500,
      disposition: { kind: "price_reduction", component: "packaging" } });
    const draft = result(await fixture.request("/api/supplier-credits", { key: randomUUID(), body })).credit;
    expect((await approve(draft)).totalAmountCents).toBe(1_500);
  });

  it("deduplicates a supplier reference even with a fresh command key", async () => {
    const body = await draftBody();
    result(await fixture.request("/api/supplier-credits", { key: randomUUID(), body }));
    const before = await creditGraph();
    const response = await fixture.request("/api/supplier-credits", { key: randomUUID(), body });
    expect(response.status).toBe(409);
    expect(await creditGraph()).toEqual(before);
  });

  it("recovers the exact committed response after acknowledgement loss and refuses changed requests or actors under its key", async () => {
    const body = await draftBody(), key = randomUUID();
    const first = await fixture.request("/api/supplier-credits", { key, body });
    result(first);
    const before = await creditGraph();
    expect(await fixture.request("/api/supplier-credits", { key, body })).toEqual({ ...first, replayed: "true" });
    expect((await fixture.request("/api/supplier-credits", { key, body: { ...body, reason: "Different reviewed reason" } })).status).toBe(422);
    expect((await fixture.request("/api/supplier-credits", { key, body, actor: PAYMENT_ACTORS.delegate })).status).toBe(422);
    expect(await creditGraph()).toEqual(before);
  });

  it("serializes competing applications of the same credit version", async () => {
    const credit = await approved();
    const replies = await Promise.all([apply(credit, 7_000), apply(credit, 7_000, PAYMENT_FLOW.invoiceB)]);
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 409]);
    expect((await detail(credit.id)).appliedAmountCents).toBe(7_000);
    expect((await fixture.pool.query("SELECT count(*)::int AS count FROM procurement.supplier_credit_applications")).rows[0].count).toBe(1);
  });

  it("serializes cash and credit competing for the last payable cents", async () => {
    const credit = await approved(10_000);
    expect(await fixture.request("/api/ap-payments", { key: randomUUID(), body: flowPayment(200_000) })).toMatchObject({ status: 201 });
    const replies = await Promise.all([apply(credit, 10_000), fixture.request("/api/ap-payments", { key: randomUUID(), body: flowPayment(10_000) })]);
    expect(replies.filter(reply => reply.status < 300)).toHaveLength(1);
    expect(replies.filter(reply => reply.status === 409)).toHaveLength(1);
    const invoice = (await fixture.request(`/api/vendor-invoices/${PAYMENT_FLOW.invoiceA}`)).body;
    expect(invoice.balanceCents).toBe(0);
    expect(Number(invoice.paidAmountCents) + Number(invoice.creditedAmountCents)).toBe(210_000);
  });

  it("rejects overapplication and leaves both cash and credit history unchanged", async () => {
    const credit = await approved();
    const before = await creditGraph();
    expect((await apply(credit, 10_001)).status).toBe(409);
    expect(await creditGraph()).toEqual(before);
  });

  it("rejects a different supplier's target invoice without partial applications", async () => {
    const credit = await approved();
    await fixture.pool.query("INSERT INTO procurement.vendor_invoices(id,vendor_id,invoice_number,status,currency,invoiced_amount_cents,balance_cents) VALUES(73,6,'OTHER-SUPPLIER','approved','USD',10000,10000)");
    const before = await creditGraph();
    const response = await fixture.request(`/api/supplier-credits/${credit.id}/applications`, { key: randomUUID(), body: {
      expectedVersion: credit.version, reason: "Reject mixed vendor application", allocations: [
        { vendorInvoiceId: 71, appliedAmountCents: 5_000 }, { vendorInvoiceId: 73, appliedAmountCents: 5_000 }],
    } });
    expect(response.status).toBe(409);
    expect(await creditGraph()).toEqual(before);
  });

  it.each([0, -1, 0.1, Number.MAX_SAFE_INTEGER + 1])("rejects invalid credit amount %s at the boundary", async amountCents => {
    const body = await draftBody(); body.lines[0].amountCents = amountCents;
    const before = await creditGraph();
    expect((await fixture.request("/api/supplier-credits", { key: randomUUID(), body })).status).toBe(422);
    expect(await creditGraph()).toEqual(before);
  });

  it("rejects a stale source version without inventing a revised supplier document", async () => {
    const body = await draftBody(); body.expectedSourceVersion = "0".repeat(64);
    const before = await creditGraph();
    expect((await fixture.request("/api/supplier-credits", { key: randomUUID(), body })).status).toBe(409);
    expect(await creditGraph()).toEqual(before);
  });

  it("requires current permission after a command waits for the financial lock", async () => {
    const credit = await create(), blocker = await fixture.pool.connect();
    const before = await creditGraph();
    let pending: ReturnType<typeof fixture.request> | undefined;
    try {
      await blocker.query("BEGIN; SELECT pg_advisory_xact_lock(hashtext('inventory.cost_graph'),hashtext('version_1'))");
      pending = fixture.request(`/api/supplier-credits/${credit.id}/approve`, { key: randomUUID(), actor: PAYMENT_ACTORS.delegate,
        body: { expectedVersion: credit.version, reason: "Permission is revoked while command waits" } });
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const rows = await fixture.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid()) AS waiting");
        if (rows.rows[0].waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await fixture.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=2 AND permission_id=2");
      await blocker.query("COMMIT");
      expect((await pending).status).toBe(403);
      expect(await creditGraph()).toEqual(before);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
  });

  it("blocks cash overpayment at the PostgreSQL boundary after credit is applied", async () => {
    result(await apply(await approved(10_000), 10_000));
    const payment = await fixture.request("/api/ap-payments", { key: randomUUID(), body: { ...flowPayment(210_000), allocations: [] } });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    await expect(fixture.pool.query("INSERT INTO procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id,applied_amount_cents) VALUES($1,71,210000)", [payment.body.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expectSettlement(0, 10_000, 200_000);
  });

  it("preserves credit document and application audit history at the database boundary", async () => {
    const credit = result(await apply(await approved(), 10_000)).credit;
    for (const statement of [
      "UPDATE procurement.supplier_credit_lines SET amount_cents=1",
      "UPDATE procurement.vendor_invoice_lines SET qty_invoiced=999 WHERE vendor_invoice_id=71",
      "DELETE FROM procurement.vendor_invoice_lines WHERE vendor_invoice_id=71",
      "DELETE FROM procurement.supplier_credit_applications",
      "UPDATE procurement.supplier_credits SET supplier_reference='changed'",
      "TRUNCATE procurement.supplier_credit_applications CASCADE",
    ]) await expect(fixture.pool.query(statement)).rejects.toMatchObject({ code: "23514" });
    expect((await detail(credit.id)).totalAmountCents).toBe(10_000);
  });

  it("replaces a voided mistaken document explicitly and retains both source documents", async () => {
    const body = await draftBody(10_000, "SUPPLIER-CREDIT-CORRECTION");
    const original = result(await fixture.request("/api/supplier-credits", { key: randomUUID(), body })).credit;
    const voided = result(await fixture.request(`/api/supplier-credits/${original.id}/void`, {
      key: randomUUID(), body: { expectedVersion: original.version, reason: "Correct the amount entered from the supplier document" },
    })).credit;
    expect(voided.capabilities.replace.allowed).toBe(true);
    expect(voided).toMatchObject({ costStatus: "not_applicable", costIssues: [], lines: [{ costState: "not_applicable", costIssues: [] }] });
    expect((await fixture.request("/api/supplier-credits", { key: randomUUID(), body })).status).toBe(409);
    const replacementBody = { ...await draftBody(8_000, body.supplierReference), replacesCreditId: original.id };
    const replacement = result(await fixture.request("/api/supplier-credits", { key: randomUUID(), body: replacementBody })).credit;
    expect(replacement).toMatchObject({ replacesCreditId: original.id, totalAmountCents: 8_000, status: "draft" });
    expect(await detail(original.id)).toMatchObject({ status: "voided", totalAmountCents: 10_000, replacedByCreditId: replacement.id,
      capabilities: { replace: { allowed: false } } });
    expect((await fixture.request("/api/supplier-credits", { key: randomUUID(), body: replacementBody })).status).toBe(409);
    expect((await approve(replacement)).totalAmountCents).toBe(8_000);
    expect((await fixture.pool.query("SELECT count(*)::int AS count FROM procurement.supplier_credits")).rows[0].count).toBe(2);
  });

  it("rolls back a late audit failure and safely retries the same financial command", async () => {
    const credit = await approved();
    const before = await creditGraph(), key = randomUUID();
    await fixture.pool.query(`CREATE FUNCTION public.reject_credit_acceptance_audit() RETURNS trigger LANGUAGE plpgsql AS $guard$
      BEGIN
        IF NEW.action = 'ap_ledger.supplier_credit.apply' THEN RAISE EXCEPTION 'Synthetic late audit failure'; END IF;
        RETURN NEW;
      END $guard$;
      CREATE TRIGGER reject_credit_acceptance_audit BEFORE INSERT ON public.audit_events
      FOR EACH ROW EXECUTE FUNCTION public.reject_credit_acceptance_audit()`);
    try {
      expect((await apply(credit, 10_000, PAYMENT_FLOW.invoiceA, key)).status).toBe(500);
      expect(await creditGraph()).toEqual(before);
    } finally {
      await fixture.pool.query("DROP TRIGGER reject_credit_acceptance_audit ON public.audit_events; DROP FUNCTION public.reject_credit_acceptance_audit()");
    }
    const deadline = Date.now() + 6_000;
    let retry = await apply(credit, 10_000, PAYMENT_FLOW.invoiceA, key);
    while (retry.status === 409 && retry.body.details?.code === "FINANCIAL_COMMAND_IN_PROGRESS" && Date.now() < deadline) {
      const seconds = Number((retry.body.details as { retryAfterSeconds?: number }).retryAfterSeconds);
      expect(Number.isInteger(seconds) && seconds > 0 && seconds <= 3).toBe(true);
      await new Promise(resolve => setTimeout(resolve, seconds * 1_000));
      retry = await apply(credit, 10_000, PAYMENT_FLOW.invoiceA, key);
    }
    result(retry);
    await expectSettlement(0, 10_000, 200_000);
    expect((await detail(credit.id)).applications).toHaveLength(1);
  });

  it("keeps original invoice economics protected after a credit is voided", async () => {
    const credit = await approved();
    const voided = result(await fixture.request(`/api/supplier-credits/${credit.id}/void`, { key: randomUUID(),
      body: { expectedVersion: credit.version, reason: "Supplier withdrew this credit document" } })).credit;
    expect(voided.status).toBe("voided");
    await expect(fixture.pool.query("UPDATE procurement.vendor_invoices SET invoiced_amount_cents=200000 WHERE id=71"))
      .rejects.toMatchObject({ code: "23514" });
    const { db } = await import("../../../../db");
    const { createInvoiceQuantityCorrectionService } = await import("../../invoice-quantity-correction.service");
    await fixture.pool.query("INSERT INTO inventory.warehouse_settings(warehouse_code,require_approval) VALUES('DEFAULT',false)");
    const direct = await createInvoiceQuantityCorrectionService(db, () => new Date("2026-10-19T12:00:00Z")).context(1, PAYMENT_ACTORS.owner);
    expect(direct).toMatchObject({ canApprove: false, blockedReason: expect.stringContaining("credit") });
    const context = await fixture.request("/api/vendor-invoice-lines/1/quantity-correction");
    expect(context.status, JSON.stringify(context.body)).toBe(200);
    expect(context.body).toMatchObject({ canApprove: false, blockedReason: expect.stringContaining("credit") });
    await expectSettlement(0, 0, 210_000);
  });

  it("rejects forged approval history and preserves harmless invoice display metadata", async () => {
    const credit = await create();
    await expect(fixture.pool.query("UPDATE procurement.supplier_credits SET approved_by=$1,approved_at=now(),version=version+1 WHERE id=$2",
      [PAYMENT_ACTORS.owner, credit.id])).rejects.toMatchObject({ code: "23514" });
    await expect(fixture.pool.query(`INSERT INTO procurement.supplier_credits(source_invoice_id,vendor_id,source_snapshot,
      supplier_reference,credit_calendar_date,total_amount_cents,currency,status,version,reason,created_by,created_at,approved_by,approved_at)
      SELECT source_invoice_id,vendor_id,source_snapshot,'FORGED-APPROVAL',credit_calendar_date,total_amount_cents,currency,
        'draft',1,reason,created_by,created_at,created_by,now() FROM procurement.supplier_credits WHERE id=$1`, [credit.id]))
      .rejects.toMatchObject({ code: "23514" });
    await fixture.pool.query("UPDATE procurement.vendor_invoice_lines SET description='Corrected supplier display label' WHERE vendor_invoice_id=71");
    expect((await approve(await detail(credit.id))).status).toBe("approved");
  });

  it("uses database permissions even when a view-only session claims an admin role", async () => {
    const body = await draftBody();
    const before = await creditGraph();
    expect((await fixture.request("/api/supplier-credits", { key: randomUUID(), body, actor: PAYMENT_ACTORS.viewer })).status).toBe(403);
    expect(await creditGraph()).toEqual(before);
    const credit = await create();
    const created = await creditGraph();
    expect((await fixture.request(`/api/supplier-credits/${credit.id}/approve`, { key: randomUUID(), actor: PAYMENT_ACTORS.viewer,
      body: { expectedVersion: credit.version, reason: "Read-only actor cannot approve" } })).status).toBe(403);
    expect(await creditGraph()).toEqual(created);
  });

  it("reapplies its migration without rewriting financial or cost history", async () => {
    const credit = result(await apply(await approved(), 10_000)).credit;
    const before = await creditGraph();
    await fixture.pool.query(readFileSync(migrationPath, "utf8"));
    expect(await creditGraph()).toEqual(before);
    expect((await detail(credit.id)).appliedAmountCents).toBe(10_000);
  });
});
