import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source contract for the Dropship Portal privacy policy.
 *
 * The policy is a promise about what the code does, so the categories it
 * names are pinned to the data the portal actually stores and the companies it
 * actually calls. Someone who adds a tracker, a new processor or a new kind of
 * stored data has to come here and change the words too.
 */
const root = join(__dirname, "..");
const page = readFileSync(join(root, "DropshipPortalPrivacy.tsx"), "utf8");
const app = readFileSync(join(root, "..", "..", "App.tsx"), "utf8");
const auth = readFileSync(join(root, "DropshipPortalAuth.tsx"), "utf8");
const shell = readFileSync(join(root, "DropshipPortalShell.tsx"), "utf8");
const indexHtml = readFileSync(join(root, "..", "..", "..", "index.html"), "utf8");

describe("Dropship Portal privacy policy", () => {
  it("is served without signing in, and is reachable from the sign-in page and every portal page", () => {
    // A protected route would hide the policy from the people it is for.
    expect(app).toContain("<Route path={`${portalRoot}/privacy`} component={DropshipPortalPrivacy} />");
    expect(app).not.toMatch(/privacy`}>\s*<DropshipPortalProtectedRoute/);
    expect(auth).toContain('data-testid="auth-privacy-link"');
    expect(shell).toContain('data-testid="portal-privacy-link"');
    expect(page).toContain('href={dropshipPortalPath("/login")}');
  });

  it("names every kind of data the portal stores, in the words a vendor would use", () => {
    for (const category of [
      "Your account.",
      "Signing in.",
      "Your store.",
      "Orders from your store.",
      "Wallet and payment methods.",
      "Bank balance readings.",
      "USDC deposits.",
      "Notifications.",
      "Technical records.",
    ]) {
      expect(page, category).toContain(category);
    }
    // The two promises that matter most to a vendor linking a bank.
    expect(page).toContain("We never store card numbers or bank account numbers.");
    expect(page).toContain("We do not show it to you and do not use it for anything else.");
  });

  it("names every company the portal sends data to, and no tracker it does not run", () => {
    for (const processor of ["Stripe", "Shopify or eBay", "ShipStation"]) {
      expect(page, processor).toContain(processor);
    }
    expect(page).toContain("We do not sell your data");
    // The claim of no trackers is only honest while the client loads none.
    expect(page).toContain("The portal runs no advertising or analytics trackers.");
    expect(indexHtml).not.toMatch(/gtag|googletagmanager|hotjar|segment\.com|posthog|fbq\(/i);
  });

  it("carries an effective date and a contact, and both are single named values", () => {
    expect(page).toMatch(/export const PRIVACY_POLICY_EFFECTIVE_DATE = "[A-Z][a-z]+ \d{1,2}, \d{4}";/);
    expect(page).toMatch(/export const PRIVACY_CONTACT_EMAIL = "[^"]+@[^"]+";/);
    expect(page).toContain("Effective {PRIVACY_POLICY_EFFECTIVE_DATE}");
    expect(page).toContain("mailto:${PRIVACY_CONTACT_EMAIL}");
  });
});
