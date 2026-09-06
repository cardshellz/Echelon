import { smallTeamProfile, type WorkConfiguration } from "@shared/warehouse-work";
import type { AssemblyTask, AssemblyTaskCommand, AssemblyWorkFence } from "@shared/warehouse-assembly-work";
export const TIME = "2026-09-06T12:00:00.000Z";
export const STATION = "00000000-0000-4000-8000-000000000001";
export const COMMAND = "00000000-0000-4000-8000-000000000002";
export const locations = [
  { id: 1, code: "BENCH", zone: "PACK", active: true },
  { id: 2, code: "MATERIALS", zone: "PACK", active: true },
  { id: 3, code: "FINISHED", zone: "PACK", active: true },
];
export function task(overrides: Partial<AssemblyTask> = {}): AssemblyTask {
  return { id: "1", warehouseId: 1, claimId: "9", claimOperationId: "10", operationKey: "build:10",
    orderId: 70, orderItemId: 71, buildOrderId: 91, buildSystemNumber: "BLD-00000091",
    destinationVariantId: 105, outputQty: "2", inputs: [{ variantId: 101, quantity: "10" }],
    configurationRevision: 1, station: { id: STATION, code: "ASSEMBLY", name: "Assembly & Pack", locationId: 1,
      capabilities: ["assembly", "packing"], enabled: true, assemblyBindings: { materialLocationIds: [2], outputLocationId: 3 } },
    profile: smallTeamProfile(), state: "queued", version: 1, assignedTo: null, startedAt: null,
    completedAt: null, blockedReason: null, sentBy: "picker", sentAt: TIME, receivedBy: null, receivedAt: null,
    ...overrides };
}
export function config(): WorkConfiguration {
  return { profile: smallTeamProfile(), stations: [task().station], access: [
    { userId: "picker", capabilities: ["picking"], scope: { kind: "warehouse" } },
    { userId: "assembler", capabilities: ["assembly"], scope: { kind: "warehouse" } },
    { userId: "other", capabilities: ["assembly"], scope: { kind: "warehouse" } },
  ] };
}
export function start(): AssemblyTaskCommand {
  return { action: "start", commandId: COMMAND, expectedVersion: 1, reason: "Received label and work instructions",
    receivedBuildSystemNumber: task().buildSystemNumber, confirmPhysicalHandoff: true };
}
export function fence(): AssemblyWorkFence {
  return { taskId: "1", expectedVersion: 2, completedOutputQty: "2", confirmPhysicalAssembly: true };
}
