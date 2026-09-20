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

  it("words the source preselection from the model, and never claims a setup the vendor did not start", () => {
    const step = between("function SourceStep", "function tryParseDollarInputToCents");
    expect(step).toContain("describeSourcePreselection({");
    expect(step).toContain("draftSourceMethodId: draft.sourceMethodId");
    expect(step).toContain("suggestedSourceMethodId: flow.suggestedSourceMethodId");
    expect(step).toContain("justAdded: autoSelectedId !== null");
    expect(source).not.toContain("Pick up where you left off.");
  });

  it("holds no money or duration policy of its own", () => {
    expect(source).not.toMatch(/"3%"|0\.03|"2 hours"|"a few days"|\(2 × your floor\)/);
    expect(source).not.toMatch(/[^\w_-](300|120|2880)[^\w_-]/);
    expect(source).not.toMatch(/\d_\d{3}/);
    expect(source).toContain("formatDurationMinutes(");
    expect(source).toContain("chargeBoundCents(");
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
    expect(review).toContain("Agree and turn on autopay");
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

  it("states the intro in the words of what happens today, from one source of the copy", () => {
    expect(source).not.toContain("passkey enrollment");
    expect(source).toContain("describeActivationTopUp(");
    // Step 1 and the manage view's "How your wallet works" render the same component, so the rules are worded once.
    expect(source.match(/describeIntro\(/g)).toHaveLength(1);
    expect(source.match(/INTRO_VERIFICATION_NOTE/g)).toHaveLength(2);
    expect(source).toContain("describeIntro({ cardFundingFeeBps: wallet.cardFundingFeeBps, usdcOffered: wallet.usdcBaseDepositAddress !== null, holdTimeoutMinutes: flow.holdTimeoutMinutes, limits: wallet.limits })");
    expect(source.match(/<WalletHowItWorks wallet=\{wallet\} flow=\{flow\} \/>/g)).toHaveLength(2);
    // Lede, then one list item per topic, each led by its bold sentence — the copy is the model's and is never re-worded here.
    const rules = between("function WalletHowItWorks", "function IntroStep");
    expect(rules).toContain("{intro.lede}");
    expect(rules).toContain("{intro.topics.map((topic) => (");
    expect(rules).toContain("<strong className=\"font-semibold text-zinc-900\">{topic.lead}</strong> {topic.detail}");
    expect(rules).toContain("data-testid=\"wallet-how-it-works-rules\"");
    // The intro names the single top-up limit; the review step is where it is explained in full.
    expect(source).not.toContain("step 5 explains it");
    expect(between("function buildReviewRows", "function ReviewStep")).toContain("\"Top-up amount\"");
    expect(between("function IntroStep", "function SourcePicker")).toContain("revisited ? \"Back to setup\" : \"Set up my wallet\"");
    const manage = between("function HowItWorksSection", "function PlanRow");
    expect(manage).toContain("data-testid=\"wallet-how-it-works\"");
    expect(manage).toContain("<CollapsibleContent");
    expect(source).toContain("<HowItWorksSection wallet={wallet} flow={flow} />");
  });

  it("navigates the flow only through the model: reachable rows are buttons, every move is a draft transition", () => {
    // The order of the steps, the step a click lands on and what it keeps all live in the model.
    expect(source).not.toMatch(/const STEP_ORDER\s*[:=]/);
    expect(source).toContain("STEP_ORDER,\n  acknowledgementForSave");
    const indicator = between("function StepIndicator", "function WalletHowItWorks");
    expect(indicator).toContain("reachable: flow.reachableSteps.includes(step)");
    // Done, current and later are the model's verdict — the page never infers a tick from a row's position.
    expect(indicator).toContain("walletStepState(step, { current, furthestStep: flow.furthestStep ?? current, seenIntro: draft.seenIntro })");
    expect(indicator).not.toMatch(/index [<>]=? \w*[Ii]ndex/);
    expect(indicator).toContain("data-testid={`wallet-step-link-${step}`}");
    expect(indicator).toContain("aria-current={state === \"current\" ? \"step\" : undefined}");
    expect(indicator).toContain("onClick={() => onSelect(step)}");
    // A row the flow has not reached yet is plain text: no button, nothing focusable.
    expect(indicator).toContain("<span className=\"flex items-start gap-3\">{body}</span>");
    expect(indicator).toContain("data-testid=\"wallet-step-indicator\"");
    // Every move through the flow is one of the model's draft transitions; the page never edits the draft's choices itself.
    for (const transition of ["draftAtStep(current, step)", "setDraft(draftAfterIntro)", "draftAfterSourceChoice(current, method, flow.source?.method ?? null)",
      "draftAfterFloorChoice(current, floorCents, topUpCents, dailyCostCents)", "draftAfterBackupChoice(current, card)", "draftAtStep(current, previous)"]) {
      expect(source, transition).toContain(transition);
    }
    expect(source).toContain("revisited={flow.furthestStep !== \"intro\"}");
    // Back is a plain control on every step screen but the intro, and it saves nothing.
    const back = between("function StepBack", "function Impact");
    expect(back).toContain("data-testid=\"wallet-step-back\"");
    expect(back).toContain("if (!onBack) return null;");
    for (const [start, end] of [["function SourceStep", "function tryParseDollarInputToCents"], ["function FloorStep", "function centsToDollarText"],
      ["function BackupStep", "function buildReviewRows"], ["function ReviewStep", "function FundingControls"], ["function DepositStep", "function ManageView"]]) {
      expect(between(start, end), start).toContain("<StepBack busy=");
    }
    expect(between("function IntroStep", "function SourcePicker")).not.toContain("<StepBack");
    // Review's Change controls open a step; they no longer throw the choice away, and are not offered for a step that is closed.
    expect(between("function ReviewStep", "function FundingControls")).toContain("onChange(step)");
    expect(between("function ReviewStep", "function FundingControls")).toContain("{step && flow.reachableSteps.includes(step) && (");
    expect(source).toContain("onChange={(step) => setDraft((current) => draftAtStep(current, step))}");
  });

  it("writes the draft synchronously before a Stripe redirect navigates away", () => {
    // React runs a state updater on its next render, which is after
    // window.location.assign has fired, so a draft written only through
    // setDraft can lose the race and the vendor returns from Stripe with no
    // record of the setup they started.
    const redirects = source.split("window.location.assign(");
    expect(redirects.length).toBeGreaterThan(1);
    for (const before of redirects.slice(0, -1)) {
      const tail = before.slice(-400);
      expect(tail).toContain("commitDraftBeforeRedirect(");
      expect(tail).not.toContain("setDraft((current)");
    }
    expect(source).toContain("function commitDraftBeforeRedirect(next: WalletDraft)");
  });
});
