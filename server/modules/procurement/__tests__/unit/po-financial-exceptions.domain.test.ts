import { describe, expect, it } from "vitest";
import { evaluatePoFinancialExceptions } from "../../domain/po-financial-exceptions";
import type { PoFinancialEvidenceInput } from "../../domain/po-financial-evidence";
const asOf = new Date("2026-10-15T12:00:00Z");
function source(): PoFinancialEvidenceInput {
  return {
    purchaseOrderId: 10,
    vendorId: 5,
    currency: "USD",
    invoices: [
      {
        id: 1,
        vendorId: 5,
        currency: "USD",
        status: "approved",
        invoicedAmountCents: 3000,
        paidAmountCents: 0,
        balanceCents: 3000,
        links: [
          {
            purchaseOrderId: 10,
            purchaseOrderVendorId: 5,
            purchaseOrderCurrency: "USD",
          },
          {
            purchaseOrderId: 20,
            purchaseOrderVendorId: 5,
            purchaseOrderCurrency: "USD",
          },
        ],
        lines: [
          {
            id: 1,
            purchaseOrderLineId: 21,
            purchaseOrderId: 10,
            freightCostId: null,
            lineTotalCents: 1000,
          },
          {
            id: 2,
            purchaseOrderLineId: 22,
            purchaseOrderId: 20,
            freightCostId: null,
            lineTotalCents: 2000,
          },
        ],
        payments: [],
      },
    ],
  };
}
function run(
  input = source(),
  dueDate: Date | null = new Date("2026-10-14T23:59:59Z"),
  time = asOf,
) {
  return evaluatePoFinancialExceptions(
    input,
    [{ id: 1, invoiceNumber: "TEST", dueDate }],
    time,
  );
}
function pay(input: PoFinancialEvidenceInput, amount: number) {
  Object.assign(input.invoices[0], {
    status: amount < 3000 ? "partially_paid" : "paid",
    paidAmountCents: amount,
    balanceCents: Math.max(3000 - amount, 0),
    payments: [
      {
        allocationId: 1,
        paymentId: 1,
        paymentVendorId: 5,
        paymentCurrency: "USD",
        paymentStatus: "completed",
        appliedAmountCents: amount,
      },
    ],
  });
  return input;
}

describe("financial exceptions use validated whole invoice evidence", () => {
  it("uses all distinct completed allocations from the same payment for overdue evidence", () => {
    const input = pay(source(), 2000);
    const first = input.invoices[0].payments[0];
    input.invoices[0].payments = [{ ...first, appliedAmountCents: 1000 }, { ...first, allocationId: 2, appliedAmountCents: 1000 }];
    const result = run(input);
    expect(result.unknownKinds).toEqual([]);
    expect(result.alerts).toEqual([expect.objectContaining({ kind: "past_due", payload: expect.objectContaining({ outstandingCents: 1000 }) })]);
    expect(result.invoiceEvidence[0].completedAllocationIds).toEqual([1, 2]);
  });
  it("retains repeated voided allocations without treating the invoice as paid", () => {
    const input = source();
    input.invoices[0].payments = [1, 2].map(allocationId => ({ allocationId, paymentId: 1, paymentVendorId: 5, paymentCurrency: "USD", paymentStatus: "voided", appliedAmountCents: 1000 }));
    const result = run(input);
    expect(result.unknownKinds).toEqual([]);
    expect(result.alerts).toEqual([expect.objectContaining({ kind: "past_due", payload: expect.objectContaining({ outstandingCents: 3000 }) })]);
    expect(result.invoiceEvidence[0].completedAllocationIds).toEqual([]);
  });
  it.each(["completed", "voided"])("rejects duplicated allocation identity for %s history", paymentStatus => {
    const input = paymentStatus === "completed" ? pay(source(), 2000) : source();
    const allocation = { allocationId: 1, paymentId: 1, paymentVendorId: 5, paymentCurrency: "USD", paymentStatus, appliedAmountCents: 1000 };
    input.invoices[0].payments = [allocation, { ...allocation }];
    expect(run(input).unknownKinds).toEqual(["overpaid", "past_due"]);
  });
  it("labels shared partial payment debt as invoice scope without allocating it to a PO", () => {
    expect(run(pay(source(), 1000)).alerts).toEqual([
      expect.objectContaining({
        kind: "past_due",
        title: "Linked invoice past due",
        payload: expect.objectContaining({
          scope: "linked_invoice",
          outstandingCents: 2000,
        }),
      }),
    ]);
  });
  it.each([
    "2026-10-15T00:00:00Z",
    "2026-10-15T23:59:59Z",
    "2026-11-01T00:00:00Z",
  ])("does not flag due today or future: %s", (due) =>
    expect(run(source(), new Date(due)).alerts).toEqual([]),
  );
  it("uses stable identity and fingerprint across days", () => {
    expect(run().alerts).toEqual(
      run(
        source(),
        new Date("2026-10-14T23:59:59Z"),
        new Date("2026-10-17T00:00:00Z"),
      ).alerts,
    );
  });
  it("changes evidence fingerprint but retains identity when a payment changes balance", () => {
    expect(run().alerts[0].identity).toBe(
      run(pay(source(), 1000)).alerts[0].identity,
    );
    expect(run().alerts[0].sourceFingerprint).not.toBe(
      run(pay(source(), 1000)).alerts[0].sourceFingerprint,
    );
  });
  it("proves legacy overpayment from completed allocations", () =>
    expect(run(pay(source(), 3100)).alerts).toEqual([
      expect.objectContaining({
        kind: "overpaid",
        payload: expect.objectContaining({ overageCents: 100 }),
      }),
    ]));
  it("does not use a header-only overpayment claim", () => {
    const input = source();
    Object.assign(input.invoices[0], {
      status: "paid",
      paidAmountCents: 3100,
      balanceCents: 0,
    });
    expect(run(input).unknownKinds).toEqual(["overpaid", "past_due"]);
  });
  it("clears paid evidence without requiring an irrelevant due date", () =>
    expect(run(pay(source(), 3000), null)).toMatchObject({
      alerts: [],
      unknownKinds: [],
    }));
  it.each([null, new Date("invalid")])(
    "preserves past due when recorded due date is unavailable",
    (due) => expect(run(source(), due).unknownKinds).toEqual(["past_due"]),
  );
  it.each([null, -1, 1.5, "1.1", "9007199254740992"])(
    "rejects malformed invoice amount %s",
    (amount) => {
      const input = source();
      input.invoices[0].invoicedAmountCents = amount;
      expect(run(input).unknownKinds).toEqual(["overpaid", "past_due"]);
    },
  );
  it("ignores voided payment history while proving current zero settlement", () => {
    const input = pay(source(), 1000);
    Object.assign(input.invoices[0], {
      status: "approved",
      paidAmountCents: 0,
      balanceCents: 3000,
    });
    input.invoices[0].payments[0].paymentStatus = "voided";
    expect(run(input).alerts[0].payload.outstandingCents).toBe(3000);
  });
  it("preserves alerts for a void with completed payments", () => {
    const input = pay(source(), 1000);
    input.invoices[0].status = "voided";
    expect(run(input).unknownKinds).toEqual(["overpaid", "past_due"]);
  });
  it("accepts canonical unpaid void retaining its old balance", () => {
    const input = source();
    input.invoices[0].status = "voided";
    expect(run(input)).toMatchObject({ alerts: [], unknownKinds: [] });
  });
  it("does not erase alerts when retained void footprint is broken", () => {
    const input = source();
    input.invoices[0].status = "voided";
    input.invoices[0].lines[0].purchaseOrderLineId = null;
    expect(run(input).unknownKinds).toEqual(["overpaid", "past_due"]);
  });
  it("rejects a line without the target PO invoice relationship", () => {
    const input = source();
    input.invoices[0].links = input.invoices[0].links.slice(1);
    expect(run(input).unknownKinds).toEqual(["overpaid", "past_due"]);
  });
  it("rejects malformed and repeated payment evidence", () => {
    const input = pay(source(), 1000);
    input.invoices[0].payments = [
      ...input.invoices[0].payments,
      ...input.invoices[0].payments,
    ];
    expect(run(input).unknownKinds).toEqual(["overpaid", "past_due"]);
  });
  it("validates its injected clock", () =>
    expect(() => run(source(), null, new Date("invalid"))).toThrow("asOf"));
  it("classifies a malformed invoice record without throwing", () => {
    const input = source();
    input.invoices = [null] as unknown as PoFinancialEvidenceInput["invoices"];
    expect(run(input).unknownKinds).toEqual(["overpaid", "past_due"]);
  });
  it("classifies malformed retained void payment evidence without throwing", () => {
    const input = source();
    input.invoices[0].status = "voided";
    input.invoices[0].payments = [
      null,
    ] as unknown as PoFinancialEvidenceInput["invoices"][number]["payments"];
    expect(run(input).unknownKinds).toEqual(["overpaid", "past_due"]);
  });
  const validSchedule = { id: 1, invoiceNumber: "TEST", dueDate: null };
  it.each([
    { label: "null array", schedules: null },
    { label: "undefined array", schedules: undefined },
    { label: "non-array", schedules: {} },
    { label: "null record", schedules: [null] },
    { label: "undefined record", schedules: [undefined] },
    { label: "null identity", schedules: [{ ...validSchedule, id: null }] },
    { label: "string identity", schedules: [{ ...validSchedule, id: "1" }] },
    {
      label: "null number",
      schedules: [{ ...validSchedule, invoiceNumber: null }],
    },
    { label: "missing number", schedules: [{ id: 1, dueDate: null }] },
    {
      label: "blank number",
      schedules: [{ ...validSchedule, invoiceNumber: " " }],
    },
    { label: "duplicate identity", schedules: [validSchedule, validSchedule] },
    {
      label: "missing date property",
      schedules: [{ id: 1, invoiceNumber: "TEST" }],
    },
    {
      label: "wrong date shape",
      schedules: [{ ...validSchedule, dueDate: "2026-10-14" }],
    },
    {
      label: "unknown field",
      schedules: [{ ...validSchedule, assumedTerms: 30 }],
    },
  ])(
    "classifies malformed schedule $label without clearing either alert kind",
    ({ schedules }) => {
      expect(
        evaluatePoFinancialExceptions(
          source(),
          schedules as unknown as Parameters<
            typeof evaluatePoFinancialExceptions
          >[1],
          asOf,
        ),
      ).toMatchObject({
        alerts: [],
        unknownKinds: ["overpaid", "past_due"],
        diagnostics: ["PO_FINANCIAL_SCHEDULE_INVALID"],
      });
    },
  );
  it("does not clear paid or voided alerts when the schedule collection is malformed", () => {
    const paid = pay(source(), 3000),
      voided = source();
    voided.invoices[0].status = "voided";
    for (const input of [paid, voided])
      expect(
        evaluatePoFinancialExceptions(
          input,
          [null] as unknown as Parameters<
            typeof evaluatePoFinancialExceptions
          >[1],
          asOf,
        ).unknownKinds,
      ).toEqual(["overpaid", "past_due"]);
  });
  it("keeps confirmed overpayment actionable when the recorded due date is null", () => {
    expect(run(pay(source(), 3100), null)).toMatchObject({
      unknownKinds: [],
      alerts: [expect.objectContaining({ kind: "overpaid" })],
    });
  });
});
