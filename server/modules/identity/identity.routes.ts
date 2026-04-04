import type { Express } from "express";
import * as repo from "./infrastructure/identity.repository";
import * as useCases from "./application/identity.use-cases";
import { requirePermission, requireAuth } from "../../routes/middleware";
import type { SafeUser } from "@shared/schema";
import bcrypt from "bcrypt"; // Keep for update password if not fully extracted yet, or extract it too.

export function registerAuthRoutes(app: Express) {
  // Auth API
  app.post("/api/auth/login", async (req, res) => {
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
  
  app.get("/api/auth/me", async (req, res) => {
    if (req.session.user) {
      try {
        const permissions = await repo.getUserPermissions(req.session.user.id);
        const roles = await repo.getUserRoles(req.session.user.id);
        res.json({ 
          user: req.session.user,
          permissions,
          roles: roles.map(r => r.name),
        });
      } catch (error) {
        res.json({ user: req.session.user, permissions: [], roles: [] });
      }
    } else {
      res.status(401).json({ error: "Not authenticated" });
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
      });
      
      res.status(201).json(safeUser);
    } catch (error: any) {
      console.error("Error creating user:", error);
      res.status(400).json({ error: error.message || "Failed to create user" });
    }
  });
  
  app.patch("/api/users/:id", requirePermission("users", "edit"), async (req, res) => {
    try {
      const userId = req.params.id;
      const { displayName, role, password, active } = req.body;
      
      const updateData: { displayName?: string; role?: string; password?: string; active?: number } = {};
      if (displayName !== undefined) updateData.displayName = displayName;
      if (role !== undefined) updateData.role = role;
      if (active !== undefined) updateData.active = active;
      if (password && password.trim()) updateData.password = await bcrypt.hash(password, 10);
      
      const user = await repo.updateUser(userId, updateData);
      if (!user) return res.status(404).json({ error: "User not found" });
      
      const safeUser: SafeUser = {
        id: user.id, username: user.username, role: user.role,
        displayName: user.displayName, active: user.active,
        createdAt: user.createdAt, lastLoginAt: user.lastLoginAt,
      };
      
      res.json(safeUser);
    } catch (error) {
      console.error("Error updating user:", error);
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
      
      const role = await useCases.createRoleUseCase(name, description || null, permissionIds || []);
      res.status(201).json(role);
    } catch (error) {
      res.status(500).json({ error: "Failed to create role" });
    }
  });
  
  app.put("/api/roles/:id/permissions", requirePermission("roles", "edit"), async (req, res) => {
    try {
      await useCases.updateRolePermissionsUseCase(parseInt(req.params.id), req.body.permissionIds || []);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to update role permissions" });
    }
  });
  
  app.delete("/api/roles/:id", requirePermission("roles", "delete"), async (req, res) => {
    try {
      const success = await repo.deleteRole(parseInt(req.params.id));
      if (!success) return res.status(400).json({ error: "Cannot delete system roles" });
      res.json({ success: true });
    } catch (error) {
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
      await useCases.assignUserRolesUseCase(req.params.id, req.body.roleIds || []);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to assign user roles" });
    }
  });
}
