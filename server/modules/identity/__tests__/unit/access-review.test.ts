import { describe, expect, it } from "vitest";
import { hasStaffCapability, missingCapabilityDependencies, describeStaffWorkflows } from "@shared/staff-capabilities";
import { buildAccessReview, effectiveAccess, assertNoNewDependencyGaps, type AccessProposal } from "../../domain/access-review";
import type { AccessConfiguration } from "../../domain/access-configuration";

const fixture = (): AccessConfiguration => ({
  revision: "a".repeat(64),
  users: [{ id: "operator", label: "Synthetic operator", active: 1 }, { id: "disabled", label: "Disabled account", active: 0 }],
  roles: [{ id: 1, name: "Shipment reader", system: 0 }, { id: 2, name: "Cost reader", system: 0 }],
  permissions: [{ id: 1,key: "shipments:view" }, { id: 2,key: "shipments:view_costs" }, { id: 3,key: "orders:edit" }],
  memberships: [{ userId: "operator",roleId: 1 }, { userId: "operator",roleId: 2 }, { userId: "disabled",roleId: 1 }],
  grants: [{ roleId: 1,permissionId: 1,restriction: null }, { roleId: 2,permissionId: 2,restriction: null }],
});
describe("configured staff workflow contracts", () => {
  it("does not imply adjacent module access or cost access from shipment view", () => {
    expect(hasStaffCapability(["shipments:view"],"shipments:view")).toBe(true);
    expect(hasStaffCapability(["shipments:view"],"shipments:view_costs")).toBe(false);
    expect(hasStaffCapability(["shipments:view"],"orders:edit")).toBe(false);
  });
  it.each(["shipments:view_costs","shipments:view_order_context"])("denies %s without its view prerequisite", key => {
    expect(hasStaffCapability([key],key)).toBe(false);
    expect(missingCapabilityDependencies([key])).toEqual([{ capability: key,required: "shipments:view" }]);
    expect(hasStaffCapability(["shipments:view",key],key)).toBe(true);
  });
  it("explains incomplete administration workflows without granting prerequisites", () => {
    const permissions = ["users:manage_roles"];
    expect(describeStaffWorkflows(permissions).find(item => item.id === "assign-staff-access")).toMatchObject({
      available: false,missing: ["users:view","roles:view"],
    });
    expect(permissions).toEqual(["users:manage_roles"]);
  });
  it("combines capabilities across multiple custom roles", () => {
    const effective = effectiveAccess(fixture(),"operator");
    expect(hasStaffCapability(effective.permissions,"shipments:view_costs")).toBe(true);
    expect(effective.permissions).not.toContain("orders:edit");
    expect(effective.sources).toHaveLength(2);
  });
  it.each(["null",'{"warehouseIds":[1]}'])("does not turn restriction %s into a global grant", restriction => {
    const config = fixture(); config.grants[0].restriction = restriction;
    expect(effectiveAccess(config,"operator").permissions).toEqual([]);
    expect(effectiveAccess(config,"operator").grantedPermissions).toEqual(["shipments:view_costs"]);
    expect(hasStaffCapability(effectiveAccess(config,"operator").permissions,"shipments:view_costs")).toBe(false);
    expect(buildAccessReview(config,{ kind: "role",id: 1 },true).restricted).toBe(true);
  });
  it("does not let a restriction override a second unrestricted grant", () => {
    const config = fixture(); config.grants.push({ roleId: 2,permissionId: 1,restriction: "null" });
    expect(effectiveAccess(config,"operator").permissions).toEqual(["shipments:view","shipments:view_costs"]);
  });
  it("denies inactive and empty-assignment access", () => {
    expect(effectiveAccess(fixture(),"disabled").permissions).toEqual([]);
    const review = buildAccessReview(fixture(),{ kind: "user",id: "operator",roleIds: [] },true);
    expect(review.users[0].after).toMatchObject({ permissions: [],roleIds: [] });
    expect(review.users[0].before.permissions).toHaveLength(2);
  });
  it("previews every member of a role, including inactive accounts", () => {
    const review = buildAccessReview(fixture(),{ kind: "role",id: 1,permissionIds: [] },true);
    expect(review.affectedCount).toBe(2);
    expect(review.dependencies).toEqual([{ userId: "operator",capability: "shipments:view_costs",required: "shipments:view" }]);
  });
  it("role deletion preview removes the role itself and preserves other assignments", () => {
    const review = buildAccessReview(fixture(),{ kind: "role",id: 1,removeRole: true },true);
    expect(review.users.find(item => item.after.userId === "operator")!.after.roleIds).toEqual([2]);
    expect(review.users.find(item => item.after.userId === "disabled")!.after.roleIds).toEqual([]);
  });
  it.each<AccessProposal>([{ kind: "role",id: 1,permissionIds: [999] }, { kind: "user",id: "operator",roleIds: [999] }])("rejects unknown proposal references", proposal => {
    expect(() => buildAccessReview(fixture(),proposal,true)).toThrow();
  });
  it("blocks new effective dependency gaps without blocking repair of an existing gap", () => {
    const before = fixture(), after = fixture(); after.grants = after.grants.filter(grant => grant.permissionId !== 1);
    expect(() => assertNoNewDependencyGaps(before,after)).toThrow(/missing required capabilities/);
    expect(() => assertNoNewDependencyGaps(after,before)).not.toThrow();
    expect(() => assertNoNewDependencyGaps(after,after)).not.toThrow();
  });
});
