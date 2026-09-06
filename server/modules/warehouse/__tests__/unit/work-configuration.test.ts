import { describe, expect, it } from "vitest";
import {
  emptyWorkConfiguration, smallTeamProfile, saveWorkConfigurationSchema, workConfigurationSchema,
  workProfileSchema, workRevisionSchema, type WorkConfiguration, type WorkContextRequest,
} from "@shared/warehouse-work";
import { canonicalConfiguration, previewWorkContext, requireWorkPermission, validateConfigurationReferences } from "../../work/domain/work-configuration";

const STATION = "00000000-0000-4000-8000-000000000001";
const locations = [{ id: 1, code: "ASSEMBLY", zone: "PACK", active: true }, { id: 2, code: "PICK", zone: "FWD", active: true }];
const employees = [{ id: "operator", name: "Operator", active: true }];
const actor = { id: "operator", active: true, permissions: ["warehouse_work:assembly", "warehouse_work:replenishment"] };
function config(): WorkConfiguration {
  return { profile: smallTeamProfile(), stations: [{ id: STATION, code: "ASSEMBLY", name: "Assembly & Packing", locationId: 1, capabilities: ["assembly", "packing"], enabled: true }],
    access: [{ userId: "operator", capabilities: ["assembly", "replenishment"], scope: { kind: "warehouse" } }] };
}
const request: WorkContextRequest = { capability: "assembly", stationId: STATION, locationId: 1 };

describe("warehouse work configuration domain", () => {
  it("uses two-person defaults without creating pretend stations or employees", () => {
    expect(emptyWorkConfiguration()).toEqual({ profile: { inbound: "receive_and_stow", replenishment: "same_operator", assemblyPacking: "combined", assignment: "claim_on_start", handoff: "on_responsibility_change" }, stations: [], access: [] });
  });
  it("cannot disable handoff evidence or turn a profile into inventory posting authority", () => {
    expect(workProfileSchema.safeParse({ ...smallTeamProfile(), handoff: "never" }).success).toBe(false);
    expect(workProfileSchema.safeParse({ ...smallTeamProfile(), autoBuild: true }).success).toBe(false);
    expect(workRevisionSchema.safeParse({ warehouseId: 1, revision: 1, configuration: config(), executionStatus: "active", savedAt: null, savedBy: null, reason: null }).success).toBe(false);
  });
  it("canonicalizes without changing the input", () => {
    const input = config(); input.stations[0].capabilities.reverse();
    const before = structuredClone(input);
    expect(canonicalConfiguration(input)).toEqual(canonicalConfiguration(config()));
    expect(input).toEqual(before);
    expect(canonicalConfiguration(input)).not.toBe(input);
  });
  it.each(["id", "code"] as const)("rejects duplicate station %s", (field) => {
    const input = config(); input.stations.push({ ...input.stations[0], id: "00000000-0000-4000-8000-000000000002", code: "OTHER", [field]: input.stations[0][field] });
    expect(workConfigurationSchema.safeParse(input).success).toBe(false);
  });
  it("rejects duplicate employees, missing station scope IDs and duplicate capabilities", () => {
    const input = config(); input.access.push(structuredClone(input.access[0]));
    expect(workConfigurationSchema.safeParse(input).success).toBe(false);
    input.access = [{ ...input.access[0], scope: { kind: "stations", stationIds: ["00000000-0000-4000-8000-000000000009"] } }];
    expect(workConfigurationSchema.safeParse(input).success).toBe(false);
    expect(workConfigurationSchema.safeParse({ ...config(), stations: [{ ...config().stations[0], capabilities: ["assembly", "assembly"] }] }).success).toBe(false);
  });
  it("rejects empty scope capabilities, unknown fields and invalid command identifiers", () => {
    expect(workConfigurationSchema.safeParse({ ...config(), extra: true }).success).toBe(false);
    expect(workConfigurationSchema.safeParse({ ...config(), access: [{ ...config().access[0], capabilities: [] }] }).success).toBe(false);
    expect(saveWorkConfigurationSchema.safeParse({ expectedRevision: -1, commandId: "x", reason: "no", configuration: config(), actorId: "forged" }).success).toBe(false);
  });
  it("allows no station for mobile replenishment and never allows draft execution", () => {
    expect(previewWorkContext(config(), 2, actor, { capability: "replenishment", stationId: null, locationId: 2 }, locations)).toEqual({ eligible: true, reason: "eligible", revision: 2, executionAllowed: false });
  });
  it.each([
    ["inactive_user", { ...actor, active: false }],
    ["missing_permission", { ...actor, permissions: ["warehouse_work:configure"] }],
  ] as const)("denies %s", (reason, employee) => {
    expect(previewWorkContext(config(), 1, employee, request, locations).reason).toBe(reason);
  });
  it("requires a matching role capability AND employee scope", () => {
    const input = config(); input.access = [];
    expect(previewWorkContext(input, 1, actor, request, locations).reason).toBe("missing_scope");
    expect(() => requireWorkPermission({ ...actor, active: false, permissions: ["warehouse_work:configure"] }, "configure")).toThrow("permission denied");
  });
  it("rejects warehouse/location and station/location mismatches", () => {
    expect(previewWorkContext(config(), 1, actor, { ...request, locationId: 999 }, locations).reason).toBe("invalid_location");
    expect(previewWorkContext(config(), 1, actor, { ...request, locationId: 2 }, locations).reason).toBe("invalid_station");
    const input = config(); input.stations[0].enabled = false;
    expect(previewWorkContext(input, 1, actor, request, locations).reason).toBe("invalid_station");
    input.stations[0].enabled = true; input.stations[0].capabilities = ["packing"];
    expect(previewWorkContext(input, 1, actor, request, locations).reason).toBe("station_capability_missing");
  });
  it("restricts station scopes to stations, including mobile bypass attempts", () => {
    const input = config(); input.access[0].scope = { kind: "stations", stationIds: [STATION] };
    expect(previewWorkContext(input, 1, actor, request, locations).eligible).toBe(true);
    expect(previewWorkContext(input, 1, actor, { ...request, stationId: null }, locations).reason).toBe("outside_scope");
  });
  it("restricts zone scopes using the warehouse location's zone", () => {
    const input = config(); input.access[0].scope = { kind: "zone", zone: "FWD" };
    expect(previewWorkContext(input, 1, actor, request, locations).reason).toBe("outside_scope");
    expect(previewWorkContext(input, 1, actor, { capability: "replenishment", stationId: null, locationId: 2 }, locations).eligible).toBe(true);
  });
  it("retires station identities without destroying them", () => {
    expect(() => validateConfigurationReferences(emptyWorkConfiguration(), config(), locations, employees)).toThrow("Disable existing stations");
    const next = config(); next.stations[0].enabled = false;
    expect(() => validateConfigurationReferences(next, config(), locations, employees)).not.toThrow();
  });
  it("validates active local locations, employees, and zones", () => {
    expect(() => validateConfigurationReferences(config(), emptyWorkConfiguration(), [], employees)).toThrow("active location");
    expect(() => validateConfigurationReferences(config(), emptyWorkConfiguration(), [{ ...locations[0], active: false }], employees)).toThrow("active location");
    expect(() => validateConfigurationReferences(config(), emptyWorkConfiguration(), locations, [{ ...employees[0], active: false }])).toThrow("inactive or unknown");
    const next = config(); next.access[0].scope = { kind: "zone", zone: "MISSING" };
    expect(() => validateConfigurationReferences(next, emptyWorkConfiguration(), locations, employees)).toThrow("active location zone");
  });
});
