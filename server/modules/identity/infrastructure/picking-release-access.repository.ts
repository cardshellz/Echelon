import { and, eq, inArray, isNull } from "drizzle-orm";
import { users, authPermissions, authRolePermissions, authUserRoles } from "@shared/schema";
import type { db } from "../../../db";

/** Identity-owned, current-account permission read; never trust session role names. */
export async function readPickingReleaseActor(client: Pick<typeof db, "select">, userId: string) {
  const [user] = await client.select({
    id: users.id, name: users.displayName, username: users.username,
    role: users.role, active: users.active,
  }).from(users).where(eq(users.id, userId)).for("share");
  if (!user || user.active !== 1) {
    return { id: userId, name: userId, role: "", active: false, permissions: [] as string[] };
  }
  const grants = await client.select({ action: authPermissions.action })
    .from(authUserRoles)
    .innerJoin(authRolePermissions, eq(authRolePermissions.roleId, authUserRoles.roleId))
    .innerJoin(authPermissions, eq(authPermissions.id, authRolePermissions.permissionId))
    .where(and(eq(authUserRoles.userId, userId), eq(authPermissions.resource, "picking"),
      inArray(authPermissions.action, ["perform", "release_any"]),
      // Generic role constraints have no picking-release contract. Fail closed.
      isNull(authRolePermissions.constraints)))
    // All joined relations are inner joins. Lock them together; PostgreSQL's
    // OF clause rejects the schema-qualified names emitted for these tables.
    .for("share");
  return {
    id: user.id, name: user.name || user.username, role: user.role, active: true,
    permissions: [...new Set(grants.map(grant => `picking:${grant.action}`))],
  };
}
