import type {
  CanonicalClaimBuildCancellationResult,
  CanonicalClaimBuildExecutionResult,
  CanonicalClaimBuildMutationPort,
  CanonicalClaimBuildHandoffResult,
} from "../../inventory-planning/application/canonical-claim-build.port";
import type {
  CanonicalClaimInventoryExecutionResource,
  CanonicalClaimInventoryMutationPort,
} from "../../inventory-planning/application/canonical-claim-inventory.port";
import { BuildDomainError } from "../domain/build.domain";
import { PostgresCanonicalClaimInventoryRepository } from "./canonical-claim-inventory.repository";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

function rows(result: { rows: any[] }): any[] {
  return Array.isArray(result.rows) ? result.rows : [];
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > POSTGRES_INTEGER_MAX) {
    throw new BuildDomainError("INVALID_CLAIM_BUILD_EVIDENCE", `${field} must be a positive PostgreSQL integer`, {
      field,
      value: String(value),
    });
  }
  return parsed;
}

function positiveBigInt(value: unknown, field: string): bigint {
  try {
    const parsed = BigInt(String(value));
    if (parsed <= BigInt(0)) throw new Error("not positive");
    return parsed;
  } catch {
    throw new BuildDomainError("INVALID_CLAIM_BUILD_EVIDENCE", `${field} must be a positive bigint`, {
      field,
      value: String(value),
    });
  }
}

function asPostgresInteger(value: bigint, field: string): number {
  if (value <= BigInt(0) || value > BigInt(POSTGRES_INTEGER_MAX)) {
    throw new BuildDomainError("CLAIM_BUILD_QUANTITY_OUT_OF_RANGE", `${field} exceeds the build workflow integer range`, {
      field,
      value: value.toString(),
    });
  }
  return Number(value);
}

function requireText(value: unknown, field: string): string {
  const parsed = String(value ?? "").trim();
  if (!parsed) {
    throw new BuildDomainError("INVALID_CLAIM_BUILD_EVIDENCE", `${field} must not be blank`, { field });
  }
  return parsed;
}

function assertCostSnapshot(
  allocation: CanonicalClaimInventoryExecutionResource["lotAllocations"][number],
  lot: any,
): void {
  const actual = {
    unitCostMills: BigInt(String(lot.total_unit_cost_mills)),
    poUnitCostMills: BigInt(String(lot.po_unit_cost_mills)),
    packagingUnitCostMills: BigInt(String(lot.packaging_cost_mills)),
    landedUnitCostMills: BigInt(String(lot.landed_cost_mills)),
  };
  const expected = {
    unitCostMills: allocation.unitCostMills,
    poUnitCostMills: allocation.poUnitCostMills,
    packagingUnitCostMills: allocation.packagingUnitCostMills,
    landedUnitCostMills: allocation.landedUnitCostMills,
  };
  if (Object.keys(expected).some((key) => actual[key as keyof typeof actual] !== expected[key as keyof typeof expected])) {
    throw new BuildDomainError(
      "CLAIM_BUILD_LOT_COST_DRIFT",
      "A claimed component lot no longer matches its exact cost snapshot",
      { inventoryLotId: allocation.inventoryLotId },
    );
  }
}

export class PostgresCanonicalClaimBuildRepository implements CanonicalClaimBuildMutationPort {
  constructor(
    private readonly inventoryWriter: CanonicalClaimInventoryMutationPort = new PostgresCanonicalClaimInventoryRepository(),
  ) {}

  async handoffOperation(
    input: Parameters<CanonicalClaimBuildMutationPort["handoffOperation"]>[0],
  ): Promise<CanonicalClaimBuildHandoffResult> {
    requireText(input.operationKey, "operationKey");
    const plannedBuilds = asPostgresInteger(input.plannedBuilds, "plannedBuilds");
    asPostgresInteger(input.outputQty, "outputQty");
    const bindingRows = rows(await input.client.query(
      `SELECT binding.id, binding.recipe_id, binding.relationship_role, binding.warehouse_id,
              binding.recipe_code_snapshot, binding.recipe_version_snapshot,
              binding.output_product_id_snapshot, binding.output_variant_id_snapshot,
              binding.output_units_per_variant_snapshot, binding.output_qty_snapshot,
              binding.validation_state,
              recipe.status AS recipe_status, recipe.recipe_type,
              recipe.code AS recipe_code, recipe.version AS recipe_version,
              recipe.output_product_id, recipe.output_variant_id,
              recipe.output_units_per_variant, recipe.output_qty
       FROM inventory.transformation_recipe_bindings AS binding
       JOIN inventory.build_recipes AS recipe ON recipe.id = binding.recipe_id
       WHERE binding.id = $1
       FOR SHARE OF binding, recipe`,
      [input.transformationRecipeBindingId],
    ));
    const binding = bindingRows[0];
    if (!binding) {
      throw new BuildDomainError("CLAIM_BUILD_BINDING_NOT_FOUND", "The claimed build binding no longer exists", {
        transformationRecipeBindingId: input.transformationRecipeBindingId,
      });
    }
    if (binding.relationship_role !== "component_build" || binding.validation_state !== "valid") {
      throw new BuildDomainError("CLAIM_BUILD_BINDING_INVALID", "The claimed binding is not a valid component build", {
        transformationRecipeBindingId: input.transformationRecipeBindingId,
        relationshipRole: binding.relationship_role,
        validationState: binding.validation_state,
      });
    }
    if (binding.recipe_status !== "active") {
      throw new BuildDomainError("CLAIM_BUILD_RECIPE_NOT_ACTIVE", "The claimed build recipe is no longer active", {
        recipeId: Number(binding.recipe_id),
        status: binding.recipe_status,
      });
    }
    const bindingWarehouseId = binding.warehouse_id == null ? null : positiveInteger(binding.warehouse_id, "binding.warehouseId");
    if (bindingWarehouseId != null && bindingWarehouseId !== input.warehouseId) {
      throw new BuildDomainError("CLAIM_BUILD_WAREHOUSE_MISMATCH", "The claimed binding does not apply to this warehouse", {
        bindingWarehouseId,
        operationWarehouseId: input.warehouseId,
      });
    }
    const snapshotMatchesRecipe =
      requireText(binding.recipe_code_snapshot, "binding.recipeCodeSnapshot") === requireText(binding.recipe_code, "recipe.code")
      && positiveInteger(binding.recipe_version_snapshot, "binding.recipeVersionSnapshot") === positiveInteger(binding.recipe_version, "recipe.version")
      && positiveInteger(binding.output_product_id_snapshot, "binding.outputProductIdSnapshot") === positiveInteger(binding.output_product_id, "recipe.outputProductId")
      && positiveInteger(binding.output_variant_id_snapshot, "binding.outputVariantIdSnapshot") === positiveInteger(binding.output_variant_id, "recipe.outputVariantId")
      && positiveInteger(binding.output_units_per_variant_snapshot, "binding.outputUnitsPerVariantSnapshot") === positiveInteger(binding.output_units_per_variant, "recipe.outputUnitsPerVariant")
      && positiveInteger(binding.output_qty_snapshot, "binding.outputQtySnapshot") === positiveInteger(binding.output_qty, "recipe.outputQty");
    if (!snapshotMatchesRecipe) {
      throw new BuildDomainError(
        "CLAIM_BUILD_RECIPE_SNAPSHOT_DRIFT",
        "The claimed transformation binding no longer matches its build recipe snapshot",
        { transformationRecipeBindingId: input.transformationRecipeBindingId, recipeId: Number(binding.recipe_id) },
      );
    }
    if (positiveInteger(binding.output_variant_id_snapshot, "binding.outputVariantIdSnapshot") !== input.destinationVariantId) {
      throw new BuildDomainError("CLAIM_BUILD_OUTPUT_MISMATCH", "The claimed build output does not match the recipe binding", {
        destinationVariantId: input.destinationVariantId,
        bindingOutputVariantId: Number(binding.output_variant_id_snapshot),
      });
    }
    if (BigInt(String(binding.output_qty_snapshot)) * input.plannedBuilds !== input.outputQty) {
      throw new BuildDomainError("CLAIM_BUILD_OUTPUT_QUANTITY_MISMATCH", "The claimed output is not the recipe output multiplied by planned builds", {
        outputQty: input.outputQty.toString(),
        plannedBuilds: input.plannedBuilds.toString(),
      });
    }

    const location = rows(await input.client.query(
      `SELECT id
       FROM warehouse.warehouse_locations
       WHERE id = $1 AND warehouse_id = $2 AND is_active = 1
       FOR SHARE`,
      [input.outputLocationId, input.warehouseId],
    ))[0];
    if (!location) {
      throw new BuildDomainError("CLAIM_BUILD_OUTPUT_LOCATION_INVALID", "The claimed build output location is not active in its warehouse", {
        warehouseId: input.warehouseId,
        outputLocationId: input.outputLocationId,
      });
    }

    const componentRows = rows(await input.client.query(
      `SELECT snapshot.component_variant_id, snapshot.component_product_id,
              snapshot.component_units_per_variant, snapshot.component_qty,
              component.id AS recipe_component_id, component.qty AS recipe_component_qty,
              component.component_product_id AS recipe_component_product_id,
              component.component_units_per_variant AS recipe_component_units_per_variant
       FROM inventory.transformation_recipe_component_snapshots AS snapshot
       JOIN inventory.build_recipe_components AS component
         ON component.recipe_id = $2
        AND component.component_variant_id = snapshot.component_variant_id
       WHERE snapshot.transformation_recipe_binding_id = $1
       ORDER BY snapshot.component_variant_id
       FOR SHARE OF snapshot, component`,
      [input.transformationRecipeBindingId, binding.recipe_id],
    ));
    const expectedInputs = new Map(input.inputs.map((entry) => [entry.sourceVariantId, entry.requiredQty]));
    if (expectedInputs.size !== input.inputs.length || componentRows.length !== expectedInputs.size) {
      throw new BuildDomainError("CLAIM_BUILD_COMPONENT_SET_MISMATCH", "Claimed build inputs do not match the bound recipe components", {
        claimedComponentCount: expectedInputs.size,
        recipeComponentCount: componentRows.length,
      });
    }
    for (const component of componentRows) {
      const variantId = positiveInteger(component.component_variant_id, "component.variantId");
      const qtyPerBuild = positiveInteger(component.component_qty, "component.qtyPerBuild");
      const requiredQty = expectedInputs.get(variantId);
      const componentSnapshotMatches =
        qtyPerBuild === positiveInteger(component.recipe_component_qty, "recipeComponent.qty")
        && positiveInteger(component.component_product_id, "component.productId") === positiveInteger(component.recipe_component_product_id, "recipeComponent.productId")
        && positiveInteger(component.component_units_per_variant, "component.unitsPerVariant") === positiveInteger(component.recipe_component_units_per_variant, "recipeComponent.unitsPerVariant");
      if (!componentSnapshotMatches || requiredQty !== BigInt(qtyPerBuild) * input.plannedBuilds) {
        throw new BuildDomainError("CLAIM_BUILD_COMPONENT_SNAPSHOT_DRIFT", "A claimed component no longer matches the bound recipe snapshot", {
          componentVariantId: variantId,
          claimedRequiredQty: requiredQty?.toString() ?? null,
        });
      }
    }

    const resourcesByVariant = new Map<number, CanonicalClaimInventoryExecutionResource[]>();
    const claimAllocationIds = new Set<string>();
    const inventoryLotIds = new Set<number>();
    for (const resource of input.resources) {
      if (resource.consumeQty <= BigInt(0)) {
        throw new BuildDomainError("INVALID_CLAIM_BUILD_EVIDENCE", "Claim build resources must have positive quantities");
      }
      const allocatedQty = resource.lotAllocations.reduce((sum, allocation) => {
        if (allocation.consumeQty <= BigInt(0)) {
          throw new BuildDomainError("INVALID_CLAIM_BUILD_EVIDENCE", "Claim build lot allocations must have positive quantities");
        }
        const allocationId = allocation.claimLotAllocationId.toString();
        if (claimAllocationIds.has(allocationId)) {
          throw new BuildDomainError("CLAIM_BUILD_ALLOCATION_DUPLICATED", "A claim lot allocation cannot be adopted more than once", {
            claimLotAllocationId: allocationId,
          });
        }
        claimAllocationIds.add(allocationId);
        if (inventoryLotIds.has(allocation.inventoryLotId)) {
          throw new BuildDomainError("CLAIM_BUILD_LOT_DUPLICATED", "A physical FIFO lot cannot appear twice in one build handoff", {
            inventoryLotId: allocation.inventoryLotId,
          });
        }
        inventoryLotIds.add(allocation.inventoryLotId);
        return sum + allocation.consumeQty;
      }, BigInt(0));
      if (allocatedQty !== resource.consumeQty) {
        throw new BuildDomainError("CLAIM_BUILD_RESOURCE_LINEAGE_MISMATCH", "Claim lot allocations do not reconcile to their resource", {
          claimResourceId: resource.claimResourceId.toString(),
          resourceQty: resource.consumeQty.toString(),
          lotQty: allocatedQty.toString(),
        });
      }
      const grouped = resourcesByVariant.get(resource.sourceVariantId) ?? [];
      grouped.push(resource);
      resourcesByVariant.set(resource.sourceVariantId, grouped);
    }
    for (const [variantId, requiredQty] of expectedInputs) {
      const claimedQty = (resourcesByVariant.get(variantId) ?? [])
        .reduce((sum, resource) => sum + resource.consumeQty, BigInt(0));
      if (claimedQty !== requiredQty) {
        throw new BuildDomainError("CLAIM_BUILD_RESOURCE_QUANTITY_MISMATCH", "Claim-owned resources do not cover the exact build input", {
          componentVariantId: variantId,
          requiredQty: requiredQty.toString(),
          claimedQty: claimedQty.toString(),
        });
      }
    }
    if ([...resourcesByVariant.keys()].some((variantId) => !expectedInputs.has(variantId))) {
      throw new BuildDomainError("CLAIM_BUILD_RESOURCE_VARIANT_MISMATCH", "Claim-owned resources include a variant outside the build input contract");
    }

    const levelIds = [...new Set(input.resources.map((resource) => resource.inventoryLevelId))].sort((a, b) => a - b);
    const lockedLevels = levelIds.length === 0 ? [] : rows(await input.client.query(
      `SELECT level.id, level.product_variant_id, level.warehouse_location_id,
              level.variant_qty, level.reserved_qty, location.warehouse_id
       FROM inventory.inventory_levels AS level
       JOIN warehouse.warehouse_locations AS location ON location.id = level.warehouse_location_id
       WHERE level.id = ANY($1::integer[])
       ORDER BY level.id
       FOR UPDATE OF level`,
      [levelIds],
    ));
    const levelsById = new Map(lockedLevels.map((level) => [positiveInteger(level.id, "inventoryLevel.id"), level]));
    if (levelsById.size !== levelIds.length) {
      throw new BuildDomainError("CLAIM_BUILD_LEVEL_MISSING", "One or more claimed inventory levels no longer exist", { levelIds });
    }
    const requiredByLevel = new Map<number, bigint>();
    for (const resource of input.resources) {
      const level = levelsById.get(resource.inventoryLevelId)!;
      if (positiveInteger(level.product_variant_id, "inventoryLevel.variantId") !== resource.sourceVariantId
        || positiveInteger(level.warehouse_location_id, "inventoryLevel.locationId") !== resource.warehouseLocationId
        || positiveInteger(level.warehouse_id, "inventoryLevel.warehouseId") !== input.warehouseId) {
        throw new BuildDomainError("CLAIM_BUILD_LEVEL_IDENTITY_DRIFT", "A claimed inventory level no longer has the persisted identity", {
          inventoryLevelId: resource.inventoryLevelId,
        });
      }
      requiredByLevel.set(resource.inventoryLevelId, (requiredByLevel.get(resource.inventoryLevelId) ?? BigInt(0)) + resource.consumeQty);
    }
    for (const [levelId, requiredQty] of requiredByLevel) {
      const level = levelsById.get(levelId)!;
      if (BigInt(String(level.variant_qty)) < requiredQty || BigInt(String(level.reserved_qty)) < requiredQty) {
        throw new BuildDomainError("CLAIM_BUILD_LEVEL_RESERVATION_DRIFT", "A claimed inventory level cannot cover its adopted reservation", {
          inventoryLevelId: levelId,
          requiredQty: requiredQty.toString(),
        });
      }
    }

    const allocations = input.resources.flatMap((resource) => resource.lotAllocations.map((allocation) => ({ resource, allocation })));
    const lotIds = [...new Set(allocations.map(({ allocation }) => allocation.inventoryLotId))].sort((a, b) => a - b);
    const lockedLots = lotIds.length === 0 ? [] : rows(await input.client.query(
      `SELECT id, product_variant_id, warehouse_location_id, qty_on_hand, qty_reserved, status,
              total_unit_cost_mills, po_unit_cost_mills, packaging_cost_mills, landed_cost_mills
       FROM inventory.inventory_lots
       WHERE id = ANY($1::integer[])
       ORDER BY id
       FOR UPDATE`,
      [lotIds],
    ));
    const lotsById = new Map(lockedLots.map((lot) => [positiveInteger(lot.id, "inventoryLot.id"), lot]));
    if (lotsById.size !== lotIds.length) {
      throw new BuildDomainError("CLAIM_BUILD_LOT_MISSING", "One or more claimed FIFO lots no longer exist", { lotIds });
    }
    for (const { resource, allocation } of allocations) {
      const lot = lotsById.get(allocation.inventoryLotId)!;
      if (positiveInteger(lot.product_variant_id, "inventoryLot.variantId") !== resource.sourceVariantId
        || positiveInteger(lot.warehouse_location_id, "inventoryLot.locationId") !== resource.warehouseLocationId
        || String(lot.status) !== "active"
        || BigInt(String(lot.qty_on_hand)) < allocation.consumeQty
        || BigInt(String(lot.qty_reserved)) < allocation.consumeQty) {
        throw new BuildDomainError("CLAIM_BUILD_LOT_RESERVATION_DRIFT", "A claimed FIFO lot cannot cover its adopted reservation", {
          inventoryLotId: allocation.inventoryLotId,
          requiredQty: allocation.consumeQty.toString(),
        });
      }
      assertCostSnapshot(allocation, lot);
    }

    const buildIdempotencyKey = `claim-build:${input.claimId}:${input.claimOperationId}`;
    const insertedOrder = rows(await input.client.query(
      `INSERT INTO inventory.build_orders (
         recipe_id, recipe_code, recipe_version, recipe_type,
         output_variant_id, output_product_id, output_units_per_variant, output_qty_per_build,
         planned_builds, warehouse_id, output_location_id, status, idempotency_key,
         created_by, released_by, released_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 'released', $12, $13, $13, $14)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, system_number`,
      [
        binding.recipe_id,
        binding.recipe_code_snapshot,
        binding.recipe_version_snapshot,
        binding.recipe_type,
        binding.output_variant_id_snapshot,
        binding.output_product_id_snapshot,
        binding.output_units_per_variant_snapshot,
        binding.output_qty_snapshot,
        plannedBuilds,
        input.warehouseId,
        input.outputLocationId,
        buildIdempotencyKey,
        input.actor,
        input.occurredAt,
      ],
    ));
    if (insertedOrder.length === 0) {
      throw new BuildDomainError("CLAIM_BUILD_ORDER_CONFLICT", "The deterministic claim build order already exists without its command receipt", {
        claimId: input.claimId.toString(),
        claimOperationId: input.claimOperationId.toString(),
      });
    }
    const buildOrderId = positiveInteger(insertedOrder[0].id, "buildOrder.id");
    const buildSystemNumber = requireText(insertedOrder[0].system_number, "buildOrder.systemNumber");
    const componentIds = new Map<number, number>();
    for (const component of componentRows) {
      const variantId = positiveInteger(component.component_variant_id, "component.variantId");
      const componentResources = resourcesByVariant.get(variantId) ?? [];
      const locationIds = [...new Set(componentResources.map((resource) => resource.warehouseLocationId))];
      const insertedComponent = rows(await input.client.query(
        `INSERT INTO inventory.build_order_components (
           build_order_id, recipe_component_id, component_variant_id,
           component_product_id, component_units_per_variant, qty_per_build,
           planned_qty, source_location_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          buildOrderId,
          component.recipe_component_id,
          variantId,
          component.component_product_id,
          component.component_units_per_variant,
          component.component_qty,
          asPostgresInteger(expectedInputs.get(variantId)!, `component.${variantId}.plannedQty`),
          locationIds.length === 1 ? locationIds[0] : null,
        ],
      ));
      componentIds.set(variantId, positiveInteger(insertedComponent[0]?.id, "buildOrderComponent.id"));
    }

    let adoptedReservationQty = BigInt(0);
    for (const { resource, allocation } of allocations) {
      const quantity = asPostgresInteger(allocation.consumeQty, "claimAllocation.consumeQty");
      await input.client.query(
        `INSERT INTO inventory.build_component_reservations (
           build_order_component_id, inventory_lot_id, reserved_qty,
           reservation_owner, availability_claim_id, availability_claim_lot_allocation_id
         ) VALUES ($1, $2, $3, 'availability_claim', $4, $5)`,
        [
          componentIds.get(resource.sourceVariantId),
          allocation.inventoryLotId,
          quantity,
          input.claimId.toString(),
          allocation.claimLotAllocationId.toString(),
        ],
      );
      adoptedReservationQty += allocation.consumeQty;
    }
    return { buildOrderId, buildSystemNumber, adoptedReservationQty };
  }

  async executeOperation(
    input: Parameters<CanonicalClaimBuildMutationPort["executeOperation"]>[0],
  ): Promise<CanonicalClaimBuildExecutionResult> {
    requireText(input.operationKey, "operationKey");
    requireText(input.actor, "actor");
    requireText(input.reason, "reason");
    positiveBigInt(input.claimId, "claim.id");
    positiveBigInt(input.claimOperationId, "claimOperation.id");
    const buildOrderId = positiveInteger(input.buildOrderId, "buildOrder.id");
    const plannedBuilds = asPostgresInteger(input.plannedBuilds, "plannedBuilds");
    const outputQty = asPostgresInteger(input.outputQty, "outputQty");
    asPostgresInteger(input.committedOutputQty, "committedOutputQty");

    const order = rows(await input.client.query(
      `SELECT id, system_number, recipe_id, output_variant_id, output_qty_per_build,
              planned_builds, completed_builds, warehouse_id, output_location_id,
              status, total_component_cost_mills
       FROM inventory.build_orders
       WHERE id = $1
       FOR UPDATE`,
      [buildOrderId],
    ))[0];
    if (!order) {
      throw new BuildDomainError("CLAIM_BUILD_ORDER_NOT_FOUND", "The handed-off build order no longer exists", {
        buildOrderId,
      });
    }
    const buildSystemNumber = requireText(order.system_number, "buildOrder.systemNumber");
    const orderMatchesOperation =
      String(order.status) === "released"
      && positiveInteger(order.output_variant_id, "buildOrder.outputVariantId") === input.destinationVariantId
      && positiveInteger(order.output_location_id, "buildOrder.outputLocationId") === input.outputLocationId
      && positiveInteger(order.warehouse_id, "buildOrder.warehouseId") === input.warehouseId
      && positiveInteger(order.planned_builds, "buildOrder.plannedBuilds") === plannedBuilds
      && Number(order.completed_builds) === 0
      && BigInt(String(order.output_qty_per_build)) * input.plannedBuilds === input.outputQty;
    if (!orderMatchesOperation) {
      throw new BuildDomainError(
        "CLAIM_BUILD_ORDER_STATE_DRIFT",
        "The handed-off build order no longer matches its canonical claim operation",
        { buildOrderId, status: order.status },
      );
    }

    const componentRows = rows(await input.client.query(
      `SELECT id, component_variant_id, qty_per_build, planned_qty, consumed_qty
       FROM inventory.build_order_components
       WHERE build_order_id = $1
       ORDER BY component_variant_id, id
       FOR UPDATE`,
      [buildOrderId],
    ));
    const expectedInputs = new Map(input.inputs.map((entry) => [entry.sourceVariantId, entry.requiredQty]));
    if (expectedInputs.size !== input.inputs.length || componentRows.length !== expectedInputs.size) {
      throw new BuildDomainError(
        "CLAIM_BUILD_COMPONENT_SET_DRIFT",
        "The handed-off build component set no longer matches the canonical operation",
        { buildOrderId },
      );
    }
    const componentIdsByVariant = new Map<number, number>();
    for (const component of componentRows) {
      const sourceVariantId = positiveInteger(component.component_variant_id, "buildComponent.sourceVariantId");
      const componentId = positiveInteger(component.id, "buildComponent.id");
      const requiredQty = expectedInputs.get(sourceVariantId);
      if (requiredQty == null
        || BigInt(String(component.planned_qty)) !== requiredQty
        || BigInt(String(component.qty_per_build)) * input.plannedBuilds !== requiredQty
        || Number(component.consumed_qty) !== 0) {
        throw new BuildDomainError(
          "CLAIM_BUILD_COMPONENT_STATE_DRIFT",
          "A handed-off build component no longer matches its canonical input contract",
          { buildOrderId, componentId, sourceVariantId },
        );
      }
      componentIdsByVariant.set(sourceVariantId, componentId);
    }

    const expectedAllocations = new Map<string, {
      resource: CanonicalClaimInventoryExecutionResource;
      allocation: CanonicalClaimInventoryExecutionResource["lotAllocations"][number];
    }>();
    for (const resource of input.resources) {
      for (const allocation of resource.lotAllocations) {
        const key = positiveBigInt(allocation.claimLotAllocationId, "claimLotAllocation.id").toString();
        if (expectedAllocations.has(key)) {
          throw new BuildDomainError(
            "CLAIM_BUILD_ALLOCATION_DUPLICATED",
            "A claim lot allocation cannot appear twice in one build execution",
            { claimLotAllocationId: key },
          );
        }
        expectedAllocations.set(key, { resource, allocation });
      }
    }
    const reservationRows = rows(await input.client.query(
      `SELECT reservation.id, reservation.inventory_lot_id, reservation.reserved_qty,
              reservation.consumed_qty, reservation.released_qty,
              reservation.reservation_owner, reservation.availability_claim_id,
              reservation.availability_claim_lot_allocation_id,
              component.id AS build_order_component_id,
              component.component_variant_id
       FROM inventory.build_component_reservations AS reservation
       JOIN inventory.build_order_components AS component
         ON component.id = reservation.build_order_component_id
       WHERE component.build_order_id = $1
       ORDER BY component.component_variant_id,
                reservation.availability_claim_lot_allocation_id,
                reservation.inventory_lot_id,
                reservation.id
       FOR UPDATE OF reservation`,
      [buildOrderId],
    ));
    if (reservationRows.length !== expectedAllocations.size) {
      throw new BuildDomainError(
        "CLAIM_BUILD_RESERVATION_SET_DRIFT",
        "The adopted build reservations no longer match the exact canonical lot allocations",
        { buildOrderId, expectedCount: expectedAllocations.size, actualCount: reservationRows.length },
      );
    }
    const seenAllocationIds = new Set<string>();
    for (const reservation of reservationRows) {
      const allocationId = positiveBigInt(
        reservation.availability_claim_lot_allocation_id,
        "buildReservation.claimLotAllocationId",
      ).toString();
      const expected = expectedAllocations.get(allocationId);
      const sourceVariantId = positiveInteger(reservation.component_variant_id, "buildComponent.sourceVariantId");
      const reservationClaimId = reservation.availability_claim_id == null
        ? null
        : positiveBigInt(reservation.availability_claim_id, "buildReservation.claimId");
      const openQty = BigInt(String(reservation.reserved_qty))
        - BigInt(String(reservation.consumed_qty))
        - BigInt(String(reservation.released_qty));
      if (!expected
         || seenAllocationIds.has(allocationId)
         || String(reservation.reservation_owner) !== "availability_claim"
        || reservationClaimId !== input.claimId
        || positiveInteger(reservation.inventory_lot_id, "buildReservation.inventoryLotId")
          !== expected.allocation.inventoryLotId
        || sourceVariantId !== expected.resource.sourceVariantId
        || positiveInteger(reservation.build_order_component_id, "buildComponent.id")
          !== componentIdsByVariant.get(sourceVariantId)
        || openQty !== expected.allocation.consumeQty
        || BigInt(String(reservation.consumed_qty)) !== BigInt(0)
        || BigInt(String(reservation.released_qty)) !== BigInt(0)) {
        throw new BuildDomainError(
          "CLAIM_BUILD_RESERVATION_STATE_DRIFT",
          "An adopted build reservation no longer matches its canonical lot allocation",
          { buildOrderId, claimLotAllocationId: allocationId },
        );
      }
      seenAllocationIds.add(allocationId);
    }

    const runIdempotencyKey = `claim-build-run:${input.claimId}:${input.claimOperationId}`;
    const run = rows(await input.client.query(
      `INSERT INTO inventory.build_runs (
         build_order_id, run_number, idempotency_key, builds_completed, output_qty, posted_by
       ) VALUES ($1, 1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, run_number`,
      [buildOrderId, runIdempotencyKey, plannedBuilds, outputQty, input.actor],
    ))[0];
    if (!run) {
      throw new BuildDomainError(
        "CLAIM_BUILD_RUN_CONFLICT",
        "The deterministic claim build run already exists without its canonical command receipt",
        { buildOrderId, idempotencyKey: runIdempotencyKey },
      );
    }
    const buildRunId = positiveInteger(run.id, "buildRun.id");
    const buildRunNumber = positiveInteger(run.run_number, "buildRun.runNumber");
    const inventoryResult = await this.inventoryWriter.executeBuildOperation({
      client: input.client,
      claimId: input.claimId,
      claimOperationId: input.claimOperationId,
      operationKey: input.operationKey,
      operationType: "component_build",
      resources: input.resources,
      destinationVariantId: input.destinationVariantId,
      outputLocationId: input.outputLocationId,
      outputQty: input.outputQty,
      committedOutputQty: input.committedOutputQty,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      build: {
        buildOrderId,
        buildRunId,
        buildRunNumber,
        buildSystemNumber,
        components: [...componentIdsByVariant].map(([sourceVariantId, buildOrderComponentId]) => ({
          sourceVariantId,
          buildOrderComponentId,
        })),
      },
      actor: input.actor,
      reason: input.reason,
      occurredAt: input.occurredAt,
    });

    let recordedInputCostMills = BigInt(0);
    const consumedByComponent = new Map<number, bigint>();
    for (const { resource, allocation } of expectedAllocations.values()) {
      const componentId = componentIdsByVariant.get(resource.sourceVariantId)!;
      const consumeQty = asPostgresInteger(allocation.consumeQty, "claimAllocation.consumeQty");
      await input.client.query(
        `INSERT INTO inventory.build_run_consumptions (
           build_run_id, build_order_component_id, inventory_lot_id, qty,
           po_unit_cost_mills, packaging_unit_cost_mills,
           landed_unit_cost_mills, total_unit_cost_mills
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          buildRunId,
          componentId,
          allocation.inventoryLotId,
          consumeQty,
          allocation.poUnitCostMills.toString(),
          allocation.packagingUnitCostMills.toString(),
          allocation.landedUnitCostMills.toString(),
          allocation.unitCostMills.toString(),
        ],
      );
      const reservationUpdate = await input.client.query(
        `UPDATE inventory.build_component_reservations
         SET consumed_qty = consumed_qty + $1, updated_at = $3
         WHERE availability_claim_lot_allocation_id = $2
           AND reservation_owner = 'availability_claim'
           AND reserved_qty - consumed_qty - released_qty = $1`,
        [consumeQty, allocation.claimLotAllocationId.toString(), input.occurredAt],
      );
      if (reservationUpdate.rowCount !== 1) {
        throw new BuildDomainError(
          "CLAIM_BUILD_RESERVATION_STATE_CHANGED",
          "An adopted build reservation changed while its consumption was being recorded",
          { buildOrderId, claimLotAllocationId: allocation.claimLotAllocationId.toString() },
        );
      }
      consumedByComponent.set(
        componentId,
        (consumedByComponent.get(componentId) ?? BigInt(0)) + allocation.consumeQty,
      );
      recordedInputCostMills += allocation.unitCostMills * allocation.consumeQty;
    }
    if (recordedInputCostMills !== inventoryResult.totalInputCostMills) {
      throw new BuildDomainError(
        "CLAIM_BUILD_COST_LINEAGE_MISMATCH",
        "Build consumption evidence does not reconcile to the canonical inventory cost result",
        {
          buildOrderId,
          recordedInputCostMills: recordedInputCostMills.toString(),
          inventoryInputCostMills: inventoryResult.totalInputCostMills.toString(),
        },
      );
    }
    for (const [componentId, consumedQty] of consumedByComponent) {
      const componentUpdate = await input.client.query(
        `UPDATE inventory.build_order_components
         SET consumed_qty = consumed_qty + $1, updated_at = $3
         WHERE id = $2 AND planned_qty - consumed_qty = $1`,
        [asPostgresInteger(consumedQty, "buildComponent.consumedQty"), componentId, input.occurredAt],
      );
      if (componentUpdate.rowCount !== 1) {
        throw new BuildDomainError(
          "CLAIM_BUILD_COMPONENT_STATE_CHANGED",
          "A build component changed while canonical consumption was being recorded",
          { buildOrderId, componentId },
        );
      }
    }
    const runUpdate = await input.client.query(
      `UPDATE inventory.build_runs
       SET status = 'posted', total_component_cost_mills = $1, posted_at = $2
       WHERE id = $3 AND status = 'posting'`,
      [inventoryResult.totalInputCostMills.toString(), input.occurredAt, buildRunId],
    );
    if (runUpdate.rowCount !== 1) {
      throw new BuildDomainError(
        "CLAIM_BUILD_RUN_STATE_CHANGED",
        "The build run changed while canonical completion was being recorded",
        { buildOrderId, buildRunId },
      );
    }
    const orderUpdate = await input.client.query(
      `UPDATE inventory.build_orders
       SET status = 'completed', completed_builds = planned_builds,
           total_component_cost_mills = $1, started_at = COALESCE(started_at, $2),
           completed_by = $3, completed_at = $2,
           failure_code = NULL, failure_message = NULL, updated_at = $2
       WHERE id = $4 AND status = 'released' AND completed_builds = 0`,
      [inventoryResult.totalInputCostMills.toString(), input.occurredAt, input.actor, buildOrderId],
    );
    if (orderUpdate.rowCount !== 1) {
      throw new BuildDomainError(
        "CLAIM_BUILD_ORDER_STATE_CHANGED",
        "The build order changed while canonical completion was being recorded",
        { buildOrderId },
      );
    }
    return {
      buildOrderId,
      buildRunId,
      buildSystemNumber,
      outputInventoryLevelId: inventoryResult.outputInventoryLevelId,
      committedLotAllocations: inventoryResult.committedLotAllocations,
      totalInputCostMills: inventoryResult.totalInputCostMills,
    };
  }

  async cancelOperation(
    input: Parameters<CanonicalClaimBuildMutationPort["cancelOperation"]>[0],
  ): Promise<CanonicalClaimBuildCancellationResult> {
    requireText(input.actor, "actor");
    requireText(input.reason, "reason");
    positiveBigInt(input.claimId, "claim.id");
    positiveBigInt(input.claimOperationId, "claimOperation.id");
    const buildOrderId = positiveInteger(input.buildOrderId, "buildOrder.id");
    const expectedReservationQty = asPostgresInteger(
      input.expectedReservationQty,
      "expectedReservationQty",
    );
    const order = rows(await input.client.query(
      `SELECT id, system_number, status, completed_builds
       FROM inventory.build_orders
       WHERE id = $1
       FOR UPDATE`,
      [buildOrderId],
    ))[0];
    if (!order) {
      throw new BuildDomainError("CLAIM_BUILD_ORDER_NOT_FOUND", "The handed-off build order no longer exists", {
        buildOrderId,
      });
    }
    if (String(order.status) !== "released" || Number(order.completed_builds) !== 0) {
      throw new BuildDomainError(
        "CLAIM_BUILD_CANCELLATION_STATE_DRIFT",
        "Only an unexecuted handed-off build may be cancelled with its claim",
        { buildOrderId, status: order.status, completedBuilds: order.completed_builds },
      );
    }
    const postedRuns = rows(await input.client.query(
      `SELECT id, status
       FROM inventory.build_runs
       WHERE build_order_id = $1
       ORDER BY id
       FOR UPDATE`,
      [buildOrderId],
    ));
    if (postedRuns.length > 0) {
      throw new BuildDomainError(
        "CLAIM_BUILD_CANCELLATION_RUN_CONFLICT",
        "An unexecuted claim build cannot contain build-run evidence",
        { buildOrderId, buildRunIds: postedRuns.map((row) => row.id) },
      );
    }
    const reservations = rows(await input.client.query(
      `SELECT reservation.id, reservation.reserved_qty,
              reservation.consumed_qty, reservation.released_qty,
              reservation.reservation_owner, reservation.availability_claim_id,
              reservation.availability_claim_lot_allocation_id
       FROM inventory.build_component_reservations AS reservation
       JOIN inventory.build_order_components AS component
         ON component.id = reservation.build_order_component_id
       WHERE component.build_order_id = $1
       ORDER BY reservation.availability_claim_lot_allocation_id, reservation.id
       FOR UPDATE OF reservation`,
      [buildOrderId],
    ));
    let releasedReservationQty = BigInt(0);
    for (const reservation of reservations) {
      const reservationClaimId = reservation.availability_claim_id == null
        ? null
        : positiveBigInt(reservation.availability_claim_id, "buildReservation.claimId");
      const openQty = BigInt(String(reservation.reserved_qty))
        - BigInt(String(reservation.consumed_qty))
        - BigInt(String(reservation.released_qty));
      if (String(reservation.reservation_owner) !== "availability_claim"
        || reservationClaimId !== input.claimId
        || reservation.availability_claim_lot_allocation_id == null
        || BigInt(String(reservation.consumed_qty)) !== BigInt(0)
        || BigInt(String(reservation.released_qty)) !== BigInt(0)
        || openQty <= BigInt(0)) {
        throw new BuildDomainError(
          "CLAIM_BUILD_CANCELLATION_RESERVATION_DRIFT",
          "An adopted build reservation cannot be released exactly once",
          { buildOrderId, reservationId: reservation.id },
        );
      }
      const quantity = asPostgresInteger(openQty, "buildReservation.openQty");
      const updated = await input.client.query(
        `UPDATE inventory.build_component_reservations
         SET released_qty = released_qty + $1, updated_at = $3
         WHERE id = $2 AND consumed_qty = 0 AND released_qty = 0
           AND reserved_qty = $1`,
        [quantity, positiveInteger(reservation.id, "buildReservation.id"), input.occurredAt],
      );
      if (updated.rowCount !== 1) {
        throw new BuildDomainError(
          "CLAIM_BUILD_CANCELLATION_RESERVATION_CHANGED",
          "An adopted build reservation changed during cancellation",
          { buildOrderId, reservationId: reservation.id },
        );
      }
      releasedReservationQty += openQty;
    }
    if (releasedReservationQty !== input.expectedReservationQty
      || releasedReservationQty !== BigInt(expectedReservationQty)) {
      throw new BuildDomainError(
        "CLAIM_BUILD_CANCELLATION_QUANTITY_MISMATCH",
        "Cancelled build reservations do not reconcile to the handoff quantity",
        {
          buildOrderId,
          expectedReservationQty: input.expectedReservationQty.toString(),
          releasedReservationQty: releasedReservationQty.toString(),
        },
      );
    }
    const orderUpdate = await input.client.query(
      `UPDATE inventory.build_orders
       SET status = 'cancelled', cancelled_by = $1, cancellation_reason = $2,
           cancelled_reservation_qty = $3, cancelled_at = $4,
           failure_code = NULL, failure_message = NULL, updated_at = $4
       WHERE id = $5 AND status = 'released' AND completed_builds = 0`,
      [input.actor, input.reason, expectedReservationQty, input.occurredAt, buildOrderId],
    );
    if (orderUpdate.rowCount !== 1) {
      throw new BuildDomainError(
        "CLAIM_BUILD_CANCELLATION_STATE_CHANGED",
        "The handed-off build order changed during cancellation",
        { buildOrderId },
      );
    }
    return {
      buildOrderId,
      buildSystemNumber: requireText(order.system_number, "buildOrder.systemNumber"),
      releasedReservationQty,
    };
  }
}
