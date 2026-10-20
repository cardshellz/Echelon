import { describe, expect, it } from "vitest";
import {
  poFinancialEvidenceSchema,
  poFinancialEvidenceIdSchema,
} from "@shared/procurement/po-financial-evidence";
import {
  buildPoFinancialEvidence,
  type PoFinancialEvidenceInput,
  type PoFinancialInvoiceEvidence,
  type PoFinancialPaymentEvidence,
} from "../../domain/po-financial-evidence";

function payment(
  overrides: Partial<PoFinancialPaymentEvidence> = {},
): PoFinancialPaymentEvidence {
  return {
    allocationId: 70,
    paymentId: 80,
    paymentVendorId: 9,
    paymentCurrency: "USD",
    paymentStatus: "completed",
    appliedAmountCents: 10000,
    ...overrides,
  };
}
function invoice(
  overrides: Partial<PoFinancialInvoiceEvidence> = {},
): PoFinancialInvoiceEvidence {
  return {
    id: 50,
    vendorId: 9,
    currency: "USD",
    status: "approved",
    invoicedAmountCents: 30000,
    paidAmountCents: 0,
    balanceCents: 30000,
    links: [
      {
        purchaseOrderId: 1,
        purchaseOrderVendorId: 9,
        purchaseOrderCurrency: "USD",
      },
      {
        purchaseOrderId: 2,
        purchaseOrderVendorId: 9,
        purchaseOrderCurrency: "USD",
      },
    ],
    lines: [
      {
        id: 60,
        purchaseOrderLineId: 10,
        purchaseOrderId: 1,
        freightCostId: null,
        lineTotalCents: 10000,
      },
      {
        id: 61,
        purchaseOrderLineId: 11,
        purchaseOrderId: 2,
        freightCostId: null,
        lineTotalCents: 20000,
      },
    ],
    payments: [],
    ...overrides,
  };
}
function input(
  invoices: PoFinancialInvoiceEvidence[] = [invoice()],
): PoFinancialEvidenceInput {
  return { purchaseOrderId: 1, vendorId: 9, currency: "USD", invoices };
}
function withPayment(
  value: number,
  source = invoice(),
): PoFinancialInvoiceEvidence {
  const amount = Number(source.invoicedAmountCents);
  return {
    ...source,
    status: value === amount ? "paid" : "partially_paid",
    paidAmountCents: value,
    balanceCents: amount - value,
    payments: [payment({ appliedAmountCents: value })],
  };
}
function soleOwner(): PoFinancialInvoiceEvidence {
  const source = invoice();
  return {
    ...source,
    links: [source.links[0]],
    lines: [source.lines[0]],
    invoicedAmountCents: 10000,
    balanceCents: 10000,
  };
}
function expectReview(
  source: PoFinancialEvidenceInput,
  code: string,
  billed: number | null = null,
): void {
  const result = buildPoFinancialEvidence(source);
  expect(result).toMatchObject({
    state: "review_required",
    invoicedAmountCents: billed,
    paidAmountCents: null,
    outstandingAmountCents: null,
  });
  expect(result.reviewReasons).toContainEqual(
    expect.objectContaining({ code }),
  );
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe("PO financial evidence", () => {
  it("reports each PO's mapped value without duplicating the shared invoice total", () => {
    const first = buildPoFinancialEvidence(input());
    const second = buildPoFinancialEvidence({ ...input(), purchaseOrderId: 2 });
    expect(first).toEqual({
      purchaseOrderId: 1,
      currency: "USD",
      state: "complete",
      invoicedAmountCents: 10000,
      paidAmountCents: 0, creditedAmountCents:0,settledAmountCents:0,
      outstandingAmountCents: 10000,
      invoiceCount: 1,
      reviewReasons: [],
    });
    expect(second).toMatchObject({
      state: "complete",
      invoicedAmountCents: 20000,
      paidAmountCents: 0,
      outstandingAmountCents: 20000,
    });
    expect(first.invoicedAmountCents! + second.invoicedAmountCents!).toBe(
      30000,
    );
  });
  it("returns explicit zero for no active invoices and ignores voided history", () => {
    const result = buildPoFinancialEvidence(
      input([
        {
          ...invoice(),
          status: "voided",
          currency: null,
          invoicedAmountCents: null,
        },
      ]),
    );
    expect(result).toMatchObject({
      state: "complete",
      invoiceCount: 0,
      invoicedAmountCents: 0,
      paidAmountCents: 0,
      outstandingAmountCents: 0,
    });
    expect(buildPoFinancialEvidence(input([]))).toEqual(result);
  });
  it("preserves an explicitly recorded zero-value invoice", () => {
    expect(
      buildPoFinancialEvidence(
        input([
          invoice({ invoicedAmountCents: 0, balanceCents: 0, lines: [] }),
        ]),
      ),
    ).toMatchObject({
      state: "complete",
      invoiceCount: 1,
      invoicedAmountCents: 0,
      paidAmountCents: 0,
      outstandingAmountCents: 0,
    });
  });
  it("keeps shared partial settlement unknown while reporting exact mapped billing", () => {
    const source = input([withPayment(10000)]);
    expectReview(source, "PO_SHARED_INVOICE_PARTIAL_PAYMENT", 10000);
    expectReview(
      { ...source, purchaseOrderId: 2 },
      "PO_SHARED_INVOICE_PARTIAL_PAYMENT",
      20000,
    );
  });
  it("derives a partial settlement when the complete invoice has one owner", () => {
    expect(
      buildPoFinancialEvidence(input([withPayment(4000, soleOwner())])),
    ).toMatchObject({
      state: "complete",
      invoicedAmountCents: 10000,
      paidAmountCents: 4000,
      outstandingAmountCents: 6000,
    });
  });
  it("does not confuse an extra zero-valued PO link with another settlement bucket", () => {
    const source = withPayment(4000, {
      ...soleOwner(),
      links: invoice().links,
    });
    expect(buildPoFinancialEvidence(input([source]))).toMatchObject({
      state: "complete",
      paidAmountCents: 4000,
      outstandingAmountCents: 6000,
    });
    expect(
      buildPoFinancialEvidence({ ...input([source]), purchaseOrderId: 2 }),
    ).toMatchObject({
      state: "complete",
      invoicedAmountCents: 0,
      paidAmountCents: 0,
      outstandingAmountCents: 0,
    });
  });
  it("derives a fully settled conserved invoice without reconstructing individual PO remittances", () => {
    const source = withPayment(30000);
    source.payments = [
      payment({ appliedAmountCents: 12345 }),
      payment({ allocationId: 71, paymentId: 81, appliedAmountCents: 17655 }),
    ];
    expect(buildPoFinancialEvidence(input([source]))).toMatchObject({
      state: "complete",
      invoicedAmountCents: 10000,
      paidAmountCents: 10000,
      outstandingAmountCents: 0,
    });
    expect(
      buildPoFinancialEvidence({ ...input([source]), purchaseOrderId: 2 }),
    ).toMatchObject({ paidAmountCents: 20000, outstandingAmountCents: 0 });
  });
  it("preserves signed recorded credits within a nonnegative PO bucket", () => {
    const source = soleOwner();
    source.lines = [
      ...source.lines,
      { ...source.lines[0], id: 62, lineTotalCents: -300 },
    ];
    source.invoicedAmountCents = 9700;
    source.balanceCents = 9700;
    expect(buildPoFinancialEvidence(input([source]))).toMatchObject({
      state: "complete",
      invoicedAmountCents: 9700,
      paidAmountCents: 0,
      outstandingAmountCents: 9700,
    });
    expect(
      buildPoFinancialEvidence(input([withPayment(9700, source)])),
    ).toMatchObject({
      state: "complete",
      paidAmountCents: 9700,
      outstandingAmountCents: 0,
    });
  });
  it.each([0, 19900])(
    "requires settlement review for negative net PO buckets with %i paid",
    (paid) => {
      const source = invoice({
        invoicedAmountCents: 19900,
        balanceCents: 19900,
      });
      source.lines = [
        { ...source.lines[0], lineTotalCents: -100 },
        source.lines[1],
      ];
      const settled = paid ? withPayment(paid, source) : source;
      expectReview(
        input([settled]),
        "PO_SIGNED_SETTLEMENT_REVIEW_REQUIRED",
        -100,
      );
      expectReview(
        { ...input([settled]), purchaseOrderId: 2 },
        "PO_SIGNED_SETTLEMENT_REVIEW_REQUIRED",
        20000,
      );
    },
  );
  it("does not net a positive PO against another PO's credit into a zero settlement", () => {
    const source = invoice({ invoicedAmountCents: 0, balanceCents: 0 });
    source.lines = [
      source.lines[0],
      { ...source.lines[1], lineTotalCents: -10000 },
    ];
    expectReview(
      input([source]),
      "PO_SIGNED_SETTLEMENT_REVIEW_REQUIRED",
      10000,
    );
  });
  it("keeps multiple lines for one PO line legitimate and uses recorded extended amounts", () => {
    const source = soleOwner();
    source.lines = [
      { ...source.lines[0], lineTotalCents: 3333 },
      { ...source.lines[0], id: 62, lineTotalCents: 6667 },
    ];
    expect(buildPoFinancialEvidence(input([source]))).toMatchObject({
      state: "complete",
      invoicedAmountCents: 10000,
    });
  });
  it.each(["EUR", "usd", "", " USD "])(
    "preserves unsupported source currency %j without inventing USD",
    (currency) => {
      const source = { ...input(), currency };
      expectReview(source, "PO_FINANCIAL_CURRENCY_UNSUPPORTED");
      expect(buildPoFinancialEvidence(source).currency).toBe(currency);
    },
  );
  it.each([
    { vendorId: null },
    { vendorId: 10 },
    { currency: null },
    { currency: "EUR" },
  ])("rejects invoice ownership mismatch %j", (override) => {
    expectReview(input([invoice(override)]), "PO_INVOICE_OWNERSHIP_INVALID");
  });
  it("requires the target PO link and consistent vendor/currency for every linked PO", () => {
    const source = invoice();
    for (const links of [
      [source.links[1]],
      [source.links[0], { ...source.links[1], purchaseOrderVendorId: null }],
      [source.links[0], { ...source.links[1], purchaseOrderCurrency: "EUR" }],
      [source.links[0], source.links[0]],
    ]) {
      expectReview(
        input([{ ...source, links }]),
        "PO_INVOICE_OWNERSHIP_INVALID",
      );
    }
  });
  it.each([
    { purchaseOrderLineId: null },
    { purchaseOrderId: null },
    { freightCostId: 99 },
  ])(
    "does not infer ownership for unmapped or conflicting source lines %j",
    (override) => {
      const source = invoice();
      source.lines = [{ ...source.lines[0], ...override }, source.lines[1]];
      expectReview(input([source]), "PO_INVOICE_LINE_UNASSIGNED");
    },
  );
  it("rejects a PO line owned by an unlinked PO or with conflicting owners", () => {
    const source = invoice();
    expectReview(
      input([
        {
          ...source,
          lines: [{ ...source.lines[0], purchaseOrderId: 3 }, source.lines[1]],
        },
      ]),
      "PO_INVOICE_OWNERSHIP_INVALID",
    );
    expectReview(
      input([
        {
          ...source,
          lines: [
            source.lines[0],
            { ...source.lines[1], purchaseOrderLineId: 10 },
          ],
        },
      ]),
      "PO_INVOICE_OWNERSHIP_INVALID",
    );
  });
  it.each([29999, 30001])(
    "requires line-to-header conservation against %i cents",
    (amount) => {
      expectReview(
        input([invoice({ invoicedAmountCents: amount, balanceCents: amount })]),
        "PO_INVOICE_LINE_TOTAL_MISMATCH",
      );
    },
  );
  it.each([
    null,
    undefined,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1),
    "1.1",
    " 1 ",
    {},
    true,
  ])("exposes unsafe line amount %s as review", (amount) => {
    const source = soleOwner();
    source.lines = [{ ...source.lines[0], lineTotalCents: amount }];
    expectReview(input([source]), "PO_INVOICE_LINE_AMOUNT_INVALID");
  });
  it("accepts exact integer database strings/bigints and the safe integer boundary", () => {
    const source = soleOwner();
    source.lines = [
      { ...source.lines[0], lineTotalCents: BigInt(Number.MAX_SAFE_INTEGER) },
    ];
    source.invoicedAmountCents = String(Number.MAX_SAFE_INTEGER);
    source.paidAmountCents = BigInt(0);
    source.balanceCents = String(Number.MAX_SAFE_INTEGER);
    expect(buildPoFinancialEvidence(input([source]))).toMatchObject({
      state: "complete",
      invoicedAmountCents: Number.MAX_SAFE_INTEGER,
      outstandingAmountCents: Number.MAX_SAFE_INTEGER,
    });
  });
  it("returns review for aggregate overflow instead of rounding or throwing", () => {
    const source = soleOwner();
    source.lines = [
      { ...source.lines[0], lineTotalCents: Number.MAX_SAFE_INTEGER },
    ];
    source.invoicedAmountCents = Number.MAX_SAFE_INTEGER;
    source.balanceCents = Number.MAX_SAFE_INTEGER;
    const second = {
      ...source,
      id: 51,
      lines: [{ ...source.lines[0], id: 62 }],
    };
    expect(buildPoFinancialEvidence(input([source, second]))).toMatchObject({
      state: "review_required",
      invoicedAmountCents: null,
      paidAmountCents: 0,
      outstandingAmountCents: null,
      reviewReasons: [
        { code: "PO_FINANCIAL_AMOUNT_OVERFLOW", invoiceId: null },
      ],
    });
  });
  it.each([null, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid invoice total %s",
    (amount) => {
      expectReview(
        input([invoice({ invoicedAmountCents: amount })]),
        "PO_INVOICE_AMOUNT_INVALID",
      );
    },
  );
  it("requires completed payment sum and header/balance conservation", () => {
    expectReview(
      input([
        invoice({
          paidAmountCents: 10000,
          balanceCents: 20000,
          status: "partially_paid",
        }),
      ]),
      "PO_INVOICE_SETTLEMENT_MISMATCH",
      10000,
    );
    expectReview(
      input([{ ...withPayment(10000), balanceCents: 19999 }]),
      "PO_INVOICE_SETTLEMENT_MISMATCH",
      10000,
    );
    expectReview(
      input([
        {
          ...withPayment(30000),
          paidAmountCents: 30001,
          payments: [payment({ appliedAmountCents: 30001 })],
        },
      ]),
      "PO_INVOICE_SETTLEMENT_MISMATCH",
      10000,
    );
  });
  it.each(["pending", "failed", "", null])(
    "does not treat payment state %s as completed or zero",
    (status) => {
      expectReview(
        input([invoice({ payments: [payment({ paymentStatus: status })] })]),
        "PO_PAYMENT_STATUS_REVIEW_REQUIRED",
        10000,
      );
    },
  );
  it("ignores valid voided payment amounts but preserves a completed replacement", () => {
    const source = withPayment(4000, soleOwner());
    source.payments = [
      ...source.payments,
      payment({
        allocationId: 71,
        paymentId: 81,
        paymentStatus: "voided",
        appliedAmountCents: 10000,
      }),
    ];
    expect(buildPoFinancialEvidence(input([source]))).toMatchObject({
      state: "complete",
      paidAmountCents: 4000,
      outstandingAmountCents: 6000,
    });
    expect(
      buildPoFinancialEvidence(
        input([invoice({ payments: [payment({ paymentStatus: "voided" })] })]),
      ),
    ).toMatchObject({ state: "complete", paidAmountCents: 0 });
  });
  it.each([
    { paymentVendorId: null },
    { paymentVendorId: 10 },
    { paymentCurrency: null },
    { paymentCurrency: "EUR" },
  ])("requires payment vendor and currency ownership %j", (override) => {
    expectReview(
      input([invoice({ payments: [payment(override)] })]),
      "PO_PAYMENT_OWNERSHIP_INVALID",
      10000,
    );
  });
  it.each([null, 0, -1, 0.1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsupported payment allocation %s",
    (amount) => {
      expectReview(
        input([
          invoice({ payments: [payment({ appliedAmountCents: amount })] }),
        ]),
        "PO_PAYMENT_AMOUNT_INVALID",
        10000,
      );
    },
  );
  it.each([
    { paidAmountCents: null },
    { balanceCents: null },
    { paidAmountCents: -1 },
    { balanceCents: NaN },
  ])(
    "preserves known billing despite invalid settlement totals %j",
    (override) => {
      expectReview(
        input([invoice(override)]),
        "PO_INVOICE_SETTLEMENT_INVALID",
        10000,
      );
    },
  );
  it.each(["received", "approved", "paid"])(
    "rejects invoice status %s inconsistent with partial payment",
    (status) => {
      expectReview(
        input([{ ...withPayment(10000), status }]),
        "PO_INVOICE_STATUS_MISMATCH",
        10000,
      );
    },
  );
  it("rejects partially-paid status with zero or complete payment", () => {
    expectReview(
      input([invoice({ status: "partially_paid" })]),
      "PO_INVOICE_STATUS_MISMATCH",
      10000,
    );
    expectReview(
      input([{ ...withPayment(30000), status: "partially_paid" }]),
      "PO_INVOICE_STATUS_MISMATCH",
      10000,
    );
  });
  it("does not confuse a dispute with unknown recorded payment amounts", () => {
    expect(
      buildPoFinancialEvidence(input([invoice({ status: "disputed" })])),
    ).toMatchObject({ state: "complete", paidAmountCents: 0 });
    expectReview(
      input([{ ...withPayment(10000), status: "disputed" }]),
      "PO_SHARED_INVOICE_PARTIAL_PAYMENT",
      10000,
    );
  });
  it("rejects unknown invoice status and malformed identities explicitly", () => {
    expectReview(
      input([invoice({ status: "legacy" })]),
      "PO_INVOICE_EVIDENCE_INVALID",
    );
    expectReview(input([invoice({ id: 0 })]), "PO_INVOICE_EVIDENCE_INVALID");
  });
  it("never counts duplicate invoice, line or allocation evidence twice", () => {
    expectReview(
      input([invoice(), invoice()]),
      "PO_INVOICE_EVIDENCE_DUPLICATE",
    );
    const source = invoice();
    expectReview(
      input([{ ...source, lines: [source.lines[0], source.lines[0]] }]),
      "PO_FINANCIAL_SOURCE_DUPLICATE",
    );
    const first = withPayment(10000);
    const second = {
      ...withPayment(10000),
      id: 51,
      lines: invoice().lines.map((line) => ({ ...line, id: line.id + 10 })),
    };
    expectReview(input([first, second]), "PO_FINANCIAL_SOURCE_DUPLICATE");
    expectReview(
      input([
        invoice({ payments: [payment(), payment({ paymentId: 81 })] }),
      ]),
      "PO_FINANCIAL_SOURCE_DUPLICATE",
    );
  });
  it("counts repeated completed applications of one payment to one invoice exactly once each", () => {
    const source = withPayment(10000, soleOwner());
    source.payments = [payment({ appliedAmountCents: 4000 }), payment({ allocationId: 71, appliedAmountCents: 6000 })];
    expect(buildPoFinancialEvidence(input([source]))).toMatchObject({ state: "complete", invoicedAmountCents: 10000, paidAmountCents: 10000, outstandingAmountCents: 0 });
  });
  it("retains repeated voided applications without counting any of them as settlement", () => {
    const source = soleOwner();
    source.payments = [payment({ paymentStatus: "voided", appliedAmountCents: 4000 }), payment({ allocationId: 71, paymentStatus: "voided", appliedAmountCents: 6000 })];
    expect(buildPoFinancialEvidence(input([source]))).toMatchObject({ state: "complete", invoicedAmountCents: 10000, paidAmountCents: 0, outstandingAmountCents: 10000 });
  });
  it("still rejects duplicate allocation identity when payment history is voided", () => {
    const source = soleOwner();
    source.payments = [payment({ paymentStatus: "voided" }), payment({ paymentStatus: "voided" })];
    expectReview(input([source]), "PO_FINANCIAL_SOURCE_DUPLICATE");
  });
  it("supports one payment allocated to multiple invoices using distinct allocation IDs", () => {
    const first = withPayment(10000, soleOwner());
    const second = {
      ...withPayment(10000, soleOwner()),
      id: 51,
      lines: [{ ...soleOwner().lines[0], id: 62 }],
      payments: [payment({ allocationId: 71 })],
    };
    expect(buildPoFinancialEvidence(input([first, second]))).toMatchObject({
      state: "complete",
      invoiceCount: 2,
      invoicedAmountCents: 20000,
      paidAmountCents: 20000,
      outstandingAmountCents: 0,
    });
  });
  it("does not hide an unknown shared settlement in an otherwise exact PO total", () => {
    const second = {
      ...soleOwner(),
      id: 51,
      lines: [{ ...soleOwner().lines[0], id: 62 }],
    };
    expectReview(
      input([withPayment(10000), second]),
      "PO_SHARED_INVOICE_PARTIAL_PAYMENT",
      20000,
    );
  });
  it("does not mutate inputs and gives deterministic results regardless of source order", () => {
    const second = {
      ...withPayment(10000),
      id: 51,
      lines: invoice().lines.map((line) => ({ ...line, id: line.id + 10 })),
      payments: [payment({ allocationId: 71 })],
    };
    const source = deepFreeze(input([withPayment(10000), second]));
    const before = structuredClone(source);
    const result = buildPoFinancialEvidence(source);
    expect(source).toEqual(before);
    expect(
      buildPoFinancialEvidence({
        ...source,
        invoices: [...source.invoices].reverse(),
      }),
    ).toEqual(result);
  });
});

describe("PO financial evidence response contract", () => {
  it.each([0, -1, 0.1, 2147483648, NaN, Infinity])(
    "rejects IDs outside the database range: %s",
    (value) => {
      expect(poFinancialEvidenceIdSchema.safeParse(value).success).toBe(false);
    },
  );
  it("rejects unexpected fields and unsupported known currencies", () => {
    const result = buildPoFinancialEvidence(input());
    expect(
      poFinancialEvidenceSchema.safeParse({ ...result, extra: true }).success,
    ).toBe(false);
    expect(
      poFinancialEvidenceSchema.safeParse({
        ...result,
        currency: "not-a-currency",
      }).success,
    ).toBe(false);
  });
  it("rejects complete results with unknown amounts, unexplained review and inconsistent totals", () => {
    const result = buildPoFinancialEvidence(input());
    for (const change of [
      { paidAmountCents: null },
      { state: "review_required" },
      { outstandingAmountCents: 9999 },
      { paidAmountCents: -1 },
    ]) {
      expect(
        poFinancialEvidenceSchema.safeParse({ ...result, ...change }).success,
      ).toBe(false);
    }
  });
});

describe("financial evidence malformed runtime boundaries", () => {
  it.each([null, undefined, 1, "invalid", false, [], {}])(
    "classifies malformed invoice %j without throwing or inventing zero",
    (candidate) => {
      const source = input([
        candidate as unknown as PoFinancialInvoiceEvidence,
      ]);
      expectReview(source, "PO_INVOICE_EVIDENCE_INVALID");
      expect(buildPoFinancialEvidence(source).invoiceCount).toBe(1);
    },
  );
  it("keeps malformed records in a mixed invoice set under review", () => {
    const source = input([
      invoice(),
      null as unknown as PoFinancialInvoiceEvidence,
    ]);
    expectReview(source, "PO_INVOICE_EVIDENCE_INVALID");
    expect(buildPoFinancialEvidence(source).invoiceCount).toBe(2);
  });
  it.each([
    ["invoicedAmountCents", 0.1],
    ["paidAmountCents", 0.1],
    ["outstandingAmountCents", 0.1],
    ["invoicedAmountCents", NaN],
    ["paidAmountCents", Infinity],
    ["outstandingAmountCents", -Infinity],
    ["invoicedAmountCents", Number.MAX_SAFE_INTEGER + 1],
  ])(
    "returns an unsuccessful schema parse for invalid %s=%s",
    (field, value) => {
      const result = buildPoFinancialEvidence(input());
      const parsed = poFinancialEvidenceSchema.safeParse({
        ...result,
        [field]: value,
      });
      expect(parsed.success).toBe(false);
    },
  );
});
