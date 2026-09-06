import type { PoolClient } from "pg";
import type { AssemblyOutputPickFence } from "@shared/warehouse-assembly-execution";
import { requireAssemblyOrderAuthority } from "../../../orders/assembly-handoff-authority";
import {
  type AssemblyTask, type AssemblyWorkRoute, type AssemblyWorkFence,
} from "@shared/warehouse-assembly-work";
import { readWarehouseWorkActor } from "../../../identity";
import { WorkConfigurationRepository } from "../infrastructure/work-configuration.repository";
import { AssemblyWorkRepository } from "../infrastructure/assembly-work.repository";
import { cancelUnstartedAssembly, completeAssemblyTask, requireAssemblyRoute, requireAssemblyScope } from "../domain/assembly-work";
import { requireWorkPermission, WarehouseWorkError, type WorkActor } from "../domain/work-configuration";

export type WorkActorReader = (client: PoolClient, actorId: string) => Promise<WorkActor>;
interface OwnerAudit { actorId: string; reason: string; commandKey: string; requestHash: string; occurredAt: string }
export interface AssemblyHandoffEvidence extends OwnerAudit {
  warehouseId: number; claimId: string; claimOperationId: string; operationKey: string;
  orderId: number; orderItemId: number; buildOrderId: number; buildSystemNumber: string;
  destinationVariantId: number; outputQty: string; outputLocationId: number | null;
  inputs: { variantId: number; quantity: string }[]; sourceLocationIds: number[];
  route: AssemblyWorkRoute;
}

/** Warehouse's published owner API. The caller owns the transaction and claim lock. */
export class AssemblyWorkOwner {
  constructor(
    readonly configuration: WorkConfigurationRepository,
    readonly tasks: AssemblyWorkRepository,
    private readonly actorReader: WorkActorReader = readWarehouseWorkActor,
  ) {}

  /** Inventory owner calls after acquiring stock locks, before committing its pick. */
  async authorizeOutputPick(client: PoolClient, input: {
    fence: AssemblyOutputPickFence; claimId: string; orderId: number; orderItemId: number;
    variantId: number; locationId: number; quantity: string; actorId: string;
    producerOperationKeys: (string | null)[];
  }): Promise<{ locationCode: string; zone: string | null }> {
    const task = await this.tasks.byId(client, input.fence.taskId);
    if (!task) throw new WarehouseWorkError("WORK_TASK_NOT_FOUND", "Assembly job not found", 404);
    const context = await this.context(client, task.warehouseId, input.actorId,
      { stationId: task.station.id, locationIds: [task.station.locationId, input.locationId] });
    requireAssemblyScope(context.revision.configuration, context.actor, task.station, context.locations, "assembly");
    requireAssemblyScope(context.revision.configuration, context.actor, task.station, context.locations, "picking");
    const locked = await this.tasks.byId(client, task.id, true);
    if (!locked || locked.version !== input.fence.expectedVersion || locked.version !== task.version) {
      throw new WarehouseWorkError("WORK_TASK_VERSION_CONFLICT", "Assembly work changed; reload the job", 409);
    }
    if (task.state !== "completed" || task.assignedTo !== input.actorId || !task.receivedAt
      || task.claimId !== input.claimId || task.orderId !== input.orderId || task.orderItemId !== input.orderItemId
      || task.destinationVariantId !== input.variantId || task.station.assemblyBindings?.outputLocationId !== input.locationId
      || BigInt(input.quantity) > BigInt(task.outputQty) || input.producerOperationKeys.length === 0
      || input.producerOperationKeys.some((key) => key !== task.operationKey)) {
      throw new WarehouseWorkError("WORK_OUTPUT_PICK_FENCE_INVALID", "Output must belong to this completed job, location, order, and assigned assembler", 409);
    }
    await requireAssemblyOrderAuthority(client, { orderId: task.orderId, orderItemId: task.orderItemId, actorId: input.actorId, action: "complete" });
    const location = context.locations.find((row) => row.id === input.locationId && row.active);
    if (!location) throw new WarehouseWorkError("WORK_OUTPUT_LOCATION_MISSING", "Assembly output location is unavailable", 409);
    return { locationCode: location.code, zone: location.zone };
  }

  async context(client: PoolClient, warehouseId: number, actorId: string, area?: { stationId: string; locationIds?: number[] }) {
    const warehouse = await this.configuration.warehouse(client, warehouseId, false);
    if (!warehouse || !["operations", "bulk_storage"].includes(warehouse.type)) {
      throw new WarehouseWorkError("WORK_WAREHOUSE_NOT_INTERNAL", "Assembly work requires an internal warehouse", 409);
    }
    const actor = await this.actorReader(client, actorId);
    requireWorkPermission(actor, "view");
    const revision = await this.configuration.current(client, warehouseId);
    const stations = area ? revision.configuration.stations.filter((station) => station.id === area.stationId) : revision.configuration.stations;
    // At most the configured station anchors for a queue; one anchor plus exact
    // operation bindings for a command. Never lock every warehouse bin per gun tap.
    const locations = await this.configuration.locationsByIds(client, warehouseId,
      [...stations.map((station) => station.locationId), ...(area?.locationIds ?? [])]);
    return { warehouse, actor, revision, locations };
  }

  async authorizeTask(client: PoolClient, task: AssemblyTask, actorId: string, starting: boolean): Promise<void> {
    const context = await this.context(client, task.warehouseId, actorId, { stationId: task.station.id, locationIds: [task.station.locationId] });
    requireAssemblyScope(context.revision.configuration, context.actor, task.station, context.locations, "assembly");
    if (starting) {
      const liveStation = context.revision.configuration.stations.find((station) => station.id === task.station.id);
      if (!context.warehouse.active || !liveStation?.enabled || !liveStation.capabilities.includes("assembly")
        || liveStation.locationId !== task.station.locationId
        || !context.locations.some((location) => location.id === task.station.locationId && location.active)) {
        throw new WarehouseWorkError("WORK_STATION_NOT_ACCEPTING_WORK", "This station is not accepting new work", 409);
      }
    }
    // Pausing a station or changing the workflow profile cannot erase already
    // started physical work. Current employee permission/scope still applies.
  }

  async handoff(client: PoolClient, evidence: AssemblyHandoffEvidence): Promise<AssemblyTask> {
    if (evidence.route.warehouseId !== evidence.warehouseId) throw new WarehouseWorkError("WORK_WAREHOUSE_MISMATCH", "The selected route does not belong to the operation warehouse", 409);
    const context = await this.context(client, evidence.warehouseId, evidence.actorId, {
      stationId: evidence.route.stationId,
      locationIds: [...evidence.sourceLocationIds, ...(evidence.outputLocationId === null ? [] : [evidence.outputLocationId])],
    });
    if (!context.warehouse.active) throw new WarehouseWorkError("WORK_WAREHOUSE_INACTIVE", "This warehouse is not accepting work", 409);
    if (context.revision.revision !== evidence.route.configurationRevision) {
      throw new WarehouseWorkError("WORK_REVISION_CONFLICT", "Work routing changed. Review the current setup", 409);
    }
    const station = requireAssemblyRoute(context.revision.configuration, evidence.route.stationId,
      evidence.outputLocationId, evidence.sourceLocationIds, context.locations);
    requireAssemblyScope(context.revision.configuration, context.actor, station, context.locations, "picking");
    if (await this.tasks.byOperation(client, evidence.claimOperationId)) {
      throw new WarehouseWorkError("WORK_TASK_ALREADY_EXISTS", "This canonical operation already has a work item", 409);
    }
    const next = await this.tasks.create(client, {
      warehouseId: evidence.warehouseId, claimId: evidence.claimId, claimOperationId: evidence.claimOperationId,
      operationKey: evidence.operationKey, orderId: evidence.orderId, orderItemId: evidence.orderItemId,
      buildOrderId: evidence.buildOrderId, buildSystemNumber: evidence.buildSystemNumber,
      destinationVariantId: evidence.destinationVariantId, outputQty: evidence.outputQty, inputs: evidence.inputs,
      configurationRevision: context.revision.revision, station, profile: context.revision.configuration.profile,
      sentBy: evidence.actorId, sentAt: evidence.occurredAt,
    });
    await this.tasks.event(client, { ...evidence, previous: null, next, action: "queued" });
    return next;
  }

  /** Called AFTER inventory/cost posting, BEFORE the canonical transaction commits. */
  async recordCompletion(client: PoolClient, evidence: OwnerAudit & {
    claimOperationId: string; producedQty: string; fence?: AssemblyWorkFence;
  }): Promise<void> {
    const task = await this.tasks.byOperation(client, evidence.claimOperationId, false);
    if (!task) {
      if (evidence.fence) throw new WarehouseWorkError("WORK_TASK_NOT_FOUND", "Assembly job not found", 404);
      return; // Existing claim-only simulations are not automatically enrolled.
    }
    await this.authorizeTask(client, task, evidence.actorId, false);
    const locked = await this.tasks.byOperation(client, evidence.claimOperationId, true);
    if (!locked || locked.id !== task.id || locked.version !== task.version) {
      throw new WarehouseWorkError("WORK_TASK_VERSION_CONFLICT", "Assembly work changed while its fence was being acquired", 409);
    }
    const next = completeAssemblyTask(task, evidence.fence, evidence.actorId, evidence.producedQty, evidence.occurredAt);
    await this.tasks.update(client, task, next);
    await this.tasks.event(client, { ...evidence, previous: task, next, action: "completed" });
  }

  /** Claim release/replacement/count displacement all use this guard while holding the claim lock. */
  async cancelUnstarted(client: PoolClient, evidence: OwnerAudit & { claimId: string }): Promise<void> {
    const tasks = await this.tasks.forClaim(client, evidence.claimId);
    // Validate ALL jobs before changing any. A started/blocked job requires
    // physical recovery; device expiry and generic claim release cannot discard it.
    const changes = tasks.map((task) => ({ previous: task, next: cancelUnstartedAssembly(task) }));
    for (const change of changes) {
      if (change.next.version === change.previous.version) continue;
      await this.tasks.update(client, change.previous, change.next);
      await this.tasks.event(client, { ...evidence, ...change, action: "cancelled",
        commandKey: `${evidence.commandKey}:work:${change.next.id}` });
    }
  }
}
