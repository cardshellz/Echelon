import {
  assemblyExecutionContextsSchema, assemblyOrderInstructionsSchema, assemblyTaskViewSchema,
  assemblyOutputPickCommandSchema,
} from "@shared/warehouse-assembly-execution";
import { warehouseIdSchema } from "@shared/warehouse-work";
import { workEvidenceIdSchema } from "@shared/warehouse-assembly-work";
import { readWarehouseWorkActor } from "../../../identity";
import { readAssemblyOrder } from "../../../orders/assembly-order-reader";
import { readAssemblyVariantLabels } from "../../../catalog/assembly-variant-reader";
import { readAssemblyOwnership } from "../../../inventory-planning/application/assembly-ownership-reader";
import type { InventoryAvailabilityClaimService } from "../../../inventory-planning/application/inventory-availability-claim.service";
import { AssemblyWorkOwner } from "./assembly-work-owner";
import { AssemblyWorkService } from "./assembly-work.service";
import { requireAssemblyScope, requireAssemblyRoute } from "../domain/assembly-work";
import { requireWorkPermission, WarehouseWorkError } from "../domain/work-configuration";
import { isFullyHandedToAssembly, type PickerCoverageLine } from "../domain/assembly-picker-coverage";

/** Read composition and typed commands only. No inventory SQL or task-status writes. */
export class AssemblyExecutionService {
  constructor(
    private readonly owner: AssemblyWorkOwner,
    private readonly work: Pick<AssemblyWorkService, "get">,
    private readonly claims: Pick<InventoryAvailabilityClaimService, "getReservationStatus" | "pickClaimLine">,
  ) {}

  async contexts(actorId: string) {
    const warehouseIds = await this.owner.configuration.transaction(async (client) => {
      const actor = await readWarehouseWorkActor(client, actorId);
      requireWorkPermission(actor, "view"); requireWorkPermission(actor, "assembly");
      return this.owner.configuration.scopedWarehouseIds(client, actorId);
    });
    const contexts = [];
    for (const warehouseId of warehouseIds) {
      const allowed = await this.owner.configuration.transaction(async (client) => {
        const context = await this.owner.context(client, warehouseId, actorId);
        requireWorkPermission(context.actor, "assembly");
        const stations = context.revision.configuration.stations.filter((station) => {
          if (!station.capabilities.includes("assembly")) return false;
          try { requireAssemblyScope(context.revision.configuration, context.actor, station, context.locations, "assembly"); return true; }
          catch (error) { if (error instanceof WarehouseWorkError && error.code === "WORK_SCOPE_DENIED") return false; throw error; }
        });
        // Paused stations remain selectable to finish/review started physical work.
        return stations.length ? { warehouseId, warehouseCode: context.warehouse.code, warehouseName: context.warehouse.name, stations } : null;
      });
      if (allowed) contexts.push(allowed);
    }
    return assemblyExecutionContextsSchema.parse({ contexts });
  }

  async order(actorId: string, rawOrderId: unknown) {
    const orderId = warehouseIdSchema.parse(rawOrderId);
    const order = await this.owner.configuration.transaction(async (client) => {
      const actor = await readWarehouseWorkActor(client, actorId);
      requireWorkPermission(actor, "view"); requireWorkPermission(actor, "picking");
      const row = await readAssemblyOrder(client, orderId);
      if (!row) throw new WarehouseWorkError("WORK_ORDER_NOT_FOUND", "Order not found", 404);
      if (row.assigned_picker_id !== actorId) throw new WarehouseWorkError("WORK_ORDER_PICKER_MISMATCH", "Claim this order before reviewing its assembly handoff", 403);
      return row;
    });
    // This read transaction is closed before entering the canonical owner's snapshot.
    const projection = await this.claims.getReservationStatus({ orderId });
    const claim = projection.claim;
    if (!claim) return assemblyOrderInstructionsSchema.parse({ orderId, orderNumber: order.order_number, instructions: [] });
    return this.owner.configuration.transaction(async (client) => {
      const tasks = await this.owner.tasks.forClaims(client, [claim.claimId]);
      const operations = claim.lines.flatMap((line) => line.operations.filter((operation) => operation.operationType === "component_build")
        .map((operation) => ({ line, operation })));
      if (operations.length > 1000) throw new WarehouseWorkError("WORK_READ_LIMIT_EXCEEDED", "Order has too many assembly operations for this view", 422);
      const labels = await readAssemblyVariantLabels(client, operations.flatMap(({ operation }) => operation.inputs.map((input) => input.sourceVariantId)));
      const instructions = [];
      for (const { line, operation } of operations) {
        const item = order.items.find((entry) => entry.id === line.orderItemId);
        if (!item || item.requires_shipping !== 1 || item.status === "cancelled") continue;
        const task = tasks.find((entry) => entry.claimOperationId === operation.claimOperationId) ?? null;
        if (operation.status === "released" || (!task && operation.status === "completed")) continue;
        const sourceIds = line.resources.filter((resource) => resource.consumerOperationKey === operation.operationKey && resource.openQty !== "0")
          .map((resource) => resource.warehouseLocationId);
        const context = await this.owner.context(client, operation.warehouseId, actorId);
        if (task) requireAssemblyScope(context.revision.configuration, context.actor, task.station, context.locations, "picking");
        const routes = [];
        let blocker: string | null = null;
        if (order.on_hold || item.on_hold || ["shipped", "cancelled"].includes(order.warehouse_status)) blocker = "Order or item is held/closed; resolve it before handoff.";
        else if (operation.parentOperationKey !== null) blocker = "This build supplies another transformation; dependency handoff is not connected yet.";
        else if (operation.committedOutputQty !== String(item.quantity) || item.picked_quantity !== 0) blocker = "Mixed stock/build or partially picked line: quantity-level handoff is not connected yet. Keep this line in the picker workload.";
        else if (line.shortfallQty !== "0" || line.releasedTargetQty !== "0" || line.consumedTargetQty !== "0"
          || line.pickedTargetQty !== "0" || operation.releasedExecutions !== "0"
          || ["failed", "executing"].includes(operation.status)) blocker = "The canonical plan is not ready for a new handoff.";
        if (!task && !blocker) {
          // One bounded location read per operation, not one query per station.
          const locations = await this.owner.configuration.locationsByIds(client, operation.warehouseId,
            [...context.revision.configuration.stations.map((station) => station.locationId), ...sourceIds,
              ...(operation.outputLocationId === null ? [] : [operation.outputLocationId])]);
          for (const station of context.revision.configuration.stations) {
            try {
              requireAssemblyScope(context.revision.configuration, context.actor, station, context.locations, "picking");
              requireAssemblyRoute(context.revision.configuration, station.id, operation.outputLocationId, sourceIds, locations);
              if (!context.warehouse.active) continue;
              routes.push({ warehouseId: operation.warehouseId, configurationRevision: context.revision.revision, station });
            } catch (error) {
              if (!(error instanceof WarehouseWorkError)) throw error;
              if (!["WORK_SCOPE_DENIED", "WORK_ASSEMBLY_STATION_INVALID", "WORK_MATERIAL_LOCATION_MISMATCH", "WORK_DISPATCH_ASSIGNMENT_NOT_CONNECTED"].includes(error.code)) throw error;
            }
          }
          if (!routes.length) blocker = "No permitted station matches the plan's actual material and output locations. Review Stations & work areas.";
        }
        instructions.push({ claimId: claim.claimId, operationKey: operation.operationKey, orderItemId: item.id,
          sku: item.sku, name: item.name, outputQty: operation.outputQty, committedOutputQty: operation.committedOutputQty,
          inputs: operation.inputs.map((input) => {
            const label = labels.find((entry) => entry.variantId === input.sourceVariantId);
            if (!label) throw new WarehouseWorkError("WORK_COMPONENT_NOT_FOUND", "A planned component has no catalog identity", 409);
            return { ...label, quantity: input.requiredQty };
          }), task, routes, blocker });
      }
      return assemblyOrderInstructionsSchema.parse({ orderId, orderNumber: order.order_number, instructions });
    });
  }

  async task(actorId: string, rawId: unknown) {
    const task = await this.work.get(actorId, workEvidenceIdSchema.parse(rawId));
    return this.owner.configuration.transaction(async (client) => {
      const order = await readAssemblyOrder(client, task.orderId);
      const item = order?.items.find((entry) => entry.id === task.orderItemId);
      if (!order || !item) throw new WarehouseWorkError("WORK_ORDER_NOT_FOUND", "The assembly order or line no longer exists", 409);
      const labels = await readAssemblyVariantLabels(client, task.inputs.map((input) => input.variantId));
      const context = await this.owner.context(client, task.warehouseId, actorId, { stationId: task.station.id,
        locationIds: task.station.assemblyBindings ? [task.station.assemblyBindings.outputLocationId] : [] });
      const location = context.locations.find((entry) => entry.id === task.station.assemblyBindings?.outputLocationId);
      let outputPickBlocker: string | null = null;
      if (task.state !== "completed") outputPickBlocker = "Complete physical assembly before picking its output.";
      else if (order.on_hold || item.on_hold || ["cancelled", "shipped"].includes(order.warehouse_status)) outputPickBlocker = "Order or item is held/closed.";
      else if (item.picked_quantity !== 0 || ["completed", "cancelled"].includes(item.status)) outputPickBlocker = "This line already has pick progress; review the order instead of picking it again.";
      else if (item.status === "short") outputPickBlocker = "Resolve the line's shortage before recording assembly output pickup.";
      else if (BigInt(item.quantity) > BigInt(task.outputQty)) outputPickBlocker = "This job does not cover the whole order line; mixed-source output picking is not connected yet.";
      else if (!location?.active) outputPickBlocker = "The configured output location is unavailable.";
      else if (task.assignedTo !== actorId) outputPickBlocker = "Only the assigned assembler can record this output pick.";
      else {
        try { requireAssemblyScope(context.revision.configuration, context.actor, task.station, context.locations, "picking"); }
        catch (error) { if (!(error instanceof WarehouseWorkError)) throw error; outputPickBlocker = error.message; }
      }
      return assemblyTaskViewSchema.parse({ task, orderNumber: order.order_number, sku: item.sku, name: item.name,
        itemQuantity: item.quantity, pickedQuantity: item.picked_quantity, itemStatus: item.status,
        orderStatus: order.warehouse_status, onHold: !!order.on_hold || !!item.on_hold, outputLocationCode: location?.code ?? null,
        inputs: task.inputs.map((input) => {
          const label = labels.find((entry) => entry.variantId === input.variantId);
          if (!label) throw new WarehouseWorkError("WORK_COMPONENT_NOT_FOUND", "A planned component has no catalog identity", 409);
          return { ...label, quantity: input.quantity };
        }), outputPickBlocker });
    });
  }

  async pickOutput(actorId: string, rawId: unknown, rawInput: unknown) {
    const id = workEvidenceIdSchema.parse(rawId);
    const input = assemblyOutputPickCommandSchema.parse(rawInput);
    if (input.fence.taskId !== id) throw new WarehouseWorkError("WORK_TASK_FENCE_MISMATCH", "Output pick belongs to another job", 400);
    const task = await this.work.get(actorId, id);
    const locationId = task.station.assemblyBindings?.outputLocationId;
    if (!locationId) throw new WarehouseWorkError("WORK_OUTPUT_LOCATION_MISSING", "The job has no output location", 409);
    // Replays still require current picking authority. Close these read locks
    // before entering the canonical writer's inventory-first lock order.
    await this.owner.configuration.transaction(async (client) => {
      const context = await this.owner.context(client, task.warehouseId, actorId,
        { stationId: task.station.id, locationIds: [task.station.locationId, locationId] });
      requireAssemblyScope(context.revision.configuration, context.actor, task.station, context.locations, "picking");
    });
    // Every field derives from immutable job identity or the original request.
    // Do not rebuild expected progress from fresh state on an uncertain retry.
    return this.claims.pickClaimLine({ claimId: task.claimId, orderItemId: task.orderItemId,
      warehouseLocationId: locationId, quantity: String(input.quantity), actor: actorId, reason: input.reason,
      idempotencyKey: `assembly-output:${input.commandId}`, locationStrategy: "strict", assemblyWork: input.fence,
      wmsProgress: { expectedStatus: input.expectedItemStatus, expectedPickedQuantity: 0,
        targetStatus: "completed", targetPickedQuantity: input.quantity } });
  }

  /** Existing picker queue remains physical truth; only wholly delegated work leaves that view. */
  async handedOffOrderIds(orders: readonly { id: number; items: PickerCoverageLine[] }[]): Promise<Set<number>> {
    const result = new Set<number>();
    for (let offset = 0; offset < orders.length; offset += 200) {
      const batch = orders.slice(offset, offset + 200);
      await this.owner.configuration.transaction(async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const ownership = await readAssemblyOwnership(client, batch.map((order) => order.id));
        const tasks = await this.owner.tasks.forClaims(client, ownership.map((row) => row.claimId));
        for (const order of batch) {
          if (isFullyHandedToAssembly(order.items, ownership.filter((row) => row.orderId === order.id), tasks)) result.add(order.id);
        }
      });
    }
    return result;
  }
}
