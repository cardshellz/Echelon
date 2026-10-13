import type { CommandAuthorityActor } from "../../identity/domain/command-authority";

export type PurchaseOrderCancellationState = Readonly<{
  status: string;
  physicalStatus?: string | null;
  sentToVendorAt?: Date | string | null;
}>;

export type PurchaseOrderCancellationPermission = Readonly<{
  resource: "purchasing";
  action: "cancel" | "approve";
}>;

/** Only an unissued state can use the ordinary cancellation grant. Legacy and
 * physical state are both evidence: a default draft physical value must not
 * weaken an issued legacy state, or an old draft legacy value an issued track. */
export function getPurchaseOrderCancellationPermission(
  po: PurchaseOrderCancellationState,
): PurchaseOrderCancellationPermission {
  const unissued = ["draft", "pending_approval", "approved"].includes(po.status)
    && (po.physicalStatus == null || po.physicalStatus === "draft")
    && po.sentToVendorAt == null;
  return { resource: "purchasing", action: unissued ? "cancel" : "approve" };
}

export class PurchaseOrderCancellationAuthorityError extends Error {
  readonly statusCode = 403;
  constructor(public readonly details: {
    code: "PO_CANCEL_ACTOR_INACTIVE" | "PO_CANCEL_PERMISSION_REQUIRED" | "PO_CANCEL_SCOPE_UNSUPPORTED";
    actorId: string;
    requiredPermission: string;
  }) {
    super(details.code === "PO_CANCEL_ACTOR_INACTIVE"
      ? "An active account is required to cancel or void a purchase order"
      : `Permission required to cancel or void this purchase order: ${details.requiredPermission}`);
    this.name = "PurchaseOrderCancellationAuthorityError";
  }
}

export function assertPurchaseOrderCancellationAuthority(
  po: PurchaseOrderCancellationState,
  actor: CommandAuthorityActor,
): void {
  const permission = getPurchaseOrderCancellationPermission(po);
  const requiredPermission = `${permission.resource}:${permission.action}`;
  const code = !actor.active ? "PO_CANCEL_ACTOR_INACTIVE"
    : actor.permissions.includes(requiredPermission) ? null
      : actor.scopedPermissions.includes(requiredPermission) ? "PO_CANCEL_SCOPE_UNSUPPORTED"
        : "PO_CANCEL_PERMISSION_REQUIRED";
  if (code) throw new PurchaseOrderCancellationAuthorityError({ code, actorId: actor.userId, requiredPermission });
}
