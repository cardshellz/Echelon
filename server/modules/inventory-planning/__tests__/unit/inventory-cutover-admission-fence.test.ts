import { describe, expect, it, vi } from "vitest";
import {
  acquireInventoryCutoverFenceInsideTransaction,
  assertInventoryCutoverFenceHeldInsideTransaction,
} from "../../infrastructure/inventory-cutover-admission-fence.repository";
import {
  INVENTORY_CUTOVER_CONFIGURATION_TABLES,
  INVENTORY_CUTOVER_OPERATIONAL_TABLES,
  inventoryCutoverFenceRequestSchema,
} from "../../domain/inventory-cutover-admission-fence";
import type { InventoryAvailabilityTransactionQueryClient } from "../../application/inventory-availability-transaction-query.port";

const request = { expectedAuthority: "legacy" as const, expectedConfigurationRunId: null };
const receiptRow = { epoch: "2", authority: "legacy", authority_revision: "1", configuration_run_id: null };
function client(rows: Record<string, unknown>[] = [receiptRow]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, transaction: { query } as InventoryAvailabilityTransactionQueryClient };
}

describe("inventory cutover admission owner contract", () => {
  it.each([
    { expectedAuthority: "unknown", expectedConfigurationRunId: null },
    { expectedAuthority: "legacy" },
    { ...request, expectedConfigurationRunId: "0" },
    { ...request, expectedConfigurationRunId: "01" },
    { ...request, expectedConfigurationRunId: "not-an-integer" },
    { ...request, expectedConfigurationRunId: "1.5" },
    { ...request, expectedConfigurationRunId: "" },
    { ...request, expectedConfigurationRunId: "9223372036854775808" },
    { ...request, expectedConfigurationRunId: 1 },
    { ...request, extra: true },
  ])("rejects malformed expectations before SQL: %j", async (bad) => {
    const fixture = client();
    await expect(acquireInventoryCutoverFenceInsideTransaction(fixture.transaction, bad as typeof request))
      .rejects.toMatchObject({ code: "INVENTORY_CUTOVER_FENCE_INPUT_INVALID" });
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it("accepts the entire PostgreSQL bigint identity range without number coercion", () => {
    expect(inventoryCutoverFenceRequestSchema.parse({ ...request, expectedConfigurationRunId: "9223372036854775807" }))
      .toEqual({ ...request, expectedConfigurationRunId: "9223372036854775807" });
  });

  it("calls only the caller transaction's DB owner function and validates its receipt", async () => {
    const fixture = client();
    const receipt = await acquireInventoryCutoverFenceInsideTransaction(fixture.transaction, request);
    expect(receipt).toEqual({ epoch: "2", authority: "legacy", authorityRevision: "1", configurationRunId: null });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(fixture.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("inventory.acquire_cutover_admission_fence"), ["legacy", null]);
  });

  it.each([
    [], [receiptRow, receiptRow], [{ ...receiptRow, epoch: "0" }], [{ ...receiptRow, authority_revision: "-1" }],
    [{ ...receiptRow, authority: "canonical" }], [{ ...receiptRow, configuration_run_id: "4" }],
    [{ ...receiptRow, epoch: 2 }], [{ ...receiptRow, epoch: "9223372036854775808" }],
  ].map((rows) => [rows]))("rejects missing, ambiguous, malformed or unexpected receipt rows", async (rows) => {
    const fixture = client(rows);
    await expect(acquireInventoryCutoverFenceInsideTransaction(fixture.transaction, request))
      .rejects.toMatchObject({ code: "INVENTORY_CUTOVER_FENCE_RECEIPT_INVALID" });
  });

  it.each(["55P03", "40001", "25001", "23514"])("preserves database failure %s for caller rollback and retry classification", async (code) => {
    const fixture = client();
    const failure = Object.assign(new Error("database rejected fence"), { code });
    fixture.query.mockRejectedValueOnce(failure);
    await expect(acquireInventoryCutoverFenceInsideTransaction(fixture.transaction, request)).rejects.toBe(failure);
    expect(fixture.query).toHaveBeenCalledOnce();
  });

  it("asserts ownership through the DB instead of trusting a context flag or GUC", async () => {
    const fixture = client([{ epoch: "2" }]);
    await expect(assertInventoryCutoverFenceHeldInsideTransaction(fixture.transaction)).resolves.toBe("2");
    expect(fixture.query).toHaveBeenCalledExactlyOnceWith("SELECT inventory.assert_cutover_admission_fence_owner()::text AS epoch");
  });

  it.each([[], [{ epoch: "0" }], [{ epoch: 2 }], [{ epoch: "2" }, { epoch: "2" }]].map((rows) => [rows]))("rejects malformed exclusive ownership evidence", async (rows) => {
    await expect(assertInventoryCutoverFenceHeldInsideTransaction(client(rows).transaction))
      .rejects.toMatchObject({ code: "INVENTORY_CUTOVER_FENCE_RECEIPT_INVALID" });
  });

  it("keeps the declared admission table sets distinct and safely schema-qualified", () => {
    const tables = [...INVENTORY_CUTOVER_CONFIGURATION_TABLES, ...INVENTORY_CUTOVER_OPERATIONAL_TABLES];
    expect(new Set(tables).size).toBe(tables.length);
    for (const table of tables) expect(table).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });
});
