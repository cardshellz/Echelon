import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { canonicalJson } from "@shared/utils/canonical-json";
import { BuildDomainError } from "../../../inventory/domain/build.domain";
import { PostgresInventoryAvailabilityClaimRepository } from "../../infrastructure/inventory-availability-claim.repository";

/**
 * Auto-assembly at pick (#64366, 2026-10-18). The order line wants 2 x P5;
 * its claim plan is a component build (3 parts -> 10 boxes) feeding a
 * same-product package conversion (5 boxes -> 1 P5). The pick must build, then
 * convert, then pick — in one transaction, prerequisite first.
 */
const FIXED_TIME = new Date("2026-10-18T15:00:00.000Z");
const CLAIM_ID = "9";
const ORDER_ID = 70;
const ORDER_ITEM_ID = 71;
const LINE_ID = "20";
const PICK_LOCATION_ID = 3;
const P5_VARIANT_ID = 105;
const BOX_VARIANT_ID = 104;
const PART_VARIANT_IDS = [201, 202, 203];

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function assemblyPlan() {
  return {
    requestKey: "order:70:availability:revision:1",
    scope: { kind: "warehouse" as const, warehouseId: 1 },
    status: "satisfied" as const,
    lines: [{ lineKey: "order-item:71", targetVariantId: P5_VARIANT_ID, requestedQty: "2", plannedQty: "2", shortfallQty: "0" }],
    resourceClaims: PART_VARIANT_IDS.map((sourceVariantId, index) => ({
      lineKey: "order-item:71", consumerOperationKey: "box-build", warehouseId: 1,
      warehouseLocationId: 40 + index, inventoryLevelId: 60 + index, sourceVariantId, claimedQty: "1",
    })),
    operations: [
      {
        lineKey: "order-item:71", warehouseId: 1, operationKey: "p5-pack", parentOperationKey: null,
        operationType: "directed_conversion" as const, authorityId: 7, sourceVariantIds: [BOX_VARIANT_ID],
        inputs: [{ sourceVariantId: BOX_VARIANT_ID, requiredQty: "10" }], destinationVariantId: P5_VARIANT_ID,
        plannedExecutions: "2", outputQty: "2", committedOutputQty: "2", outputLocationId: PICK_LOCATION_ID,
      },
      {
        lineKey: "order-item:71", warehouseId: 1, operationKey: "box-build", parentOperationKey: "p5-pack",
        operationType: "component_build" as const, authorityId: 8, sourceVariantIds: PART_VARIANT_IDS,
        inputs: PART_VARIANT_IDS.map((sourceVariantId) => ({ sourceVariantId, requiredQty: "1" })),
        destinationVariantId: BOX_VARIANT_ID, plannedExecutions: "1", outputQty: "10", committedOutputQty: "10",
        outputLocationId: PICK_LOCATION_ID,
      },
    ],
    fulfillmentGroups: [{
      groupKey: "order:70:availability:revision:1:warehouse:1", warehouseId: 1,
      lineAllocations: [{ lineKey: "order-item:71", targetVariantId: P5_VARIANT_ID, plannedQty: "2" }],
    }],
    modelEvidence: [],
    blockers: [],
    snapshotFingerprint: "d".repeat(64),
  };
}

type Resource = {
  id: string; consumer: string | null; producer: string | null; variantId: number; locationId: number;
  levelId: number; claimed: bigint; consumed: bigint; picked: bigint;
};
type Allocation = { id: string; resourceId: string; lotId: number; claimed: bigint; consumed: bigint; picked: bigint };
type State = {
  operations: Map<string, { id: string; status: string }>;
  resources: Resource[];
  allocations: Allocation[];
  handoffs: { id: string; operationId: string; buildOrderId: number; status: string }[];
  commands: { commandType: string; idempotencyKey: string; requestHash: string; resultPayload: unknown }[];
  linePicked: bigint;
  nextId: number;
};

function initialState(): State {
  return {
    operations: new Map([["p5-pack", { id: "301", status: "pending" }], ["box-build", { id: "302", status: "pending" }]]),
    resources: PART_VARIANT_IDS.map((variantId, index) => ({
      id: String(400 + index), consumer: "box-build", producer: null, variantId, locationId: 40 + index,
      levelId: 60 + index, claimed: BigInt(1), consumed: BigInt(0), picked: BigInt(0),
    })),
    allocations: PART_VARIANT_IDS.map((_, index) => ({
      id: String(500 + index), resourceId: String(400 + index), lotId: 700 + index,
      claimed: BigInt(1), consumed: BigInt(0), picked: BigInt(0),
    })),
    handoffs: [],
    commands: [],
    linePicked: BigInt(0),
    nextId: 1000,
  };
}

function cloneState(state: State): State {
  return {
    operations: new Map([...state.operations].map(([key, value]) => [key, { ...value }])),
    resources: state.resources.map((resource) => ({ ...resource })),
    allocations: state.allocations.map((allocation) => ({ ...allocation })),
    handoffs: state.handoffs.map((handoff) => ({ ...handoff })),
    commands: state.commands.map((command) => ({ ...command })),
    linePicked: state.linePicked,
    nextId: state.nextId,
  };
}

const open = (row: { claimed: bigint; consumed: bigint; picked: bigint }) => row.claimed - row.consumed - row.picked;

/** Stateful SQL fake with transactional snapshot/rollback semantics. */
function createAssemblyPool(plan = assemblyPlan()) {
  let committed = initialState();
  let state = committed;
  const operationByKey = (key: string) => plan.operations.find((operation) => operation.operationKey === key)!;
  const operationRow = (key: string) => {
    const planned = operationByKey(key);
    const persisted = state.operations.get(key)!;
    const handoff = state.handoffs.find((entry) => entry.operationId === persisted.id);
    return {
      id: persisted.id, claim_line_id: LINE_ID, order_item_id: ORDER_ITEM_ID, operation_key: key,
      parent_operation_key: planned.parentOperationKey, warehouse_id: planned.warehouseId,
      operation_type: planned.operationType, authority_id: planned.authorityId,
      destination_variant_id: planned.destinationVariantId, planned_executions: planned.plannedExecutions,
      output_qty: planned.outputQty, committed_output_qty: planned.committedOutputQty,
      output_location_id: planned.outputLocationId, status: persisted.status,
      executed_executions: persisted.status === "completed" ? planned.plannedExecutions : "0", released_executions: "0",
      ...(handoff ? { handoff_id: handoff.id, build_order_id: handoff.buildOrderId, adopted_reservation_qty: "3", handoff_status: handoff.status } : {}),
    };
  };
  const resourceRow = (resource: Resource) => ({
    id: resource.id, claim_line_id: LINE_ID, warehouse_id: 1, warehouse_location_id: resource.locationId,
    inventory_level_id: resource.levelId, source_variant_id: resource.variantId, claimed_qty: resource.claimed.toString(),
    released_qty: "0", consumed_qty: resource.consumed.toString(), picked_qty: resource.picked.toString(),
  });
  const allocationRow = (allocation: Allocation) => ({
    id: allocation.id, claim_resource_id: allocation.resourceId, inventory_lot_id: allocation.lotId,
    claimed_qty: allocation.claimed.toString(), released_qty: "0", consumed_qty: allocation.consumed.toString(),
    picked_qty: allocation.picked.toString(), unit_cost_mills: "1000", po_unit_cost_mills: "900",
    packaging_unit_cost_mills: "60", landed_unit_cost_mills: "40",
  });
  const handler = async (text: string, values: any[]): Promise<any> => {
    const sql = text.trim();
    if (sql.startsWith("BEGIN")) { state = cloneState(committed); return { rows: [] }; }
    if (sql === "COMMIT") { committed = state; return { rows: [] }; }
    if (sql === "ROLLBACK") { state = committed; return { rows: [] }; }
    if (sql.includes("pg_advisory_xact_lock") || sql.includes("FROM inventory.transformation_model_heads")) return { rows: [] };
    if (sql.includes("FROM inventory.availability_claim_commands")) {
      const found = state.commands.find((command) => command.idempotencyKey === values[0]);
      return { rows: found ? [{ command_type: found.commandType, request_hash: found.requestHash, result_payload: found.resultPayload }] : [] };
    }
    if (sql.includes("FROM inventory.availability_runtime_authority")) {
      return { rows: [{ authority: "canonical", activation_run_id: "8", revision: "2" }] };
    }
    if (sql.includes("FROM inventory.availability_claims")) {
      return { rows: [{ id: CLAIM_ID, claim_key: plan.requestKey, order_id: ORDER_ID, revision: 1, status: "active",
        runtime_authority_revision: "2", plan_hash: hash(plan), plan_payload: plan }] };
    }
    if (sql.includes("FROM catalog.product_variants") && sql.includes("product_id") && !sql.includes("transformation_model_paths")) {
      return { rows: [BOX_VARIANT_ID, P5_VARIANT_ID, ...PART_VARIANT_IDS].map((id) => ({ id, product_id: 10 })) };
    }
    if (sql.includes("FROM inventory.transformation_model_paths path")) {
      return { rows: [{ id: 7, operationType: "directed_conversion", sourceVariantId: BOX_VARIANT_ID,
        destinationVariantId: P5_VARIANT_ID, sourceProductId: 10, destinationProductId: 10, inputQty: 5, outputQty: 1,
        sourceUnitsPerVariant: 1, destinationUnitsPerVariant: 5, authorityState: "allowed", validationState: "valid" }] };
    }
    if (sql.includes("FROM wms.orders")) {
      return { rows: [{ order_id: ORDER_ID, warehouse_id: 1, warehouse_status: "ready", on_hold: 0, order_edit_operation_id: null }] };
    }
    if (sql.includes("FROM wms.order_items")) {
      return { rows: [{ order_item_id: ORDER_ITEM_ID, sku: "QUAD-BOX-TOP-P5", stored_product_id: 10, order_item_requires_shipping: 1,
        target_variant_id: P5_VARIANT_ID, requested_qty: 2, root_product_id: 10, is_active: true, requires_shipping: true,
        track_inventory: true, sales_eligibility: "sellable" }] };
    }
    if (sql.includes("FROM warehouse.warehouse_locations")) {
      return { rows: [{ warehouse_id: 1, is_active: 1, is_pickable: 1, cycle_count_freeze_id: null }] };
    }
    if (sql.includes("FROM inventory.availability_claim_lines")) {
      return { rows: [{ id: LINE_ID, order_item_id: ORDER_ITEM_ID, target_variant_id: P5_VARIANT_ID, planned_qty: "2",
        released_target_qty: "0", consumed_target_qty: "0", picked_target_qty: state.linePicked.toString() }] };
    }
    // Materialization reads every operation state on the line.
    if (sql.startsWith("SELECT operation_key, status FROM inventory.availability_claim_operations")
      && sql.includes("claim_line_id = $2")) {
      return { rows: [...state.operations].map(([key, value]) => ({ operation_key: key, status: value.status })) };
    }
    // Prerequisite read inside loadOperationExecutionResources.
    if (sql.includes("FROM inventory.availability_claim_operations") && sql.includes("parent_operation_key = $2")) {
      return { rows: plan.operations.filter((operation) => operation.parentOperationKey === values[1])
        .map((operation) => ({ operation_key: operation.operationKey, status: state.operations.get(operation.operationKey)!.status })) };
    }
    if (sql.includes("FROM inventory.availability_claim_operations AS operation")) {
      const row = operationRow(String(values[1]));
      if (sql.includes("JOIN inventory.availability_claim_build_handoffs")) return { rows: row.handoff_id ? [row] : [] };
      return { rows: [row] };
    }
    if (sql.includes("FROM inventory.availability_claim_operation_inputs")) {
      const key = [...state.operations].find(([, value]) => value.id === String(values[0]))![0];
      return { rows: operationByKey(key).inputs.map((input) => ({ source_variant_id: input.sourceVariantId, required_qty: input.requiredQty })) };
    }
    if (sql.includes("FROM inventory.availability_claim_resources") && sql.includes("consumer_operation_key = $2")) {
      return { rows: state.resources.filter((resource) => resource.consumer === values[1] && open(resource) > BigInt(0)).map(resourceRow) };
    }
    if (sql.includes("FROM inventory.availability_claim_resources") && sql.includes("consumer_operation_key IS NULL")) {
      return { rows: state.resources.filter((resource) => resource.consumer === null && resource.variantId === values[2]).map(resourceRow) };
    }
    if (sql.includes("FROM inventory.availability_claim_lot_allocations")) {
      const ids = new Set((values.find(Array.isArray) as string[]).map(String));
      return { rows: state.allocations.filter((allocation) => ids.has(allocation.resourceId)).map(allocationRow) };
    }
    if (sql.startsWith("UPDATE inventory.availability_claim_lot_allocations")) {
      const allocation = state.allocations.find((entry) => entry.id === String(values[1]))!;
      const qty = BigInt(values[0]);
      if (sql.includes("SET consumed_qty")) allocation.consumed += qty; else allocation.picked += qty;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE inventory.availability_claim_resources")) {
      const resource = state.resources.find((entry) => entry.id === String(values[1]))!;
      const qty = BigInt(values[0]);
      if (sql.includes("SET consumed_qty")) resource.consumed += qty; else resource.picked += qty;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE inventory.availability_claim_lines")) {
      state.linePicked += BigInt(values[0]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE inventory.availability_claim_operations")) {
      const entry = [...state.operations.values()].find((value) => value.id === String(values[0]))!;
      entry.status = sql.includes("status = 'executing'") ? "executing" : "completed";
      return { rows: [{ id: entry.id }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO inventory.availability_claim_build_handoffs")) {
      state.handoffs.push({ id: String(state.nextId++), operationId: String(values[1]), buildOrderId: Number(values[2]), status: "handed_off" });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE inventory.availability_claim_build_handoffs")) {
      state.handoffs.find((handoff) => handoff.id === String(values[0]))!.status = "completed";
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO inventory.availability_claim_resources")) {
      const id = String(state.nextId++);
      state.resources.push({ id, consumer: values[2], producer: values[3], variantId: Number(values[7]),
        locationId: Number(values[5]), levelId: Number(values[6]), claimed: BigInt(values[8]), consumed: BigInt(0), picked: BigInt(0) });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO inventory.availability_claim_lot_allocations")) {
      state.allocations.push({ id: String(state.nextId++), resourceId: String(values[1]), lotId: Number(values[2]),
        claimed: BigInt(values[3]), consumed: BigInt(0), picked: BigInt(0) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO inventory.availability_claim_commands")) {
      const handoff = sql.includes("'handoff_build'");
      state.commands.push(handoff
        ? { commandType: "handoff_build", idempotencyKey: values[2], requestHash: values[3], resultPayload: JSON.parse(values[6]) }
        : { commandType: values[2], idempotencyKey: values[3], requestHash: values[4], resultPayload: JSON.parse(values[7]) });
      return { rows: [{ id: "31" }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE wms.order_items")) return { rows: [{ id: ORDER_ITEM_ID }], rowCount: 1 };
    if (sql.startsWith("UPDATE wms.outbound_shipment_items")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("INSERT INTO inventory.availability_claim_pick_movements")
      || sql.startsWith("INSERT INTO inventory.availability_claim_events")) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query: ${text}`);
  };
  const query = vi.fn(async (text: string, values: unknown[] = []) => handler(text, values as any[]));
  return {
    pool: { connect: vi.fn(async () => ({ query, release: vi.fn() })) } as any,
    query,
    committed: () => committed,
  };
}

function createWriters() {
  const inventoryWriter = {
    assertCountableCustody: vi.fn(), ensureInventoryLevel: vi.fn(), applyCycleCountAdjustment: vi.fn(),
    recordCycleCountNoop: vi.fn(), approveCycleCountItem: vi.fn(), reserveResource: vi.fn(), releaseResources: vi.fn(),
    reconcilePickResource: vi.fn(), reconcileObservedPickResource: vi.fn(), unpickResources: vi.fn(), executeBuildOperation: vi.fn(),
    // P5 conversion: 10 boxes -> 2 P5 at the pick bin, one exact cost lot.
    executePackageOperation: vi.fn(async () => ({
      outputInventoryLevelId: 90, totalInputCostMills: BigInt(30_000),
      committedLotAllocations: [{ inventoryLotId: 902, qty: 2, unitCostMills: BigInt(15_000), poUnitCostMills: BigInt(13_500),
        packagingUnitCostMills: BigInt(900), landedUnitCostMills: BigInt(600) }],
    })),
    pickResources: vi.fn(async () => ({
      movements: [{ claimResourceId: BigInt(1003), claimLotAllocationId: BigInt(1004), inventoryLotId: 902, quantity: BigInt(2),
        unitCostMills: BigInt(15_000), totalCostMills: BigInt(30_000), orderItemCostId: 81, reversesPickMovementId: null }],
      totalCostMills: BigInt(30_000),
    })),
  };
  const buildWriter = {
    handoffOperation: vi.fn(async () => ({ buildOrderId: 88, buildSystemNumber: "BLD-000088", adoptedReservationQty: BigInt(3) })),
    // One build: 3 parts (1000 mills each) -> 10 boxes at the pick bin.
    executeOperation: vi.fn(async () => ({
      buildOrderId: 88, buildRunId: 89, buildSystemNumber: "BLD-000088", outputInventoryLevelId: 91, totalInputCostMills: BigInt(3000),
      committedLotAllocations: [{ inventoryLotId: 901, qty: 10, unitCostMills: BigInt(300), poUnitCostMills: BigInt(270),
        packagingUnitCostMills: BigInt(18), landedUnitCostMills: BigInt(12) }],
    })),
    cancelOperation: vi.fn(),
  };
  return { inventoryWriter, buildWriter };
}

const pickCommand = {
  claimId: CLAIM_ID, orderItemId: ORDER_ITEM_ID, warehouseLocationId: PICK_LOCATION_ID, quantity: "2",
  locationStrategy: "strict" as const, idempotencyKey: "pick:64366:71:1", actor: "picker-7", reason: "picker scanned line",
  wmsProgress: { expectedStatus: "pending" as const, expectedPickedQuantity: 0, targetStatus: "completed" as const, targetPickedQuantity: 2 },
};

describe("auto-assembly at pick", () => {
  it("builds, converts and picks atomically in prerequisite order with system hand-off evidence", async () => {
    const fake = createAssemblyPool();
    const { inventoryWriter, buildWriter } = createWriters();
    const repository = new PostgresInventoryAvailabilityClaimRepository(inventoryWriter as any, fake.pool, () => FIXED_TIME, buildWriter as any);

    await expect(repository.pickClaimLine(pickCommand)).resolves.toMatchObject({
      outcome: "picked", quantity: "2", totalCostMills: "30000", idempotentReplay: false,
    });

    // Build first, then the conversion that consumes its boxes, then the pick.
    expect(buildWriter.handoffOperation.mock.invocationCallOrder[0]).toBeLessThan(buildWriter.executeOperation.mock.invocationCallOrder[0]);
    expect(buildWriter.executeOperation.mock.invocationCallOrder[0]).toBeLessThan(inventoryWriter.executePackageOperation.mock.invocationCallOrder[0]);
    expect(inventoryWriter.executePackageOperation.mock.invocationCallOrder[0]).toBeLessThan(inventoryWriter.pickResources.mock.invocationCallOrder[0]);
    expect(buildWriter.handoffOperation).toHaveBeenCalledWith(expect.objectContaining({
      claimOperationId: BigInt(302), transformationRecipeBindingId: 8, plannedBuilds: BigInt(1), outputQty: BigInt(10),
      outputLocationId: PICK_LOCATION_ID, actor: "picker-7",
      inputs: PART_VARIANT_IDS.map((sourceVariantId) => ({ sourceVariantId, requiredQty: BigInt(1) })),
    }));
    expect(buildWriter.executeOperation).toHaveBeenCalledWith(expect.objectContaining({
      buildOrderId: 88, orderId: ORDER_ID, orderItemId: ORDER_ITEM_ID, committedOutputQty: BigInt(10),
      resources: expect.arrayContaining([expect.objectContaining({ sourceVariantId: 201, consumeQty: BigInt(1) })]),
    }));

    const committed = fake.committed();
    expect(committed.operations.get("box-build")!.status).toBe("completed");
    expect(committed.operations.get("p5-pack")!.status).toBe("completed");
    expect(committed.handoffs).toEqual([expect.objectContaining({ operationId: "302", buildOrderId: 88, status: "completed" })]);
    expect(committed.resources.filter((resource) => resource.consumer === "box-build").every((resource) => open(resource) === BigInt(0))).toBe(true);
    expect(committed.resources.find((resource) => resource.producer === "box-build")).toMatchObject({ consumer: "p5-pack", claimed: BigInt(10), consumed: BigInt(10) });
    expect(committed.resources.find((resource) => resource.producer === "p5-pack")).toMatchObject({ consumer: null, claimed: BigInt(2), picked: BigInt(2) });
    expect(committed.linePicked).toBe(BigInt(2));
    const identity = hash({ pick: pickCommand.idempotencyKey, operation: "box-build" });
    expect(committed.commands.map((command) => [command.commandType, command.idempotencyKey])).toEqual([
      ["handoff_build", `pick-build-handoff:${identity}`],
      ["execute_build", `pick-build:${identity}`],
      ["execute", `pick-package-conversion:${hash({ pick: pickCommand.idempotencyKey, operation: "p5-pack" })}`],
      ["pick", pickCommand.idempotencyKey],
    ]);
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("rolls the whole pick back with zero postings when a component is short", async () => {
    const fake = createAssemblyPool();
    const { inventoryWriter, buildWriter } = createWriters();
    buildWriter.executeOperation.mockRejectedValueOnce(new BuildDomainError(
      "CLAIM_BUILD_LOT_RESERVATION_DRIFT", "A claimed FIFO lot cannot cover its adopted reservation", { inventoryLotId: 702 }));
    const repository = new PostgresInventoryAvailabilityClaimRepository(inventoryWriter as any, fake.pool, () => FIXED_TIME, buildWriter as any);
    const before = cloneState(fake.committed());

    await expect(repository.pickClaimLine(pickCommand)).rejects.toMatchObject({
      code: "CLAIM_PICK_AUTO_ASSEMBLY_FAILED",
      context: expect.objectContaining({ operationKey: "box-build", buildErrorCode: "CLAIM_BUILD_LOT_RESERVATION_DRIFT" }),
    });

    expect(inventoryWriter.executePackageOperation).not.toHaveBeenCalled();
    expect(inventoryWriter.pickResources).not.toHaveBeenCalled();
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(fake.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    // The hand-off row and its receipt were written in-transaction, then discarded.
    expect(fake.query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO inventory.availability_claim_build_handoffs"))).toBe(true);
    expect(fake.committed()).toEqual(before);
  });

  it("replays the same pick key without building twice, and a new pick never rebuilds a completed build", async () => {
    const fake = createAssemblyPool();
    const { inventoryWriter, buildWriter } = createWriters();
    const repository = new PostgresInventoryAvailabilityClaimRepository(inventoryWriter as any, fake.pool, () => FIXED_TIME, buildWriter as any);

    const first = await repository.pickClaimLine(pickCommand);
    await expect(repository.pickClaimLine(pickCommand)).resolves.toEqual({ ...first, idempotentReplay: true });

    expect(buildWriter.handoffOperation).toHaveBeenCalledOnce();
    expect(buildWriter.executeOperation).toHaveBeenCalledOnce();
    expect(inventoryWriter.executePackageOperation).toHaveBeenCalledOnce();
    expect(inventoryWriter.pickResources).toHaveBeenCalledOnce();
    expect(fake.committed().commands.filter((command) => command.commandType === "execute_build")).toHaveLength(1);
  });

  it("refuses a build already handed to assembly work instead of executing it twice", async () => {
    const fake = createAssemblyPool();
    const { inventoryWriter, buildWriter } = createWriters();
    const repository = new PostgresInventoryAvailabilityClaimRepository(inventoryWriter as any, fake.pool, () => FIXED_TIME, buildWriter as any);
    fake.committed().operations.get("box-build")!.status = "executing";

    await expect(repository.pickClaimLine(pickCommand)).rejects.toMatchObject({ code: "CLAIM_PICK_BUILD_HANDED_OFF" });
    expect(buildWriter.handoffOperation).not.toHaveBeenCalled();
    expect(buildWriter.executeOperation).not.toHaveBeenCalled();
    expect(inventoryWriter.pickResources).not.toHaveBeenCalled();
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("fails closed when no build writer is configured", async () => {
    const fake = createAssemblyPool();
    const { inventoryWriter } = createWriters();
    const repository = new PostgresInventoryAvailabilityClaimRepository(inventoryWriter as any, fake.pool, () => FIXED_TIME);

    await expect(repository.pickClaimLine(pickCommand)).rejects.toMatchObject({ code: "CLAIM_BUILD_EXECUTION_NOT_CONFIGURED" });
    expect(inventoryWriter.pickResources).not.toHaveBeenCalled();
  });
});
