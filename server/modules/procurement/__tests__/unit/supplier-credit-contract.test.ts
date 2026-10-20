import { describe, expect, it, vi } from "vitest";
import { assertInvoiceSettlementEvidence, readVerifiedInvoiceSettlementProjections } from "../../supplier-credit-settlement.repository";
import type { ApLedgerDbClient } from "../../ap-ledger.service";
import { supplierCreditCreateInputSchema, supplierCreditApplyInputSchema, supplierCreditDetailSchema } from "@shared/procurement/supplier-credit";
import { sumInvoiceCredits, type InvoiceCreditEvidence } from "../../domain/invoice-credit-evidence";
import { deriveInvoiceFinancialState } from "../../domain/invoice-financial-state";
import { buildPoFinancialEvidence, type PoFinancialInvoiceEvidence } from "../../domain/po-financial-evidence";
import { projectInvoiceSettlement } from "@shared/procurement/invoice-settlement";
const line = {
  invoiceLineId: 2,
  amountCents: 100,
  disposition: {
    kind: "price_reduction",
    component: "product"
  }
};
const create = {
  sourceInvoiceId: 1,
  expectedSourceVersion: "a".repeat(64),
  supplierReference: " CREDIT-1 ",
  creditCalendarDate: "2026-10-19",
  reason: "Supplier approved correction",
  lines: [line]
};
const evidence: InvoiceCreditEvidence = {
  allocationId: 10,
  creditId: 3,
  creditVendorId: 5,
  creditCurrency: "USD",
  creditStatus: "approved",
  creditTotalAmountCents: 300,
  creditAppliedAmountCents: 100,
  appliedAmountCents: 100,
  reversalId: null,
  evidenceValid: true
};
function invoice(overrides: Partial<PoFinancialInvoiceEvidence> = {}): PoFinancialInvoiceEvidence {
  return {
    id: 1,
    vendorId: 5,
    currency: "USD",
    status: "partially_paid",
    invoicedAmountCents: 1000,
    paidAmountCents: 200,
    creditedAmountCents: 100,
    balanceCents: 700,
    links: [{
      purchaseOrderId: 7,
      purchaseOrderVendorId: 5,
      purchaseOrderCurrency: "USD"
    }],
    lines: [{
      id: 2,
      purchaseOrderLineId: 8,
      purchaseOrderId: 7,
      freightCostId: null,
      lineTotalCents: 1000
    }],
    payments: [{
      allocationId: 4,
      paymentId: 9,
      paymentVendorId: 5,
      paymentCurrency: "USD",
      paymentStatus: "completed",
      appliedAmountCents: 200
    }],
    credits: [evidence],
    ...overrides
  };
}
describe("supplier credit document contracts", () => {
  it("normalizes reference whitespace without inventing case folding", () => expect(supplierCreditCreateInputSchema.parse(create).supplierReference).toBe("CREDIT-1"));
  it("accepts separate product and packaging corrections on one original invoice row", () => expect(supplierCreditCreateInputSchema.safeParse({
    ...create,
    lines: [line, {
      ...line,
      disposition: {
        kind: "price_reduction",
        component: "packaging"
      }
    }]
  }).success).toBe(true));
  it("rejects repeated source components", () => expect(supplierCreditCreateInputSchema.safeParse({
    ...create,
    lines: [line, line]
  }).success).toBe(false));
  it.each([0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid source cents %s without throwing", amount => expect(supplierCreditCreateInputSchema.safeParse({
    ...create,
    lines: [{
      ...line,
      amountCents: amount
    }]
  }).success).toBe(false));
  it("rejects total overflow across individually valid lines", () => expect(supplierCreditCreateInputSchema.safeParse({
    ...create,
    lines: [{
      ...line,
      amountCents: Number.MAX_SAFE_INTEGER
    }, {
      ...line,
      invoiceLineId: 3,
      amountCents: 1
    }]
  }).success).toBe(false));
  it.each(["2026-02-30", "2026-10-19T12:00:00Z", "10/19/2026"])("requires an actual explicit calendar date %s", creditCalendarDate => expect(supplierCreditCreateInputSchema.safeParse({
    ...create,
    creditCalendarDate
  }).success).toBe(false));
  it("rejects undeclared return paths", () => expect(supplierCreditCreateInputSchema.safeParse({
    ...create,
    lines: [{
      ...line,
      disposition: {
        kind: "accepted_stock_return",
        quantity: 1
      }
    }]
  }).success).toBe(false));
  it("requires explicit quarantine disposition and reference", () => expect(supplierCreditCreateInputSchema.safeParse({
    ...create,
    lines: [{
      ...line,
      disposition: {
        kind: "quarantine_return",
        returnDispositionId: 8,
        quantity: 1,
        evidenceReference: "RETURN-8"
      }
    }]
  }).success).toBe(true));
  it.each([0, -1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid application %s without BigInt exceptions", appliedAmountCents => expect(supplierCreditApplyInputSchema.safeParse({
    expectedVersion: "b".repeat(64),
    reason: "Apply credit",
    allocations: [{
      vendorInvoiceId: 1,
      appliedAmountCents
    }]
  }).success).toBe(false));
  it("rejects duplicate target invoices", () => expect(supplierCreditApplyInputSchema.safeParse({
    expectedVersion: "b".repeat(64),
    reason: "Apply credit",
    allocations: [{
      vendorInvoiceId: 1,
      appliedAmountCents: 1
    }, {
      vendorInvoiceId: 1,
      appliedAmountCents: 2
    }]
  }).success).toBe(false));
});
describe("noncash settlement evidence", () => {
  it("adds unique repeated applications of one credit and ignores retained reversals", () => expect(sumInvoiceCredits([evidence, {
    ...evidence,
    allocationId: 11,
    appliedAmountCents: 20
  }, {
    ...evidence,
    allocationId: 12,
    reversalId: 2,
    appliedAmountCents: 30
  }], 5, "USD")).toBe(120));
  it.each([{
    allocationId: 10
  }, {
    creditVendorId: 6
  }, {
    creditCurrency: "EUR"
  }, {
    creditStatus: "voided"
  }, {
    creditAppliedAmountCents: 301
  }, {
    evidenceValid: false
  }, {
    appliedAmountCents: -1
  }, {
    appliedAmountCents: 0.2
  }])("rejects incompatible evidence %j", patch => expect(sumInvoiceCredits([evidence, {
    ...evidence,
    allocationId: 11,
    ...patch
  }], 5, "USD")).toBeNull());
  it("retains reversed voided document history without spending it", () => expect(sumInvoiceCredits([{
    ...evidence,
    creditStatus: "voided",
    reversalId: 9,
    creditAppliedAmountCents: 0
  }], 5, "USD")).toBe(0));
  it("settles by credit without creating cash", () => expect(deriveInvoiceFinancialState({
    status: "approved",
    invoiceAmountCents: 1000,
    paidAmountCents: 0,
    creditedAmountCents: 1000
  })).toEqual({
    status: "paid",
    balanceCents: 0
  }));
  it("keeps disputed status while reducing its true payable", () => expect(deriveInvoiceFinancialState({
    status: "disputed",
    invoiceAmountCents: 1000,
    paidAmountCents: 200,
    creditedAmountCents: 100
  })).toEqual({
    status: "disputed",
    balanceCents: 700
  }));
  it("projects exact canonical PO cash, credit, settled and outstanding separately", () => expect(buildPoFinancialEvidence({
    purchaseOrderId: 7,
    vendorId: 5,
    currency: "USD",
    invoices: [invoice()]
  })).toMatchObject({
    state: "complete",
    invoicedAmountCents: 1000,
    paidAmountCents: 200,
    creditedAmountCents: 100,
    settledAmountCents: 300,
    outstandingAmountCents: 700
  }));
  it("fails closed on stale credit caches", () => expect(buildPoFinancialEvidence({
    purchaseOrderId: 7,
    vendorId: 5,
    currency: "USD",
    invoices: [invoice({
      creditedAmountCents: 0
    })]
  }).state).toBe("review_required"));
  it("does not infer a mixed cash/credit split across multiple POs", () => {
    const source = invoice({
      status: "paid",
      creditedAmountCents: 800,
      balanceCents: 0,
      credits: [{
        ...evidence,
        creditTotalAmountCents: 800,
        creditAppliedAmountCents: 800,
        appliedAmountCents: 800
      }]
    });
    source.links = [...source.links, {
      purchaseOrderId: 8,
      purchaseOrderVendorId: 5,
      purchaseOrderCurrency: "USD"
    }];
    source.lines = [{
      ...source.lines[0],
      lineTotalCents: 500
    }, {
      ...source.lines[0],
      id: 3,
      purchaseOrderId: 8,
      lineTotalCents: 500
    }];
    expect(buildPoFinancialEvidence({
      purchaseOrderId: 7,
      vendorId: 5,
      currency: "USD",
      invoices: [source]
    })).toMatchObject({
      state: "review_required",
      paidAmountCents: null,
      creditedAmountCents: null
    });
  });
  it("keeps a retained cash overpayment readable and explicitly flagged", () => {
    expect(projectInvoiceSettlement({ invoicedAmountCents: 3000, paidAmountCents: 3100, creditedAmountCents: 0, balanceCents: 0 }))
      .toEqual({ creditedAmountCents: 0, settledAmountCents: 3100, overpaidAmountCents: 100, settlementReviewRequired: true });
  });
  it("does not extend the legacy cash exception to oversettled supplier credits", () => {
    expect(() => projectInvoiceSettlement({ invoicedAmountCents: 3000, paidAmountCents: 3000, creditedAmountCents: 100, balanceCents: 0 })).toThrow();
  });
  it("does not invent missing read credit evidence", () => expect(() => projectInvoiceSettlement({
    invoicedAmountCents: 1000,
    paidAmountCents: 200,
    balanceCents: 800
  })).toThrow());
  it("rejects malformed read conservation", () => expect(() => projectInvoiceSettlement({
    invoicedAmountCents: 1000,
    paidAmountCents: 200,
    creditedAmountCents: 100,
    balanceCents: 800
  })).toThrow());
});


describe("retained invoice settlement evidence", () => {
  const invoice = { id: 71, vendorId: 5, currency: "USD", status: "paid", invoicedAmountCents: 3000,
    paidAmountCents: 3100, creditedAmountCents: 0, balanceCents: 0 };
  function fixture(cash = 3100, paymentStatus = "completed") {
    function query<T>(rows: T[]) {
      const promise = Promise.resolve(rows);
      const result = { from: () => result, leftJoin: () => result, where: () => result,
        orderBy: () => promise, then: promise.then.bind(promise) };
      return result;
    }
    const select = vi.fn()
      .mockReturnValueOnce(query([{ payment: { id: 1, vendorId: 5, currency: "USD", status: paymentStatus, totalAmountCents: 3100 }, amount: cash }]))
      .mockReturnValueOnce(query([{ id: 1, apPaymentId: 1, vendorInvoiceId: 71, appliedAmountCents: cash,
        invoiceVendorId: 5, invoiceCurrency: "USD", invoiceStatus: "paid" }]));
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    return { select, execute } as unknown as ApLedgerDbClient;
  }
  it("keeps a verified legacy overpayment readable without authorizing additional settlement", async () => {
    expect((await readVerifiedInvoiceSettlementProjections(fixture(), [invoice])).get(71))
      .toMatchObject({ overpaidAmountCents: 100, settlementReviewRequired: true, settledAmountCents: 3100 });
    await expect(assertInvoiceSettlementEvidence(fixture(), invoice))
      .rejects.toMatchObject({ details: { code: "AP_INVOICE_PAYMENT_EVIDENCE_REVIEW" } });
  });
  it.each(["scheduled", "returned", "unsupported_legacy_status"])("preserves the legacy payment status classification for %s", async paymentStatus => {
    await expect(assertInvoiceSettlementEvidence(fixture(3100, paymentStatus), invoice))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "AP_PAYMENT_STATUS_REVIEW_REQUIRED" } });
  });
  it("retains a negative voided document only for read review and never as spendable settlement", async () => {
    const historical = { ...invoice, status: "voided", invoicedAmountCents: -1000, paidAmountCents: 0 };
    expect((await readVerifiedInvoiceSettlementProjections(fixture(), [historical])).get(historical.id))
      .toEqual({ creditedAmountCents: 0, settledAmountCents: 0, overpaidAmountCents: 0, settlementReviewRequired: true });
    await expect(assertInvoiceSettlementEvidence(fixture(), historical))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "AP_INVOICE_PAYMENT_EVIDENCE_REVIEW" } });
  });
  it.each([{ status: undefined }, { status: "approved" }, { paidAmountCents: 1 }, { creditedAmountCents: 1 }, { balanceCents: 1 }, { invoicedAmountCents: -Number.MAX_SAFE_INTEGER - 1 }])(
    "does not broaden the negative voided read exception for %j", patch => {
      expect(() => projectInvoiceSettlement({ ...invoice, status: "voided", invoicedAmountCents: -1000, paidAmountCents: 0, ...patch })).toThrow();
    });
  it("does not present an unverified cached overpayment as confirmed cash", async () => {
    await expect(readVerifiedInvoiceSettlementProjections(fixture(3000), [invoice]))
      .rejects.toMatchObject({ details: { code: "AP_INVOICE_PAYMENT_EVIDENCE_REVIEW" } });
  });
  it("preserves the cash evidence error contract for malformed retained payment applications", async () => {
    await expect(assertInvoiceSettlementEvidence(fixture(-1), invoice))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "AP_INVOICE_PAYMENT_EVIDENCE_REVIEW" } });
  });
});
