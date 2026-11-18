import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";
import { assignedSystemRoleKeys, type StaffSystemRoleAuthority } from "../domain/staff-access";

export interface StaffAuthorityTransaction {
  execute(query: SQL): Promise<unknown>;
}

export interface StaffAuthorityPgTransaction {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
}

/** Caller must keep its transaction open through the protected mutation. */
export async function readStaffSystemRoleAuthority(
  tx: StaffAuthorityTransaction,
  userId: string,
): Promise<StaffSystemRoleAuthority> {
  const actorId = z.string().min(1).refine(value => value.trim().length > 0).parse(userId);
  // Same lock order as Identity command authority and assignment changes: account, then roles/memberships.
  const account = z.object({ rows: z.array(z.object({ active: z.number().int() })).max(1) }).parse(
    await tx.execute(sql`SELECT active FROM identity.users WHERE id = ${actorId} FOR SHARE`),
  ).rows[0];
  if (account?.active !== 1) return { active: false, roles: [] };
  const result = await tx.execute(sql`
    SELECT role.id, role.name, (role.is_system = 1) AS "isSystem"
    FROM identity.auth_user_roles assignment
    JOIN identity.auth_roles role ON role.id = assignment.role_id
    WHERE assignment.user_id = ${actorId}
    ORDER BY role.id, assignment.id FOR SHARE OF role, assignment
  `);
  const { rows } = z.object({ rows: z.array(z.object({
    id: z.number().int().positive(), name: z.string(), isSystem: z.boolean(),
  })) }).parse(result);
  return { active: true, roles: assignedSystemRoleKeys(rows) };
}

/** Explicit node-postgres entrypoint; uses the same parameterized statements and parsing. */
export async function readStaffSystemRoleAuthorityPg(
  tx: StaffAuthorityPgTransaction,
  userId: string,
): Promise<StaffSystemRoleAuthority> {
  const dialect = new PgDialect();
  return readStaffSystemRoleAuthority({
    execute: query => {
      const compiled = dialect.sqlToQuery(query);
      return tx.query(compiled.sql, compiled.params);
    },
  }, userId);
}
