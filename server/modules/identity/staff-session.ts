import type { RequestHandler, Request } from "express";
// Type-only: loads the express-session typings (`req.session`, `SessionData`) into
// every TypeScript program that contains this file, so the augmentation below
// resolves even when the server entry point is not part of the program.
import type {} from "express-session";
import type { SafeUser } from "@shared/schema";
import { isCurrentStaffCredential } from "@shared/staff-credentials";
export { isCurrentStaffCredential } from "@shared/staff-credentials";
import { readStaffCredentialState } from "./infrastructure/staff-credentials.repository";
import { readCurrentStaffAccess } from "./infrastructure/staff-access.repository";
import { logger } from "../../platform/observability/logger";

declare module "express-session" { interface SessionData {
  user?: SafeUser;
  staffCredentialVersion?: string;
  /** Lifecycle only; never a truthy legacy staff user. */
  staffCredentialCompletion?: {user:SafeUser;credentialVersion:string};
} }
export function staffLifecyclePrincipal(req: Request) {
  return req.session.user ? {user:req.session.user,credentialVersion:req.session.staffCredentialVersion}
    : req.session.staffCredentialCompletion;
}
export function staffSessionActor(req: Request) {
  const principal=staffLifecyclePrincipal(req);
  return { actorId: principal?.user.id ?? "", credentialVersion: principal?.credentialVersion };
}
export function clearStaffSession(req: Request): void {
  delete req.session.user; delete req.session.staffCredentialVersion;
  delete req.session.staffCredentialCompletion;
}
export async function readStaffLifecycleAccess(req:Request) {
  const principal=staffLifecyclePrincipal(req);
  if(!principal)return undefined;
  const access=await readCurrentStaffAccess(principal.user.id);
  const state=await readStaffCredentialState(principal.user.id);
  if(!access || !isCurrentStaffCredential(principal.credentialVersion,state))return undefined;
  return {access,credentialActionRequired:!!req.session.staffCredentialCompletion || !!state?.mustChangePassword};
}
/** Runs immediately after session loading, before ANY application route. It
 * covers legacy guards and direct session-user consumers as well as new guards.
 * Independently authenticated customer/vendor scope is not a staff credential. */
export function createStaffSessionGate(read = readStaffCredentialState): RequestHandler {
  return async (req, res, next) => {
    if (!req.session) return next();
    const principal=staffLifecyclePrincipal(req);
    if (!principal) return next();
    // A stale cookie must not prevent logging in again or ending this session.
    if (req.path === "/api/auth/login" || req.path === "/api/auth/logout"
      || req.path === "/api/auth/forgot-password" || req.path === "/api/auth/reset-password-token") return next();
    try {
      const state = await read(principal.user.id);
      if (!isCurrentStaffCredential(principal.credentialVersion, state)) {
        clearStaffSession(req);
        // Clear staff identity before independent customer/provider routes run.
        return next();
      }
      if (state!.mustChangePassword && req.session.user) {
        req.session.staffCredentialCompletion={user:req.session.user,credentialVersion:state!.credentialVersion};
        delete req.session.user;delete req.session.staffCredentialVersion;
      }
      return next();
    } catch {
      try {logger.error("identity.session.credentials", { module: "identity", outcome: "denied", error_code: "IDENTITY_CREDENTIAL_AUTHORITY_UNAVAILABLE" });}
      catch {/* A diagnostic failure must not admit the request or replace the refusal. */}
      return res.status(503).json({ code: "IDENTITY_CREDENTIAL_AUTHORITY_UNAVAILABLE", error: "Staff session could not be verified." });
    }
  };
}
