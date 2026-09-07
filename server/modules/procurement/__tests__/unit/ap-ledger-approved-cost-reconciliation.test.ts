import { beforeEach, describe, expect, it, vi } from "vitest";

// These owner fixtures isolate financial state changes. The real PostgreSQL
// cost suites verify the shared graph lock and its transaction ordering.
vi.mock("../../../inventory/infrastructure/cost-evidence.repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../inventory/infrastructure/cost-evidence.repository")>(),
  lockInventoryCostGraph: vi.fn(async () => undefined),
}));

const tables = vi.hoisted(() => ({
  purchaseOrderLines: {
    id: "purchase_order_lines.id",
    purchaseOrderId: "purchase_order_lines.purchase_order_id",
    lineType: "purchase_order_lines.line_type",
    status: "purchase_order_lines.status",
    orderQty: "purchase_order_lines.order_qty",
    receivedQty: "purchase_order_lines.received_qty",
    unitCostCents: "purchase_order_lines.unit_cost_cents",
    unitCostMills: "purchase_order_lines.unit_cost_mills",
    expectedReceiveVariantId: "purchase_order_lines.expected_receive_variant_id",
    productVariantId: "purchase_order_lines.product_variant_id",
  },
  vendorInvoiceLines: {
    id: "vendor_invoice_lines.id",
    vendorInvoiceId: "vendor_invoice_lines.vendor_invoice_id",
    purchaseOrderLineId: "vendor_invoice_lines.purchase_order_line_id",
    productVariantId: "vendor_invoice_lines.product_variant_id",
    qtyInvoiced: "vendor_invoice_lines.qty_invoiced",
    unitCostCents: "vendor_invoice_lines.unit_cost_cents",
    unitCostMills: "vendor_invoice_lines.unit_cost_mills",
  },
  vendorInvoices: {
    id: "vendor_invoices.id",
    invoiceNumber: "vendor_invoices.invoice_number",
    status: "vendor_invoices.status",
  },
  auditEvents: { id: "audit_events.id" },
  vendorInvoicePoLinks: {},
  vendorInvoiceAttachments: {},
  apPayments: {},
  apPaymentAllocations: {},
  purchaseOrders: {},
  vendors: {},
  inboundFreightCosts: {},
  inboundShipments: {},
  poStatusHistory: {},
}));

const mocks = vi.hoisted(() => ({
  reconcilePurchaseCostEvidence: vi.fn(),
}));

vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("@shared/schema", () => tables);
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  and: vi.fn(),
  inArray: vi.fn((field: unknown, values: unknown[]) => ({ field, values })),
  sql: vi.fn(),
  desc: vi.fn(),
  lt: vi.fn(),
  lte: vi.fn(),
  gte: vi.fn(),
  ne: vi.fn(),
  asc: vi.fn((value: unknown) => value),
  like: vi.fn(),
}));
vi.mock("../../po-exceptions.service", () => ({
  detectMatchMismatch: vi.fn(),
  detectOverpaid: vi.fn(),
  detectPastDue: vi.fn(),
}));
vi.mock("../../../inventory/cogs.service", () => ({ COGSService: class {} }));
vi.mock("../../purchase-cost-application.service", () => ({
  reconcilePurchaseCostEvidence: mocks.reconcilePurchaseCostEvidence,
}));

function selectChain(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.for = vi.fn(() => Promise.resolve(rows));
  chain.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function clientFor(selectResults: unknown[][]) {
  const audits: unknown[] = [];
  return {
    select: vi.fn(() => selectChain(selectResults.shift() ?? [])),
    insert: vi.fn(() => ({
      values: vi.fn((row: unknown) => {
        audits.push(row);
        return Promise.resolve([]);
      }),
    })),
    audits,
  } as any;
}

const poLine = {
  id: 50,
  purchaseOrderId: 7,
  lineType: "product",
  status: "open",
  orderQty: 100,
  receivedQty: 0,
  unitCostCents: 5,
  unitCostMills: 500,
  expectedReceiveVariantId: 6,
  productVariantId: 5,
};

function invoiceLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 70,
    vendorInvoiceId: 12,
    productVariantId: 6,
    qtyInvoiced: 100,
    unitCostCents: 6,
    unitCostMills: 550,
    ...overrides,
  };
}

function componentResult(options: { evidence?: "confirmed" | "estimated" | "review_required"; product?: number; pieces?: number; review?: boolean } = {}) {
  const evidence = options.evidence ?? "confirmed";
  const review = options.review ?? evidence === "review_required";
  const issue = evidence === "review_required" ? { code: "INVOICE_COMPONENT_REVIEW_REQUIRED", message: "Resolve invoice components." } : null;
  return {
    lotsUpdated: review ? 0 : 1, cogsRowsUpdated: review ? 0 : 2, totalCogsDeltaCents: review ? 0 : 10,
    costApplications: [1, 2].map((id) => ({ applicationId: id, status: review ? "review_required" : "applied", lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0, issues: issue ? [issue] : [], replayed: false })),
    costSources: (["product", "packaging"] as const).map((component, index) => ({ id: index + 1, contract: {
      contractVersion: 1, revision: 1, fingerprint: "a".repeat(64), component,
      scope: { kind: "purchase_order_line", purchaseOrderId: 7, purchaseOrderLineId: 50 },
      sources: [{ kind: evidence === "estimated" ? "purchase_order_line" : "vendor_invoice_line", documentId: evidence === "estimated" ? 7 : 12, lineId: evidence === "estimated" ? 50 : 70, version: "b".repeat(64) }],
      currency: "USD", totalMills: component === "product" ? options.product ?? 55_000 : 5000,
      basePieces: options.pieces ?? 100, evidence, packagingTreatment: "separate", issue, manualOverride: null,
    } })),
  };
}
describe("approved invoice PO-line cost reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reconcilePurchaseCostEvidence.mockResolvedValue(componentResult());
  });

  it("reports confirmed invoice components only after their applications succeed", async () => {
    const client = clientFor([
      [poLine],
      [invoiceLine()],
      [{ id: 12, invoiceNumber: "INV-001", status: "approved" }],
    ]);
    const { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } =
      await import("../../ap-ledger.service");

    const result = await reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(
      50,
      client,
      "ops-user",
    );

    const { lockInventoryCostGraph } = await import("../../../inventory/infrastructure/cost-evidence.repository");
    expect(vi.mocked(lockInventoryCostGraph).mock.invocationCallOrder[0]).toBeLessThan(client.select.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({
      state: "confirmed_invoice_cost",
      authoritativeUnitCostMills: 550,
      approvedInvoiceIds: [12],
      approvedQty: "100",
    });
    expect(mocks.reconcilePurchaseCostEvidence).toHaveBeenCalledWith(client, 50, expect.any(Object), expect.any(String), expect.any(Date));
  });

  it("requires component review while approved invoice quantity is incomplete", async () => {
    mocks.reconcilePurchaseCostEvidence.mockResolvedValue(componentResult({ evidence: "review_required" }));
    const client = clientFor([
      [poLine],
      [invoiceLine({ qtyInvoiced: 40 })],
      [{ id: 12, invoiceNumber: "INV-001", status: "approved" }],
    ]);
    const { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } =
      await import("../../ap-ledger.service");

    const result = await reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(50, client);

    expect(result).toMatchObject({
      state: "review_required",
      authoritativeUnitCostMills: null,
      approvedQty: "40",
    });
    expect(mocks.reconcilePurchaseCostEvidence).toHaveBeenCalledWith(client, 50, expect.any(Object), expect.any(String), expect.any(Date));
  });

  it("uses the exact component total even when legacy invoice unit prices disagree", async () => {
    mocks.reconcilePurchaseCostEvidence.mockResolvedValue(componentResult({ product: 77700 }));
    const client = clientFor([
      [poLine],
      [
        invoiceLine({ qtyInvoiced: 40, unitCostMills: 550 }),
        invoiceLine({ id: 71, vendorInvoiceId: 13, qtyInvoiced: 60, unitCostMills: 575 }),
      ],
      [
        { id: 12, invoiceNumber: "INV-001", status: "paid" },
        { id: 13, invoiceNumber: "INV-002", status: "approved" },
      ],
    ]);
    const { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } =
      await import("../../ap-ledger.service");

    const result = await reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(50, client);

    expect(result).toMatchObject({
      state: "confirmed_invoice_cost",
      authoritativeUnitCostMills: 777,
      approvedInvoiceIds: [12, 13],
      approvedQty: "100",
    });
    expect(mocks.reconcilePurchaseCostEvidence).toHaveBeenCalledWith(client, 50, expect.any(Object), expect.any(String), expect.any(Date));
  });

  it("retains final received quantity diagnostics for a short-closed PO line", async () => {
    mocks.reconcilePurchaseCostEvidence.mockResolvedValue(componentResult({ product: 33000, pieces: 60 }));
    const client = clientFor([
      [{ ...poLine, status: "closed", receivedQty: 60 }],
      [invoiceLine({ qtyInvoiced: 60 })],
      [{ id: 12, invoiceNumber: "INV-SHORT", status: "approved" }],
    ]);
    const { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } =
      await import("../../ap-ledger.service");

    const result = await reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(50, client);

    expect(result).toMatchObject({
      state: "confirmed_invoice_cost",
      authoritativeUnitCostMills: 550,
      approvedQty: "60",
    });
  });

  it("reports estimated PO components when no invoice is approved", async () => {
    mocks.reconcilePurchaseCostEvidence.mockResolvedValue(componentResult({ evidence: "estimated", product: 50000 }));
    const client = clientFor([
      [poLine],
      [invoiceLine()],
      [{ id: 12, invoiceNumber: "INV-001", status: "voided" }],
    ]);
    const { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } =
      await import("../../ap-ledger.service");

    const result = await reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(50, client);

    expect(result).toMatchObject({
      state: "estimated_purchase_cost",
      authoritativeUnitCostMills: 500,
      approvedInvoiceIds: [],
      approvedQty: "0",
    });
  });
  it("does not claim an authoritative scalar while exact components need lineage review", async () => {
    mocks.reconcilePurchaseCostEvidence.mockResolvedValue(componentResult({ review: true }));
    const client = clientFor([[poLine], [invoiceLine()], [{ id: 12, status: "approved" }]]);
    const { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } = await import("../../ap-ledger.service");
    const result = await reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(50, client, "operator");
    expect(result).toMatchObject({ state: "review_required", authoritativeUnitCostMills: null,
      costSourceState: "confirmed", costApplicationState: "review_required", quantityCoverage: { complete: true } });
    expect(client.audits).toEqual([expect.objectContaining({ context: expect.objectContaining({ state: "review_required", authoritativeUnitCostMills: null }) })]);
  });

  it("preserves exact source totals without claiming a rounded per-piece scalar", async () => {
    mocks.reconcilePurchaseCostEvidence.mockResolvedValue(componentResult({ product: 56501 }));
    const client = clientFor([[poLine], [invoiceLine()], [{ id: 12, status: "approved" }]]);
    const { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } = await import("../../ap-ledger.service");
    const result = await reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(50, client);
    expect(result).toMatchObject({ state: "confirmed_invoice_cost", authoritativeUnitCostMills: null,
      costSources: [{ contract: { totalMills: 56501, basePieces: 100 } }, { contract: { totalMills: 5000 } }] });
  });

  it("cannot treat missing component applications as completed cost authority", async () => {
    mocks.reconcilePurchaseCostEvidence.mockResolvedValue({ ...componentResult(), costApplications: [] });
    const client = clientFor([[poLine], [invoiceLine()], [{ id: 12, status: "approved" }]]);
    const { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } = await import("../../ap-ledger.service");
    expect(await reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(50, client)).toMatchObject({ state: "review_required", authoritativeUnitCostMills: null });
  });
});
