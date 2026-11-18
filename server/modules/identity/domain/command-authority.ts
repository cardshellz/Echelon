import { z } from "zod";

const permission = z.string().min(3).max(201);

/** Current Identity evidence for a command; session roles are not authority. */
export const commandAuthorityActorSchema = z.object({
  userId: z.string().min(1).max(255).refine(value => value.trim().length > 0),
  active: z.boolean(),
  permissions: z.array(permission),
  scopedPermissions: z.array(permission),
});

export type CommandAuthorityActor = z.infer<typeof commandAuthorityActorSchema>;
