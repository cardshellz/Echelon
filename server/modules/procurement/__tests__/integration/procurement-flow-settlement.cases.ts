import { expect } from "vitest";
import { z } from "zod";
import { recordPaymentResultSchema, paymentApplicationResultSchema } from "@shared/procurement/ap-payment-contract";
import { invoiceWorkListQuerySchema, paymentWorkListQuerySchema } from "@shared/procurement/ap-work-list";
import { supplierCreditCommandResultSchema, type SupplierCreditCommand, type SourceLineInput } from "@shared/procurement/supplier-credit";
import { supplierReturnCommandResultSchema } from "@shared/procurement/supplier-return";
import { supplierReturnCreditReviewCommandResultSchema } from "@shared/procurement/supplier-return-credit";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import type { FinancialCommandDescriptor, FinancialCommandResult } from "../../../../platform/commands/transactional-command.service";
import type { RecordApPaymentInput } from "../../ap-ledger.service";
import { FLOW_ACTOR, FLOW_AT, FLOW_IDS, type FlowCostHarness } from "./procurement-flow-cost.fixture";
import { installFlowLifecycleWrites } from "./procurement-lifecycle-write.fixture";

interface FlowSettlementScope {
  purchaseOrderId: number;
  purchaseOrderLineId: number;
  shipmentId: number;
}

function identity(scope: { method: string; routeTemplate: string; resourceKey: string; commandName: string },
  body: unknown, key: string, params: Record<string, string> = {}): FinancialCommandDescriptor {
  return { ...scope, actorType: "user", actorId: FLOW_ACTOR, contractVersion: 1,
    idempotencyKey: `controlled-flow-settlement-${key}`,
    requestHash: hashHttpFinancialCommand({ ...scope, body, params, query: {} }) };
}

function succeeded(result: FinancialCommandResult): void {
  expect(result, JSON.stringify(result.body)).toMatchObject({ terminalState: "succeeded" });
}

/** Extend the SAME persisted RFQ/receipt/sale/late-freight scenario through cash,
 * noncash settlement and a physical supplier return. This records synthetic bank
 * evidence; it does not execute a bank transfer or certify deployed integrations. */
export async function verifyFlowSettlementAndReturn(harness: FlowCostHarness, scope: FlowSettlementScope): Promise<void> {
  await installFlowLifecycleWrites(harness);
  // Import owners only after the FLOW harness has redirected legacy module SQL
  // to its exclusively leased local pool. Never initialize an external DB here.
  const [commandModule, paymentModule, creditModule, creditRepository, returnModule,
    returnCommandsModule, reviewModule, reviewRepository, financialModule] = await Promise.all([
    import("../../../../platform/commands/command-results.repository"), import("../../ap-payment-commands"),
    import("../../supplier-credit.commands"), import("../../supplier-credit.repository"),
    import("../../supplier-return.service"), import("../../supplier-return.commands"),
    import("../../supplier-return-difference.commands"), import("../../supplier-return-credit-review.service"),
    import("../../po-financial-evidence.service"),
  ]);
  const repository = commandModule.createDrizzleFinancialCommandRepository(harness.database);
  const payments = paymentModule.createApPaymentCommands(repository, () => FLOW_AT);
  const credits = creditModule.createSupplierCreditCommands(repository, () => FLOW_AT);
  const returns = returnCommandsModule.createSupplierReturnCommands(repository, () => FLOW_AT);
  const returnReader = returnModule.createSupplierReturnReader(harness.database);
  const reviews = reviewModule.createSupplierReturnReviewCommands(repository, () => FLOW_AT);
  const invoices = z.array(z.object({ id: z.number().int().positive(), vendor_id: z.number().int().positive(),
    invoiced_amount_cents: z.coerce.number().int().safe() })).parse((await harness.pool.query(
    "SELECT id,vendor_id,invoiced_amount_cents FROM procurement.vendor_invoices ORDER BY id")).rows);
  expect(invoices).toHaveLength(4);
  expect(invoices.reduce((sum, row) => sum + row.invoiced_amount_cents, 0)).toBe(461_000);
  const [source] = z.array(z.object({ invoice_id: z.number().int().positive(), invoice_line_id: z.number().int().positive() }))
    .length(1).parse((await harness.pool.query(`SELECT il.vendor_invoice_id AS invoice_id,il.id AS invoice_line_id
      FROM procurement.vendor_invoice_lines il WHERE il.purchase_order_line_id=$1`, [scope.purchaseOrderLineId])).rows);
  expect(invoices.find(row => row.id === source.invoice_id)).toMatchObject({ vendor_id: FLOW_IDS.vendor, invoiced_amount_cents: 210_000 });
  const lot = z.object({ id: z.number().int().positive() }).parse((await harness.pool.query(`SELECT id FROM inventory.inventory_lots
    WHERE po_line_id=$1 AND inbound_shipment_id=$2 AND qty_on_hand>0 ORDER BY id LIMIT 1`,
  [scope.purchaseOrderLineId, scope.shipmentId])).rows[0]);

  async function rowsByTable(tables: readonly string[]) {
    return Object.fromEntries(await Promise.all(tables.map(async table =>
      [table, (await harness.pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows] as const)));
  }
  function physical() {
    return rowsByTable(["inventory.inventory_lots", "inventory.inventory_levels", "inventory.inventory_transactions",
      "inventory.supplier_return_allocations", "inventory.supplier_return_cost_entries", "procurement.receiving_lines",
      "procurement.po_receipts", "procurement.rfq_quote_revisions", "procurement.rfq_purchase_order_line_links",
      "oms.order_item_costs"]);
  }
  function originalSourceHistory() {
    // Named source tables avoid a positional slice silently changing the proof
    // when another physical snapshot relation is added later.
    return rowsByTable(["procurement.receiving_lines", "procurement.po_receipts", "procurement.purchase_order_lines",
      "procurement.rfq_quote_revisions", "procurement.rfq_purchase_order_line_links", "oms.order_item_costs"]);
  }
  async function values() {
    const row = (await harness.pool.query(`SELECT
      (SELECT sum(qty_on_hand::numeric*total_unit_cost_mills)::text FROM inventory.inventory_lots WHERE status='active') AS inventory,
      (SELECT sum(total_cost_mills)::text FROM oms.order_item_costs) AS sold,
      (SELECT sum(delta_mills)::text FROM inventory.supplier_return_cost_entries) AS returned`)).rows[0];
    expect(row).toEqual({ inventory: "41300000", sold: "2400000", returned: "2400000" });
    expect(BigInt(row.inventory) + BigInt(row.sold) + BigInt(row.returned)).toBe(BigInt(46_100_000));
  }
  async function settlement(paid: number, credited: number, balance: number) {
    expect(await harness.ap.getInvoiceById(source.invoice_id)).toMatchObject({ invoicedAmountCents: 210_000,
      paidAmountCents: paid, creditedAmountCents: credited, balanceCents: balance });
    expect(await financialModule.createPoFinancialEvidenceService(harness.database).readWorkflow(scope.purchaseOrderId))
      .toMatchObject({ state: balance === 0 ? "settled" : "payment_due", evidence: { state: "complete",
        invoicedAmountCents: 210_000, paidAmountCents: paid, creditedAmountCents: credited,
        outstandingAmountCents: balance, reviewReasons: [] } });
  }

  const sourceHistory = await originalSourceHistory();
  const reviewed = await returnReader.preview({ vendorId: FLOW_IDS.vendor, lines: [{ inventoryLotId: lot.id, quantity: 1 }] }, FLOW_ACTOR);
  const returnBody = { vendorId: FLOW_IDS.vendor, lines: [{ inventoryLotId: lot.id, quantity: 1 }],
    expectedSourceFingerprint: reviewed.sourceFingerprint, returnCalendarDate: "2026-09-10",
    evidenceReference: "FLOW-SUPPLIER-COLLECTION-1", reason: "Supplier collected one verified unsold case" };
  const returnIdentity = identity(returnCommandsModule.SUPPLIER_RETURN_COMMAND_SCOPE, returnBody, "return");
  const returnedResponse = await returns.record(returnBody, returnIdentity);
  succeeded(returnedResponse);
  const returned = supplierReturnCommandResultSchema.parse(returnedResponse.body).return;
  expect(returned.lines[0].currentCosts).toEqual({ productMills: 2_000_000, packagingMills: 100_000, landedMills: 300_000, totalMills: 2_400_000 });
  expect(await originalSourceHistory()).toEqual(sourceHistory);
  const afterReturn = await physical();
  await values();
  const returnReplay = await returns.record(returnBody, returnIdentity);
  expect(returnReplay).toMatchObject({ replayed: true, body: returnedResponse.body });
  expect(await physical()).toEqual(afterReturn);

  async function credit(command: SupplierCreditCommand, body: unknown, key: string, creditId?: number, applicationId?: number) {
    const routeTemplate = command === "create" ? "/api/supplier-credits" : command === "apply" ? "/api/supplier-credits/:id/applications"
      : command === "reverse" ? "/api/supplier-credits/:id/applications/:applicationId/reverse" : `/api/supplier-credits/:id/${command}`;
    const params: Record<string, string> = creditId === undefined ? {} : { id: String(creditId) };
    if (applicationId !== undefined) params.applicationId = String(applicationId);
    const descriptor = identity({ method: "POST", routeTemplate, resourceKey: `supplier-credit:${creditId ?? "new"}:${applicationId ?? "document"}`,
      commandName: `supplier_credit.${command}` }, body, key, params);
    const response = await credits.execute(command, body, descriptor, creditId, applicationId);
    succeeded(response);
    return { value: supplierCreditCommandResultSchema.parse(response.body), response, replay: () => credits.execute(command, body, descriptor, creditId, applicationId) };
  }
  async function creditDetail(id: number) {
    return harness.database.transaction(tx => creditRepository.readSupplierCreditDetail(tx, id, true));
  }
  async function createReturnCredit(key: string, entitlementId?: number, replacesCreditId?: number) {
    const original = await harness.database.transaction(tx => creditRepository.loadSupplierCreditSource(tx, source.invoice_id));
    const lines: SourceLineInput[] = ([{ component: "product", amountCents: 20_000 }, { component: "packaging", amountCents: 1_000 }] as const)
      .map(line => ({ invoiceLineId: source.invoice_line_id, amountCents: line.amountCents,
        disposition: { kind: "accepted_stock_return", supplierReturnLineId: returned.lines[0].id, quantity: 1,
          evidenceReference: returnBody.evidenceReference, component: line.component, ...(entitlementId ? { entitlementId } : {}) } }));
    const draft = await credit("create", { sourceInvoiceId: source.invoice_id, expectedSourceVersion: original.version,
      supplierReference: "FLOW-RETURN-NOTE-1", creditCalendarDate: "2026-09-10", reason: "Supplier credited product and packaging for this collection",
      lines, ...(replacesCreditId ? { replacesCreditId } : {}) }, `${key}-create`);
    return (await credit("approve", { expectedVersion: draft.value.credit.version, reason: "Reviewed supplier note against actual collected stock" },
      `${key}-approve`, draft.value.creditId)).value.credit;
  }
  const approved = await createReturnCredit("original");
  const applied = await credit("apply", { expectedVersion: approved.version, reason: "Apply supplier note to its original invoice",
    allocations: [{ vendorInvoiceId: source.invoice_id, appliedAmountCents: 21_000 }] }, "original-apply", approved.id);
  await settlement(0, 21_000, 189_000);
  expect(await physical()).toEqual(afterReturn);

  async function recordPayment(vendorId: number, totalAmountCents: number,
    allocations: RecordApPaymentInput["allocations"], key: string) {
    const payment: RecordApPaymentInput = { vendorId, totalAmountCents, allocations, currency: "USD", paymentMethod: "wire",
      paymentDate: new Date("2026-09-10T00:00:00.000Z"), paymentCalendarDate: "2026-09-10",
      referenceNumber: `FLOW-BANK-${key}`, createdBy: FLOW_ACTOR };
    const descriptor = identity({ method: "POST", routeTemplate: "/api/ap-payments", resourceKey: `vendor:${vendorId}`,
      commandName: "ap.payment.record" }, { ...payment, paymentDate: payment.paymentDate.toISOString() }, key);
    const response = await payments.recordPayment({ payment, userId: FLOW_ACTOR }, descriptor);
    succeeded(response);
    return { value: recordPaymentResultSchema.parse(response.body), response,
      replay: () => payments.recordPayment({ payment, userId: FLOW_ACTOR }, descriptor) };
  }
  const advance = await recordPayment(FLOW_IDS.vendor, 189_000, [], "advance");
  expect(advance.value.paymentBalance).toMatchObject({ appliedAmountCents: 0, unappliedAmountCents: 189_000 });
  await settlement(0, 21_000, 189_000);
  let version = advance.value.paymentBalance.version;
  for (const [index, cents] of [100_000, 89_000].entries()) {
    const application = { expectedVersion: version, reason: "Apply existing supplier advance without recording new cash",
      allocations: [{ vendorInvoiceId: source.invoice_id, appliedAmountCents: cents }] };
    const descriptor = identity({ method: "POST", routeTemplate: "/api/ap-payments/:id/applications",
      resourceKey: `ap_payment:${advance.value.paymentId}`, commandName: "ap.payment.apply" }, application, `advance-apply-${index}`,
    { id: String(advance.value.paymentId) });
    const response = await payments.applyPayment(advance.value.paymentId, { application }, descriptor);
    succeeded(response);
    const value = paymentApplicationResultSchema.parse(response.body);
    version = value.paymentBalance.version;
    expect(await payments.applyPayment(advance.value.paymentId, { application }, descriptor))
      .toMatchObject({ replayed: true, body: response.body });
    await settlement(index === 0 ? 100_000 : 189_000, 21_000, index === 0 ? 89_000 : 0);
  }
  // Other invoices keep their actual supplier: the freight provider is distinct
  // from the merchandise vendor; an unrelated payable is never cross-applied.
  for (const vendorId of [FLOW_IDS.vendor, FLOW_IDS.freightVendor]) {
    const remaining = invoices.filter(invoice => invoice.id !== source.invoice_id && invoice.vendor_id === vendorId);
    expect(remaining).toHaveLength(vendorId === FLOW_IDS.vendor ? 1 : 2);
    await recordPayment(vendorId, remaining.reduce((sum, invoice) => sum + invoice.invoiced_amount_cents, 0),
      remaining.map(invoice => ({ vendorInvoiceId: invoice.id, appliedAmountCents: invoice.invoiced_amount_cents })), `remaining-${vendorId}`);
  }
  expect(await advance.replay()).toMatchObject({ replayed: true, body: advance.response.body });
  expect(await applied.replay()).toMatchObject({ replayed: true, body: applied.response.body });
  await settlement(189_000, 21_000, 0);

  // Explicit reversal and replacement retain the supplier note and its original
  // application. Neither is permission to collect or remove the stock again.
  const applicationId = applied.value.applicationIds[0];
  const reversed = await credit("reverse", { expectedVersion: (await creditDetail(approved.id)).version,
    reason: "Reverse application before replacing the supplier note" }, "original-reverse", approved.id, applicationId);
  await settlement(189_000, 0, 21_000);
  await credit("void", { expectedVersion: reversed.value.credit.version, reason: "Supplier replaced the original note" }, "original-void", approved.id);
  const [entitlement] = z.array(z.object({ id: z.number().int().positive(), quantity: z.number() })).length(1)
    .parse((await harness.pool.query("SELECT id,quantity FROM procurement.supplier_return_credit_entitlements")).rows);
  expect(entitlement.quantity).toBe(1);
  const replacement = await createReturnCredit("replacement", entitlement.id, approved.id);
  await credit("apply", { expectedVersion: replacement.version, reason: "Apply replacement document to the same original invoice",
    allocations: [{ vendorInvoiceId: source.invoice_id, appliedAmountCents: 21_000 }] }, "replacement-apply", replacement.id);
  await settlement(189_000, 21_000, 0);
  expect((await creditDetail(approved.id)).applications[0]).toMatchObject({ id: applicationId, appliedAmountCents: 21_000, reversal: expect.any(Object) });

  // The merchandise supplier did not credit the separate freight provider's $30.
  // Keep that difference visible; recording the supplier's decision is not cash,
  // inventory value, a second credit, or an unexplained balancing adjustment.
  const difference = await harness.database.transaction(tx => reviewRepository.readSupplierReturnEntitlementReview(tx, entitlement.id));
  expect(difference.differences).toMatchObject({ productMills: 0, packagingMills: 0, landedMills: 300_000, totalMills: 300_000 });
  const reviewBody = { expectedVersion: difference.version, reason: "Supplier declined reimbursement of the separately invoiced freight",
    evidenceReference: "FLOW-SUPPLIER-DECISION-1", disposition: "supplier_declined" as const, assignments: [] };
  const reviewIdentity = identity(reviewModule.SUPPLIER_RETURN_REVIEW_COMMAND_SCOPE, reviewBody, "difference-review", { id: String(entitlement.id) });
  const reviewedDifference = await reviews.review(entitlement.id, reviewBody, reviewIdentity);
  succeeded(reviewedDifference);
  expect(supplierReturnCreditReviewCommandResultSchema.parse(reviewedDifference.body).review)
    .toMatchObject({ reviewCurrent: true, differences: { totalMills: 300_000 } });
  expect(await reviews.review(entitlement.id, reviewBody, reviewIdentity)).toMatchObject({ replayed: true, body: reviewedDifference.body });
  expect(await physical()).toEqual(afterReturn);
  await values();
  expect((await harness.pool.query(`SELECT sum(total_amount_cents)::text AS cash,count(*)::int AS payments
    FROM procurement.ap_payments WHERE status='completed'`)).rows).toEqual([{ cash: "440000", payments: 3 }]);
  expect((await harness.pool.query(`SELECT sum(invoiced_amount_cents)::text AS gross,sum(paid_amount_cents)::text AS cash,
    sum(credited_amount_cents)::text AS credit,sum(balance_cents)::text AS balance FROM procurement.vendor_invoices`)).rows)
    .toEqual([{ gross: "461000", cash: "440000", credit: "21000", balance: "0" }]);
  expect((await harness.pool.query(`SELECT count(*)::int AS count FROM procurement.supplier_returns`)).rows).toEqual([{ count: 1 }]);
  expect(await originalSourceHistory()).toEqual(sourceHistory);
  await verifyReadModelAgreement();
  console.info(JSON.stringify({ event: "procurement.controlled_settlement.proven", purchaseOrderId: scope.purchaseOrderId,
    invoiceId: source.invoice_id, returnId: returned.id, originalCreditId: approved.id, replacementCreditId: replacement.id,
    grossCents: 461_000, cashCents: 440_000, creditCents: 21_000, outstandingCents: 0, returnFreightDifferenceMills: 300_000,
    authority: "pre_opening_legacy", bankTransfer: "not_executed" }));

  async function verifyReadModelAgreement() {
    const invoicePage = await harness.ap.listInvoiceWorkList(invoiceWorkListQuerySchema.parse({}), FLOW_AT);
    expect(invoicePage).toMatchObject({ total: 4, nextOffset: null });
    expect(invoicePage.items.map(invoice => ({ id: invoice.id, gross: invoice.invoicedAmountCents,
      cash: invoice.paidAmountCents, credit: invoice.creditedAmountCents, balance: invoice.balanceCents,
      review: invoice.settlementReviewRequired })).sort((left, right) => left.id - right.id))
      .toEqual(invoices.map(invoice => ({ id: invoice.id, gross: invoice.invoiced_amount_cents,
        cash: invoice.invoiced_amount_cents - (invoice.id === source.invoice_id ? 21_000 : 0),
        credit: invoice.id === source.invoice_id ? 21_000 : 0, balance: 0, review: false })));
    const links = z.array(z.object({ purchase_order_id: z.number().int().positive() })).length(2)
      .parse((await harness.pool.query("SELECT DISTINCT purchase_order_id FROM procurement.vendor_invoice_po_links ORDER BY purchase_order_id")).rows);
    for (const link of links) {
      const credited = link.purchase_order_id === scope.purchaseOrderId ? 21_000 : 0;
      expect(await financialModule.createPoFinancialEvidenceService(harness.database).readWorkflow(link.purchase_order_id))
        .toMatchObject({ state: "settled", evidence: { state: "complete", invoicedAmountCents: 210_000,
          paidAmountCents: 210_000 - credited, creditedAmountCents: credited, outstandingAmountCents: 0, reviewReasons: [] } });
    }
    const paymentPage = await harness.ap.listPaymentWorkList(paymentWorkListQuerySchema.parse({}));
    expect(paymentPage).toMatchObject({ total: 3, nextOffset: null });
    expect(paymentPage.items.map(payment => payment.totalAmountCents).sort((left, right) => left - right))
      .toEqual([41_000, 189_000, 210_000]);
    for (const payment of paymentPage.items) {
      expect(payment.paymentBalance).toMatchObject({ state: "fully_applied", appliedAmountCents: payment.totalAmountCents,
        unappliedAmountCents: 0, issue: null });
      expect(await harness.ap.getPaymentById(payment.id)).toMatchObject({ id: payment.id, paymentBalance: payment.paymentBalance });
    }
    const { createSupplierCreditReader } = await import("../../supplier-credit.service");
    const creditPage = await createSupplierCreditReader(() => FLOW_AT).list({ invoiceId: source.invoice_id }, FLOW_ACTOR);
    expect(creditPage).toMatchObject({ total: 2, nextOffset: null });
    expect(creditPage.items.find(item => item.id === approved.id)).toMatchObject({ status: "voided", appliedAmountCents: 0,
      applications: [expect.objectContaining({ id: applicationId, reversal: expect.any(Object) })] });
    expect(creditPage.items.find(item => item.id === replacement.id)).toMatchObject({ status: "approved", replacesCreditId: approved.id,
      appliedAmountCents: 21_000, unappliedAmountCents: 0 });
  }
}
