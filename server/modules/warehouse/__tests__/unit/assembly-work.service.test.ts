import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { AssemblyWorkOwner } from "../../work/application/assembly-work-owner";
import { AssemblyWorkService } from "../../work/application/assembly-work.service";
import { AssemblyWorkRepository } from "../../work/infrastructure/assembly-work.repository";
import { WorkConfigurationRepository } from "../../work/infrastructure/work-configuration.repository";
import { WarehouseWorkError } from "../../work/domain/work-configuration";
import { transitionAssemblyTask } from "../../work/domain/assembly-work";
import { config, fence, locations, start, STATION, task, TIME } from "../assembly-work.fixture";

function harness() {
  const sequence: string[] = [];
  const query = vi.fn(async (sql: string) => {
    sequence.push(sql);
    if (sql.includes("FROM wms.orders")) return { rows: [{ warehouse_status: "in_progress", on_hold: 0 }] };
    if (sql.includes("FROM wms.order_items")) return { rows: [{ status: "pending", on_hold: 0, requires_shipping: 1 }] };
    return { rows: sql.includes("availability_claims") ? [{ status: "active" }] : [] };
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const repository = new WorkConfigurationRepository({ connect: vi.fn(async () => client) } as unknown as Pool);
  const configuration = config();
  vi.spyOn(repository, "warehouse").mockImplementation(async () => { sequence.push("warehouse"); return { id: 1, code: "LOCAL", name: "Local", active: true, type: "operations" }; });
  vi.spyOn(repository, "current").mockImplementation(async () => ({ warehouseId: 1, revision: 1, configuration, executionStatus: "explicit_handoff_only", savedAt: TIME, savedBy: "admin", reason: "Setup" }));
  vi.spyOn(repository, "locationsByIds").mockResolvedValue(locations);
  const tasks = new AssemblyWorkRepository();
  vi.spyOn(tasks, "byId").mockImplementation(async (_client, _id, lock) => { sequence.push(lock ? "task_lock" : "task_read"); return task(); });
  vi.spyOn(tasks, "byOperation").mockResolvedValue(null);
  vi.spyOn(tasks, "forClaim").mockResolvedValue([task()]);
  vi.spyOn(tasks, "queue").mockResolvedValue([task()]);
  vi.spyOn(tasks, "create").mockImplementation(async (_client, next) => ({ ...task(), ...next, id: "1" }));
  vi.spyOn(tasks, "update").mockResolvedValue(undefined);
  vi.spyOn(tasks, "event").mockResolvedValue(undefined);
  vi.spyOn(tasks, "replay").mockResolvedValue(null);
  const identity = vi.fn(async (_client: PoolClient, id: string) => {
    sequence.push("identity");
    return { id, active: true, permissions: ["warehouse_work:view", "warehouse_work:picking", "warehouse_work:assembly"] };
  });
  const owner = new AssemblyWorkOwner(repository, tasks, identity);
  const claims = { handoffBuildOperation: vi.fn(), executeBuildOperation: vi.fn() };
  const service = new AssemblyWorkService(owner, () => new Date(TIME), claims);
  return { owner, service, tasks, repository, client, query, sequence, configuration, identity, claims };
}
function handoffEvidence() {
  return { warehouseId: 1, claimId: "9", claimOperationId: "10", operationKey: "build:10", orderId: 70, orderItemId: 71,
    buildOrderId: 91, buildSystemNumber: "BLD-00000091", destinationVariantId: 105, outputQty: "2", outputLocationId: 3,
    inputs: [{ variantId: 101, quantity: "10" }], sourceLocationIds: [2], actorId: "picker", reason: "Send work",
    commandKey: "handoff:one", requestHash: "a".repeat(64), occurredAt: TIME,
    route: { warehouseId: 1, stationId: STATION, configurationRevision: 1, acknowledgeWorkOnlyHandoff: true as const } };
}
describe("assembly work application boundary", () => {
  it("locks the claim before identity/task locks and commits start plus immutable receipt together", async () => {
    const h = harness(); const result = await h.service.command("assembler", "1", start());
    expect(result).toMatchObject({ task: { assignedTo: "assembler", version: 2 }, idempotentReplay: false });
    expect(h.sequence.indexOf("identity")).toBeGreaterThan(h.sequence.findIndex((entry) => entry.includes("availability_claims")));
    expect(h.sequence.findIndex((entry) => entry.includes("availability_claims"))).toBeGreaterThan(h.sequence.findIndex((entry) => entry.includes("FROM wms.order_items")));
    expect(h.sequence.indexOf("task_lock")).toBeGreaterThan(h.sequence.indexOf("identity"));
    expect(h.tasks.update).toHaveBeenCalledWith(h.client, task(), result.task);
    expect(h.tasks.event).toHaveBeenCalledWith(h.client, expect.objectContaining({ actorId: "assembler", previous: task(), next: result.task }));
    expect(h.sequence.at(-1)).toBe("COMMIT"); expect(h.client.release).toHaveBeenCalledOnce();
  });
  it("returns the persisted receipt on replay without changing the task", async () => {
    const h = harness(); const result = transitionAssemblyTask(task(), start(), "assembler", TIME);
    vi.mocked(h.tasks.replay).mockResolvedValue(result);
    await expect(h.service.command("assembler", "1", start())).resolves.toEqual({ task: result, idempotentReplay: true });
    expect(h.tasks.update).not.toHaveBeenCalled(); expect(h.tasks.event).not.toHaveBeenCalled();
  });
  it("rolls back a state update when event persistence fails", async () => {
    const h = harness(); vi.mocked(h.tasks.event).mockRejectedValue(new Error("event store unavailable"));
    await expect(h.service.command("assembler", "1", start())).rejects.toThrow("event store unavailable");
    expect(h.sequence.at(-1)).toBe("ROLLBACK"); expect(h.sequence).not.toContain("COMMIT");
  });
  it("does not let a paused station receive NEW responsibility", async () => {
    const h = harness(); h.configuration.stations[0].enabled = false;
    await expect(h.service.command("assembler", "1", start())).rejects.toMatchObject({ code: "WORK_STATION_NOT_ACCEPTING_WORK" });
    expect(h.tasks.update).not.toHaveBeenCalled();
  });
  it("allows already-started completion at a paused station, with current permission", async () => {
    const h = harness(); h.configuration.stations[0].enabled = false;
    vi.mocked(h.tasks.byOperation).mockResolvedValue(transitionAssemblyTask(task(), start(), "assembler", TIME));
    await h.owner.recordCompletion(h.client, { claimOperationId: "10", producedQty: "2", fence: fence(), actorId: "assembler",
      reason: "Physically built", commandKey: "complete:one", requestHash: "b".repeat(64), occurredAt: TIME });
    expect(h.tasks.update).toHaveBeenCalledWith(h.client, expect.anything(), expect.objectContaining({ state: "completed" }));
  });
  it("does not bypass the employee fence when an internal caller omits work", async () => {
    const h = harness(); vi.mocked(h.tasks.byOperation).mockResolvedValue(task());
    await expect(h.owner.recordCompletion(h.client, { claimOperationId: "10", producedQty: "2", actorId: "assembler",
      reason: "Bypass", commandKey: "complete:one", requestHash: "b".repeat(64), occurredAt: TIME })).rejects.toMatchObject({ code: "WORK_TASK_FENCE_REQUIRED" });
    expect(h.tasks.update).not.toHaveBeenCalled();
  });
  it("creates one queued job from owner evidence, retaining the exact profile and no receipt assumption", async () => {
    const h = harness(); const result = await h.owner.handoff(h.client, handoffEvidence());
    expect(result).toMatchObject({ state: "queued", receivedAt: null, assignedTo: null, outputQty: "2", profile: config().profile });
    expect(h.tasks.event).toHaveBeenCalledWith(h.client, expect.objectContaining({ previous: null, next: result, action: "queued" }));
  });
  it.each(["warehouse", "revision", "duplicate", "permission"])("rejects invalid handoff %s without task creation", async (invalid) => {
    const h = harness(); const evidence = handoffEvidence();
    if (invalid === "warehouse") evidence.route.warehouseId = 2;
    if (invalid === "revision") evidence.route.configurationRevision = 2;
    if (invalid === "duplicate") vi.mocked(h.tasks.byOperation).mockResolvedValue(task());
    if (invalid === "permission") h.identity.mockResolvedValue({ id: "picker", active: true, permissions: ["warehouse_work:view"] });
    await expect(h.owner.handoff(h.client, evidence)).rejects.toBeInstanceOf(WarehouseWorkError);
    expect(h.tasks.create).not.toHaveBeenCalled();
  });
  it("blocks all cancellation changes if ANY task has started physical work", async () => {
    const h = harness(); vi.mocked(h.tasks.forClaim).mockResolvedValue([task(), transitionAssemblyTask(task({ id: "2" }), start(), "assembler", TIME)]);
    await expect(h.owner.cancelUnstarted(h.client, { claimId: "9", actorId: "system:cancel", reason: "Order cancellation",
      commandKey: "release:one", requestHash: "c".repeat(64), occurredAt: TIME })).rejects.toMatchObject({ code: "WORK_PHYSICAL_RECOVERY_REQUIRED" });
    expect(h.tasks.update).not.toHaveBeenCalled();
  });
  it("filters station scope before executing a bounded, server-side queue query", async () => {
    const h = harness(); h.configuration.access[1].scope = { kind: "zone", zone: "OTHER" };
    await h.service.queue("assembler", { warehouseId: 1, limit: 20 });
    expect(h.tasks.queue).toHaveBeenCalledWith(h.client, { warehouseId: 1, limit: 20, includeClosed: false, stationIds: [] });
  });
  it("ends replay-authorization reads before entering the canonical handoff owner", async () => {
    const h = harness(); h.claims.handoffBuildOperation.mockImplementation(async (command) => {
      expect(h.sequence.at(-1)).toBe("COMMIT"); return command;
    });
    await h.service.handoff("picker", { claimId: "9", operationKey: "build:10", commandId: start().commandId,
      route: handoffEvidence().route, reason: "Hand off work" });
    expect(h.claims.handoffBuildOperation).toHaveBeenCalledWith(expect.objectContaining({ actor: "picker", work: handoffEvidence().route }));
  });
  it("loads immutable owner identity for completion and rejects a different job fence", async () => {
    const h = harness();
    await expect(h.service.complete("assembler", "1", { commandId: start().commandId, reason: "Complete", fence: { ...fence(), taskId: "2" } }))
      .rejects.toMatchObject({ code: "WORK_TASK_FENCE_MISMATCH" });
    expect(h.claims.executeBuildOperation).not.toHaveBeenCalled();
    await h.service.complete("assembler", "1", { commandId: start().commandId, reason: "Complete", fence: fence() });
    expect(h.claims.executeBuildOperation).toHaveBeenCalledWith(expect.objectContaining({ claimId: "9", operationKey: "build:10", actor: "assembler", work: fence() }));
  });
});
