import { randomUUID } from "node:crypto";
import { z } from "zod";

const exactId = z.string().min(1).refine(value => value.trim().length > 0);
export interface IdentityAdministrationActor {
  actorId: string;
  /** Callers may preserve this across a retry. This is correlation, not deduplication. */
  operationId?: string;
  attemptId?: string;
  /** Required for replacement/deletion of reviewed access. Not an authorization token. */
  expectedAccessRevision?: string;
  credentialVersion?: string;
}
export class IdentityAdministrationError extends Error {
  constructor(public readonly code: "IDENTITY_ADMINISTRATION_INVALID" | "IDENTITY_ADMINISTRATION_FORBIDDEN"
    | "IDENTITY_LAST_ACCESS_MANAGER" | "IDENTITY_USER_NOT_FOUND" | "IDENTITY_ACCESS_STALE"
    | "IDENTITY_ACCESS_REVIEW_REQUIRED" | "IDENTITY_ACCESS_DEPENDENCIES" | "IDENTITY_CREDENTIAL_STALE"
    | "IDENTITY_CREDENTIAL_PROOF_REQUIRED" | "IDENTITY_CREDENTIAL_RECOVERY_UNAVAILABLE", public readonly statusCode: 400 | 403 | 404 | 409 | 428 | 503,
    message: string) {
    super(message); this.name = "IdentityAdministrationError";
  }
}
export function parseAdministrationActor(raw: unknown) {
  const parsed = z.object({ actorId: exactId, operationId: z.string().uuid().optional(), attemptId: z.string().uuid().optional(),
    expectedAccessRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(), credentialVersion: z.string().uuid().optional() }).safeParse(raw);
  if (!parsed.success) throw new IdentityAdministrationError("IDENTITY_ADMINISTRATION_INVALID", 400, "A current actor and valid operation context are required.");
  return { ...parsed.data, operationId: parsed.data.operationId ?? randomUUID(), attemptId: parsed.data.attemptId ?? randomUUID() };
}
export const accessManagementCapabilities = ["users:manage_roles", "roles:edit"] as const;
export type AccessManagementCapability = typeof accessManagementCapabilities[number];
export type AccessManagerCounts = Record<AccessManagementCapability, number>;
export function assertAccessManagersPreserved(before: AccessManagerCounts, after: AccessManagerCounts): void {
  if (accessManagementCapabilities.some(capability => before[capability] > 0 && after[capability] === 0)) {
    throw new IdentityAdministrationError("IDENTITY_LAST_ACCESS_MANAGER", 409,
      "This change would remove the last active access manager. Assign an appropriate replacement first.");
  }
}
export function parseAdministrationInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new IdentityAdministrationError("IDENTITY_ADMINISTRATION_INVALID", 400, "Invalid identity administration request.");
  return parsed.data;
}
export const userProfileEditSchema = z.object({
  displayName: z.string().optional(), role: z.string().min(1).max(20).optional(),
  active: z.union([z.literal(0), z.literal(1)]).optional(),
}).strict().refine(value => Object.keys(value).length > 0);
