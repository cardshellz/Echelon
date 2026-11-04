import { describe, expect, it } from "vitest";
import { staffAuthorityKey, staffAuthoritySchema } from "../../staff-authority";

const user = { id: "operator", username: "operator", role: "admin", active: 1, displayName: null,
  createdAt: "2026-11-04T00:00:00Z", lastLoginAt: null };
const empty = { user, roles: [], permissions: [], assignedRoles: [], systemRoles: [] };

describe("verified staff authority contract", () => {
  it("accepts a current active identity with no operational assignments despite a legacy admin label", () => {
    const parsed = staffAuthoritySchema.parse(empty);
    expect(parsed.assignedRoles).toEqual([]);
    expect(parsed.systemRoles).toEqual([]);
  });
  it("accepts custom and multiple assignments without interpreting names as system authority", () => {
    const parsed = staffAuthoritySchema.parse({ ...empty, roles: ["Administrator", "Stock reader"],
      assignedRoles: [{ id: 4, name: "Administrator", isSystem: false }, { id: 5, name: "Stock reader", isSystem: false }],
      permissions: ["inventory:view"] });
    expect(parsed.systemRoles).toEqual([]);
  });
  it("accepts explicit system authority independently of the legacy picker label", () => {
    expect(staffAuthoritySchema.parse({ ...empty, user: { ...user, role: "picker" }, roles: ["Administrator"],
      assignedRoles: [{ id: 1, name: "Administrator", isSystem: true }], systemRoles: ["admin"] }).systemRoles).toEqual(["admin"]);
  });
  it.each([
    { assignedRoles: undefined }, { systemRoles: undefined }, { roles: undefined },
    { assignedRoles: [{ id: 1, name: "Administrator", isSystem: 1 }], roles: ["Administrator"], systemRoles: ["admin"] },
    { permissions: ["inventory:view"] },
    { roles: ["Administrator"] },
    { assignedRoles: [{ id: 1, name: "Picker", isSystem: true }], roles: ["Picker"], systemRoles: ["admin"] },
    { assignedRoles: [{ id: 1, name: "Picker", isSystem: true }], roles: ["Picker"], systemRoles: [] },
    { assignedRoles: [{ id: 1, name: "Picker", isSystem: true }], roles: ["Picker"], systemRoles: ["picker", "picker"] },
    { assignedRoles: [{ id: 1, name: "A", isSystem: false }, { id: 1, name: "B", isSystem: false }], roles: ["A", "B"] },
    { user: { ...user, active: 0 } },
  ])("rejects absent, malformed or contradictory evidence %#", patch => {
    expect(staffAuthoritySchema.safeParse({ ...empty, ...patch }).success).toBe(false);
  });
  it("changes the cache identity for actual authority changes, not ordering or compatibility labels", () => {
    const value = staffAuthoritySchema.parse({ ...empty, roles: ["A", "B"],
      assignedRoles: [{ id: 2, name: "A", isSystem: false }, { id: 3, name: "B", isSystem: false }],
      permissions: ["inventory:view", "users:view"] });
    expect(staffAuthorityKey({ ...value, user: { ...value.user, role: "picker" },
      permissions: [...value.permissions].reverse(), assignedRoles: [...value.assignedRoles].reverse() })).toBe(staffAuthorityKey(value));
    expect(staffAuthorityKey({ ...value, permissions: ["inventory:view"] })).not.toBe(staffAuthorityKey(value));
  });
});
