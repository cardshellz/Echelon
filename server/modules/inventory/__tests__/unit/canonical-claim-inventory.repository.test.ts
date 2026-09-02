import { describe, expect, it, vi } from "vitest";

import {
  CanonicalClaimInventoryMutationError,
  PostgresCanonicalClaimInventoryRepository,
} from "../../infrastructure/canonical-claim-inventory.repository";

const OCCURRED_AT = new Date("2026-09-02T02:00:00.000Z");

function createClient(handler: (text: string, values: unknown[]) => Promise<any>) {
  const query = vi.fn(async (text: string, values: unknown[] = []) => handler(text, values));
  return { client: { query } as any, query };
}

describe("PostgresCanonicalClaimInventoryRepository", () => {
  it("reserves exact FIFO lots, the aggregate level, and an auditable ledger row", async () => {
    const fake = createClient(async (text) => {
      if (text.includes("FROM inventory.inventory_levels") && text.includes("WHERE id = $1")) {
        return {
          rows: [{
            id: 11,
            warehouse_location_id: 2,
            product_variant_id: 101,
            variant_qty: 10,
            reserved_qty: 2,
          }],
        };
      }
      if (text.includes("FROM inventory.inventory_lots")) {
        return {
          rows: [
            { id: 51, qty_on_hand: 3, qty_reserved: 1, unit_cost_mills: "125" },
            { id: 52, qty_on_hand: 5, qty_reserved: 0, unit_cost_mills: "200" },
          ],
        };
      }
      if (text.startsWith("UPDATE inventory.inventory_lots")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.inventory_levels")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.inventory_transactions")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.reserveResource({
      client: fake.client,
      claimId: BigInt(9),
      claimResourceId: BigInt(12),
      inventoryLevelId: 11,
      warehouseLocationId: 2,
      sourceVariantId: 101,
      claimedQty: 4,
      orderId: 70,
      orderItemId: 71,
      consumerOperationKey: "operation:1",
      actor: "unit-test",
      occurredAt: OCCURRED_AT,
    })).resolves.toEqual([
      {
        inventoryLotId: 51,
        qty: 2,
        unitCostMills: BigInt(125),
        poUnitCostMills: BigInt(125),
        packagingUnitCostMills: BigInt(0),
        landedUnitCostMills: BigInt(0),
      },
      {
        inventoryLotId: 52,
        qty: 2,
        unitCostMills: BigInt(200),
        poUnitCostMills: BigInt(200),
        packagingUnitCostMills: BigInt(0),
        landedUnitCostMills: BigInt(0),
      },
    ]);

    const calls = fake.query.mock.calls.map(([text, values]) => ({ text: String(text), values }));
    const lotUpdates = calls.filter((call) => call.text.startsWith("UPDATE inventory.inventory_lots"));
    expect(lotUpdates.map((call) => call.values)).toEqual([[2, 51], [2, 52]]);
    expect(calls.find((call) => call.text.startsWith("UPDATE inventory.inventory_levels"))?.values)
      .toEqual([4, 11, OCCURRED_AT]);
    expect(calls.find((call) => call.text.startsWith("INSERT INTO inventory.inventory_transactions"))?.values)
      .toEqual([101, 2, 10, 4, 70, 71, "claim:9:resource:12", "unit-test", "Canonical source allocation for operation operation:1", OCCURRED_AT]);
  });

  it("detects a FIFO lot shortfall before issuing any mutation", async () => {
    const fake = createClient(async (text) => {
      if (text.includes("FROM inventory.inventory_levels")) {
        return { rows: [{ id: 11, warehouse_location_id: 2, product_variant_id: 101, variant_qty: 10, reserved_qty: 0 }] };
      }
      if (text.includes("FROM inventory.inventory_lots")) {
        return { rows: [{ id: 51, qty_on_hand: 2, qty_reserved: 1, unit_cost_mills: "125" }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.reserveResource({
      client: fake.client,
      claimId: BigInt(9),
      claimResourceId: BigInt(12),
      inventoryLevelId: 11,
      warehouseLocationId: 2,
      sourceVariantId: 101,
      claimedQty: 4,
      orderId: 70,
      orderItemId: 71,
      consumerOperationKey: null,
      actor: "unit-test",
      occurredAt: OCCURRED_AT,
    })).rejects.toEqual(expect.objectContaining<Partial<CanonicalClaimInventoryMutationError>>({
      code: "CLAIM_LOT_SHORTFALL",
    }));
    expect(fake.query.mock.calls.some(([text]) => /^\s*(UPDATE|INSERT)/i.test(String(text)))).toBe(false);
  });

  it("consumes only claim-owned lots and reserves only committed transformation output", async () => {
    let outputLotId = 60;
    const fake = createClient(async (text) => {
      if (text.startsWith("INSERT INTO inventory.inventory_levels")) return { rows: [], rowCount: 1 };
      if (text.includes("FROM inventory.inventory_levels") && text.includes("OR (product_variant_id")) {
        return {
          rows: [
            { id: 11, warehouse_location_id: 2, product_variant_id: 101, variant_qty: 10, reserved_qty: 5 },
            { id: 12, warehouse_location_id: 3, product_variant_id: 105, variant_qty: 2, reserved_qty: 0 },
          ],
        };
      }
      if (text.includes("FROM inventory.inventory_lots") && text.includes("ANY($1::integer[])")) {
        return {
          rows: [{
            id: 51,
            product_variant_id: 101,
            warehouse_location_id: 2,
            qty_on_hand: 5,
            qty_reserved: 5,
            qty_picked: 0,
            status: "active",
            received_at: OCCURRED_AT,
            unit_cost_mills: "125",
            po_unit_cost_mills: "100",
            packaging_cost_mills: "20",
            landed_cost_mills: "5",
            total_unit_cost_mills: "125",
          }],
        };
      }
      if (text.startsWith("UPDATE inventory.inventory_lots")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.inventory_levels")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.inventory_lots")) {
        outputLotId += 1;
        return { rows: [{ id: outputLotId }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO inventory.inventory_transactions")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.executePackageOperation({
      client: fake.client,
      claimId: BigInt(9),
      claimOperationId: BigInt(10),
      operationKey: "line:1:operation:1",
      operationType: "assemble_pack",
      resources: [{
        claimResourceId: BigInt(12),
        inventoryLevelId: 11,
        warehouseLocationId: 2,
        sourceVariantId: 101,
        consumeQty: BigInt(5),
        lotAllocations: [{
          claimLotAllocationId: BigInt(21),
          inventoryLotId: 51,
          consumeQty: BigInt(5),
          unitCostMills: BigInt(125),
          poUnitCostMills: BigInt(100),
          packagingUnitCostMills: BigInt(20),
          landedUnitCostMills: BigInt(5),
        }],
      }],
      destinationVariantId: 105,
      outputLocationId: 3,
      outputQty: BigInt(4),
      committedOutputQty: BigInt(3),
      orderId: 70,
      orderItemId: 71,
      actor: "unit-test",
      reason: "claim execution",
      occurredAt: OCCURRED_AT,
    })).resolves.toEqual({
      outputInventoryLevelId: 12,
      committedLotAllocations: [
        {
          inventoryLotId: 61,
          qty: 1,
          unitCostMills: BigInt(157),
          poUnitCostMills: BigInt(125),
          packagingUnitCostMills: BigInt(25),
          landedUnitCostMills: BigInt(7),
        },
        {
          inventoryLotId: 62,
          qty: 2,
          unitCostMills: BigInt(156),
          poUnitCostMills: BigInt(125),
          packagingUnitCostMills: BigInt(25),
          landedUnitCostMills: BigInt(6),
        },
      ],
      totalInputCostMills: BigInt(625),
    });

    const calls = fake.query.mock.calls.map(([text, values]) => ({ text: String(text), values }));
    const levelLockIndex = calls.findIndex((call) => call.text.includes("FROM inventory.inventory_levels"));
    const lotLockIndex = calls.findIndex((call) => call.text.includes("FROM inventory.inventory_lots"));
    const firstConsumeIndex = calls.findIndex((call) => call.text.startsWith("UPDATE inventory.inventory_lots"));
    expect(levelLockIndex).toBeGreaterThanOrEqual(0);
    expect(lotLockIndex).toBeGreaterThan(levelLockIndex);
    expect(firstConsumeIndex).toBeGreaterThan(lotLockIndex);
    expect(calls.filter((call) => call.text.startsWith("INSERT INTO inventory.inventory_lots"))).toHaveLength(3);
    expect(calls.find((call) => call.text.includes("SET variant_qty = variant_qty + $1"))?.values)
      .toEqual([4, 3, 12, OCCURRED_AT]);
  });

  it("locks every level before every lot and releases exact claim-owned quantities", async () => {
    const fake = createClient(async (text, values) => {
      if (text.includes("FROM inventory.inventory_levels") && text.includes("ANY($1::integer[])")) {
        expect(values).toEqual([[11, 12]]);
        return {
          rows: [
            { id: 11, warehouse_location_id: 2, product_variant_id: 101, variant_qty: 10, reserved_qty: 7 },
            { id: 12, warehouse_location_id: 3, product_variant_id: 102, variant_qty: 8, reserved_qty: 2 },
          ],
        };
      }
      if (text.includes("FROM inventory.inventory_lots") && text.includes("ANY($1::integer[])")) {
        expect(values).toEqual([[51, 52]]);
        return {
          rows: [
            { id: 51, warehouse_location_id: 2, product_variant_id: 101, qty_reserved: 7 },
            { id: 52, warehouse_location_id: 3, product_variant_id: 102, qty_reserved: 2 },
          ],
        };
      }
      if (text.startsWith("UPDATE inventory.inventory_lots")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.inventory_levels")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.inventory_transactions")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await repository.releaseResources({
      client: fake.client,
      claimId: BigInt(9),
      resources: [
        {
          claimResourceId: BigInt(13),
          inventoryLevelId: 12,
          warehouseLocationId: 3,
          sourceVariantId: 102,
          releaseQty: BigInt(2),
          lotAllocations: [{ inventoryLotId: 52, releaseQty: BigInt(2) }],
          orderItemId: 72,
        },
        {
          claimResourceId: BigInt(12),
          inventoryLevelId: 11,
          warehouseLocationId: 2,
          sourceVariantId: 101,
          releaseQty: BigInt(3),
          lotAllocations: [{ inventoryLotId: 51, releaseQty: BigInt(3) }],
          orderItemId: 71,
        },
      ],
      orderId: 70,
      actor: "unit-test",
      reason: "cancelled",
      occurredAt: OCCURRED_AT,
    });

    const sql = fake.query.mock.calls.map(([text]) => String(text));
    const levelLock = sql.findIndex((text) => text.includes("FROM inventory.inventory_levels") && text.includes("ANY($1::integer[])"));
    const lotLock = sql.findIndex((text) => text.includes("FROM inventory.inventory_lots") && text.includes("ANY($1::integer[])"));
    const firstWrite = sql.findIndex((text) => text.startsWith("UPDATE inventory.inventory_lots"));
    expect(levelLock).toBeGreaterThanOrEqual(0);
    expect(lotLock).toBeGreaterThan(levelLock);
    expect(firstWrite).toBeGreaterThan(lotLock);
    expect(sql.filter((text) => text.startsWith("INSERT INTO inventory.inventory_transactions"))).toHaveLength(2);
  });

  it("rejects a release lineage mismatch before issuing any mutation", async () => {
    const fake = createClient(async (text) => {
      if (text.includes("FROM inventory.inventory_levels")) {
        return { rows: [{ id: 11, warehouse_location_id: 2, product_variant_id: 101, variant_qty: 10, reserved_qty: 4 }] };
      }
      if (text.includes("FROM inventory.inventory_lots")) {
        return { rows: [{ id: 51, warehouse_location_id: 2, product_variant_id: 101, qty_reserved: 4 }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.releaseResources({
      client: fake.client,
      claimId: BigInt(9),
      resources: [{
        claimResourceId: BigInt(12),
        inventoryLevelId: 11,
        warehouseLocationId: 2,
        sourceVariantId: 101,
        releaseQty: BigInt(4),
        lotAllocations: [{ inventoryLotId: 51, releaseQty: BigInt(3) }],
        orderItemId: 71,
      }],
      orderId: 70,
      actor: "unit-test",
      reason: "cancelled",
      occurredAt: OCCURRED_AT,
    })).rejects.toEqual(expect.objectContaining<Partial<CanonicalClaimInventoryMutationError>>({
      code: "CLAIM_RELEASE_LINEAGE_MISMATCH",
    }));
    expect(fake.query.mock.calls.some(([text]) => /^\s*(UPDATE|INSERT)/i.test(String(text)))).toBe(false);
  });
});
