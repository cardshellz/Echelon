import { z } from "zod";

const userIdSchema = z.string().min(1).max(255).refine(value => value.trim() === value);
const identitySchema = z.object({
  id: userIdSchema,
  active: z.number().int(),
  role: z.string().min(1).max(20),
  roles: z.array(z.object({ name: z.string().min(1).max(100), isSystem: z.number().int().min(0).max(1) }).strict()).max(200),
}).strict();

/** This port exposes current authorization evidence, never a password or cached session role. */
export type CustomerReturnPreviewIdentityReader = (userId: string) => Promise<unknown>;

export class CustomerReturnPreviewAccessError extends Error {
  constructor(
    readonly code: "RETURN_PREVIEW_AUTH_REQUIRED" | "RETURN_PREVIEW_FORBIDDEN" | "RETURN_PREVIEW_UNAVAILABLE",
    readonly status: 401 | 403 | 503,
    message: string,
  ) {
    super(message);
    this.name = "CustomerReturnPreviewAccessError";
  }
}

export async function requireCustomerReturnPreviewAccess(
  sessionUserId: unknown,
  readIdentity: CustomerReturnPreviewIdentityReader,
): Promise<void> {
  const userId = userIdSchema.safeParse(sessionUserId);
  if (!userId.success) throw new CustomerReturnPreviewAccessError("RETURN_PREVIEW_AUTH_REQUIRED", 401, "Staff authentication is required.");
  let identity: z.infer<typeof identitySchema> | null;
  try {
    identity = identitySchema.nullable().parse(await readIdentity(userId.data));
  } catch {
    throw new CustomerReturnPreviewAccessError("RETURN_PREVIEW_UNAVAILABLE", 503, "The admin preview is temporarily unavailable.");
  }
  // The existing account role and RBAC membership are independently editable.
  // For this private preview, either demotion denies access; neither is an OR fallback.
  if (!identity || identity.id !== userId.data || identity.active !== 1 || identity.role !== "admin"
    || !identity.roles.some(role => role.name === "Administrator" && role.isSystem === 1)) {
    throw new CustomerReturnPreviewAccessError("RETURN_PREVIEW_FORBIDDEN", 403, "Active administrator access is required.");
  }
}
