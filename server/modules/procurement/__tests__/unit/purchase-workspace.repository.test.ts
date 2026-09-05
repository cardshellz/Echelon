import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createPurchaseWorkspaceRepository, PURCHASE_WORKSPACE_RECORD_LIMIT } from "../../purchase-workspace.repository";

const dialect = new PgDialect();
const purchase = {
  id: 17, poNumber: "PO-017", status: "sent", physicalStatus: "sent", financialStatus: "unbilled",
  currency: "USD", vendorName: "Fixture supplier", totalCents: "12345",
  invoicedTotalCents: "0", paidTotalCents: "0", outstandingCents: "0",
  expectedDeliveryDate: new Date("2026-10-01T12:00:00Z"), confirmedDeliveryDate: null, actualDeliveryDate: null,
};
const receipt = {
  id: 31, receiptNumber: "RCV-DRAFT", status: "draft", purchaseOrderId: 17,
  inboundShipmentId: null, expectedDate: null, receivedDate: null, closedDate: null,
};

function setup(overrides: Record<string, unknown> = {}, receiptRows = [receipt]) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const execute = vi.fn(async (query: SQL) => {
    const compiled = dialect.sqlToQuery(query);
    statements.push(compiled);
    if (compiled.sql.includes("FROM procurement.purchase_orders p")) return { rows: [{ ...purchase, ...overrides }] };
    if (compiled.sql.includes("FROM procurement.receiving_orders ro")) return { rows: receiptRows };
    return { rows: [] };
  });
  const transaction = vi.fn(async (callback: (executor: { execute: typeof execute }) => Promise<unknown>) => callback({ execute }));
  // The fake implements the transaction/execute read boundary only; SQL is
  // compiled with the real PostgreSQL dialect for parameterization inspection.
  const repository = createPurchaseWorkspaceRepository({ transaction } as unknown as Parameters<typeof createPurchaseWorkspaceRepository>[0]);
  return { repository, statements, transaction };
}

describe("purchase workspace repository boundary", () => {
  it("preserves exact bigint/null values and serializes recorded dates without mutating source rows", async () => {
    const { repository, transaction, statements } = setup({ totalCents: "-12345", outstandingCents: null });
    const result = await repository.read(17);
    expect(result?.purchase).toMatchObject({ totalCents: -12345, outstandingCents: null, expectedDeliveryDate: "2026-10-01T12:00:00.000Z" });
    expect(result?.receipts).toEqual([receipt]);
    expect(result?.directReceiptIds).toEqual([31]);
    expect(purchase.totalCents).toBe("12345");
    expect(transaction.mock.calls[0][1]).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
    expect(statements).toHaveLength(5);
    expect(statements.every((statement) => statement.sql.trimStart().startsWith("SELECT"))).toBe(true);
    expect(statements[0].params).toContain(17);
    expect(statements[0].sql).not.toContain("p.id = 17");
  });

  it.each(["9007199254740992", "-9007199254740992", "1.25", "1e3", "", Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unsafe or non-integer recorded money value %s",
    async (totalCents) => {
      const { repository } = setup({ totalCents });
      await expect(repository.read(17)).rejects.toMatchObject({ code: "PURCHASE_WORKSPACE_MONEY_INVALID", statusCode: 500 });
    },
  );

  it.each([String(Number.MAX_SAFE_INTEGER), String(Number.MIN_SAFE_INTEGER)])("retains the safe integer boundary %s", async (value) => {
    const result = await setup({ totalCents: value }).repository.read(17);
    expect(result?.purchase.totalCents).toBe(Number(value));
  });

  it("fails on malformed recorded dates instead of inventing a milestone", async () => {
    await expect(setup({ expectedDeliveryDate: "not-a-date" }).repository.read(17))
      .rejects.toMatchObject({ code: "PURCHASE_WORKSPACE_DATE_INVALID" });
  });

  it("fails explicitly when a bounded read exceeds its record limit", async () => {
    const rows = Array.from({ length: PURCHASE_WORKSPACE_RECORD_LIMIT + 1 }, (_, index) => ({ ...receipt, id: index + 1 }));
    await expect(setup({}, rows).repository.read(17)).rejects.toMatchObject({ code: "PURCHASE_WORKSPACE_TOO_LARGE", statusCode: 422 });
  });

  it("propagates database failure without returning an empty or successful workspace", async () => {
    const failure = new Error("Database unavailable");
    const repository = createPurchaseWorkspaceRepository({
      transaction: vi.fn().mockRejectedValue(failure),
    } as unknown as Parameters<typeof createPurchaseWorkspaceRepository>[0]);
    await expect(repository.read(17)).rejects.toBe(failure);
  });
});
