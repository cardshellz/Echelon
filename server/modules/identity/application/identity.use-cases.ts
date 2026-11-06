import { newStaffPasswordSchema } from "@shared/staff-credentials";
import { db } from "../../../storage/base";
import * as repo from "../infrastructure/identity.repository";
import * as domain from "../domain/identity.domain";
import bcrypt from "bcrypt";
import type { InsertUser, SafeUser, User } from "../../../storage/base";
import type { AuthRole } from "@shared/schema";
import { parseRolePermissionEdit } from "../domain/role-permission-edit";
import { logger } from "../../../platform/observability/logger";
import { parseRoleAssignment } from "../domain/role-assignment";
import { z } from "zod";
import { insertUserSchema } from "@shared/schema";
import { sql } from "drizzle-orm";
import { authenticateStaffSession } from "./staff-credentials";
import { staffCredentials } from "@shared/schema";
import { runIdentityAdministration, type IdentityAdministrationMutation } from "../infrastructure/access-administration.repository";
import { IdentityAdministrationError, parseAdministrationActor, parseAdministrationInput, userProfileEditSchema,
  type IdentityAdministrationActor } from "../domain/access-administration";

function safeUser(user: User): SafeUser {
  const { password: _password, ...safe } = user;
  return safe;
}
function userAuditState(user: User | undefined) {
  return user ? { id: user.id, active: user.active, displayName: user.displayName, legacyRoleLabel: user.role } : null;
}
type IdentityTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function runAdministration<T>(rawActor: IdentityAdministrationActor, permission: string, action: string,
  change: (tx: IdentityTransaction) => Promise<IdentityAdministrationMutation<T>>): Promise<T> {
  const actor = parseAdministrationActor(rawActor);
  const started = performance.now();
  const report = (outcome: "succeeded" | "failed", code?: string) => {
    try {
      logger[outcome === "succeeded" ? "info" : "error"](`identity.access.${action}`, {
        module: "identity", outcome, operationId: actor.operationId, attemptId: actor.attemptId,
        actorId: actor.actorId, duration_ms: performance.now() - started,
        release: process.env.HEROKU_SLUG_COMMIT ?? process.env.RELEASE_VERSION ?? "unknown",
        ...(code ? { error_code: code, failed_step: "access_transaction", retry_safety: "recheck_current_authority" } : {}),
      });
    } catch { /* Diagnostics cannot undo a committed audit or replace the original failure. */ }
  };
  try {
    const result = await db.transaction(tx => runIdentityAdministration(tx, actor, permission, action, () => change(tx)));
    report("succeeded");
    return result;
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      && error.code.startsWith("IDENTITY_") ? error.code : "IDENTITY_ADMINISTRATION_FAILED";
    report("failed", code);
    throw error;
  }
}
async function lockUser(tx: IdentityTransaction, userId: string): Promise<User> {
  await tx.execute(sql`SELECT id FROM identity.users WHERE id=${userId} FOR UPDATE`);
  const user = await repo.getUser(userId, tx);
  if (!user) throw new IdentityAdministrationError("IDENTITY_USER_NOT_FOUND", 404, "User not found.");
  return user;
}
async function roleAuditState(tx: IdentityTransaction, roleId: number) {
  const roles = await tx.execute(sql`SELECT id,name,description,is_system AS "isSystem"
    FROM identity.auth_roles WHERE id=${roleId} FOR UPDATE`);
  if (!roles.rows[0]) return null;
  const grants = await tx.execute(sql`SELECT permission_id AS "permissionId",constraints,(constraints IS NOT NULL) AS "isRestricted"
    FROM identity.auth_role_permissions WHERE role_id=${roleId} ORDER BY permission_id FOR UPDATE`);
  return { ...roles.rows[0], grants: grants.rows };
}

export async function loginUseCase(username:string,passwordString:string):Promise<SafeUser> {
  return (await authenticateStaffSession(username,passwordString)).user;
}

export async function createUserUseCase(raw: InsertUser, actor: IdentityAdministrationActor): Promise<SafeUser> {
  const data = parseAdministrationInput(insertUserSchema.extend({ username: z.string().min(1), password: newStaffPasswordSchema }).strict(), raw);
  const password = await bcrypt.hash(data.password, 10);
  return runAdministration(actor, "users:create", "user_created", async tx => {
    const existing = await repo.getUserByUsername(data.username, tx);
    if (existing) throw new IdentityAdministrationError("IDENTITY_ADMINISTRATION_INVALID", 400, "Username already exists.");
    const user = await repo.createUser({ ...data, password }, tx);
    await tx.insert(staffCredentials).values({ userId: user.id });
    // Account creation never assigns roles, including for a legacy admin label.
    return { result: safeUser(user), target: `user:${user.id}`, before: null, after: { ...userAuditState(user), roleIds: [] } };
  });
}

export async function createRoleUseCase(name: string, description: string | null, permissionIds: number[], actor: IdentityAdministrationActor): Promise<AuthRole> {
  const data = parseAdministrationInput(z.object({ name: z.string().min(1).max(100), description: z.string().nullable() }), { name, description });
  const ids = parseRolePermissionEdit(1, permissionIds).permissionIds;
  return runAdministration(actor, "roles:create", "role_created", async tx => {
    const role = await repo.createRole(data.name, data.description, ids, tx);
    return { result: role, target: `role:${role.id}`, before: null, after: await roleAuditState(tx, role.id) };
  });
}

export async function updateRolePermissionsUseCase(roleId: unknown, permissionIds: unknown, actor: IdentityAdministrationActor): Promise<void> {
  const edit = parseRolePermissionEdit(roleId, permissionIds);
  return runAdministration(actor, "roles:edit", "role_permissions_replaced", async tx => {
    const before = await roleAuditState(tx, edit.roleId);
    await repo.updateRolePermissions(edit.roleId, edit.permissionIds, tx);
    return { result: undefined, target: `role:${edit.roleId}`, before, after: await roleAuditState(tx, edit.roleId) };
  });
}

export async function assignUserRolesUseCase(userId: unknown, roleIds: unknown, actor: IdentityAdministrationActor): Promise<void> {
  const assignment = parseRoleAssignment(userId, roleIds);
  return runAdministration(actor, "users:manage_roles", "user_roles_replaced", async tx => {
    await lockUser(tx, assignment.userId);
    const before = { roleIds: (await repo.getUserRoles(assignment.userId, tx)).map(role => role.id).sort((a, b) => a - b) };
    await repo.assignUserRoles(assignment.userId, assignment.roleIds, tx);
    return { result: undefined, target: `user:${assignment.userId}`, before, after: { roleIds: [...assignment.roleIds].sort((a, b) => a - b) } };
  });
}

export async function updateUserUseCase(userId: string, raw: z.input<typeof userProfileEditSchema>, actor: IdentityAdministrationActor): Promise<SafeUser> {
  const id = parseRoleAssignment(userId, []).userId;
  const data = parseAdministrationInput(userProfileEditSchema, raw);
  return runAdministration(actor, "users:edit", "user_updated", async tx => {
    const beforeUser = await lockUser(tx, id);
    if (data.active !== undefined && data.active !== beforeUser.active && !actor.expectedAccessRevision)
      throw new IdentityAdministrationError("IDENTITY_ACCESS_REVIEW_REQUIRED", 428,
        "Reload current account access before changing activation.");
    const updated = await repo.updateUser(id, data, tx) ?? beforeUser;
    return { result: safeUser(updated), target: `user:${id}`, before: userAuditState(beforeUser),
      after: userAuditState(updated) };
  });
}

export async function deleteRoleUseCase(roleId: number, actor: IdentityAdministrationActor): Promise<boolean> {
  const id = parseRolePermissionEdit(roleId, []).roleId;
  return runAdministration(actor, "roles:delete", "role_deleted", async tx => {
    const before = await roleAuditState(tx, id);
    const memberships = await tx.execute(sql`SELECT user_id AS "userId" FROM identity.auth_user_roles
      WHERE role_id=${id} ORDER BY user_id FOR UPDATE`);
    const deleted = await repo.deleteRole(id, tx);
    if (!deleted) throw new IdentityAdministrationError("IDENTITY_ADMINISTRATION_INVALID", 400, "Cannot delete system roles or a missing role.");
    return { result: deleted, target: `role:${id}`, before: { ...before, affectedUserIds: memberships.rows.map(row => row.userId) }, after: null };
  });
}

function reportDefinitionRegistration(level: "info" | "error", fields: Parameters<typeof logger.info>[1]): void {
  try {
    logger[level]("identity.definitions.register", fields);
  } catch {
    // Diagnostic delivery must not turn a committed registration into a failed
    // database operation or mask the original DB error. This is deliberately a
    // best-effort side channel, not the durable audit for an access mutation.
  }
}

export async function seedRBACUseCase(): Promise<void> {
  const started = performance.now();
  try {
    const registered = await db.transaction(tx => repo.registerIdentityDefinitions(
      domain.DEFAULT_PERMISSIONS,
      Object.values(domain.SYSTEM_ROLES).map(role => ({ name: role.name, description: role.description })),
      tx,
    ));
    reportDefinitionRegistration("info", {
      module: "identity", outcome: "succeeded", duration_ms: performance.now() - started, ...registered,
    });
  } catch (error) {
    reportDefinitionRegistration("error", {
      module: "identity", outcome: "failed", duration_ms: performance.now() - started,
      error_code: "IDENTITY_DEFINITION_REGISTRATION_FAILED", dependency: "database",
    });
    throw error;
  }
}

export async function seedAdjustmentReasonsUseCase(): Promise<void> {
  try {
    const { adjustmentReasons } = await import("@shared/schema");
    await db.select().from(adjustmentReasons).limit(1);
    
    const { eq } = await import("drizzle-orm");
    const oldLowercaseCodes = ["po_received", "rma_return", "cycle_count", "damaged"];
    
    for (const code of oldLowercaseCodes) {
      try { await db.delete(adjustmentReasons).where(eq(adjustmentReasons.code, code)); } catch(e) {}
    }

    for (const reason of domain.DEFAULT_ADJUSTMENT_REASONS) {
      try { await db.insert(adjustmentReasons).values(reason as any).onConflictDoNothing(); } catch(e) {}
    }
  } catch(e) { /* ignore schema error during early startup */ }
}
