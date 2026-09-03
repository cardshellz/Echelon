import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { canonicalJson } from "@shared/utils/canonical-json";
import {
  InventoryAvailabilityClaimRepositoryError,
  PostgresInventoryAvailabilityClaimRepository,
  selectCycleCountDisplacedClaims,
} from "../../infrastructure/inventory-availability-claim.repository";

const FIXED_TIME = new Date("2026-09-02T02:00:00.000Z");

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function createPool(handler: (text: string, values: unknown[]) => Promise<any>) {
  const query = vi.fn(async (text: string, values: unknown[] = []) => handler(text, values));
  const release = vi.fn();
  return {
    pool: { connect: vi.fn(async () => ({ query, release })) } as any,
    query,
    release,
  };
}

function createInventoryWriter() {
  return {
    ensureInventoryLevel: vi.fn(),
    applyCycleCountAdjustment: vi.fn(),
    recordCycleCountNoop: vi.fn(async () => ({ adjustmentTransactionId: 900 })),
    approveCycleCountItem: vi.fn(async () => undefined),
    reserveResource: vi.fn(async () => []),
    releaseResources: vi.fn(async () => undefined),
    reconcilePickResource: vi.fn(async () => []),
    reconcileObservedPickResource: vi.fn(),
    pickResources: vi.fn(),
    unpickResources: vi.fn(),
    executePackageOperation: vi.fn(),
    executeBuildOperation: vi.fn(),
  };
}

function packageClaimPlan() {
  const operationKey = "order-item:71:warehouse:1:path:7:operation:1";
  return {
    requestKey: "order:70:availability:revision:1",
    scope: { kind: "warehouse" as const, warehouseId: 1 },
    status: "satisfied" as const,
    lines: [{
      lineKey: "order-item:71",
      targetVariantId: 105,
      requestedQty: "3",
      plannedQty: "3",
      shortfallQty: "0",
    }],
    resourceClaims: [{
      lineKey: "order-item:71",
      consumerOperationKey: operationKey,
      warehouseId: 1,
      warehouseLocationId: 2,
      inventoryLevelId: 11,
      sourceVariantId: 101,
      claimedQty: "5",
    }],
    operations: [{
      lineKey: "order-item:71",
      warehouseId: 1,
      operationKey,
      parentOperationKey: null,
      operationType: "assemble_pack" as const,
      authorityId: 7,
      sourceVariantIds: [101],
      inputs: [{ sourceVariantId: 101, requiredQty: "5" }],
      destinationVariantId: 105,
      plannedExecutions: "1",
      outputQty: "4",
      committedOutputQty: "3",
      outputLocationId: 3,
    }],
    fulfillmentGroups: [{
      groupKey: "order:70:availability:revision:1:warehouse:1",
      warehouseId: 1,
      lineAllocations: [{ lineKey: "order-item:71", targetVariantId: 105, plannedQty: "3" }],
    }],
    modelEvidence: [],
    blockers: [],
    snapshotFingerprint: "a".repeat(64),
  };
}

function buildClaimPlan() {
  const plan = packageClaimPlan();
  return {
    ...plan,
    operations: [{
      ...plan.operations[0],
      operationType: "component_build" as const,
      outputQty: "3",
      committedOutputQty: "3",
    }],
  };
}

function directClaimPlan(requestedQty = 3, revision = 1) {
  return {
    requestKey: `order:70:availability:revision:${revision}`,
    scope: { kind: "warehouse" as const, warehouseId: 1 },
    status: "satisfied" as const,
    lines: [{
      lineKey: "order-item:71",
      targetVariantId: 101,
      requestedQty: String(requestedQty),
      plannedQty: String(requestedQty),
      shortfallQty: "0",
    }],
    resourceClaims: [{
      lineKey: "order-item:71",
      consumerOperationKey: null,
      warehouseId: 1,
      warehouseLocationId: 11,
      inventoryLevelId: 1,
      sourceVariantId: 101,
      claimedQty: String(requestedQty),
    }],
    operations: [],
    fulfillmentGroups: [{
      groupKey: `order:70:availability:revision:${revision}:warehouse:1`,
      warehouseId: 1,
      lineAllocations: [{
        lineKey: "order-item:71",
        targetVariantId: 101,
        plannedQty: String(requestedQty),
      }],
    }],
    modelEvidence: [],
    blockers: [],
    snapshotFingerprint: "b".repeat(64),
  };
}

function createClaimReplacementPool(
  oldPlan = directClaimPlan(),
  options: { currentRequestedQty?: number; pickedTargetQty?: string; cycleCountShortage?: boolean } = {},
) {
  let snapshotInventoryReads = 0;
  const pickedQty = options.pickedTargetQty ?? "0";
  const openClaimQty = String(BigInt("3") - BigInt(pickedQty));
  const fake = createPool(async (text) => {
    const sql = text.trim();
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
    if (sql.includes("FROM inventory.availability_runtime_authority")) {
      return { rows: [{ authority: "canonical", activation_run_id: "8", revision: "2" }] };
    }
    if (options.cycleCountShortage && sql.includes("FROM inventory.cycle_counts")) {
      return { rows: [{ id: 8, status: "in_progress" }] };
    }
    if (options.cycleCountShortage && sql.includes("FROM inventory.cycle_count_items")) {
      return { rows: [{
        id: 81,
        cycle_count_id: 8,
        warehouse_location_id: 11,
        product_variant_id: 101,
        counted_qty: 1,
        status: "variance",
        adjustment_transaction_id: null,
      }] };
    }
    if (sql.includes("COALESCE(MAX(revision)")) return { rows: [{ revision: 2 }] };
    if (options.cycleCountShortage && sql.includes("SELECT claim.id AS claim_id")) {
      return { rows: [{ claim_id: "9", order_id: 70, claim_resource_id: "12", open_qty: "3" }] };
    }
    if (sql.includes("FROM inventory.availability_claims")) {
      return { rows: [{
        id: "9",
        claim_key: oldPlan.requestKey,
        order_id: 70,
        revision: 1,
        runtime_authority_revision: "2",
        plan_hash: hash(oldPlan),
        plan_payload: oldPlan,
      }] };
    }
    if (sql.includes("FROM wms.orders")) {
      return { rows: [{ order_id: 70, warehouse_id: 1, warehouse_status: "ready", on_hold: 0 }] };
    }
    if (sql.includes("FROM wms.order_items")) {
      return { rows: [{
        order_item_id: 71,
        sku: "EA",
        stored_product_id: 101,
        order_item_requires_shipping: 1,
        target_variant_id: 101,
        requested_qty: options.currentRequestedQty ?? 2,
        root_product_id: 10,
        is_active: true,
        requires_shipping: true,
        track_inventory: true,
        sales_eligibility: "sellable",
      }] };
    }
    if (sql.includes("WITH RECURSIVE graph")) return { rows: [{ product_id: 10 }] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("transaction_timestamp() AS captured_at")) {
      return { rows: [{ captured_at: FIXED_TIME.toISOString() }] };
    }
    if (sql.includes("FROM catalog.products")) {
      return { rows: [{ id: 10, inventory_strategy: "physical_only" }] };
    }
    if (sql.includes("FROM catalog.product_variants")) {
      return { rows: [{
        id: 101,
        product_id: 10,
        sku: "EA",
        name: "Each",
        units_per_variant: 1,
        is_active: true,
        requires_shipping: true,
        track_inventory: true,
        sales_eligibility: "sellable",
      }] };
    }
    if (sql.includes("FROM inventory.transformation_model_heads")) {
      return { rows: [{
        product_id: 10,
        draft_model_id: null,
        active_model_id: 501,
        model_id: 501,
        version: 1,
        lifecycle_status: "sealed",
        build_to_promise_enabled: false,
        definition_hash: "a".repeat(64),
        validation_state: "valid",
        validation_errors: [],
      }] };
    }
    if (sql.includes("FROM inventory.transformation_model_paths")
      || sql.includes("FROM inventory.transformation_recipe_bindings")
      || sql.includes("FROM inventory.build_recipes")) return { rows: [] };
    if (sql.includes("FROM warehouse.warehouses")) {
      return { rows: [{ id: 1, code: "LEON", is_active: true, hub_warehouse_id: null }] };
    }
    if (sql.includes("FROM inventory.inventory_levels")) {
      if (options.cycleCountShortage && sql.includes("WHERE product_variant_id = $1")
        && sql.includes("warehouse_location_id = $2")) {
        return { rows: [{ id: 1, variant_qty: 5, reserved_qty: 3 }] };
      }
      if (options.cycleCountShortage && sql.includes("WHERE id = $1") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: 1, variant_qty: 5, reserved_qty: 3 }] };
      }
      if (sql.includes("SELECT id") && sql.includes("FOR UPDATE")) return { rows: [{ id: 1 }] };
      snapshotInventoryReads += 1;
      return { rows: [{
        id: 1,
        warehouse_location_id: 11,
        product_variant_id: 101,
        variant_qty: options.cycleCountShortage && snapshotInventoryReads > 1 ? "1" : options.cycleCountShortage ? "5" : "10",
        reserved_qty: snapshotInventoryReads === 1 ? openClaimQty : "0",
        picked_qty: pickedQty,
        packed_qty: "0",
      }] };
    }
    if (sql.includes("FROM inventory.inventory_lots")) return { rows: [] };
    if (sql.includes("FROM warehouse.product_locations")) {
      return { rows: [{ product_variant_id: 101, warehouse_id: 1, warehouse_location_id: 11 }] };
    }
    if (sql.includes("FROM warehouse.warehouse_locations AS location")) {
      return { rows: [{
        id: 11,
        warehouse_id: 1,
        code: "PICK-1",
        location_type: "pick",
        is_pickable: true,
        is_active: true,
        cycle_count_freeze_id: options.cycleCountShortage ? 8 : null,
        draft_policy_id: null,
        policy_id: null,
      }] };
    }
    if (sql.includes("FROM inventory.promise_safety_policy_heads")) {
      if (sql.includes("SELECT scope_key")) return { rows: [] };
      return { rows: [{
        draft_policy_id: null,
        policy_id: 1,
        version: 1,
        scope_key: "business",
        scope_type: "business",
        product_variant_id: null,
        warehouse_id: null,
        policy_mode: "off",
        fixed_units: null,
        days_of_cover_milli_days: null,
        untrusted_demand_fallback_units: null,
        demand_method_version: null,
        definition_hash: "c".repeat(64),
      }] };
    }
    if (sql.includes("FROM inventory.location_promise_policy_heads")
      || sql.includes("FROM inventory.demand_evidence_snapshots")) return { rows: [] };
    if (sql.includes("FROM inventory.availability_claim_build_handoffs")) return { rows: [] };
    if (sql.includes("FROM inventory.availability_claim_lines") && sql.includes("FOR SHARE")) {
      return { rows: [{
        line_key: "order-item:71",
        target_variant_id: 101,
        requested_qty: "3",
        planned_qty: "3",
        shortfall_qty: "0",
        released_target_qty: "0",
        consumed_target_qty: "0",
        picked_target_qty: pickedQty,
      }] };
    }
    if (sql.includes("FROM inventory.availability_claim_resources AS resource")) {
      return { rows: [{
        id: "12",
        claim_line_id: "20",
        inventory_level_id: 1,
        warehouse_location_id: 11,
        source_variant_id: 101,
        claimed_qty: "3",
        released_qty: "0",
        consumed_qty: "0",
        picked_qty: pickedQty,
        order_item_id: 71,
      }] };
    }
    if (sql.includes("FROM inventory.availability_claim_lot_allocations AS allocation")) {
      return { rows: [{
        id: "21",
        claim_resource_id: "12",
        inventory_lot_id: 51,
        claimed_qty: "3",
        released_qty: "0",
        consumed_qty: "0",
        picked_qty: pickedQty,
      }] };
    }
    if (sql.startsWith("UPDATE inventory.availability_claims")
      || sql.startsWith("UPDATE inventory.availability_claim_")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("INSERT INTO inventory.availability_claims")) return { rows: [{ id: "10" }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO inventory.availability_claim_lines")) {
      return { rows: [{ id: "30" }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO inventory.availability_claim_resources")) {
      return { rows: [{ id: "31" }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO inventory.availability_claim_")) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query: ${text}`);
  });
  return { ...fake, getSnapshotInventoryReads: () => snapshotInventoryReads };
}

describe("PostgresInventoryAvailabilityClaimRepository", () => {
  it("selects the newest whole claims needed to fit a counted shortage", () => {
    const claims = [
      { claimId: BigInt(7), orderId: 70, openQty: BigInt(3) },
      { claimId: BigInt(8), orderId: 71, openQty: BigInt(4) },
      { claimId: BigInt(9), orderId: 72, openQty: BigInt(3) },
    ];

    expect(selectCycleCountDisplacedClaims(claims, 10, 7)).toEqual([claims[2]]);
    expect(selectCycleCountDisplacedClaims(claims, 10, 4)).toEqual([claims[1], claims[2]]);
    expect(selectCycleCountDisplacedClaims(claims, 10, 10)).toEqual([]);
  });

  it("refuses displacement when aggregate reserved quantity lacks exact claim ownership", () => {
    expect(() => selectCycleCountDisplacedClaims([
      { claimId: BigInt(7), orderId: 70, openQty: BigInt(3) },
    ], 4, 2)).toThrow(expect.objectContaining({ code: "CYCLE_COUNT_CLAIM_OWNERSHIP_MISMATCH" }));
  });

  it("releases, adjusts, partially replans, and approves a counted shortage in one transaction", async () => {
    const oldPlan = directClaimPlan(3);
    const fake = createClaimReplacementPool(oldPlan, {
      currentRequestedQty: 3,
      cycleCountShortage: true,
    });
    const writer = createInventoryWriter();
    writer.applyCycleCountAdjustment.mockResolvedValue({
      adjustmentTransactionId: 901,
      consumedQty: BigInt(4),
      consumedCostMills: BigInt(500),
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.reconcileCycleCount({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 11,
      countedQty: 1,
      reasonCode: "verified",
      actor: "user:7",
      reason: "verified physical shortage",
    })).resolves.toEqual({
      outcome: "cycle_count_reconciled",
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 11,
      quantityBefore: 5,
      quantityAfter: 1,
      quantityDelta: -4,
      adjustmentTransactionId: 901,
      displacedOrderIds: [70],
      idempotentReplay: false,
    });

    expect(writer.releaseResources).toHaveBeenCalledWith(expect.objectContaining({
      claimId: BigInt(9),
      orderId: 70,
      resources: [expect.objectContaining({ releaseQty: BigInt(3) })],
    }));
    expect(writer.applyCycleCountAdjustment).toHaveBeenCalledWith(expect.objectContaining({
      quantityBefore: 5,
      countedQty: 1,
      cycleCountItemId: 81,
    }));
    expect(writer.reserveResource).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 70,
      claimedQty: 1,
    }));
    expect(writer.approveCycleCountItem).toHaveBeenCalledWith(expect.objectContaining({
      cycleCountItemId: 81,
      adjustmentTransactionId: 901,
    }));
    expect(writer.releaseResources.mock.invocationCallOrder[0])
      .toBeLessThan(writer.applyCycleCountAdjustment.mock.invocationCallOrder[0]);
    expect(writer.applyCycleCountAdjustment.mock.invocationCallOrder[0])
      .toBeLessThan(writer.reserveResource.mock.invocationCallOrder[0]);
    expect(writer.reserveResource.mock.invocationCallOrder[0])
      .toBeLessThan(writer.approveCycleCountItem.mock.invocationCallOrder[0]);
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("rolls back a counted shortage when replacement reservation fails", async () => {
    const fake = createClaimReplacementPool(directClaimPlan(3), {
      currentRequestedQty: 3,
      cycleCountShortage: true,
    });
    const writer = createInventoryWriter();
    writer.applyCycleCountAdjustment.mockResolvedValue({
      adjustmentTransactionId: 901,
      consumedQty: BigInt(4),
      consumedCostMills: BigInt(500),
    });
    writer.reserveResource.mockRejectedValueOnce(new Error("replacement reservation failed"));
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.reconcileCycleCount({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 11,
      countedQty: 1,
      reasonCode: "verified",
      actor: "user:7",
      reason: "verified physical shortage",
    })).rejects.toThrow("replacement reservation failed");

    expect(writer.releaseResources).toHaveBeenCalledOnce();
    expect(writer.applyCycleCountAdjustment).toHaveBeenCalledOnce();
    expect(writer.approveCycleCountItem).not.toHaveBeenCalled();
    expect(fake.query.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(fake.query.mock.calls.some(([text]) => text === "COMMIT")).toBe(false);
  });

  it("fails closed before claim pick when canonical authority is inactive", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "legacy", activation_run_id: null, revision: "1" }] };
      }
      if (text === "ROLLBACK") return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.pickClaimLine({
      claimId: "9",
      orderItemId: 71,
      warehouseLocationId: 2,
      quantity: "3",
      locationStrategy: "strict",
      idempotencyKey: "pick:9:71:1",
      actor: "test-user",
      reason: "unit test",
    })).rejects.toEqual(expect.objectContaining({ code: "CANONICAL_AUTHORITY_NOT_ACTIVE" }));

    expect(writer.pickResources).not.toHaveBeenCalled();
  });

  it("replays an exact claim pick receipt without touching inventory", async () => {
    const command = {
      claimId: "9",
      orderItemId: 71,
      warehouseLocationId: 2,
      quantity: "3",
      locationStrategy: "strict" as const,
      idempotencyKey: "pick:9:71:1",
      actor: "test-user",
      reason: "unit test",
    };
    const persisted = {
      outcome: "picked" as const,
      claimId: "9",
      claimLineId: "20",
      orderId: 70,
      orderItemId: 71,
      warehouseLocationIds: [2],
      quantity: "3",
      reconciledQuantity: "0",
      totalCostMills: "375",
      idempotentReplay: false,
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) {
        return { rows: [{ command_type: "pick", request_hash: hash(command), result_payload: persisted }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.pickClaimLine(command)).resolves.toEqual({
      ...persisted,
      idempotentReplay: true,
    });
    expect(writer.pickResources).not.toHaveBeenCalled();
    expect(writer.reconcilePickResource).not.toHaveBeenCalled();
  });

  it("replays an exact picker-observation receipt without duplicating inventory or review writes", async () => {
    const command = {
      claimId: "9",
      orderItemId: 71,
      warehouseLocationId: 3,
      quantity: "3",
      locationStrategy: "reconcile_picker_observation" as const,
      observation: {
        kind: "validated_item_scan" as const,
        observedPhysicalQty: "3",
        locationCode: "P-3",
        deviceType: "scanner",
        sessionId: "session-1",
      },
      idempotencyKey: "pick:9:71:observation:1",
      actor: "test-user",
      reason: "picker found stock missing from the system",
    };
    const persisted = {
      outcome: "picked_with_observation" as const,
      claimId: "9",
      claimLineId: "20",
      orderId: 70,
      orderItemId: 71,
      warehouseLocationIds: [3],
      quantity: "3",
      reconciledQuantity: "3",
      recordedReconciledQuantity: "1",
      observedRelocatedQuantity: "2",
      inventoryReviewId: 88,
      observationKind: "validated_item_scan" as const,
      totalCostMills: "375",
      idempotentReplay: false,
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) {
        return {
          rows: [{
            command_type: "pick_observation",
            request_hash: hash(command),
            result_payload: persisted,
          }],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    const reviewWriter = { recordReview: vi.fn() };
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      writer,
      fake.pool,
      () => FIXED_TIME,
      undefined,
      reviewWriter,
    );

    await expect(repository.pickClaimLine(command)).resolves.toEqual({
      ...persisted,
      idempotentReplay: true,
    });
    expect(writer.ensureInventoryLevel).not.toHaveBeenCalled();
    expect(writer.reconcileObservedPickResource).not.toHaveBeenCalled();
    expect(writer.pickResources).not.toHaveBeenCalled();
    expect(reviewWriter.recordReview).not.toHaveBeenCalled();
  });

  it("picks an exact claim line and persists command, movement, and event evidence atomically", async () => {
    const plan = packageClaimPlan();
    const command = {
      claimId: "9",
      orderItemId: 71,
      warehouseLocationId: 2,
      quantity: "3",
      locationStrategy: "strict" as const,
      idempotencyKey: "pick:9:71:1",
      actor: "test-user",
      reason: "picker completed line",
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "8", revision: "2" }] };
      }
      if (text.includes("FROM inventory.availability_claims")) {
        return {
          rows: [{
            id: "9",
            claim_key: plan.requestKey,
            order_id: 70,
            revision: 1,
            status: "active",
            runtime_authority_revision: "2",
            plan_hash: hash(plan),
            plan_payload: plan,
          }],
        };
      }
      if (text.includes("FROM catalog.product_variants") && text.includes("product_id")) {
        return { rows: [{ id: 101, product_id: 10 }, { id: 105, product_id: 10 }] };
      }
      if (text.includes("pg_advisory_xact_lock") || text.includes("FROM inventory.transformation_model_heads")) {
        return { rows: [] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 70, warehouse_id: 1, warehouse_status: "ready" }] };
      }
      if (text.includes("FROM wms.order_items")) {
        return {
          rows: [{
            order_item_id: 71,
            sku: "P5",
            stored_product_id: 10,
            order_item_requires_shipping: 1,
            target_variant_id: 105,
            requested_qty: 3,
            root_product_id: 10,
            is_active: true,
            requires_shipping: true,
            track_inventory: true,
            sales_eligibility: "sellable",
          }],
        };
      }
      if (text.includes("FROM warehouse.warehouse_locations")) {
        return {
          rows: [{ warehouse_id: 1, is_active: 1, is_pickable: 1, cycle_count_freeze_id: null }],
        };
      }
      if (text.includes("FROM inventory.availability_claim_lines")) {
        return {
          rows: [{
            id: "20",
            order_item_id: 71,
            target_variant_id: 105,
            planned_qty: "3",
            released_target_qty: "0",
            consumed_target_qty: "0",
            picked_target_qty: "0",
          }],
        };
      }
      if (text.includes("FROM inventory.availability_claim_resources")) {
        return {
          rows: [{
            id: "12",
            inventory_level_id: 11,
            warehouse_id: 1,
            warehouse_location_id: 2,
            source_variant_id: 105,
            claimed_qty: "3",
            released_qty: "0",
            consumed_qty: "0",
            picked_qty: "0",
          }],
        };
      }
      if (text.includes("FROM inventory.availability_claim_lot_allocations")) {
        return {
          rows: [{
            id: "21",
            claim_resource_id: "12",
            inventory_lot_id: 51,
            claimed_qty: "3",
            released_qty: "0",
            consumed_qty: "0",
            picked_qty: "0",
            unit_cost_mills: "125",
            po_unit_cost_mills: "100",
            packaging_unit_cost_mills: "20",
            landed_unit_cost_mills: "5",
          }],
        };
      }
      if (text.startsWith("UPDATE inventory.availability_claim_lot_allocations")
        || text.startsWith("UPDATE inventory.availability_claim_resources")
        || text.startsWith("UPDATE inventory.availability_claim_lines")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO inventory.availability_claim_commands")) {
        return { rows: [{ id: "31" }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO inventory.availability_claim_pick_movements")
        || text.startsWith("INSERT INTO inventory.availability_claim_events")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    writer.pickResources.mockResolvedValue({
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
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.pickClaimLine(command)).resolves.toEqual({
      outcome: "picked",
      claimId: "9",
      claimLineId: "20",
      orderId: 70,
      orderItemId: 71,
      warehouseLocationIds: [2],
      quantity: "3",
      reconciledQuantity: "0",
      totalCostMills: "375",
      idempotentReplay: false,
    });

    expect(writer.pickResources).toHaveBeenCalledOnce();
    expect(fake.query.mock.calls.some(([text]) => String(text).startsWith("INSERT INTO inventory.availability_claim_pick_movements")))
      .toBe(true);
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("reverses the latest unreversed pick movement and restores an active reservation", async () => {
    const plan = packageClaimPlan();
    const command = {
      claimId: "9",
      orderItemId: 71,
      quantity: "2",
      idempotencyKey: "unpick:9:71:1",
      actor: "test-user",
      reason: "picker corrected quantity",
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "8", revision: "2" }] };
      }
      if (text.includes("FROM inventory.availability_claims")) {
        return {
          rows: [{
            id: "9",
            claim_key: plan.requestKey,
            order_id: 70,
            revision: 1,
            status: "active",
            runtime_authority_revision: "2",
            plan_hash: hash(plan),
            plan_payload: plan,
          }],
        };
      }
      if (text.includes("FROM catalog.product_variants") && text.includes("product_id")) {
        return { rows: [{ id: 101, product_id: 10 }, { id: 105, product_id: 10 }] };
      }
      if (text.includes("pg_advisory_xact_lock") || text.includes("FROM inventory.transformation_model_heads")) {
        return { rows: [] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 70, warehouse_id: 1, warehouse_status: "in_progress", on_hold: 0 }] };
      }
      if (text.includes("FROM wms.order_items")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_lines")) {
        return {
          rows: [{
            id: "20",
            order_item_id: 71,
            target_variant_id: 105,
            planned_qty: "3",
            released_target_qty: "0",
            consumed_target_qty: "0",
            picked_target_qty: "3",
          }],
        };
      }
      if (text.includes("FROM inventory.availability_claim_resources")) {
        return {
          rows: [{
            id: "12",
            inventory_level_id: 11,
            warehouse_id: 1,
            warehouse_location_id: 2,
            source_variant_id: 105,
            claimed_qty: "3",
            released_qty: "0",
            consumed_qty: "0",
            picked_qty: "3",
          }],
        };
      }
      if (text.includes("FROM inventory.availability_claim_lot_allocations")) {
        return {
          rows: [{
            id: "21",
            claim_resource_id: "12",
            inventory_lot_id: 51,
            claimed_qty: "3",
            released_qty: "0",
            consumed_qty: "0",
            picked_qty: "3",
            unit_cost_mills: "125",
            po_unit_cost_mills: "100",
            packaging_unit_cost_mills: "20",
            landed_unit_cost_mills: "5",
          }],
        };
      }
      if (text.includes("FROM inventory.availability_claim_pick_movements")) {
        return {
          rows: [{
            id: "31",
            claim_resource_id: "12",
            claim_lot_allocation_id: "21",
            inventory_lot_id: 51,
            movement_type: "pick",
            quantity: "3",
            reverses_pick_movement_id: null,
            inventory_level_id: 11,
            warehouse_location_id: 2,
            source_variant_id: 105,
            cost_order_id: 70,
            cost_order_item_id: 71,
            cost_inventory_lot_id: 51,
            cost_product_variant_id: 105,
            cost_qty: 3,
            unit_cost_mills: "125",
            total_cost_mills: "375",
          }],
        };
      }
      if (text.startsWith("UPDATE inventory.availability_claim_lot_allocations")
        || text.startsWith("UPDATE inventory.availability_claim_resources")
        || text.startsWith("UPDATE inventory.availability_claim_lines")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO inventory.availability_claim_commands")) {
        return { rows: [{ id: "41" }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO inventory.availability_claim_pick_movements")
        || text.startsWith("INSERT INTO inventory.availability_claim_events")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    writer.unpickResources.mockResolvedValue({
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
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.unpickClaimLine(command)).resolves.toEqual({
      outcome: "unpicked",
      claimId: "9",
      claimLineId: "20",
      orderId: 70,
      orderItemId: 71,
      warehouseLocationIds: [2],
      quantity: "2",
      reservationRestored: true,
      totalCostMills: "250",
      idempotentReplay: false,
    });
    expect(writer.unpickResources).toHaveBeenCalledWith(expect.objectContaining({ restoreReservation: true }));
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("rebinds claim ownership to a different pickable bin only through recorded stock", async () => {
    const plan = packageClaimPlan();
    let resourceRead = 0;
    let lotRead = 0;
    const command = {
      claimId: "9",
      orderItemId: 71,
      warehouseLocationId: 3,
      quantity: "3",
      locationStrategy: "reconcile_recorded_stock" as const,
      idempotencyKey: "pick:9:71:reconcile:1",
      actor: "test-user",
      reason: "picker used forward bin",
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "8", revision: "2" }] };
      }
      if (text.includes("FROM inventory.availability_claims")) {
        return {
          rows: [{
            id: "9",
            claim_key: plan.requestKey,
            order_id: 70,
            revision: 1,
            status: "active",
            runtime_authority_revision: "2",
            plan_hash: hash(plan),
            plan_payload: plan,
          }],
        };
      }
      if (text.includes("FROM catalog.product_variants") && text.includes("product_id")) {
        return { rows: [{ id: 101, product_id: 10 }, { id: 105, product_id: 10 }] };
      }
      if (text.includes("pg_advisory_xact_lock") || text.includes("FROM inventory.transformation_model_heads")) {
        return { rows: [] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 70, warehouse_id: 1, warehouse_status: "ready", on_hold: 0 }] };
      }
      if (text.includes("FROM wms.order_items")) {
        return {
          rows: [{
            order_item_id: 71,
            sku: "P5",
            stored_product_id: 10,
            order_item_requires_shipping: 1,
            target_variant_id: 105,
            requested_qty: 3,
            root_product_id: 10,
            is_active: true,
            requires_shipping: true,
            track_inventory: true,
            sales_eligibility: "sellable",
          }],
        };
      }
      if (text.includes("FROM warehouse.warehouse_locations AS location")) {
        return {
          rows: [{
            inventory_level_id: 15,
            warehouse_id: 1,
            is_active: 1,
            is_pickable: 1,
            cycle_count_freeze_id: null,
          }],
        };
      }
      if (text.includes("FROM warehouse.warehouse_locations")) {
        return {
          rows: [{ warehouse_id: 1, is_active: 1, is_pickable: 1, cycle_count_freeze_id: null }],
        };
      }
      if (text.includes("FROM inventory.availability_claim_lines")) {
        return {
          rows: [{
            id: "20",
            order_item_id: 71,
            target_variant_id: 105,
            planned_qty: "3",
            released_target_qty: "0",
            consumed_target_qty: "0",
            picked_target_qty: "0",
          }],
        };
      }
      if (text.includes("FROM inventory.availability_claim_resources")) {
        resourceRead += 1;
        return resourceRead === 1
          ? {
            rows: [{
              id: "12",
              inventory_level_id: 11,
              warehouse_id: 1,
              warehouse_location_id: 2,
              source_variant_id: 105,
              claimed_qty: "3",
              released_qty: "0",
              consumed_qty: "0",
              picked_qty: "0",
            }],
          }
          : {
            rows: [
              {
                id: "12",
                inventory_level_id: 11,
                warehouse_id: 1,
                warehouse_location_id: 2,
                source_variant_id: 105,
                claimed_qty: "3",
                released_qty: "3",
                consumed_qty: "0",
                picked_qty: "0",
              },
              {
                id: "13",
                inventory_level_id: 15,
                warehouse_id: 1,
                warehouse_location_id: 3,
                source_variant_id: 105,
                claimed_qty: "3",
                released_qty: "0",
                consumed_qty: "0",
                picked_qty: "0",
              },
            ],
          };
      }
      if (text.includes("FROM inventory.availability_claim_lot_allocations")) {
        lotRead += 1;
        return lotRead === 1
          ? {
            rows: [{
              id: "21",
              claim_resource_id: "12",
              inventory_lot_id: 51,
              claimed_qty: "3",
              released_qty: "0",
              consumed_qty: "0",
              picked_qty: "0",
              unit_cost_mills: "125",
              po_unit_cost_mills: "100",
              packaging_unit_cost_mills: "20",
              landed_unit_cost_mills: "5",
            }],
          }
          : {
            rows: [
              {
                id: "21",
                claim_resource_id: "12",
                inventory_lot_id: 51,
                claimed_qty: "3",
                released_qty: "3",
                consumed_qty: "0",
                picked_qty: "0",
                unit_cost_mills: "125",
                po_unit_cost_mills: "100",
                packaging_unit_cost_mills: "20",
                landed_unit_cost_mills: "5",
              },
              {
                id: "22",
                claim_resource_id: "13",
                inventory_lot_id: 52,
                claimed_qty: "3",
                released_qty: "0",
                consumed_qty: "0",
                picked_qty: "0",
                unit_cost_mills: "125",
                po_unit_cost_mills: "100",
                packaging_unit_cost_mills: "20",
                landed_unit_cost_mills: "5",
              },
            ],
          };
      }
      if (text.startsWith("INSERT INTO inventory.availability_claim_resources")) {
        return { rows: [{ id: "13" }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO inventory.availability_claim_lot_allocations")) {
        return { rows: [{ id: "22" }], rowCount: 1 };
      }
      if (text.startsWith("UPDATE inventory.availability_claim_lot_allocations")
        || text.startsWith("UPDATE inventory.availability_claim_resources")
        || text.startsWith("UPDATE inventory.availability_claim_lines")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO inventory.availability_claim_commands")) {
        return { rows: [{ id: "41" }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO inventory.availability_claim_pick_movements")
        || text.startsWith("INSERT INTO inventory.availability_claim_events")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    writer.reconcilePickResource.mockResolvedValue([{
      inventoryLotId: 52,
      qty: 3,
      unitCostMills: BigInt(125),
      poUnitCostMills: BigInt(100),
      packagingUnitCostMills: BigInt(20),
      landedUnitCostMills: BigInt(5),
    }]);
    writer.pickResources.mockResolvedValue({
      movements: [{
        claimResourceId: BigInt(13),
        claimLotAllocationId: BigInt(22),
        inventoryLotId: 52,
        quantity: BigInt(3),
        unitCostMills: BigInt(125),
        totalCostMills: BigInt(375),
        orderItemCostId: 81,
        reversesPickMovementId: null,
      }],
      totalCostMills: BigInt(375),
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.pickClaimLine(command)).resolves.toEqual(expect.objectContaining({
      outcome: "picked",
      warehouseLocationIds: [3],
      reconciledQuantity: "3",
    }));
    expect(writer.reconcilePickResource).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ warehouseLocationId: 3, claimedQty: 3 }),
    }));
    expect(writer.pickResources).toHaveBeenCalledWith(expect.objectContaining({
      resources: [expect.objectContaining({ claimResourceId: BigInt(13), warehouseLocationId: 3 })],
    }));
    const reconciliationEvent = fake.query.mock.calls.find(([text, values]) =>
      String(text).includes("claim_pick_location_reconciled") && String(values?.[1] ?? "").includes("claim_pick_location_reconciled"));
    expect(reconciliationEvent).toBeDefined();
  });

  it("atomically records a picker-observed shortage, review evidence, and the resulting pick", async () => {
    const plan = packageClaimPlan();
    let resourceRead = 0;
    let lotRead = 0;
    let targetAllocationId = 21;
    const command = {
      claimId: "9",
      orderItemId: 71,
      warehouseLocationId: 3,
      quantity: "3",
      locationStrategy: "reconcile_picker_observation" as const,
      observation: {
        kind: "validated_item_scan" as const,
        observedPhysicalQty: "3",
        locationCode: "P-3",
        deviceType: "scanner",
        sessionId: "session-1",
      },
      idempotencyKey: "pick:9:71:observation:1",
      actor: "test-user",
      reason: "picker found stock missing from the system",
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "8", revision: "2" }] };
      }
      if (text.includes("FROM inventory.availability_claims")) {
        return { rows: [{
          id: "9",
          claim_key: plan.requestKey,
          order_id: 70,
          revision: 1,
          status: "active",
          runtime_authority_revision: "2",
          plan_hash: hash(plan),
          plan_payload: plan,
        }] };
      }
      if (text.includes("FROM catalog.product_variants") && text.includes("product_id")) {
        return { rows: [{ id: 101, product_id: 10 }, { id: 105, product_id: 10 }] };
      }
      if (text.includes("pg_advisory_xact_lock") || text.includes("FROM inventory.transformation_model_heads")) {
        return { rows: [] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 70, warehouse_id: 1, warehouse_status: "ready", on_hold: 0 }] };
      }
      if (text.trimStart().startsWith("SELECT") && text.includes("FROM wms.order_items")) {
        return { rows: [{
          order_item_id: 71,
          sku: "P5",
          stored_product_id: 10,
          order_item_requires_shipping: 1,
          target_variant_id: 105,
          requested_qty: 3,
          root_product_id: 10,
          is_active: true,
          requires_shipping: true,
          track_inventory: true,
          sales_eligibility: "sellable",
        }] };
      }
      if (text.startsWith("INSERT INTO inventory.inventory_levels")) return { rows: [], rowCount: 1 };
      if (text.includes("FROM warehouse.warehouse_locations AS location")) {
        return { rows: [{
          inventory_level_id: 15,
          warehouse_id: 1,
          code: "P-3",
          is_active: 1,
          is_pickable: 1,
          cycle_count_freeze_id: null,
        }] };
      }
      if (text.includes("FROM warehouse.warehouse_locations")) {
        return { rows: [{ warehouse_id: 1, is_active: 1, is_pickable: 1, cycle_count_freeze_id: null }] };
      }
      if (text.includes("FROM inventory.availability_claim_lines")) {
        return { rows: [{
          id: "20",
          order_item_id: 71,
          target_variant_id: 105,
          planned_qty: "3",
          released_target_qty: "0",
          consumed_target_qty: "0",
          picked_target_qty: "0",
        }] };
      }
      if (text.includes("FROM inventory.availability_claim_resources")) {
        resourceRead += 1;
        return resourceRead === 1
          ? { rows: [{
              id: "12",
              inventory_level_id: 11,
              warehouse_id: 1,
              warehouse_location_id: 2,
              source_variant_id: 105,
              claimed_qty: "3",
              released_qty: "0",
              consumed_qty: "0",
              picked_qty: "0",
            }] }
          : { rows: [
              {
                id: "12",
                inventory_level_id: 11,
                warehouse_id: 1,
                warehouse_location_id: 2,
                source_variant_id: 105,
                claimed_qty: "3",
                released_qty: "3",
                consumed_qty: "0",
                picked_qty: "0",
              },
              {
                id: "13",
                inventory_level_id: 15,
                warehouse_id: 1,
                warehouse_location_id: 3,
                source_variant_id: 105,
                claimed_qty: "3",
                released_qty: "0",
                consumed_qty: "0",
                picked_qty: "0",
              },
            ] };
      }
      if (text.includes("FROM inventory.availability_claim_lot_allocations")) {
        lotRead += 1;
        return lotRead === 1
          ? { rows: [{
              id: "21",
              claim_resource_id: "12",
              inventory_lot_id: 51,
              claimed_qty: "3",
              released_qty: "0",
              consumed_qty: "0",
              picked_qty: "0",
              unit_cost_mills: "125",
              po_unit_cost_mills: "100",
              packaging_unit_cost_mills: "20",
              landed_unit_cost_mills: "5",
            }] }
          : { rows: [
              {
                id: "21",
                claim_resource_id: "12",
                inventory_lot_id: 51,
                claimed_qty: "3",
                released_qty: "3",
                consumed_qty: "0",
                picked_qty: "0",
                unit_cost_mills: "125",
                po_unit_cost_mills: "100",
                packaging_unit_cost_mills: "20",
                landed_unit_cost_mills: "5",
              },
              {
                id: "22",
                claim_resource_id: "13",
                inventory_lot_id: 52,
                claimed_qty: "1",
                released_qty: "0",
                consumed_qty: "0",
                picked_qty: "0",
                unit_cost_mills: "125",
                po_unit_cost_mills: "100",
                packaging_unit_cost_mills: "20",
                landed_unit_cost_mills: "5",
              },
              {
                id: "23",
                claim_resource_id: "13",
                inventory_lot_id: 53,
                claimed_qty: "2",
                released_qty: "0",
                consumed_qty: "0",
                picked_qty: "0",
                unit_cost_mills: "125",
                po_unit_cost_mills: "100",
                packaging_unit_cost_mills: "20",
                landed_unit_cost_mills: "5",
              },
            ] };
      }
      if (text.startsWith("INSERT INTO inventory.availability_claim_resources")) {
        return { rows: [{ id: "13" }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO inventory.availability_claim_lot_allocations")) {
        targetAllocationId += 1;
        return { rows: [{ id: String(targetAllocationId) }], rowCount: 1 };
      }
      if (text.startsWith("UPDATE inventory.availability_claim_lot_allocations")
        || text.startsWith("UPDATE inventory.availability_claim_resources")
        || text.startsWith("UPDATE inventory.availability_claim_lines")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO wms.allocation_exceptions")) {
        return { rows: [{ id: 88 }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO inventory.availability_claim_commands")) {
        return { rows: [{ id: "41" }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO inventory.availability_claim_pick_movements")
        || text.startsWith("INSERT INTO inventory.availability_claim_events")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    writer.ensureInventoryLevel.mockResolvedValue(15);
    writer.reconcileObservedPickResource.mockResolvedValue({
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
    writer.pickResources.mockResolvedValue({
      movements: [
        {
          claimResourceId: BigInt(13),
          claimLotAllocationId: BigInt(22),
          inventoryLotId: 52,
          quantity: BigInt(1),
          unitCostMills: BigInt(125),
          totalCostMills: BigInt(125),
          orderItemCostId: 81,
          reversesPickMovementId: null,
        },
        {
          claimResourceId: BigInt(13),
          claimLotAllocationId: BigInt(23),
          inventoryLotId: 53,
          quantity: BigInt(2),
          unitCostMills: BigInt(125),
          totalCostMills: BigInt(250),
          orderItemCostId: 82,
          reversesPickMovementId: null,
        },
      ],
      totalCostMills: BigInt(375),
    });
    const reviewWriter = { recordReview: vi.fn().mockResolvedValue(88) };
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      writer,
      fake.pool,
      () => FIXED_TIME,
      undefined,
      reviewWriter,
    );

    await expect(repository.pickClaimLine(command)).resolves.toEqual({
      outcome: "picked_with_observation",
      claimId: "9",
      claimLineId: "20",
      orderId: 70,
      orderItemId: 71,
      warehouseLocationIds: [3],
      quantity: "3",
      reconciledQuantity: "3",
      recordedReconciledQuantity: "1",
      observedRelocatedQuantity: "2",
      inventoryReviewId: 88,
      observationKind: "validated_item_scan",
      totalCostMills: "375",
      idempotentReplay: false,
    });
    expect(writer.reconcileObservedPickResource).toHaveBeenCalledWith(expect.objectContaining({
      observationReference: hash(command),
      target: expect.objectContaining({ claimedQty: 3, warehouseLocationId: 3 }),
    }));
    const calls = fake.query.mock.calls.map(([text, values]) => ({ text: String(text), values }));
    const commandIndex = calls.findIndex((call) => call.text.startsWith("INSERT INTO inventory.availability_claim_commands"));
    expect(reviewWriter.recordReview).toHaveBeenCalledWith(expect.objectContaining({
      client: expect.any(Object),
      orderId: 70,
      orderItemId: 71,
      requestedQty: 3,
      selectedLocationId: 3,
      metadata: expect.objectContaining({
        observedRelocatedQty: "2",
        relocatedInventoryLotIds: [53],
      }),
    }));
    expect(commandIndex).toBeGreaterThanOrEqual(0);
    expect(calls[commandIndex]?.values?.[2]).toBe("pick_observation");
    expect(calls.at(-1)?.text).toBe("COMMIT");
  });

  it("fails closed before operation execution when canonical authority is inactive", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "legacy", activation_run_id: null, revision: "1" }] };
      }
      if (text === "ROLLBACK") return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      writer,
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.executePackageOperation({
      claimId: "9",
      operationKey: "line:1:operation:1",
      idempotencyKey: "execute:9:1",
      actor: "test-user",
      reason: "unit test",
    })).rejects.toEqual(expect.objectContaining({ code: "CANONICAL_AUTHORITY_NOT_ACTIVE" }));

    expect(writer.executePackageOperation).not.toHaveBeenCalled();
    expect(fake.query.mock.calls.some(([text]) => String(text).includes("availability_claim_operations"))).toBe(false);
  });

  it("replays an exact operation execution receipt without touching inventory", async () => {
    const command = {
      claimId: "9",
      operationKey: "line:1:operation:1",
      idempotencyKey: "execute:9:1",
      actor: "test-user",
      reason: "unit test",
    };
    const persisted = {
      outcome: "executed",
      claimId: "9",
      claimOperationId: "10",
      operationKey: command.operationKey,
      outputResourceId: "13",
      producedQty: "4",
      committedQty: "3",
      surplusQty: "1",
      totalInputCostMills: "625",
      idempotentReplay: false,
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) {
        return { rows: [{ command_type: "execute", request_hash: hash(command), result_payload: persisted }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      writer,
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.executePackageOperation(command)).resolves.toEqual({
      ...persisted,
      idempotentReplay: true,
    });
    expect(writer.executePackageOperation).not.toHaveBeenCalled();
  });

  it("executes a hashed package operation and records exact output ownership atomically", async () => {
    const plan = packageClaimPlan();
    const command = {
      claimId: "9",
      operationKey: plan.operations[0].operationKey,
      idempotencyKey: "execute:9:1",
      actor: "test-user",
      reason: "unit test",
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "8", revision: "2" }] };
      }
      if (text.includes("FROM inventory.availability_claims")) {
        return {
          rows: [{
            id: "9",
            claim_key: plan.requestKey,
            order_id: 70,
            revision: 1,
            runtime_authority_revision: "2",
            plan_hash: hash(plan),
            plan_payload: plan,
          }],
        };
      }
      if (text.includes("FROM catalog.product_variants") && text.includes("product_id")) {
        return { rows: [{ id: 101, product_id: 10 }, { id: 105, product_id: 10 }] };
      }
      if (text.includes("pg_advisory_xact_lock") || text.includes("FROM inventory.transformation_model_heads")) {
        return { rows: [] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 70, warehouse_id: 1, warehouse_status: "ready" }] };
      }
      if (text.includes("FROM wms.order_items")) {
        return {
          rows: [{
            order_item_id: 71,
            sku: "P5",
            stored_product_id: 10,
            order_item_requires_shipping: 1,
            target_variant_id: 105,
            requested_qty: 3,
            root_product_id: 10,
            is_active: true,
            requires_shipping: true,
            track_inventory: true,
            sales_eligibility: "sellable",
          }],
        };
      }
      if (text.includes("JOIN inventory.availability_claim_lines AS line")) {
        return {
          rows: [{
            id: "10",
            claim_line_id: "20",
            order_item_id: 71,
            operation_key: command.operationKey,
            parent_operation_key: null,
            warehouse_id: 1,
            operation_type: "assemble_pack",
            authority_id: 7,
            destination_variant_id: 105,
            planned_executions: "1",
            output_qty: "4",
            committed_output_qty: "3",
            output_location_id: 3,
            status: "pending",
            executed_executions: "0",
            released_executions: "0",
          }],
        };
      }
      if (text.includes("parent_operation_key = $2")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_operation_inputs")) {
        return { rows: [{ source_variant_id: 101, required_qty: "5" }] };
      }
      if (text.includes("FROM inventory.availability_claim_resources")) {
        return {
          rows: [{
            id: "12",
            claim_line_id: "20",
            warehouse_id: 1,
            warehouse_location_id: 2,
            inventory_level_id: 11,
            source_variant_id: 101,
            claimed_qty: "5",
            released_qty: "0",
            consumed_qty: "0",
          }],
        };
      }
      if (text.includes("FROM inventory.availability_claim_lot_allocations")) {
        return {
          rows: [{
            id: "21",
            claim_resource_id: "12",
            inventory_lot_id: 51,
            claimed_qty: "5",
            released_qty: "0",
            consumed_qty: "0",
            unit_cost_mills: "125",
            po_unit_cost_mills: "100",
            packaging_unit_cost_mills: "20",
            landed_unit_cost_mills: "5",
          }],
        };
      }
      if (text.startsWith("UPDATE inventory.availability_claim_lot_allocations")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.availability_claim_resources")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.availability_claim_resources")) {
        return { rows: [{ id: "13" }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO inventory.availability_claim_lot_allocations")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.availability_claim_operations")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.availability_claim_commands")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.availability_claim_events")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    writer.executePackageOperation.mockResolvedValue({
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
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      writer,
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.executePackageOperation(command)).resolves.toEqual({
      outcome: "executed",
      claimId: "9",
      claimOperationId: "10",
      operationKey: command.operationKey,
      outputResourceId: "13",
      producedQty: "4",
      committedQty: "3",
      surplusQty: "1",
      totalInputCostMills: "625",
      idempotentReplay: false,
    });
    expect(writer.executePackageOperation).toHaveBeenCalledOnce();
    expect(writer.executePackageOperation).toHaveBeenCalledWith(expect.objectContaining({
      claimId: BigInt(9),
      claimOperationId: BigInt(10),
      outputQty: BigInt(4),
      committedOutputQty: BigInt(3),
      resources: [expect.objectContaining({ claimResourceId: BigInt(12), consumeQty: BigInt(5) })],
    }));
    const outputResourceInsert = fake.query.mock.calls.find(([text]) =>
      String(text).startsWith("INSERT INTO inventory.availability_claim_resources"));
    expect(outputResourceInsert?.[1]).toEqual([
      "9", "20", null, command.operationKey, 1, 3, 12, 105, "3",
    ]);
  });

  it("hands exact claim-owned lots to one build order without a second reservation", async () => {
    const plan = buildClaimPlan();
    const command = {
      claimId: "9",
      operationKey: plan.operations[0].operationKey,
      idempotencyKey: "handoff-build:9:1",
      actor: "test-user",
      reason: "unit test",
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "8", revision: "2" }] };
      }
      if (text.includes("FROM inventory.availability_claims")) {
        return { rows: [{
          id: "9",
          claim_key: plan.requestKey,
          order_id: 70,
          revision: 1,
          runtime_authority_revision: "2",
          plan_hash: hash(plan),
          plan_payload: plan,
        }] };
      }
      if (text.includes("FROM catalog.product_variants") && text.includes("product_id")) {
        return { rows: [{ id: 101, product_id: 10 }, { id: 105, product_id: 10 }] };
      }
      if (text.includes("pg_advisory_xact_lock") || text.includes("FROM inventory.transformation_model_heads")) {
        return { rows: [] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 70, warehouse_id: 1, warehouse_status: "ready" }] };
      }
      if (text.includes("FROM wms.order_items")) {
        return { rows: [{
          order_item_id: 71,
          sku: "P5",
          stored_product_id: 10,
          order_item_requires_shipping: 1,
          target_variant_id: 105,
          requested_qty: 3,
          root_product_id: 10,
          is_active: true,
          requires_shipping: true,
          track_inventory: true,
          sales_eligibility: "sellable",
        }] };
      }
      if (text.includes("JOIN inventory.availability_claim_lines AS line")) {
        return { rows: [{
          id: "10",
          claim_line_id: "20",
          order_item_id: 71,
          operation_key: command.operationKey,
          parent_operation_key: null,
          warehouse_id: 1,
          operation_type: "component_build",
          authority_id: 7,
          destination_variant_id: 105,
          planned_executions: "1",
          output_qty: "3",
          committed_output_qty: "3",
          output_location_id: 3,
          status: "pending",
          executed_executions: "0",
          released_executions: "0",
        }] };
      }
      if (text.includes("parent_operation_key = $2")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_operation_inputs")) {
        return { rows: [{ source_variant_id: 101, required_qty: "5" }] };
      }
      if (text.includes("FROM inventory.availability_claim_resources")) {
        return { rows: [{
          id: "12",
          claim_line_id: "20",
          warehouse_id: 1,
          warehouse_location_id: 2,
          inventory_level_id: 11,
          source_variant_id: 101,
          claimed_qty: "5",
          released_qty: "0",
          consumed_qty: "0",
        }] };
      }
      if (text.includes("FROM inventory.availability_claim_lot_allocations")) {
        return { rows: [{
          id: "21",
          claim_resource_id: "12",
          inventory_lot_id: 51,
          claimed_qty: "5",
          released_qty: "0",
          consumed_qty: "0",
          unit_cost_mills: "125",
          po_unit_cost_mills: "100",
          packaging_unit_cost_mills: "20",
          landed_unit_cost_mills: "5",
        }] };
      }
      if (text.startsWith("INSERT INTO inventory.availability_claim_build_handoffs")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.availability_claim_operations")) return { rows: [{ id: "10" }], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.availability_claim_commands")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.availability_claim_events")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const inventoryWriter = createInventoryWriter();
    const buildWriter = {
      handoffOperation: vi.fn(async () => ({
        buildOrderId: 91,
        buildSystemNumber: "BLD-00000091",
        adoptedReservationQty: BigInt(5),
      })),
    };
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      inventoryWriter,
      fake.pool,
      () => FIXED_TIME,
      buildWriter,
    );

    await expect(repository.handoffBuildOperation(command)).resolves.toEqual({
      outcome: "build_handed_off",
      claimId: "9",
      claimOperationId: "10",
      operationKey: command.operationKey,
      buildOrderId: 91,
      buildSystemNumber: "BLD-00000091",
      adoptedReservationQty: "5",
      idempotentReplay: false,
    });
    expect(buildWriter.handoffOperation).toHaveBeenCalledWith(expect.objectContaining({
      claimId: BigInt(9),
      claimOperationId: BigInt(10),
      plannedBuilds: BigInt(1),
      transformationRecipeBindingId: 7,
      resources: [expect.objectContaining({ claimResourceId: BigInt(12), consumeQty: BigInt(5) })],
    }));
  });

  it("replays an exact build handoff receipt without touching build or inventory writers", async () => {
    const command = {
      claimId: "9",
      operationKey: "order-item:71:warehouse:1:binding:7:operation:1",
      idempotencyKey: "handoff-build:9:1",
      actor: "test-user",
      reason: "unit test",
    };
    const persisted = {
      outcome: "build_handed_off" as const,
      claimId: "9",
      claimOperationId: "10",
      operationKey: command.operationKey,
      buildOrderId: 91,
      buildSystemNumber: "BLD-00000091",
      adoptedReservationQty: "5",
      idempotentReplay: false,
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) {
        return { rows: [{ command_type: "handoff_build", request_hash: hash(command), result_payload: persisted }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const inventoryWriter = createInventoryWriter();
    const buildWriter = { handoffOperation: vi.fn() };
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      inventoryWriter,
      fake.pool,
      () => FIXED_TIME,
      buildWriter,
    );

    await expect(repository.handoffBuildOperation(command)).resolves.toEqual({
      ...persisted,
      idempotentReplay: true,
    });
    expect(buildWriter.handoffOperation).not.toHaveBeenCalled();
    expect(inventoryWriter.reserveResource).not.toHaveBeenCalled();
    expect(inventoryWriter.executePackageOperation).not.toHaveBeenCalled();
  });

  it("executes a handed-off claim build and records its output ownership atomically", async () => {
    const plan = buildClaimPlan();
    const command = {
      claimId: "9",
      operationKey: plan.operations[0].operationKey,
      idempotencyKey: "execute-build:9:1",
      actor: "test-user",
      reason: "unit test build execution",
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "8", revision: "2" }] };
      }
      if (text.includes("FROM inventory.availability_claims")) {
        return { rows: [{
          id: "9",
          claim_key: plan.requestKey,
          order_id: 70,
          revision: 1,
          runtime_authority_revision: "2",
          plan_hash: hash(plan),
          plan_payload: plan,
        }] };
      }
      if (text.includes("FROM catalog.product_variants") && text.includes("product_id")) {
        return { rows: [{ id: 101, product_id: 10 }, { id: 105, product_id: 10 }] };
      }
      if (text.includes("pg_advisory_xact_lock") || text.includes("FROM inventory.transformation_model_heads")) {
        return { rows: [] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 70, warehouse_id: 1, warehouse_status: "ready" }] };
      }
      if (text.includes("FROM wms.order_items")) {
        return { rows: [{
          order_item_id: 71,
          sku: "P5",
          stored_product_id: 10,
          order_item_requires_shipping: 1,
          target_variant_id: 105,
          requested_qty: 3,
          root_product_id: 10,
          is_active: true,
          requires_shipping: true,
          track_inventory: true,
          sales_eligibility: "sellable",
        }] };
      }
      if (text.includes("JOIN inventory.availability_claim_build_handoffs AS handoff")) {
        return { rows: [{
          id: "10",
          claim_line_id: "20",
          order_item_id: 71,
          operation_key: command.operationKey,
          parent_operation_key: null,
          warehouse_id: 1,
          operation_type: "component_build",
          authority_id: 7,
          destination_variant_id: 105,
          planned_executions: "1",
          output_qty: "3",
          committed_output_qty: "3",
          output_location_id: 3,
          status: "executing",
          executed_executions: "0",
          released_executions: "0",
          handoff_id: "30",
          build_order_id: 91,
          adopted_reservation_qty: "5",
          handoff_status: "handed_off",
        }] };
      }
      if (text.includes("parent_operation_key = $2")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_operation_inputs")) {
        return { rows: [{ source_variant_id: 101, required_qty: "5" }] };
      }
      if (text.includes("FROM inventory.availability_claim_resources")) {
        return { rows: [{
          id: "12",
          claim_line_id: "20",
          warehouse_id: 1,
          warehouse_location_id: 2,
          inventory_level_id: 11,
          source_variant_id: 101,
          claimed_qty: "5",
          released_qty: "0",
          consumed_qty: "0",
        }] };
      }
      if (text.includes("FROM inventory.availability_claim_lot_allocations")) {
        return { rows: [{
          id: "21",
          claim_resource_id: "12",
          inventory_lot_id: 51,
          claimed_qty: "5",
          released_qty: "0",
          consumed_qty: "0",
          unit_cost_mills: "125",
          po_unit_cost_mills: "100",
          packaging_unit_cost_mills: "20",
          landed_unit_cost_mills: "5",
        }] };
      }
      if (text.startsWith("UPDATE inventory.availability_claim_lot_allocations")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.availability_claim_resources")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.availability_claim_resources")) return { rows: [{ id: "13" }], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.availability_claim_lot_allocations")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.availability_claim_operations")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.availability_claim_build_handoffs")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.availability_claim_commands")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.availability_claim_events")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const buildWriter = {
      handoffOperation: vi.fn(),
      cancelOperation: vi.fn(),
      executeOperation: vi.fn(async () => ({
        buildOrderId: 91,
        buildRunId: 92,
        buildSystemNumber: "BLD-00000091",
        outputInventoryLevelId: 12,
        committedLotAllocations: [{
          inventoryLotId: 61,
          qty: 3,
          unitCostMills: BigInt(208),
          poUnitCostMills: BigInt(166),
          packagingUnitCostMills: BigInt(33),
          landedUnitCostMills: BigInt(9),
        }],
        totalInputCostMills: BigInt(625),
      })),
    };
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
      buildWriter,
    );

    await expect(repository.executeBuildOperation(command)).resolves.toEqual({
      outcome: "executed",
      claimId: "9",
      claimOperationId: "10",
      operationKey: command.operationKey,
      outputResourceId: "13",
      producedQty: "3",
      committedQty: "3",
      surplusQty: "0",
      totalInputCostMills: "625",
      idempotentReplay: false,
    });
    expect(buildWriter.executeOperation).toHaveBeenCalledWith(expect.objectContaining({
      claimId: BigInt(9),
      claimOperationId: BigInt(10),
      buildOrderId: 91,
      plannedBuilds: BigInt(1),
      committedOutputQty: BigInt(3),
    }));
    const commandInsert = fake.query.mock.calls.find(([text]) =>
      String(text).startsWith("INSERT INTO inventory.availability_claim_commands"));
    expect(commandInsert?.[1]?.[2]).toBe("execute_build");
  });

  it("cancels unexecuted build handoffs before releasing their claim-owned inventory", async () => {
    const plan = buildClaimPlan();
    const command = {
      orderId: 70,
      disposition: "cancel" as const,
      idempotencyKey: "cancel-claim:70",
      actor: "test-user",
      reason: "order cancelled",
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "8", revision: "2" }] };
      }
      if (text.includes("FROM inventory.availability_claims")) {
        return { rows: [{ id: "9", claim_key: plan.requestKey, order_id: 70, revision: 1, runtime_authority_revision: "2", plan_hash: hash(plan), plan_payload: plan }] };
      }
      if (text.includes("FROM catalog.product_variants") && text.includes("product_id")) {
        return { rows: [{ id: 101, product_id: 10 }, { id: 105, product_id: 10 }] };
      }
      if (text.includes("pg_advisory_xact_lock") || text.includes("FROM inventory.transformation_model_heads")) return { rows: [] };
      if (text.includes("FROM wms.orders")) return { rows: [{ order_id: 70, warehouse_id: 1, warehouse_status: "cancelled" }] };
      if (text.includes("FROM wms.order_items")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_build_handoffs AS handoff")) {
        return { rows: [{
          id: "30",
          claim_operation_id: "10",
          build_order_id: 91,
          adopted_reservation_qty: "5",
          status: "handed_off",
          operation_key: plan.operations[0].operationKey,
          operation_status: "executing",
          executed_executions: "0",
          released_executions: "0",
        }] };
      }
      if (text.includes("FROM inventory.availability_claim_resources AS resource")) {
        return { rows: [{
          id: "12",
          claim_line_id: "20",
          inventory_level_id: 11,
          warehouse_location_id: 2,
          source_variant_id: 101,
          claimed_qty: "5",
          released_qty: "0",
          consumed_qty: "0",
          order_item_id: 71,
        }] };
      }
      if (text.includes("FROM inventory.availability_claim_lot_allocations AS allocation")) {
        return { rows: [{ id: "21", claim_resource_id: "12", inventory_lot_id: 51, claimed_qty: "5", released_qty: "0", consumed_qty: "0" }] };
      }
      if (text.startsWith("UPDATE inventory.availability_claim_build_handoffs")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.availability_claim_lot_allocations")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.availability_claim_resources")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.availability_claim_lines")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.availability_claim_operations")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.availability_claims")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.availability_claim_commands")) return { rows: [], rowCount: 1 };
      if (text.startsWith("INSERT INTO inventory.availability_claim_events")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const inventoryWriter = createInventoryWriter();
    const buildWriter = {
      handoffOperation: vi.fn(),
      executeOperation: vi.fn(),
      cancelOperation: vi.fn(async () => ({
        buildOrderId: 91,
        buildSystemNumber: "BLD-00000091",
        releasedReservationQty: BigInt(5),
      })),
    };
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      inventoryWriter,
      fake.pool,
      () => FIXED_TIME,
      buildWriter,
    );

    await expect(repository.releaseOrderClaim(command)).resolves.toEqual({
      outcome: "released",
      claimId: "9",
      claimKey: plan.requestKey,
      orderId: 70,
      status: "cancelled",
      releasedResourceQty: "5",
      releasedLotQty: "5",
      idempotentReplay: false,
    });
    expect(buildWriter.cancelOperation).toHaveBeenCalledWith(expect.objectContaining({
      claimId: BigInt(9),
      claimOperationId: BigInt(10),
      buildOrderId: 91,
      expectedReservationQty: BigInt(5),
    }));
    expect(inventoryWriter.releaseResources).toHaveBeenCalledWith(expect.objectContaining({
      claimId: BigInt(9),
      resources: [expect.objectContaining({ claimResourceId: BigInt(12), releaseQty: BigInt(5) })],
    }));
  });

  it("releases the exact active claim when the locked order has no claimable demand", async () => {
    const fake = createClaimReplacementPool(directClaimPlan(), { currentRequestedQty: 0 });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      writer,
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.releaseOrderClaim({
      orderId: 70,
      disposition: "release",
      expectedClaimId: "9",
      expectedWarehouseStatus: "ready",
      requireNoClaimableDemand: true,
      idempotencyKey: "demand-reconcile:70:empty",
      actor: "oms-order-sync",
      reason: "all physical order lines were removed",
    })).resolves.toMatchObject({
      outcome: "released",
      claimId: "9",
      orderId: 70,
      status: "released",
      releasedResourceQty: "3",
      releasedLotQty: "3",
      idempotentReplay: false,
    });
    expect(writer.releaseResources).toHaveBeenCalledOnce();
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("rejects a guarded release when locked claimable demand still exists", async () => {
    const fake = createClaimReplacementPool(directClaimPlan(), { currentRequestedQty: 2 });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      writer,
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.releaseOrderClaim({
      orderId: 70,
      disposition: "release",
      expectedClaimId: "9",
      expectedWarehouseStatus: "ready",
      requireNoClaimableDemand: true,
      idempotencyKey: "demand-reconcile:70:nonempty",
      actor: "oms-order-sync",
      reason: "attempt zero-demand release",
    })).rejects.toMatchObject({
      code: "ORDER_STILL_HAS_CLAIMABLE_DEMAND",
      context: expect.objectContaining({
        orderId: 70,
        expectedClaimId: "9",
        claimableLineCount: 1,
      }),
    });
    expect(writer.releaseResources).not.toHaveBeenCalled();
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("rejects a guarded release when the locked order status changed", async () => {
    const fake = createClaimReplacementPool(directClaimPlan(), { currentRequestedQty: 0 });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      writer,
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.releaseOrderClaim({
      orderId: 70,
      disposition: "release",
      expectedClaimId: "9",
      expectedWarehouseStatus: "packing",
      requireNoClaimableDemand: true,
      idempotencyKey: "demand-reconcile:70:status-race",
      actor: "oms-order-sync",
      reason: "all physical order lines were removed",
    })).rejects.toMatchObject({
      code: "ORDER_WAREHOUSE_STATUS_CHANGED",
      context: expect.objectContaining({
        expectedWarehouseStatus: "packing",
        lockedWarehouseStatus: "ready",
      }),
    });
    expect(writer.releaseResources).not.toHaveBeenCalled();
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("rejects a release when the active claim is not the expected target", async () => {
    const fake = createClaimReplacementPool();
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      writer,
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.releaseOrderClaim({
      orderId: 70,
      disposition: "release",
      expectedClaimId: "10",
      idempotencyKey: "demand-reconcile:70:stale-claim",
      actor: "oms-order-sync",
      reason: "stale demand event",
    })).rejects.toMatchObject({
      code: "ACTIVE_CLAIM_CHANGED",
      context: expect.objectContaining({
        orderId: 70,
        expectedClaimId: "10",
        activeClaimId: "9",
      }),
    });
    expect(writer.releaseResources).not.toHaveBeenCalled();
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("rejects reuse of a package-execution receipt as a build-handoff receipt", async () => {
    const command = {
      claimId: "9",
      operationKey: "order-item:71:warehouse:1:binding:7:operation:1",
      idempotencyKey: "shared-operation-key",
      actor: "test-user",
      reason: "unit test",
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) {
        return { rows: [{ command_type: "execute", request_hash: hash(command), result_payload: {} }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
      { handoffOperation: vi.fn() },
    );

    await expect(repository.handoffBuildOperation(command)).rejects.toEqual(expect.objectContaining({
      code: "IDEMPOTENCY_KEY_REUSED",
    }));
  });

  it("replays an exact claim replacement receipt without releasing or reserving inventory", async () => {
    const command = {
      orderId: 70,
      expectedClaimId: "9",
      idempotencyKey: "replace:70:9:2",
      actor: "test-user",
      reason: "accepted order quantity changed",
    };
    const persisted = {
      outcome: "replaced" as const,
      orderId: 70,
      supersededClaimId: "9",
      supersededClaimKey: "order:70:availability:revision:1",
      supersededRevision: 1,
      replacementClaim: {
        claimId: "10",
        claimKey: "order:70:availability:revision:2",
        revision: 2,
        runtimeAuthorityRevision: "2",
        plan: directClaimPlan(2, 2),
      },
      releasedResourceQty: "3",
      releasedLotQty: "3",
      idempotentReplay: false,
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) {
        return { rows: [{ command_type: "replace", request_hash: hash(command), result_payload: persisted }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.replaceOrderClaim(command)).resolves.toEqual({
      ...persisted,
      idempotentReplay: true,
    });
    expect(writer.releaseResources).not.toHaveBeenCalled();
    expect(writer.reserveResource).not.toHaveBeenCalled();
  });

  it("fails closed before reading an order when claim replacement authority is inactive", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "legacy", activation_run_id: null, revision: "1" }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.replaceOrderClaim({
      orderId: 70,
      expectedClaimId: "9",
      idempotencyKey: "replace:70:9:2",
      actor: "test-user",
      reason: "accepted order quantity changed",
    })).rejects.toEqual(expect.objectContaining({ code: "CANONICAL_AUTHORITY_NOT_ACTIVE" }));
    expect(fake.query.mock.calls.some(([text]) => String(text).includes("FROM wms.orders"))).toBe(false);
    expect(writer.releaseResources).not.toHaveBeenCalled();
  });

  it("rejects claim replacement when the expected predecessor is no longer active", async () => {
    const plan = directClaimPlan();
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "8", revision: "2" }] };
      }
      if (text.includes("FROM inventory.availability_claims")) {
        return { rows: [{
          id: "10",
          claim_key: plan.requestKey,
          order_id: 70,
          revision: 1,
          runtime_authority_revision: "2",
          plan_hash: hash(plan),
          plan_payload: plan,
        }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.replaceOrderClaim({
      orderId: 70,
      expectedClaimId: "9",
      idempotencyKey: "replace:70:9:2",
      actor: "test-user",
      reason: "accepted order quantity changed",
    })).rejects.toEqual(expect.objectContaining({
      code: "ACTIVE_CLAIM_CHANGED",
      context: expect.objectContaining({ expectedClaimId: "9", activeClaimId: "10" }),
    }));
    expect(writer.releaseResources).not.toHaveBeenCalled();
  });

  it("atomically supersedes, replans, and reserves changed accepted-order demand after a partial pick", async () => {
    const fake = createClaimReplacementPool(directClaimPlan(), {
      currentRequestedQty: 1,
      pickedTargetQty: "1",
    });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    const result = await repository.replaceOrderClaim({
      orderId: 70,
      expectedClaimId: "9",
      idempotencyKey: "replace:70:9:2",
      actor: "test-user",
      reason: "accepted order quantity changed from three to two after one pick",
    });

    expect(result).toMatchObject({
      outcome: "replaced",
      orderId: 70,
      supersededClaimId: "9",
      supersededRevision: 1,
      replacementClaim: {
        claimId: "10",
        claimKey: "order:70:availability:revision:2",
        revision: 2,
        runtimeAuthorityRevision: "2",
        plan: {
          lines: [{ lineKey: "order-item:71", requestedQty: "1", plannedQty: "1" }],
          resourceClaims: [{ claimedQty: "1", inventoryLevelId: 1 }],
        },
      },
      releasedResourceQty: "2",
      releasedLotQty: "2",
      idempotentReplay: false,
    });
    expect(fake.getSnapshotInventoryReads()).toBe(2);
    expect(writer.releaseResources).toHaveBeenCalledWith(expect.objectContaining({
      claimId: BigInt(9),
      resources: [expect.objectContaining({ claimResourceId: BigInt(12), releaseQty: BigInt(2) })],
    }));
    expect(writer.reserveResource).toHaveBeenCalledWith(expect.objectContaining({
      claimId: BigInt(10),
      claimedQty: 1,
    }));
    expect(writer.releaseResources.mock.invocationCallOrder[0])
      .toBeLessThan(writer.reserveResource.mock.invocationCallOrder[0]!);

    const replacementHeader = fake.query.mock.calls.find(([text]) =>
      String(text).startsWith("INSERT INTO inventory.availability_claims"));
    expect(replacementHeader?.[1]?.[3]).toBe("9");
    const replacementReceipt = fake.query.mock.calls.find(([text]) =>
      String(text).startsWith("INSERT INTO inventory.availability_claim_commands"));
    expect(String(replacementReceipt?.[0])).toContain("'replace'");
    expect(fake.query.mock.calls.filter(([text]) =>
      String(text).startsWith("INSERT INTO inventory.availability_claim_events"))).toHaveLength(2);
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("does not replace a claim merely because its picked quantity reduced remaining order demand", async () => {
    const fake = createClaimReplacementPool(directClaimPlan(), { pickedTargetQty: "1" });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.replaceOrderClaim({
      orderId: 70,
      expectedClaimId: "9",
      idempotencyKey: "replace:70:9:2",
      actor: "test-user",
      reason: "verify accepted order demand",
    })).rejects.toEqual(expect.objectContaining({ code: "ORDER_DEMAND_UNCHANGED" }));

    expect(writer.releaseResources).not.toHaveBeenCalled();
    expect(writer.reserveResource).not.toHaveBeenCalled();
    expect(fake.query.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("replays the active claim when a pick reduced order and claim remaining demand equally", async () => {
    const plan = directClaimPlan();
    const fake = createClaimReplacementPool(plan, {
      currentRequestedQty: 2,
      pickedTargetQty: "1",
    });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.claimOrder({
      orderId: 70,
      idempotencyKey: "claim:70:after-pick",
      actor: "test-user",
      reason: "retry accepted order claim after normal pick progress",
    })).resolves.toEqual({
      outcome: "claimed",
      claimId: "9",
      claimKey: plan.requestKey,
      orderId: 70,
      revision: 1,
      runtimeAuthorityRevision: "2",
      plan,
      idempotentReplay: false,
    });

    expect(writer.releaseResources).not.toHaveBeenCalled();
    expect(writer.reserveResource).not.toHaveBeenCalled();
    expect(fake.query.mock.calls.some(([text]) => text === "COMMIT")).toBe(true);
  });

  it("rolls back the released predecessor when replacement reservation fails", async () => {
    const fake = createClaimReplacementPool();
    const writer = createInventoryWriter();
    writer.reserveResource.mockRejectedValueOnce(Object.assign(new Error("replacement stock moved"), {
      code: "CLAIM_RESOURCE_CONFLICT",
    }));
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.replaceOrderClaim({
      orderId: 70,
      expectedClaimId: "9",
      idempotencyKey: "replace:70:9:2",
      actor: "test-user",
      reason: "accepted order quantity changed from three to two",
    })).rejects.toThrow("replacement stock moved");

    expect(writer.releaseResources).toHaveBeenCalledOnce();
    expect(fake.query.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(fake.query.mock.calls.some(([text]) => text === "COMMIT")).toBe(false);
    expect(fake.query.mock.calls.some(([text]) =>
      String(text).startsWith("INSERT INTO inventory.availability_claim_commands"))).toBe(false);
  });

  it("fails closed before reading or mutating order inventory when canonical authority is inactive", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "legacy", activation_run_id: null, revision: "1" }] };
      }
      if (text === "ROLLBACK") return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.claimOrder({
      orderId: 41,
      idempotencyKey: "claim:41",
      actor: "test-user",
      reason: "unit test",
    })).rejects.toEqual(expect.objectContaining<Partial<InventoryAvailabilityClaimRepositoryError>>({
      code: "CANONICAL_AUTHORITY_NOT_ACTIVE",
    }));

    expect(fake.query.mock.calls.some(([text]) => String(text).includes("FROM wms.orders"))).toBe(false);
    expect(fake.query.mock.calls.some(([text]) => /^\s*(INSERT|UPDATE)\s+inventory\.inventory_/i.test(String(text)))).toBe(false);
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("returns the persisted command result without replanning or writing on exact idempotent replay", async () => {
    const command = {
      orderId: 42,
      idempotencyKey: "claim:42",
      actor: "test-user",
      reason: "unit test",
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) {
        return {
          rows: [{
            request_hash: hash(command),
            result_payload: { outcome: "no_claim_required", orderId: 42, idempotentReplay: false },
          }],
        };
      }
      if (text === "COMMIT") return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.claimOrder(command)).resolves.toEqual({
      outcome: "no_claim_required",
      orderId: 42,
      idempotentReplay: true,
    });
    expect(fake.query.mock.calls.some(([text]) => String(text).includes("runtime_authority"))).toBe(false);
  });

  it("retries an idempotency-key race and returns the concurrently committed receipt", async () => {
    const command = {
      orderId: 420,
      idempotencyKey: "claim:420",
      actor: "test-user",
      reason: "concurrent retry test",
    };
    let attempt = 0;
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN")) {
        attempt += 1;
        return { rows: [] };
      }
      if (text.includes("FROM inventory.availability_claim_commands")) {
        return attempt === 1
          ? { rows: [] }
          : {
              rows: [{
                request_hash: hash(command),
                result_payload: { outcome: "no_claim_required", orderId: 420, idempotentReplay: false },
              }],
            };
      }
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "9", revision: "2" }] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 420, warehouse_id: 1, warehouse_status: "ready" }] };
      }
      if (text.includes("FROM wms.order_items")) return { rows: [] };
      if (text.includes("INSERT INTO inventory.availability_claim_commands")) {
        throw Object.assign(new Error("duplicate idempotency key"), {
          code: "23505",
          constraint: "availability_claim_commands_idempotency_uq",
        });
      }
      if (text === "ROLLBACK" || text === "COMMIT") return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.claimOrder(command)).resolves.toEqual({
      outcome: "no_claim_required",
      orderId: 420,
      idempotentReplay: true,
    });
    expect(attempt).toBe(2);
  });

  it("records an inert no-op command for a physical order with no claimable lines", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "9", revision: "2" }] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 43, warehouse_id: 1, warehouse_status: "ready" }] };
      }
      if (text.includes("FROM wms.order_items")) return { rows: [] };
      if (text.includes("INSERT INTO inventory.availability_claim_commands")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.claimOrder({
      orderId: 43,
      idempotencyKey: "claim:43",
      actor: "test-user",
      reason: "digital-only order",
    })).resolves.toEqual({
      outcome: "no_claim_required",
      orderId: 43,
      idempotentReplay: false,
    });
    expect(fake.query.mock.calls.some(([text]) => String(text).includes("inventory.inventory_levels"))).toBe(false);
    expect(fake.query.mock.calls.some(([text]) => String(text).includes("inventory.inventory_lots"))).toBe(false);
  });

  it("excludes a digital order line before requiring any catalog inventory identity", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "9", revision: "2" }] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 45, warehouse_id: 1, warehouse_status: "ready" }] };
      }
      if (text.includes("FROM wms.order_items")) {
        return {
          rows: [{
            order_item_id: 451,
            sku: "DIGITAL-MEMBERSHIP",
            stored_product_id: null,
            order_item_requires_shipping: 0,
            target_variant_id: null,
            requested_qty: 1,
            root_product_id: null,
            is_active: null,
            requires_shipping: null,
            track_inventory: null,
            sales_eligibility: null,
          }],
        };
      }
      if (text.includes("INSERT INTO inventory.availability_claim_commands")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.claimOrder({
      orderId: 45,
      idempotencyKey: "claim:45",
      actor: "test-user",
      reason: "digital-only order",
    })).resolves.toEqual({
      outcome: "no_claim_required",
      orderId: 45,
      idempotentReplay: false,
    });
    expect(fake.query.mock.calls.some(([text]) => String(text).includes("WITH RECURSIVE graph"))).toBe(false);
  });

  it("fails closed when a stored order-item identity conflicts with its active SKU mapping", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "9", revision: "2" }] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 46, warehouse_id: 1, warehouse_status: "ready" }] };
      }
      if (text.includes("FROM wms.order_items")) {
        return {
          rows: [{
            order_item_id: 461,
            sku: "P5",
            stored_product_id: 999,
            order_item_requires_shipping: 1,
            target_variant_id: 101,
            requested_qty: 1,
            root_product_id: 10,
            is_active: true,
            requires_shipping: true,
            track_inventory: true,
            sales_eligibility: "sellable",
          }],
        };
      }
      if (text === "ROLLBACK") return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.claimOrder({
      orderId: 46,
      idempotencyKey: "claim:46",
      actor: "test-user",
      reason: "identity conflict test",
    })).rejects.toEqual(expect.objectContaining({ code: "ORDER_ITEM_VARIANT_IDENTITY_CONFLICT" }));
  });

  it("rejects an idempotency key reused with a different semantic request", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) {
        return {
          rows: [{
            request_hash: "a".repeat(64),
            result_payload: { outcome: "no_claim_required", orderId: 44, idempotentReplay: false },
          }],
        };
      }
      if (text === "ROLLBACK") return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.releaseOrderClaim({
      orderId: 44,
      disposition: "cancel",
      idempotencyKey: "reused-key",
      actor: "test-user",
      reason: "unit test",
    })).rejects.toEqual(expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }));
  });

  it("approves an unchanged cycle count without an inventory mutation", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "9", revision: "2" }] };
      }
      if (text.includes("FROM inventory.cycle_counts")) {
        return { rows: [{ id: 8, status: "in_progress" }] };
      }
      if (text.includes("FROM inventory.cycle_count_items")) {
        return { rows: [{
          id: 81,
          cycle_count_id: 8,
          warehouse_location_id: 2,
          product_variant_id: 101,
          counted_qty: 6,
          status: "variance",
          adjustment_transaction_id: null,
        }] };
      }
      if (text.includes("FROM inventory.inventory_levels")) {
        return { rows: [{ id: 11, variant_qty: 6, reserved_qty: 0 }] };
      }
      if (text.includes("FROM inventory.availability_claims")) return { rows: [] };
      if (text.startsWith("UPDATE inventory.cycle_count_items")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.reconcileCycleCount({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      reasonCode: "verified",
      actor: "user:7",
      reason: "verified physical count",
    })).resolves.toEqual({
      outcome: "cycle_count_reconciled",
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      quantityBefore: 6,
      quantityAfter: 6,
      quantityDelta: 0,
      adjustmentTransactionId: 900,
      displacedOrderIds: [],
      idempotentReplay: false,
    });
    expect(writer.applyCycleCountAdjustment).not.toHaveBeenCalled();
    expect(writer.recordCycleCountNoop).toHaveBeenCalledWith({
      client: expect.any(Object),
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      cycleCountId: 8,
      cycleCountItemId: 81,
      actor: "user:7",
      reason: "verified physical count",
      occurredAt: FIXED_TIME,
    });
    expect(writer.approveCycleCountItem).toHaveBeenCalledWith({
      client: expect.any(Object),
      cycleCountItemId: 81,
      expectedStatus: "variance",
      actor: "user:7",
      reasonCode: "verified",
      adjustmentTransactionId: 900,
      occurredAt: FIXED_TIME,
    });
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("replays exact cycle-count adjustment and displaced-order evidence", async () => {
    const fake = createPool(async (text, values) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "9", revision: "2" }] };
      }
      if (text.includes("FROM inventory.cycle_counts")) {
        return { rows: [{ id: 8, status: "completed" }] };
      }
      if (text.includes("FROM inventory.cycle_count_items")) {
        return { rows: [{
          id: 81,
          cycle_count_id: 8,
          warehouse_location_id: 2,
          product_variant_id: 101,
          counted_qty: 6,
          status: "approved",
          adjustment_transaction_id: 901,
        }] };
      }
      if (text.includes("FROM inventory.inventory_transactions")) {
        return { rows: [
          {
            id: 901,
            product_variant_id: 101,
            from_location_id: 2,
            to_location_id: null,
            transaction_type: "adjustment",
            variant_qty_before: 10,
            variant_qty_after: 8,
            variant_qty_delta: -2,
            cycle_count_id: 8,
            reference_type: "cycle_count_item",
            reference_id: "81",
          },
          {
            id: 902,
            product_variant_id: 101,
            from_location_id: 2,
            to_location_id: null,
            transaction_type: "adjustment",
            variant_qty_before: 8,
            variant_qty_after: 6,
            variant_qty_delta: -2,
            cycle_count_id: 8,
            reference_type: "cycle_count_item",
            reference_id: "81",
          },
        ] };
      }
      if (text.includes("SELECT DISTINCT order_id") && text.includes("availability_claim_commands")) {
        expect(values).toEqual(["cycle-count:8:81:claim:"]);
        return { rows: [{ order_id: 70 }, { order_id: 72 }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.reconcileCycleCount({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      reasonCode: "verified",
      actor: "user:7",
      reason: "retry verified physical count",
    })).resolves.toEqual({
      outcome: "cycle_count_reconciled",
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      quantityBefore: 10,
      quantityAfter: 6,
      quantityDelta: -4,
      adjustmentTransactionId: 901,
      displacedOrderIds: [70, 72],
      idempotentReplay: true,
    });
    expect(writer.applyCycleCountAdjustment).not.toHaveBeenCalled();
  });

  it("fails approved replay closed when no durable adjustment or no-op evidence exists", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "9", revision: "2" }] };
      }
      if (text.includes("FROM inventory.cycle_counts")) {
        return { rows: [{ id: 8, status: "completed" }] };
      }
      if (text.includes("FROM inventory.cycle_count_items")) {
        return { rows: [{
          id: 81,
          cycle_count_id: 8,
          warehouse_location_id: 2,
          product_variant_id: 101,
          counted_qty: 6,
          status: "approved",
          adjustment_transaction_id: null,
        }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.reconcileCycleCount({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      reasonCode: "verified",
      actor: "user:7",
      reason: "retry historical count",
    })).rejects.toEqual(expect.objectContaining({ code: "CYCLE_COUNT_REPLAY_EVIDENCE_MISSING" }));
    expect(writer.applyCycleCountAdjustment).not.toHaveBeenCalled();
  });

  it("refuses a new reconciliation after the parent count is completed", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "9", revision: "2" }] };
      }
      if (text.includes("FROM inventory.cycle_counts")) {
        return { rows: [{ id: 8, status: "completed" }] };
      }
      if (text.includes("FROM inventory.cycle_count_items")) {
        return { rows: [{
          id: 81,
          cycle_count_id: 8,
          warehouse_location_id: 2,
          product_variant_id: 101,
          counted_qty: 6,
          status: "variance",
          adjustment_transaction_id: null,
        }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.reconcileCycleCount({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      reasonCode: "verified",
      actor: "user:7",
      reason: "late approval",
    })).rejects.toEqual(expect.objectContaining({ code: "CYCLE_COUNT_NOT_IN_PROGRESS" }));
    expect(writer.applyCycleCountAdjustment).not.toHaveBeenCalled();
  });

  it("fails a cycle count closed before reading the item when canonical authority is inactive", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "legacy", activation_run_id: null, revision: "1" }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const writer = createInventoryWriter();
    const repository = new PostgresInventoryAvailabilityClaimRepository(writer, fake.pool, () => FIXED_TIME);

    await expect(repository.reconcileCycleCount({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 2,
      countedQty: 6,
      reasonCode: "verified",
      actor: "user:7",
      reason: "verified physical count",
    })).rejects.toEqual(expect.objectContaining({ code: "CANONICAL_AUTHORITY_NOT_ACTIVE" }));
    expect(fake.query.mock.calls.some(([text]) => String(text).includes("cycle_count_items"))).toBe(false);
    expect(writer.applyCycleCountAdjustment).not.toHaveBeenCalled();
  });
});
