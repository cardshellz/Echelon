import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source contract for the vendor Wallet page. The page is a React component
 * with browser-only dependencies, so its structure is checked from source and
 * its behavior from the browser journey in test/browser/dropship-wallet.spec.ts.
 */
const source = readFileSync(join(__dirname, "..", "DropshipPortalWallet.tsx"), "utf8");

function between(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("DropshipPortalWallet contract", () => {
  it("derives one next step from the wallet overview instead of showing every form at once", () => {
    expect(source).toContain("deriveWalletSetupState(wallet)");
    expect(source).toContain("setup.stage === \"ready\"");
    expect(source).toContain("<SetupSection");
    expect(source).toContain("<BalanceSection");
    expect(source).toContain("<AutoReloadSection");
  });

  it("shows a paused vendor why selling stopped, from the same onboarding state the shell refreshes after wallet changes", () => {
    expect(source).toContain("useQuery<DropshipOnboardingState>({");
    expect(source).toContain("queryKey: [...ONBOARDING_QUERY_KEY],");
    expect(source).toContain("const standingNotice = onboardingQuery.data ? describeVendorStanding(onboardingQuery.data.vendor) : null;");
    const notice = source.indexOf('data-testid="wallet-vendor-standing-notice"');
    expect(notice).toBeGreaterThan(0);
    expect(notice).toBeLessThan(source.indexOf("{walletQuery.error && ("));
  });

  it("puts the backup card first, then a bank-or-card choice for top-ups, with the card's role and fee stated before it is added", () => {
    expect(source).toContain("{ key: \"card\", title: \"Add your backup card\" }");
    expect(source).toContain("{ key: \"top_up\", title: \"Choose how to top up\" }");
    const setup = between("function SetupSection", "function BalanceSection");
    expect(setup).toContain("data-testid=\"wallet-backup-card-role\"");
    expect(setup).toContain("data-testid=\"wallet-card-fee-note\"");
    expect(setup).toContain("aria-label=\"Top up from\"");
    expect(setup).toContain("title=\"Bank account\"");
    expect(setup).toContain("Add a bank account");
    expect(setup).toContain("title=\"Card\"");
  });

  it("words the top-up policy from the model, so the page never claims a fixed reload amount", () => {
    expect(source).toContain("describeTopUpRule(terms)");
    expect(source).toContain("describeTopUpFee(terms)");
    expect(source).toContain("describeAutoReloadMandate(terms)");
    expect(source).toContain("{PAUSE_ON_DECLINE_NOTE}");
    expect(source).toContain("describeAutoReloadPolicy({ autoReload, method, backupCard, cardFundingFeeBps })");
    expect(source).toContain("label=\"Keep my balance at\"");
    expect(source).toContain("label=\"Largest single top-up\"");
    expect(source).not.toContain("Add this much each time");
    expect(source).not.toContain("Reload when my balance drops below");
  });

  it("lets a ready wallet add funds by bank account, card or USDC, and keeps only the hold timeout and saved methods under Advanced", () => {
    const balance = between("function BalanceSection", "function AutoReloadSection");
    expect(balance).toContain("aria-label=\"Pay with\"");
    expect(balance).toContain("<UsdcFundingPanel");
    expect(balance).toContain("describeFundingQuote(payWith.method, quote)");
    const advanced = between("function AdvancedSection", "function ActivitySection");
    expect(advanced).toContain("<Collapsible open={open}");
    expect(advanced).toContain("useState(false)");
    for (const heading of ["Payment hold timeout", "Saved methods"]) {
      expect(advanced).toContain(`<h3 className="font-medium">${heading}</h3>`);
    }
    expect(advanced).not.toContain("USDC on Base");
    expect(advanced).not.toContain("Bank account (ACH)");
  });

  it("replaces free-text money fields with whole-dollar presets on the setup step", () => {
    expect(source).toContain("AUTO_RELOAD_MINIMUM_PRESETS_CENTS");
    expect(source).toContain("AUTO_RELOAD_CAP_PRESETS_CENTS");
    expect(source).toContain("role=\"radio\"");
    const setup = between("function SetupSection", "function BalanceSection");
    expect(setup).not.toContain("<Input");
    // The cap can never sit below the balance it protects.
    expect(setup).toContain("if (capCents < cents) setCapCents(smallestCapFor(cents, capOptions));");
    expect(setup).toContain("isOptionDisabled={(cents) => cents < minimumCents}");
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

  it("polls for the Stripe webhook after a successful setup, for a card or a bank account, bounded by a timeout", () => {
    expect(source).toContain("CARD_CONFIRMATION_POLL_INTERVAL_MS");
    expect(source).toContain("CARD_CONFIRMATION_POLL_TIMEOUT_MS");
    expect(source).toContain("const awaitingCard = returnedFromSetup && setupRail === \"stripe_card\"");
    expect(source).toContain("const awaitingBank = returnedFromSetup && setupRail === \"stripe_ach\"");
    expect(source).toContain("window.history.replaceState");
  });

  it("offers the way back to onboarding only while the vendor is still onboarding", () => {
    expect(source).toContain("{setup.stage === \"ready\" && stillOnboarding && (");
    expect(source).toContain("isOnboardingVendor(onboardingQuery.data.vendor.status)");
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
