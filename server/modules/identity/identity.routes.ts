import type { Express } from "express";
import { identityStorage as storage } from "../identity";
import { requirePermission, requireAuth } from "../../routes/middleware";
import bcrypt from "bcrypt";
import { getUserPermissions, getUserRoles, getAllRoles, getAllPermissions, getRolePermissions, createRole, updateRolePermissions, deleteRole, assignUserRoles } from "./rbac";
import type { SafeUser } from "@shared/schema";

export function registerAuthRoutes(app: Express) {
  // Auth API
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
      }
      
      const user = await storage.getUserByUsername(username);
      
      if (!user || !user.active) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      
      const validPassword = await bcrypt.compare(password, user.password);
      
      if (!validPassword) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      
      await storage.updateUserLastLogin(user.id);
      
      const safeUser: SafeUser = {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.displayName,
        active: user.active,
        createdAt: user.createdAt,
        lastLoginAt: new Date(),
      };
      
      req.session.user = safeUser;
      
      // Explicitly save session before responding (fixes mobile browser issues)
      req.session.save((err) => {
        if (err) {
          console.error("Session save error:", err);
          return res.status(500).json({ error: "Session failed to save" });
        }
        res.json({ user: safeUser });
      });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });
  
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Logout failed" });
      }
      res.json({ success: true });
    });
  });
  
  app.get("/api/auth/me", async (req, res) => {
    if (req.session.user) {
      try {
        const permissions = await getUserPermissions(req.session.user.id);
        const roles = await getUserRoles(req.session.user.id);
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
      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });
  
  app.post("/api/users", requirePermission("users", "create"), async (req, res) => {
    try {
      
      const { username, password, role, displayName } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
      }
      
      // Check if username already exists
      const existing = await storage.getUserByUsername(username);
      if (existing) {
        return res.status(400).json({ error: "Username already exists" });
      }
      
      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);
      
      const user = await storage.createUser({
        username,
        password: hashedPassword,
        role: role || "picker",
        displayName: displayName || username,
      });
      
      // Return safe user (without password)
      const safeUser: SafeUser = {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.displayName,
        active: user.active,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      };
      
      res.status(201).json(safeUser);
    } catch (error) {
      console.error("Error creating user:", error);
      res.status(500).json({ error: "Failed to create user" });
    }
  });
  
  // Update user
  app.patch("/api/users/:id", requirePermission("users", "edit"), async (req, res) => {
    try {
      const userId = req.params.id;
      const { displayName, role, password, active } = req.body;
      
      // Build update data
      const updateData: { displayName?: string; role?: string; password?: string; active?: number } = {};
      
      if (displayName !== undefined) updateData.displayName = displayName;
      if (role !== undefined) updateData.role = role;
      if (active !== undefined) updateData.active = active;
      
      // If password is provided, hash it
      if (password && password.trim()) {
        updateData.password = await bcrypt.hash(password, 10);
      }
      
      const user = await storage.updateUser(userId, updateData);
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Return safe user (without password)
      const safeUser: SafeUser = {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.displayName,
        active: user.active,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      };
      
      res.json(safeUser);
    } catch (error) {
      console.error("Error updating user:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  });
  
  // RBAC Management API
  
  // Get all roles
  app.get("/api/roles", requirePermission("roles", "view"), async (req, res) => {
    try {
      const roles = await getAllRoles();
      res.json(roles);
    } catch (error) {
      console.error("Error fetching roles:", error);
      res.status(500).json({ error: "Failed to fetch roles" });
    }
  });
  
  // Get all permissions
  app.get("/api/permissions", requirePermission("roles", "view"), async (req, res) => {
    try {
      const permissions = await getAllPermissions();
      res.json(permissions);
    } catch (error) {
      console.error("Error fetching permissions:", error);
      res.status(500).json({ error: "Failed to fetch permissions" });
    }
  });
  
  // Get permissions for a role
  app.get("/api/roles/:id/permissions", requirePermission("roles", "view"), async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const permissions = await getRolePermissions(roleId);
      res.json(permissions);
    } catch (error) {
      console.error("Error fetching role permissions:", error);
      res.status(500).json({ error: "Failed to fetch role permissions" });
    }
  });
  
  // Create a new role
  app.post("/api/roles", requirePermission("roles", "create"), async (req, res) => {
    try {
      const { name, description, permissionIds } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Role name is required" });
      }
      
      const role = await createRole(name, description || null, permissionIds || []);
      res.status(201).json(role);
    } catch (error) {
      console.error("Error creating role:", error);
      res.status(500).json({ error: "Failed to create role" });
    }
  });
  
  // Update role permissions
  app.put("/api/roles/:id/permissions", requirePermission("roles", "edit"), async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const { permissionIds } = req.body;
      
      await updateRolePermissions(roleId, permissionIds || []);
      res.json({ success: true });
    } catch (error) {
      console.error("Error updating role permissions:", error);
      res.status(500).json({ error: "Failed to update role permissions" });
    }
  });
  
  // Delete a role
  app.delete("/api/roles/:id", requirePermission("roles", "delete"), async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const success = await deleteRole(roleId);
      
      if (!success) {
        return res.status(400).json({ error: "Cannot delete system roles" });
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting role:", error);
      res.status(500).json({ error: "Failed to delete role" });
    }
  });
  
  // Get roles for a user
  app.get("/api/users/:id/roles", requirePermission("users", "view"), async (req, res) => {
    try {
      const userId = req.params.id;
      const roles = await getUserRoles(userId);
      res.json(roles);
    } catch (error) {
      console.error("Error fetching user roles:", error);
      res.status(500).json({ error: "Failed to fetch user roles" });
    }
  });
  
  // Assign roles to user
  app.put("/api/users/:id/roles", requirePermission("users", "manage_roles"), async (req, res) => {
    try {
      const userId = req.params.id;
      const { roleIds } = req.body;
      
      await assignUserRoles(userId, roleIds || []);
      res.json({ success: true });
    } catch (error) {
      console.error("Error assigning user roles:", error);
      res.status(500).json({ error: "Failed to assign user roles" });
    }
  });
}
