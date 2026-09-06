import {
  assemblyTaskSchema, type AssemblyTask, type AssemblyTaskCommand, type AssemblyWorkFence,
} from "@shared/warehouse-assembly-work";
import type { WorkConfiguration, WorkStation } from "@shared/warehouse-work";
import { requireWorkPermission, WarehouseWorkError, type WorkActor, type WorkLocation } from "./work-configuration";

export function requireAssemblyScope(
  configuration: WorkConfiguration, actor: WorkActor, station: WorkStation,
  locations: readonly WorkLocation[], capability: "assembly" | "picking" | "packing",
): void {
  requireWorkPermission(actor, "view");
  requireWorkPermission(actor, capability);
  // Canonical audit principals are varchar(100). Never let an identity start
  // physical work which its inventory owner cannot subsequently record.
  if (actor.id.length > 100 || actor.id.trim() !== actor.id || actor.id.length === 0) {
    throw new WarehouseWorkError("WORK_ACTOR_IDENTIFIER_UNSUPPORTED", "This employee identifier is incompatible with canonical inventory audit records", 409);
  }
  const access = configuration.access.find((row) => row.userId === actor.id);
  const location = locations.find((row) => row.id === station.locationId);
  if (!access?.capabilities.includes(capability) || !location
    || (access.scope.kind === "zone" && access.scope.zone !== location.zone)
    || (access.scope.kind === "stations" && !access.scope.stationIds.includes(station.id))) {
    throw new WarehouseWorkError("WORK_SCOPE_DENIED", "This employee is not eligible for this work area", 403);
  }
}

export function requireAssemblyRoute(
  configuration: WorkConfiguration, stationId: string, outputLocationId: number | null,
  sourceLocationIds: readonly number[], locations: readonly WorkLocation[],
): WorkStation {
  const station = configuration.stations.find((row) => row.id === stationId);
  if (!station?.enabled || !station.capabilities.includes("assembly")
    || !locations.some((row) => row.id === station.locationId && row.active)) {
    throw new WarehouseWorkError("WORK_ASSEMBLY_STATION_INVALID", "Choose an enabled assembly station in this warehouse", 422);
  }
  // Handoff is work-only. Routing must not silently move claimed materials or
  // relocate planned output; a material transfer requires its inventory owner.
  const bindings = station.assemblyBindings;
  if (!bindings || outputLocationId !== bindings.outputLocationId || sourceLocationIds.length === 0
    || sourceLocationIds.some((id) => !bindings.materialLocationIds.includes(id))
    || [...sourceLocationIds, bindings.outputLocationId].some((id) => !locations.some((row) => row.id === id && row.active))) {
    throw new WarehouseWorkError("WORK_MATERIAL_LOCATION_MISMATCH",
      "The claim's materials and output must match this station's explicit location bindings; reconcile the inventory plan first", 409);
  }
  if (configuration.profile.assignment !== "claim_on_start") {
    throw new WarehouseWorkError("WORK_DISPATCH_ASSIGNMENT_NOT_CONNECTED", "Dispatcher assignment is not connected for assembly yet", 409);
  }
  return station;
}

function requireVersion(task: AssemblyTask, expectedVersion: number): void {
  if (task.version !== expectedVersion) {
    throw new WarehouseWorkError("WORK_TASK_VERSION_CONFLICT", "This job changed. Reload before continuing", 409, { currentVersion: task.version });
  }
  if (task.version >= 2_147_483_646) throw new WarehouseWorkError("WORK_TASK_VERSION_EXHAUSTED", "Job revision limit reached; supervisor review required", 409);
}

export function transitionAssemblyTask(
  task: AssemblyTask, command: AssemblyTaskCommand, actorId: string, occurredAt: string,
): AssemblyTask {
  requireVersion(task, command.expectedVersion);
  if (["completed", "cancelled"].includes(task.state)) {
    throw new WarehouseWorkError("WORK_TASK_CLOSED", "This job is already closed", 409);
  }
  const next = { ...task, version: task.version + 1 };
  if (command.action === "start") {
    if (task.state !== "queued" || task.assignedTo !== null || task.startedAt !== null) {
      throw new WarehouseWorkError("WORK_TASK_ALREADY_TAKEN", "Another employee has taken responsibility for this job", 409);
    }
    if (command.receivedBuildSystemNumber !== task.buildSystemNumber) {
      throw new WarehouseWorkError("WORK_HANDOFF_MISMATCH", "The received job does not match this build ticket", 409);
    }
    return assemblyTaskSchema.parse({ ...next, state: "in_progress", assignedTo: actorId,
      startedAt: occurredAt, receivedAt: occurredAt, receivedBy: actorId });
  }
  if (task.assignedTo !== actorId) {
    throw new WarehouseWorkError("WORK_TASK_NOT_ASSIGNED_TO_ACTOR", "Only the assigned employee can update this job", 403);
  }
  if (command.action === "block" && task.state === "in_progress") {
    return assemblyTaskSchema.parse({ ...next, state: "blocked", blockedReason: command.reason });
  }
  if (command.action === "resume" && task.state === "blocked") {
    return assemblyTaskSchema.parse({ ...next, state: "in_progress", blockedReason: null });
  }
  throw new WarehouseWorkError("WORK_TASK_TRANSITION_INVALID", "This action is not valid for the current job state", 409);
}

export function completeAssemblyTask(
  task: AssemblyTask, fence: AssemblyWorkFence | undefined, actorId: string, producedQty: string, occurredAt: string,
): AssemblyTask {
  if (!fence || fence.taskId !== task.id) throw new WarehouseWorkError("WORK_TASK_FENCE_REQUIRED", "Assembly completion requires the exact job and revision", 409);
  requireVersion(task, fence.expectedVersion);
  if (task.assignedTo !== actorId) throw new WarehouseWorkError("WORK_TASK_NOT_ASSIGNED_TO_ACTOR", "Only the assigned employee can complete assembly", 403);
  if (task.state !== "in_progress" || task.receivedBy !== actorId || !task.receivedAt) {
    throw new WarehouseWorkError("WORK_TASK_NOT_STARTED", "Receive and start this job before completing assembly", 409);
  }
  if (producedQty !== task.outputQty || fence.completedOutputQty !== task.outputQty) {
    throw new WarehouseWorkError("WORK_PARTIAL_ASSEMBLY_REQUIRES_REVIEW", "This owner command posts the entire build. Block incomplete work; do not report it complete", 409);
  }
  return assemblyTaskSchema.parse({ ...task, version: task.version + 1, state: "completed", completedAt: occurredAt });
}

export function cancelUnstartedAssembly(task: AssemblyTask): AssemblyTask {
  if (task.state === "completed" || task.state === "cancelled") return task;
  if (task.startedAt !== null || task.assignedTo !== null) {
    throw new WarehouseWorkError("WORK_PHYSICAL_RECOVERY_REQUIRED",
      "Assembly has started. Resolve the physical work before releasing or replacing its inventory claim", 409, { taskId: task.id });
  }
  requireVersion(task, task.version);
  return assemblyTaskSchema.parse({ ...task, state: "cancelled", version: task.version + 1 });
}
