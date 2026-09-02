import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { canonicalJson } from "@shared/utils/canonical-json";
import {
  InventoryAvailabilityClaimRepositoryError,
  PostgresInventoryAvailabilityClaimRepository,
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
    reserveResource: vi.fn(async () => []),
    releaseResources: vi.fn(async () => undefined),
    executePackageOperation: vi.fn(),
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

describe("PostgresInventoryAvailabilityClaimRepository", () => {
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
});
