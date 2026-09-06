import { createHash } from "node:crypto";
import { assemblyPackingCommandSchema, assemblyPackingReceiptSchema, assemblyPackingResultSchema } from "@shared/warehouse-assembly-packing";
import { workEvidenceIdSchema } from "@shared/warehouse-assembly-work";
import { lockPackingReadiness, packingReadinessBlockers, recordAssemblyPackingReady } from "../../../wms/assembly-packing-readiness";
import { lockPackingReplenishmentBlockers } from "../../../inventory/application/packing-replenishment-reader";
import { lockAssemblyClaimForWork } from "../../../inventory-planning/application/assembly-work-claim-access";
import { lockAssemblyPackingPickEvidence } from "../../../inventory-planning/application/assembly-packing-claim-reader";
import { requireAssemblyScope } from "../domain/assembly-work";
import { WarehouseWorkError } from "../domain/work-configuration";
import { AssemblyPackingRepository } from "../infrastructure/assembly-packing.repository";
import { AssemblyWorkOwner } from "./assembly-work-owner";

export class AssemblyPackingService {
  constructor(private readonly owner: AssemblyWorkOwner, private readonly receipts: AssemblyPackingRepository, private readonly clock: () => Date) {}

  async ready(actorId: string, rawTaskId: unknown, rawCommand: unknown) {
    const taskId = workEvidenceIdSchema.parse(rawTaskId);
    const command = assemblyPackingCommandSchema.parse(rawCommand);
    const requestHash = createHash("sha256").update(JSON.stringify({ actorId, taskId, command })).digest("hex");
    const occurredAt = this.clock();
    return this.owner.configuration.transaction(async (client) => {
      const preliminary = await this.owner.tasks.byId(client, taskId);
      if (!preliminary) throw new WarehouseWorkError("WORK_TASK_NOT_FOUND", "Assembly job not found", 404);
      const evidence = await lockPackingReadiness(client, preliminary.orderId);
      const claim = await lockAssemblyClaimForWork(client, preliminary.claimId);
      const taskLine = evidence.items.find((item) => item.id === preliminary.orderItemId);
      const canonicalPickComplete = taskLine && taskLine.quantity > 0
        ? await lockAssemblyPackingPickEvidence(client, { claimId: preliminary.claimId, orderItemId: taskLine.id, quantity: taskLine.quantity }) : false;
      const replenIds = await lockPackingReplenishmentBlockers(client, preliminary.orderId);
      const context = await this.owner.context(client, preliminary.warehouseId, actorId, { stationId: preliminary.station.id });
      requireAssemblyScope(context.revision.configuration, context.actor, preliminary.station, context.locations, "assembly");
      requireAssemblyScope(context.revision.configuration, context.actor, preliminary.station, context.locations, "packing");
      const task = await this.owner.tasks.byId(client, taskId, true);
      const replay = await this.receipts.replay(client, command.commandId, requestHash);
      if (replay) return assemblyPackingResultSchema.parse({ receipt: replay, idempotentReplay: true });
      if (!task || task.version !== command.expectedVersion || task.version !== preliminary.version)
        throw new WarehouseWorkError("WORK_TASK_VERSION_CONFLICT", "Assembly job changed; reload", 409);
      if (!claim.active || task.state !== "completed" || task.assignedTo !== actorId || !task.receivedAt)
        throw new WarehouseWorkError("WORK_PACKING_NOT_READY", "The assigned assembler must finish the active job first", 409);
      if (!canonicalPickComplete) throw new WarehouseWorkError("WORK_CANONICAL_PICK_INCOMPLETE", "The assembly line's canonical pick evidence is incomplete or changed", 409);
      if (task.profile.assemblyPacking !== "combined" || !task.station.capabilities.includes("packing"))
        throw new WarehouseWorkError("WORK_PACKING_ROUTE_UNSUPPORTED", "This action supports the combined assembly/packing area; a separate custody handoff is not connected", 409);
      const blockers = packingReadinessBlockers(evidence, task.warehouseId, task.orderItemId, replenIds);
      if (blockers.length) throw new WarehouseWorkError("WORK_PACKING_BLOCKED", blockers.join("; "), 409, { blockers });
      const receipt = assemblyPackingReceiptSchema.parse({ commandId: command.commandId, taskId, orderId: task.orderId,
        warehouseId: task.warehouseId, actorId, readyAt: occurredAt.toISOString(), status: "ready_to_ship", packingUrl: `/packing?orderId=${task.orderId}` });
      await recordAssemblyPackingReady(client, evidence, () => occurredAt);
      await this.receipts.insert(client, { receipt, requestHash, reason: command.reason, beforeStatus: evidence.order.warehouse_status });
      return assemblyPackingResultSchema.parse({ receipt, idempotentReplay: false });
    });
  }
}
