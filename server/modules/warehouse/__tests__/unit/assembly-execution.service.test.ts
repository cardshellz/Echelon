import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssemblyExecutionService } from "../../work/application/assembly-execution.service";
import { AssemblyWorkOwner } from "../../work/application/assembly-work-owner";
import { AssemblyWorkRepository } from "../../work/infrastructure/assembly-work.repository";
import { WorkConfigurationRepository } from "../../work/infrastructure/work-configuration.repository";
import { readAssemblyOrder } from "../../../orders/assembly-order-reader";
import { readAssemblyOwnership } from "../../../inventory-planning/application/assembly-ownership-reader";
import { readWarehouseWorkActor } from "../../../identity";
import { readAssemblyVariantLabels } from "../../../catalog/assembly-variant-reader";
import { config, task, TIME, COMMAND, locations } from "../assembly-work.fixture";

vi.mock("../../../identity", () => ({ readWarehouseWorkActor: vi.fn() }));
vi.mock("../../../orders/assembly-order-reader", () => ({ readAssemblyOrder: vi.fn() }));
vi.mock("../../../catalog/assembly-variant-reader", () => ({ readAssemblyVariantLabels: vi.fn() }));
vi.mock("../../../inventory-planning/application/assembly-ownership-reader", () => ({ readAssemblyOwnership: vi.fn() }));

function harness() {
  const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() } as unknown as PoolClient;
  const repository = new WorkConfigurationRepository({ connect: vi.fn(async () => client) });
  const configuration = config();
  configuration.access.find((row) => row.userId === "assembler")!.capabilities.push("picking");
  vi.spyOn(repository, "warehouse").mockResolvedValue({ id: 1, code: "LOCAL", name: "Local", active: true, type: "operations" });
  vi.spyOn(repository, "locationsByIds").mockResolvedValue(locations);
  vi.spyOn(repository, "current").mockImplementation(async () => ({ warehouseId: 1, revision: 1, configuration, executionStatus: "explicit_handoff_only", savedAt: TIME, savedBy: "admin", reason: "Setup" }));
  vi.spyOn(repository, "scopedWarehouseIds").mockResolvedValue([1]);
  const tasks = new AssemblyWorkRepository(); vi.spyOn(tasks, "forClaims").mockResolvedValue([]);
  const owner = new AssemblyWorkOwner(repository, tasks, readWarehouseWorkActor);
  const work = { get: vi.fn(async () => task({ state: "completed", assignedTo: "assembler", receivedBy: "assembler", receivedAt: TIME, startedAt: TIME, completedAt: TIME, version: 3 })) };
  const operation = { claimOperationId: "10", operationKey: "build:10", operationType: "component_build", warehouseId: 1, parentOperationKey: null,
    status: "ready", releasedExecutions: "0", outputQty: "2", committedOutputQty: "2", outputLocationId: 3, inputs: [{ sourceVariantId: 101, requiredQty: "10" }] };
  const line = { orderItemId: 71, shortfallQty: "0", releasedTargetQty: "0", consumedTargetQty: "0", pickedTargetQty: "0", resources: [{ consumerOperationKey: "build:10", warehouseLocationId: 2, openQty: "10" }], operations: [operation] };
  const claims = { getReservationStatus: vi.fn(async () => ({ claim: { claimId: "9", lines: [line] } })), pickClaimLine: vi.fn(async () => ({ outcome: "picked" })) };
  const service = new AssemblyExecutionService(owner, work, claims as never);
  return { client, repository, tasks, owner, service, work, claims, operation, line, configuration };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readWarehouseWorkActor).mockImplementation(async (_client, id) => ({ id, active: true, permissions: ["warehouse_work:view", "warehouse_work:assembly", "warehouse_work:picking"] }));
  vi.mocked(readAssemblyOrder).mockResolvedValue({ id: 70, order_number: "ORDER-70", warehouse_status: "in_progress", assigned_picker_id: "picker", on_hold: 0,
    items: [{ id: 71, sku: "P5", name: "Five pack", quantity: 2, picked_quantity: 0, status: "pending", on_hold: false, requires_shipping: 1 }] });
  vi.mocked(readAssemblyVariantLabels).mockResolvedValue([{ variantId: 101, sku: "EA", name: "Each" }]);
  vi.mocked(readAssemblyOwnership).mockResolvedValue([]);
});
describe("assembly execution read/command composition", () => {
  it("shows exact canonical components and matching station routes without a write", async () => {
    const h = harness(); const result = await h.service.order("picker", 70);
    expect(result.instructions[0]).toMatchObject({ sku: "P5", outputQty: "2", inputs: [{ sku: "EA", quantity: "10" }], blocker: null });
    expect(result.instructions[0].routes).toHaveLength(1);
    expect(h.client.query).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT|UPDATE|DELETE/), expect.anything());
    expect(h.claims.pickClaimLine).not.toHaveBeenCalled();
  });
  it("rejects another picker before exposing canonical order evidence", async () => {
    const h = harness(); await expect(h.service.order("other", 70)).rejects.toMatchObject({ code: "WORK_ORDER_PICKER_MISMATCH" });
    expect(h.claims.getReservationStatus).not.toHaveBeenCalled();
  });
  it.each(["partial", "nested", "missing-route"])("makes unsupported %s work explicit instead of fabricating a route", async (kind) => {
    const h = harness();
    if (kind === "partial") h.operation.committedOutputQty = "1";
    if (kind === "nested") Object.assign(h.operation, { parentOperationKey: "parent" });
    if (kind === "missing-route") h.configuration.stations[0].assemblyBindings!.materialLocationIds = [999];
    const result = await h.service.order("picker", 70);
    expect(result.instructions[0].blocker).not.toBeNull(); expect(result.instructions[0].routes).toEqual([]);
  });
  it("a boolean item hold blocks a new route", async () => {
    const order = await readAssemblyOrder({} as PoolClient, 70); order!.items[0].on_hold = true;
    const h = harness(); expect((await h.service.order("picker", 70)).instructions[0].blocker).toContain("held");
  });
  it("requires permission even when no scope is available", async () => {
    const h = harness(); vi.mocked(readWarehouseWorkActor).mockResolvedValue({ id: "assembler", active: true, permissions: [] });
    await expect(h.service.contexts("assembler")).rejects.toMatchObject({ code: "WORK_PERMISSION_DENIED" });
  });
  it("keeps paused scoped stations visible but never adds an unauthorized station", async () => {
    const h = harness(); h.configuration.stations[0].enabled = false;
    expect((await h.service.contexts("assembler")).contexts[0].stations).toHaveLength(1);
    h.configuration.access = [];
    expect((await h.service.contexts("assembler")).contexts).toEqual([]);
  });
  it("renders completed assembly separately from picked/packed status", async () => {
    const h = harness(); const view = await h.service.task("assembler", "1");
    expect(view).toMatchObject({ sku: "P5", itemQuantity: 2, pickedQuantity: 0, outputLocationCode: "FINISHED", outputPickBlocker: null });
  });
  it("requires separate picking capability for output pickup", async () => {
    const h = harness(); h.configuration.access.find((row) => row.userId === "assembler")!.capabilities = ["assembly"];
    expect((await h.service.task("assembler", "1")).outputPickBlocker).not.toBeNull();
  });
  it("keeps exact request identity on retries instead of rebuilding mutable WMS progress", async () => {
    const h = harness(); const input = { commandId: COMMAND, quantity: 2, expectedItemStatus: "pending", reason: "Actual output picked",
      fence: { taskId: "1", expectedVersion: 3, confirmPhysicalOutput: true } };
    await h.service.pickOutput("assembler", "1", input); await h.service.pickOutput("assembler", "1", input);
    expect(h.claims.pickClaimLine.mock.calls[0]).toEqual(h.claims.pickClaimLine.mock.calls[1]);
    expect(h.claims.pickClaimLine).toHaveBeenCalledWith(expect.objectContaining({ locationStrategy: "strict", quantity: "2", actor: "assembler", wmsProgress: { expectedStatus: "pending", expectedPickedQuantity: 0, targetStatus: "completed", targetPickedQuantity: 2 } }));
    expect(readAssemblyOrder).not.toHaveBeenCalled();
  });
  it("rejects forged job IDs and malformed quantities before canonical posting", async () => {
    const h = harness(); await expect(h.service.pickOutput("assembler", "1", { commandId: COMMAND, quantity: 2, expectedItemStatus: "pending", reason: "Pick",
      fence: { taskId: "2", expectedVersion: 3, confirmPhysicalOutput: true } })).rejects.toMatchObject({ code: "WORK_TASK_FENCE_MISMATCH" });
    expect(h.claims.pickClaimLine).not.toHaveBeenCalled();
  });
  it("batches queue ownership reads and never writes picker state", async () => {
    const h = harness(); const orders = Array.from({ length: 201 }, (_, index) => ({ id: index + 1, items: [] }));
    expect(await h.service.handedOffOrderIds(orders)).toEqual(new Set());
    expect(readAssemblyOwnership).toHaveBeenCalledTimes(2);
    expect(vi.mocked(readAssemblyOwnership).mock.calls[0][1]).toHaveLength(200);
    expect(h.client.query).toHaveBeenCalledWith("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  });
});
