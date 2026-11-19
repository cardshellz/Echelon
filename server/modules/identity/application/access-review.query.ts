import { db } from "../../../db";
import { readCommandAuthorityActor } from "../infrastructure/command-authority.repository";
import { readAccessConfiguration } from "../infrastructure/access-configuration.repository";
import { buildAccessReview, type AccessProposal } from "../domain/access-review";
import { IdentityAdministrationError } from "../domain/access-administration";
import { accessRevisionSchema } from "@shared/staff-capabilities";
import { getAllUsers } from "../infrastructure/identity.repository";

/** User-list values and the opaque revision must come from one snapshot; pairing
 * stale Active values with a newer revision would defeat the activation guard.
 * This requires users:view only and reveals no role/grant details.
 */
export async function queryStaffUserList(actorId: string) {
  return db.transaction(async tx => {
    const actor = await readCommandAuthorityActor(tx,actorId,{ lock: false });
    if (!actor.active || !actor.permissions.includes("users:view"))
      throw new IdentityAdministrationError("IDENTITY_ADMINISTRATION_FORBIDDEN",403,"Current user-view permission is required.");
    const { revision } = await readAccessConfiguration(tx);
    // The bounded configuration read first proves this snapshot has <=10,000 users.
    const users = await getAllUsers(tx);
    return { users,revision };
  },{ isolationLevel: "repeatable read",accessMode: "read only" });
}

/** Snapshot review, no state changes. Replacement compares this revision under the
 * same administration lock as the mutation; review never supplies authority.
 */
export async function queryAccessReview(actorId: string, proposal: AccessProposal, expectedRevision?: unknown) {
  return db.transaction(async tx => {
    const actor = await readCommandAuthorityActor(tx, actorId, { lock: false });
    const needed = proposal.kind === "user" ? ["users:view","roles:view"] : ["roles:view"];
    if (!actor.active || needed.some(key => !actor.permissions.includes(key)))
      throw new IdentityAdministrationError("IDENTITY_ADMINISTRATION_FORBIDDEN", 403, "Current access-review permission is required.");
    const configuration = await readAccessConfiguration(tx);
    if (expectedRevision !== undefined && (!accessRevisionSchema.safeParse(expectedRevision).success || expectedRevision !== configuration.revision))
      throw new IdentityAdministrationError("IDENTITY_ACCESS_STALE", 409, "Access changed since your review. Reload before editing.");
    const review = buildAccessReview(configuration, proposal, actor.permissions.includes("users:view"));
    // roles:view alone may inspect role grants, not enumerate staff identities.
    return actor.permissions.includes("users:view") ? review : { ...review, users: [],
      dependencies: review.dependencies.map(item => ({ ...item, userId: "affected account" })),
      blockingDependencies: review.blockingDependencies.map(item => ({ ...item, userId: "affected account" })) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
