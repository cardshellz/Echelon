import type pg from "pg";
import * as schema from "@shared/schema";
import { rfqCommandReceiptSchema } from "@shared/procurement/rfq-command";
import type { createRfqWorkflowCommands } from "../../rfq-workflow.commands";

export const RFQ_AUTHORITY_TABLES = [schema.users, schema.authRoles, schema.authPermissions,
  schema.authUserRoles, schema.authRolePermissions];

/** Actual Identity rows and grants, installed only in the caller's owned database. */
export async function seedRfqEditActor(pool: pg.Pool, actorId: string): Promise<void> {
  await pool.query("INSERT INTO identity.users(id,username,password,role,active) VALUES($1,$2,'fixture-only','picker',1)", [actorId, actorId]);
  await pool.query("INSERT INTO identity.auth_roles(id,name,is_system) OVERRIDING SYSTEM VALUE VALUES(1,'rfq-editor',0)");
  await pool.query("INSERT INTO identity.auth_permissions(id,resource,action,category) OVERRIDING SYSTEM VALUE VALUES(1,'purchasing','edit','purchasing')");
  await pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,1)", [actorId]);
  await pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES(1,1,NULL)");
}

/** Preserve existing domain assertions at the legacy response boundary. New
 * recovery tests use the durable owner directly and inspect its saved receipt. */
export function legacyRfqTestCommands(commands: ReturnType<typeof createRfqWorkflowCommands>) {
  return {
    async execute(...args: Parameters<typeof commands.execute>) {
      const response = await commands.execute(...args);
      return response.terminalState === "succeeded"
        ? { ...response, body: rfqCommandReceiptSchema.parse(response.body).result } : response;
    },
  };
}
