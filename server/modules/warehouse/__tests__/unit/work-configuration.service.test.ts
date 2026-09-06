import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { emptyWorkConfiguration, type WorkRevision, type SaveWorkConfiguration } from "@shared/warehouse-work";
import { WorkConfigurationService } from "../../work/application/work-configuration.service";
import { WorkConfigurationRepository } from "../../work/infrastructure/work-configuration.repository";

const TIME = "2026-09-05T12:00:00.000Z";
const client = {} as PoolClient;
const initial = (): WorkRevision => ({ warehouseId: 1, revision: 0, configuration: emptyWorkConfiguration(), executionStatus: "not_connected", savedAt: null, savedBy: null, reason: null });
const command = (): SaveWorkConfiguration => ({ expectedRevision: 0, commandId: "00000000-0000-4000-8000-000000000001", reason: "Small team setup", configuration: emptyWorkConfiguration() });
function fixture() {
  const repo = new WorkConfigurationRepository({} as Pool);
  vi.spyOn(repo, "transaction").mockImplementation((operation) => operation(client));
  const warehouse = vi.spyOn(repo, "warehouse").mockResolvedValue({ id: 1, name: "HQ", code: "HQ", type: "operations", active: true });
  const current = vi.spyOn(repo, "current").mockResolvedValue(initial());
  const replay = vi.spyOn(repo, "command").mockResolvedValue(null);
  vi.spyOn(repo, "locations").mockResolvedValue([{ id: 1, code: "PACK", zone: "PACK", active: true }]);
  vi.spyOn(repo, "history").mockResolvedValue([]);
  const persist = vi.spyOn(repo, "persist").mockResolvedValue({ ...initial(), revision: 1, savedBy: "admin", savedAt: TIME });
  const identity = { actor: vi.fn().mockResolvedValue({ id: "admin", active: true, permissions: ["warehouse_work:view", "warehouse_work:configure", "warehouse_work:manage_access"] }),
    employees: vi.fn().mockResolvedValue([{ id: "admin", name: "Admin", active: true }]) };
  const clock = vi.fn(() => new Date(TIME));
  return { service: new WorkConfigurationService(repo, clock, identity), repo, warehouse, current, replay, persist, identity, clock };
}

describe("warehouse work application commands", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("saves one audited revision using the authenticated actor and injected clock", async () => {
    const f = fixture(); await f.service.save("admin", 1, command());
    expect(f.warehouse).toHaveBeenCalledWith(client, 1, true);
    expect(f.persist).toHaveBeenCalledWith(client, initial(), command(), "admin", TIME, false);
  });
  it("returns the original result for an exact retry without reading the clock or persisting", async () => {
    const f = fixture(); const saved = { ...initial(), revision: 1, savedBy: "admin", savedAt: TIME };
    f.replay.mockResolvedValue({ request: command(), revision: saved, accessChanged: false });
    expect(await f.service.save("admin", 1, command())).toEqual(saved);
    expect(f.persist).not.toHaveBeenCalled(); expect(f.clock).not.toHaveBeenCalled();
  });
  it("rejects changed requests and different actors reusing a command ID", async () => {
    const f = fixture(); f.replay.mockResolvedValue({ request: command(), revision: { ...initial(), savedBy: "other" }, accessChanged: false });
    await expect(f.service.save("admin", 1, command())).rejects.toMatchObject({ code: "WORK_COMMAND_REUSED" });
    f.replay.mockResolvedValue({ request: command(), revision: { ...initial(), savedBy: "admin" }, accessChanged: false });
    await expect(f.service.save("admin", 1, { ...command(), reason: "different reason" })).rejects.toMatchObject({ code: "WORK_COMMAND_REUSED" });
    expect(f.persist).not.toHaveBeenCalled();
  });
  it("rejects stale revisions before any write", async () => {
    const f = fixture(); f.current.mockResolvedValue({ ...initial(), revision: 1 });
    await expect(f.service.save("admin", 1, command())).rejects.toMatchObject({ code: "WORK_REVISION_CONFLICT", context: { currentRevision: 1 } });
    expect(f.persist).not.toHaveBeenCalled();
  });
  it("requires a separate access-management capability for changes and replays", async () => {
    const f = fixture(); f.identity.actor.mockResolvedValue({ id: "admin", active: true, permissions: ["warehouse_work:view", "warehouse_work:configure"] });
    const request = command(); request.configuration.access = [{ userId: "admin", capabilities: ["picking"], scope: { kind: "warehouse" } }];
    await expect(f.service.save("admin", 1, request)).rejects.toMatchObject({ code: "WORK_PERMISSION_DENIED" });
    f.replay.mockResolvedValue({ request, revision: { ...initial(), savedBy: "admin" }, accessChanged: true });
    await expect(f.service.save("admin", 1, request)).rejects.toMatchObject({ code: "WORK_PERMISSION_DENIED" });
    expect(f.persist).not.toHaveBeenCalled();
  });
  it.each(["3pl", "unknown"])("rejects %s warehouse setup", async (type) => {
    const f = fixture(); f.warehouse.mockResolvedValue({ id: 1, name: "external", code: "EXT", type, active: true });
    await expect(f.service.setup("admin", 1)).rejects.toMatchObject({ code: "WORK_WAREHOUSE_NOT_INTERNAL" });
    expect(f.persist).not.toHaveBeenCalled();
  });
  it("requires an active employee with view/configure rights even for replay", async () => {
    const f = fixture(); f.identity.actor.mockResolvedValue({ id: "admin", active: false, permissions: ["warehouse_work:view", "warehouse_work:configure"] });
    await expect(f.service.save("admin", 1, command())).rejects.toMatchObject({ status: 403 });
    expect(f.replay).not.toHaveBeenCalled();
  });
  it("never writes on setup/history/context-preview reads", async () => {
    const f = fixture(); const setup = await f.service.setup("admin", 1);
    expect(setup.revision.executionStatus).toBe("not_connected");
    await f.service.history("admin", 1, 100);
    expect(await f.service.preview("admin", 1, { capability: "picking", stationId: null, locationId: 1 })).toMatchObject({ executionAllowed: false, eligible: false });
    expect(f.persist).not.toHaveBeenCalled(); expect(f.clock).not.toHaveBeenCalled();
    expect(f.warehouse.mock.calls.every((call) => call[2] === false)).toBe(true);
  });
  it("rejects input attempting to activate runtime or forge an actor", async () => {
    const f = fixture();
    await expect(f.service.save("admin", 1, { ...command(), actorId: "forged", executionStatus: "active" })).rejects.toThrow();
    expect(f.warehouse).not.toHaveBeenCalled();
  });
});
