import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { accessManagementCapabilities } from "../domain/access-administration";

/** Pure read-only inspection against an explicitly supplied connection. No backfill or bootstrap. */
export async function readIdentityAccessPreflight(executor: { execute(query: SQL): Promise<unknown> }) {
  const result = await executor.execute(sql`
    WITH access AS (
      SELECT account.id,account.role,
        EXISTS(SELECT 1 FROM identity.auth_user_roles membership WHERE membership.user_id=account.id) AS assigned,
        ARRAY(SELECT DISTINCT permission.resource || ':' || permission.action
          FROM identity.auth_user_roles membership
          JOIN identity.auth_role_permissions grant_row ON grant_row.role_id=membership.role_id
          JOIN identity.auth_permissions permission ON permission.id=grant_row.permission_id
          WHERE membership.user_id=account.id AND grant_row.constraints IS NULL) AS permissions
      FROM identity.users account WHERE account.active=1
    )
    SELECT count(*)::integer AS "activeAccounts",
      count(*) FILTER(WHERE NOT assigned)::integer AS "unassignedActiveAccounts",
      count(*) FILTER(WHERE NOT assigned AND role IN ('admin','lead','picker'))::integer AS "legacyLabelOnlyActiveAccounts",
      count(*) FILTER(WHERE 'users:manage_roles'=ANY(permissions))::integer AS "assignmentHolders",
      count(*) FILTER(WHERE ARRAY['users:manage_roles','users:view','roles:view']::text[] <@ permissions)::integer AS "assignmentUiHolders",
      count(*) FILTER(WHERE 'roles:edit'=ANY(permissions))::integer AS "grantHolders",
      count(*) FILTER(WHERE ARRAY['roles:edit','roles:view']::text[] <@ permissions)::integer AS "grantUiHolders"
    FROM access`);
  const number = z.number().int().nonnegative();
  const [row] = z.object({ rows: z.array(z.object({ activeAccounts: number, unassignedActiveAccounts: number,
    legacyLabelOnlyActiveAccounts: number, assignmentHolders: number, assignmentUiHolders: number,
    grantHolders: number, grantUiHolders: number })).length(1) }).parse(result).rows;
  const capabilities = [
    { capability: accessManagementCapabilities[0], holders: row.assignmentHolders, uiReadyHolders: row.assignmentUiHolders },
    { capability: accessManagementCapabilities[1], holders: row.grantHolders, uiReadyHolders: row.grantUiHolders },
  ];
  return { ready: capabilities.every(capability => capability.uiReadyHolders > 0), capabilities,
    activeAccounts: row.activeAccounts, unassignedActiveAccounts: row.unassignedActiveAccounts,
    legacyLabelOnlyActiveAccounts: row.legacyLabelOnlyActiveAccounts };
}
