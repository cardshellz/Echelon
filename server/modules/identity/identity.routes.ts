import type { Express } from "express";
import * as repo from "./infrastructure/identity.repository";
import * as useCases from "./application/identity.use-cases";
import { requirePermission, requireAuth, requireActiveSessionIdentity, getRequestStaffAccess } from "../../routes/middleware";
import rateLimit from "express-rate-limit";
import { RolePermissionEditError } from "./domain/role-permission-edit";
import { RoleAssignmentError } from "./domain/role-assignment";
import { IdentityAdministrationError } from "./domain/access-administration";
import { assignedSystemRoleKeys } from "./domain/staff-access";
import { queryAccessReview, queryStaffUserList } from "./application/access-review.query";
import { parseRolePermissionEdit } from "./domain/role-permission-edit";
import { parseRoleAssignment } from "./domain/role-assignment";
import {
  authenticateStaffSession,
  reviewStaffCredentialReset,
  resetStaffPassword,
  changeOwnStaffPassword,
  requestStaffPasswordRecoveryEmail,
  resetStaffPasswordWithToken,
} from "./application/staff-credentials";
import { staffSessionActor, clearStaffSession, readStaffLifecycleAccess } from "./staff-session";
import { readStaffCredentialState } from "./infrastructure/staff-credentials.repository";

const createLoginRateLimiter = () => rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // Limit each IP to 15 login requests per `window`
  message: { error: "Too many login attempts from this IP, please try again after 15 minutes" },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});
const createCredentialRateLimiter = () => rateLimit({windowMs:15*60*1000,max:10,standardHeaders:true,legacyHeaders:false,
  message:{code:"IDENTITY_CREDENTIAL_RATE_LIMITED",error:"Too many credential requests. Try again later."}});

export function registerAuthRoutes(app: Express) {
  const loginRateLimiter=createLoginRateLimiter();
  const credentialRateLimiter=createCredentialRateLimiter();
  // Auth API
  app.post("/api/auth/login", loginRateLimiter, async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: "Username and password required" });
      
      const authenticated = await authenticateStaffSession(username, password);
      // Regenerate only after proof; do not reattach a stale staff principal.
      const customerReturnSession=req.session.customerReturnSession;
      const returnLoginBrowserKey=req.session.returnLoginBrowserKey;
      const secureCookie=req.session.cookie.secure;
      // These namespaces authenticate independently of staff. Their proofs and
      // passkey challenges bind member/action/expiry, not the staff session ID.
      const dropship={dropship:req.session.dropship,dropshipSensitiveProofs:req.session.dropshipSensitiveProofs,
        dropshipPasskeyRegistration:req.session.dropshipPasskeyRegistration,dropshipPasskeyLogin:req.session.dropshipPasskeyLogin,
        dropshipPasskeySensitiveAction:req.session.dropshipPasskeySensitiveAction};
      await new Promise<void>((resolve,reject)=>req.session.regenerate(error=>error?reject(error):resolve()));
      if(authenticated.mustChangePassword)
        req.session.staffCredentialCompletion={user:authenticated.user,credentialVersion:authenticated.credentialVersion};
      else {req.session.user=authenticated.user;req.session.staffCredentialVersion=authenticated.credentialVersion;}
      req.session.customerReturnSession=customerReturnSession;
      req.session.returnLoginBrowserKey=returnLoginBrowserKey;
      Object.assign(req.session,dropship);
      if(secureCookie)req.session.cookie.secure=secureCookie;
      
      req.session.save((err) => {
        if (err) {
          console.error("Session save error:", err);
          return res.status(500).json({ error: "Session failed to save" });
        }
        res.json({ user: authenticated.user });
      });
    } catch (error: any) {
      // Credential/database errors may contain parameters. Never log/serialize them.
      res.status(401).json({ error: "Invalid credentials" });
    }
  });
  
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ error: "Logout failed" });
      res.json({ success: true });
    });
  });
  
  app.get("/api/auth/me", async (req, res, next) => {
    try {
      const lifecycle=await readStaffLifecycleAccess(req);
      if(!lifecycle)return res.status(401).json({error:"Sign in again."});
      const {access,credentialActionRequired}=lifecycle;
      res.json({
        user: access.user,
        permissions: credentialActionRequired?[]:access.permissions,
        roles: access.roles.map(role => role.name),
        assignedRoles: access.roles,
        systemRoles: assignedSystemRoleKeys(access.roles),
        credentialActionRequired,
      });
    } catch (error) {
      // An unavailable authority is not evidence of either zero access or permission.
      next(error);
    }
  });
  app.post("/api/auth/password",credentialRateLimiter,async(req,res)=>{
    try {
      if(!await readStaffLifecycleAccess(req))return res.status(401).json({error:"Sign in again."});
      await changeOwnStaffPassword(req.body,staffSessionActor(req));
      clearStaffSession(req);
      await new Promise<void>((resolve,reject)=>req.session.save(error=>error?reject(error):resolve()));
      res.status(204).end();
    } catch(error) {
      if(error instanceof IdentityAdministrationError) return res.status(error.statusCode).json({code:error.code,error:error.message});
      res.status(503).json({error:"Password change could not be confirmed. Sign in again before retrying."});
    }
  });
  app.post("/api/auth/forgot-password",credentialRateLimiter,async(req,res)=>{
    try {
      const identifier = req.body?.identifier ?? req.body?.username;
      const host = req.get("host");
      const publicOrigin = process.env.PUBLIC_ORIGIN ?? (host ? `${req.protocol}://${host}` : undefined);
      await requestStaffPasswordRecoveryEmail({ identifier }, { publicOrigin });
      res.status(202).json({
        accepted: true,
        message: "If an active account with a recovery email matches, a 15-minute single-use reset link has been sent.",
      });
    } catch(error) {
      if(error instanceof IdentityAdministrationError && error.statusCode === 400) {
        return res.status(400).json({ code: error.code, error: error.message });
      }
      // Uniform response on non-input errors prevents user enumeration.
      res.status(202).json({
        accepted: true,
        message: "If an active account with a recovery email matches, a 15-minute single-use reset link has been sent.",
      });
    }
  });
  app.post("/api/auth/reset-password-token",credentialRateLimiter,async(req,res)=>{
    try {
      await resetStaffPasswordWithToken(req.body);
      if (req.session) {
        clearStaffSession(req);
        await new Promise<void>((resolve,reject)=>req.session.save(error=>error?reject(error):resolve()));
      }
      res.status(204).end();
    } catch(error) {
      if(error instanceof IdentityAdministrationError) return res.status(error.statusCode).json({code:error.code,error:error.message});
      res.status(503).json({error:"Password reset could not be confirmed. Request a new reset link before retrying."});
    }
  });

  app.get("/api/users/:id/credential-review",credentialRateLimiter,requirePermission("users","reset_password"),async(req,res)=>{
    try {res.set("Cache-Control","no-store").json(await reviewStaffCredentialReset(req.params.id,staffSessionActor(req)));}
    catch(error){if(error instanceof IdentityAdministrationError)return res.status(error.statusCode).json({code:error.code,error:error.message});
      res.status(503).json({error:"Credential authority could not be verified."});}
  });
  app.post("/api/users/:id/password-reset",credentialRateLimiter,requirePermission("users","reset_password"),async(req,res)=>{
    try {await resetStaffPassword(req.params.id,req.body,staffSessionActor(req));res.status(204).end();}
    catch(error){if(error instanceof IdentityAdministrationError)return res.status(error.statusCode).json({code:error.code,error:error.message});
      res.status(503).json({error:"Password reset could not be confirmed. Review current state before retrying."});}
  });
  
  // User Management API
  app.get("/api/users", requirePermission("users", "view"), async (req, res) => {
    try {
      const result = await queryStaffUserList(req.session.user!.id);
      res.set("X-Access-Revision",result.revision).set("Cache-Control","no-store").json(result.users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });
  
  app.post("/api/users", requirePermission("users", "create"), async (req, res) => {
    try {
      const { username, password, role, displayName } = req.body;
      if (!username || !password) return res.status(400).json({ error: "Username and password required" });
      
      const safeUser = await useCases.createUserUseCase({
        username,
        password,
        role: role || "picker",
        displayName: displayName || username,
      }, staffSessionActor(req));
      
      res.status(201).json(safeUser);
    } catch (error: any) {
      if (error instanceof IdentityAdministrationError) return res.status(error.statusCode).json({ code: error.code, error: error.message });
      // Do not serialize/log a database error carrying password/hash parameters.
      res.status(500).json({ error: "Failed to create user" });
    }
  });
  
  app.patch("/api/users/:id", requirePermission("users", "edit"), async (req, res) => {
    try {
      const userId = req.params.id;
      const { expectedAccessRevision, ...profile } = req.body ?? {};
      res.json(await useCases.updateUserUseCase(userId, profile, { ...staffSessionActor(req),expectedAccessRevision }));
    } catch (error) {
      if (error instanceof IdentityAdministrationError) return res.status(error.statusCode).json({ code: error.code, error: error.message });
      res.status(500).json({ error: "Failed to update user" });
    }
  });
  
  // RBAC Management API
  app.get("/api/roles", requirePermission("roles", "view"), async (req, res) => {
    try {
      const roles = await repo.getAllRoles();
      res.json(roles);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch roles" });
    }
  });
  
  app.get("/api/permissions", requirePermission("roles", "view"), async (req, res) => {
    try {
      const permissions = await repo.getAllPermissions();
      res.json(permissions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch permissions" });
    }
  });

  app.post("/api/roles/:id/access-review", requirePermission("roles", "view"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const permissionIds = req.body?.permissionIds === undefined ? undefined : parseRolePermissionEdit(id, req.body.permissionIds).permissionIds;
      res.json(await queryAccessReview(req.session.user!.id, { kind: "role", id, permissionIds, removeRole: req.body?.removeRole === true }, req.body?.expectedAccessRevision));
    } catch (error) {
      if (error instanceof IdentityAdministrationError || error instanceof RolePermissionEditError)
        return res.status(error.statusCode).json({ code: error.code, error: error.message });
      res.status(500).json({ error: "Access review could not be verified." });
    }
  });

  app.post("/api/users/:id/access-review", requirePermission("users", "view"), requirePermission("roles", "view"), async (req, res) => {
    try {
      const parsed = parseRoleAssignment(req.params.id, req.body?.roleIds === undefined ? [] : req.body.roleIds);
      res.json(await queryAccessReview(req.session.user!.id, { kind: "user", id: parsed.userId,
        ...(req.body?.roleIds === undefined ? {} : { roleIds: parsed.roleIds }) }, req.body?.expectedAccessRevision));
    } catch (error) {
      if (error instanceof IdentityAdministrationError || error instanceof RoleAssignmentError)
        return res.status(error.statusCode).json({ code: error.code, error: error.message });
      res.status(500).json({ error: "Access review could not be verified." });
    }
  });
  
  app.get("/api/roles/:id/permissions", requirePermission("roles", "view"), async (req, res) => {
    try {
      const permissions = await repo.getRolePermissions(parseInt(req.params.id));
      res.json(permissions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch role permissions" });
    }
  });
  
  app.post("/api/roles", requirePermission("roles", "create"), async (req, res) => {
    try {
      const { name, description, permissionIds } = req.body;
      if (!name) return res.status(400).json({ error: "Role name is required" });
      
      const role = await useCases.createRoleUseCase(name, description ?? null, permissionIds === undefined ? [] : permissionIds, staffSessionActor(req));
      res.status(201).json(role);
    } catch (error) {
      if (error instanceof IdentityAdministrationError || error instanceof RolePermissionEditError) return res.status(error.statusCode).json({ code: error.code, error: error.message });
      res.status(500).json({ error: "Failed to create role" });
    }
  });
  
  app.put("/api/roles/:id/permissions", requirePermission("roles", "edit"), async (req, res) => {
    try {
      const roleId = /^[1-9]\d*$/.test(req.params.id) ? Number(req.params.id) : NaN;
      await useCases.updateRolePermissionsUseCase(roleId, req.body?.permissionIds, { ...staffSessionActor(req),
        expectedAccessRevision: req.body?.expectedAccessRevision });
      res.json({ success: true });
    } catch (error) {
      if (error instanceof RolePermissionEditError || error instanceof IdentityAdministrationError) {
        return res.status(error.statusCode).json({ code: error.code, error: error.message });
      }
      res.status(500).json({ error: "Failed to update role permissions" });
    }
  });
  
  app.delete("/api/roles/:id", requirePermission("roles", "delete"), async (req, res) => {
    try {
      const roleId = /^[1-9]\d*$/.test(req.params.id) ? Number(req.params.id) : NaN;
      const success = await useCases.deleteRoleUseCase(roleId, { ...staffSessionActor(req),
        expectedAccessRevision: req.body?.expectedAccessRevision });
      if (!success) return res.status(400).json({ error: "Cannot delete system roles" });
      res.json({ success: true });
    } catch (error) {
      if (error instanceof IdentityAdministrationError || error instanceof RolePermissionEditError) return res.status(error.statusCode).json({ code: error.code, error: error.message });
      res.status(500).json({ error: "Failed to delete role" });
    }
  });
  
  app.get("/api/users/:id/roles", requirePermission("users", "view"), async (req, res) => {
    try {
      const roles = await repo.getUserRoles(req.params.id);
      res.json(roles);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch user roles" });
    }
  });
  
  app.put("/api/users/:id/roles", requirePermission("users", "manage_roles"), async (req, res) => {
    try {
      await useCases.assignUserRolesUseCase(req.params.id, req.body?.roleIds, { ...staffSessionActor(req),
        expectedAccessRevision: req.body?.expectedAccessRevision });
      res.json({ success: true });
    } catch (error) {
      if (error instanceof RoleAssignmentError || error instanceof IdentityAdministrationError) {
        return res.status(error.statusCode).json({ code: error.code, error: error.message });
      }
      res.status(500).json({ error: "Failed to assign user roles" });
    }
  });
}
