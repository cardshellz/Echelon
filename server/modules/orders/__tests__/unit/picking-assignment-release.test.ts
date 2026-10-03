import { describe, expect, it, vi } from "vitest";
import type { Order } from "@shared/schema";
import { decidePickingAssignmentRelease, type PickingAssignmentState, type PickingReleaseActor } from "../../domain/picking-assignment-release";
import { releasePickingAssignment, type PickingAssignmentReleaseTransaction, type PickingAssignmentReleaseRepository } from "../../picking-assignment-release.service";
import { DEFAULT_PERMISSIONS, SYSTEM_ROLES } from "../../../identity/domain/identity.domain";

const actor: PickingReleaseActor = { id: "picker", name: "Picker", role: "picker", active: true, permissions: ["picking:perform"] };
const assignment: PickingAssignmentState = { warehouseStatus: "in_progress", assignedPickerId: "picker", startedAt: "2026-10-03T10:00:00.000Z" };
const snapshot = { assignedPickerId: assignment.assignedPickerId, startedAt: assignment.startedAt };
const supervisor = { ...actor, id: "supervisor", permissions: ["picking:release_any"] };

describe("picking assignment release authority", () => {
  it("allows an owner and an explicitly authorized supervisor through the same decision", () => {
    expect(decidePickingAssignmentRelease(actor, assignment, snapshot)).toBe("release");
    expect(decidePickingAssignmentRelease(supervisor, assignment, snapshot)).toBe("release");
    expect(decidePickingAssignmentRelease(actor, assignment)).toBe("release");
  });
  it.each([
    { ...actor, id: "someone-else" },
    { ...actor, id: "someone-else", role: "admin" },
    { ...actor, permissions: ["orders:hold", "picking:view"] },
    { ...supervisor, active: false },
  ])("rejects missing authority regardless of legacy role: %j", denied => {
    expect(() => decidePickingAssignmentRelease(denied, assignment, snapshot)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
  it("requires the supervisor to supply the assignment they saw, including an unassigned active order", () => {
    expect(() => decidePickingAssignmentRelease(supervisor, assignment)).toThrow(expect.objectContaining({ statusCode: 400 }));
    const unassigned = { ...assignment, assignedPickerId: null };
    expect(() => decidePickingAssignmentRelease(actor, unassigned)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(decidePickingAssignmentRelease(supervisor, unassigned, { ...snapshot, assignedPickerId: null })).toBe("release");
  });
  it.each(["completed", "ready_to_ship", "shipped", "cancelled", "exception", "on_hold"])("never reopens a %s order", warehouseStatus => {
    expect(() => decidePickingAssignmentRelease(supervisor, { ...assignment, warehouseStatus }, snapshot))
      .toThrow(expect.objectContaining({ statusCode: 409, context: { reason: "picking_assignment_not_active", warehouseStatus } }));
  });
  it("rejects stale snapshots even when the same picker reclaimed the order", () => {
    for (const changed of [{ ...assignment, assignedPickerId: "new-picker" }, { ...assignment, startedAt: "2026-10-03T11:00:00.000Z" }]) {
      expect(() => decidePickingAssignmentRelease(supervisor, changed, snapshot))
        .toThrow(expect.objectContaining({ statusCode: 409, context: { reason: "picking_assignment_changed" } }));
    }
  });
  it("treats a repeated release as a no-op without reopening or auditing it again", () => {
    const released = { warehouseStatus: "ready", assignedPickerId: null, startedAt: null };
    expect(decidePickingAssignmentRelease(actor, released, snapshot)).toBe("already_released");
    expect(() => decidePickingAssignmentRelease({ ...actor, id: "different" }, released, snapshot))
      .toThrow(expect.objectContaining({ statusCode: 403 }));
  });
  it("seeds a separate override permission for admin/lead, not ordinary pickers", () => {
    expect(DEFAULT_PERMISSIONS).toContainEqual(expect.objectContaining({ resource: "picking", action: "release_any" }));
    expect(SYSTEM_ROLES.admin.permissions).toContain("picking:release_any");
    expect(SYSTEM_ROLES.lead.permissions).toContain("picking:release_any");
    expect(SYSTEM_ROLES.picker.permissions).not.toContain("picking:release_any");
  });
});

function fixture() {
  const before = { id: 1, ...assignment, startedAt: new Date(assignment.startedAt!), onHold: 1, pickedCount: 2 } as Order;
  const after = { ...before, warehouseStatus: "ready", assignedPickerId: null, startedAt: null };
  const tx: PickingAssignmentReleaseTransaction = {
    readActor: vi.fn(async () => actor), lockOrder: vi.fn(async () => before),
    clearAssignment: vi.fn(async () => after), recordRelease: vi.fn(async () => {}),
  };
  const repository: PickingAssignmentReleaseRepository = { transaction: run => run(tx) };
  vi.spyOn(repository, "transaction");
  return { before, after, tx, repository };
}

describe("one picking assignment command", () => {
  it("locks actor then order, updates once, and audits in the same transaction with an injected clock", async () => {
    const { repository, tx, before, after } = fixture();
    const now = new Date("2026-10-03T12:00:00.000Z");
    const command = { orderId: 1, userId: actor.id, expectedAssignment: snapshot };
    await expect(releasePickingAssignment(repository, command, () => now)).resolves.toEqual(after);
    expect(repository.transaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tx.readActor).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(tx.lockOrder).mock.invocationCallOrder[0]);
    expect(tx.clearAssignment).toHaveBeenCalledWith(1);
    expect(tx.recordRelease).toHaveBeenCalledWith(before, after, actor, command, now);
  });
  it.each([
    { orderId: 0, userId: "picker" }, { orderId: 1, userId: "" },
    { orderId: 2_147_483_648, userId: "picker" }, { orderId: 1.5, userId: "picker" },
    { orderId: 1, userId: "picker", resetProgress: true },
    { orderId: 1, userId: "picker", canOverride: true },
    { orderId: 1, userId: "picker", expectedAssignment: { assignedPickerId: "picker", startedAt: "invalid" } },
  ])("validates before touching the repository: %j", async command => {
    const { repository } = fixture();
    await expect(releasePickingAssignment(repository, command)).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.transaction).not.toHaveBeenCalled();
  });
  it("does not write when the order is absent", async () => {
    const { repository, tx } = fixture();
    vi.mocked(tx.lockOrder).mockResolvedValue(undefined);
    await expect(releasePickingAssignment(repository, { orderId: 1, userId: "picker" })).rejects.toMatchObject({ statusCode: 404 });
    expect(tx.clearAssignment).not.toHaveBeenCalled();
    expect(tx.recordRelease).not.toHaveBeenCalled();
  });
  it("does not write or audit a duplicate release", async () => {
    const { repository, tx, after } = fixture();
    vi.mocked(tx.lockOrder).mockResolvedValue(after);
    await expect(releasePickingAssignment(repository, { orderId: 1, userId: "picker", expectedAssignment: snapshot })).resolves.toEqual(after);
    expect(tx.clearAssignment).not.toHaveBeenCalled();
    expect(tx.recordRelease).not.toHaveBeenCalled();
  });
});
