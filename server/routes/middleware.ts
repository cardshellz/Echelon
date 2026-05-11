import type { Request, Response, NextFunction } from "express";
import { hasPermission } from "../modules/identity";
import multer from "multer";

export const upload = multer({ storage: multer.memoryStorage() });

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
