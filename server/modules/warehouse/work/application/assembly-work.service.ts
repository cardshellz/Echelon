import { createHash } from "node:crypto";
import {
  assemblyQueueRequestSchema, assemblyQueueSchema, assemblyTaskCommandSchema, assemblyTaskResultSchema,
  workEvidenceIdSchema, type AssemblyTask, type AssemblyTaskResult,
  createAssemblyHandoffSchema, completeAssemblyTaskSchema,
} from "@shared/warehouse-assembly-work";
import { lockAssemblyClaimForWork } from "../../../inventory-planning/application/assembly-work-claim-access";
import { lockAssemblyOrderForWork } from "../../../orders/assembly-work-order-lock";
import { requireAssemblyScope, transitionAssemblyTask } from "../domain/assembly-work";
import { requireWorkPermission, WarehouseWorkError } from "../domain/work-configuration";
import { AssemblyWorkOwner } from "./assembly-work-owner";
import type { InventoryAvailabilityClaimService } from "../../../inventory-planning/application/inventory-availability-claim.service";

export class AssemblyWorkService {
  constructor(
    private readonly owner: AssemblyWorkOwner, private readonly clock: () => Date,
    private readonly claims: Pick<InventoryAvailabilityClaimService, "handoffBuildOperation" | "executeBuildOperation">,
  ) {}

  async handoff(actorId: string, rawRequest: unknown) {
    const input = createAssemblyHandoffSchema.parse(rawRequest);
    // Authorize receipt replay too; this read transaction ends before the
    // canonical transaction starts, so it cannot invert owner lock order.
    await this.owner.configuration.transaction(async (client) => {
      const context = await this.owner.context(client, input.route.warehouseId, actorId, { stationId: input.route.stationId });
      const station = context.revision.configuration.stations.find((row) => row.id === input.route.stationId);
      if (!station) throw new WarehouseWorkError("WORK_ASSEMBLY_STATION_INVALID", "Assembly station not found", 404);
      requireAssemblyScope(context.revision.configuration, context.actor, station, context.locations, "picking");
    });
    return this.claims.handoffBuildOperation({
      claimId: input.claimId, operationKey: input.operationKey, actor: actorId,
      idempotencyKey: `work-handoff:${input.commandId}`, reason: input.reason, work: input.route,
    });
  }

  async complete(actorId: string, rawId: unknown, rawRequest: unknown) {
    const id = workEvidenceIdSchema.parse(rawId);
    const input = completeAssemblyTaskSchema.parse(rawRequest);
    if (input.fence.taskId !== id) throw new WarehouseWorkError("WORK_TASK_FENCE_MISMATCH", "The completion fence belongs to another job", 400);
    const task = await this.get(actorId, id);
    return this.claims.executeBuildOperation({
      claimId: task.claimId, operationKey: task.operationKey, actor: actorId,
      idempotencyKey: `work-complete:${input.commandId}`, reason: input.reason, work: input.fence,
    });
  }

  async queue(actorId: string, rawRequest: unknown) {
    const request = assemblyQueueRequestSchema.parse(rawRequest);
    return this.owner.configuration.transaction(async (client) => {
      const context = await this.owner.context(client, request.warehouseId, actorId);
      requireWorkPermission(context.actor, "assembly");
      const stationIds = context.revision.configuration.stations.filter((station) => {
        if (request.stationId && station.id !== request.stationId) return false;
        try {
          requireAssemblyScope(context.revision.configuration, context.actor, station, context.locations, "assembly");
          return true;
        } catch (error) {
          if (error instanceof WarehouseWorkError && error.code === "WORK_SCOPE_DENIED") return false;
          throw error;
        }
      }).map((station) => station.id);
      const tasks = await this.owner.tasks.queue(client, { ...request, stationIds });
      return assemblyQueueSchema.parse({ tasks, nextBeforeId: tasks.length === request.limit ? tasks.at(-1)!.id : null });
    });
  }

  async get(actorId: string, rawId: unknown): Promise<AssemblyTask> {
    const id = workEvidenceIdSchema.parse(rawId);
    return this.owner.configuration.transaction(async (client) => {
      const task = await this.owner.tasks.byId(client, id);
      if (!task) throw new WarehouseWorkError("WORK_TASK_NOT_FOUND", "Assembly job not found", 404);
      await this.owner.authorizeTask(client, task, actorId, false);
      return task;
    });
  }

  async command(actorId: string, rawId: unknown, rawCommand: unknown): Promise<AssemblyTaskResult> {
    const id = workEvidenceIdSchema.parse(rawId);
    const command = assemblyTaskCommandSchema.parse(rawCommand);
    const commandKey = `work:${command.commandId}`;
    const requestHash = createHash("sha256").update(JSON.stringify({ actorId, taskId: id, command })).digest("hex");
    const occurredAt = this.clock().toISOString();
    return this.owner.configuration.transaction(async (client) => {
      const preliminary = await this.owner.tasks.byId(client, id);
      if (!preliminary) throw new WarehouseWorkError("WORK_TASK_NOT_FOUND", "Assembly job not found", 404);
      // Match canonical owner order: WMS order/item -> claim -> work context ->
      // task. Standalone work commands never acquire graph/inventory locks.
      const order = await lockAssemblyOrderForWork(client, preliminary);
      const claim = await lockAssemblyClaimForWork(client, preliminary.claimId);
      await this.owner.authorizeTask(client, preliminary, actorId, false);
      const replay = await this.owner.tasks.replay(client, commandKey, requestHash);
      if (replay) return assemblyTaskResultSchema.parse({ task: replay, idempotentReplay: true });
      if (!claim.active) throw new WarehouseWorkError("WORK_CLAIM_NOT_ACTIVE", "This assembly job no longer has an active inventory claim", 409);
      if (command.action !== "block" && !order.executable) {
        throw new WarehouseWorkError("WORK_ORDER_NOT_EXECUTABLE", "This order or item cannot start or resume assembly; resolve its hold or terminal state first", 409);
      }
      const task = await this.owner.tasks.byId(client, id, true);
      if (!task || task.claimId !== preliminary.claimId) throw new WarehouseWorkError("WORK_TASK_CHANGED", "Assembly job changed", 409);
      if (command.action === "start") await this.owner.authorizeTask(client, task, actorId, true);
      const next = transitionAssemblyTask(task, command, actorId, occurredAt);
      await this.owner.tasks.update(client, task, next);
      await this.owner.tasks.event(client, { previous: task, next, action: command.action,
        commandKey, requestHash, actorId, reason: command.reason, occurredAt });
      return assemblyTaskResultSchema.parse({ task: next, idempotentReplay: false });
    });
  }
}
