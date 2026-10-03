import { z } from "zod";
import { NotFoundError, ValidationError } from "@shared/errors";
import type { Order } from "@shared/schema";
import { releasePickingAssignmentRequestSchema } from "@shared/types/picking-assignment-release";
import { decidePickingAssignmentRelease, type PickingReleaseActor } from "./domain/picking-assignment-release";

const commandSchema = releasePickingAssignmentRequestSchema.extend({
  orderId: z.number().int().positive().max(2_147_483_647),
  userId: z.string().min(1).max(100),
  deviceType: z.string().max(20).optional(),
  sessionId: z.string().max(100).optional(),
});
export type ReleasePickingAssignmentCommand = z.infer<typeof commandSchema>;

export interface PickingAssignmentReleaseTransaction {
  readActor(userId: string): Promise<PickingReleaseActor>;
  lockOrder(orderId: number): Promise<Order | undefined>;
  clearAssignment(orderId: number): Promise<Order>;
  recordRelease(before: Order, after: Order, actor: PickingReleaseActor,
    command: ReleasePickingAssignmentCommand, now: Date): Promise<void>;
}
export interface PickingAssignmentReleaseRepository {
  transaction<T>(run: (tx: PickingAssignmentReleaseTransaction) => Promise<T>): Promise<T>;
}

export async function releasePickingAssignment(
  repository: PickingAssignmentReleaseRepository,
  input: unknown,
  clock: () => Date = () => new Date(),
): Promise<Order> {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid picking assignment release request.", {
    fields: parsed.error.issues.map(issue => issue.path.join(".")),
  });
  const command = parsed.data;
  return repository.transaction(async tx => {
    // Lock order is Identity account/grants, then the WMS order. Audit commits
    // with the assignment update; neither inventory nor hold writers are called.
    const actor = await tx.readActor(command.userId);
    const before = await tx.lockOrder(command.orderId);
    if (!before) throw new NotFoundError("Order not found");
    const decision = decidePickingAssignmentRelease(actor, {
      warehouseStatus: before.warehouseStatus,
      assignedPickerId: before.assignedPickerId,
      startedAt: before.startedAt?.toISOString() ?? null,
    }, command.expectedAssignment);
    if (decision === "already_released") return before;
    const after = await tx.clearAssignment(before.id);
    await tx.recordRelease(before, after, actor, command, clock());
    return after;
  });
}
