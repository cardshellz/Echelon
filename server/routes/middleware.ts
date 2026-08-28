import type { Request, Response, NextFunction } from "express";
import { hasPermission } from "../modules/identity";
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

export function requirePermission(resource: string, action: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const allowed = await hasPermission(req.session.user.id, resource, action);
    if (!allowed) {
      return res.status(403).json({ error: `Permission denied: ${resource}:${action}` });
    }

    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
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
  if (requestHasInternalApiKey(req) || req.session.user) {
    return next();
  }

  return res.status(401).json({ error: "Authentication required" });
}
