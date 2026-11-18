import type { Request, Response, NextFunction } from "express";
import { readCurrentStaffAccess, hasAssignedSystemRole, hasPermission,
  type CurrentStaffAccess, type StaffSystemRole } from "../modules/identity";
import multer from "multer";

/**
 * Shared upload handler for CSV imports and invoice attachments.
 *
 * `memoryStorage()` buffers the whole file in RAM, so without `limits` a single
 * request can allocate as much as the client chooses to send. That matters more
 * than it looks: this instance is used by at least six routes, including
 * /api/vendor-invoices/:id/attachments, and Buffers live off-heap where
 * --max-old-space-size does not constrain them. On a 512MB dyno an unbounded
 * upload is a crash, not a slow request.
 *
 * 10MB matches the ceiling catalog asset uploads already enforce.
 */
export const UPLOAD_MAX_BYTES =
  Number(process.env.UPLOAD_MAX_BYTES) > 0
    ? Number(process.env.UPLOAD_MAX_BYTES)
    : 10 * 1024 * 1024;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 },
});

// Cache only for this HTTP request, never in the session or across requests. This
// makes identity and system-role guards agree on one account/membership/grant snapshot. Commands
// that require authority through commit must also use their transactional reader.
const requestAccess = new WeakMap<Request, { userId: string; access: Promise<CurrentStaffAccess | undefined> }>();

export function getRequestStaffAccess(req: Request): Promise<CurrentStaffAccess | undefined> {
  const userId = req.session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) return Promise.resolve(undefined);
  const cached = requestAccess.get(req);
  if (cached?.userId === userId) return cached.access;
  const access = readCurrentStaffAccess(userId);
  requestAccess.set(req, { userId, access });
  return access;
}

async function requireCurrentIdentity(req: Request, res: Response, operational: boolean) {
  const access = await getRequestStaffAccess(req);
  if (!access) {
    res.status(401).json({ error: "Authentication required" });
    return undefined;
  }
  if (operational && access.roles.length === 0) {
    res.status(403).json({ code: "IDENTITY_ACCESS_UNASSIGNED", error: "No staff roles are assigned" });
    return undefined;
  }
  return access;
}

export function requirePermission(resource: string, action: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.session?.user) return res.status(401).json({ error: "Authentication required" });
    try {
      // The canonical capability reader already requires a current active account,
      // assigned roles and an unrestricted grant. Preserve this public guard's
      // existing 403 deny contract; no session role grants capability access.
      if (!await hasPermission(req.session.user.id, resource, action)) {
        return res.status(403).json({ error: `Permission denied: ${resource}:${action}` });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export type PermissionGrant = readonly [resource: string, action: string];

/**
 * Allows the request when the session user holds ANY of the listed grants.
 * Each grant uses the current Identity permission reader. Evaluation stops at
 * the first allow. Intended for read-only views that two operator
 * roles legitimately share (for example the live inventory runtime authority
 * shown on both Channel Allocation and Channel Inventory). A permission-owner
 * failure is forwarded to the error handler instead of being treated as a deny
 * or an allow.
 */
export function requireAnyPermission(...grants: PermissionGrant[]) {
  if (grants.length === 0) {
    throw new Error("requireAnyPermission requires at least one grant");
  }
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.session?.user) return res.status(401).json({ error: "Authentication required" });
    try {
      for (const [resource, action] of grants) {
        if (await hasPermission(req.session.user.id, resource, action)) return next();
      }
    } catch (error) {
      return next(error);
    }
    const denied = grants.map(([resource, action]) => `${resource}:${action}`).join(" or ");
    return res.status(403).json({ error: `Permission denied: ${denied}` });
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    if (await requireCurrentIdentity(req, res, true)) next();
  } catch (error) {
    next(error);
  }
}

/** Authentication lifecycle may show an active identity with no operational access. */
export async function requireActiveSessionIdentity(req: Request, res: Response, next: NextFunction) {
  try {
    if (await requireCurrentIdentity(req, res, false)) next();
  } catch (error) {
    next(error);
  }
}

export function requireAssignedSystemRole(...roles: StaffSystemRole[]) {
  if (roles.length === 0) throw new Error("requireAssignedSystemRole requires at least one role");
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const access = await requireCurrentIdentity(req, res, true);
      if (!access) return;
      if (!hasAssignedSystemRole(access, roles)) {
        return res.status(403).json({ error: "An assigned system role is required" });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requestHasInternalApiKey(req: Request): boolean {
  const configuredKey = process.env.INTERNAL_API_KEY;
  const authHeader = req.headers.authorization;
  const providedKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  return Boolean(configuredKey && providedKey && providedKey === configuredKey);
}

export function requireInternalApiKey(req: Request, res: Response, next: NextFunction) {
  if (!requestHasInternalApiKey(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

export function requireAuthOrInternalApiKey(req: Request, res: Response, next: NextFunction) {
  if (requestHasInternalApiKey(req)) {
    return next();
  }
  return requireAuth(req, res, next);
}
