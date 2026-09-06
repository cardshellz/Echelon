import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssemblyPackingService } from "../../work/application/assembly-packing.service";
import { AssemblyPackingRepository } from "../../work/infrastructure/assembly-packing.repository";
import { AssemblyWorkRepository } from "../../work/infrastructure/assembly-work.repository";
import { WorkConfigurationRepository } from "../../work/infrastructure/work-configuration.repository";
import { AssemblyWorkOwner } from "../../work/application/assembly-work-owner";
import { lockPackingReadiness, recordAssemblyPackingReady } from "../../../wms/assembly-packing-readiness";
import { lockPackingReplenishmentBlockers } from "../../../inventory/application/packing-replenishment-reader";
import { lockAssemblyClaimForWork } from "../../../inventory-planning/application/assembly-work-claim-access";
import { config, task, locations, TIME, COMMAND } from "../assembly-work.fixture";
vi.mock("../../../wms/assembly-packing-readiness", async (original) => ({ ...await original<object>(), lockPackingReadiness: vi.fn(), recordAssemblyPackingReady: vi.fn() }));
vi.mock("../../../inventory/application/packing-replenishment-reader", () => ({ lockPackingReplenishmentBlockers: vi.fn() }));
vi.mock("../../../inventory-planning/application/assembly-work-claim-access", () => ({ lockAssemblyClaimForWork: vi.fn() }));
const command = { commandId: COMMAND, expectedVersion: 3, confirmReadyForPacking: true, reason: "Continue at the assembly bench" };
const evidence = () => ({ order: { id: 70, warehouse_id: 1, warehouse_status: "in_progress" as const, on_hold: 0 },
  items: [{ id: 71, sku: "P5", quantity: 2, picked_quantity: 2, status: "completed", on_hold: false, requires_shipping: 1, location: "FINISHED" }], exceptionIds: [] });
function harness() {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const configuration = new WorkConfigurationRepository({ connect: vi.fn(async () => client) });
  const setup = config(); setup.access[1].capabilities.push("packing");
  vi.spyOn(configuration, "warehouse").mockResolvedValue({ id: 1, code: "HQ", name: "HQ", type: "operations", active: true });
  vi.spyOn(configuration, "current").mockResolvedValue({ warehouseId: 1, revision: 1, configuration: setup, executionStatus: "explicit_handoff_only", savedAt: TIME, savedBy: "admin", reason: "Setup" });
  vi.spyOn(configuration, "locationsByIds").mockResolvedValue(locations);
  const tasks = new AssemblyWorkRepository();
  vi.spyOn(tasks, "byId").mockResolvedValue(task({ state: "completed", version: 3, assignedTo: "assembler", receivedAt: TIME, receivedBy: "assembler", startedAt: TIME, completedAt: TIME }));
  const identity = vi.fn(async (_client: PoolClient, id: string) => ({ id, active: true, permissions: ["warehouse_work:view", "warehouse_work:assembly", "warehouse_work:packing"] }));
  const owner = new AssemblyWorkOwner(configuration, tasks, identity);
  const receipts = new AssemblyPackingRepository(); vi.spyOn(receipts, "replay").mockResolvedValue(null); vi.spyOn(receipts, "insert").mockResolvedValue(undefined);
  return { service: new AssemblyPackingService(owner, receipts, () => new Date(TIME)), client, query, receipts, setup, tasks, identity };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.mocked(lockPackingReadiness).mockResolvedValue(evidence());
  vi.mocked(lockPackingReplenishmentBlockers).mockResolvedValue([]); vi.mocked(lockAssemblyClaimForWork).mockResolvedValue({ active: true });
});
describe("assembly packing handoff", () => {
  it("commits readiness and immutable receipt together with the injected time", async () => {
    const h = harness(); const result = await h.service.ready("assembler", "1", command);
    expect(result.receipt).toMatchObject({ readyAt: TIME, status: "ready_to_ship", packingUrl: "/packing?orderId=70", actorId: "assembler" });
    expect(recordAssemblyPackingReady).toHaveBeenCalledWith(h.client, evidence(), expect.any(Function));
    expect(h.receipts.insert).toHaveBeenCalledWith(h.client, expect.objectContaining({ receipt: result.receipt, beforeStatus: "in_progress" }));
    expect(h.query).toHaveBeenLastCalledWith("COMMIT");
    expect(vi.mocked(lockPackingReadiness).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(lockAssemblyClaimForWork).mock.invocationCallOrder[0]);
  });
  it("rolls back a header transition if receipt persistence fails", async () => {
    const h = harness(); vi.mocked(h.receipts.insert).mockRejectedValue(new Error("receipt unavailable"));
    await expect(h.service.ready("assembler", "1", command)).rejects.toThrow("receipt unavailable");
    expect(h.query).toHaveBeenLastCalledWith("ROLLBACK"); expect(h.query).not.toHaveBeenCalledWith("COMMIT");
  });
  it("replays the original receipt without another write", async () => {
    const h = harness(); const first = await h.service.ready("assembler", "1", command);
    vi.mocked(h.receipts.replay).mockResolvedValue(first.receipt); vi.mocked(recordAssemblyPackingReady).mockClear(); vi.mocked(h.receipts.insert).mockClear();
    expect(await h.service.ready("assembler", "1", command)).toEqual({ ...first, idempotentReplay: true });
    expect(recordAssemblyPackingReady).not.toHaveBeenCalled(); expect(h.receipts.insert).not.toHaveBeenCalled();
  });
  it.each(["hold", "warehouse", "partial", "exception", "replen", "scope", "role", "version", "claim", "worker", "separate"])("rejects %s without recording readiness", async (kind) => {
    const h = harness(); const row = evidence();
    if (kind === "hold") row.order.on_hold = 1;
    if (kind === "warehouse") row.order.warehouse_id = 2;
    if (kind === "partial") row.items[0].picked_quantity = 1;
    if (kind === "exception") Object.assign(row, { exceptionIds: [1] });
    if (kind === "replen") vi.mocked(lockPackingReplenishmentBlockers).mockResolvedValue([1]);
    if (kind === "scope") h.setup.access[1].capabilities = ["assembly"];
    if (kind === "role") h.identity.mockResolvedValue({ id: "assembler", active: true, permissions: [] });
    if (kind === "claim") vi.mocked(lockAssemblyClaimForWork).mockResolvedValue({ active: false });
    if (kind === "version") vi.mocked(h.tasks.byId).mockResolvedValue(task({ version: 4 }));
    if (kind === "worker") vi.mocked(h.tasks.byId).mockResolvedValue(task({ version: 3, state: "completed", assignedTo: "other", receivedAt: TIME }));
    if (kind === "separate") vi.mocked(h.tasks.byId).mockResolvedValue(task({ version: 3, state: "completed", assignedTo: "assembler", receivedAt: TIME, profile: { ...config().profile, assemblyPacking: "separate" } }));
    vi.mocked(lockPackingReadiness).mockResolvedValue(row);
    await expect(h.service.ready("assembler", "1", command)).rejects.toThrow();
    expect(recordAssemblyPackingReady).not.toHaveBeenCalled(); expect(h.receipts.insert).not.toHaveBeenCalled();
  });
});
