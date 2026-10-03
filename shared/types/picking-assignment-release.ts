import { z } from "zod";

export const PICKING_RELEASE_ANY_PERMISSION = "picking:release_any";

export const pickingAssignmentSnapshotSchema = z.object({
  assignedPickerId: z.string().min(1).max(100).nullable(),
  startedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export const releasePickingAssignmentRequestSchema = z.object({
  expectedAssignment: pickingAssignmentSnapshotSchema.optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
  // Older clients send false. Resetting pick progress is never a release.
  resetProgress: z.literal(false).optional(),
}).strict();

export type PickingAssignmentSnapshot = z.infer<typeof pickingAssignmentSnapshotSchema>;
export type ReleasePickingAssignmentRequest = z.infer<typeof releasePickingAssignmentRequestSchema>;

export function canReleasePickingAssignment(
  actorId: string,
  permissions: readonly string[],
  assignment: { warehouseStatus: string; assignedPickerId: string | null },
): boolean {
  return actorId.length > 0 && assignment.warehouseStatus === "in_progress" && (
    permissions.includes(PICKING_RELEASE_ANY_PERMISSION)
    || (assignment.assignedPickerId === actorId && permissions.includes("picking:perform"))
  );
}
