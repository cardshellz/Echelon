import { sql } from "drizzle-orm";
import type { db } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/transactional-audit";
import { readCommandAuthorityActor } from "./command-authority.repository";
import { assertAccessManagersPreserved, IdentityAdministrationError,
  parseAdministrationActor, type AccessManagerCounts, type IdentityAdministrationActor } from "../domain/access-administration";
import { readIdentityAccessPreflight } from "./access-preflight.repository";
import { readAccessConfiguration } from "./access-configuration.repository";
import { assertNoNewDependencyGaps } from "../domain/access-review";
import { readStaffCredentialState } from "./staff-credentials.repository";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Evidence = Record<string, unknown> | null;
export type IdentityAdministrationMutation<T> = { result: T; target: string; before: Evidence; after: Evidence };

/** Current unrestricted holders only. Separate people may manage assignments and grants. */
async function readAccessManagerCoverage(tx: Pick<Transaction, "execute">) {
  const snapshot = await readIdentityAccessPreflight(tx);
  const commands: AccessManagerCounts = { "users:manage_roles": 0, "roles:edit": 0 };
  const ui: AccessManagerCounts = { "users:manage_roles": 0, "roles:edit": 0 };
  for (const row of snapshot.capabilities) {
    commands[row.capability] = row.holders;
    ui[row.capability] = row.uiReadyHolders;
  }
  return { commands, ui };
}

/**
 * Every public access writer participates in this gate BEFORE actor/target locks.
 * It serializes low-volume administration, avoiding cross-editor lock upgrades and
 * making the last-manager check atomic. It never serializes ordinary business work.
 * Repository primitives are private to Identity and require the caller's transaction.
 */
export async function runIdentityAdministration<T>(tx: Transaction, rawActor: IdentityAdministrationActor,
  permission: string, action: string, change: () => Promise<IdentityAdministrationMutation<T>>): Promise<T> {
  const actor = parseAdministrationActor(rawActor);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('echelon.identity.access_administration.v1',0))`);
  const authority = await readCommandAuthorityActor(tx, actor.actorId);
  if (!authority.active || !authority.permissions.includes(permission)) {
    throw new IdentityAdministrationError("IDENTITY_ADMINISTRATION_FORBIDDEN", 403, "Current permission is required for this access change.");
  }
  {
    const state=await readStaffCredentialState(actor.actorId,tx);
    if(!actor.credentialVersion || !state || state.credentialVersion!==actor.credentialVersion || state.mustChangePassword)
      throw new IdentityAdministrationError("IDENTITY_CREDENTIAL_STALE",403,"Sign in again with current credentials.");
  }
  const beforeConfiguration = await readAccessConfiguration(tx);
  if (["role_permissions_replaced", "user_roles_replaced", "role_deleted"].includes(action) || actor.expectedAccessRevision !== undefined) {
    if (!actor.expectedAccessRevision) throw new IdentityAdministrationError(
      "IDENTITY_ACCESS_REVIEW_REQUIRED", 428, "Reload and review current access before saving.");
    if (actor.expectedAccessRevision !== beforeConfiguration.revision) throw new IdentityAdministrationError(
      "IDENTITY_ACCESS_STALE", 409, "Access changed since your review. Reload and review the current assignments.");
  }
  const beforeCounts = await readAccessManagerCoverage(tx);
  const mutation = await change();
  assertNoNewDependencyGaps(beforeConfiguration, await readAccessConfiguration(tx));
  const afterCounts = await readAccessManagerCoverage(tx);
  assertAccessManagersPreserved(beforeCounts.commands, afterCounts.commands);
  assertAccessManagersPreserved(beforeCounts.ui, afterCounts.ui);
  await persistAuditEvent(tx, {
    actor: actor.actorId, action: `identity.access.${action}`, target: mutation.target,
    changes: { before: mutation.before, after: mutation.after },
    context: { operationId: actor.operationId, attemptId: actor.attemptId, reason: action, requiredPermission: permission },
  }, { emitStructuredLog: false });
  return mutation.result;
}
