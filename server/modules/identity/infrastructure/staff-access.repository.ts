import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import type { CurrentStaffAccess } from "../domain/staff-access";

const timestampSchema = z.union([z.date(), z.string().min(1).pipe(z.coerce.date())]);
const snapshotSchema = z.object({
  id: z.string(), username: z.string(), role: z.string(), displayName: z.string().nullable(),
  active: z.literal(1), createdAt: timestampSchema, lastLoginAt: timestampSchema.nullable(),
  roles: z.array(z.object({ id: z.number().int().positive(), name: z.string(), isSystem: z.boolean() })),
  permissions: z.array(z.string()),
});

/**
 * One PostgreSQL statement gives the account, assignments and global grants the same
 * MVCC snapshot. Aggregate each membership-scoped list independently to avoid multiplying
 * roles by grants. SQL NULL alone means unrestricted; JSONB null remains restricted.
 * No password column is selected. Command writers still need transaction-held authority.
 */
export async function readCurrentStaffAccess(
  userId: string,
  executor: { execute(query: SQL): Promise<unknown> } = db,
): Promise<CurrentStaffAccess | undefined> {
  const actorId = z.string().min(1).refine(value => value.trim().length > 0).parse(userId);
  const result = await executor.execute(sql`
    SELECT account.id, account.username, account.role, account.display_name AS "displayName",
      account.active, account.created_at AS "createdAt", account.last_login_at AS "lastLoginAt",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', role.id, 'name', role.name,
          'isSystem', role.is_system = 1) ORDER BY role.id)
        FROM identity.auth_user_roles assignment
        JOIN identity.auth_roles role ON role.id = assignment.role_id
        WHERE assignment.user_id = account.id
      ), '[]'::jsonb) AS roles,
      COALESCE((
        SELECT jsonb_agg(DISTINCT permission.resource || ':' || permission.action)
        FROM identity.auth_user_roles assignment
        JOIN identity.auth_role_permissions grant_row ON grant_row.role_id = assignment.role_id
        JOIN identity.auth_permissions permission ON permission.id = grant_row.permission_id
        WHERE assignment.user_id = account.id AND grant_row.constraints IS NULL
      ), '[]'::jsonb) AS permissions
    FROM identity.users account WHERE account.id = ${actorId} AND account.active = 1
  `);
  const row = z.object({ rows: z.array(snapshotSchema).max(1) }).parse(result).rows[0];
  if (!row) return undefined;
  const { roles, permissions, ...user } = row;
  return { user, roles, permissions: [...new Set(permissions)].sort() };
}
