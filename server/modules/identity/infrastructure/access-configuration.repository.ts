import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { db } from "../../../db";
import { IdentityAdministrationError } from "../domain/access-administration";
import type { AccessConfiguration } from "../domain/access-configuration";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const userSchema = z.object({ id: z.string(), label: z.string(), active: z.number().int() });
const roleSchema = z.object({ id: z.number().int(), name: z.string(), system: z.number().int() });
const permissionSchema = z.object({ id: z.number().int(), key: z.string() });
const membershipSchema = z.object({ userId: z.string(), roleId: z.number().int() });
const grantSchema = z.object({ roleId: z.number().int(), permissionId: z.number().int(), restriction: z.string().nullable() });
const MAX_CONFIGURATION_ROWS = 10_000;
/** Selected access fields only: no passwords, tokens, emails or scope contents leave Identity.
 * Caller uses a repeatable-read snapshot or the serialized administration transaction.
 */
export async function readAccessConfiguration(tx: Pick<Transaction, "execute">): Promise<AccessConfiguration> {
  async function rows<T>(query: Parameters<Transaction["execute"]>[0], schema: z.ZodType<T>) {
    const result = await tx.execute(query);
    if (result.rows.length > MAX_CONFIGURATION_ROWS) throw new IdentityAdministrationError(
      "IDENTITY_ADMINISTRATION_INVALID", 400, "Access review exceeds its supported size. No changes were made.");
    return z.array(schema).parse(result.rows);
  }
  const users = await rows(sql`SELECT id,coalesce(display_name,username) AS label,active FROM identity.users ORDER BY id LIMIT 10001`, userSchema);
  const roles = await rows(sql`SELECT id,name,is_system AS system FROM identity.auth_roles ORDER BY id LIMIT 10001`, roleSchema);
  const permissions = await rows(sql`SELECT id,resource || ':' || action AS key FROM identity.auth_permissions ORDER BY id LIMIT 10001`, permissionSchema);
  const memberships = await rows(sql`SELECT user_id AS "userId",role_id AS "roleId" FROM identity.auth_user_roles ORDER BY user_id,role_id LIMIT 10001`, membershipSchema);
  const grants = await rows(sql`SELECT role_id AS "roleId",permission_id AS "permissionId",constraints::text AS restriction FROM identity.auth_role_permissions ORDER BY role_id,permission_id LIMIT 10001`, grantSchema);
  const snapshot = { users, roles, permissions, memberships, grants };
  // Include assignment and grant contents, not only role.updated_at. Existing
  // writers do not reliably update that field; JSONB null must differ from SQL NULL.
  const revision = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return { ...snapshot, revision };
}
