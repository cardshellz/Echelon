import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

export interface VendorProfile {
  id: number;
  email: string;
  name: string;
  company_name: string | null;
  phone: string | null;
  status: string;
  tier: string;
  wallet_balance_cents: number;
  auto_reload_enabled: boolean;
  auto_reload_threshold_cents: number;
  auto_reload_amount_cents: number;
  ebay_connected: boolean;
  ebay_user_id: string | null;
  stripe_customer_id: string | null;
  created_at: string;
}

interface VendorAuthContextType {
  vendor: VendorProfile | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  refetch: () => Promise<void>;
}

const VendorAuthContext = createContext<VendorAuthContextType | null>(null);

const TOKEN_KEY = "vendor_token"; // Deprecated client-side storage key

// We no longer manage tokens on the client to ensure security (HttpOnly cookies)
export function getVendorToken(): string | null {
  return null;
}

export function setVendorToken(_token: string) {
  // Legacy cleanup if it existed
  localStorage.removeItem(TOKEN_KEY);
}

export function clearVendorToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function vendorFetch(path: string, options?: RequestInit): Promise<Response> {
  // Cookies handle auth automatically
  return fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
}

export function VendorAuthProvider({ children }: { children: React.ReactNode }) {
  const [vendor, setVendor] = useState<VendorProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    // Clear any legacy client-side token
    clearVendorToken();
    try {
      const res = await vendorFetch("/api/vendor/auth/me");
      if (res.ok) {
        const data = await res.json();
        setVendor(data);
      } else {
        clearVendorToken();
        setVendor(null);
      }
    } catch {
      setVendor(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const login = async (email: string, password: string) => {
    try {
      const res = await fetch("/api/vendor/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        // The server will set the HttpOnly cookie for us
        clearVendorToken();
        await refetch();
        return { success: true };
      }
      const errorData = await res.json().catch(() => ({}));
      return { success: false, error: errorData.message || errorData.error || "Login failed" };
    } catch {
      return { success: false, error: "Network error" };
    }
  };

  const logout = async () => {
    try {
      await fetch("/api/vendor/auth/logout", { method: "POST" });
    } catch (e) {}
    clearVendorToken();
    setVendor(null);
  };

  return (
    <VendorAuthContext.Provider
      value={{
        vendor,
        isLoading,
        isAuthenticated: !!vendor,
        login,
        logout,
        refetch,
      }}
    >
      {children}
    </VendorAuthContext.Provider>
  );
}

export function useVendorAuth() {
  const context = useContext(VendorAuthContext);
  if (!context) {
    throw new Error("useVendorAuth must be used within a VendorAuthProvider");
  }
  return context;
}
