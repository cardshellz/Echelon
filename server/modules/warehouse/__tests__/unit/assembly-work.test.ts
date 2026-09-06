import { describe, expect, it } from "vitest";
import {
  assemblyTaskCommandSchema, assemblyWorkFenceSchema, assemblyWorkRouteSchema, workEvidenceIdSchema,
} from "@shared/warehouse-assembly-work";
import { completeAssemblyTask, cancelUnstartedAssembly, requireAssemblyRoute, requireAssemblyScope, transitionAssemblyTask } from "../../work/domain/assembly-work";
import { validateConfigurationReferences } from "../../work/domain/work-configuration";
import { config, fence, locations, start, STATION, task, TIME } from "../assembly-work.fixture";

describe("assembly work contracts and ownership", () => {
  it.each(["0", "-1", "1.0", "1e2", "1foo", "foo", "9223372036854775808", "01"])("rejects invalid bigint evidence %s without throwing outside validation", (id) => {
    expect(workEvidenceIdSchema.safeParse(id).success).toBe(false);
  });
  it("accepts exact bigint strings without converting them to JS numbers", () => {
    expect(workEvidenceIdSchema.parse("9223372036854775807")).toBe("9223372036854775807");
  });
  it("requires explicit physical confirmations and rejects trusted-actor/status injection", () => {
    expect(assemblyTaskCommandSchema.safeParse({ ...start(), actorId: "someone-else" }).success).toBe(false);
    expect(assemblyTaskCommandSchema.safeParse({ ...start(), confirmPhysicalHandoff: false }).success).toBe(false);
    expect(assemblyWorkFenceSchema.safeParse({ ...fence(), confirmPhysicalAssembly: false }).success).toBe(false);
    expect(assemblyTaskCommandSchema.safeParse({ ...start(), action: "completed" }).success).toBe(false);
    expect(assemblyWorkRouteSchema.safeParse({ warehouseId: 1, stationId: STATION, configurationRevision: 1 }).success).toBe(false);
  });
  it("requires role capability AND current physical scope", () => {
    const actor = { id: "assembler", active: true, permissions: ["warehouse_work:view", "warehouse_work:assembly"] };
    expect(() => requireAssemblyScope(config(), actor, task().station, locations, "assembly")).not.toThrow();
    expect(() => requireAssemblyScope(config(), { ...actor, active: false }, task().station, locations, "assembly")).toThrow("permission denied");
    expect(() => requireAssemblyScope(config(), { ...actor, permissions: ["warehouse_work:view"] }, task().station, locations, "assembly")).toThrow("permission denied");
    const restricted = config(); restricted.access[1].scope = { kind: "zone", zone: "OTHER" };
    expect(() => requireAssemblyScope(restricted, actor, task().station, locations, "assembly")).toThrow("not eligible");
    restricted.access[1].scope = { kind: "stations", stationIds: ["00000000-0000-4000-8000-000000000099"] };
    expect(() => requireAssemblyScope(restricted, actor, task().station, locations, "assembly")).toThrow("not eligible");
  });
  it("routes only explicit station material/output bindings, not the work-area anchor", () => {
    expect(requireAssemblyRoute(config(), STATION, 3, [2], locations).id).toBe(STATION);
    expect(() => requireAssemblyRoute(config(), STATION, 1, [1], locations)).toThrow("location bindings");
    const missing = config(); delete missing.stations[0].assemblyBindings;
    expect(() => requireAssemblyRoute(missing, STATION, 3, [2], locations)).toThrow("location bindings");
    expect(() => requireAssemblyRoute(config(), STATION, 3, [99], locations)).toThrow("location bindings");
    expect(() => requireAssemblyRoute(config(), STATION, 3, [], locations)).toThrow("location bindings");
  });
  it("validates binding locations against the warehouse without auto-creating or moving material", () => {
    const next = config(); next.stations[0].assemblyBindings!.materialLocationIds = [99];
    const employees = next.access.map((entry) => ({ id: entry.userId, name: entry.userId, active: true }));
    expect(() => validateConfigurationReferences(next, config(), locations, employees)).toThrow("Assembly bindings");
  });
  it.each(["disabled", "capability", "dispatcher", "inactive"])("rejects unsupported or unavailable routing: %s", (condition) => {
    const next = config(); const bins = structuredClone(locations);
    if (condition === "disabled") next.stations[0].enabled = false;
    if (condition === "capability") next.stations[0].capabilities = ["packing"];
    if (condition === "dispatcher") next.profile.assignment = "dispatcher";
    if (condition === "inactive") bins[1].active = false;
    expect(() => requireAssemblyRoute(next, STATION, 3, [2], bins)).toThrow();
  });
  it("atomically starts and receives work for one employee without mutating inputs", () => {
    const before = task(); const snapshot = structuredClone(before);
    const started = transitionAssemblyTask(before, start(), "assembler", TIME);
    expect(before).toEqual(snapshot);
    expect(started).toMatchObject({ state: "in_progress", version: 2, assignedTo: "assembler", receivedBy: "assembler", startedAt: TIME, receivedAt: TIME });
    expect(started.outputQty).toBe("2");
    expect(() => transitionAssemblyTask(started, { ...start(), expectedVersion: 2 }, "other", TIME)).toThrow("taken responsibility");
  });
  it("does not interpret a tracking barcode or a different build ticket as receipt", () => {
    expect(() => transitionAssemblyTask(task(), { ...start(), receivedBuildSystemNumber: "TRACKING-123" }, "assembler", TIME)).toThrow("does not match");
  });
  it("retains ownership and routing while blocked; only the owner can resume", () => {
    const started = transitionAssemblyTask(task(), start(), "assembler", TIME);
    const blocked = transitionAssemblyTask(started, { action: "block", commandId: start().commandId, expectedVersion: 2, reason: "Component missing" }, "assembler", TIME);
    expect(blocked).toMatchObject({ state: "blocked", assignedTo: "assembler", startedAt: TIME, version: 3 });
    const resume = { action: "resume" as const, commandId: start().commandId, expectedVersion: 3, reason: "Component located" };
    expect(() => transitionAssemblyTask(blocked, resume, "other", TIME)).toThrow("assigned employee");
    expect(transitionAssemblyTask(blocked, resume, "assembler", TIME)).toMatchObject({ state: "in_progress", blockedReason: null, version: 4 });
    expect(blocked.station).toEqual(task().station);
  });
  it("requires the exact fence, physical quantity and owner before recording completion", () => {
    const started = transitionAssemblyTask(task(), start(), "assembler", TIME);
    expect(completeAssemblyTask(started, fence(), "assembler", "2", TIME)).toMatchObject({ state: "completed", completedAt: TIME, version: 3 });
    expect(() => completeAssemblyTask(started, undefined, "assembler", "2", TIME)).toThrow("exact job");
    expect(() => completeAssemblyTask(started, { ...fence(), taskId: "2" }, "assembler", "2", TIME)).toThrow("exact job");
    expect(() => completeAssemblyTask(started, { ...fence(), expectedVersion: 1 }, "assembler", "2", TIME)).toThrow("changed");
    expect(() => completeAssemblyTask(started, fence(), "other", "2", TIME)).toThrow("assigned employee");
    expect(() => completeAssemblyTask(started, { ...fence(), completedOutputQty: "1" }, "assembler", "2", TIME)).toThrow("entire build");
    expect(() => completeAssemblyTask(started, fence(), "assembler", "3", TIME)).toThrow("entire build");
  });
  it("never releases started physical work, including blocked jobs", () => {
    expect(cancelUnstartedAssembly(task())).toMatchObject({ state: "cancelled", version: 2 });
    const started = transitionAssemblyTask(task(), start(), "assembler", TIME);
    expect(() => cancelUnstartedAssembly(started)).toThrow("physical work");
    expect(() => cancelUnstartedAssembly({ ...started, state: "blocked", blockedReason: "Missing component" })).toThrow("physical work");
    const completed = completeAssemblyTask(started, fence(), "assembler", "2", TIME);
    expect(cancelUnstartedAssembly(completed)).toBe(completed);
  });
});
