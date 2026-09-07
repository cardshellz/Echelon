import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tables = vi.hoisted(() => ({
  vendorInvoiceLines: { id: "line.id", vendorInvoiceId: "line.invoice_id", purchaseOrderLineId: "line.po_line_id", lineTotalCents: "line.total" },
  vendorInvoices: { id: "invoice.id", vendorId: "invoice.vendor_id", status: "invoice.status", currency: "invoice.currency", paidAmountCents: "invoice.paid" },
  vendorInvoicePoLinks: { vendorInvoiceId: "link.invoice_id", purchaseOrderId: "link.po_id" },
  auditEvents: { id: "audit.id" },
}));
const mocks = vi.hoisted(() => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn() },
  detectOverpaid: vi.fn(),
  detectPastDue: vi.fn(),
}));
vi.mock("../../../../db", () => ({ db: mocks.db }));
vi.mock("@shared/schema", () => ({
  ...tables,
  apPaymentAllocations: {}, apPayments: {}, inboundFreightCosts: {}, inboundShipments: {},
  poStatusHistory: {}, purchaseOrderLines: {}, purchaseOrders: {}, vendorInvoiceAttachments: {}, vendors: {},
}));
vi.mock("../../po-exceptions.service", () => ({
  detectMatchMismatch: vi.fn(), detectOverpaid: mocks.detectOverpaid, detectPastDue: mocks.detectPastDue,
}));

type RecordedLine = {
  id: number; vendorInvoiceId: number; purchaseOrderLineId: null;
  qtyInvoiced: number; unitCostCents: number; unitCostMills: number | null;
  lineTotalCents: number; matchStatus: string; description: string | null; notes: string | null;
};

const fixedTime = new Date("2026-09-06T12:00:00.000Z");
function fixture(overrides: Partial<RecordedLine> = {}): RecordedLine {
  return {
    id: 33, vendorInvoiceId: 12, purchaseOrderLineId: null,
    qtyInvoiced: 150, unitCostCents: 67, unitCostMills: 6_667,
    lineTotalCents: 11_800, matchStatus: "matched", description: "Original description", notes: "Original note",
    ...overrides,
  };
}

function configure(record: RecordedLine, invoiceStatus = "received", financialReadResults: unknown[][] = []) {
  const selectResults: unknown[][] = [
    [{ vendorInvoiceId: record.vendorInvoiceId, purchaseOrderLineId: null }],
    [{ id: 12, vendorId: 4, currency: "USD", paidAmountCents: 0, status: invoiceStatus }],
    [record],
    ...financialReadResults,
  ];
  const writes: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const audits: Record<string, unknown>[] = [];
  const locks: string[] = [];
  mocks.db.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(mocks.db));
  mocks.db.select.mockImplementation(() => {
    if (selectResults.length === 0) throw new Error("Unexpected financial projection read");
    const result = selectResults.shift()!;
    const chain: any = {
      from: () => chain, where: () => chain, leftJoin: () => chain, innerJoin: () => chain,
      for: (lock: string) => { locks.push(lock); return chain; },
      then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  });
  mocks.db.update.mockImplementation((table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      writes.push({ table, values });
      const result = [{ ...record, ...values }];
      const terminal = {
        returning: async () => result,
        then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
      };
      return { where: () => terminal };
    },
  }));
  mocks.db.insert.mockImplementation((table: unknown) => ({
    values: async (values: Record<string, unknown>) => {
      expect(table).toBe(tables.auditEvents);
      audits.push(values);
    },
  }));
  return { writes, audits, locks };
}

describe("invoice line metadata preserves recorded economics", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(fixedTime);
  });
  afterEach(() => vi.useRealTimers());

  it("preserves an imported total and matching state, skips financial projection, and audits metadata", async () => {
    const record = fixture();
    const state = configure(record);
    const { updateInvoiceLine } = await import("../../ap-ledger.service");
    const updated = await updateInvoiceLine(33, { notes: " Revised packing instructions " }, "operator-9");

    expect(updated).toEqual({ ...record, notes: "Revised packing instructions", updatedAt: fixedTime });
    expect(state.writes).toEqual([{ table: tables.vendorInvoiceLines, values: { notes: "Revised packing instructions", updatedAt: fixedTime } }]);
    expect(state.locks).toEqual(["update", "update"]);
    expect(mocks.detectOverpaid).not.toHaveBeenCalled();
    expect(mocks.detectPastDue).not.toHaveBeenCalled();
    expect(state.audits).toEqual([expect.objectContaining({
      actor: "operator-9", action: "ap_ledger.invoice_line_updated", target: "invoice:12",
      context: {
        invoiceId: 12, invoiceLineId: 33, affectedPoIds: [], economicsChanged: false,
        economicsBefore: { qtyInvoiced: 150, unitCostCents: 67, unitCostMills: 6_667, lineTotalCents: 11_800, matchStatus: "matched" },
        economicsAfter: { qtyInvoiced: 150, unitCostCents: 67, unitCostMills: 6_667, lineTotalCents: 11_800, matchStatus: "matched" },
        metadataBefore: { notes: "Original note" }, metadataAfter: { notes: "Revised packing instructions" },
      },
    })]);
  });

  it.each([
    { label: "absent legacy mills", record: fixture({ unitCostMills: null, unitCostCents: 4, lineTotalCents: 777 }) },
    { label: "inconsistent historical cent mirror", record: fixture({ unitCostMills: 375, unitCostCents: 3 }) },
    { label: "signed credit", record: fixture({ qtyInvoiced: 1, unitCostMills: -550_000, unitCostCents: -5_500, lineTotalCents: -5_500 }) },
    { label: "recorded zero values", record: fixture({ qtyInvoiced: 0, unitCostMills: 0, unitCostCents: 0, lineTotalCents: 0 }) },
  ])("does not repair or normalize $label during a description edit", async ({ record }) => {
    const state = configure(record);
    const { updateInvoiceLine } = await import("../../ap-ledger.service");
    const updated = await updateInvoiceLine(33, { description: "Updated description" }, "operator-9");
    expect(updated).toEqual({ ...record, description: "Updated description", updatedAt: fixedTime });
    expect(Object.keys(state.writes[0].values).sort()).toEqual(["description", "updatedAt"]);
  });

  it.each([
    { qtyInvoiced: 150 },
    { unitCostCents: 67 },
    { unitCostMills: 6_667 },
    { qtyInvoiced: 150, unitCostCents: 67, unitCostMills: 6_667 },
  ])("does not reprice an unchanged form echo %j", async (echo) => {
    const record = fixture();
    const state = configure(record);
    const { updateInvoiceLine } = await import("../../ap-ledger.service");
    const updated = await updateInvoiceLine(33, { ...echo, notes: "Same agreed price" });
    expect(updated).toMatchObject({ ...record, notes: "Same agreed price" });
    expect(state.writes[0].values).toEqual({ updatedAt: fixedTime, notes: "Same agreed price" });
  });

  it("does not turn a rounded cents-only echo into a new sub-cent price", async () => {
    const record = fixture({ unitCostMills: 375, unitCostCents: 4 });
    const state = configure(record);
    const { updateInvoiceLine } = await import("../../ap-ledger.service");
    const updated = await updateInvoiceLine(33, { unitCostCents: 4 });
    expect(updated).toMatchObject(record);
    expect(state.writes[0].values).toEqual({ updatedAt: fixedTime });
  });

  it("preserves both stored mirrors when an unchanged legacy form resends them", async () => {
    const record = fixture({ unitCostMills: 375, unitCostCents: 3 });
    const state = configure(record);
    const { updateInvoiceLine } = await import("../../ap-ledger.service");
    const updated = await updateInvoiceLine(33, { unitCostMills: 375, unitCostCents: 3 });
    expect(updated).toMatchObject(record);
    expect(state.writes[0].values).toEqual({ updatedAt: fixedTime });
  });

  it("preserves absent legacy mills when a form resends the equivalent normalized price", async () => {
    const record = fixture({ unitCostMills: null, unitCostCents: 4 });
    const state = configure(record);
    const { updateInvoiceLine } = await import("../../ap-ledger.service");
    const updated = await updateInvoiceLine(33, { unitCostMills: 400, unitCostCents: 4 });
    expect(updated).toMatchObject(record);
    expect(state.writes[0].values).toEqual({ updatedAt: fixedTime });
    expect(state.audits[0].context).toMatchObject({
      economicsBefore: { unitCostMills: null, lineTotalCents: 11_800 },
      economicsAfter: { unitCostMills: null, lineTotalCents: 11_800 },
    });
  });

  it("retains the existing economic recalculation path for an actual quantity change", async () => {
    const record = fixture();
    const state = configure(record, "received", [[{ total: 6_667 }], [{ id: 12, paidAmountCents: 0 }], []]);
    const { updateInvoiceLine } = await import("../../ap-ledger.service");
    const updated = await updateInvoiceLine(33, { qtyInvoiced: 100 });
    expect(updated).toMatchObject({ qtyInvoiced: 100, unitCostMills: 6_667, unitCostCents: 67, lineTotalCents: 6_667, matchStatus: "pending" });
    expect(state.writes[1]).toEqual({ table: tables.vendorInvoices, values: { invoicedAmountCents: 6_667, balanceCents: 6_667, updatedAt: fixedTime } });
    expect(state.audits[0].context).toMatchObject({
      economicsChanged: true,
      economicsBefore: { qtyInvoiced: 150, unitCostCents: 67, unitCostMills: 6_667, lineTotalCents: 11_800, matchStatus: "matched" },
      economicsAfter: { qtyInvoiced: 100, unitCostCents: 67, unitCostMills: 6_667, lineTotalCents: 6_667, matchStatus: "pending" },
    });
  });

  it("still rejects inconsistent newly supplied economic prices", async () => {
    const state = configure(fixture());
    const { updateInvoiceLine } = await import("../../ap-ledger.service");
    await expect(updateInvoiceLine(33, { unitCostMills: 9_999, unitCostCents: 67 })).rejects.toMatchObject({
      details: { code: "AP_UNIT_COST_PRECISION_MISMATCH" },
    });
    expect(state.writes).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it.each([
    ["unitCostMills", null], ["unitCostMills", false], ["unitCostMills", ""], ["unitCostMills", "400"],
    ["unitCostCents", null], ["unitCostCents", true], ["unitCostCents", "4"],
    ["qtyInvoiced", null], ["qtyInvoiced", false], ["qtyInvoiced", "150"], ["qtyInvoiced", 0],
    ["qtyInvoiced", 1.5], ["unitCostMills", Infinity], ["unitCostCents", NaN],
    ["unitCostMills", Number.MAX_SAFE_INTEGER + 1], ["unitCostCents", -1],
  ])("rejects raw JSON %s=%j before it can reprice a legacy row", async (field, value) => {
    const state = configure(fixture({ unitCostMills: null, unitCostCents: 4 }));
    const { updateInvoiceLine } = await import("../../ap-ledger.service");
    await expect(updateInvoiceLine(33, { [field as string]: value } as any)).rejects.toMatchObject({
      statusCode: 400,
      details: { field },
    });
    expect(mocks.db.transaction).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("does not bypass the existing invoice edit lock for metadata", async () => {
    const state = configure(fixture(), "approved");
    const { updateInvoiceLine } = await import("../../ap-ledger.service");
    await expect(updateInvoiceLine(33, { notes: "Cannot edit" })).rejects.toMatchObject({
      statusCode: 409, details: { code: "AP_INVOICE_IMMUTABLE" },
    });
    expect(state.writes).toEqual([]);
    expect(state.audits).toEqual([]);
  });
});
