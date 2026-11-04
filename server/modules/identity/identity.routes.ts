import type { Express } from "express";
import * as repo from "./infrastructure/identity.repository";
import * as useCases from "./application/identity.use-cases";
import { requirePermission, requireAuth, requireActiveSessionIdentity, getRequestStaffAccess } from "../../routes/middleware";
import rateLimit from "express-rate-limit";
import { RolePermissionEditError } from "./domain/role-permission-edit";
import { RoleAssignmentError } from "./domain/role-assignment";
import { IdentityAdministrationError } from "./domain/access-administration";
import { assignedSystemRoleKeys } from "./domain/staff-access";

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // Limit each IP to 15 login requests per `window`
  message: { error: "Too many login attempts from this IP, please try again after 15 minutes" },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

export function registerAuthRoutes(app: Express) {
  // Auth API
  app.post("/api/auth/login", loginRateLimiter, async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: "Username and password required" });
      
      const safeUser = await useCases.loginUseCase(username, password);
      req.session.user = safeUser;
      
      req.session.save((err) => {
        if (err) {
          console.error("Session save error:", err);
          return res.status(500).json({ error: "Session failed to save" });
        }
        res.json({ user: safeUser });
      });
    } catch (error: any) {
      console.error("Login error:", error);
      res.status(401).json({ error: error.message || "Login failed" });
    }
  });
  
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ error: "Logout failed" });
      res.json({ success: true });
    });
  });
  
  app.get("/api/auth/me", requireActiveSessionIdentity, async (req, res, next) => {
    try {
      const access = await getRequestStaffAccess(req);
      if (!access) return res.status(401).json({ error: "Not authenticated" });
      res.json({
        user: access.user,
        permissions: access.permissions,
        roles: access.roles.map(role => role.name),
        assignedRoles: access.roles,
        systemRoles: assignedSystemRoleKeys(access.roles),
      });
    } catch (error) {
      // An unavailable authority is not evidence of either zero access or permission.
      next(error);
    }
  });
  
  // User Management API
  app.get("/api/users", requirePermission("users", "view"), async (req, res) => {
    try {
      const users = await repo.getAllUsers();
      res.json(users);
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
      }, { actorId: req.session.user!.id });
      
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
      res.json(await useCases.updateUserUseCase(userId, req.body, { actorId: req.session.user!.id }));
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
      
      const role = await useCases.createRoleUseCase(name, description ?? null, permissionIds === undefined ? [] : permissionIds, { actorId: req.session.user!.id });
      res.status(201).json(role);
    } catch (error) {
      if (error instanceof IdentityAdministrationError || error instanceof RolePermissionEditError) return res.status(error.statusCode).json({ code: error.code, error: error.message });
      res.status(500).json({ error: "Failed to create role" });
    }
  });
  
  app.put("/api/roles/:id/permissions", requirePermission("roles", "edit"), async (req, res) => {
    try {
      const roleId = /^[1-9]\d*$/.test(req.params.id) ? Number(req.params.id) : NaN;
      await useCases.updateRolePermissionsUseCase(roleId, req.body?.permissionIds, { actorId: req.session.user!.id });
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
      const success = await useCases.deleteRoleUseCase(roleId, { actorId: req.session.user!.id });
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
      await useCases.assignUserRolesUseCase(req.params.id, req.body?.roleIds, { actorId: req.session.user!.id });
      res.json({ success: true });
    } catch (error) {
      if (error instanceof RoleAssignmentError || error instanceof IdentityAdministrationError) {
        return res.status(error.statusCode).json({ code: error.code, error: error.message });
      }
      res.status(500).json({ error: "Failed to assign user roles" });
    }
  });
}
