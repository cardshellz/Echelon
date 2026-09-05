import type { PoolClient } from "pg";

/** Identity-owned reader for warehouse-work commands. No password or session claims leave Identity. */
export async function readWarehouseWorkActor(client: PoolClient, userId: string) {
  const user = await client.query<{ id: string; active: number }>(
    "SELECT id, active FROM identity.users WHERE id = $1 FOR SHARE", [userId],
  );
  const grants = await client.query<{ action: string; constraints: unknown }>(`
    SELECT p.action, rp.constraints
    FROM identity.auth_user_roles ur
    JOIN identity.auth_role_permissions rp ON rp.role_id = ur.role_id
    JOIN identity.auth_permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = $1 AND p.resource = 'warehouse_work'
    ORDER BY ur.id, rp.id, p.id
    FOR SHARE OF ur, rp, p
  `, [userId]);
  return {
    id: userId,
    active: user.rows[0]?.active === 1,
    // Existing generic constraints have no implemented contract. Never discard them
    // to accidentally turn a restricted role into a warehouse-wide grant.
    permissions: [...new Set(grants.rows.filter((row) => row.constraints === null)
      .map((row) => `warehouse_work:${row.action}`))],
  };
}

export async function readWarehouseWorkEmployees(client: PoolClient, userIds?: readonly string[]) {
  const result = await client.query<{ id: string; name: string; active: number }>(`
    SELECT id, COALESCE(display_name, username) AS name, active
    FROM identity.users WHERE ($1::varchar[] IS NULL OR id = ANY($1::varchar[])) ORDER BY id FOR SHARE
  `, [userIds === undefined ? null : [...userIds]]);
  return result.rows.map((row) => ({ id: row.id, name: row.name, active: row.active === 1 }));
}
