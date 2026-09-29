import { describe, expect, it, vi } from "vitest";
import type { WarehouseSourceActivationEvidence } from "@shared/types/warehouse-source-activation";
import { validateWarehouseSourceActivation } from "../../domain/warehouse-source-activation";
import { activateReviewedWarehouseSourcesInsideTransaction, readWarehouseSourceActivationEvidence } from "../../infrastructure/warehouse-source-activation.repository";
import type { InventoryAvailabilityTransactionQueryClient } from "../../../inventory-planning/application/inventory-availability-transaction-query.port";

const source: WarehouseSourceActivationEvidence = Object.freeze({
  nodeId: 1, warehouseId: 7, nodeType: "internal_warehouse", inventoryAuthority: "echelon",
  fulfillmentAuthority: "echelon", providerAccountId: null, providerLocationId: null,
  lifecycleStatus: "draft", warehouseActive: 1,
});
const audit = { actor: "operator", occurredAt: new Date("2026-09-29T12:00:00Z") };

function store(rows: WarehouseSourceActivationEvidence[], updatedCount = rows.filter(row => row.lifecycleStatus === "draft").length) {
  const query = vi.fn(async (statement: string, _values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (statement.startsWith("SELECT inventory.assert_cutover")) return { rows: [], rowCount: 1 };
    if (statement.startsWith("SELECT node.id")) return { rows, rowCount: rows.length };
    if (statement.startsWith("UPDATE warehouse.fulfillment_nodes")) return { rows: [], rowCount: updatedCount };
    throw new Error(`Unexpected query: ${statement}`);
  });
  return { query, client: { query } as InventoryAvailabilityTransactionQueryClient };
}

describe("reviewed warehouse source activation", () => {
  it("accepts a draft internal source without changing its stock/provider authority", () => {
    expect(validateWarehouseSourceActivation(source)).toEqual(source);
    expect(validateWarehouseSourceActivation(source)).not.toBe(source);
  });

  it("preserves an already commissioned external source", () => {
    const external = { ...source, inventoryAuthority: "external_provider", fulfillmentAuthority: "external_provider",
      lifecycleStatus: "active", providerAccountId: 3, providerLocationId: 4 };
    expect(validateWarehouseSourceActivation(external)).toEqual(external);
  });

  it.each([
    { inventoryAuthority: "external_provider" }, { fulfillmentAuthority: "external_provider" },
  ])("does not implicitly commission draft external custody: %j", authority => {
    expect(() => validateWarehouseSourceActivation({ ...source, ...authority }))
      .toThrow(expect.objectContaining({ code: "WAREHOUSE_SOURCE_PROVIDER_COMMISSIONING_REQUIRED" }));
  });

  it.each([{ lifecycleStatus: "retired" }, { warehouseActive: 0 }])("rejects an unavailable source: %j", change => {
    expect(() => validateWarehouseSourceActivation({ ...source, ...change }))
      .toThrow(expect.objectContaining({ code: "WAREHOUSE_SOURCE_ACTIVATION_UNAVAILABLE" }));
  });

  it.each([
    { nodeId: 0 }, { nodeId: 2_147_483_648 }, { warehouseId: 1.5 }, { providerAccountId: 9 },
    { inventoryAuthority: "guess" }, { warehouseActive: true }, { lifecycleStatus: "unknown" }, { extra: "unreviewed" },
  ])("rejects invalid or incomplete identity: %j", change => {
    expect(() => validateWarehouseSourceActivation({ ...source, ...change }))
      .toThrow(expect.objectContaining({ code: "WAREHOUSE_SOURCE_ACTIVATION_INVALID" }));
  });

  it("only activates exact reviewed drafts after checking the fence and locking their identities", async () => {
    const active: WarehouseSourceActivationEvidence = { ...source, nodeId: 2, lifecycleStatus: "active" };
    const { client, query } = store([source, active]);
    await expect(activateReviewedWarehouseSourcesInsideTransaction(client, [source, active], audit)).resolves.toEqual([1]);
    expect(query.mock.calls[0]).toEqual(["SELECT inventory.assert_cutover_admission_fence_owner()"]);
    expect(query.mock.calls[1][0]).toContain("ORDER BY node.id FOR UPDATE OF node FOR SHARE OF warehouse");
    expect(query.mock.calls[1][1]).toEqual([[1, 2]]);
    expect(query.mock.calls[2][1]).toEqual([[1], "operator", "2026-09-29T12:00:00.000Z"]);
    expect(query.mock.calls[2][0]).not.toMatch(/inventory_authority\s*=|fulfillment_authority\s*=|warehouse_id\s*=/);
    expect(query).toHaveBeenCalledTimes(3);
    expect(source.lifecycleStatus).toBe("draft");
  });

  it("does not rewrite an already active source or an empty selection", async () => {
    const active: WarehouseSourceActivationEvidence = { ...source, lifecycleStatus: "active" };
    const { client, query } = store([active]);
    await expect(activateReviewedWarehouseSourcesInsideTransaction(client, [active], audit)).resolves.toEqual([]);
    expect(query.mock.calls.some(([statement]) => statement.startsWith("UPDATE"))).toBe(false);
    query.mockClear();
    await expect(activateReviewedWarehouseSourcesInsideTransaction(client, [], audit)).resolves.toEqual([]);
    expect(query.mock.calls).toEqual([["SELECT inventory.assert_cutover_admission_fence_owner()"]]);
  });

  it.each([
    { warehouseId: 8 }, { inventoryAuthority: "manual" }, { lifecycleStatus: "active" }, { warehouseActive: 0 },
  ] as const)("rejects identity/lifecycle changes since review without writing: %j", change => {
    const { client, query } = store([{ ...source, ...change }]);
    return expect(activateReviewedWarehouseSourcesInsideTransaction(client, [source], audit))
      .rejects.toMatchObject({ code: "WAREHOUSE_SOURCE_ACTIVATION_CHANGED" })
      .then(() => expect(query.mock.calls.some(([statement]) => statement.startsWith("UPDATE"))).toBe(false));
  });

  it("rejects a missing source or partial update", async () => {
    await expect(activateReviewedWarehouseSourcesInsideTransaction(store([]).client, [source], audit))
      .rejects.toMatchObject({ code: "WAREHOUSE_SOURCE_ACTIVATION_MISSING" });
    await expect(activateReviewedWarehouseSourcesInsideTransaction(store([source], 0).client, [source], audit))
      .rejects.toMatchObject({ code: "WAREHOUSE_SOURCE_ACTIVATION_CHANGED" });
  });

  it("propagates admission failure before taking row locks or writing", async () => {
    const { client, query } = store([source]);
    const failure = new Error("Cutover fence is not owned");
    query.mockRejectedValueOnce(failure);
    await expect(activateReviewedWarehouseSourcesInsideTransaction(client, [source], audit)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([[], [0], [2, 1], [1, 1]].map(ids => ({ ids })))("validates bounded sorted unique source IDs: %j", async ({ ids }) => {
    const { client, query } = store([]);
    if (ids.length === 0) await expect(readWarehouseSourceActivationEvidence(client, ids)).resolves.toEqual([]);
    else await expect(readWarehouseSourceActivationEvidence(client, ids)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps evidence capture read-only", async () => {
    const { client, query } = store([source]);
    await expect(readWarehouseSourceActivationEvidence(client, [1])).resolves.toEqual([source]);
    expect(query.mock.calls[0][0]).not.toContain("FOR UPDATE");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([{ actor: "" }, { occurredAt: new Date("invalid") }])("rejects invalid audit identity/time before any query: %j", async change => {
    const { client, query } = store([source]);
    await expect(activateReviewedWarehouseSourcesInsideTransaction(client, [source], { ...audit, ...change })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
