import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { purchaseApprovalActorSchema, type PurchaseApprovalActor } from "../domain/purchase-approval-authority";

export interface PurchaseApprovalIdentityTransaction {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
}
const resourceId = z.number().int().positive().safe();

/** Identity owns these reads. Share locks hold current account, membership and
 * grant evidence through the purchase transaction; session role strings never
 * authorize a financial command. No password leaves this reader. */
export async function readPurchaseApprovalActor(tx: PurchaseApprovalIdentityTransaction, userId: string): Promise<PurchaseApprovalActor> {
  const actorId = purchaseApprovalActorSchema.shape.userId.parse(userId);
  const userResult = await tx.execute(sql`SELECT id,active FROM identity.users WHERE id=${actorId} FOR SHARE`);
  const user = z.object({ id: z.string(), active: z.number().int() }).optional().parse(userResult.rows[0]);
  if (!user || user.active !== 1) return { userId: actorId, active: false, roles: [], approvalGrantIds: [], hasScopedApprovalGrant: false };
  const rolesResult = await tx.execute(sql`
    SELECT role.id,role.name,role.is_system AS "isSystem"
    FROM identity.auth_user_roles assignment
    JOIN identity.auth_roles role ON role.id=assignment.role_id
    WHERE assignment.user_id=${actorId} ORDER BY role.id,assignment.id
    FOR SHARE OF role,assignment
  `);
  const grantsResult = await tx.execute(sql`
    SELECT grant_row.id,grant_row.constraints
    FROM identity.auth_user_roles assignment
    JOIN identity.auth_role_permissions grant_row ON grant_row.role_id=assignment.role_id
    JOIN identity.auth_permissions permission ON permission.id=grant_row.permission_id
    WHERE assignment.user_id=${actorId} AND permission.resource='purchasing' AND permission.action='approve'
    ORDER BY assignment.id,grant_row.id,permission.id
    FOR SHARE OF assignment,grant_row,permission
  `);
  const roleRows = z.array(z.object({ id: resourceId, name: z.string(), isSystem: z.number().int().min(0).max(1) })).parse(rolesResult.rows);
  const grants = z.array(z.object({ id: resourceId, constraints: z.unknown() })).parse(grantsResult.rows);
  return purchaseApprovalActorSchema.parse({
    userId: user.id, active: true,
    roles: roleRows.map((role) => ({ ...role, isSystem: role.isSystem === 1 })),
    // Identity's generic constraints have no implemented scope contract. Follow
    // readWarehouseWorkActor: a restricted grant cannot become a global grant.
    approvalGrantIds: grants.filter((grant) => grant.constraints === null).map((grant) => grant.id),
    hasScopedApprovalGrant: grants.some((grant) => grant.constraints !== null),
  });
}
