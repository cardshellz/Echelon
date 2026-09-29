import { describe, expect, it, vi } from "vitest";
import type { InventoryCutoverManifest } from "@shared/types/inventory-cutover-commit";
import type { WarehouseSourceActivationEvidence } from "@shared/types/warehouse-source-activation";
import type { InventoryAvailabilityTransactionQueryClient } from "../../application/inventory-availability-transaction-query.port";
import { captureCutoverSourceNodes } from "../../infrastructure/inventory-cutover-source-nodes.repository";

const manifest: InventoryCutoverManifest = {
  contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [20], publicationTargetIds: [1, 2], selections: [
    { kind: "source_binding", key: "1", definitionId: 10, definitionHash: "a".repeat(64) },
    { kind: "channel_policy", key: "channel:1", definitionId: 20, definitionHash: "b".repeat(64) },
    { kind: "variant_mapping", key: "1:101", definitionId: 30, definitionHash: "c".repeat(64) },
  ],
};
const source: WarehouseSourceActivationEvidence = {
  nodeId: 1, warehouseId: 7, nodeType: "internal_warehouse", inventoryAuthority: "echelon", fulfillmentAuthority: "echelon",
  providerAccountId: null, providerLocationId: null, lifecycleStatus: "draft", warehouseActive: 1,
};

function store(ids: number[], rows: WarehouseSourceActivationEvidence[]) {
  const query = vi.fn(async (statement: string, _values?: unknown[]): Promise<{ rows: unknown[] }> => {
    if (statement.startsWith("SELECT DISTINCT node_id")) return { rows: ids.map(node_id => ({ node_id })) };
    if (statement.startsWith("SELECT node.id")) return { rows };
    throw new Error(`Unexpected query: ${statement}`);
  });
  return { query, client: { query } as InventoryAvailabilityTransactionQueryClient };
}

describe("cutover source selection evidence", () => {
  it("captures only nodes referenced by reviewed bindings and explicit policy source overrides", async () => {
    const second = { ...source, nodeId: 2, warehouseId: 8 };
    const { query, client } = store([1, 2], [source, second]);
    await expect(captureCutoverSourceNodes(client, manifest)).resolves.toEqual({ ...manifest, sourceNodes: [source, second] });
    expect(query.mock.calls[0][1]).toEqual([[10], [20]]);
    expect(query.mock.calls[0][0]).toContain("inherit_all=false");
    expect(query.mock.calls[0][0]).toContain("ORDER BY node_id");
    expect(query.mock.calls[1][1]).toEqual([[1, 2]]);
    expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT") && !sql.includes("FOR UPDATE"))).toBe(true);
    expect(manifest.sourceNodes).toBeUndefined();
  });

  it("does not activate global or observe-only sources when there are no reviewed binding/policy selections", async () => {
    const { query, client } = store([], []);
    await expect(captureCutoverSourceNodes(client, { ...manifest, selections: [] }))
      .resolves.toEqual({ ...manifest, selections: [], sourceNodes: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it("does not select every warehouse when an explicit source list is empty", async () => {
    const { query, client } = store([], []);
    await expect(captureCutoverSourceNodes(client, manifest)).resolves.toEqual({ ...manifest, sourceNodes: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("requires every selected source identity to exist", async () => {
    await expect(captureCutoverSourceNodes(store([1], []).client, manifest))
      .rejects.toMatchObject({ code: "WAREHOUSE_SOURCE_ACTIVATION_MISSING" });
  });

  it.each([
    { lifecycleStatus: "retired" }, { warehouseActive: 0 }, { inventoryAuthority: "external_provider" },
  ] as const)("cannot approve unavailable or uncommissioned sources: %j", change => {
    return expect(captureCutoverSourceNodes(store([1], [{ ...source, ...change }]).client, manifest)).rejects.toThrow();
  });

  it("propagates database failures rather than silently dropping sources", async () => {
    const { query, client } = store([], []);
    const failure = new Error("Connection failed");
    query.mockRejectedValueOnce(failure);
    await expect(captureCutoverSourceNodes(client, manifest)).rejects.toBe(failure);
  });
});
