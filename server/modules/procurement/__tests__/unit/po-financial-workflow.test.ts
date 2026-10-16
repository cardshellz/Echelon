import { describe, expect, it, vi } from "vitest";
import { poFinancialWorkflowSchema } from "@shared/procurement/po-financial-workflow";
import {
  validatePoFinancialInvoiceFootprint,
  type PoFinancialEvidenceInput,
  type PoFinancialInvoiceEvidence,
} from "../../domain/po-financial-evidence";
import { buildPoFinancialWorkflow } from "../../domain/po-financial-workflow";
import {
  PoFinancialEvidenceSourceError,
  readPoFinancialEvidenceSource,
  readPoFinancialEvidenceSourcesWithClient,
  type PoFinancialEvidenceDatabase,
  type PoFinancialEvidenceReadClient,
} from "../../po-financial-evidence.repository";
import { createPoFinancialEvidenceService } from "../../po-financial-evidence.service";

function invoice(
  overrides: Partial<PoFinancialInvoiceEvidence> = {},
): PoFinancialInvoiceEvidence {
  return {
    id: 10,
    vendorId: 9,
    currency: "USD",
    status: "approved",
    invoicedAmountCents: 10000,
    paidAmountCents: 0,
    balanceCents: 10000,
    links: [
      {
        purchaseOrderId: 1,
        purchaseOrderVendorId: 9,
        purchaseOrderCurrency: "USD",
      },
    ],
    lines: [
      {
        id: 11,
        purchaseOrderLineId: 12,
        purchaseOrderId: 1,
        freightCostId: null,
        lineTotalCents: 10000,
      },
    ],
    payments: [],
    ...overrides,
  };
}
function input(
  invoices: readonly PoFinancialInvoiceEvidence[] = [invoice()],
): PoFinancialEvidenceInput {
  return { purchaseOrderId: 1, vendorId: 9, currency: "USD", invoices };
}
function paid(amount = 10000): PoFinancialInvoiceEvidence {
  return invoice({
    status: amount === 10000 ? "paid" : "partially_paid",
    paidAmountCents: amount,
    balanceCents: 10000 - amount,
    payments: [
      {
        allocationId: 21,
        paymentId: 22,
        paymentVendorId: 9,
        paymentCurrency: "USD",
        paymentStatus: "completed",
        appliedAmountCents: amount,
      },
    ],
  });
}
function zero(status: string): PoFinancialInvoiceEvidence {
  return invoice({
    status,
    invoicedAmountCents: 0,
    paidAmountCents: 0,
    balanceCents: 0,
    lines: [],
  });
}
function distinct(
  source: PoFinancialInvoiceEvidence,
): PoFinancialInvoiceEvidence {
  return {
    ...source,
    id: source.id + 100,
    lines: source.lines.map((line) => ({ ...line, id: line.id + 100 })),
    payments: source.payments.map((payment) => ({
      ...payment,
      allocationId: payment.allocationId + 100,
    })),
  };
}

describe("current PO financial workflow", () => {
  it("does not treat a legacy cached paid PO with no invoices as settled", () => {
    const legacyPo = {
      id: 1,
      vendorId: 9,
      currency: "USD",
      financialStatus: "paid",
      paidTotalCents: 50000,
      fullyPaidAt: new Date("2026-01-01"),
    };
    const result = buildPoFinancialWorkflow({
      purchaseOrderId: legacyPo.id,
      vendorId: legacyPo.vendorId,
      currency: legacyPo.currency,
      invoices: [],
    });
    expect(result).toMatchObject({
      state: "unbilled",
      evidence: {
        state: "complete",
        invoiceCount: 0,
        invoicedAmountCents: 0,
        paidAmountCents: 0,
        outstandingAmountCents: 0,
      },
    });
  });
  it("ignores voided history for current workflow", () => {
    expect(
      buildPoFinancialWorkflow(
        input([
          invoice({ status: "voided", currency: null, balanceCents: null }),
        ]),
      ).state,
    ).toBe("unbilled");
  });
  it.each([0, 10000])(
    "requires approval for a received invoice of %i cents",
    (amount) => {
      const source =
        amount === 0 ? zero("received") : invoice({ status: "received" });
      expect(buildPoFinancialWorkflow(input([source])).state).toBe(
        "awaiting_approval",
      );
    },
  );
  it.each([0, 10000])(
    "requires review for a disputed invoice of %i cents",
    (amount) => {
      const source =
        amount === 0 ? zero("disputed") : invoice({ status: "disputed" });
      expect(buildPoFinancialWorkflow(input([source]))).toMatchObject({
        state: "review_required",
        evidence: { state: "complete" },
      });
    },
  );
  it("does not close an approved zero-value invoice", () => {
    expect(buildPoFinancialWorkflow(input([zero("approved")])).state).toBe(
      "review_required",
    );
  });
  it("accepts an explicitly paid zero-value invoice", () => {
    expect(buildPoFinancialWorkflow(input([zero("paid")])).state).toBe(
      "settled",
    );
  });
  it.each([invoice(), paid(4000)])(
    "identifies approved or partially paid money due",
    (source) => {
      expect(buildPoFinancialWorkflow(input([source])).state).toBe(
        "payment_due",
      );
    },
  );
  it("requires complete, paid invoice evidence to report settlement", () => {
    expect(buildPoFinancialWorkflow(input([paid()]))).toMatchObject({
      state: "settled",
      evidence: {
        outstandingAmountCents: 0,
        paidAmountCents: 10000,
        invoiceCount: 1,
      },
    });
  });
  it("accepts paid documents alongside an approved amount due", () => {
    expect(
      buildPoFinancialWorkflow(input([paid(), distinct(invoice())])).state,
    ).toBe("payment_due");
  });
  it("keeps approval ahead of payment when received and approved invoices coexist", () => {
    expect(
      buildPoFinancialWorkflow(
        input([invoice({ status: "received" }), distinct(invoice())]),
      ).state,
    ).toBe("awaiting_approval");
  });
  it("keeps dispute ahead of approval", () => {
    expect(
      buildPoFinancialWorkflow(
        input([zero("disputed"), distinct(invoice({ status: "received" }))]),
      ).state,
    ).toBe("review_required");
  });
  it("does not settle a PO whose zero share belongs to an open invoice", () => {
    const source = invoice({
      links: [
        ...invoice().links,
        {
          purchaseOrderId: 2,
          purchaseOrderVendorId: 9,
          purchaseOrderCurrency: "USD",
        },
      ],
      lines: [{ ...invoice().lines[0], purchaseOrderId: 2 }],
    });
    expect(buildPoFinancialWorkflow(input([source]))).toMatchObject({
      state: "review_required",
      evidence: {
        state: "complete",
        outstandingAmountCents: 0,
        invoiceCount: 1,
      },
    });
  });
  it("retains unknown settlement for a shared partial payment", () => {
    const source = paid(4000);
    source.links = [
      ...source.links,
      {
        purchaseOrderId: 2,
        purchaseOrderVendorId: 9,
        purchaseOrderCurrency: "USD",
      },
    ];
    source.lines = [
      { ...source.lines[0], lineTotalCents: 6000 },
      {
        id: 13,
        purchaseOrderLineId: 14,
        purchaseOrderId: 2,
        freightCostId: null,
        lineTotalCents: 4000,
      },
    ];
    const result = buildPoFinancialWorkflow(input([source]));
    expect(result).toMatchObject({
      state: "review_required",
      evidence: {
        invoicedAmountCents: 6000,
        paidAmountCents: null,
        outstandingAmountCents: null,
      },
    });
    expect(result.evidence.reviewReasons).toContainEqual(
      expect.objectContaining({ code: "PO_SHARED_INVOICE_PARTIAL_PAYMENT" }),
    );
  });
  it.each([null, undefined, {}, { status: "unknown" }])(
    "classifies malformed invoice %j without an unguarded status read",
    (source) => {
      expect(
        buildPoFinancialWorkflow(
          input([source as unknown as PoFinancialInvoiceEvidence]),
        ).state,
      ).toBe("review_required");
    },
  );
  it.each([
    invoice({ currency: "EUR" }),
    invoice({ invoicedAmountCents: Number.MAX_SAFE_INTEGER + 1 }),
    invoice({ balanceCents: null }),
    invoice({ status: "paid" }),
    invoice({ lines: [] }),
  ])("keeps invalid amounts, ownership or status in review", (source) => {
    expect(buildPoFinancialWorkflow(input([source])).state).toBe(
      "review_required",
    );
  });
  it("does not reinterpret an unsupported-currency empty PO as unbilled", () => {
    expect(
      buildPoFinancialWorkflow({ ...input([]), currency: "EUR" }).state,
    ).toBe("review_required");
  });
  it("preserves the source without writes or mutation", () => {
    const source = input([paid()]);
    const before = structuredClone(source);
    expect(buildPoFinancialWorkflow(source)).toEqual(
      buildPoFinancialWorkflow(source),
    );
    expect(source).toEqual(before);
  });
});

describe("PO financial workflow output contract", () => {
  const settled = buildPoFinancialWorkflow(input([paid()]));
  it("rejects mismatched PO identities", () => {
    expect(
      poFinancialWorkflowSchema.safeParse({ ...settled, purchaseOrderId: 2 })
        .success,
    ).toBe(false);
  });
  it("rejects extra response fields", () => {
    expect(
      poFinancialWorkflowSchema.safeParse({
        ...settled,
        legacyFinancialStatus: "paid",
      }).success,
    ).toBe(false);
  });
  it.each(["settled", "payment_due", "awaiting_approval"])(
    "rejects %s without active invoices",
    (state) => {
      expect(
        poFinancialWorkflowSchema.safeParse({
          ...buildPoFinancialWorkflow(input([])),
          state,
        }).success,
      ).toBe(false);
    },
  );
  it("rejects a nonzero outstanding settled claim", () => {
    expect(
      poFinancialWorkflowSchema.safeParse({
        ...buildPoFinancialWorkflow(input()),
        state: "settled",
      }).success,
    ).toBe(false);
  });
  it("rejects payment due at zero outstanding", () => {
    expect(
      poFinancialWorkflowSchema.safeParse({ ...settled, state: "payment_due" })
        .success,
    ).toBe(false);
  });
  it("rejects unbilled with an active invoice", () => {
    expect(
      poFinancialWorkflowSchema.safeParse({ ...settled, state: "unbilled" })
        .success,
    ).toBe(false);
  });
  it.each(["unbilled", "awaiting_approval", "payment_due", "settled"])(
    "rejects %s with incomplete evidence",
    (state) => {
      const result = buildPoFinancialWorkflow(
        input([invoice({ balanceCents: null })]),
      );
      expect(
        poFinancialWorkflowSchema.safeParse({ ...result, state }).success,
      ).toBe(false);
    },
  );
});

/** A read-only query boundary fake. Financial behavior still runs through the
 * actual repository grouping and domain validation, with no database fallback. */
function reader(rows: readonly (readonly unknown[])[]) {
  let queryIndex = 0;
  const select = vi.fn(() => {
    const selected = rows[queryIndex++];
    if (!selected) throw new Error("Unexpected query");
    const query = {
      from: vi.fn(() => query),
      leftJoin: vi.fn(() => query),
      innerJoin: vi.fn(() => query),
      where: vi.fn(() => query),
      orderBy: vi.fn(async () => selected),
    };
    return query;
  });
  const client = { select } as unknown as PoFinancialEvidenceReadClient;
  const transaction = vi.fn(
    async (run: (tx: PoFinancialEvidenceReadClient) => Promise<unknown>) =>
      run(client),
  );
  return {
    client,
    select,
    transaction,
    database: { transaction } as unknown as PoFinancialEvidenceDatabase,
  };
}
function batchRows(): unknown[][] {
  const source = invoice();
  const header = {
    id: source.id,
    vendorId: source.vendorId,
    currency: source.currency,
    status: source.status,
    invoicedAmountCents: 30000,
    paidAmountCents: 0,
    balanceCents: 30000,
  };
  const rows: unknown[][] = [
    [
      { id: 1, vendorId: 9, currency: "USD" },
      { id: 2, vendorId: 9, currency: "USD" },
      { id: 3, vendorId: 9, currency: "USD" },
    ],
    [
      { purchaseOrderId: 1, invoice: header },
      { purchaseOrderId: 2, invoice: header },
    ],
    [
      {
        vendorInvoiceId: 10,
        purchaseOrderId: 1,
        purchaseOrderVendorId: 9,
        purchaseOrderCurrency: "USD",
      },
      {
        vendorInvoiceId: 10,
        purchaseOrderId: 2,
        purchaseOrderVendorId: 9,
        purchaseOrderCurrency: "USD",
      },
    ],
    [
      { vendorInvoiceId: 10, ...source.lines[0] },
      {
        vendorInvoiceId: 10,
        id: 13,
        purchaseOrderLineId: 14,
        purchaseOrderId: 2,
        freightCostId: null,
        lineTotalCents: 20000,
      },
    ],
    [],
  ];
  rows.splice(2, 0, []);
  return rows;
}

describe("batched financial evidence read boundaries", () => {
  it("preserves both owners' complete shared-invoice footprint using six queries", async () => {
    const fixture = reader(batchRows());
    const sources = await readPoFinancialEvidenceSourcesWithClient(
      fixture.client,
      [3, 2, 1, 2, 999],
    );
    expect(fixture.select).toHaveBeenCalledTimes(6);
    expect([...sources.keys()]).toEqual([1, 2, 3]);
    expect(sources.get(1)?.invoices[0]).toEqual(sources.get(2)?.invoices[0]);
    expect(sources.get(1)?.invoices[0].links).toHaveLength(2);
    expect(sources.get(1)?.invoices[0].lines).toHaveLength(2);
    expect(sources.get(3)?.invoices).toEqual([]);
    expect(
      buildPoFinancialWorkflow(sources.get(1)!).evidence.invoicedAmountCents,
    ).toBe(10000);
    expect(
      buildPoFinancialWorkflow(sources.get(2)!).evidence.invoicedAmountCents,
    ).toBe(20000);
    expect(fixture.transaction).not.toHaveBeenCalled();
  });
  it("reads many results in one repeatable-read read-only snapshot", async () => {
    const fixture = reader(batchRows());
    const result = await createPoFinancialEvidenceService(
      fixture.database,
    ).readMany([1, 2, 3, 999]);
    expect(fixture.transaction).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    expect(fixture.select).toHaveBeenCalledTimes(6);
    expect(result.get(1)?.invoicedAmountCents).toBe(10000);
    expect(result.get(2)?.invoicedAmountCents).toBe(20000);
    expect(result.get(3)?.invoiceCount).toBe(0);
    expect(result.has(999)).toBe(false);
  });
  it("reads workflow states without duplicate evidence queries", async () => {
    const fixture = reader(batchRows());
    const result = await createPoFinancialEvidenceService(
      fixture.database,
    ).readManyWorkflows([1, 2, 3]);
    expect([...result.values()].map((workflow) => workflow.state)).toEqual([
      "payment_due",
      "payment_due",
      "unbilled",
    ]);
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.select).toHaveBeenCalledTimes(6);
  });
  it("preserves single source, evidence and workflow not-found behavior", async () => {
    for (const operation of ["source", "evidence", "workflow"] as const) {
      const fixture = reader([[]]);
      const service = createPoFinancialEvidenceService(fixture.database);
      const result =
        operation === "source"
          ? await readPoFinancialEvidenceSource(fixture.database, 1)
          : operation === "evidence"
            ? await service.read(1)
            : await service.readWorkflow(1);
      expect(result).toBeNull();
      expect(fixture.select).toHaveBeenCalledTimes(1);
    }
  });
  it("does not query for an empty batch", async () => {
    const fixture = reader([]);
    expect(
      await readPoFinancialEvidenceSourcesWithClient(fixture.client, []),
    ).toEqual(new Map());
    const service = createPoFinancialEvidenceService(fixture.database);
    expect(await service.readMany([])).toEqual(new Map());
    expect(await service.readManyWorkflows([])).toEqual(new Map());
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fixture.select).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 2147483648, NaN, Infinity])(
    "rejects invalid ID %s before database access",
    async (id) => {
      const fixture = reader([]);
      const service = createPoFinancialEvidenceService(fixture.database);
      await expect(
        readPoFinancialEvidenceSourcesWithClient(fixture.client, [id]),
      ).rejects.toThrow();
      await expect(service.readMany([1, id])).rejects.toThrow();
      await expect(service.readManyWorkflows([id])).rejects.toThrow();
      await expect(service.read(id)).rejects.toThrow();
      await expect(service.readWorkflow(id)).rejects.toThrow();
      expect(fixture.transaction).not.toHaveBeenCalled();
      expect(fixture.select).not.toHaveBeenCalled();
    },
  );
  it("never silently loses a linked invoice with a missing header", async () => {
    const fixture = reader([
      [{ id: 1, vendorId: 9, currency: "USD" }],
      [{ purchaseOrderId: 1, invoice: null }],
    ]);
    await expect(
      createPoFinancialEvidenceService(fixture.database).readWorkflow(1),
    ).rejects.toBeInstanceOf(PoFinancialEvidenceSourceError);
    expect(fixture.select).toHaveBeenCalledTimes(2);
  });
  it("discovers an owned invoice whose target PO link is missing", async () => {
    const rows = batchRows();
    rows[2] = [rows[1][0], rows[1][0]];
    rows[1] = [rows[1][1]];
    rows[3] = [rows[3][1]];
    const result = await createPoFinancialEvidenceService(
      reader(rows).database,
    ).readWorkflow(1);
    expect(result).toMatchObject({
      state: "review_required",
      evidence: { invoiceCount: 1, invoicedAmountCents: null },
    });
    expect(result?.evidence.reviewReasons).toContainEqual(
      expect.objectContaining({ code: "PO_INVOICE_OWNERSHIP_INVALID" }),
    );
  });
  it("does not duplicate an invoice discovered from both links and owned lines", async () => {
    const rows = batchRows();
    rows[2] = [rows[1][0], rows[1][0], rows[1][1]];
    const result = await createPoFinancialEvidenceService(
      reader(rows).database,
    ).readMany([1, 2]);
    expect(result.get(1)).toMatchObject({
      state: "complete",
      invoiceCount: 1,
      invoicedAmountCents: 10000,
    });
    expect(result.get(2)).toMatchObject({
      state: "complete",
      invoiceCount: 1,
      invoicedAmountCents: 20000,
    });
  });
  it("fails explicitly when an owned invoice line has no invoice header", async () => {
    const fixture = reader([
      [{ id: 1, vendorId: 9, currency: "USD" }],
      [],
      [{ purchaseOrderId: 1, invoice: null }],
    ]);
    await expect(
      createPoFinancialEvidenceService(fixture.database).readWorkflow(1),
    ).rejects.toBeInstanceOf(PoFinancialEvidenceSourceError);
    expect(fixture.select).toHaveBeenCalledTimes(3);
  });
  it("preserves duplicate target links for explicit domain review", async () => {
    const rows = batchRows();
    rows[1].push(rows[1][0]);
    const fixture = reader(rows);
    const result = await createPoFinancialEvidenceService(
      fixture.database,
    ).readWorkflow(1);
    expect(result?.state).toBe("review_required");
    expect(result?.evidence.reviewReasons).toContainEqual(
      expect.objectContaining({ code: "PO_INVOICE_EVIDENCE_DUPLICATE" }),
    );
  });
  it("preserves missing payment headers for review instead of inventing zero payment", async () => {
    const rows = batchRows();
    rows[5] = [
      {
        vendorInvoiceId: 10,
        allocationId: 21,
        paymentId: 22,
        paymentVendorId: null,
        paymentCurrency: null,
        paymentStatus: null,
        appliedAmountCents: 100,
      },
    ];
    const fixture = reader(rows);
    const result = await createPoFinancialEvidenceService(
      fixture.database,
    ).readWorkflow(1);
    expect(result?.evidence).toMatchObject({
      state: "review_required",
      paidAmountCents: null,
      outstandingAmountCents: null,
    });
  });
});

describe("reusable invoice footprint validation", () => {
  it.each([
    "received",
    "approved",
    "partially_paid",
    "paid",
    "disputed",
    "voided",
  ])("validates ownership independently of %s settlement policy", (status) => {
    const source = invoice({
      status,
      paidAmountCents: null,
      balanceCents: null,
      payments: [],
    });
    expect(
      validatePoFinancialInvoiceFootprint(input([source]), source),
    ).toEqual({ valid: true, codes: [] });
  });
  it.each([
    [invoice({ links: [] }), "PO_INVOICE_OWNERSHIP_INVALID"],
    [invoice({ lines: [] }), "PO_INVOICE_LINE_TOTAL_MISMATCH"],
    [invoice({ vendorId: 99 }), "PO_INVOICE_OWNERSHIP_INVALID"],
    [invoice({ currency: "EUR" }), "PO_INVOICE_OWNERSHIP_INVALID"],
    [invoice({ invoicedAmountCents: null }), "PO_INVOICE_AMOUNT_INVALID"],
    [invoice({ status: "missing" }), "PO_INVOICE_EVIDENCE_INVALID"],
    [null, "PO_INVOICE_EVIDENCE_INVALID"],
  ])("rejects incomplete or inconsistent ownership", (source, code) => {
    expect(validatePoFinancialInvoiceFootprint(input(), source)).toEqual({
      valid: false,
      codes: [code],
    });
  });
  it("does not validate a voided source merely because the current projection ignores it", () => {
    const source = invoice({ status: "voided", links: [] });
    expect(
      validatePoFinancialInvoiceFootprint(input([source]), source),
    ).toEqual({ valid: false, codes: ["PO_INVOICE_OWNERSHIP_INVALID"] });
  });
  it("rejects malformed root identity without throwing", () => {
    expect(
      validatePoFinancialInvoiceFootprint(
        { ...input(), purchaseOrderId: 0 },
        invoice(),
      ),
    ).toEqual({ valid: false, codes: ["PO_FINANCIAL_ROOT_INVALID"] });
  });
  it("rejects unsupported root currency", () => {
    expect(
      validatePoFinancialInvoiceFootprint(
        { ...input(), currency: "EUR" },
        invoice(),
      ),
    ).toEqual({ valid: false, codes: ["PO_FINANCIAL_CURRENCY_UNSUPPORTED"] });
  });
});
