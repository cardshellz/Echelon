import { z } from "zod";

export const credentialVersionSchema = z.string().uuid();
export function isCurrentStaffCredential(sessionVersion: unknown, state: {credentialVersion:string} | undefined): boolean {
  return credentialVersionSchema.safeParse(sessionVersion).success && sessionVersion === state?.credentialVersion;
}
// bcrypt uses at most 72 UTF-8 bytes. Reject truncation rather than silently
// making different proposed credentials equivalent. Never trim a credential.
export const newStaffPasswordSchema = z.string().min(1).refine(value => new TextEncoder().encode(value).length <= 72);
export const resetStaffPasswordSchema = z.object({
  password: newStaffPasswordSchema,
  currentPassword: z.string().min(1),
  expectedCredentialVersion: credentialVersionSchema,
  expectedAccessRevision: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
}).strict();
export const changeStaffPasswordSchema = z.object({
  currentPassword: z.string().min(1), password: newStaffPasswordSchema,
  operationId: z.string().uuid(),
}).strict();
export const STAFF_PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
export const forgotStaffPasswordRequestSchema = z.object({
  identifier: z.string().trim().min(1).max(320),
}).strict();
export const resetStaffPasswordWithTokenSchema = z.object({
  token: z.string().trim().min(1).max(2048),
  password: newStaffPasswordSchema,
  operationId: z.string().uuid(),
}).strict();
export const breakGlassStaffPasswordRecoverySchema = z.object({
  userId: z.string().trim().min(1).optional(),
  username: z.string().trim().min(1).optional(),
  password: newStaffPasswordSchema,
  reason: z.string().trim().min(10).max(500),
  operator: z.string().trim().min(1).max(200),
  operationId: z.string().uuid(),
}).strict().refine(value => Boolean(value.userId || value.username), {
  message: "Either userId or username is required for break-glass recovery.",
});
export const staffCredentialReviewSchema = z.object({
  userId: z.string().min(1), credentialVersion: credentialVersionSchema,
  protectedTarget: z.boolean(), requiredPermission: z.string(),
  expectedAccessRevision: z.string().regex(/^[a-f0-9]{64}$/),
  lastOperationId: z.string().uuid().nullable(),
});
export const STAFF_RESET_PERMISSION = "users:reset_password";
export const STAFF_PRIVILEGED_RESET_PERMISSION = "users:reset_privileged_password";
/** Credential control can impersonate access-control holders. Classification is
 * independent of role names, current activity and unsupported grant scopes. */
export const STAFF_CONTROL_PERMISSIONS = [
  "users:manage_roles", "roles:create", "roles:edit", "roles:delete",
  "warehouse_work:manage_access", STAFF_RESET_PERMISSION, STAFF_PRIVILEGED_RESET_PERMISSION,
] as const;
