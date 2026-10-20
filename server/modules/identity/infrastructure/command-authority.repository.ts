import { sql } from "drizzle-orm";
import { z } from "zod";
import { commandAuthorityActorSchema, type CommandAuthorityActor } from "../domain/command-authority";
import type { PurchaseApprovalIdentityTransaction } from "./purchase-approval-access.repository";

/**
 * Read within the command transaction, after its global command locks. Use the existing
 * approval reader's account -> role/membership -> grant/permission lock order so
 * revocation cannot invalidate authority before that transaction commits.
 * Read-only snapshot consumers may disable locks; this option never grants command authority.
 */
export async function readCommandAuthorityActor(
  tx: PurchaseApprovalIdentityTransaction,
  userId: string,
  options: { lock?: boolean } = {},
): Promise<CommandAuthorityActor> {
  const actorId = commandAuthorityActorSchema.shape.userId.parse(userId);
  const lock = options.lock !== false;
  const userResult = await tx.execute(sql`SELECT id,active FROM identity.users WHERE id=${actorId} ${lock ? sql`FOR SHARE` : sql``}`);
  const user = z.object({ id: z.string(), active: z.number().int() }).optional().parse(userResult.rows[0]);
  if (!user || user.active !== 1) {
    return { userId: actorId, active: false, permissions: [], scopedPermissions: [] };
  }

  if (lock) await tx.execute(sql`
    SELECT role.id
    FROM identity.auth_user_roles assignment
    JOIN identity.auth_roles role ON role.id=assignment.role_id
    WHERE assignment.user_id=${actorId} ORDER BY role.id,assignment.id
    FOR SHARE OF role,assignment
  `);
  const grantsResult = await tx.execute(sql`
    SELECT permission.resource,permission.action,grant_row.constraints
    FROM identity.auth_user_roles assignment
    JOIN identity.auth_role_permissions grant_row ON grant_row.role_id=assignment.role_id
    JOIN identity.auth_permissions permission ON permission.id=grant_row.permission_id
    WHERE assignment.user_id=${actorId}
    ORDER BY assignment.id,grant_row.id,permission.id
    ${lock ? sql`FOR SHARE OF assignment,grant_row,permission` : sql``}
  `);
  const grants = z.array(z.object({
    resource: z.string().min(1), action: z.string().min(1), constraints: z.unknown(),
  })).parse(grantsResult.rows);
  const permissionNames = (scoped: boolean) => [...new Set(grants
    .filter((grant) => (grant.constraints !== null) === scoped)
    .map((grant) => `${grant.resource}:${grant.action}`))].sort();

  return commandAuthorityActorSchema.parse({
    userId: user.id, active: true,
    permissions: permissionNames(false),
    // Generic Identity constraints have no implemented command scope contract.
    // Preserve this evidence without turning a restricted grant into a global one.
    scopedPermissions: permissionNames(true),
  });
}
