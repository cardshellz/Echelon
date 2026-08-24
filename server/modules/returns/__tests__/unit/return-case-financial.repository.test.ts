import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipReturnWalletSettlementPort } from "../../../dropship/application/return-wallet-settlement.port";
import type {
  ReturnCaseAdminStore,
  ReturnCaseDetailRow,
} from "../../application/return-case-admin.service";
import type {
  ReturnFinancialCaseSource,
  VendorSettlementQuote,
} from "../../application/return-case-financial.service";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  persistAuditEvent: vi.fn(),
}));

vi.mock("../../../../db", () => ({
  db: {},
  pool: { connect: mocks.connect, query: mocks.query },
}));

vi.mock("../../../../infrastructure/auditLogger", () => ({
  persistAuditEvent: mocks.persistAuditEvent,
}));

vi.mock("../../infrastructure/return-case.repository", () => ({
  PostgresReturnCaseAdminStore: class PostgresReturnCaseAdminStore {
    getById = vi.fn();
  },
}));

import {
  PostgresReturnCaseFinancialSourceStore,
  PostgresReturnCaseVendorSettlementStore,
} from "../../infrastructure/return-case-financial.repository";

const NOW = new Date("2026-08-23T20:00:00.000Z");
const REQUEST_HASH = "a".repeat(64);
const QUOTE_HASH = "b".repeat(64);

describe("PostgresReturnCaseFinancialSourceStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a legacy immutable RMA item through its exact OMS order line", async () => {
    const adminStore = adminStoreWith(financialDetail());
    mocks.query.mockImplementation(async (text: string, params: unknown[]) => {
      const sql = normalizeSql(text);
      if (sql.includes("FROM oms.oms_orders")) {
        expect(params).toEqual([653408]);
        return result([{ external_order_id: "653408", currency: "USD" }]);
      }
      expect(sql).toContain("FROM oms.oms_order_lines");
      expect(sql).toContain("WHERE order_id = $1");
      expect(params).toEqual([653408, [114910]]);
      return result([{ id: "114910", external_line_item_id: "36002367799455" }]);
    });

    const store = new PostgresReturnCaseFinancialSourceStore(adminStore);
    const loaded = await store.loadCase(1);

    expect(loaded?.items[0].externalLineItemId).toBe("36002367799455");
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the immutable snapshot conflicts with the OMS line", async () => {
    const adminStore = adminStoreWith(financialDetail({ externalLineItemId: "other-line" }));
    mockOmsIdentity([{ id: "114910", external_line_item_id: "36002367799455" }]);

    const store = new PostgresReturnCaseFinancialSourceStore(adminStore);
    await expect(store.loadCase(1)).rejects.toMatchObject({
      code: "RETURN_FINANCIAL_LINE_IDENTITY_CONFLICT",
      status: 409,
      context: expect.objectContaining({ reason: "EXTERNAL_LINE_ID_MISMATCH" }),
    });
  });

  it("fails closed when the linked OMS line does not belong to the source order", async () => {
    const adminStore = adminStoreWith(financialDetail());
    mockOmsIdentity([]);

    const store = new PostgresReturnCaseFinancialSourceStore(adminStore);
    await expect(store.loadCase(1)).rejects.toMatchObject({
      code: "RETURN_FINANCIAL_LINE_IDENTITY_CONFLICT",
      status: 409,
      context: expect.objectContaining({ reason: "OMS_LINE_NOT_IN_SOURCE_ORDER" }),
    });
  });

  it("preserves a stored identity when an older item has no OMS line link", async () => {
    const adminStore = adminStoreWith(financialDetail({
      omsOrderLineId: null,
      externalLineItemId: "legacy-line",
    }));
    mockOmsIdentity([]);

    const store = new PostgresReturnCaseFinancialSourceStore(adminStore);
    const loaded = await store.loadCase(1);

    expect(loaded?.items[0].externalLineItemId).toBe("legacy-line");
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});

describe("PostgresReturnCaseVendorSettlementStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistAuditEvent.mockResolvedValue(undefined);
  });

  it("loads immutable replay evidence without consulting mutable return state", async () => {
    const replay = settlementResult(true);
    const query = vi.fn(async (text: string) => {
      expect(normalizeSql(text)).toContain("FROM returns.return_case_commands");
      return result([{ request_hash: REQUEST_HASH, response: replay }]);
    });
    const release = vi.fn();
    mocks.connect.mockResolvedValue({ query, release });

    const store = new PostgresReturnCaseVendorSettlementStore(wallet());
    await expect(store.findReplay("settlement-command-42", REQUEST_HASH)).resolves.toEqual(replay);

    expect(query).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("records settlement, wallet links, lifecycle, command, event, and audit in one transaction", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (text: string) => {
      const sql = normalizeSql(text);
      statements.push(sql);
      if (sql.includes("FROM returns.return_case_commands")) return result([]);
      if (sql.includes("FROM returns.return_case_vendor_settlements settlement")) return result([]);
      if (sql.startsWith("SELECT id, case_number, business_context")) return result([lockedCase()]);
      if (sql.startsWith("INSERT INTO returns.return_case_vendor_settlements")) return result([{ id: 91 }]);
      if (sql.startsWith("UPDATE returns.return_cases")) return result([{ id: 42 }]);
      return result([]);
    });
    const release = vi.fn();
    const walletPort = wallet();
    mocks.connect.mockResolvedValue({ query, release });

    const store = new PostgresReturnCaseVendorSettlementStore(walletPort);
    const output = await store.settle(settleInput());

    expect(output).toEqual(settlementResult(false));
    expect(walletPort.post).toHaveBeenCalledWith(expect.objectContaining({
      tx: expect.objectContaining({ query }),
      returnCaseId: 42,
      vendorSettlementId: 91,
      vendorId: 22,
      grossCreditCents: 1_000,
      totalFeeCents: 125,
      idempotencyKey: "settlement-command-42",
      requestHash: REQUEST_HASH,
    }));
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements).not.toContain("ROLLBACK");
    expect(statements.some((sql) => sql.startsWith("INSERT INTO returns.return_case_vendor_settlement_ledger_entries"))).toBe(true);
    expect(statements.some((sql) => sql.startsWith("INSERT INTO returns.return_case_events"))).toBe(true);
    expect(statements.some((sql) => sql.startsWith("INSERT INTO returns.return_case_commands"))).toBe(true);
    expect(statements.join(" ")).not.toMatch(/\b(?:inventory|wms|oms)\./);
    expect(mocks.persistAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: "user:9",
        action: "RETURN_CASE_VENDOR_ACCOUNT_SETTLED",
        target: "returns.return_cases:42",
      }),
      { timestamp: NOW, emitStructuredLog: false },
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rolls back all return evidence when the dropship-owned wallet mutation fails", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (text: string) => {
      const sql = normalizeSql(text);
      statements.push(sql);
      if (sql.includes("FROM returns.return_case_commands")) return result([]);
      if (sql.includes("FROM returns.return_case_vendor_settlements settlement")) return result([]);
      if (sql.startsWith("SELECT id, case_number, business_context")) return result([lockedCase()]);
      if (sql.startsWith("INSERT INTO returns.return_case_vendor_settlements")) return result([{ id: 91 }]);
      return result([]);
    });
    const walletPort = wallet();
    vi.mocked(walletPort.post).mockRejectedValueOnce(new Error("wallet write failed"));
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });

    const store = new PostgresReturnCaseVendorSettlementStore(walletPort);
    await expect(store.settle(settleInput())).rejects.toMatchObject({
      code: "RETURN_VENDOR_SETTLEMENT_FAILED",
      status: 500,
    });

    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(statements.some((sql) => sql.startsWith("UPDATE returns.return_cases"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("INSERT INTO returns.return_case_events"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("INSERT INTO returns.return_case_commands"))).toBe(false);
    expect(mocks.persistAuditEvent).not.toHaveBeenCalled();
  });
});

function settleInput() {
  return {
    source: source(),
    quote: quote(),
    quoteHash: QUOTE_HASH,
    requestHash: REQUEST_HASH,
    idempotencyKey: "settlement-command-42",
    notes: "Vendor responsibility confirmed",
    actor: "user:9",
    now: NOW,
  };
}

function source(): ReturnFinancialCaseSource {
  return {
    caseId: 42,
    caseNumber: "RET-0000000042",
    businessContext: "dropship",
    channelProvider: null,
    channelId: null,
    vendorId: 22,
    storeConnectionId: 9,
    omsOrderId: 500,
    externalOrderId: "marketplace-order-500",
    currency: "USD",
    policyVersion: 2,
    updatedAt: NOW,
    actionContext: {} as ReturnFinancialCaseSource["actionContext"],
    items: [],
  };
}

function adminStoreWith(detail: ReturnCaseDetailRow): Pick<ReturnCaseAdminStore, "getById"> {
  return { getById: vi.fn().mockResolvedValue(detail) };
}

function financialDetail(
  itemOverrides: Partial<ReturnCaseDetailRow["items"][number]> = {},
): ReturnCaseDetailRow {
  return {
    recordOrigin: "canonical",
    recordKey: "canonical:1",
    legacyRmaId: null,
    id: 1,
    caseNumber: "RET-0000000001",
    sourceProvider: "admin",
    sourceEventType: "manual_return_case_opened",
    sourceEventId: "returns-admin:1",
    businessContext: "retail",
    channelId: 36,
    channelName: "Shopify",
    vendorId: null,
    vendorName: null,
    storeConnectionId: null,
    storeName: null,
    omsOrderId: 653408,
    omsOrderNumber: "#61694",
    wmsOrderId: 206955,
    wmsOrderNumber: "#61694",
    wmsReturnId: 230,
    caseStatus: "open",
    approvalStatus: "approved",
    logisticsStatus: "received",
    inspectionStatus: "approved",
    customerRefundStatus: "pending",
    vendorSettlementStatus: "not_applicable",
    openedAt: NOW,
    closedAt: null,
    itemCount: 1,
    unitCount: 1,
    policyId: 6,
    policyVersion: 2,
    policySnapshot: {},
    createdAt: NOW,
    updatedAt: NOW,
    items: [{
      id: 1,
      wmsReturnItemId: 41,
      omsOrderLineId: 114910,
      wmsOrderItemId: 317291,
      productVariantId: 700,
      externalLineItemId: null,
      sku: "SHLZ-TOP-180PT-BLU-P10",
      title: "180PT 3x4 Premium Toploader - UV Shield - Blue Hint - Pack of 10",
      quantity: 1,
      expectedQuantity: 1,
      receivedQuantity: 1,
      remainingQuantity: 0,
      receiptStatus: "received",
      unitPaidPriceCents: 495,
      sourceLineTotalCents: 495,
      createdAt: NOW,
      ...itemOverrides,
    }],
    events: [],
    actionContext: { channelProvider: "shopify" } as ReturnCaseDetailRow["actionContext"],
  };
}

function mockOmsIdentity(rows: Array<{ id: string; external_line_item_id: string | null }>): void {
  mocks.query.mockImplementation(async (text: string) => {
    const sql = normalizeSql(text);
    if (sql.includes("FROM oms.oms_orders")) {
      return result([{ external_order_id: "653408", currency: "USD" }]);
    }
    return result(rows);
  });
}

function quote(): VendorSettlementQuote {
  return {
    currency: "USD",
    faultCategory: "vendor",
    returnShippingActualCents: null,
    settlement: {
      productCreditCents: 1_000,
      originalShippingCreditCents: 0,
      restockingFeeCents: 50,
      processingFeeCents: 75,
      returnShippingFeeCents: 0,
      grossCreditCents: 1_000,
      totalFeeCents: 125,
      netSettlementCents: 875,
      creditLedgerType: "return_credit",
      breakdown: { version: 1, faultCategory: "vendor" },
    },
    policyFeeIds: {
      restockingFeeId: 1,
      processingFeeId: 2,
      returnShippingFeeId: null,
    },
  };
}

function settlementResult(replayed: boolean) {
  return {
    commandType: "settle_vendor_account" as const,
    caseId: 42,
    caseNumber: "RET-0000000042",
    vendorSettlementId: 91,
    vendorId: 22,
    currency: "USD",
    grossCreditCents: 1_000,
    totalFeeCents: 125,
    netSettlementCents: 875,
    walletLedgerIds: [501, 502],
    settledAt: NOW.toISOString(),
    replayed,
  };
}

function wallet(): DropshipReturnWalletSettlementPort {
  return {
    post: vi.fn().mockResolvedValue([
      { walletLedgerId: 501, role: "credit", amountCents: 1_000 },
      { walletLedgerId: 502, role: "fee", amountCents: -125 },
    ]),
  };
}

function lockedCase() {
  return {
    id: 42,
    case_number: "RET-0000000042",
    business_context: "dropship",
    channel_id: null,
    vendor_id: 22,
    oms_order_id: 500,
    case_status: "open",
    approval_status: "approved",
    inspection_status: "approved",
    customer_refund_status: "not_required",
    vendor_settlement_status: "pending",
    updated_at: NOW,
  };
}

function result<T extends Record<string, unknown>>(rows: T[]) {
  return { rows, rowCount: rows.length };
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
