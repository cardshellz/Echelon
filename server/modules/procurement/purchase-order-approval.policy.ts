import { z } from "zod";
import { SYSTEM_ROLES } from "../identity/domain/identity.domain";
import { purchaseApprovalActorSchema, type PurchaseApprovalActor } from "../identity/domain/purchase-approval-authority";

const id = z.number().int().positive().safe();
const amount = z.number().int().nonnegative().safe();
const tierSchema = z.object({ id, thresholdCents: amount, approverRole: z.string().trim().min(1).max(100) });
export type PurchaseApprovalTier = z.infer<typeof tierSchema>;

export class PurchaseApprovalAuthorityError extends Error {
  constructor(message: string, readonly statusCode: 403 | 409, readonly details: Record<string, unknown>) {
    super(message); this.name = "PurchaseApprovalAuthorityError";
  }
}

/** The application supplies the two highest active thresholds. Equal limits
 * cannot select an arbitrary approver role or silently pick a duplicate tier. */
export function assertUniqueHighestApprovalTier(rows: readonly unknown[]): void {
  if (rows.length < 2) return;
  const pair = z.array(z.object({ id, thresholdCents: amount })).length(2).safeParse(rows);
  if (!pair.success) throw new PurchaseApprovalAuthorityError("The current purchase approval tiers are invalid.", 409,
    { code: "PO_APPROVAL_POLICY_INVALID" });
  if (pair.data[0].thresholdCents === pair.data[1].thresholdCents) {
    throw new PurchaseApprovalAuthorityError("Multiple active approval tiers have the same highest threshold. Resolve the duplicate tiers before continuing.", 409,
      { code: "PO_APPROVAL_TIER_AMBIGUOUS", tierIds: pair.data.map((tier) => tier.id), thresholdCents: pair.data[0].thresholdCents });
  }
}

export const purchaseApprovalSnapshotSchema = z.object({
  contractVersion: z.literal(1),
  requireApproval: z.boolean(),
  tier: tierSchema.nullable(),
  totalCents: amount,
  actor: purchaseApprovalActorSchema,
  matchedRoleId: id.nullable(),
}).strict();
export type PurchaseApprovalSnapshot = z.infer<typeof purchaseApprovalSnapshotSchema>;

export function assertPurchaseApprovalPermission(actorInput: PurchaseApprovalActor): PurchaseApprovalActor {
  const parsedActor = purchaseApprovalActorSchema.safeParse(actorInput);
  if (!parsedActor.success) throw new PurchaseApprovalAuthorityError("Current approval authority could not be verified.", 409,
    { code: "PO_APPROVAL_AUTHORITY_INVALID" });
  const actor = parsedActor.data;
  if (!actor.active) throw new PurchaseApprovalAuthorityError("An active authenticated user is required to approve this purchase order.", 403,
    { code: "PO_APPROVAL_ACTOR_INACTIVE", actorId: actor.userId });
  if (actor.approvalGrantIds.length === 0) throw new PurchaseApprovalAuthorityError(
    actor.hasScopedApprovalGrant ? "This approval grant has an unsupported scope. Configure an explicit purchasing approval grant before approving."
      : "The current user does not have purchasing approval permission.", 403,
    { code: actor.hasScopedApprovalGrant ? "PO_APPROVAL_SCOPE_UNSUPPORTED" : "PO_APPROVAL_PERMISSION_REQUIRED", actorId: actor.userId });
  return actor;
}

/** Settings labels this as the required role, not a minimum role. SeedRBAC maps
 * legacy keys to these named system roles; there is no inferred role hierarchy. */
function matchesRequiredRole(role: PurchaseApprovalActor["roles"][number], requiredRole: string): boolean {
  if (requiredRole === "admin" || requiredRole === "lead" || requiredRole === "picker") {
    return role.isSystem && role.name === SYSTEM_ROLES[requiredRole].name;
  }
  return role.name === requiredRole;
}

export function buildPurchaseApprovalSnapshot(input: {
  actor: PurchaseApprovalActor; requireApproval: boolean; tier: PurchaseApprovalTier | null; totalCents: number;
}): PurchaseApprovalSnapshot {
  const actor = assertPurchaseApprovalPermission(input.actor);
  const parsedPolicy = z.object({ requireApproval: z.boolean(), totalCents: amount, tier: tierSchema.nullable() })
    .safeParse({ requireApproval: input.requireApproval, totalCents: input.totalCents, tier: input.requireApproval ? input.tier : null });
  if (!parsedPolicy.success) throw new PurchaseApprovalAuthorityError("The current purchase approval policy or amount is invalid.", 409,
    { code: "PO_APPROVAL_POLICY_INVALID" });
  const { totalCents, tier } = parsedPolicy.data;
  const matchedRole = tier ? actor.roles.find((role) => matchesRequiredRole(role, tier.approverRole)) : null;
  if (tier && !matchedRole) throw new PurchaseApprovalAuthorityError(
    `This purchase requires the '${tier.approverRole}' approver role. Your assigned roles: ${actor.roles.map((role) => role.name).join(", ") || "none"}.`, 403,
    { code: "PO_APPROVAL_ROLE_REQUIRED", requiredRole: tier.approverRole, tierId: tier.id, actorId: actor.userId,
      assignedRoles: actor.roles.map((role) => ({ id: role.id, name: role.name })) });
  return purchaseApprovalSnapshotSchema.parse({ contractVersion: 1, requireApproval: input.requireApproval, tier, totalCents, actor,
    matchedRoleId: matchedRole?.id ?? null });
}

/** Historical approval authority is frozen evidence. A later tier edit or
 * changed amount cannot silently reuse that approval under the same tier ID. */
export function purchaseApprovalSnapshotCovers(input: {
  snapshot: unknown; tier: PurchaseApprovalTier; totalCents: number; approvedBy: string | null;
}): boolean {
  const snapshot = purchaseApprovalSnapshotSchema.safeParse(input.snapshot);
  const tier = tierSchema.safeParse(input.tier);
  if (!snapshot.success || !tier.success || input.approvedBy === null) return false;
  const evidence = snapshot.data;
  const recordedTier = evidence.tier;
  return evidence.requireApproval && recordedTier !== null && evidence.actor.active && evidence.actor.approvalGrantIds.length > 0
    && evidence.actor.userId === input.approvedBy && evidence.totalCents === input.totalCents
    && recordedTier.id === tier.data.id && recordedTier.thresholdCents === tier.data.thresholdCents
    && recordedTier.approverRole === tier.data.approverRole
    && evidence.actor.roles.some((role) => role.id === evidence.matchedRoleId && matchesRequiredRole(role, tier.data.approverRole));
}
