import { describe, expect, it } from "vitest";
import {
  dropshipPortalPath,
  isDropshipPortalHost,
  isDropshipSensitiveProofActive,
  resolveDropshipSensitiveActionStepUp,
} from "../dropship-auth";

describe("dropship portal routing helpers", () => {
  it("recognizes the dedicated customer portal hostnames", () => {
    expect(isDropshipPortalHost("cardshellz.io")).toBe(true);
    expect(isDropshipPortalHost("www.cardshellz.io")).toBe(true);
    expect(isDropshipPortalHost("echelon.cardshellz.test")).toBe(false);
  });

  it("keeps dedicated-host paths at the site root", () => {
    expect(dropshipPortalPath("/login", "cardshellz.io")).toBe("/login");
    expect(dropshipPortalPath("dashboard", "cardshellz.io")).toBe("/dashboard");
  });

  it("uses a prefixed path in the shared Echelon app", () => {
    expect(dropshipPortalPath("/login", "localhost")).toBe("/dropship-portal/login");
    expect(dropshipPortalPath("dashboard", "localhost")).toBe("/dropship-portal/dashboard");
  });
});

describe("dropship sensitive-action proof helpers", () => {
  const now = new Date("2026-05-07T12:00:00.000Z");

  it("uses email MFA until a passkey is enrolled", () => {
    expect(resolveDropshipSensitiveActionStepUp(null, "add_funding_method")).toBe("email_mfa");
    expect(resolveDropshipSensitiveActionStepUp({ hasPasskey: false }, "add_funding_method")).toBe("email_mfa");
    expect(resolveDropshipSensitiveActionStepUp({ hasPasskey: false }, "manage_catalog_selection")).toBe("email_mfa");
    expect(resolveDropshipSensitiveActionStepUp({ hasPasskey: true }, "add_funding_method")).toBe("passkey");
  });

  it("requires proof method to match current account state", () => {
    expect(isDropshipSensitiveProofActive({
      principal: { hasPasskey: false },
      action: "add_funding_method",
      proof: {
        method: "email_mfa",
        verifiedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      },
      now,
    })).toBe(true);

    expect(isDropshipSensitiveProofActive({
      principal: { hasPasskey: true },
      action: "add_funding_method",
      proof: {
        method: "email_mfa",
        verifiedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      },
      now,
    })).toBe(false);
  });

  it("rejects expired or invalid proof timestamps", () => {
    expect(isDropshipSensitiveProofActive({
      principal: { hasPasskey: false },
      action: "add_funding_method",
      proof: {
        method: "email_mfa",
        verifiedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() - 1).toISOString(),
      },
      now,
    })).toBe(false);

    expect(isDropshipSensitiveProofActive({
      principal: { hasPasskey: false },
      action: "add_funding_method",
      proof: {
        method: "email_mfa",
        verifiedAt: now.toISOString(),
        expiresAt: "not-a-date",
      },
      now,
    })).toBe(false);
  });
});
