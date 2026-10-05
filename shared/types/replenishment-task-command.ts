import { z } from "zod";
import { IntegrityError } from "../errors";
const positiveInteger = z.number().int().positive().max(2_147_483_647);
export const replenishmentTaskPatchSchema = z
  .object({
    commandId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative().max(2_147_483_647),
    expectedStatus: z.enum(["pending", "assigned", "in_progress", "blocked"]),
    status: z
      .enum(["pending", "assigned", "in_progress", "blocked", "cancelled"])
      .optional(),
    assignedTo: z.string().trim().min(1).max(100).nullable().optional(),
    priority: positiveInteger.max(10).optional(),
    notes: z.string().max(5000).nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== undefined ||
      value.assignedTo !== undefined ||
      value.priority !== undefined ||
      value.notes !== undefined,
    {
      message:
        "A task command must change status, assignment, priority or notes",
    },
  );
export type ReplenishmentTaskPatch = z.infer<
  typeof replenishmentTaskPatchSchema
>;

export function assertReplenishmentTaskTransition(
  from: string,
  to: string,
): void {
  const transitions: Readonly<Record<string, readonly string[]>> = {
    pending: ["assigned", "in_progress", "cancelled"],
    assigned: ["in_progress", "pending", "cancelled"],
    in_progress: ["pending", "cancelled", "blocked"],
    blocked: ["pending", "cancelled"],
  };
  if (!transitions[from] || (to !== from && !transitions[from].includes(to)))
    throw new IntegrityError(
      `Cannot transition replenishment task from ${from} to ${to}`,
      { from, to },
    );
}
