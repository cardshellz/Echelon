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
  }

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
});
