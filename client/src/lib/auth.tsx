import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import type { SafeUser } from "@shared/schema";
import { queryClient } from "./queryClient";
import { staffAuthorityKey, staffAuthoritySchema, type AssignedStaffRole, type StaffSystemRole } from "./staff-authority";

type AccessStatus = "loading" | "authenticated" | "anonymous" | "unverified";
interface AuthContextType {
  user: SafeUser | null;
  permissions: string[];
  roles: string[];
  assignedRoles: AssignedStaffRole[];
  systemRoles: StaffSystemRole[];
  accessStatus: AccessStatus;
  accessError: string | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
  hasPermission: (resource: string, action: string) => boolean;
  hasAnyPermission: (perms: Array<{ resource: string; action: string }>) => boolean;
  hasSystemRole: (role: StaffSystemRole) => boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);
const verificationError = "Your access could not be verified. Refresh access or sign out and try again.";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SafeUser | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [assignedRoles, setAssignedRoles] = useState<AssignedStaffRole[]>([]);
  const [systemRoles, setSystemRoles] = useState<StaffSystemRole[]>([]);
  const [accessStatus, setAccessStatus] = useState<AccessStatus>("loading");
  const [accessError, setAccessError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const sessionActionInFlight = useRef(false);
  const authorityKey = useRef<string | null>(null);

  const clearAuthority = useCallback(() => {
    const hadVerifiedStaffAuthority = authorityKey.current !== null;
    setPermissions([]);
    setRoles([]);
    setAssignedRoles([]);
    setSystemRoles([]);
    authorityKey.current = null;
    // AuthProvider also wraps independent public/vendor portals. An anonymous
    // staff probe must not cancel their initial queries or repeatedly clear them.
    if (hadVerifiedStaffAuthority) {
      void queryClient.cancelQueries();
      queryClient.clear();
    }
  }, []);

  const readAuthority = useCallback(async (): Promise<"verified" | "anonymous" | "unverified" | "superseded"> => {
    const generation = ++requestGeneration.current;
    try {
      const response = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });
      if (generation !== requestGeneration.current) return "superseded";
      if (response.status === 401) {
        clearAuthority();
        setUser(null);
        setAccessError(null);
        setAccessStatus("anonymous");
        return "anonymous";
      }
      if (!response.ok) throw new Error("Authority read failed");
      const authority = staffAuthoritySchema.parse(await response.json());
      if (generation !== requestGeneration.current) return "superseded";
      const nextKey = staffAuthorityKey(authority);
      if (authorityKey.current !== null && authorityKey.current !== nextKey) {
        void queryClient.cancelQueries();
        queryClient.clear();
      }
      authorityKey.current = nextKey;
      setUser(authority.user);
      setPermissions(authority.permissions);
      setRoles(authority.roles);
      setAssignedRoles(authority.assignedRoles);
      setSystemRoles(authority.systemRoles);
      setAccessError(null);
      setAccessStatus("authenticated");
      return "verified";
    } catch {
      if (generation !== requestGeneration.current) return "superseded";
      clearAuthority();
      setAccessError(verificationError);
      setAccessStatus("unverified");
      return "unverified";
    }
  }, [clearAuthority]);

  // A manual refresh must not race a login/logout that changes the server cookie.
  // Login uses the private reader after its successful session write.
  const refetch = useCallback(async () => {
    if (!sessionActionInFlight.current) await readAuthority();
  }, [readAuthority]);

  useEffect(() => {
    void refetch();
    const onFocus = () => { if (!sessionActionInFlight.current) void refetch(); };
    const onVisibility = () => { if (document.visibilityState === "visible") onFocus(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      ++requestGeneration.current;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refetch]);

  const login = async (username: string, password: string) => {
    if (sessionActionInFlight.current) return { success: false, error: "A sign-in or sign-out request is still pending." };
    sessionActionInFlight.current = true;
    const generation = ++requestGeneration.current;
    clearAuthority();
    setUser(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      if (generation !== requestGeneration.current) return { success: false, error: "Sign-in was interrupted. Try again." };
      if (!response.ok) {
        setAccessStatus("anonymous");
        return { success: false, error: response.status === 429 ? "Too many sign-in attempts. Try again later." : "Sign-in failed. Check your credentials." };
      }
      // Login's compatibility user does not enable pages; /me supplies authority.
      setAccessStatus("loading");
      const status = await readAuthority();
      if (status === "anonymous" || status === "superseded") {
        return { success: false, error: "Your session could not be verified. Sign in again." };
      }
      return { success: true };
    } catch {
      if (generation !== requestGeneration.current) return { success: false, error: "Sign-in was interrupted. Try again." };
      setAccessStatus("anonymous");
      return { success: false, error: "Network error. Try again." };
    } finally {
      sessionActionInFlight.current = false;
    }
  };

  const logout = async () => {
    if (sessionActionInFlight.current) throw new Error("A sign-in or sign-out request is still pending");
    sessionActionInFlight.current = true;
    ++requestGeneration.current;
    clearAuthority();
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("Sign-out failed");
      ++requestGeneration.current;
      setUser(null);
      setAccessError(null);
      setAccessStatus("anonymous");
    } catch {
      setAccessError("Sign-out could not be confirmed. Try signing out again.");
      setAccessStatus("unverified");
      throw new Error("Sign-out could not be confirmed");
    } finally {
      sessionActionInFlight.current = false;
    }
  };

  const hasPermission = useCallback((resource: string, action: string) => (
    accessStatus === "authenticated" && assignedRoles.length > 0 && permissions.includes(`${resource}:${action}`)
  ), [accessStatus, assignedRoles, permissions]);
  const hasAnyPermission = useCallback((perms: Array<{ resource: string; action: string }>) => (
    perms.some(({ resource, action }) => hasPermission(resource, action))
  ), [hasPermission]);
  const hasSystemRole = useCallback((role: StaffSystemRole) => (
    accessStatus === "authenticated" && assignedRoles.length > 0 && systemRoles.includes(role)
  ), [accessStatus, assignedRoles, systemRoles]);

  return <AuthContext.Provider value={{ user, permissions, roles, assignedRoles, systemRoles, accessStatus, accessError,
    isLoading: accessStatus === "loading", login, logout, refetch, hasPermission, hasAnyPermission, hasSystemRole }}>
    {children}
  </AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}

export function useRequireAuth(allowedSystemRoles?: readonly StaffSystemRole[]) {
  const { user, isLoading, assignedRoles, accessStatus, hasSystemRole } = useAuth();
  if (isLoading) return { authorized: false, loading: true, user: null };
  const authorized = !!user && accessStatus === "authenticated" && assignedRoles.length > 0
    && (!allowedSystemRoles || allowedSystemRoles.some(hasSystemRole));
  return { authorized, loading: false, user };
}

export function useRequirePermission(resource: string, action: string) {
  const { user, isLoading, hasPermission } = useAuth();
  if (isLoading) return { authorized: false, loading: true, user: null };
  return { authorized: !!user && hasPermission(resource, action), loading: false, user };
}
