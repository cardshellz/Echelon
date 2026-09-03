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
  it("creates a zero inventory level only through the physical inventory writer", async () => {
    const fake = createClient(async (text, values) => {
      if (text.startsWith("INSERT INTO inventory.inventory_levels")) {
        expect(text).toContain("VALUES ($1, $2, 0, 0, 0, 0, 0, $3)");
        expect(text).toContain("ON CONFLICT (product_variant_id, warehouse_location_id) DO NOTHING");
        expect(text).toContain("RETURNING id");
        expect(values).toEqual([105, 3, OCCURRED_AT]);
        return { rows: [{ id: 15 }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.ensureInventoryLevel({
      client: fake.client,
      productVariantId: 105,
      warehouseLocationId: 3,
      occurredAt: OCCURRED_AT,
    })).resolves.toBe(15);
    expect(fake.query).toHaveBeenCalledOnce();
  });

  it("reuses an existing target level without updating it", async () => {
    const fake = createClient(async (text, values) => {
      if (text.startsWith("INSERT INTO inventory.inventory_levels")) {
        expect(text).toContain("DO NOTHING");
        expect(values).toEqual([105, 3, OCCURRED_AT]);
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM inventory.inventory_levels")) {
        expect(text).not.toContain("FOR UPDATE");
        expect(values).toEqual([105, 3]);
        return { rows: [{ id: 15 }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.ensureInventoryLevel({
      client: fake.client,
      productVariantId: 105,
      warehouseLocationId: 3,
      occurredAt: OCCURRED_AT,
    })).resolves.toBe(15);
  });

  it("fails closed when a target inventory level cannot be resolved after creation", async () => {
    const fake = createClient(async (text) => {
      if (text.startsWith("INSERT INTO inventory.inventory_levels")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM inventory.inventory_levels")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.ensureInventoryLevel({
      client: fake.client,
      productVariantId: 105,
      warehouseLocationId: 3,
      occurredAt: OCCURRED_AT,
    })).rejects.toEqual(expect.objectContaining<Partial<CanonicalClaimInventoryMutationError>>({
      code: "INVENTORY_LEVEL_CREATION_CONFLICT",
    }));
  });

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

  it("uses recorded stock first, relocates only the observed shortage, and preserves exact lot lineage", async () => {
    let observedLotId = 52;
    const sourceLevel = {
      id: 11,
      warehouse_location_id: 2,
      product_variant_id: 105,
      warehouse_id: 1,
      variant_qty: 3,
      reserved_qty: 3,
    };
    const targetLevel = {
      id: 15,
      warehouse_location_id: 3,
      product_variant_id: 105,
      warehouse_id: 1,
      variant_qty: 1,
      reserved_qty: 0,
    };
    const sourceLot = {
      id: 51,
      product_variant_id: 105,
      warehouse_location_id: 2,
      qty_on_hand: 3,
      qty_reserved: 3,
      qty_picked: 0,
      status: "active",
      received_at: OCCURRED_AT,
      unit_cost_mills: "125",
      po_unit_cost_mills: "100",
      packaging_cost_mills: "20",
      landed_cost_mills: "5",
      total_unit_cost_mills: "125",
      receiving_order_id: 401,
      purchase_order_id: 402,
      inbound_shipment_id: 403,
      build_order_id: null,
      build_run_id: null,
      po_line_id: 404,
      cost_provisional: 0,
      cost_source: "purchase_order",
    };
    const targetLot = {
      id: 52,
      product_variant_id: 105,
      warehouse_location_id: 3,
      qty_on_hand: 1,
      qty_reserved: 0,
      qty_picked: 0,
      status: "active",
      received_at: OCCURRED_AT,
      unit_cost_mills: "125",
      po_unit_cost_mills: "100",
      packaging_cost_mills: "20",
      landed_cost_mills: "5",
      total_unit_cost_mills: "125",
    };
    const fake = createClient(async (text, values) => {
      if (text.includes("FROM inventory.inventory_levels") && text.includes("ANY($1::integer[])")) {
        const ids = values[0] as number[];
        return { rows: ids.includes(15) ? [sourceLevel, targetLevel] : [sourceLevel] };
      }
      if (text.includes("FROM inventory.inventory_levels") && text.includes("WHERE id = $1")) {
        return { rows: [targetLevel] };
      }
      if (text.includes("FROM inventory.inventory_lots") && text.includes("OR (product_variant_id")) {
        return { rows: [sourceLot, targetLot] };
      }
      if (text.includes("FROM inventory.inventory_lots") && text.includes("ANY($1::integer[])")) {
        return { rows: [sourceLot] };
      }
      if (text.includes("FROM inventory.inventory_lots") && text.includes("WHERE product_variant_id = $1")) {
        return { rows: [targetLot] };
      }
      if (text.startsWith("INSERT INTO inventory.inventory_lots")) {
        observedLotId += 1;
        return { rows: [{ id: observedLotId }], rowCount: 1 };
      }
      if (text.startsWith("UPDATE inventory.inventory_lots")
        || text.startsWith("UPDATE inventory.inventory_levels")
        || text.startsWith("INSERT INTO inventory.inventory_transactions")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.reconcileObservedPickResource({
      client: fake.client,
      claimId: BigInt(9),
      releases: [{
        claimResourceId: BigInt(12),
        inventoryLevelId: 11,
        warehouseLocationId: 2,
        sourceVariantId: 105,
        releaseQty: BigInt(3),
        lotAllocations: [{ inventoryLotId: 51, releaseQty: BigInt(3) }],
        orderItemId: 71,
      }],
      sourceCostLayers: [{
        inventoryLotId: 51,
        quantity: BigInt(3),
        unitCostMills: BigInt(125),
        poUnitCostMills: BigInt(100),
        packagingUnitCostMills: BigInt(20),
        landedUnitCostMills: BigInt(5),
      }],
      target: {
        claimResourceId: BigInt(13),
        inventoryLevelId: 15,
        warehouseLocationId: 3,
        sourceVariantId: 105,
        claimedQty: 3,
        orderItemId: 71,
      },
      observationReference: "a".repeat(64),
      orderId: 70,
      actor: "unit-test",
      reason: "picker observed three units",
      occurredAt: OCCURRED_AT,
    })).resolves.toEqual({
      allocations: [
        {
          inventoryLotId: 52,
          qty: 1,
          unitCostMills: BigInt(125),
          poUnitCostMills: BigInt(100),
          packagingUnitCostMills: BigInt(20),
          landedUnitCostMills: BigInt(5),
        },
        {
          inventoryLotId: 53,
          qty: 2,
          unitCostMills: BigInt(125),
          poUnitCostMills: BigInt(100),
          packagingUnitCostMills: BigInt(20),
          landedUnitCostMills: BigInt(5),
        },
      ],
      recordedReconciledQuantity: BigInt(1),
      observedRelocatedQuantity: BigInt(2),
      relocatedInventoryLotIds: [53],
      systemLevelQuantityBefore: BigInt(1),
      systemLotQuantityBefore: BigInt(1),
      recordedUnreservedQuantityBefore: BigInt(1),
    });

    const calls = fake.query.mock.calls.map(([text, values]) => ({ text: String(text), values }));
    const firstLevelLock = calls.findIndex((call) => call.text.includes("FROM inventory.inventory_levels"));
    const firstLotLock = calls.findIndex((call) => call.text.includes("FROM inventory.inventory_lots"));
    const firstWrite = calls.findIndex((call) => /^\s*(UPDATE|INSERT)/i.test(call.text));
    expect(firstLevelLock).toBeGreaterThanOrEqual(0);
    expect(firstLotLock).toBeGreaterThan(firstLevelLock);
    expect(firstWrite).toBeGreaterThan(firstLotLock);
    const observedLot = calls.find((call) => call.text.startsWith("INSERT INTO inventory.inventory_lots"));
    expect(observedLot?.text).toContain("cost_provisional");
    expect(observedLot?.text).toContain("build_order_id, build_run_id");
    expect(observedLot?.values?.[3]).toBe(401);
    expect(observedLot?.values?.[17]).toBe(2);
    expect(observedLot?.values?.[19]).toBe(0);
    expect(observedLot?.values?.[20]).toBe("purchase_order");
    const sourceLevelUpdate = calls.find((call) =>
      call.text.startsWith("UPDATE inventory.inventory_levels")
      && call.text.includes("variant_qty = variant_qty - $1"));
    expect(sourceLevelUpdate?.values).toEqual([2, 11, OCCURRED_AT]);
    const observationLevelUpdate = calls.find((call) =>
      call.text.startsWith("UPDATE inventory.inventory_levels")
      && call.text.includes("variant_qty = variant_qty + $1"));
    expect(observationLevelUpdate?.values).toEqual([2, 15, OCCURRED_AT]);
    const transferRows = calls.filter((call) =>
      call.text.startsWith("INSERT INTO inventory.inventory_transactions")
      && (call.text.includes("'transfer'") || call.text.includes("'reserve_move'")));
    expect(transferRows.map((call) => call.text)).toEqual([
      expect.stringContaining("'transfer'"),
      expect.stringContaining("'reserve_move'"),
    ]);
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

  it("posts canonical build inventory with build-linked lots and ledger evidence", async () => {
    const fake = createClient(async (text) => {
      if (text.startsWith("INSERT INTO inventory.inventory_levels")) return { rows: [], rowCount: 1 };
      if (text.includes("FROM inventory.inventory_levels") && text.includes("OR (product_variant_id")) {
        return { rows: [
          { id: 11, warehouse_location_id: 2, product_variant_id: 101, variant_qty: 5, reserved_qty: 5 },
          { id: 12, warehouse_location_id: 3, product_variant_id: 105, variant_qty: 0, reserved_qty: 0 },
        ] };
      }
      if (text.includes("FROM inventory.inventory_lots") && text.includes("ANY($1::integer[])")) {
        return { rows: [{
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
        }] };
      }
      if (text.startsWith("UPDATE inventory.inventory_lots")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.inventory_levels")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.inventory_lots")) return { rows: [{ id: 61 }], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.inventory_transactions")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.executeBuildOperation({
      client: fake.client,
      claimId: BigInt(9),
      claimOperationId: BigInt(10),
      operationKey: "line:1:build:1",
      operationType: "component_build",
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
      outputQty: BigInt(1),
      committedOutputQty: BigInt(1),
      orderId: 70,
      orderItemId: 71,
      build: {
        buildOrderId: 91,
        buildRunId: 94,
        buildRunNumber: 1,
        buildSystemNumber: "BLD-00000091",
        components: [{ sourceVariantId: 101, buildOrderComponentId: 92 }],
      },
      actor: "unit-test",
      reason: "claim build execution",
      occurredAt: OCCURRED_AT,
    })).resolves.toEqual({
      outputInventoryLevelId: 12,
      committedLotAllocations: [{
        inventoryLotId: 61,
        qty: 1,
        unitCostMills: BigInt(625),
        poUnitCostMills: BigInt(500),
        packagingUnitCostMills: BigInt(100),
        landedUnitCostMills: BigInt(25),
      }],
      totalInputCostMills: BigInt(625),
    });

    const calls = fake.query.mock.calls.map(([text, values]) => ({ text: String(text), values }));
    const inventoryTransactions = calls.filter((call) => call.text.startsWith("INSERT INTO inventory.inventory_transactions"));
    expect(inventoryTransactions).toHaveLength(2);
    expect(inventoryTransactions[0].text).toContain("build_order_component_id");
    expect(inventoryTransactions[0].values?.slice(-3)).toEqual([91, 92, 94]);
    expect(inventoryTransactions[1].text).toContain("build_order_id, build_run_id");
    expect(inventoryTransactions[1].values?.slice(-2)).toEqual([91, 94]);
    const outputLot = calls.find((call) => call.text.startsWith("INSERT INTO inventory.inventory_lots"));
    expect(outputLot?.text).toContain("build_order_id, build_run_id");
    expect(outputLot?.values?.slice(-2)).toEqual([91, 94]);
  });

  it("moves exact reserved claim lots to picked and records immutable COGS evidence", async () => {
    let nextCostId = 80;
    const fake = createClient(async (text) => {
      if (text.includes("FROM inventory.inventory_levels") && text.includes("ANY($1::integer[])")) {
        return {
          rows: [{
            id: 11,
            warehouse_location_id: 2,
            product_variant_id: 101,
            variant_qty: 10,
            reserved_qty: 4,
            picked_qty: 1,
          }],
        };
      }
      if (text.includes("FROM inventory.inventory_lots") && text.includes("ANY($1::integer[])")) {
        return {
          rows: [{
            id: 51,
            warehouse_location_id: 2,
            product_variant_id: 101,
            qty_on_hand: 6,
            qty_reserved: 4,
            qty_picked: 1,
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
      if (text.startsWith("INSERT INTO oms.order_item_costs")) {
        nextCostId += 1;
        return { rows: [{ id: nextCostId }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO inventory.inventory_transactions")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.inventory_levels")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.pickResources({
      client: fake.client,
      claimId: BigInt(9),
      claimLineId: BigInt(10),
      resources: [{
        claimResourceId: BigInt(12),
        inventoryLevelId: 11,
        warehouseLocationId: 2,
        sourceVariantId: 101,
        pickQty: BigInt(3),
        lotAllocations: [{
          claimLotAllocationId: BigInt(21),
          inventoryLotId: 51,
          pickQty: BigInt(3),
          unitCostMills: BigInt(125),
          poUnitCostMills: BigInt(100),
          packagingUnitCostMills: BigInt(20),
          landedUnitCostMills: BigInt(5),
        }],
      }],
      orderId: 70,
      orderItemId: 71,
      actor: "unit-test",
      reason: "picker completed line",
      occurredAt: OCCURRED_AT,
    })).resolves.toEqual({
      movements: [{
        claimResourceId: BigInt(12),
        claimLotAllocationId: BigInt(21),
        inventoryLotId: 51,
        quantity: BigInt(3),
        unitCostMills: BigInt(125),
        totalCostMills: BigInt(375),
        orderItemCostId: 81,
        reversesPickMovementId: null,
      }],
      totalCostMills: BigInt(375),
    });

    const calls = fake.query.mock.calls.map(([text, values]) => ({ text: String(text), values }));
    expect(calls.find((call) => call.text.startsWith("UPDATE inventory.inventory_lots"))?.text)
      .toContain("qty_picked = qty_picked + $1");
    expect(calls.find((call) => call.text.startsWith("UPDATE inventory.inventory_levels"))?.text)
      .toContain("picked_qty = picked_qty + $1");
    expect(calls.find((call) => call.text.startsWith("INSERT INTO oms.order_item_costs"))?.values)
      .toEqual([70, 71, 51, 101, 3, "1", "4", "125", "375", OCCURRED_AT]);
  });

  it("unpick restores an active claim reservation and appends compensating COGS", async () => {
    const fake = createClient(async (text) => {
      if (text.includes("FROM inventory.inventory_levels") && text.includes("ANY($1::integer[])")) {
        return {
          rows: [{
            id: 11,
            warehouse_location_id: 2,
            product_variant_id: 101,
            variant_qty: 7,
            reserved_qty: 1,
            picked_qty: 3,
          }],
        };
      }
      if (text.includes("FROM inventory.inventory_lots") && text.includes("ANY($1::integer[])")) {
        return {
          rows: [{
            id: 51,
            warehouse_location_id: 2,
            product_variant_id: 101,
            qty_on_hand: 3,
            qty_reserved: 1,
            qty_picked: 3,
            status: "active",
            received_at: OCCURRED_AT,
          }],
        };
      }
      if (text.startsWith("UPDATE inventory.inventory_lots")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO oms.order_item_costs")) return { rows: [{ id: 82 }], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.inventory_transactions")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.inventory_levels")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.unpickResources({
      client: fake.client,
      claimId: BigInt(9),
      claimLineId: BigInt(10),
      resources: [{
        claimResourceId: BigInt(12),
        inventoryLevelId: 11,
        warehouseLocationId: 2,
        sourceVariantId: 101,
        unpickQty: BigInt(2),
        lotAllocations: [{
          claimLotAllocationId: BigInt(21),
          inventoryLotId: 51,
          unpickQty: BigInt(2),
          reversesPickMovementId: BigInt(31),
          unitCostMills: BigInt(125),
        }],
      }],
      orderId: 70,
      orderItemId: 71,
      restoreReservation: true,
      actor: "unit-test",
      reason: "picker corrected quantity",
      occurredAt: OCCURRED_AT,
    })).resolves.toEqual({
      movements: [{
        claimResourceId: BigInt(12),
        claimLotAllocationId: BigInt(21),
        inventoryLotId: 51,
        quantity: BigInt(2),
        unitCostMills: BigInt(125),
        totalCostMills: BigInt(250),
        orderItemCostId: 82,
        reversesPickMovementId: BigInt(31),
      }],
      totalCostMills: BigInt(250),
    });

    const calls = fake.query.mock.calls.map(([text, values]) => ({ text: String(text), values }));
    expect(calls.find((call) => call.text.startsWith("UPDATE inventory.inventory_lots"))?.values)
      .toEqual([2, 2, 51]);
    expect(calls.find((call) => call.text.startsWith("UPDATE inventory.inventory_levels"))?.values)
      .toEqual([2, 2, 11, OCCURRED_AT]);
    expect(calls.find((call) => call.text.startsWith("INSERT INTO oms.order_item_costs"))?.values)
      .toEqual([70, 71, 51, 101, -2, "1", "-3", "125", "-250", OCCURRED_AT]);
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

  it("applies a counted shortage only from unreserved FIFO stock and records exact adjustment lineage", async () => {
    let adjustmentLedgerRows = 0;
    const fake = createClient(async (text, values) => {
      if (text.includes("FROM inventory.inventory_levels") && text.includes("WHERE id = $1")) {
        return { rows: [{ id: 11, warehouse_location_id: 2, product_variant_id: 101, variant_qty: 10, reserved_qty: 4 }] };
      }
      if (text.includes("FROM inventory.inventory_lots")) {
        return { rows: [
          { id: 51, qty_on_hand: 6, qty_reserved: 4, qty_picked: 0, total_unit_cost_mills: "125" },
          { id: 52, qty_on_hand: 4, qty_reserved: 0, qty_picked: 0, total_unit_cost_mills: "200" },
        ] };
      }
      if (text.startsWith("UPDATE inventory.inventory_lots")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.inventory_levels")) {
        expect(values).toEqual([6, OCCURRED_AT, 11, 10]);
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO inventory.inventory_transactions")) {
        adjustmentLedgerRows += 1;
        expect(values).toEqual(adjustmentLedgerRows === 1
          ? [101, 2, null, -2, 10, 8, "1", "125", "250", 51, 8, "81", "approved physical count", "user:7", OCCURRED_AT]
          : [101, 2, null, -2, 8, 6, "2", "200", "400", 52, 8, "81", "approved physical count", "user:7", OCCURRED_AT]);
        return { rows: [{ id: 900 + adjustmentLedgerRows }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.applyCycleCountAdjustment({
      client: fake.client,
      inventoryLevelId: 11,
      productVariantId: 101,
      warehouseLocationId: 2,
      quantityBefore: 10,
      countedQty: 6,
      cycleCountId: 8,
      cycleCountItemId: 81,
      actor: "user:7",
      reason: "approved physical count",
      occurredAt: OCCURRED_AT,
    })).resolves.toEqual({
      adjustmentTransactionId: 901,
      consumedQty: BigInt(4),
      consumedCostMills: BigInt(650),
    });
    const lotUpdates = fake.query.mock.calls.filter(([text]) => String(text).startsWith("UPDATE inventory.inventory_lots"));
    expect(lotUpdates.map(([, values]) => values)).toEqual([[2, 51], [2, 52]]);
    expect(adjustmentLedgerRows).toBe(2);
  });

  it("rejects a counted shortage until exact claims reduce reserved ownership", async () => {
    const fake = createClient(async (text) => {
      if (text.includes("FROM inventory.inventory_levels")) {
        return { rows: [{ id: 11, warehouse_location_id: 2, product_variant_id: 101, variant_qty: 10, reserved_qty: 7 }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.applyCycleCountAdjustment({
      client: fake.client,
      inventoryLevelId: 11,
      productVariantId: 101,
      warehouseLocationId: 2,
      quantityBefore: 10,
      countedQty: 6,
      cycleCountId: 8,
      cycleCountItemId: 81,
      actor: "user:7",
      reason: "approved physical count",
      occurredAt: OCCURRED_AT,
    })).rejects.toEqual(expect.objectContaining<Partial<CanonicalClaimInventoryMutationError>>({
      code: "CYCLE_COUNT_RESERVATIONS_NOT_RECONCILED",
    }));
    expect(fake.query.mock.calls.some(([text]) => String(text).includes("inventory.inventory_lots"))).toBe(false);
  });

  it("rejects a count when FIFO lot totals disagree with the locked inventory level", async () => {
    const fake = createClient(async (text) => {
      if (text.includes("FROM inventory.inventory_levels")) {
        return { rows: [{ id: 11, warehouse_location_id: 2, product_variant_id: 101, variant_qty: 10, reserved_qty: 4 }] };
      }
      if (text.includes("FROM inventory.inventory_lots")) {
        return { rows: [{
          id: 51,
          qty_on_hand: 9,
          qty_reserved: 4,
          qty_picked: 0,
          total_unit_cost_mills: "125",
        }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.applyCycleCountAdjustment({
      client: fake.client,
      inventoryLevelId: 11,
      productVariantId: 101,
      warehouseLocationId: 2,
      quantityBefore: 10,
      countedQty: 6,
      cycleCountId: 8,
      cycleCountItemId: 81,
      actor: "user:7",
      reason: "approved physical count",
      occurredAt: OCCURRED_AT,
    })).rejects.toEqual(expect.objectContaining<Partial<CanonicalClaimInventoryMutationError>>({
      code: "CYCLE_COUNT_LOT_AGGREGATE_MISMATCH",
    }));
    expect(fake.query.mock.calls.some(([text]) => /^\s*(UPDATE|INSERT)/i.test(String(text)))).toBe(false);
  });

  it("creates a provisional item-keyed FIFO lot for a counted overage", async () => {
    const fake = createClient(async (text, values) => {
      if (text.includes("FROM inventory.inventory_levels")) {
        return { rows: [{ id: 11, warehouse_location_id: 2, product_variant_id: 101, variant_qty: 4, reserved_qty: 1 }] };
      }
      if (text.includes("FROM inventory.inventory_lots")) {
        return { rows: [{ id: 51, qty_on_hand: 4, qty_reserved: 1, qty_picked: 0, total_unit_cost_mills: "125" }] };
      }
      if (text.includes("FROM catalog.product_variants")) {
        return { rows: [{ cost_cents: "250", cost_source: "last_paid" }] };
      }
      if (text.startsWith("INSERT INTO inventory.inventory_lots")) {
        expect(values).toEqual([
          "CC-8-81", 101, 2, "250", "25000", 3, OCCURRED_AT, 1, "last_paid", "approved physical count",
        ]);
        return { rows: [{ id: 53 }], rowCount: 1 };
      }
      if (text.startsWith("UPDATE inventory.inventory_levels")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.inventory_transactions")) {
        expect(values).toEqual([
          101, null, 2, 3, 4, 7, "250", "25000", "75000", 53,
          8, "81", "approved physical count", "user:7", OCCURRED_AT,
        ]);
        return { rows: [{ id: 902 }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.applyCycleCountAdjustment({
      client: fake.client,
      inventoryLevelId: 11,
      productVariantId: 101,
      warehouseLocationId: 2,
      quantityBefore: 4,
      countedQty: 7,
      cycleCountId: 8,
      cycleCountItemId: 81,
      actor: "user:7",
      reason: "approved physical count",
      occurredAt: OCCURRED_AT,
    })).resolves.toEqual({
      adjustmentTransactionId: 902,
      consumedQty: BigInt(0),
      consumedCostMills: BigInt(0),
    });
  });

  it("records a durable item-keyed no-op when the physical count is unchanged", async () => {
    const fake = createClient(async (text, values) => {
      if (text.startsWith("INSERT INTO inventory.inventory_transactions")) {
        expect(values).toEqual([
          101, 2, 6, 8, "81", "verified unchanged count", "user:7", OCCURRED_AT,
        ]);
        return { rows: [{ id: 903 }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.recordCycleCountNoop({
      client: fake.client,
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      cycleCountId: 8,
      cycleCountItemId: 81,
      actor: "user:7",
      reason: "verified unchanged count",
      occurredAt: OCCURRED_AT,
    })).resolves.toEqual({ adjustmentTransactionId: 903 });
  });

  it("approves the exact cycle-count item through the inventory-owned writer", async () => {
    const fake = createClient(async (text, values) => {
      if (text.startsWith("UPDATE inventory.cycle_count_items")) {
        expect(values).toEqual(["user:7", OCCURRED_AT, "verified", 901, 81, "variance"]);
        return { rows: [{ id: 81 }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimInventoryRepository();

    await expect(repository.approveCycleCountItem({
      client: fake.client,
      cycleCountItemId: 81,
      expectedStatus: "variance",
      actor: "user:7",
      reasonCode: "verified",
      adjustmentTransactionId: 901,
      occurredAt: OCCURRED_AT,
    })).resolves.toBeUndefined();
  });
});
