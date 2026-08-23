import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));

vi.mock("../../../../db", () => ({
  db: { transaction: mocks.transaction },
}));

import type { ReturnCaseOperationAggregate } from "../../application/return-case-operations.service";
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

  it("uses the same active-first, latest-terminal, cancelled-excluding selection in the detail repository", () => {
    const source = readFileSync(
      "server/modules/returns/infrastructure/return-case.repository.ts",
      "utf8",
    );

    expect(source).toContain("IN ('in_progress', 'approved', 'rejected')");
    expect(source).toContain("CASE WHEN ${returnCaseInspections.status} = 'in_progress' THEN 0 ELSE 1 END");
    expect(source).toContain("sql`${returnCaseInspections.id} DESC`");
    expect(source).toContain(".limit(1)");
    expect(source).not.toContain('eq(returnCaseInspections.status, "in_progress")');
  });
  it("loads the active inspection first and otherwise the latest approved or rejected terminal evidence", async () => {
    const execute = operationReader({ inspection_status: "approved" }, [{
      id: 9,
      status: "approved",
      started_at: new Date("2026-08-22T14:00:00.000Z"),
      started_by: "user:6",
      completed_at: NOW,
      completed_by: "user:7",
    }]);
    mocks.transaction.mockImplementation(async (work) => work({ execute }));
    const store = new PostgresReturnCaseOperationStore();

    const aggregate = await store.transaction((tx) => tx.loadForUpdate(42));

    expect(aggregate?.actionContext.inspection).toMatchObject({
      inspectionId: 9,
      status: "approved",
      completedAt: NOW,
      completedBy: "user:7",
    });
    const query = execute.mock.calls.map(([statement]) => qtext(statement))
      .find((text) => text.includes("FROM returns.return_case_inspections"));
    expect(query).toContain("status IN ('in_progress', 'approved', 'rejected')");
    expect(query).toContain("CASE WHEN status = 'in_progress' THEN 0 ELSE 1 END");
    expect(query).toContain("id DESC LIMIT 1 FOR UPDATE");
    expect(query).not.toContain("cancelled");
  });

  it("completes an inspection with two exact CAS updates and no stock, refund, settlement, or case closure writes", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = qtext(query);
      if (text.startsWith("UPDATE returns.return_case_inspections")) return { rows: [{ id: 9 }] };
      if (text.startsWith("UPDATE returns.return_cases")) return { rows: [{ id: 42 }] };
      return { rows: [] };
    });
    const auditValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn(() => ({ values: auditValues }));
    mocks.transaction.mockImplementation(async (work) => work({ execute, insert }));
    const store = new PostgresReturnCaseOperationStore();

    const result = await store.transaction((tx) => tx.persistCompleteInspection({
      aggregate: completionAggregate(),
      inspectionId: 9,
      idempotencyKey: "complete-9",
      requestHash: "a".repeat(64),
      actor: "user:7",
      outcome: "approved",
      notes: "sealed product",
      now: NOW,
    }));

    expect(result).toEqual({
      commandType: "complete_inspection",
      caseId: 42,
      caseNumber: "RET-0000000042",
      inspectionId: 9,
      inspectionStatus: "approved",
      completedAt: NOW.toISOString(),
      replayed: false,
    });
    const statements = execute.mock.calls.map(([query]) => qtext(query));
    const inspectionUpdate = statements.find((text) => text.startsWith("UPDATE returns.return_case_inspections"));
    const caseUpdate = statements.find((text) => text.startsWith("UPDATE returns.return_cases"));
    expect(inspectionUpdate).toContain("completion_notes");
    expect(inspectionUpdate).toContain("status = 'in_progress' AND completed_at IS NULL AND completed_by IS NULL RETURNING id");
    expect(caseUpdate).toContain("SET inspection_status =");
    expect(caseUpdate).toContain("inspection_status = 'in_progress' RETURNING id");
    expect(caseUpdate).not.toMatch(/customer_refund_status|vendor_settlement_status|case_status|closed_at/);
    expect(statements.join(" ")).not.toMatch(/\b(?:wms|inventory|oms)\./);
    expect(statements.some((text) => text.startsWith("INSERT INTO returns.return_case_events"))).toBe(true);
    expect(statements.some((text) => text.startsWith("INSERT INTO returns.return_case_commands"))).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      action: "RETURN_CASE_INSPECTION_COMPLETED",
      context: expect.objectContaining({ policyId: 6, policyVersion: 2 }),
    }));
  });

  it.each([
    { failedTarget: "inspection" as const, expectedCalls: 1 },
    { failedTarget: "case" as const, expectedCalls: 2 },
  ])("fails completion closed when the $failedTarget CAS does not affect exactly one row", async ({
    failedTarget,
    expectedCalls,
  }) => {
    const execute = vi.fn(async (query: any) => {
      const text = qtext(query);
      if (text.startsWith("UPDATE returns.return_case_inspections")) {
        return { rows: failedTarget === "inspection" ? [] : [{ id: 9 }] };
      }
      if (text.startsWith("UPDATE returns.return_cases")) {
        return { rows: failedTarget === "case" ? [] : [{ id: 42 }] };
      }
      throw new Error(`Unexpected SQL after failed CAS: ${text}`);
    });
    mocks.transaction.mockImplementation(async (work) => work({ execute }));
    const store = new PostgresReturnCaseOperationStore();

    await expect(store.transaction((tx) => tx.persistCompleteInspection({
      aggregate: completionAggregate(),
      inspectionId: 9,
      idempotencyKey: `complete-stale-${failedTarget}`,
      requestHash: "b".repeat(64),
      actor: "user:7",
      outcome: "rejected",
      notes: null,
      now: NOW,
    }))).rejects.toMatchObject({
      code: "RETURN_CASE_INSPECTION_STATE_STALE",
      status: 409,
      context: { caseId: 42, inspectionId: 9, target: failedTarget, affectedRows: 0 },
    });
    expect(execute).toHaveBeenCalledTimes(expectedCalls);
  });

  it("parses persisted completion results for idempotent replay", async () => {
    const execute = vi.fn(async () => ({
      rows: [{
        command_type: "complete_inspection",
        request_hash: "c".repeat(64),
        response: {
          commandType: "complete_inspection",
          caseId: 42,
          caseNumber: "RET-0000000042",
          inspectionId: 9,
          inspectionStatus: "rejected",
          completedAt: NOW.toISOString(),
          replayed: false,
        },
      }],
    }));
    mocks.transaction.mockImplementation(async (work) => work({ execute }));
    const store = new PostgresReturnCaseOperationStore();

    const command = await store.transaction((tx) => tx.findCommand("complete-9"));

    expect(command).toEqual({
      commandType: "complete_inspection",
      requestHash: "c".repeat(64),
      result: {
        commandType: "complete_inspection",
        caseId: 42,
        caseNumber: "RET-0000000042",
        inspectionId: 9,
        inspectionStatus: "rejected",
        completedAt: NOW.toISOString(),
        replayed: false,
      },
    });
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

function operationReader(
  caseOverride: Record<string, unknown> = {},
  inspectionRows: Array<Record<string, unknown>> = [],
) {
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
    if (text.includes("FROM returns.return_case_inspections")) return { rows: inspectionRows };
    throw new Error(`Unexpected SQL: ${text}`);
  });
}

function completionAggregate(): ReturnCaseOperationAggregate {
  return {
    caseId: 42,
    caseNumber: "RET-0000000042",
    omsOrderId: 50,
    wmsReturnId: 230,
    actionContext: {
      lifecycle: {
        caseStatus: "open",
        approvalStatus: "approved",
        logisticsStatus: "received",
        inspectionStatus: "in_progress",
        customerRefundStatus: "pending",
        vendorSettlementStatus: "not_applicable",
      },
      policy: policySnapshot(),
      receipt: {
        wmsReturnId: 230,
        wmsStatus: "received",
        receivedAt: new Date("2026-08-22T14:00:00.000Z"),
        restocked: false,
        canonicalItemCount: 1,
        items: [{
          returnCaseItemId: 11,
          wmsReturnItemId: 101,
          caseExpectedQuantity: 1,
          wmsExpectedQuantity: 1,
          wmsReceivedQuantity: 1,
          wmsStatus: "received",
        }],
      },
      inspection: {
        inspectionId: 9,
        status: "in_progress",
        startedAt: new Date("2026-08-22T14:30:00.000Z"),
        startedBy: "user:6",
        completedAt: null,
        completedBy: null,
      },
      conditionalInspectionDecision: null,
    },
  };
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
