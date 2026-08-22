import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));

vi.mock("../../../../db", () => ({
  db: { transaction: mocks.transaction },
}));

import { PostgresReturnCaseOperationStore } from "../../infrastructure/return-case-operation.repository";

const NOW = new Date("2026-08-22T15:00:00.000Z");

function qtext(query: any): string {
  return (query?.queryChunks ?? [])
    .flatMap((chunk: any) => {
      if (chunk == null) return [];
      if (typeof chunk === "string") return [chunk];
      if (Array.isArray(chunk.value)) return chunk.value;
      if (chunk.value !== undefined) return [String(chunk.value)];
      return [];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("PostgresReturnCaseOperationStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acquires the shared OMS quantity lock before row locks and projects exact evidence", async () => {
    const execute = operationReader();
    mocks.transaction.mockImplementation(async (work) => work({ execute }));
    const store = new PostgresReturnCaseOperationStore();

    const aggregate = await store.transaction((tx) => tx.loadForUpdate(42));

    expect(aggregate).toMatchObject({
      caseId: 42,
      caseNumber: "RET-0000000042",
      omsOrderId: 50,
      wmsReturnId: 230,
      actionContext: {
        policy: { id: 6, version: 2, labelProvider: "shipstation" },
        receipt: {
          wmsReturnId: 230,
          canonicalItemCount: 2,
          items: [
            { returnCaseItemId: 11, wmsReturnItemId: 101, wmsReceivedQuantity: 0 },
            { returnCaseItemId: 12, wmsReturnItemId: 102, wmsReceivedQuantity: 1 },
          ],
        },
      },
    });

    const statements = execute.mock.calls.map(([query]) => qtext(query));
    const identityRead = statements.findIndex((text) => text.startsWith("SELECT oms_order_id FROM returns.return_cases"));
    const advisoryLock = statements.findIndex((text) => text.startsWith("SELECT pg_advisory_xact_lock"));
    const caseLock = statements.findIndex((text) => text.includes("FROM returns.return_cases") && text.endsWith("FOR UPDATE"));
    const wmsHeaderLock = statements.findIndex((text) => text.startsWith("SELECT id, status, received_at, restocked FROM wms.returns"));
    const wmsItemLock = statements.findIndex((text) => text.includes("FROM wms.return_items ri"));
    expect([identityRead, advisoryLock, caseLock, wmsHeaderLock, wmsItemLock].every((index) => index >= 0)).toBe(true);
    expect(identityRead).toBeLessThan(advisoryLock);
    expect(advisoryLock).toBeLessThan(caseLock);
    expect(caseLock).toBeLessThan(wmsHeaderLock);
    expect(wmsHeaderLock).toBeLessThan(wmsItemLock);
  });

  it.each([
    {
      name: "snapshot identity does not match the immutable case",
      override: { policy_version: 3 },
    },
    {
      name: "snapshot contains an invalid enum value",
      override: { policy_snapshot: { ...policySnapshot(), labelProvider: "invalid" } },
    },
  ])("fails policy evidence closed when $name", async ({ override }) => {
    const execute = operationReader(override);
    mocks.transaction.mockImplementation(async (work) => work({ execute }));
    const store = new PostgresReturnCaseOperationStore();

    const aggregate = await store.transaction((tx) => tx.loadForUpdate(42));

    expect(aggregate?.actionContext.policy).toBeNull();
  });
});

function operationReader(caseOverride: Record<string, unknown> = {}) {
  return vi.fn(async (query: any) => {
    const text = qtext(query);
    if (text.startsWith("SELECT oms_order_id FROM returns.return_cases")) {
      return { rows: [{ oms_order_id: 50 }] };
    }
    if (text.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [{}] };
    if (text.includes("SELECT id, case_number, oms_order_id, wms_return_id")) {
      return { rows: [{ ...caseRow(), ...caseOverride }] };
    }
    if (text.startsWith("SELECT id, status, received_at, restocked FROM wms.returns")) {
      return { rows: [{ id: 230, status: "partially_received", received_at: NOW, restocked: false }] };
    }
    if (text.includes("FROM wms.return_items ri")) {
      return {
        rows: [
          {
            return_case_item_id: 11,
            canonical_quantity: 2,
            wms_return_item_id: 101,
            expected_qty: 2,
            received_qty: 0,
            status: "expected",
          },
          {
            return_case_item_id: 12,
            canonical_quantity: 3,
            wms_return_item_id: 102,
            expected_qty: 3,
            received_qty: 1,
            status: "partially_received",
          },
        ],
      };
    }
    if (text.startsWith("SELECT COUNT(*)::integer AS total FROM returns.return_case_items")) {
      return { rows: [{ total: 2 }] };
    }
    if (text.includes("FROM returns.return_case_inspections")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${text}`);
  });
}

function caseRow() {
  return {
    id: 42,
    case_number: "RET-0000000042",
    oms_order_id: 50,
    wms_return_id: 230,
    case_status: "open",
    approval_status: "approved",
    logistics_status: "partially_received",
    inspection_status: "pending",
    customer_refund_status: "pending",
    vendor_settlement_status: "not_applicable",
    policy_id: 6,
    policy_version: 2,
    policy_snapshot: policySnapshot(),
  };
}

function policySnapshot() {
  return {
    id: 6,
    name: "Shopify retail returns",
    version: 2,
    scopeKind: "channel_context",
    scopeKey: "context:retail:channel:36",
    returnWindowDays: 32,
    returnDestination: "card_shellz",
    approvalAuthority: "card_shellz",
    labelProvider: "shipstation",
    returnShippingPayer: "customer",
    inspectionRequirement: "required",
    inspectionOwner: "card_shellz",
    customerRefundAuthority: "card_shellz",
    vendorSettlementTrigger: "none",
    returnlessRefundAllowed: false,
  };
}
