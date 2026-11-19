import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { recordPaymentResultSchema, paymentApplicationResultSchema } from "@shared/procurement/ap-payment-contract";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import type { ApPaymentFinancialCommand, RecordApPaymentInput } from "../../ap-ledger.service";
import { PAYMENT_ACTORS, PAYMENT_FLOW, type PaymentAcceptanceFixture } from "./payment-controlled-acceptance.fixture";

const RECORDED_AT = new Date("2031-10-25T12:34:56.789Z");
const APPLIED_AT = new Date("2031-10-26T13:45:57.123Z");
const VOIDED_AT = new Date("2031-10-27T14:56:58.456Z");
const PAYMENT_DAY = "2026-10-01";

function payment(allocated = 100_000): RecordApPaymentInput {
  return { vendorId: PAYMENT_FLOW.vendorId, paymentDate: new Date(PAYMENT_DAY + "T00:00:00.000Z"),
    paymentCalendarDate: PAYMENT_DAY, paymentMethod: "wire", totalAmountCents: 100_000,
    allocations: allocated ? [{ vendorInvoiceId: PAYMENT_FLOW.invoiceA, appliedAmountCents: allocated }] : [] };
}

function descriptor(command: ApPaymentFinancialCommand, body: unknown, id?: number, key = randomUUID()): FinancialCommandDescriptor {
  const routeTemplate = command === "record_payment" ? "/api/ap-payments" : command === "apply_payment"
    ? "/api/ap-payments/:id/applications" : "/api/ap-payments/:id/void";
  const resourceKey = id === undefined ? "vendor:" + PAYMENT_FLOW.vendorId : "payment:" + id;
  return { actorType: "user", actorId: PAYMENT_ACTORS.owner, method: "POST", routeTemplate, resourceKey,
    commandName: command === "record_payment" ? "ap.payment.record" : command === "apply_payment" ? "ap.payment.apply" : "ap.payment.void",
    contractVersion: 1, idempotencyKey: key,
    requestHash: hashHttpFinancialCommand({ method: "POST", routeTemplate, resourceKey, body }) };
}

export function registerApPaymentClockAndNumberCases(fixture: PaymentAcceptanceFixture): void {
  it("uses the command instant for payment, allocations, invoice/PO projections, milestones and audit; replay preserves it", async () => {
    const { createApPaymentCommands } = await import("../../ap-payment-commands");
    const input = { payment: payment() }, request = descriptor("record_payment", input);
    let clockCalls = 0;
    const commands = createApPaymentCommands(undefined, () => { clockCalls++; return RECORDED_AT; });
    const first = await commands.recordPayment(input, request);
    const saved = recordPaymentResultSchema.parse(first.body);
    expect(first).toMatchObject({ replayed: false, httpStatus: 201 });
    expect(saved).toMatchObject({ paymentNumber: "PAY-20311025-001", paymentDate: PAYMENT_DAY + "T00:00:00.000Z", paymentCalendarDate: PAYMENT_DAY });
    const graph = await fixture.graph();
    expect(graph.payments[0]).toMatchObject({ created_at: RECORDED_AT, updated_at: RECORDED_AT, payment_date: new Date(PAYMENT_DAY + "T00:00:00.000Z") });
    expect(graph.allocations[0].created_at).toEqual(RECORDED_AT);
    expect(graph.invoices[0].updated_at).toEqual(RECORDED_AT);
    expect(graph.purchaseOrders[0]).toMatchObject({ updated_at: RECORDED_AT, first_paid_at: RECORDED_AT });
    expect(graph.history[0].changed_at).toEqual(RECORDED_AT);
    expect(graph.audits[0].timestamp).toEqual(RECORDED_AT);
    const replayCommands = createApPaymentCommands(undefined, () => { clockCalls++; return VOIDED_AT; });
    expect(await replayCommands.recordPayment(input, request)).toMatchObject({ replayed: true, body: first.body });
    expect(clockCalls).toBe(1);
    expect(await fixture.graph()).toEqual(graph);
  });

  it("applies and voids recorded cash with one timestamp per command while retaining the original cash and calendar date", async () => {
    const { createApPaymentCommands } = await import("../../ap-payment-commands");
    const input = { payment: { ...payment(25_000), totalAmountCents: PAYMENT_FLOW.invoiceCents } };
    const saved = recordPaymentResultSchema.parse((await createApPaymentCommands(undefined, () => RECORDED_AT)
      .recordPayment(input, descriptor("record_payment", input))).body);
    const application = { expectedVersion: saved.paymentBalance.version, reason: "Apply the remaining recorded supplier advance",
      allocations: [{ vendorInvoiceId: PAYMENT_FLOW.invoiceA, appliedAmountCents: PAYMENT_FLOW.invoiceCents - 25_000 }] };
    const applied = await createApPaymentCommands(undefined, () => APPLIED_AT)
      .applyPayment(saved.id, { application }, descriptor("apply_payment", application, saved.id));
    expect(paymentApplicationResultSchema.parse(applied.body).paymentBalance.state).toBe("fully_applied");
    const afterApply = await fixture.graph();
    expect(afterApply.allocations.map(row => row.created_at)).toEqual([RECORDED_AT, APPLIED_AT]);
    expect(afterApply.invoices[0]).toMatchObject({ updated_at: APPLIED_AT, status: "paid" });
    expect(afterApply.purchaseOrders[0]).toMatchObject({ updated_at: APPLIED_AT, first_paid_at: RECORDED_AT, fully_paid_at: APPLIED_AT });
    expect(afterApply.history.at(-1).changed_at).toEqual(APPLIED_AT);
    expect(afterApply.audits[1].timestamp).toEqual(APPLIED_AT);
    const inputVoid = { reason: "Reverse the synthetic transfer after reconciliation" };
    const requestVoid = descriptor("void_payment", inputVoid, saved.id);
    const voided = await createApPaymentCommands(undefined, () => VOIDED_AT).voidPayment(saved.id, inputVoid, requestVoid);
    const graph = await fixture.graph();
    expect(graph.payments[0]).toMatchObject({ created_at: RECORDED_AT, updated_at: VOIDED_AT, voided_at: VOIDED_AT,
      payment_date: new Date(PAYMENT_DAY + "T00:00:00.000Z"), payment_calendar_date: afterApply.payments[0].payment_calendar_date });
    // node-postgres parses raw DATE fields as Date; verify the stored calendar
    // value explicitly without relying on driver/timezone rendering.
    expect((await fixture.pool.query("SELECT payment_calendar_date::text AS day FROM procurement.ap_payments WHERE id=$1", [saved.id])).rows)
      .toEqual([{ day: PAYMENT_DAY }]);
    expect(graph.allocations).toEqual(afterApply.allocations);
    expect(graph.invoices[0]).toMatchObject({ updated_at: VOIDED_AT, paid_amount_cents: "0" });
    expect(graph.purchaseOrders[0]).toMatchObject({ updated_at: VOIDED_AT, first_paid_at: RECORDED_AT, fully_paid_at: APPLIED_AT, paid_total_cents: "0" });
    expect(graph.history.at(-1).changed_at).toEqual(VOIDED_AT);
    expect(graph.audits.at(-1)).toMatchObject({ timestamp: VOIDED_AT, action: "ap_ledger.void_payment" });
    expect(await createApPaymentCommands(undefined, () => new Date("2032-01-01T00:00:00Z"))
      .voidPayment(saved.id, inputVoid, requestVoid)).toMatchObject({ replayed: true, body: voided.body });
    expect(await fixture.graph()).toEqual(graph);
  });

  it.each(["record_payment", "apply_payment", "void_payment"] as const)("rejects an invalid %s clock with no financial or audit write", async command => {
    const { executeApPaymentCommandInTransaction } = await import("../../ap-ledger.service");
    const { db } = await import("../../../../db");
    const before = await fixture.graph();
    await expect(db.transaction(tx => executeApPaymentCommandInTransaction(command,
      { userId: PAYMENT_ACTORS.owner, now: new Date("invalid"), payment: payment(), paymentId: 1 }, tx)))
      .rejects.toMatchObject({ statusCode: 500, details: { code: "AP_PAYMENT_CLOCK_INVALID" } });
    expect(await fixture.graph()).toEqual(before);
  });

  it("owns its clock snapshot before waiting for the inventory graph lock", async () => {
    const { createApPaymentCommands } = await import("../../ap-payment-commands");
    const blocker = await fixture.pool.connect();
    const mutableClock = new Date(RECORDED_AT.getTime());
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext('inventory.cost_graph'), hashtext('version_1'))");
      const input = { payment: payment() };
      pending = createApPaymentCommands(undefined, () => mutableClock).recordPayment(input, descriptor("record_payment", input));
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const observed = await fixture.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid()) AS waiting");
        if (observed.rows[0].waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      mutableClock.setUTCFullYear(2040);
      await blocker.query("COMMIT");
      await pending;
      const graph = await fixture.graph();
      expect(graph.payments[0]).toMatchObject({ payment_number: "PAY-20311025-001", created_at: RECORDED_AT, updated_at: RECORDED_AT });
      expect(graph.audits[0].timestamp).toEqual(RECORDED_AT);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
  });

  it("allocates numerically after 999 and historical voids, ignoring nonnumeric supplier references", async () => {
    const { createApPaymentCommands } = await import("../../ap-payment-commands");
    await fixture.pool.query(`INSERT INTO procurement.ap_payments(payment_number,vendor_id,payment_date,payment_method,total_amount_cents,status,voided_at,void_reason)
      VALUES('PAY-20311025-999',5,'2026-10-01','wire',1,'completed',NULL,NULL),
        ('PAY-20311025-1000',5,'2026-10-01','wire',1,'completed',NULL,NULL),
        ('PAY-20311025-0001001',5,'2026-10-01','wire',1,'voided','2031-10-25','Synthetic historical void'),
        ('PAY-20311025-99999-note',5,'2026-10-01','wire',1,'completed',NULL,NULL)`);
    const input = { payment: payment(0) };
    const saved = recordPaymentResultSchema.parse((await createApPaymentCommands(undefined, () => RECORDED_AT)
      .recordPayment(input, descriptor("record_payment", input))).body);
    expect(saved.paymentNumber).toBe("PAY-20311025-1002");
    expect((await fixture.graph()).payments).toHaveLength(5);
  });

  it("durably rejects exhausted payment numbers without mutating cash or balances", async () => {
    const { createApPaymentCommands } = await import("../../ap-payment-commands");
    await fixture.pool.query("INSERT INTO procurement.ap_payments(payment_number,vendor_id,payment_date,payment_method,total_amount_cents,status) VALUES($1,5,'2026-10-01','wire',1,'completed')", ["PAY-20311025-" + "9".repeat(17)]);
    const before = await fixture.graph(), input = { payment: payment(0) }, request = descriptor("record_payment", input);
    const commands = createApPaymentCommands(undefined, () => RECORDED_AT);
    const rejected = await commands.recordPayment(input, request);
    expect(rejected).toMatchObject({ terminalState: "rejected", httpStatus: 409, replayed: false,
      body: { details: { code: "DOCUMENT_NUMBER_EXHAUSTED", command: "record_payment", paymentCommandOutcome: "rejected" } } });
    expect(await fixture.graph()).toEqual(before);
    expect(await commands.recordPayment(input, request)).toMatchObject({ replayed: true, body: rejected.body });
    expect(await fixture.graph()).toEqual(before);
  });

  it("serializes concurrent same-day payment allocation without duplicates", async () => {
    const { createApPaymentCommands } = await import("../../ap-payment-commands");
    const commands = createApPaymentCommands(undefined, () => RECORDED_AT);
    const input = { payment: payment(0) };
    const results = await Promise.all(Array.from({ length: 4 }, () => commands.recordPayment(input, descriptor("record_payment", input))));
    expect(results.map(row => recordPaymentResultSchema.parse(row.body).paymentNumber).sort()).toEqual([
      "PAY-20311025-001", "PAY-20311025-002", "PAY-20311025-003", "PAY-20311025-004",
    ]);
    const graph = await fixture.graph();
    expect(graph.payments).toHaveLength(4);
    expect(graph.audits).toHaveLength(4);
    expect(graph.payments.every(row => row.created_at.getTime() === RECORDED_AT.getTime())).toBe(true);
  });

  it("rolls back number and timestamp effects with a failed audit, then retries with one new command instant", async () => {
    const { createApPaymentCommands } = await import("../../ap-payment-commands");
    const input = { payment: payment() }, request = descriptor("record_payment", input);
    const before = await fixture.graph();
    await fixture.pool.query(`CREATE FUNCTION procurement.payment_clock_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic payment timestamp audit failure'; END $$;
      CREATE TRIGGER payment_clock_audit_failure BEFORE INSERT ON public.audit_events
      FOR EACH ROW WHEN(NEW.action='ap_ledger.record_payment') EXECUTE FUNCTION procurement.payment_clock_audit_failure()`);
    try {
      await expect(createApPaymentCommands(undefined, () => RECORDED_AT).recordPayment(input, request)).rejects.toThrow();
    } finally { await fixture.pool.query("DROP TRIGGER payment_clock_audit_failure ON public.audit_events; DROP FUNCTION procurement.payment_clock_audit_failure()"); }
    expect(await fixture.graph()).toEqual(before);
    await fixture.pool.query(`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM next_attempt_at-clock_timestamp())) + 0.01)
      FROM public.financial_command_results WHERE idempotency_key=$1`, [request.idempotencyKey]);
    const retryAt = new Date("2031-10-25T13:00:00.123Z");
    const retry = await createApPaymentCommands(undefined, () => retryAt).recordPayment(input, request);
    expect(recordPaymentResultSchema.parse(retry.body).paymentNumber).toBe("PAY-20311025-001");
    const graph = await fixture.graph();
    expect(graph.payments).toHaveLength(1);
    expect(graph.payments[0]).toMatchObject({ created_at: retryAt, updated_at: retryAt });
    expect(graph.allocations[0].created_at).toEqual(retryAt);
    expect(graph.invoices[0].updated_at).toEqual(retryAt);
    expect(graph.purchaseOrders[0]).toMatchObject({ updated_at: retryAt, first_paid_at: retryAt });
    expect(graph.history[0].changed_at).toEqual(retryAt);
    expect(graph.audits[0].timestamp).toEqual(retryAt);
  });

  it("reads numeric invoice suggestions without reserving numbers or replacing a reviewed supplier identifier", async () => {
    const service = await import("../../ap-ledger.service");
    await fixture.pool.query(`INSERT INTO procurement.vendor_invoices(invoice_number,vendor_id,status,invoiced_amount_cents,balance_cents)
      VALUES('INV-20311025-999',5,'received',1,1),('INV-20311025-1000',6,'received',1,1),
        ('INV-20311025-0001001',5,'voided',1,1),('INV-20311025-99999-note',5,'received',1,1)`);
    const before = await fixture.graph();
    expect(await service.generateInvoiceNumber({ now: RECORDED_AT })).toBe("INV-20311025-1002");
    expect(await service.generateInvoiceNumber({ now: RECORDED_AT })).toBe("INV-20311025-1002");
    expect(await fixture.graph()).toEqual(before);
    const created = await service.createInvoice({ vendorId: 5, invoiceNumber: "SUPPLIER-OCT-42", invoicedAmountCents: 100 });
    expect(created.invoiceNumber).toBe("SUPPLIER-OCT-42");
    const saved = await fixture.graph();
    await expect(service.createInvoice({ vendorId: 5, invoiceNumber: "SUPPLIER-OCT-42", invoicedAmountCents: 100 }))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "AP_INVOICE_DUPLICATE" } });
    expect(await fixture.graph()).toEqual(saved);
  });
}
