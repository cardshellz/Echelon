import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

export type DropshipSensitiveAction =
  | "account_bootstrap"
  | "connect_store"
  | "disconnect_store"
  | "change_password"
  | "change_contact_email"
  | "password_reset"
  | "register_passkey"
  | "add_funding_method"
  | "remove_funding_method"
  | "wallet_funding_high_value"
  | "bulk_listing_push"
  | "high_risk_order_acceptance";

export interface DropshipSessionPrincipal {
  authIdentityId: number;
  memberId: string;
  cardShellzEmail: string;
  hasPasskey: boolean;
  authMethod: "passkey" | "password";
  entitlementStatus: "active" | "grace";
  authenticatedAt: string;
}

export interface DropshipSensitiveProof {
  method: "email_mfa" | "passkey";
  verifiedAt: string;
  expiresAt: string;
}

interface DropshipAuthContextValue {
  principal: DropshipSessionPrincipal | null;
  sensitiveProofs: Partial<Record<DropshipSensitiveAction, DropshipSensitiveProof>>;
  isAuthenticated: boolean;
  isLoading: boolean;
  passkeysSupported: boolean;
  platformPasskeyAvailable: boolean;
  refetch: () => Promise<void>;
  logout: () => Promise<void>;
  startBootstrap: (email: string) => Promise<void>;
  completeBootstrap: (input: {
    email: string;
    verificationCode: string;
    password: string;
  }) => Promise<DropshipSessionPrincipal>;
  loginWithPassword: (input: {
    email: string;
    password: string;
  }) => Promise<DropshipSessionPrincipal>;
  loginWithPasskey: (email?: string) => Promise<DropshipSessionPrincipal>;
  startEmailStepUp: (action: DropshipSensitiveAction) => Promise<void>;
  verifyEmailStepUp: (input: {
    action: DropshipSensitiveAction;
    verificationCode: string;
  }) => Promise<DropshipSensitiveProof>;
  registerPasskey: () => Promise<DropshipSessionPrincipal>;
  verifyPasskeyStepUp: (action: DropshipSensitiveAction) => Promise<DropshipSensitiveProof>;
}

const DropshipAuthContext = createContext<DropshipAuthContextValue | null>(null);

export function DropshipAuthProvider({ children }: { children: React.ReactNode }) {
  const [principal, setPrincipal] = useState<DropshipSessionPrincipal | null>(null);
  const [sensitiveProofs, setSensitiveProofs] = useState<
    Partial<Record<DropshipSensitiveAction, DropshipSensitiveProof>>
  >({});
  const [isLoading, setIsLoading] = useState(true);
  const [passkeysSupported, setPasskeysSupported] = useState(false);
  const [platformPasskeyAvailable, setPlatformPasskeyAvailable] = useState(false);

  useEffect(() => {
    setPasskeysSupported(browserSupportsWebAuthn());
    platformAuthenticatorIsAvailable()
      .then(setPlatformPasskeyAvailable)
      .catch(() => setPlatformPasskeyAvailable(false));
  }, []);

  const refetch = useCallback(async () => {
    try {
      const data = await dropshipJson<{
        principal?: DropshipSessionPrincipal;
        sensitiveProofs?: Partial<Record<DropshipSensitiveAction, DropshipSensitiveProof>>;
      }>("/api/dropship/auth/me", { method: "GET" });
      setPrincipal(data.principal ?? null);
      setSensitiveProofs(data.sensitiveProofs ?? {});
    } catch {
      setPrincipal(null);
      setSensitiveProofs({});
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const value = useMemo<DropshipAuthContextValue>(() => ({
    principal,
    sensitiveProofs,
    isAuthenticated: !!principal,
    isLoading,
    passkeysSupported,
    platformPasskeyAvailable,
    refetch,
    logout: async () => {
      await dropshipJson("/api/dropship/auth/logout", { method: "POST" }).catch(() => undefined);
      setPrincipal(null);
      setSensitiveProofs({});
    },
    startBootstrap: async (email: string) => {
      await dropshipJson("/api/dropship/auth/bootstrap/start", {
        method: "POST",
        body: {
          email,
          idempotencyKey: createIdempotencyKey("bootstrap"),
        },
      });
    },
    completeBootstrap: async (input) => {
      const data = await dropshipJson<{ principal: DropshipSessionPrincipal }>(
        "/api/dropship/auth/bootstrap/complete",
        {
          method: "POST",
          body: input,
        },
      );
      setPrincipal(data.principal);
      setSensitiveProofs({});
      return data.principal;
    },
    loginWithPassword: async (input) => {
      const data = await dropshipJson<{ principal: DropshipSessionPrincipal }>(
        "/api/dropship/auth/login/password",
        {
          method: "POST",
          body: input,
        },
      );
      setPrincipal(data.principal);
      setSensitiveProofs({});
      return data.principal;
    },
    loginWithPasskey: async (email?: string) => {
      const start = await dropshipJson<{ options: PublicKeyCredentialRequestOptionsJSON }>(
        "/api/dropship/auth/login/passkey/start",
        {
          method: "POST",
          body: email?.trim() ? { email: email.trim() } : {},
        },
      );
      const response = await startAuthentication({ optionsJSON: start.options });
      const data = await dropshipJson<{ principal: DropshipSessionPrincipal }>(
        "/api/dropship/auth/login/passkey/complete",
        {
          method: "POST",
          body: { response },
        },
      );
      setPrincipal(data.principal);
      setSensitiveProofs({});
      return data.principal;
    },
    startEmailStepUp: async (action) => {
      await dropshipJson("/api/dropship/auth/sensitive-actions/challenge/start", {
        method: "POST",
        body: {
          action,
          idempotencyKey: createIdempotencyKey(action),
        },
      });
    },
    verifyEmailStepUp: async (input) => {
      const proof = await dropshipJson<DropshipSensitiveProof & { action: DropshipSensitiveAction }>(
        "/api/dropship/auth/sensitive-actions/challenge/verify",
        {
          method: "POST",
          body: input,
        },
      );
      setSensitiveProofs((current) => ({
        ...current,
        [proof.action]: proof,
      }));
      return proof;
    },
    registerPasskey: async () => {
      const start = await dropshipJson<{ options: PublicKeyCredentialCreationOptionsJSON }>(
        "/api/dropship/auth/passkeys/register/start",
        { method: "POST" },
      );
      const response = await startRegistration({ optionsJSON: start.options });
      const data = await dropshipJson<{ principal: DropshipSessionPrincipal }>(
        "/api/dropship/auth/passkeys/register/complete",
        {
          method: "POST",
          body: { response },
        },
      );
      setPrincipal(data.principal);
      return data.principal;
    },
    verifyPasskeyStepUp: async (action) => {
      const start = await dropshipJson<{ options: PublicKeyCredentialRequestOptionsJSON }>(
        "/api/dropship/auth/sensitive-actions/passkey/start",
        {
          method: "POST",
          body: { action },
        },
      );
      const response = await startAuthentication({ optionsJSON: start.options });
      const proof = await dropshipJson<DropshipSensitiveProof & { action: DropshipSensitiveAction }>(
        "/api/dropship/auth/sensitive-actions/passkey/verify",
        {
          method: "POST",
          body: { action, response },
        },
      );
      setSensitiveProofs((current) => ({
        ...current,
        [proof.action]: proof,
      }));
      return proof;
    },
  }), [
    isLoading,
    passkeysSupported,
    platformPasskeyAvailable,
    principal,
    refetch,
    sensitiveProofs,
  ]);

  return (
    <DropshipAuthContext.Provider value={value}>
      {children}
    </DropshipAuthContext.Provider>
  );
}

export function useDropshipAuth() {
  const context = useContext(DropshipAuthContext);
  if (!context) {
    throw new Error("useDropshipAuth must be used within a DropshipAuthProvider");
  }
  return context;
}

export function isDropshipPortalHost(hostname = window.location.hostname): boolean {
  return hostname === "cardshellz.io" || hostname === "www.cardshellz.io";
}

export function dropshipPortalPath(path: string, hostname = window.location.hostname): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return isDropshipPortalHost(hostname) ? normalizedPath : `/dropship-portal${normalizedPath}`;
}

async function dropshipJson<T = unknown>(
  url: string,
  options: {
    method: "GET" | "POST";
    body?: unknown;
  },
): Promise<T> {
  const response = await fetch(url, {
    method: options.method,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(await dropshipErrorMessage(response));
  }

  return await response.json();
}

async function dropshipErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return response.statusText || "Request failed";

  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || parsed?.error || response.statusText;
  } catch {
    return text;
  }
}

function createIdempotencyKey(prefix: string): string {
  if (crypto.randomUUID) return `${prefix}:${crypto.randomUUID()}`;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}:${suffix}`;
}
