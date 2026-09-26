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
    // Exactly one checkbox: the points box (owner decision 2026-09-26). Every other money choice is a named option.
    expect(source.match(/<Checkbox/g)).toHaveLength(1);
    expect(source).toContain("adaptWalletView(await fetchJson<unknown>(WALLET_QUERY_KEY[0]))");
  });

  it("words the source preselection from the model, and never claims a setup the vendor did not start", () => {
    const step = between("function SourceStep", "function tryParseDollarInputToCents");
    expect(step).toContain("describeSourcePreselection({");
    expect(step).toContain("draftSourceMethodId: draft.sourceMethodId");
    expect(step).toContain("suggestedSourceMethodId: flow.suggestedSourceMethodId");
    expect(step).toContain("justAdded: autoSelectedId !== null");
    expect(source).not.toContain("Pick up where you left off.");
    // A saved card is named by the model, never silently adopted as the source.
    expect(step).toContain("describeSavedCardAlternative({");
    expect(step).toContain("data-testid=\"wallet-source-saved-card\"");
  });

  it("makes each source option one whole clickable radio that defaults to the recommended rail", () => {
    const picker = between("function SourcePicker", "function SourceStep");
    // The radio is the card itself, not a button around the icon and title.
    expect(picker).toContain("role=\"radio\"");
    expect(picker).toContain("onKeyDown={(event) => {");
    expect(picker).not.toMatch(/<button[^>]*role="radio"/);
    // Controls inside the selected card act on their own, without re-picking the rail.
    expect(picker).toContain("onClick={(event) => event.stopPropagation()}");
    // Neither the picker nor the step names a rail of its own.
    expect(picker).toContain("railChoice ?? initialRail ?? RECOMMENDED_SOURCE_RAIL");
    const step = between("function SourceStep", "function tryParseDollarInputToCents");
    expect(step).toContain("const shownRail = rail ?? confirmation?.rail ?? RECOMMENDED_SOURCE_RAIL");
    expect(step).toContain("initialRail={shownRail}");
    expect(step).toContain("{shownRail === \"stripe_ach\" && (");
    expect(step).toContain("{shownRail === \"stripe_card\" && (");
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
      "\"/api/dropship/wallet/usdc/deposit-address\"",
      "\"/api/dropship/wallet/rewards/preference\"",
    ]));
    expect(source.match(/deleteJson</g)).toHaveLength(1);
    expect(between("function removeMethod", "function addFunds")).toContain("deleteJson<");
    expect(between("function removeMethod", "function addFunds")).toContain("buildRemoveFundingMethodPath(method.fundingMethodId)");
    expect(source).toContain("\"add_funding_method\" | \"wallet_funding_high_value\" | \"remove_funding_method\"");
    expect(source.match(/depositFundingMethodFor\(/g)).toHaveLength(2);
  });

  it("renders feedback and an impact statement in every step but the intro, and one button that authorizes", () => {
    for (const [start, end] of [["function SourceStep", "function tryParseDollarInputToCents"], ["function FloorStep", "function centsToDollarText"], ["function BackupStep", "function buildReviewRows"], ["function ReviewStep", "function FundingControls"]]) {
      const body = between(start, end);
      expect(body, start).toContain("<SectionFeedback");
      expect(body, start).toMatch(/<Impact>|data-testid="wallet-impact"/);
    }
    // The add-money step carries feedback but no impact box: its terms are the picked rail's bullets.
    const deposit = between("function DepositStep", "function ManageView");
    expect(deposit).toContain("<SectionFeedback");
    expect(deposit).not.toContain("<Impact>");
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

  it("keeps the standing notice above the wallet error and strips the Stripe marker", () => {
    const notice = source.indexOf('data-testid="wallet-vendor-standing-notice"');
    expect(notice).toBeGreaterThan(0);
    expect(notice).toBeLessThan(source.indexOf("{walletErrorText && ("));
    expect(source).toContain("window.history.replaceState");
    expect(source).toContain("flow.source?.rail === \"stripe_card\" ? (");
    expect(source).toContain("readWalletDraft(storageOrNull(), vendorId)");
  });

  it("offers the two tier minimums on the minimum step and nothing to guess or type for the amount", () => {
    const step = between("function FloorStep", "function centsToDollarText");
    expect(step).toContain('aria-label="Reserve"');
    expect(step).toContain("const options = minimumOptions(limits);");
    expect(step).toContain("useState(minimumOptionFor(initialFloorCents, limits))");
    expect(step).toContain("hint={describeMinimumOption(option.tier)}");
    expect(step).toContain("testId={`wallet-minimum-${option.tier}`}");
    expect(step).toContain("options.some((option) => option.cents === floorCents)");
    // The top-up amount: the minimum, its multiples that follow the minimum, or the vendor's own number.
    expect(step).toContain('aria-label="Top-up amount"');
    expect(step).toContain("const topUpChoices = topUpOptions(floorCents, limits);");
    expect(step).toContain("topUpChoiceFor(initialTopUpCents, minimumOptionFor(initialFloorCents, limits))");
    expect(step).toContain("hint={describeTopUpOption(option)}");
    expect(step).toContain("testId={`wallet-top-up-${option.factor}x`}");
    expect(step).toContain("topUpCentsFor(effectiveTopUp, floorCents)");
    expect(step).toContain('data-testid="wallet-top-up-custom"');
    // The daily-cost guesser, the recommendation and the free-form amount are gone from the whole page.
    // (The deposit step keeps its own "Or another amount" input; only the minimum's free-form amount is gone.)
    expect(source).not.toMatch(/daily (order )?cost|dailyCost|wallet-floor-custom|recommendedFloor|Keep my balance at/i);
    expect(step).not.toContain("initialDailyCostCents");
  });

  it("adds money with the top-up step's picks again, opening on what autopay would pull next", () => {
    const controls = between("function FundingControls", "function UsdcFundingPanel");
    expect(controls).toContain("const options = depositOptions({ minimumCents: floorCents, topUpCents, limits, rail: rail === \"stripe_card\" ? \"stripe_card\" : \"stripe_ach\" });");
    expect(controls).toContain("depositDefaultCents(options, nextTopUpCents({ floorCents, topUpCents, availableCents: wallet.account.availableBalanceCents, pendingCents: wallet.account.pendingBalanceCents }))");
    expect(controls).toContain("hint={describeDepositOption(option)}");
    expect(controls).toContain('testId={`wallet-deposit-${option.factor === null ? "top-up" : `${option.factor}x`}`}');
    // A pick the plan no longer offers counts as none, and nothing is sent without an amount.
    expect(controls).toContain("const preset = options.some((option) => option.cents === presetCents) ? presetCents : null;");
    expect(controls).toContain('if (amountCents === null) { setCustomError("Pick an amount or enter one."); return; }');
    expect(controls).toContain('<Label htmlFor="wallet-custom-amount">Or another amount</Label>');
    // Both callers hand the controls the plan's top-up amount.
    const step = between("function DepositStep", "function ManageView");
    expect(step).toContain("topUpCents={terms.topUpCents}");
    const manage = between("function ManageView", "function ListingTiersSection");
    expect(manage).toContain("const topUpCents = wallet.autoReload ? wallet.autoReload.topUpAmountCents : flow.topUpCents;");
    expect(manage).toContain("topUpCents={topUpCents}");
    // The fixed presets below the minimum are gone from the whole page.
    expect(source).not.toMatch(/DEPOSIT_PRESETS_CENTS|presetsIncluding|depositAmountDefault|placeholder="75\.00"/);
  });

  it("adds money on its own terms: the balance stands alone, the picked rail lists its terms, nothing is said about autopay, and skipping is one click", () => {
    const step = between("function DepositStep", "function ManageView");
    expect(step).toContain('data-testid="wallet-deposit-balance"');
    expect(step).toContain('data-testid="wallet-deposit-available"');
    expect(step).toContain("formatSignedCents(wallet.account.availableBalanceCents)");
    expect(step).toContain("describePendingBalance(wallet.account.pendingBalanceCents, wallet.advance)");
    expect(step).toContain("railNotes={(rail, method) => describeDepositRail({");
    expect(step).toContain("bankFundingMethodId: rail === \"stripe_ach\" && method ? method.fundingMethodId : null,");
    expect(step).toContain("rewardsRates: wallet.limits,");
    expect(step).toContain("Skip for now");
    // No autopay talk, no impact box, no Back: the autopay steps before it cover autopay, and the step list still opens the review.
    expect(step).not.toMatch(/autopay|auto-reload|daily check|first top-up|describeActivationTopUp|Not now|onBack|<Impact>/i);
    const controls = between("function FundingControls", "function UsdcFundingPanel");
    expect(controls).toContain('data-testid="wallet-rail-notes"');
    expect(controls).toContain("{railNotes(rail, method).map((note) => <li key={note}>{note}</li>)}");
    // The activation sentence left the page with the paragraph that carried it.
    expect(source).not.toContain("describeActivationTopUp");
  });

  it("states the intro in the words of what happens today, from one source of the copy", () => {
    expect(source).not.toContain("passkey enrollment");
    // Step 1 and the manage view's "How your wallet works" render the same component, so the rules are worded once.
    expect(source.match(/describeIntro\(/g)).toHaveLength(1);
    expect(source.match(/INTRO_VERIFICATION_NOTE/g)).toHaveLength(2);
    expect(source).toContain("describeIntro({ cardFundingFeeBps: wallet.cardFundingFeeBps, usdcOffered: usdcOfferedFor(wallet), usdcDeposit: wallet.usdcDeposit, holdTimeoutMinutes: flow.holdTimeoutMinutes, limits: wallet.limits })");
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
      "draftAfterFloorChoice(current, floorCents, topUpCents)", "draftAfterBackupChoice(current, card)", "draftAtStep(current, previous)"]) {
      expect(source, transition).toContain(transition);
    }
    expect(source).toContain("revisited={flow.furthestStep !== \"intro\"}");
    // Back is a plain control on every step screen but the intro and the add-money step, and it saves nothing.
    // (Past the plan there is nothing to go back and change; the step list still opens the review.)
    const back = between("function StepBack", "function Impact");
    expect(back).toContain("data-testid=\"wallet-step-back\"");
    expect(back).toContain("if (!onBack) return null;");
    for (const [start, end] of [["function SourceStep", "function tryParseDollarInputToCents"], ["function FloorStep", "function centsToDollarText"],
      ["function BackupStep", "function buildReviewRows"], ["function ReviewStep", "function FundingControls"]]) {
      expect(between(start, end), start).toContain("<StepBack busy=");
    }
    expect(between("function IntroStep", "function SourcePicker")).not.toContain("<StepBack");
    expect(between("function DepositStep", "function ManageView")).not.toContain("<StepBack");
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

describe("rewards on the wallet page (funding design phase 7)", () => {
  it("shows the points as their own element with one checkbox, ticked unless the vendor unticked it, in the model's words", () => {
    const block = between("function RewardsBalance", "function describeBalanceAfterCell");
    expect(block).toContain('data-testid="wallet-rewards"');
    expect(block).toContain('data-testid="wallet-rewards-balance"');
    expect(block).toContain('data-testid="wallet-rewards-value"');
    expect(block).toContain("const balance = describeRewardsBalance(wallet.account.rewardsBalanceCents);");
    expect(block).toContain("{balance.points}");
    expect(block).toContain("worth {balance.value} on your orders");
    expect(block).toContain("{describeRewardsUse(spendFirst)}");
    // One checkbox, on by default (owner decision 2026-09-26). What ticked means is the model's, never the page's;
    // a click that leaves the state as it is sends nothing, and the box waits for the settings row.
    expect(block).toContain("const spendFirst = wallet.autoReload?.spendRewardsFirst ?? null;");
    expect(block).toContain("const applies = rewardsApplyToOrders(spendFirst);");
    expect(block).toContain("const disabled = feedback.busy || !wallet.autoReload;");
    expect(block).toContain("checked={applies}");
    expect(block).toContain("onCheckedChange={(checked) => { const next = checked === true; if (next !== applies) void onSave(next); }}");
    expect(block).toContain('<Label htmlFor="wallet-rewards-apply"');
    expect(block).toContain("Use my points on my orders");
    expect(block).not.toContain("RadioChip");
    expect(block).not.toMatch(/1%|\d+%|"\$|<Switch|\?\? true/);
    expect(block).not.toContain("formatCents(");
    // The balance section renders it once, above the add-money panel.
    expect(between('data-testid="wallet-balance"', 'data-testid="wallet-add-money"')).toContain('<RewardsBalance wallet={wallet} feedback={feedback("rewards")} onSave={onSaveRewardsPreference} />');
    expect(source.match(/<RewardsBalance /g)).toHaveLength(1);
  });

  it("saves the preference through the model's request and words, with no step-up and a refetch", () => {
    const handler = between("function saveRewardsPreference", "function removeMethod");
    expect(handler).toContain('run("rewards", "put", async () => {');
    expect(handler).toContain('putJson<{ autoReload: unknown }>("/api/dropship/wallet/rewards/preference", buildRewardsPreferenceInput(spendRewardsFirst));');
    expect(handler).toContain("await refreshAfterWalletChange();");
    expect(handler).toContain("describeRewardsPreferenceSaved(spendRewardsFirst)");
    expect(handler).not.toContain("withVerification");
  });

  it("shows a rewards row's amount and balance in points in Activity, and what USDC earns under its address", () => {
    expect(source).toContain('<TableCell className="text-right font-mono">{describeLedgerAmount(entry)}</TableCell>');
    expect(source).toContain('<TableCell className="text-right font-mono">{describeBalanceAfterCell(entry)}</TableCell>');
    expect(source).not.toContain("formatSignedCents(entry.availableBalanceAfterCents)");
    expect(source).not.toContain("formatSignedCents(entry.amountCents)");
    const cell = between("function describeBalanceAfterCell", "function ActivitySection");
    expect(cell).toContain("ledgerBalanceAfter(entry)");
    expect(cell).toContain('after.balance === "rewards" ? formatPoints(after.cents) : formatSignedCents(after.cents)');
    expect(source.match(/data-testid="wallet-usdc-rewards"/g)).toHaveLength(2);
    expect(source.match(/describeRewardsEarning\("usdc_base", wallet\.limits\)/g)).toHaveLength(1);
    expect(source.match(/\{usdcRewards && <p className="text-sm text-zinc-600" data-testid="wallet-usdc-rewards">\{usdcRewards\}<\/p>\}/g)).toHaveLength(2);
  });
});

describe("USDC deposits on the wallet page (funding design phase 6)", () => {
  it("shows the vendor's own address or offers to get one, with the model's words, and asks for it without a step-up", () => {
    const panel = between("function UsdcFundingPanel", "function DepositStep");
    expect(panel).toContain("deposit.address.checksumAddress");
    expect(panel).toContain("data-testid=\"wallet-usdc-request-address\"");
    expect(panel).toContain("Get my deposit address");
    expect(panel).toContain("describeUsdcDeposit(deposit)");
    expect(panel).toContain("data-testid=\"wallet-usdc-timing\"");
    expect(panel).toContain("data-testid=\"wallet-usdc-warning\"");
    // The shared-address panel stays for a deployment without a key.
    expect(panel).toContain("wallet.usdcBaseDepositAddress");
    const request = between("async function requestUsdcAddress", "function checkAgain");
    expect(request).toContain("run(\"money\", \"usdc\"");
    expect(request).not.toContain("withVerification");
    expect(request).toContain("\"/api/dropship/wallet/usdc/deposit-address\"");
    expect(source.match(/usdcOfferedFor\(wallet\)/g)).toHaveLength(3);
    expect(source).toContain("describeUsdcSourceNote(wallet.usdcDeposit)");
    expect(source).not.toContain("wallet.usdcBaseDepositAddress !== null");
  });
});
