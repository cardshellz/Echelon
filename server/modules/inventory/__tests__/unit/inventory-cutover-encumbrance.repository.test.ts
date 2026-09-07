import { describe, expect, it, vi } from "vitest";
import type { InventoryCutoverEncumbranceQueryClient } from "../../infrastructure/inventory-cutover-encumbrance.repository";
import { captureInventoryCutoverEncumbranceInsideTransaction } from "../../infrastructure/inventory-cutover-encumbrance.repository";

const level = {
  inventoryLevelId: 10, warehouseLocationId: 20, productVariantId: 30,
  variantQty: "12", reservedQty: "7", pickedQty: "2", packedQty: "1",
};
const build = {
  reservationId: 1, buildOrderComponentId: 2, buildOrderId: 3, buildOrderStatus: "released",
  warehouseId: 4, componentVariantId: 30, sourceLocationId: 20, inventoryLotId: 5,
  lotVariantId: 30, lotLocationId: 20, lotQtyReserved: "3",
  reservedQty: "4", consumedQty: "1", releasedQty: "0", reservationOwner: "build_order",
  availabilityClaimId: null, availabilityClaimLotAllocationId: null,
  claimLotResourceId: null, claimLotInventoryLotId: null, claimLotOpenQty: null,
};
const resource = {
  claimResourceId: "9007199254740993", claimId: "9007199254740994", claimStatus: "active",
  orderId: 6, claimLineId: "9007199254740995", orderItemId: 7, targetVariantId: 30,
  warehouseId: 4, warehouseLocationId: 20, inventoryLevelId: 10, sourceVariantId: 30,
  claimedQty: "5", releasedQty: "1", consumedQty: "1", pickedQty: "1",
};

function fixture(overrides: {
  transaction?: Record<string, unknown>;
  levels?: Record<string, unknown>[];
  builds?: Record<string, unknown>[];
  resources?: Record<string, unknown>[];
  installed?: Record<string, unknown>;
  totals?: Record<string, unknown>;
} = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("transaction_read_only")) return { rows: [overrides.transaction ?? {
      read_only: "on", isolation_level: "repeatable read",
    }] };
    if (sql.includes("count(*)::text")) return { rows: [overrides.totals ?? {
      inventoryLevelCount: "1", variantQty: "12", reservedQty: "7", pickedQty: "2", packedQty: "1",
    }] };
    if (sql.includes("FROM inventory.inventory_levels")) return { rows: overrides.levels ?? [{ ...level }] };
    if (sql.includes("FROM inventory.build_component_reservations")) return { rows: overrides.builds ?? [{ ...build }] };
    if (sql.includes("to_regclass")) return { rows: [overrides.installed ?? {
      claims: "inventory.availability_claims", lines: "inventory.availability_claim_lines",
      resources: "inventory.availability_claim_resources",
      lot_allocations: "inventory.availability_claim_lot_allocations",
    }] };
    if (sql.includes("FROM inventory.availability_claim_resources")) return { rows: overrides.resources ?? [{ ...resource }] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as InventoryCutoverEncumbranceQueryClient, query };
}

describe("inventory-owned cutover encumbrance capture", () => {
  it("captures all raw balances and exact current owners without resetting or planning inventory", async () => {
    const { client, query } = fixture();
    const result = await captureInventoryCutoverEncumbranceInsideTransaction(client);
    expect(result.inventoryLevels).toEqual([level]);
    expect(result.buildReservations).toEqual([build]);
    expect(result.canonicalResources).toEqual([resource]);
    expect(result.totals).toEqual({
      inventoryLevelCount: "1", variantQty: "12", reservedQty: "7", pickedQty: "2", packedQty: "1",
      quantitySemantics: "mixed_sku_units_not_atp",
    });
    expect(result.attributionCaveats).toContain("unexplained_reserved_balance_is_not_free_supply");
    expect(result).not.toHaveProperty("ready");
    expect(result).not.toHaveProperty("atp");
    for (const [sql] of query.mock.calls) {
      expect(sql.trimStart()).toMatch(/^SELECT\b/);
      expect(sql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|UPDATE|INSERT|DELETE|pg_advisory)\b/i);
      expect(sql).not.toMatch(/\b(?:wms|oms|catalog|warehouse)\./);
    }
    const bounded = query.mock.calls.filter(([sql]) => sql.includes("LIMIT $1"));
    expect(bounded).toHaveLength(3);
    for (const call of bounded) expect((call as unknown[])[1]).toEqual([25_001]);
  });

  it("retains arbitrary precision quantities, negative evidence and inactive claim custody", async () => {
    const { client } = fixture({
      levels: [{ ...level, variantQty: "-2", reservedQty: "-1" }],
      resources: [{ ...resource, claimStatus: "superseded", claimedQty: "9223372036854775807", pickedQty: "3" }],
      totals: { inventoryLevelCount: "1", variantQty: "-2", reservedQty: "-1", pickedQty: "2", packedQty: "1" },
    });
    const result = await captureInventoryCutoverEncumbranceInsideTransaction(client);
    expect(result.inventoryLevels[0]?.variantQty).toBe("-2");
    expect(result.canonicalResources[0]?.claimedQty).toBe("9223372036854775807");
    expect(result.canonicalResources[0]?.claimStatus).toBe("superseded");
  });

  it("retains build/claim overlap identity rather than counting both as separate holds", async () => {
    const { client } = fixture({ builds: [{
      ...build, reservationOwner: "availability_claim", availabilityClaimId: resource.claimId,
      availabilityClaimLotAllocationId: "9007199254740996",
      claimLotResourceId: resource.claimResourceId, claimLotInventoryLotId: 5, claimLotOpenQty: "2",
    }] });
    const result = await captureInventoryCutoverEncumbranceInsideTransaction(client);
    expect(result.buildReservations[0]).toMatchObject({
      reservationOwner: "availability_claim", availabilityClaimId: resource.claimId,
    });
    expect(result.attributionCaveats).toContain("build_claim_hold_overlap_requires_deduplication");
    expect(result).not.toHaveProperty("totalOwnedReservations");
  });

  it("retains missing parent/lot references and terminal build holds for review", async () => {
    const { client, query } = fixture({ builds: [{
      ...build, buildOrderId: null, buildOrderStatus: null, warehouseId: null,
      componentVariantId: null, sourceLocationId: null,
      lotVariantId: null, lotLocationId: null, lotQtyReserved: null,
    }] });
    const result = await captureInventoryCutoverEncumbranceInsideTransaction(client);
    expect(result.buildReservations[0]?.buildOrderId).toBeNull();
    const sql = query.mock.calls.find(([text]) => text.includes("FROM inventory.build_component_reservations"))![0];
    expect(sql).toContain("LEFT JOIN inventory.build_orders");
    expect(sql).not.toMatch(/build.status\s*(?:=|IN)/);
    expect(sql).toContain("- reservation.released_qty::numeric <> 0");
  });

  it("reads canonical residues even on inactive claims instead of only active rows", async () => {
    const { client, query } = fixture();
    await captureInventoryCutoverEncumbranceInsideTransaction(client);
    const sql = query.mock.calls.find(([text]) => text.includes("FROM inventory.availability_claim_resources"))![0];
    expect(sql).toContain("WHERE claim.status = 'active'");
    expect(sql).toContain("- resource.consumed_qty::numeric - resource.picked_qty::numeric <> 0");
    expect(sql).toContain("OR resource.picked_qty <> 0");
    expect(sql).toContain("line.claim_id = resource.claim_id");
  });

  it.each([
    { read_only: "off", isolation_level: "repeatable read" },
    { read_only: "on", isolation_level: "read committed" },
    { read_only: "on", isolation_level: "read uncommitted" },
  ])("rejects an unsafe transaction before reading positions: %o", async (transaction) => {
    const { client, query } = fixture({ transaction });
    await expect(captureInventoryCutoverEncumbranceInsideTransaction(client)).rejects.toMatchObject({
      code: "INVENTORY_CUTOVER_READ_ONLY_SNAPSHOT_REQUIRED",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("allows caller-owned serializable read-only capture", async () => {
    const { client } = fixture({ transaction: { read_only: "on", isolation_level: "serializable" } });
    await expect(captureInventoryCutoverEncumbranceInsideTransaction(client)).resolves.toHaveProperty("schemaVersion");
  });

  it.each([0, -1, 1.5, 50_001, Number.NaN])("validates row bound %s before SQL", async (maxRows) => {
    const { client, query } = fixture();
    await expect(captureInventoryCutoverEncumbranceInsideTransaction(client, { maxRows })).rejects.toMatchObject({
      code: "INVENTORY_CUTOVER_INVALID_CAPTURE_LIMIT",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { field: "inventoryLevels", overrides: { levels: [{ ...level }, { ...level, inventoryLevelId: 11 }] } },
    { field: "buildReservations", overrides: { builds: [{ ...build }, { ...build, reservationId: 2 }] } },
    { field: "canonicalResources", overrides: { resources: [{ ...resource }, { ...resource, claimResourceId: "2" }] } },
  ])("rejects $field overflow rather than returning incomplete evidence", async ({ field, overrides }) => {
    const { client } = fixture(overrides);
    await expect(captureInventoryCutoverEncumbranceInsideTransaction(client, { maxRows: 1 })).rejects.toMatchObject({
      code: "INVENTORY_CUTOVER_CAPTURE_LIMIT_EXCEEDED", context: { collection: field, maxRows: 1 },
    });
  });

  it("reports canonical schema absence explicitly and does not query absent tables", async () => {
    const { client, query } = fixture({ installed: { claims: null, lines: null, resources: null, lot_allocations: null } });
    const result = await captureInventoryCutoverEncumbranceInsideTransaction(client);
    expect(result.canonicalTablesStatus).toBe("not_installed");
    expect(result.canonicalResources).toEqual([]);
    expect(query.mock.calls.some(([sql]) => sql.includes("FROM inventory.availability_claim_resources"))).toBe(false);
  });

  it("rejects partial canonical migrations", async () => {
    const { client } = fixture({ installed: { claims: "inventory.availability_claims", lines: null, resources: null, lot_allocations: null } });
    await expect(captureInventoryCutoverEncumbranceInsideTransaction(client)).rejects.toMatchObject({
      code: "INVENTORY_CUTOVER_CANONICAL_SCHEMA_INCOMPLETE",
    });
  });

  it("rejects missing installation fields instead of treating them as installed", async () => {
    const { client } = fixture({ installed: {} });
    await expect(captureInventoryCutoverEncumbranceInsideTransaction(client)).rejects.toMatchObject({
      code: "INVENTORY_CUTOVER_INVALID_DATABASE_EVIDENCE",
    });
  });

  it.each(["1.5", "NaN", "01", "-0", null, 4])("rejects malformed raw quantity %s", async (variantQty) => {
    const { client } = fixture({ levels: [{ ...level, variantQty }] });
    await expect(captureInventoryCutoverEncumbranceInsideTransaction(client)).rejects.toMatchObject({
      code: "INVENTORY_CUTOVER_INVALID_DATABASE_EVIDENCE",
    });
  });

  it("propagates database errors without pretending missing evidence is empty", async () => {
    const { client, query } = fixture();
    query.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(captureInventoryCutoverEncumbranceInsideTransaction(client)).rejects.toThrow("database unavailable");
  });
});
