import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const shell = readFileSync(join(__dirname, "..", "DropshipPortalShell.tsx"), "utf8");
const home = readFileSync(join(__dirname, "..", "DropshipPortalHome.tsx"), "utf8");
const app = readFileSync(join(__dirname, "..", "..", "..", "App.tsx"), "utf8");
const auth = readFileSync(join(__dirname, "..", "DropshipPortalAuth.tsx"), "utf8");

describe("DropshipPortalShell contract", () => {
  it("shows the Onboarding item only while the vendor is onboarding, from the same state every page loads", () => {
    expect(shell).toContain("const ONBOARDING_QUERY_KEY = [\"/api/dropship/onboarding/state\"] as const;");
    expect(shell).toContain("isOnboardingVendor(onboardingQuery.data.vendor.status) : false");
    expect(shell).toContain("navItems.filter((item) => item.href !== ONBOARDING_NAV_HREF || showOnboarding)");
    expect(shell).toContain("{visibleNavItems.map((item) => {");
  });
});

describe("DropshipPortalHome contract", () => {
  it("lands an onboarding vendor on the checklist and everyone else on the dashboard", () => {
    expect(home).toContain("isOnboardingVendor(onboardingQuery.data.vendor.status)");
    expect(home).toContain("? \"/onboarding\"");
    expect(home).toContain(": \"/dashboard\"");
    expect(home).toContain("<Redirect to={dropshipPortalPath(destination)} />");
  });

  it("is where sign-in and the portal root send the vendor", () => {
    expect(app).toContain("<DropshipPortalProtectedRoute component={DropshipPortalHome} />");
    expect(app).toContain("<Redirect to={dropshipPortalPath(\"/home\")} />");
    expect(app).not.toContain("<Redirect to={dropshipPortalPath(\"/onboarding\")} />");
    expect(auth).toContain("setLocation(dropshipPortalPath(\"/home\"))");
    expect(auth).not.toContain("setLocation(dropshipPortalPath(\"/onboarding\"))");
  });
});
