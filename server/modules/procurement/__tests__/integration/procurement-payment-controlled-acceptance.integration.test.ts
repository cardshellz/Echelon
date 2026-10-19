import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import type { PaymentBalance } from "@shared/procurement/ap-payment-contract";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PaymentAcceptanceFixture, PAYMENT_ACTORS, PAYMENT_FLOW, flowPayment,
  type PaymentHttpResult,
} from "./payment-controlled-acceptance.fixture";

const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const enabled = !!testUrl && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const acceptance = enabled ? describe : describe.skip;

// C06/C08/F02/F03: real AP HTTP + RBAC + commands + PostgreSQL. Invoice approval,
// receipt/putaway and original COGS are seeded prerequisites in this bounded
// suite; the companion FLOW suite exercises those owning services separately.
acceptance.sequential("procurement payment controlled acceptance", () => {
  const fixture = new PaymentAcceptanceFixture();

  beforeAll(async () => fixture.start(testUrl!));
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.stop());

  const pay = (amount: number, key = randomUUID(), actor: string | null = PAYMENT_ACTORS.owner) =>
    fixture.request("/api/ap-payments", { body: flowPayment(amount), key, actor });

  async function command(key: string) {
    const result = await fixture.pool.query("SELECT * FROM public.financial_command_results WHERE idempotency_key=$1", [key]);
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  }

  function paymentId(result: PaymentHttpResult): number {
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(Number.isSafeInteger(result.body.id)).toBe(true);
    return result.body.id!;
  }

  async function expectBalances(paid: number, balance: number, invoiceStatus: string, poStatus: string) {
    const invoice = await fixture.request(`/api/vendor-invoices/${PAYMENT_FLOW.invoiceA}`);
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(200);
    expect(invoice.body).toMatchObject({ id: PAYMENT_FLOW.invoiceA,
      invoicedAmountCents: PAYMENT_FLOW.invoiceCents, paidAmountCents: paid, balanceCents: balance, status: invoiceStatus });
    const graph = await fixture.graph();
    expect(graph.purchaseOrders[0]).toMatchObject({ id: PAYMENT_FLOW.poA, invoiced_total_cents: "210000",
      paid_total_cents: String(paid), outstanding_cents: String(balance), financial_status: poStatus,
      status: "received", physical_status: "received" });
    expect(graph.invoices[0]).toMatchObject({ id: PAYMENT_FLOW.invoiceA,
      paid_amount_cents: String(paid), balance_cents: String(balance), status: invoiceStatus });
    // Cached invoice/PO balances alone cannot prove agreement with PO screens.
    const { db } = await import("../../../../db");
    const { createPoFinancialEvidenceService } = await import("../../po-financial-evidence.service");
    expect(await createPoFinancialEvidenceService(db).readWorkflow(PAYMENT_FLOW.poA)).toMatchObject({
      state: balance === 0 ? "settled" : "payment_due",
      evidence: { state: "complete", invoicedAmountCents: PAYMENT_FLOW.invoiceCents,
        paidAmountCents: paid, outstandingAmountCents: balance, reviewReasons: [] },
    });
  }

  async function advance(total: number, allocated = 0): Promise<number> {
    return paymentId(await fixture.request("/api/ap-payments", { key: randomUUID(), body: {
      ...flowPayment(total), paymentDate: "2026-10-01",
      allocations: allocated ? [{ vendorInvoiceId: PAYMENT_FLOW.invoiceA, appliedAmountCents: allocated }] : [],
    } }));
  }

  async function balance(id: number): Promise<PaymentBalance> {
    const response = await fixture.request<{ paymentBalance: PaymentBalance }>(`/api/ap-payments/${id}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.paymentBalance;
  }

  function apply(id: number, version: string, cents: number, key = randomUUID(), invoiceId: number = PAYMENT_FLOW.invoiceA) {
    return fixture.request(`/api/ap-payments/${id}/applications`, { key, body: {
      expectedVersion: version, reason: "Apply previously recorded supplier advance",
      allocations: [{ vendorInvoiceId: invoiceId, appliedAmountCents: cents }],
    } });
  }

  it("reads an ordinary product invoice with explicit replacement ineligibility without changing the financial graph", async () => {
    const before = await fixture.graph();
    const invoice = await fixture.request(`/api/vendor-invoices/${PAYMENT_FLOW.invoiceA}`);
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(200);
    expect(invoice.body).toMatchObject({
      id: PAYMENT_FLOW.invoiceA, status: "approved", inboundShipmentId: null,
      invoicedAmountCents: PAYMENT_FLOW.invoiceCents, paidAmountCents: 0, balanceCents: PAYMENT_FLOW.invoiceCents,
      replacementCapability: { allowed: false, code: "AP_INVOICE_REPLACEMENT_NOT_VOIDED", successorInvoiceId: null },
      replacementHistory: [{ id: PAYMENT_FLOW.invoiceA, status: "approved", replacesInvoiceId: null }],
    });
    expect(await fixture.graph()).toEqual(before);
  });

  it("records partial and final FLOW payments with matching invoice, ledger and PO balances while preserving costs and physical receipt state", async () => {
    const before = await fixture.graph();
    const first = await pay(100_000);
    const firstId = paymentId(first);
    expect(first.replayed).toBe("false");
    await expectBalances(100_000, 110_000, "partially_paid", "partially_paid");
    const partial = await fixture.graph();
    expect(partial.purchaseOrders[0].first_paid_at).toBeInstanceOf(Date);
    expect(partial.purchaseOrders[0].fully_paid_at).toBeNull();

    const finalId = paymentId(await pay(110_000));
    expect(finalId).not.toBe(firstId);
    await expectBalances(210_000, 0, "paid", "paid");
    const final = await fixture.graph();
    expect(final.inventory).toEqual(before.inventory);
    expect(final.invoiceLines).toEqual(before.invoiceLines);
    expect(final.invoiceLinks).toEqual(before.invoiceLinks);
    expect(final.purchaseOrders[1]).toEqual(before.purchaseOrders[1]);
    expect(final.invoices[1]).toEqual(before.invoices[1]);
    expect(final.purchaseOrders[0].first_paid_at).toEqual(partial.purchaseOrders[0].first_paid_at);
    expect(final.purchaseOrders[0].fully_paid_at).toBeInstanceOf(Date);
    expect(final.allocations.map((row) => row.applied_amount_cents)).toEqual(["100000", "110000"]);
    expect(final.history).toEqual([
      expect.objectContaining({ changed_by: PAYMENT_ACTORS.owner, from_status: "received", to_status: "received",
        notes: expect.stringContaining("invoiced -> partially_paid") }),
      expect.objectContaining({ changed_by: PAYMENT_ACTORS.owner, from_status: "received", to_status: "received",
        notes: expect.stringContaining("partially_paid -> paid") }),
    ]);
    expect(final.audits).toHaveLength(2);
    expect(final.audits).toEqual(expect.arrayContaining([expect.objectContaining({ actor: PAYMENT_ACTORS.owner,
      action: "ap_ledger.record_payment", target: `payment:${firstId}`,
      context: expect.objectContaining({ affectedInvoiceIds: [PAYMENT_FLOW.invoiceA], affectedPurchaseOrderIds: [PAYMENT_FLOW.poA] }) })]));
    const ledger = await fixture.request<{ payments: Array<{ id: number; totalAmountCents: number }> }>("/api/ap-payments");
    expect(ledger.status).toBe(200);
    expect(ledger.body.payments.map((payment) => payment.totalAmountCents).sort((a, b) => a - b)).toEqual([100_000, 110_000]);
    const detail = await fixture.request(`/api/ap-payments/${firstId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: firstId, totalAmountCents: 100_000, status: "completed",
      allocations: [expect.objectContaining({ vendorInvoiceId: PAYMENT_FLOW.invoiceA, appliedAmountCents: 100_000, balanceCents: 0 })] });
  });

  it("rejects a one-cent overpayment without any financial graph change and replays that exact rejection", async () => {
    paymentId(await pay(100_000));
    const before = await fixture.graph();
    const key = randomUUID();
    const rejected = await pay(110_001, key);
    expect(rejected).toMatchObject({ status: 409, replayed: "false", body: { details: { code: "AP_PAYMENT_ALLOCATION_EXCEEDS_BALANCE" } } });
    expect(await fixture.graph()).toEqual(before);
    const replay = await pay(110_001, key);
    expect(replay).toEqual({ ...rejected, replayed: "true" });
    expect(await fixture.graph()).toEqual(before);
    expect(await command(key)).toMatchObject({ status: "rejected", http_status: 409, attempt_count: 1,
      last_error_code: "AP_PAYMENT_ALLOCATION_EXCEEDS_BALANCE", response_body: rejected.body });
    paymentId(await pay(110_000));
    await expectBalances(210_000, 0, "paid", "paid");
  });

  it("replays the original committed response after a lost acknowledgement and rejects a changed payload under its key", async () => {
    const key = randomUUID();
    const first = await pay(100_000, key);
    const id = paymentId(first);
    const committed = await fixture.graph();
    expect(await pay(100_000, key)).toEqual({ ...first, replayed: "true" });
    expect(await fixture.graph()).toEqual(committed);
    expect(await pay(100_001, key)).toMatchObject({ status: 422,
      body: { details: { code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" } } });
    expect(await fixture.graph()).toEqual(committed);
    expect(await command(key)).toMatchObject({ status: "succeeded", attempt_count: 1, http_status: 201,
      result_type: "ap_payment", result_id: String(id), response_body: first.body });
    await expect(fixture.pool.query("UPDATE public.financial_command_results SET response_body='{}'::jsonb WHERE idempotency_key=$1", [key]))
      .rejects.toMatchObject({ code: "23514" });
    expect((await command(key)).response_body).toEqual(first.body);
  });

  it("serializes concurrent distinct payments against the same balance so only one can consume the available cents", async () => {
    const before = await fixture.inventoryEvidence();
    const keys = [randomUUID(), randomUUID()];
    const responses = await Promise.all(keys.map((key) => pay(120_000, key)));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body).toMatchObject({ details: { code: "AP_PAYMENT_ALLOCATION_EXCEEDS_BALANCE" } });
    await expectBalances(120_000, 90_000, "partially_paid", "partially_paid");
    const graph = await fixture.graph();
    expect(graph.payments).toHaveLength(1);
    expect(graph.allocations).toHaveLength(1);
    expect(graph.audits).toHaveLength(1);
    expect(graph.inventory).toEqual(before);
    expect((await Promise.all(keys.map(command))).map((row) => row.status).sort()).toEqual(["rejected", "succeeded"]);
  });

  it("admits concurrent duplicate HTTP requests only once and returns the saved result on the next retry", async () => {
    const key = randomUUID();
    const responses = await Promise.all([pay(100_000, key), pay(100_000, key)]);
    const success = responses.find((response) => response.status === 201);
    expect(success).toBeDefined();
    for (const response of responses) {
      if (response.status === 201) expect(response.body).toEqual(success!.body);
      else expect(response).toMatchObject({ status: 409, body: { details: { code: "FINANCIAL_COMMAND_IN_PROGRESS" } } });
    }
    expect(await pay(100_000, key)).toEqual({ ...success!, replayed: "true" });
    const graph = await fixture.graph();
    expect(graph.payments).toHaveLength(1);
    expect(graph.allocations).toHaveLength(1);
    expect(graph.audits).toHaveLength(1);
    expect(await command(key)).toMatchObject({ attempt_count: 1, status: "succeeded" });
  });

  it("rolls back payment, allocations, balances, PO history and audit when the final audit insert fails, then retries the same command once", async () => {
    const before = await fixture.graph();
    const key = randomUUID();
    await fixture.pool.query(`CREATE FUNCTION procurement.payment_fixture_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic payment audit failure'; END $$;
      CREATE TRIGGER payment_fixture_audit_failure BEFORE INSERT ON public.audit_events
      FOR EACH ROW WHEN(NEW.action='ap_ledger.record_payment') EXECUTE FUNCTION procurement.payment_fixture_audit_failure()`);
    try {
      const failed = await pay(100_000, key);
      expect(failed.status).toBeGreaterThanOrEqual(400);
    } finally {
      await fixture.pool.query("DROP TRIGGER payment_fixture_audit_failure ON public.audit_events; DROP FUNCTION procurement.payment_fixture_audit_failure()");
    }
    expect(await fixture.graph()).toEqual(before);
    expect(await command(key)).toMatchObject({ status: "retryable", attempt_count: 1,
      response_body: null, http_status: null, last_error_code: "AP_PAYMENT_COMMAND_TRANSIENT_FAILURE" });
    // Honor the real retry time; editing it would bypass the command contract.
    await fixture.pool.query(`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM next_attempt_at-clock_timestamp())) + 0.01)
      FROM public.financial_command_results WHERE idempotency_key=$1`, [key]);
    const retry = await pay(100_000, key);
    paymentId(retry);
    expect(retry.replayed).toBe("false");
    await expectBalances(100_000, 110_000, "partially_paid", "partially_paid");
    const committed = await fixture.graph();
    expect(committed.payments).toHaveLength(1);
    expect(committed.allocations).toHaveLength(1);
    expect(committed.history).toHaveLength(1);
    expect(committed.audits).toHaveLength(1);
    expect(committed.inventory).toEqual(before.inventory);
    expect(await command(key)).toMatchObject({ status: "succeeded", attempt_count: 2, response_body: retry.body });
    expect(await pay(100_000, key)).toEqual({ ...retry, replayed: "true" });
    expect(await fixture.graph()).toEqual(committed);
  });

  it("allows an actual delegate, ignores a forged admin session role, and denies a revoked delegate before reserving a command", async () => {
    const initial = await fixture.graph();
    const anonymousKey = randomUUID(), viewerKey = randomUUID();
    expect(await pay(100_000, anonymousKey, null)).toMatchObject({ status: 401 });
    expect(await pay(100_000, viewerKey, PAYMENT_ACTORS.viewer)).toMatchObject({ status: 403 });
    expect((await fixture.request("/api/ap-payments", { actor: PAYMENT_ACTORS.viewer })).status).toBe(200);
    expect(await fixture.graph()).toEqual(initial);
    expect((await fixture.pool.query("SELECT * FROM public.financial_command_results")).rows).toEqual([]);

    const delegated = await fixture.request("/api/ap-payments", {
      body: { ...flowPayment(100_000), createdBy: PAYMENT_ACTORS.owner },
      key: randomUUID(), actor: PAYMENT_ACTORS.delegate,
    });
    const id = paymentId(delegated);
    const committed = await fixture.graph();
    expect(committed.payments[0]).toMatchObject({ created_by: PAYMENT_ACTORS.delegate, updated_by: PAYMENT_ACTORS.delegate });
    expect(committed.audits[0]).toMatchObject({ actor: PAYMENT_ACTORS.delegate });
    expect(committed.history[0]).toMatchObject({ changed_by: PAYMENT_ACTORS.delegate });
    await fixture.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=2 AND permission_id=2");
    const revokedKey = randomUUID(), voidKey = randomUUID();
    expect(await pay(110_000, revokedKey, PAYMENT_ACTORS.delegate)).toMatchObject({ status: 403 });
    expect(await fixture.request(`/api/ap-payments/${id}/void`, { body: { reason: "Synthetic UAT reversal" }, key: voidKey,
      actor: PAYMENT_ACTORS.delegate })).toMatchObject({ status: 403 });
    expect(await fixture.graph()).toEqual(committed);
    expect((await fixture.pool.query("SELECT * FROM public.financial_command_results WHERE idempotency_key=ANY($1::text[])",
      [[anonymousKey, viewerKey, revokedKey, voidKey]])).rows).toEqual([]);
  });

  it("requires command identity before writes and rejects invalid, unsafe or incompatible amounts atomically", async () => {
    const before = await fixture.graph();
    expect(await fixture.request("/api/ap-payments", { body: flowPayment(100_000) })).toMatchObject({ status: 400,
      body: { details: { code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REQUIRED" } } });
    const cases = [
      { patch: { totalAmountCents: 0 }, status: 400, code: "AP_PAYMENT_TOTAL_INVALID" },
      { patch: { totalAmountCents: -1 }, status: 400, code: "AP_PAYMENT_TOTAL_INVALID" },
      { patch: { totalAmountCents: 100_000.5 }, status: 400, code: "AP_PAYMENT_TOTAL_INVALID" },
      { patch: { totalAmountCents: Number.MAX_SAFE_INTEGER + 1 }, status: 400, code: "AP_PAYMENT_TOTAL_INVALID" },
      { patch: { paymentDate: "invalid" }, status: 400, code: "AP_PAYMENT_DATE_INVALID" },
      { patch: { currency: "EUR" }, status: 422, code: "AP_FX_RATE_REQUIRED" },
      { patch: { vendorId: PAYMENT_FLOW.otherVendorId }, status: 422, code: "AP_PAYMENT_ALLOCATION_VENDOR_MISMATCH" },
      { patch: { totalAmountCents: 99_999 }, status: 422, code: "AP_PAYMENT_ALLOCATION_EXCEEDS_TOTAL" },
      { patch: { allocations: [{ vendorInvoiceId: 999, appliedAmountCents: 100_000 }] }, status: 422, code: "AP_PAYMENT_ALLOCATION_INVOICE_NOT_FOUND" },
      { patch: { allocations: [{ vendorInvoiceId: PAYMENT_FLOW.invoiceA, appliedAmountCents: 50_000 },
        { vendorInvoiceId: PAYMENT_FLOW.invoiceA, appliedAmountCents: 50_000 }] }, status: 422, code: "AP_PAYMENT_ALLOCATION_DUPLICATE_INVOICE" },
    ];
    for (const scenario of cases) {
      const key = randomUUID();
      const rejected = await fixture.request("/api/ap-payments", { body: { ...flowPayment(100_000), ...scenario.patch }, key });
      expect(rejected, JSON.stringify(scenario)).toMatchObject({ status: scenario.status, body: { details: { code: scenario.code } } });
      expect(await command(key)).toMatchObject({ status: "rejected", last_error_code: scenario.code });
      expect(await fixture.graph()).toEqual(before);
    }
  });

  it("denies record, void and replay for a deactivated account holding its real previously authenticated session cookie", async () => {
    const identity = await import("../../../identity/infrastructure/identity.repository");
    const cookie = await fixture.loginDelegate();
    const key = randomUUID(), body = flowPayment(100_000);
    const accepted = await fixture.request("/api/ap-payments", { body, key, cookie });
    const id = paymentId(accepted);
    expect(await identity.getUserPermissions(PAYMENT_ACTORS.delegate)).toContain("purchasing:approve");
    const before = await fixture.graph();
    // Use the same identity owner as PATCH /api/users/:id. Its persisted session
    // remains intact, so the permission read must reject the now inactive user.
    await identity.updateUser(PAYMENT_ACTORS.delegate, { active: 0 });
    const nextKey = randomUUID(), voidKey = randomUUID();
    expect(await fixture.request("/api/ap-payments", { body: flowPayment(110_000), key: nextKey, cookie }))
      .toMatchObject({ status: 403 });
    expect(await fixture.request("/api/ap-payments", { body, key, cookie })).toMatchObject({ status: 403 });
    expect(await fixture.request(`/api/ap-payments/${id}/void`, { body: { reason: "Synthetic retained-cookie attempt" }, key: voidKey, cookie }))
      .toMatchObject({ status: 403 });
    expect(await identity.getUserPermissions(PAYMENT_ACTORS.delegate)).toEqual([]);
    const session = await fixture.request("/api/auth/me", { cookie });
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ user: { id: PAYMENT_ACTORS.delegate, active: 1 }, permissions: [] });
    expect(await fixture.graph()).toEqual(before);
    expect(await command(key)).toMatchObject({ status: "succeeded", attempt_count: 1, response_body: accepted.body });
    expect((await fixture.pool.query("SELECT * FROM public.financial_command_results WHERE idempotency_key=ANY($1::text[])",
      [[nextKey, voidKey]])).rows).toEqual([]);

    await identity.updateUser(PAYMENT_ACTORS.delegate, { active: 1 });
    expect(await fixture.request("/api/ap-payments", { body, key, cookie })).toEqual({ ...accepted, replayed: "true" });
    paymentId(await fixture.request("/api/ap-payments", { body: flowPayment(110_000), key: nextKey, cookie }));
    await expectBalances(210_000, 0, "paid", "paid");
  });

  it("rejects the entire allocation when one of two invoices is not payable", async () => {
    await fixture.pool.query("UPDATE procurement.vendor_invoices SET status='received' WHERE id=$1", [PAYMENT_FLOW.invoiceB]);
    const before = await fixture.graph();
    expect(await fixture.request("/api/ap-payments", { key: randomUUID(), body: {
      ...flowPayment(200_000), allocations: [
        { vendorInvoiceId: PAYMENT_FLOW.invoiceA, appliedAmountCents: 100_000 },
        { vendorInvoiceId: PAYMENT_FLOW.invoiceB, appliedAmountCents: 100_000 },
      ],
    } })).toMatchObject({ status: 409, body: { details: { code: "AP_PAYMENT_ALLOCATION_INVOICE_NOT_PAYABLE" } } });
    expect(await fixture.graph()).toEqual(before);
  });

  it("allocates one real payment across both FLOW invoices and reconciles each linked PO exactly", async () => {
    const before = await fixture.inventoryEvidence();
    const posted = await fixture.request("/api/ap-payments", { key: randomUUID(), body: {
      ...flowPayment(420_000), allocations: [
        { vendorInvoiceId: PAYMENT_FLOW.invoiceB, appliedAmountCents: 210_000 },
        { vendorInvoiceId: PAYMENT_FLOW.invoiceA, appliedAmountCents: 210_000 },
      ],
    } });
    paymentId(posted);
    const graph = await fixture.graph();
    expect(graph.payments).toHaveLength(1);
    expect(graph.allocations).toHaveLength(2);
    expect(graph.invoices).toEqual([expect.objectContaining({ id: 71, paid_amount_cents: "210000", balance_cents: "0", status: "paid" }),
      expect.objectContaining({ id: 72, paid_amount_cents: "210000", balance_cents: "0", status: "paid" })]);
    expect(graph.purchaseOrders.map((po) => [po.id, po.paid_total_cents, po.outstanding_cents, po.financial_status]))
      .toEqual([[11, "210000", "0", "paid"], [12, "210000", "0", "paid"]]);
    expect(graph.inventory).toEqual(before);
  });

  it("voids once with retained allocations and history, restores the invoice balance and replays without a second reversal", async () => {
    const id = paymentId(await pay(210_000));
    const paid = await fixture.graph();
    const key = randomUUID(), body = { reason: "Synthetic UAT duplicate wire record" };
    const result = await fixture.request(`/api/ap-payments/${id}/void`, { body, key });
    expect(result).toMatchObject({ status: 200, replayed: "false", body: { ok: true } });
    await expectBalances(0, 210_000, "approved", "invoiced");
    const voided = await fixture.graph();
    expect(voided.allocations).toEqual(paid.allocations);
    expect(voided.inventory).toEqual(paid.inventory);
    expect(voided.payments[0]).toMatchObject({ status: "voided", voided_by: PAYMENT_ACTORS.owner, void_reason: body.reason });
    expect(voided.payments[0].voided_at).toBeInstanceOf(Date);
    expect(voided.history).toHaveLength(2);
    expect(voided.audits).toHaveLength(2);
    expect(voided.audits[1]).toMatchObject({ actor: PAYMENT_ACTORS.owner, action: "ap_ledger.void_payment", target: `payment:${id}` });
    expect(voided.purchaseOrders[0].first_paid_at).toEqual(paid.purchaseOrders[0].first_paid_at);
    expect(voided.purchaseOrders[0].fully_paid_at).toEqual(paid.purchaseOrders[0].fully_paid_at);
    expect(await fixture.request(`/api/ap-payments/${id}/void`, { body, key })).toEqual({ ...result, replayed: "true" });
    expect(await fixture.graph()).toEqual(voided);
    expect(await fixture.request(`/api/ap-payments/${id}/void`, { body, key: randomUUID() })).toMatchObject({ status: 409 });
    expect(await fixture.graph()).toEqual(voided);
  });
  it("applies one advance repeatedly without creating cash or rewriting original allocations", async () => {
    await fixture.pool.query("UPDATE procurement.vendor_invoices SET due_date='2026-10-01' WHERE id IN (71,72)");
    const activePastDue = async () => (await fixture.pool.query("SELECT id FROM procurement.po_exceptions WHERE po_id=11 AND kind='past_due' AND status IN ('open','acknowledged')")).rows;
    const inventory = await fixture.inventoryEvidence();
    const id = await advance(300_000, 50_000);
    const original = await fixture.graph();
    expect(await balance(id)).toMatchObject({ state: "available", appliedAmountCents: 50_000, unappliedAmountCents: 250_000 });
    const first = await apply(id, (await balance(id)).version, 60_000);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ command: "apply_payment", paymentId: id, actorId: PAYMENT_ACTORS.owner,
      applications: [expect.objectContaining({ vendorInvoiceId: PAYMENT_FLOW.invoiceA, appliedAmountCents: 60_000 })] });
    expect((await fixture.graph()).allocations[0]).toEqual(original.allocations[0]);
    await expectBalances(110_000, 100_000, "partially_paid", "partially_paid");
    expect(await activePastDue()).toHaveLength(1);
    expect((await apply(id, (await balance(id)).version, 100_000)).status).toBe(200);
    expect((await apply(id, (await balance(id)).version, 90_000, randomUUID(), PAYMENT_FLOW.invoiceB)).status).toBe(200);
    await expectBalances(210_000, 0, "paid", "paid");
    const graph = await fixture.graph();
    expect(graph.payments).toEqual(original.payments);
    expect(graph.allocations.map(row => row.applied_amount_cents)).toEqual(["50000", "60000", "100000", "90000"]);
    expect(graph.inventory).toEqual(inventory);
    expect(graph.audits.filter(row => row.action === "ap_ledger.apply_payment")).toHaveLength(3);
    expect(await balance(id)).toMatchObject({ state: "fully_applied", appliedAmountCents: 300_000, unappliedAmountCents: 0 });
    const list = await fixture.request<{ payments: Array<{ id: number; paymentBalance: PaymentBalance }> }>("/api/ap-payments");
    expect(list.body.payments.find(row => row.id === id)?.paymentBalance).toEqual(await balance(id));
    expect(graph.purchaseOrders[0].first_paid_at).toEqual(original.purchaseOrders[0].first_paid_at);
    expect(graph.purchaseOrders[0].fully_paid_at).toBeInstanceOf(Date);
    const { db } = await import("../../../../db");
    const { createPurchaseOrderListRepository } = await import("../../purchase-order-list.repository");
    const { createPurchaseOrderListService } = await import("../../purchase-order-list.service");
    const readList = createPurchaseOrderListService(createPurchaseOrderListRepository(db));
    expect((await readList({ financialWorkflow: "settled" })).purchaseOrders.map(row => row.id)).toEqual([PAYMENT_FLOW.poA]);
    expect((await readList({ financialWorkflow: "review_required" })).total).toBe(0);
    expect(await activePastDue()).toHaveLength(0);
    expect((await fixture.request(`/api/ap-payments/${id}/void`, { key: randomUUID(), body: { reason: "Correct the recorded application through the existing whole-payment reversal" } })).status).toBe(200);
    await expectBalances(0, 210_000, "approved", "invoiced");
    const reversed = await fixture.graph();
    expect(reversed.allocations).toEqual(graph.allocations);
    expect(reversed.purchaseOrders[0].fully_paid_at).toEqual(graph.purchaseOrders[0].fully_paid_at);
    expect((await readList({ financialWorkflow: "payment_due" })).total).toBe(2);
    expect((await readList({ financialWorkflow: "review_required" })).total).toBe(0);
    expect(await activePastDue()).toHaveLength(1);
  });

  it("replays a saved application after acknowledgement loss and rejects changed input under that key", async () => {
    const id = await advance(100_000), key = randomUUID(), version = (await balance(id)).version;
    const first = await apply(id, version, 40_000, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const committed = await fixture.graph();
    expect(await apply(id, version, 40_000, key)).toEqual({ ...first, replayed: "true" });
    expect(await apply(id, version, 40_001, key)).toMatchObject({ status: 422 });
    expect(await fixture.graph()).toEqual(committed);
    expect(await command(key)).toMatchObject({ status: "succeeded", attempt_count: 1, response_body: first.body });
  });

  it("serializes competing applications of the same payment version", async () => {
    const id = await advance(100_000), version = (await balance(id)).version;
    const replies = await Promise.all([apply(id, version, 60_000), apply(id, version, 60_000)]);
    expect(replies.map(row => row.status).sort()).toEqual([200, 409]);
    expect(replies.find(row => row.status === 409)?.body).toMatchObject({ details: { code: "AP_PAYMENT_VERSION_CONFLICT" } });
    expect(await balance(id)).toMatchObject({ appliedAmountCents: 60_000, unappliedAmountCents: 40_000 });
    const graph = await fixture.graph();
    expect(graph.payments).toHaveLength(1);
    expect(graph.allocations).toHaveLength(1);
  });

  it("serializes two advances competing for one invoice balance", async () => {
    const ids = [await advance(150_000), await advance(150_000)];
    const versions = await Promise.all(ids.map(balance));
    const replies = await Promise.all(ids.map((id, index) => apply(id, versions[index].version, 150_000)));
    expect(replies.map(row => row.status).sort()).toEqual([200, 409]);
    await expectBalances(150_000, 60_000, "partially_paid", "partially_paid");
    expect((await fixture.graph()).allocations).toHaveLength(1);
  });

  it("admits duplicate application requests once", async () => {
    const id = await advance(100_000), version = (await balance(id)).version, key = randomUUID();
    const replies = await Promise.all([apply(id, version, 25_000, key), apply(id, version, 25_000, key)]);
    const first = replies.find(row => row.status === 200);
    expect(first).toBeDefined();
    for (const reply of replies) {
      if (reply.status === 200) expect(reply.body).toEqual(first!.body);
      else expect(reply).toMatchObject({ status: 409, body: { details: { code: "FINANCIAL_COMMAND_IN_PROGRESS" } } });
    }
    expect(await apply(id, version, 25_000, key)).toEqual({ ...first!, replayed: "true" });
    expect((await fixture.graph()).allocations).toHaveLength(1);
    expect(await command(key)).toMatchObject({ attempt_count: 1, status: "succeeded" });
  });

  it("keeps every application as history when a void races an application", async () => {
    const id = await advance(100_000, 20_000), version = (await balance(id)).version;
    const original = await fixture.graph();
    const [applied, voided] = await Promise.all([apply(id, version, 30_000), fixture.request(`/api/ap-payments/${id}/void`, {
      key: randomUUID(), body: { reason: "Synthetic application/void race" },
    })]);
    expect([200, 409]).toContain(applied.status);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    await expectBalances(0, 210_000, "approved", "invoiced");
    const final = await fixture.graph();
    expect(final.allocations[0]).toEqual(original.allocations[0]);
    expect(final.allocations).toHaveLength(applied.status === 200 ? 2 : 1);
    expect(await balance(id)).toMatchObject({ state: "voided", appliedAmountCents: 0, unappliedAmountCents: 0 });
  });

  it("rejects invalid, over-remainder and stale applications without changing financial history", async () => {
    const id = await advance(100_000), version = (await balance(id)).version;
    const before = await fixture.graph();
    for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 100_001]) {
      const response = await apply(id, version, amount);
      expect(response.status, JSON.stringify(response.body)).toBe(amount === 100_001 ? 409 : 400);
      expect(await fixture.graph()).toEqual(before);
    }
    const invalidBodies = [
      { expectedVersion: "not-a-version", reason: "review", allocations: [{ vendorInvoiceId: 71, appliedAmountCents: 1 }] },
      { expectedVersion: version, reason: "  ", allocations: [{ vendorInvoiceId: 71, appliedAmountCents: 1 }] },
      { expectedVersion: version, reason: "review", allocations: [{ vendorInvoiceId: 71, appliedAmountCents: 1 }, { vendorInvoiceId: 71, appliedAmountCents: 1 }] },
    ];
    for (const body of invalidBodies) {
      expect((await fixture.request(`/api/ap-payments/${id}/applications`, { body, key: randomUUID() })).status).toBe(400);
      expect(await fixture.graph()).toEqual(before);
    }
    expect((await apply(id, version, 1)).status).toBe(200);
    const committed = await fixture.graph();
    expect(await apply(id, version, 1)).toMatchObject({ status: 409, body: { details: { code: "AP_PAYMENT_VERSION_CONFLICT" } } });
    expect(await fixture.graph()).toEqual(committed);
  });

  it("rejects an application whose cached invoice balance disagrees with settlement evidence", async () => {
    const id = await advance(100_000), version = (await balance(id)).version;
    await fixture.pool.query("UPDATE procurement.vendor_invoices SET paid_amount_cents=100,balance_cents=209900 WHERE id=71");
    const before = await fixture.graph();
    expect(await apply(id, version, 50_000)).toMatchObject({ status: 409, body: { details: { code: "AP_INVOICE_PAYMENT_EVIDENCE_REVIEW" } } });
    expect(await fixture.graph()).toEqual(before);
  });

  it("rolls back a complete application when its immutable audit cannot be saved", async () => {
    const id = await advance(100_000), version = (await balance(id)).version, key = randomUUID();
    const before = await fixture.graph();
    await fixture.pool.query(`CREATE FUNCTION procurement.application_fixture_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic application audit failure'; END $$;
      CREATE TRIGGER application_fixture_audit_failure BEFORE INSERT ON public.audit_events
      FOR EACH ROW WHEN(NEW.action='ap_ledger.apply_payment') EXECUTE FUNCTION procurement.application_fixture_audit_failure()`);
    try { expect((await apply(id, version, 50_000, key)).status).toBeGreaterThanOrEqual(400); }
    finally { await fixture.pool.query("DROP TRIGGER application_fixture_audit_failure ON public.audit_events; DROP FUNCTION procurement.application_fixture_audit_failure()"); }
    expect(await fixture.graph()).toEqual(before);
    expect(await command(key)).toMatchObject({ status: "retryable", attempt_count: 1 });
    await fixture.pool.query(`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM next_attempt_at-clock_timestamp())) + 0.01)
      FROM public.financial_command_results WHERE idempotency_key=$1`, [key]);
    const retry = await apply(id, version, 50_000, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(await command(key)).toMatchObject({ status: "succeeded", attempt_count: 2, response_body: retry.body });
    expect((await fixture.graph()).allocations).toHaveLength(1);
    expect(await apply(id, version, 50_000, key)).toEqual({ ...retry, replayed: "true" });
  });

  it("enforces allocation and payment history immutability in PostgreSQL", async () => {
    const id = await advance(100_000, 25_000);
    const before = await fixture.graph();
    for (const query of [
      "UPDATE procurement.ap_payment_allocations SET applied_amount_cents=1",
      "DELETE FROM procurement.ap_payment_allocations",
      "TRUNCATE procurement.ap_payment_allocations",
      "UPDATE procurement.ap_payments SET total_amount_cents=200000",
      "UPDATE procurement.ap_payments SET payment_calendar_date='2026-10-02'",
      "DELETE FROM procurement.ap_payments",
      "TRUNCATE procurement.ap_payments CASCADE",
      `INSERT INTO procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id,applied_amount_cents) VALUES(${id},71,75001)`,
    ]) await expect(fixture.pool.query(query), query).rejects.toMatchObject({ code: "23514" });
    expect(await fixture.graph()).toEqual(before);
  });

  it("stores explicit calendar dates and leaves legacy timestamps unverified without rewriting history", async () => {
    const id = await advance(100_000);
    const detail = await fixture.request(`/api/ap-payments/${id}`);
    expect(detail.body).toMatchObject({ paymentCalendarDate: "2026-10-01", paymentDateSource: "recorded_calendar_date", paymentDate: "2026-10-01T00:00:00.000Z" });
    const legacyId = paymentId(await pay(1));
    const legacy = await fixture.request(`/api/ap-payments/${legacyId}`);
    expect(legacy.body).toMatchObject({ paymentCalendarDate: null, paymentDateSource: "legacy_timestamp", paymentDate: "2026-09-10T12:00:00.000Z" });
    const before = await fixture.graph();
    for (const paymentDate of ["2026-02-29", "2026-13-01", "2026-10-01junk", "0000-01-01"]) {
      expect(await fixture.request("/api/ap-payments", { key: randomUUID(), body: { ...flowPayment(1), paymentDate } }))
        .toMatchObject({ status: 400, body: { details: { code: "AP_PAYMENT_DATE_INVALID" } } });
      expect(await fixture.graph()).toEqual(before);
    }
  });

  it.each(["record", "apply", "void"] as const)("rechecks current permission for %s after waiting for the financial graph lock", async operation => {
    const id = await advance(100_000), version = (await balance(id)).version, key = randomUUID();
    const before = await fixture.graph(), blocker = await fixture.pool.connect();
    let pending: ReturnType<typeof fixture.request> | undefined;
    try {
      await blocker.query("BEGIN; SELECT pg_advisory_xact_lock(hashtext('inventory.cost_graph'),hashtext('version_1'))");
      const path = operation === "record" ? "/api/ap-payments" : `/api/ap-payments/${id}/${operation === "apply" ? "applications" : "void"}`;
      const body = operation === "record" ? flowPayment(100) : operation === "void" ? { reason: "Synthetic permission revocation race" }
        : { expectedVersion: version, reason: "Synthetic permission revocation race", allocations: [{ vendorInvoiceId: 71, appliedAmountCents: 100 }] };
      pending = fixture.request(path, { key, actor: PAYMENT_ACTORS.delegate, body });
      // Wait for observed PostgreSQL lock contention, not a guessed timer.
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const observed = await fixture.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid()) AS waiting");
        if (observed.rows[0].waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await fixture.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=2 AND permission_id=2");
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ status: 403, body: { details: { code: "AP_PAYMENT_AUTHORITY_REQUIRED", paymentCommandOutcome: "rejected" } } });
      expect(await fixture.graph()).toEqual(before);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
  });

  it("prevents reuse of one cash request key by another operator, supplier or action", async () => {
    const key = randomUUID(), body = { ...flowPayment(100_000), allocations: [] };
    const first = await fixture.request("/api/ap-payments", { key, body });
    const id = paymentId(first), committed = await fixture.graph();
    expect(await fixture.request("/api/ap-payments", { key, body, actor: PAYMENT_ACTORS.delegate }))
      .toMatchObject({ status: 422, body: { details: { code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" } } });
    expect(await fixture.request("/api/ap-payments", { key, body: { ...body, vendorId: PAYMENT_FLOW.otherVendorId } })).toMatchObject({ status: 422 });
    expect(await fixture.request(`/api/ap-payments/${id}/void`, { key, body: { reason: "Reused cash key" } })).toMatchObject({ status: 422 });
    expect(await fixture.graph()).toEqual(committed);
    expect(await fixture.request("/api/ap-payments", { key, body })).toEqual({ ...first, replayed: "true" });
  });

  it("admits only one cash record when two authorized actors concurrently reuse a key", async () => {
    const key = randomUUID(), body = { ...flowPayment(100_000), allocations: [] };
    const replies = await Promise.all([PAYMENT_ACTORS.owner, PAYMENT_ACTORS.delegate].map(actor => fixture.request("/api/ap-payments", { key, body, actor })));
    expect(replies.map(row => row.status).sort()).toEqual([201, 422]);
    expect((await fixture.graph()).payments).toHaveLength(1);
    expect((await fixture.pool.query("SELECT * FROM public.financial_command_results WHERE idempotency_key=$1", [key])).rows).toHaveLength(1);
  });

  it("replays an exact legacy cash command and rejects adoption by a new operator without adding cash", async () => {
    const { financialCommandRepository } = await import("../../../../platform/commands/command-results.repository");
    const { runTransactionalFinancialCommand } = await import("../../../../platform/commands/transactional-command.service");
    const { executeApPaymentCommandInTransaction } = await import("../../ap-ledger.service");
    const key = randomUUID(), body = flowPayment(100_000);
    const descriptor: FinancialCommandDescriptor = { actorType: "user", actorId: PAYMENT_ACTORS.owner, method: "POST",
      routeTemplate: "/api/ap-payments", resourceKey: "vendor:5", commandName: "ap.payment.record", contractVersion: 1,
      idempotencyKey: key, requestHash: hashHttpFinancialCommand({ method: "POST", routeTemplate: "/api/ap-payments", resourceKey: "vendor:5", body }) };
    const legacy = await runTransactionalFinancialCommand({ repository: financialCommandRepository, descriptor,
      classifyFailure: error => { throw error; }, work: async tx => {
        const value = await executeApPaymentCommandInTransaction("record_payment", { payment: { ...body, paymentDate: new Date(body.paymentDate), createdBy: PAYMENT_ACTORS.owner }, userId: PAYMENT_ACTORS.owner, now: new Date("2026-10-01T12:00:00Z") }, tx);
        if (!("id" in value)) throw new Error("Legacy fixture requires a recorded payment");
        // A legacy saved response has no newly invented recovery identity.
        return { httpStatus: 201, body: JSON.parse(JSON.stringify(value)), resultType: "ap_payment", resultId: value.id };
      } });
    const committed = await fixture.graph();
    expect(await fixture.request("/api/ap-payments", { key, body })).toMatchObject({ status: 201, replayed: "true", body: legacy.body });
    expect(await fixture.request("/api/ap-payments", { key, body, actor: PAYMENT_ACTORS.delegate }))
      .toMatchObject({ status: 409, body: { details: { code: "AP_PAYMENT_LEGACY_KEY_REVIEW" } } });
    expect(await fixture.graph()).toEqual(committed);
    expect((await fixture.pool.query("SELECT * FROM public.financial_command_results WHERE idempotency_key=$1", [key])).rows).toHaveLength(1);
  });

  it("prevents concurrent legacy/new namespace reservation while allowing unrelated command families", async () => {
    const { financialCommandRepository } = await import("../../../../platform/commands/command-results.repository");
    const { bindApPaymentCommandIdentity } = await import("../../ap-payment-command-identity");
    const key = randomUUID();
    const legacy: FinancialCommandDescriptor = { actorType: "user", actorId: PAYMENT_ACTORS.owner, method: "POST", routeTemplate: "/api/ap-payments",
      resourceKey: "vendor:5", commandName: "ap.payment.record", contractVersion: 1, idempotencyKey: key, requestHash: "a".repeat(64) };
    const results = await Promise.allSettled([financialCommandRepository.reserve(legacy), financialCommandRepository.reserve(bindApPaymentCommandIdentity(legacy, "record_payment"))]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(row => row.status === "rejected")).toHaveLength(1);
    expect((await fixture.pool.query("SELECT * FROM public.financial_command_results WHERE idempotency_key=$1", [key])).rows).toHaveLength(1);
    const unrelated = { ...legacy, routeTemplate: "/api/unrelated-fixture", commandName: "fixture.unrelated", resourceKey: "fixture:1" };
    await expect(financialCommandRepository.reserve(unrelated)).resolves.toMatchObject({ kind: "claimed" });
  });

  it("reapplies the migration without changing recorded payment, allocation or response history", async () => {
    const id = await advance(100_000, 25_000);
    const key = randomUUID();
    paymentId(await pay(1, key));
    const before = await fixture.graph(), saved = await command(key), projected = await balance(id);
    await fixture.pool.query(readFileSync(resolve(process.cwd(), "docs/procurement/payment-balance-completion.pending.sql"), "utf8"));
    expect(await fixture.graph()).toEqual(before);
    expect(await command(key)).toEqual(saved);
    expect(await balance(id)).toEqual(projected);
  });

  it("preserves corrupt legacy allocations as review evidence instead of spending a misleading remainder", async () => {
    const id = await advance(100_000, 25_000);
    // Deliberately reproduce pre-migration bad data on this fixture-owned table.
    // The protection is restored atomically before either the read or new write.
    const setup = await fixture.pool.connect();
    try {
      await setup.query("BEGIN; ALTER TABLE procurement.ap_payment_allocations DISABLE TRIGGER USER");
      await setup.query("UPDATE procurement.ap_payment_allocations SET applied_amount_cents=-100 WHERE ap_payment_id=$1", [id]);
      await setup.query("ALTER TABLE procurement.ap_payment_allocations ENABLE TRIGGER USER; COMMIT");
    } catch (error) { await setup.query("ROLLBACK"); throw error; }
    finally { setup.release(); }
    const projected = await balance(id), before = await fixture.graph();
    expect(projected).toMatchObject({ state: "review_required", appliedAmountCents: null, unappliedAmountCents: null });
    expect(await apply(id, projected.version, 1)).toMatchObject({ status: 409, body: { details: { code: "AP_PAYMENT_ALLOCATION_REVIEW_REQUIRED" } } });
    await expect(fixture.pool.query("INSERT INTO procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id,applied_amount_cents) VALUES($1,71,1)", [id]))
      .rejects.toMatchObject({ code: "23514" });
    expect(await fixture.graph()).toEqual(before);
  });

  it("rejects both new cash and existing funds when another payment has corrupt target-invoice evidence", async () => {
    const corruptId = await advance(100_000, 25_000);
    const availableId = await advance(100_000);
    // Simulate historical corruption only in this disposable fixture, restoring
    // protections before exercising both real HTTP entry points and direct SQL.
    const setup = await fixture.pool.connect();
    try {
      await setup.query("BEGIN; ALTER TABLE procurement.ap_payment_allocations DISABLE TRIGGER USER");
      await setup.query("UPDATE procurement.ap_payment_allocations SET applied_amount_cents=-100 WHERE ap_payment_id=$1", [corruptId]);
      await setup.query("ALTER TABLE procurement.ap_payment_allocations ENABLE TRIGGER USER; COMMIT");
    } catch (error) { await setup.query("ROLLBACK"); throw error; }
    finally { setup.release(); }
    const before = await fixture.graph();
    const available = await balance(availableId);
    expect(available).toMatchObject({ state: "available", unappliedAmountCents: 100_000 });
    expect(await apply(availableId, available.version, 1))
      .toMatchObject({ status: 409, body: { details: { code: "AP_INVOICE_PAYMENT_EVIDENCE_REVIEW" } } });
    expect(await fixture.graph()).toEqual(before);
    const cashKey = randomUUID();
    const rejectedCash = await pay(1, cashKey);
    expect(rejectedCash).toMatchObject({ status: 422, body: {
      error: "The payment references invalid or incompatible AP records",
      details: { paymentCommandOutcome: "rejected", command: "record_payment", actorId: PAYMENT_ACTORS.owner, idempotencyKey: cashKey },
    } });
    expect(await command(cashKey)).toMatchObject({ status: "rejected", last_error_code: "AP_PAYMENT_REFERENCE_INVALID" });
    expect(await pay(1, cashKey)).toEqual({ ...rejectedCash, replayed: "true" });
    await expect(fixture.pool.query("INSERT INTO procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id,applied_amount_cents) VALUES($1,71,1)", [availableId]))
      .rejects.toMatchObject({ code: "23514" });
    expect(await fixture.graph()).toEqual(before);
  });

  it("rejects a verified date that disagrees with its stored instant at the database boundary", async () => {
    const before = await fixture.graph();
    await expect(fixture.pool.query(`INSERT INTO procurement.ap_payments(payment_number,vendor_id,payment_date,payment_calendar_date,payment_method,total_amount_cents)
      VALUES('SYNTHETIC-BAD-DATE',5,'2026-10-01T12:00:00','2026-10-01','wire',100)`)).rejects.toMatchObject({ code: "23514" });
    expect(await fixture.graph()).toEqual(before);
  });

});
