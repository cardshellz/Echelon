import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipReturnWalletSettlementPort } from "../../../dropship/application/return-wallet-settlement.port";
import type {
  ReturnFinancialCaseSource,
  VendorSettlementQuote,
} from "../../application/return-case-financial.service";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  persistAuditEvent: vi.fn(),
}));

vi.mock("../../../../db", () => ({
  db: {},
  pool: { connect: mocks.connect },
}));

vi.mock("../../../../infrastructure/auditLogger", () => ({
  persistAuditEvent: mocks.persistAuditEvent,
}));

vi.mock("../../infrastructure/return-case.repository", () => ({
  PostgresReturnCaseAdminStore: class PostgresReturnCaseAdminStore {
    getById = vi.fn();
  },
}));

import { PostgresReturnCaseVendorSettlementStore } from "../../infrastructure/return-case-financial.repository";

const NOW = new Date("2026-08-23T20:00:00.000Z");
const REQUEST_HASH = "a".repeat(64);
const QUOTE_HASH = "b".repeat(64);

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
