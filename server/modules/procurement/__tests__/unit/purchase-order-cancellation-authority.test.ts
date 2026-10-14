import { describe, expect, it } from "vitest";
import type { CommandAuthorityActor } from "../../../identity/domain/command-authority";
import {
  assertPurchaseOrderCancellationAuthority,
  getPurchaseOrderCancellationPermission,
  type PurchaseOrderCancellationState,
} from "../../domain/purchase-order-cancellation-authority";
import { buildPoLifecycleSummary } from "../../purchase-order-lifecycle.service";

const actor = (permissions: string[], overrides: Partial<CommandAuthorityActor> = {}): CommandAuthorityActor => ({
  userId: "buyer", active: true, permissions, scopedPermissions: [], ...overrides,
});

describe("canonical purchase order cancellation authority", () => {
  it.each(["draft", "pending_approval", "approved"])("allows cancellation authority for unissued %s", (status) => {
    const po = { status, physicalStatus: "draft", sentToVendorAt: null };
    expect(getPurchaseOrderCancellationPermission(po)).toEqual({ resource: "purchasing", action: "cancel" });
    expect(() => assertPurchaseOrderCancellationAuthority(po, actor(["purchasing:cancel"]))).not.toThrow();
    expect(() => assertPurchaseOrderCancellationAuthority(po, actor(["purchasing:approve"]))).toThrow("purchasing:cancel");
    expect(buildPoLifecycleSummary(po).nextActions.find((action) => action.id === "cancel")).toMatchObject({
      label: "Cancel", requiredPermission: { resource: "purchasing", action: "cancel" },
    });
  });

  it.each<PurchaseOrderCancellationState>([
    { status: "sent", physicalStatus: "draft" },
    { status: "sent", physicalStatus: null },
    { status: "acknowledged", physicalStatus: "acknowledged" },
    { status: "approved", physicalStatus: "sent" },
    { status: "draft", physicalStatus: "shipped" },
    { status: "approved", physicalStatus: "draft", sentToVendorAt: new Date("2026-10-13T12:00:00Z") },
    { status: "approved", physicalStatus: "unknown_state" },
  ])("requires approval authority for issued or inconsistent evidence %j", (po) => {
    expect(getPurchaseOrderCancellationPermission(po)).toEqual({ resource: "purchasing", action: "approve" });
    expect(() => assertPurchaseOrderCancellationAuthority(po, actor(["purchasing:cancel"]))).toThrow("purchasing:approve");
    expect(() => assertPurchaseOrderCancellationAuthority(po, actor(["purchasing:approve"]))).not.toThrow();
  });

  it.each(["sent", "acknowledged", "shipped", "in_transit", "arrived"])("advertises the same elevated grant for physical %s", (physicalStatus) => {
    const summary = buildPoLifecycleSummary({ status: "acknowledged", physicalStatus });
    expect(summary.nextActions.find((action) => action.id === "cancel")).toMatchObject({
      label: "Void", requiredPermission: { resource: "purchasing", action: "approve" },
    });
  });

  it("denies inactive users even when their fixture includes the required grant", () => {
    expect(() => assertPurchaseOrderCancellationAuthority({ status: "draft" }, actor(["purchasing:cancel"], { active: false })))
      .toThrow(expect.objectContaining({ statusCode: 403, details: { code: "PO_CANCEL_ACTOR_INACTIVE", actorId: "buyer", requiredPermission: "purchasing:cancel" } }));
  });

  it("does not elevate scoped grants or unrelated permissions", () => {
    expect(() => assertPurchaseOrderCancellationAuthority({ status: "sent" }, actor(["purchasing:edit", "inventory:adjust"], { scopedPermissions: ["purchasing:approve"] })))
      .toThrow(expect.objectContaining({ statusCode: 403, details: { code: "PO_CANCEL_SCOPE_UNSUPPORTED", actorId: "buyer", requiredPermission: "purchasing:approve" } }));
    expect(() => assertPurchaseOrderCancellationAuthority({ status: "sent" }, actor(["purchasing:edit", "inventory:adjust"])))
      .toThrow(expect.objectContaining({ statusCode: 403, details: { code: "PO_CANCEL_PERMISSION_REQUIRED", actorId: "buyer", requiredPermission: "purchasing:approve" } }));
  });
});
