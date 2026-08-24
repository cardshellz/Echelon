import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReturnFinancialCaseSource } from "../../application/return-case-financial.service";

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

import { PostgresReturnCaseCustomerRefundStore } from "../../infrastructure/return-case-financial.repository";

const NOW = new Date("2026-08-23T20:00:00.000Z");

describe("PostgresReturnCaseCustomerRefundStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistAuditEvent.mockResolvedValue(undefined);
  });

  it("rolls back confirmed provider evidence when the canonical refund lifecycle CAS fails", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (text: string) => {
      const sql = normalizeSql(text);
      statements.push(sql);
      if (sql.startsWith("SELECT id, status, amount_cents")) {
        return result([{
          id: 81,
          status: "pending",
          amount_cents: 525,
          notify_customer: true,
          idempotency_key: "refund-command-42",
          request_hash: "a".repeat(64),
        }]);
      }
      if (sql.startsWith("SELECT id, case_number, business_context")) return result([lockedCase()]);
      if (sql.startsWith("UPDATE returns.return_case_customer_refunds")) return result([{ id: 81 }]);
      if (sql.startsWith("UPDATE returns.return_cases")) return result([]);
      return result([]);
    });
    const release = vi.fn();
    mocks.connect.mockResolvedValue({ query, release });

    const store = new PostgresReturnCaseCustomerRefundStore();
    await expect(store.complete({
      customerRefundId: 81,
      source: source(),
      execution: {
        providerRefundId: "gid://shopify/Refund/900",
        completedAt: NOW,
        rawResult: { refundId: "gid://shopify/Refund/900" },
      },
      actor: "user:7",
      now: NOW,
    })).rejects.toMatchObject({ code: "RETURN_FINANCIAL_STATE_STALE", status: 409 });

    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(statements.some((sql) => sql.startsWith("INSERT INTO returns.return_case_events"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("INSERT INTO returns.return_case_commands"))).toBe(false);
    expect(mocks.persistAuditEvent).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

function source(): ReturnFinancialCaseSource {
  return {
    caseId: 42,
    caseNumber: "RET-0000000042",
    businessContext: "retail",
    channelProvider: "shopify",
    channelId: 36,
    vendorId: null,
    storeConnectionId: null,
    omsOrderId: 500,
    externalOrderId: "gid://shopify/Order/500",
    currency: "USD",
    policyVersion: 2,
    updatedAt: NOW,
    actionContext: {} as ReturnFinancialCaseSource["actionContext"],
    items: [],
  };
}

function lockedCase() {
  return {
    id: 42,
    case_number: "RET-0000000042",
    business_context: "retail",
    channel_id: 36,
    vendor_id: null,
    oms_order_id: 500,
    case_status: "open",
    approval_status: "approved",
    inspection_status: "approved",
    customer_refund_status: "pending",
    vendor_settlement_status: "not_applicable",
    updated_at: NOW,
  };
}

function result<T extends Record<string, unknown>>(rows: T[]) {
  return { rows, rowCount: rows.length };
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
