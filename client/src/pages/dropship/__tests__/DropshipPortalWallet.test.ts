import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source contract for the vendor Wallet page. The page is a React component
 * with browser-only dependencies, so its structure is checked from source and
 * its behavior from the browser journeys in test/browser/dropship-wallet.spec.ts.
 */
const source = readFileSync(join(__dirname, "..", "DropshipPortalWallet.tsx"), "utf8");

function between(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThan(0);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to);
}

const STEP_COMPONENTS = ["function IntroStep", "function SourceStep", "function FloorStep", "function BackupStep", "function ReviewStep", "function DepositStep", "function ManageView"];

describe("DropshipPortalWallet contract", () => {
  it("renders the six steps and the manage view in order, decided only by deriveWalletFlow", () => {
    let last = -1;
    for (const component of STEP_COMPONENTS) {
      const index = source.indexOf(component);
      expect(index, component).toBeGreaterThan(last);
      last = index;
    }
    expect(source.match(/deriveWalletFlow\(/g)).toHaveLength(1);
    expect(source).not.toContain("from \"@/components/ui/switch\"");
    expect(source).not.toContain("<Checkbox");
    expect(source).toContain("adaptWalletView(await fetchJson<unknown>(WALLET_QUERY_KEY[0]))");
  });

  it("holds no money or duration policy of its own", () => {
    expect(source).not.toMatch(/"3%"|0\.03|"2 hours"|"a few days"|\(2 × your floor\)/);
    expect(source).not.toMatch(/[^\w_-](300|120|2880)[^\w_-]/);
    expect(source).not.toMatch(/\d_\d{3}/);
    expect(source).toContain("formatDurationMinutes(");
    expect(source).toContain("describeLimitDerivation(");
    expect(source).toContain("formatFeeRate(wallet.cardFundingFeeBps)");
    expect(source).not.toMatch(/\.isDefault/);
  });

  it("only ever calls the routes of the contract, with DELETE reserved for removal", () => {
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
    expect(source.match(/deleteJson</g)).toHaveLength(1);
    expect(between("function removeMethod", "function addFunds")).toContain("deleteJson<");
    expect(between("function removeMethod", "function addFunds")).toContain("buildRemoveFundingMethodPath(method.fundingMethodId)");
    expect(source).toContain("\"add_funding_method\" | \"wallet_funding_high_value\" | \"remove_funding_method\"");
    expect(source.match(/depositFundingMethodFor\(/g)).toHaveLength(2);
  });

  it("renders feedback and an impact statement in every step but the intro, and one button that authorizes", () => {
    for (const [start, end] of [["function SourceStep", "function tryParseDollarInputToCents"], ["function FloorStep", "function centsToDollarText"], ["function BackupStep", "function buildReviewRows"], ["function ReviewStep", "function FundingControls"], ["function DepositStep", "function ManageView"]]) {
      const body = between(start, end);
      expect(body, start).toContain("<SectionFeedback");
      expect(body, start).toMatch(/<Impact>|data-testid="wallet-impact"/);
    }
    const intro = between("function IntroStep", "function SourcePicker");
    expect(intro).not.toContain("wallet-impact");
    const review = between("function ReviewStep", "function FundingControls");
    expect(review).toContain("Agree and turn on auto-reload");
    expect(review).toContain("disabled={busy || disabled}");
    expect(between("function authorize", "function savePlan")).toContain("buildAuthorizeInput(plan, wallet)");
    expect(source).toContain("data-testid=\"wallet-verification\"");
  });

  it("pre-disables removal from roles and words the dialog honestly", () => {
    const methods = between("function SavedMethods", "function ActivitySection");
    expect(methods).toContain("disabledReasonForRemoval(method, flow.canTurnOffAutoReload)");
    expect(methods).toContain("disabled={feedback.busy || reason !== null}");
    expect(methods).toContain("We also ask Stripe to remove it. Card Shellz will no longer charge it.");
    expect(source).not.toContain("It can no longer be charged");
    expect(source).not.toContain("has been notified");
    expect(between("function showError", "async function run")).toContain("describeWalletError(caught.code, caught.message, caught.context, { surface, limits })");
  });

  it("keeps the turn-off control behind canTurnOffAutoReload and the Save label behind acknowledgementForSave", () => {
    expect(source).toContain("{flow.canTurnOffAutoReload && <TurnOffDialog");
    expect(source).toContain("acknowledgementForSave({ autoReload: wallet.autoReload, cardFundingFeeBps: wallet.cardFundingFeeBps })");
    expect(source).toContain("submitLabel={ack.saveLabel}");
    expect(source).toContain("saveLabel={ack.saveLabel}");
    expect(source).toContain("Transfer started.");
    expect(source).toContain("Payment received.");
  });

  it("keeps the standing notice above the wallet error, strips the Stripe marker, and never sends the daily cost", () => {
    const notice = source.indexOf('data-testid="wallet-vendor-standing-notice"');
    expect(notice).toBeGreaterThan(0);
    expect(notice).toBeLessThan(source.indexOf("{walletErrorText && ("));
    expect(source).toContain("window.history.replaceState");
    expect(source).toContain("flow.source?.rail === \"stripe_card\" ? (");
    expect(source).toContain("readWalletDraft(storageOrNull(), vendorId)");
    // Request builders receive plans and wallets only; the daily cost lives in the draft and component state.
    for (const builder of ["buildAuthorizeInput(", "buildPlanSaveInput(", "buildConfirmTermsInput(", "buildAutoReloadDisableInput("]) {
      for (const match of source.matchAll(new RegExp(builder.replace("(", "\\(") + "([^)]*)\\)", "g"))) {
        expect(match[1], builder).not.toMatch(/daily|cost/i);
      }
    }
    expect(between("function addFunds", "function saveUsdcMethod")).not.toMatch(/daily|cost/i);
  });

  it("states the intro in the words of what happens today", () => {
    expect(source).toContain("INTRO_VERIFICATION_NOTE");
    expect(source).not.toContain("passkey enrollment");
    expect(source).toContain("describeIntro({ cardFundingFeeBps: wallet.cardFundingFeeBps, usdcOffered: wallet.usdcBaseDepositAddress !== null, holdTimeoutMinutes: flow.holdTimeoutMinutes })");
    expect(source).toContain("describeActivationTopUp(");
  });
});
