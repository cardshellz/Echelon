import { describe, expect, it, vi } from "vitest";

import { PostgresCanonicalClaimBuildRepository } from "../../infrastructure/canonical-claim-build.repository";

const OCCURRED_AT = new Date("2026-09-02T18:00:00.000Z");
const MODEL_HASH = "a".repeat(64);
const RECIPE_HASH = "b".repeat(64);

describe("PostgresCanonicalClaimBuildRepository", () => {
  it("adopts exact multi-location claim lots without reserving physical inventory a second time", async () => {
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("FROM inventory.transformation_recipe_bindings")) {
        return { rows: [{
          id: 7,
          model_id: 6,
          recipe_id: 8,
          relationship_role: "component_build",
          warehouse_id: 1,
          recipe_code_snapshot: "ASSEMBLE-P5",
          recipe_version_snapshot: 2,
          recipe_definition_hash: RECIPE_HASH,
          output_product_id_snapshot: 50,
          output_variant_id_snapshot: 105,
          output_units_per_variant_snapshot: 5,
          output_qty_snapshot: 1,
          validation_state: "valid",
          validation_errors: [],
          model_product_id: 50,
          model_version: 3,
          model_lifecycle_status: "retired",
          model_validation_state: "valid",
          model_validation_errors: [],
          model_definition_hash: MODEL_HASH,
          recipe_type: "assembly",
          recipe_code: "ASSEMBLE-P5",
          recipe_version: 2,
          output_product_id: 50,
          output_variant_id: 105,
          output_units_per_variant: 5,
          output_qty: 1,
        }] };
      }
      if (text.includes("FROM warehouse.warehouse_locations")) return { rows: [{ id: 30 }] };
      if (text.includes("FROM inventory.transformation_recipe_component_snapshots")) {
        return { rows: [{
          component_variant_id: 101,
          component_product_id: 51,
          component_units_per_variant: 1,
          component_qty: 5,
          recipe_component_id: 81,
          recipe_component_qty: 5,
          recipe_component_product_id: 51,
          recipe_component_units_per_variant: 1,
        }] };
      }
      if (text.includes("FROM inventory.inventory_levels")) {
        return { rows: [
          { id: 11, product_variant_id: 101, warehouse_location_id: 21, warehouse_id: 1, variant_qty: 20, reserved_qty: 2 },
          { id: 12, product_variant_id: 101, warehouse_location_id: 22, warehouse_id: 1, variant_qty: 20, reserved_qty: 3 },
        ] };
      }
      if (text.includes("FROM inventory.availability_claims AS claim")) {
        return { rows: [{
          activation_run_id: "4",
          runtime_authority_revision: "5",
          authority: "canonical",
          current_activation_run_id: "4",
          current_authority_revision: "5",
        }] };
      }
      if (text.includes("FROM inventory.inventory_lots")) {
        return { rows: [
          { id: 51, product_variant_id: 101, warehouse_location_id: 21, qty_on_hand: 20, qty_reserved: 2, status: "active", total_unit_cost_mills: 125, po_unit_cost_mills: 100, packaging_cost_mills: 20, landed_cost_mills: 5 },
          { id: 52, product_variant_id: 101, warehouse_location_id: 22, qty_on_hand: 20, qty_reserved: 3, status: "active", total_unit_cost_mills: 125, po_unit_cost_mills: 100, packaging_cost_mills: 20, landed_cost_mills: 5 },
        ] };
      }
      if (text.startsWith("INSERT INTO inventory.build_orders")) {
        expect(values?.slice(14)).toEqual(["5", "4", 6, 3, MODEL_HASH, 7, RECIPE_HASH]);
        return { rows: [{ id: 91, system_number: "BLD-00000091" }] };
      }
      if (text.startsWith("INSERT INTO inventory.build_order_components")) {
        expect(values?.[7]).toBeNull();
        return { rows: [{ id: 92 }] };
      }
      if (text.startsWith("INSERT INTO inventory.build_component_reservations")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimBuildRepository();

    await expect(repository.handoffOperation({
      client: { query },
      claimId: BigInt(9),
      claimOperationId: BigInt(10),
      operationKey: "order-item:71:warehouse:1:binding:7:operation:1",
      transformationRecipeBindingId: 7,
      warehouseId: 1,
      plannedBuilds: BigInt(1),
      destinationVariantId: 105,
      outputLocationId: 30,
      outputQty: BigInt(1),
      inputs: [{ sourceVariantId: 101, requiredQty: BigInt(5) }],
      resources: [
        {
          claimResourceId: BigInt(12),
          inventoryLevelId: 11,
          warehouseLocationId: 21,
          sourceVariantId: 101,
          consumeQty: BigInt(2),
          lotAllocations: [{
            claimLotAllocationId: BigInt(61),
            inventoryLotId: 51,
            consumeQty: BigInt(2),
            unitCostMills: BigInt(125),
            poUnitCostMills: BigInt(100),
            packagingUnitCostMills: BigInt(20),
            landedUnitCostMills: BigInt(5),
          }],
        },
        {
          claimResourceId: BigInt(13),
          inventoryLevelId: 12,
          warehouseLocationId: 22,
          sourceVariantId: 101,
          consumeQty: BigInt(3),
          lotAllocations: [{
            claimLotAllocationId: BigInt(62),
            inventoryLotId: 52,
            consumeQty: BigInt(3),
            unitCostMills: BigInt(125),
            poUnitCostMills: BigInt(100),
            packagingUnitCostMills: BigInt(20),
            landedUnitCostMills: BigInt(5),
          }],
        },
      ],
      actor: "unit-test",
      occurredAt: OCCURRED_AT,
    })).resolves.toEqual({
      buildOrderId: 91,
      buildSystemNumber: "BLD-00000091",
      adoptedReservationQty: BigInt(5),
    });

    const allSql = query.mock.calls.map(([text]) => text).join("\n");
    expect(allSql).not.toMatch(/UPDATE\s+inventory\.inventory_(levels|lots)/i);
    expect(allSql).not.toMatch(/INSERT\s+INTO\s+inventory\.inventory_transactions/i);
    expect(allSql).not.toMatch(/recipe\.status\s*=\s*'active'/i);
    const reservationCalls = query.mock.calls.filter(([text]) =>
      text.startsWith("INSERT INTO inventory.build_component_reservations"));
    expect(reservationCalls).toHaveLength(2);
    expect(reservationCalls.map(([, values]) => values?.slice(3))).toEqual([
      ["9", "61"],
      ["9", "62"],
    ]);
  });

  it("posts one full claim-owned build run and preserves exact lot ownership", async () => {
    const inventoryWriter = {
      reserveResource: vi.fn(),
      releaseResources: vi.fn(),
      executePackageOperation: vi.fn(),
      executeBuildOperation: vi.fn(async () => ({
        outputInventoryLevelId: 31,
        committedLotAllocations: [{
          inventoryLotId: 71,
          qty: 1,
          unitCostMills: BigInt(625),
          poUnitCostMills: BigInt(500),
          packagingUnitCostMills: BigInt(100),
          landedUnitCostMills: BigInt(25),
        }],
        totalInputCostMills: BigInt(625),
      })),
    };
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM inventory.build_orders")) {
        return { rows: [{
          id: 91,
          system_number: "BLD-00000091",
          recipe_id: 8,
          recipe_code: "ASSEMBLE-P5",
          recipe_version: 2,
          recipe_type: "assembly",
          output_product_id: 50,
          output_variant_id: 105,
          output_units_per_variant: 5,
          output_qty_per_build: 1,
          planned_builds: 1,
          completed_builds: 0,
          warehouse_id: 1,
          output_location_id: 30,
          status: "released",
          total_component_cost_mills: null,
          transformation_authority: "canonical",
          transformation_authority_revision: "5",
          transformation_activation_run_id: "4",
          transformation_model_id: 6,
          transformation_model_version: 3,
          transformation_model_definition_hash: MODEL_HASH,
          transformation_recipe_binding_id: 7,
          transformation_recipe_definition_hash: RECIPE_HASH,
          transformation_authorized_at: OCCURRED_AT,
          transformation_authorized_by: "unit-test",
        }] };
      }
      if (text.includes("FROM inventory.availability_claim_build_handoffs AS handoff")) {
        return { rows: [{
          claim_id: "9",
          claim_operation_id: "10",
          operation_binding_id: 7,
          activation_run_id: "4",
          runtime_authority_revision: "5",
          runtime_authority: "canonical",
          current_activation_run_id: "4",
          current_authority_revision: "5",
          binding_model_id: 6,
          binding_recipe_id: 8,
          binding_relationship_role: "component_build",
          binding_warehouse_id: 1,
          recipe_code_snapshot: "ASSEMBLE-P5",
          recipe_version_snapshot: 2,
          recipe_definition_hash: RECIPE_HASH,
          output_product_id_snapshot: 50,
          output_variant_id_snapshot: 105,
          output_units_per_variant_snapshot: 5,
          output_qty_snapshot: 1,
          binding_validation_state: "valid",
          binding_validation_errors: [],
          model_product_id: 50,
          model_version: 3,
          model_definition_hash: MODEL_HASH,
          model_lifecycle_status: "retired",
          model_validation_state: "valid",
          model_validation_errors: [],
        }] };
      }
      if (text.includes("FROM inventory.build_order_components") && !text.includes("build_component_reservations")) {
        return { rows: [{
          id: 92,
          component_variant_id: 101,
          component_product_id: 51,
          component_units_per_variant: 1,
          qty_per_build: 5,
          planned_qty: 5,
          consumed_qty: 0,
          authorized_component_product_id: 51,
          authorized_component_units_per_variant: 1,
          authorized_component_qty: 5,
        }] };
      }
      if (text.includes("FROM inventory.build_component_reservations AS reservation")) {
        return { rows: [{
          id: 93,
          inventory_lot_id: 51,
          reserved_qty: 5,
          consumed_qty: 0,
          released_qty: 0,
          reservation_owner: "availability_claim",
          availability_claim_id: "9",
          availability_claim_lot_allocation_id: "61",
          build_order_component_id: 92,
          component_variant_id: 101,
        }] };
      }
      if (text.startsWith("INSERT INTO inventory.build_runs")) return { rows: [{ id: 94, run_number: 1 }] };
      if (text.startsWith("INSERT INTO inventory.build_run_consumptions")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.build_component_reservations")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.build_order_components")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.build_runs")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.build_orders")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimBuildRepository(inventoryWriter);
    const resource = {
      claimResourceId: BigInt(12),
      inventoryLevelId: 11,
      warehouseLocationId: 21,
      sourceVariantId: 101,
      consumeQty: BigInt(5),
      lotAllocations: [{
        claimLotAllocationId: BigInt(61),
        inventoryLotId: 51,
        consumeQty: BigInt(5),
        unitCostMills: BigInt(125),
        poUnitCostMills: BigInt(100),
        packagingUnitCostMills: BigInt(20),
        landedUnitCostMills: BigInt(5),
      }],
    };

    await expect(repository.executeOperation({
      client: { query },
      claimId: BigInt(9),
      claimOperationId: BigInt(10),
      operationKey: "order-item:71:warehouse:1:binding:7:operation:1",
      buildOrderId: 91,
      warehouseId: 1,
      plannedBuilds: BigInt(1),
      destinationVariantId: 105,
      outputLocationId: 30,
      outputQty: BigInt(1),
      committedOutputQty: BigInt(1),
      inputs: [{ sourceVariantId: 101, requiredQty: BigInt(5) }],
      resources: [resource],
      orderId: 70,
      orderItemId: 71,
      actor: "unit-test",
      reason: "execute claim build",
      occurredAt: OCCURRED_AT,
    })).resolves.toEqual({
      buildOrderId: 91,
      buildRunId: 94,
      buildSystemNumber: "BLD-00000091",
      outputInventoryLevelId: 31,
      committedLotAllocations: expect.any(Array),
      totalInputCostMills: BigInt(625),
    });
    expect(query.mock.calls[0][0]).toContain("pg_advisory_xact_lock");
    const orderRead = query.mock.calls.find(([text]) => text.includes("FROM inventory.build_orders"));
    expect(orderRead?.[0]).toContain("transformation_recipe_binding_id");
    expect(orderRead?.[0]).toContain("transformation_model_definition_hash");
    const componentRead = query.mock.calls.find(([text]) =>
      text.includes("FROM inventory.build_order_components AS component")
      && text.includes("transformation_recipe_component_snapshots"));
    expect(componentRead?.[1]).toEqual([91, 7, 6]);
    expect(inventoryWriter.executeBuildOperation).toHaveBeenCalledWith(expect.objectContaining({
      claimId: BigInt(9),
      claimOperationId: BigInt(10),
      build: expect.objectContaining({
        buildOrderId: 91,
        buildRunId: 94,
        components: [{ sourceVariantId: 101, buildOrderComponentId: 92 }],
      }),
    }));
    const reservationUpdate = query.mock.calls.find(([text]) =>
      text.startsWith("UPDATE inventory.build_component_reservations"));
    expect(reservationUpdate?.[1]).toEqual([5, "61", OCCURRED_AT]);
  });

  it("cancels an unexecuted handoff without independently unreserving physical inventory", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM inventory.build_orders")) {
        return { rows: [{ id: 91, system_number: "BLD-00000091", status: "released", completed_builds: 0 }] };
      }
      if (text.includes("FROM inventory.build_runs")) return { rows: [] };
      if (text.includes("FROM inventory.build_component_reservations AS reservation")) {
        return { rows: [
          { id: 93, reserved_qty: 2, consumed_qty: 0, released_qty: 0, reservation_owner: "availability_claim", availability_claim_id: "9", availability_claim_lot_allocation_id: "61" },
          { id: 94, reserved_qty: 3, consumed_qty: 0, released_qty: 0, reservation_owner: "availability_claim", availability_claim_id: "9", availability_claim_lot_allocation_id: "62" },
        ] };
      }
      if (text.startsWith("UPDATE inventory.build_component_reservations")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE inventory.build_orders")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresCanonicalClaimBuildRepository({
      reserveResource: vi.fn(),
      releaseResources: vi.fn(),
      executePackageOperation: vi.fn(),
      executeBuildOperation: vi.fn(),
    });

    await expect(repository.cancelOperation({
      client: { query },
      claimId: BigInt(9),
      claimOperationId: BigInt(10),
      buildOrderId: 91,
      expectedReservationQty: BigInt(5),
      actor: "unit-test",
      reason: "order cancelled",
      occurredAt: OCCURRED_AT,
    })).resolves.toEqual({
      buildOrderId: 91,
      buildSystemNumber: "BLD-00000091",
      releasedReservationQty: BigInt(5),
    });

    const allSql = query.mock.calls.map(([text]) => text).join("\n");
    expect(allSql).not.toMatch(/UPDATE\s+inventory\.inventory_(levels|lots)/i);
    expect(allSql).not.toMatch(/INSERT\s+INTO\s+inventory\.inventory_transactions/i);
  });
});
