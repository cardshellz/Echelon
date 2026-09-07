import { z } from "zod";

const resourceId = z.number().int().positive().safe();
export const purchaseApprovalActorSchema = z.object({
  userId: z.string().trim().min(1).max(255),
  active: z.boolean(),
  roles: z.array(z.object({ id: resourceId, name: z.string().min(1).max(100), isSystem: z.boolean() })),
  approvalGrantIds: z.array(resourceId),
  hasScopedApprovalGrant: z.boolean(),
});
export type PurchaseApprovalActor = z.infer<typeof purchaseApprovalActorSchema>;
