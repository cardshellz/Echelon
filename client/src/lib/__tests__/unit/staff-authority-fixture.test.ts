import { describe, expect, it } from "vitest";
import { staffAuthorityFixture } from "../../../../../test/browser/fixtures/staff-authority.fixture";

const user = { id: "synthetic-staff", username: "fixture", role: "admin" };

describe("browser staff authority fixture", () => {
  it("preserves zero access despite a legacy admin label", () => {
    const result = staffAuthorityFixture({ user, permissions: [], systemRoles: [] });
    expect(result.assignedRoles).toEqual([]);
    expect(result.systemRoles).toEqual([]);
    expect(result.permissions).toEqual([]);
    expect(result.user).toMatchObject({ active: 1, displayName: null, lastLoginAt: null });
    expect(result.user.createdAt.toISOString()).toBe("2026-11-04T00:00:00.000Z");
  });

  it("uses explicitly selected system roles without inventing their default grants", () => {
    const result = staffAuthorityFixture({ user: { ...user, role: "picker" }, permissions: ["users:view"], systemRoles: ["admin", "lead"] });
    expect(result.roles).toEqual(["Administrator", "Team Lead"]);
    expect(result.systemRoles).toEqual(["admin", "lead"]);
    expect(result.permissions).toEqual(["users:view"]);
  });

  it("preserves custom same-name roles without promoting them into system authority", () => {
    const result = staffAuthorityFixture({ user, permissions: ["inventory:view"], systemRoles: [],
      assignedRoles: [{ id: 101, name: "Administrator", isSystem: false }] });
    expect(result.roles).toEqual(["Administrator"]);
    expect(result.assignedRoles[0]).toEqual({ id: 101, name: "Administrator", isSystem: false });
    expect(result.systemRoles).toEqual([]);
  });

  it("rejects grants with no explicitly assigned role", () => {
    expect(() => staffAuthorityFixture({ user, permissions: ["inventory:view"], systemRoles: [] })).toThrow();
  });

  it("rejects duplicate or contradictory explicit role metadata", () => {
    expect(() => staffAuthorityFixture({ user, permissions: [], systemRoles: ["admin", "admin"] })).toThrow();
    expect(() => staffAuthorityFixture({ user, permissions: [], systemRoles: [],
      assignedRoles: [{ id: 101, name: "Administrator", isSystem: true }] })).toThrow();
  });

  it("does not hide an invalid inactive user or malformed permission", () => {
    expect(() => staffAuthorityFixture({ user: { ...user, active: 0 }, permissions: [], systemRoles: [] })).toThrow();
    expect(() => staffAuthorityFixture({ user, permissions: ["not a permission"], systemRoles: ["admin"] })).toThrow();
  });

  it("does not mutate caller assignments or grant arrays", () => {
    const assignedRoles = [{ id: 101, name: "Reviewer", isSystem: false }];
    const permissions = ["inventory:view"];
    const result = staffAuthorityFixture({ user, permissions, systemRoles: [], assignedRoles });
    result.assignedRoles[0].name = "Different";
    result.permissions.push("inventory:edit");
    expect(assignedRoles[0].name).toBe("Reviewer");
    expect(permissions).toEqual(["inventory:view"]);
  });
});
