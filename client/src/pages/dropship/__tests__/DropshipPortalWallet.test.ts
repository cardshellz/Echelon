import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source contract for the vendor Wallet page. The page is a React component
 * with browser-only dependencies, so its structure is checked from source and
 * its behavior from the browser journey in test/browser/dropship-wallet.spec.ts.
 */
const source = readFileSync(join(__dirname, "..", "DropshipPortalWallet.tsx"), "utf8");

describe("DropshipPortalWallet contract", () => {
  it("derives one next step from the wallet overview instead of showing every form at once", () => {
    expect(source).toContain("deriveWalletSetupState(wallet)");
    expect(source).toContain("setup.stage === \"ready\"");
    expect(source).toContain("<SetupSection");
    expect(source).toContain("<BalanceSection");
    expect(source).toContain("<AutoReloadSection");
  });

  it("keeps bank accounts, USDC and the hold timeout behind a collapsed Advanced section", () => {
    const advancedStart = source.indexOf("function AdvancedSection");
    expect(advancedStart).toBeGreaterThan(0);
    const advanced = source.slice(advancedStart);
    expect(advanced).toContain("<Collapsible open={open}");
    expect(advanced).toContain("useState(false)");
    const renderedBeforeAdvanced = source.slice(source.indexOf("function SetupSection"), advancedStart);
    for (const heading of ["Bank account (ACH)", "Payment hold timeout", "USDC on Base", "Saved methods"]) {
      expect(advanced).toContain(`<h3 className="font-medium">${heading}</h3>`);
      // None of these forms render in the setup or overview sections.
      expect(renderedBeforeAdvanced).not.toContain(heading);
    }
  });

  it("replaces free-text money fields with whole-dollar presets on the setup step", () => {
    expect(source).toContain("AUTO_RELOAD_MINIMUM_PRESETS_CENTS");
    expect(source).toContain("AUTO_RELOAD_AMOUNT_PRESETS_CENTS");
    expect(source).toContain("role=\"radio\"");
    const setup = source.slice(source.indexOf("function SetupSection"), source.indexOf("function BalanceSection"));
    expect(setup).not.toContain("<Input");
  });

  it("renders notices and the emailed code prompt inside the acting section, not at the top of the page", () => {
    expect(source).toContain("function SectionFeedback");
    const sections = ["function SetupSection", "function BalanceSection", "function AutoReloadSection", "function AdvancedSection"];
    for (const section of sections) {
      const body = source.slice(source.indexOf(section));
      expect(body.slice(0, body.indexOf("\n}\n"))).toContain("<SectionFeedback");
    }
    expect(source).toContain("data-testid=\"wallet-verification\"");
  });

  it("reuses a live proof and parks the request until the code is accepted", () => {
    expect(source).toContain("isDropshipSensitiveProofActive({ principal, action, proof: sensitiveProofs[action] })");
    expect(source).toContain("setVerification({ scope, action, intent })");
    expect(source).toContain("await run(scope, intent)");
  });

  it("polls for the Stripe webhook after a successful card setup, bounded by a timeout", () => {
    expect(source).toContain("CARD_CONFIRMATION_POLL_INTERVAL_MS");
    expect(source).toContain("CARD_CONFIRMATION_POLL_TIMEOUT_MS");
    expect(source).toContain("stripeReturn?.kind === \"funding_setup\" && stripeReturn.status === \"success\"");
    expect(source).toContain("window.history.replaceState");
  });

  it("only ever calls the existing wallet routes", () => {
    const routes = [...source.matchAll(/"\/api\/dropship\/[^"]+"/g)].map((match) => match[0]);
    expect(new Set(routes)).toEqual(new Set([
      "\"/api/dropship/wallet?limit=50\"",
      "\"/api/dropship/onboarding/state\"",
      "\"/api/dropship/settings\"",
      "\"/api/dropship/wallet/funding-methods/stripe/setup-session\"",
      "\"/api/dropship/wallet/auto-reload\"",
      "\"/api/dropship/wallet/funding/stripe/checkout-session\"",
      "\"/api/dropship/wallet/funding-methods/usdc-base\"",
    ]));
  });
});
