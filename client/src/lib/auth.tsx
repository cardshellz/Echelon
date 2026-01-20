import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { SafeUser } from "@shared/schema";

interface AuthContextType {
  user: SafeUser | null;
  permissions: string[];
  roles: string[];
  isLoading: boolean;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
  hasPermission: (resource: string, action: string) => boolean;
  hasAnyPermission: (perms: Array<{ resource: string; action: string }>) => boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SafeUser | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        setPermissions(data.permissions || []);
        setRoles(data.roles || []);
      } else {
        setUser(null);
        setPermissions([]);
        setRoles([]);
      }
    } catch {
      setUser(null);
      setPermissions([]);
      setRoles([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const login = async (username: string, password: string) => {
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      
      if (res.ok && data.user) {
        setUser(data.user);
        await refetch();
        return { success: true };
      }
      return { success: false, error: data.error || "Login failed" };
    } catch {
      return { success: false, error: "Network error" };
    }
  };

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
      setPermissions([]);
      setRoles([]);
    }
  };

  const hasPermission = useCallback((resource: string, action: string) => {
    return permissions.includes(`${resource}:${action}`);
  }, [permissions]);

  const hasAnyPermission = useCallback((perms: Array<{ resource: string; action: string }>) => {
    return perms.some(({ resource, action }) => permissions.includes(`${resource}:${action}`));
  }, [permissions]);

  return (
    <AuthContext.Provider value={{ 
      user, 
      permissions, 
      roles, 
      isLoading, 
      login, 
      logout, 
      refetch,
      hasPermission,
      hasAnyPermission,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

export function useRequireAuth(allowedRoles?: string[]) {
  const { user, isLoading } = useAuth();
  
  if (isLoading) return { authorized: false, loading: true, user: null };
  if (!user) return { authorized: false, loading: false, user: null };
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return { authorized: false, loading: false, user };
  }
  return { authorized: true, loading: false, user };
}

export function useRequirePermission(resource: string, action: string) {
  const { user, isLoading, hasPermission } = useAuth();
  
  if (isLoading) return { authorized: false, loading: true, user: null };
  if (!user) return { authorized: false, loading: false, user: null };
  if (!hasPermission(resource, action)) {
    return { authorized: false, loading: false, user };
  }
  return { authorized: true, loading: false, user };
}
