import { describe, expect, it, vi } from "vitest";

import { PostgresCanonicalClaimBuildRepository } from "../../infrastructure/canonical-claim-build.repository";

const OCCURRED_AT = new Date("2026-09-02T18:00:00.000Z");

describe("PostgresCanonicalClaimBuildRepository", () => {
  it("adopts exact multi-location claim lots without reserving physical inventory a second time", async () => {
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("FROM inventory.transformation_recipe_bindings")) {
        return { rows: [{
          id: 7,
          recipe_id: 8,
          relationship_role: "component_build",
          warehouse_id: 1,
          recipe_code_snapshot: "ASSEMBLE-P5",
          recipe_version_snapshot: 2,
          output_product_id_snapshot: 50,
          output_variant_id_snapshot: 105,
          output_units_per_variant_snapshot: 5,
          output_qty_snapshot: 1,
          validation_state: "valid",
          recipe_status: "active",
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
      if (text.includes("FROM inventory.inventory_lots")) {
        return { rows: [
          { id: 51, product_variant_id: 101, warehouse_location_id: 21, qty_on_hand: 20, qty_reserved: 2, status: "active", total_unit_cost_mills: 125, po_unit_cost_mills: 100, packaging_cost_mills: 20, landed_cost_mills: 5 },
          { id: 52, product_variant_id: 101, warehouse_location_id: 22, qty_on_hand: 20, qty_reserved: 3, status: "active", total_unit_cost_mills: 125, po_unit_cost_mills: 100, packaging_cost_mills: 20, landed_cost_mills: 5 },
        ] };
      }
      if (text.startsWith("INSERT INTO inventory.build_orders")) {
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
    const reservationCalls = query.mock.calls.filter(([text]) =>
      text.startsWith("INSERT INTO inventory.build_component_reservations"));
    expect(reservationCalls).toHaveLength(2);
    expect(reservationCalls.map(([, values]) => values?.slice(3))).toEqual([
      ["9", "61"],
      ["9", "62"],
    ]);
  });
});
