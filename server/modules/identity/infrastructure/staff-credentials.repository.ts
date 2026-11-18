import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import { credentialVersionSchema, STAFF_CONTROL_PERMISSIONS } from "@shared/staff-credentials";
import { SYSTEM_ROLES } from "../domain/identity.domain";

type Executor = { execute(query: SQL): Promise<unknown> };
const stateSchema = z.object({ userId: z.string(), credentialVersion: credentialVersionSchema,
  mustChangePassword: z.boolean(), lastOperationId: z.string().uuid().nullable() });
export type StaffCredentialState = z.infer<typeof stateSchema>;
export async function readStaffCredentialState(userId: string, executor: Executor = db, lock = false): Promise<StaffCredentialState | undefined> {
  const result = await executor.execute(sql`SELECT user_id AS "userId",credential_version AS "credentialVersion",
    must_change_password AS "mustChangePassword",last_operation_id AS "lastOperationId"
    FROM identity.staff_credentials WHERE user_id=${userId} ${lock ? sql`FOR UPDATE` : sql``}`);
  return z.object({ rows: z.array(stateSchema).max(1) }).parse(result).rows[0];
}
export async function isProtectedStaffTarget(userId: string, executor: Executor): Promise<boolean> {
  const keys = sql.join(STAFF_CONTROL_PERMISSIONS.map(key => sql`${key}`), sql`, `);
  const result = await executor.execute(sql`SELECT EXISTS(
    SELECT 1 FROM identity.auth_user_roles assignment
    JOIN identity.auth_role_permissions grant_row ON grant_row.role_id=assignment.role_id
    JOIN identity.auth_permissions permission ON permission.id=grant_row.permission_id
    WHERE assignment.user_id=${userId} AND permission.resource || ':' || permission.action IN (${keys})
  ) OR EXISTS (
    SELECT 1 FROM identity.auth_user_roles assignment
    JOIN identity.auth_roles role ON role.id=assignment.role_id
    WHERE assignment.user_id=${userId} AND role.is_system=1
      AND role.name IN (${SYSTEM_ROLES.admin.name},${SYSTEM_ROLES.lead.name})
  ) AS protected`);
  return z.object({ rows: z.array(z.object({ protected: z.boolean() })).length(1) }).parse(result).rows[0].protected;
}
