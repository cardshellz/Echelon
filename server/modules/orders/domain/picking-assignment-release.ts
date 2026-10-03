import { AppError, IntegrityError, ValidationError } from "@shared/errors";
import {
  canReleasePickingAssignment,
  PICKING_RELEASE_ANY_PERMISSION,
  type PickingAssignmentSnapshot,
} from "@shared/types/picking-assignment-release";

export interface PickingReleaseActor {
  id: string;
  name: string;
  role: string;
  active: boolean;
  permissions: readonly string[];
}

export interface PickingAssignmentState extends PickingAssignmentSnapshot {
  warehouseStatus: string;
}

/** Decide under the order lock; a stale screen must not release a newer claim. */
export function decidePickingAssignmentRelease(
  actor: PickingReleaseActor,
  current: PickingAssignmentState,
  expected?: PickingAssignmentSnapshot,
): "release" | "already_released" {
  const mayOverride = actor.permissions.includes(PICKING_RELEASE_ANY_PERMISSION);
  const mayPick = actor.permissions.includes("picking:perform");
  const forbidden = () => new AppError(
    "You may release only your own picking assignment. Releasing another assignment requires picking:release_any.",
    "PICKING_RELEASE_FORBIDDEN", 403,
  );
  if (!actor.active || (!mayOverride && !mayPick)) throw forbidden();

  // A retry after a successful release is a no-op, with no second audit entry.
  if (current.warehouseStatus === "ready" && current.assignedPickerId === null && current.startedAt === null) {
    if (expected && expected.assignedPickerId !== actor.id && !mayOverride) throw forbidden();
    return "already_released";
  }
  if (current.warehouseStatus !== "in_progress") {
    throw new IntegrityError("This order is not actively being picked. Refresh the queue.", {
      reason: "picking_assignment_not_active", warehouseStatus: current.warehouseStatus,
    });
  }
  if (!canReleasePickingAssignment(actor.id, actor.permissions, current)) throw forbidden();

  // Preserve old own-assignment clients, but require an explicit snapshot for
  // an override so it cannot act on an assignment the supervisor never saw.
  if (!expected && current.assignedPickerId !== actor.id) {
    throw new ValidationError("Refresh the queue before releasing another picking assignment.", {
      reason: "picking_assignment_snapshot_required",
    });
  }
  if (expected && (expected.assignedPickerId !== current.assignedPickerId
    || (expected.startedAt === null ? null : Date.parse(expected.startedAt))
      !== (current.startedAt === null ? null : Date.parse(current.startedAt)))) {
    throw new IntegrityError("The picking assignment changed. Refresh the queue before releasing it.", {
      reason: "picking_assignment_changed",
    });
  }
  return "release";
}
