import { describe, expect, it } from "vitest";
import {
  AUTO_RELOAD_OFF_ALLOWED_STATUSES,
  EMPTY_DRAFT,
  acknowledgementForSave,
  buildAuthorizeInput,
  buildAutoReloadDisableInput,
  buildConfirmTermsInput,
  buildPendingStripe,
  buildPlanSaveInput,
  buildRemoveFundingMethodPath,
  depositFundingMethodFor,
  depositDefaultCents,
  depositOptions,
  describeDepositOption,
  defaultMinimumCents,
  deriveWalletFlow,
  describeMinimumOption,
  describeTopUpOption,
  minimumOptionFor,
  minimumOptions,
  topUpCentsFor,
  topUpChoiceFor,
  topUpOptions,
  draftAfterBackupChoice,
  draftAfterFloorChoice,
  draftAfterIntro,
  draftAfterSourceChoice,
  draftAtStep,
  describeAcknowledgementBanner,
  describeAuthorizationRecord,
  describeActivationQuote,
  describeActivationTopUp,
  cardFeeAt,
  cardFeeNoun,
  cardFeeOnTop,
  describeCardFee,
  REWARDS_LEDGER_REASONS,
  buildRewardsPreferenceInput,
  describeDepositRail,
  describeLedgerAmount,
  describeRewardsBalance,
  describeRewardsEarning,
  describeRewardsExpiryRule,
  describeRewardsNextExpiry,
  describeRewardsPreferenceSaved,
  describeRewardsRule,
  describeRewardsUse,
  rewardsApplyToOrders,
  ledgerBalanceAfter,
  rewardsOffered,
  describeBackupFollow,
  describeFundingMethod,
  describeFundingMethodDetailed,
  describeHoldTimeLine,
  describeIntro,
  describeMandate,
  describeAdvanceStanding,
  describeNegativeBalance,
  describePendingBalance,
  describePlanSentence,
  describeRoleGap,
  describeAdvanceReason,
  describeSavedCardAlternative,
  describeSourcePreselection,
  disabledReasonForRemoval,
  draftStorageKey,
  isPendingStripeLive,
  LEDGER_REASON_LABELS,
  parseWalletDraft,
  parseStripeReturn,
  planAfterSourceChange,
  planFromWallet,
  previousWalletStep,
  readWalletDraft,
  RECOMMENDED_SOURCE_RAIL,
  resolveStripeReturn,
  STEP_ORDER,
  stripStripeReturn,
  walletStepNumber,
  walletStepState,
  writeWalletDraft,
  type WalletDraft,
  type WalletFlowStep,
  type WalletTerms,
  describeUsdcDeposit,
  describeUsdcIntroSentence,
  describeUsdcSourceNote,
  usdcOfferedFor,
} from "../dropship-wallet-flow";
import type {
  WalletUsdcDeposit, DropshipWalletView, WalletFundingMethod, WalletLimits } from "../dropship-wallet-view-adapter";

const STAMP = "2026-09-15T00:00:00.000Z";
const LATER = "2026-09-16T00:00:00.000Z";
const NOW = new Date("2026-09-18T12:00:00.000Z");
const LIMITS = { autoReloadMinTriggerCents: 5_000, autoReloadMinAmountCents: 10_000, manualFundingMinCents: 1_000, manualFundingMaxCents: 500_000, cardFundingMinCents: 10_000, rewardsRateBankBps: 100, rewardsRateUsdcBps: 100, rewardsRateCardBps: 0, rewardsExpiryDays: null, defaultPaymentHoldTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120, caseTierMinimumCents: 50_000, advanceFeeBps: 100, advanceCapCents: 50_000, tierChangeGraceDays: 14, bankBalanceReadOffered: false };

function method(overrides: Partial<WalletFundingMethod> & { fundingMethodId: number }): WalletFundingMethod {
  const rail = overrides.rail ?? "stripe_card";
  return {
    rail, status: "active", displayLabel: null, usdcWalletAddress: null, createdAt: STAMP, updatedAt: STAMP,
    card: rail === "stripe_card" ? { brand: "Visa", last4: "4242", expMonth: 12, expYear: 2027 } : null,
    bankAccount: rail === "stripe_ach" ? { bankName: "Chase", last4: "1234", accountType: "checking" } : null,
    roles: { isAutoReloadSource: false, isBackupCard: false, chargeable: rail === "stripe_card" },
    ...overrides,
  };
}
const CARD = method({ fundingMethodId: 10 });
const BANK = method({ fundingMethodId: 30, rail: "stripe_ach" });

function wallet(overrides: Partial<DropshipWalletView> = {}): DropshipWalletView {
  const base: DropshipWalletView = {
    account: { availableBalanceCents: 0, pendingBalanceCents: 0, rewardsBalanceCents: 0, currency: "USD", status: "active" },
    autoReload: null, fundingMethods: [], recentLedger: [], cardFundingFeeBps: 300, usdcBaseDepositAddress: null, usdcDeposit: null,
    limits: LIMITS, setupStatus: { sourceReady: false, backupReady: false, acknowledged: false, done: false, launchReady: false }, listingTiers: null, advance: null,
    rewardsNextExpiry: null, clientFallbacks: [],
  };
  return { ...base, ...overrides };
}

function doneWallet(overrides: Partial<DropshipWalletView> = {}): DropshipWalletView {
  return wallet({
    autoReload: { autoReloadSettingId: 5, enabled: true, minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000, topUpAmountCents: null, paymentHoldTimeoutMinutes: 2_880, fundingMethodId: 30, updatedAt: STAMP, backstopFundingMethodId: 10, acknowledgedCardFeeBps: 300, acknowledgedAt: STAMP, spendRewardsFirst: true },
    fundingMethods: [{ ...CARD, roles: { isAutoReloadSource: false, isBackupCard: true, chargeable: true } }, { ...BANK, roles: { isAutoReloadSource: true, isBackupCard: false, chargeable: false } }],
    setupStatus: { sourceReady: true, backupReady: true, acknowledged: true, done: true, launchReady: true },
    ...overrides,
  });
}

const draft = (overrides: Partial<WalletDraft> = {}): WalletDraft => ({ ...EMPTY_DRAFT, ...overrides });
/** A draft whose owner has read the intro; nothing past step 1 is reached without one. */
const started = (overrides: Partial<WalletDraft> = {}): WalletDraft => draft({ seenIntro: true, ...overrides });
const derive = (w: DropshipWalletView, d: WalletDraft = draft(), vendorStatus = "onboarding") => deriveWalletFlow({ wallet: w, vendorStatus, draft: d, now: NOW });

describe("deriveWalletFlow", () => {
  it("walks the decision table in order", () => {
    expect(derive(wallet())).toMatchObject({ mode: "flow", step: "intro" });
    expect(derive(wallet(), started())).toMatchObject({ step: "source", suggestedSourceMethodId: null });
    expect(derive(wallet({ fundingMethods: [CARD, BANK] }), started())).toMatchObject({ step: "source", suggestedSourceMethodId: 30 });
    // A saved card is never preselected: the picker opens on the recommended bank rail.
    expect(derive(wallet({ fundingMethods: [CARD] }), started())).toMatchObject({ step: "source", suggestedSourceMethodId: null });
    // Nothing drafted or saved: the step opens on the pack minimum the policy serves.
    expect(derive(wallet({ fundingMethods: [BANK] }), started({ sourceMethodId: 30 }))).toMatchObject({ step: "floor", floorCents: 5_000 });
    expect(derive(wallet({ fundingMethods: [BANK] }), started({ sourceMethodId: 30, floorCents: 4_000 }))).toMatchObject({ step: "floor" });
    expect(derive(wallet({ fundingMethods: [BANK] }), started({ sourceMethodId: 30, floorCents: 25_000 }))).toMatchObject({ step: "backup", backup: null, topUpCents: null, limitCents: 25_000 });
    expect(derive(wallet({ fundingMethods: [BANK, CARD] }), started({ sourceMethodId: 30, floorCents: 25_000 }))).toMatchObject({ step: "backup" });
    expect(derive(wallet({ fundingMethods: [BANK, CARD] }), started({ sourceMethodId: 30, floorCents: 25_000, backupMethodId: 10 }))).toMatchObject({ step: "authorize", backup: { satisfiedBySource: false } });
    expect(derive(wallet({ fundingMethods: [CARD] }), started({ sourceMethodId: 10, floorCents: 10_000 }))).toMatchObject({ step: "authorize", backup: { method: CARD, satisfiedBySource: true }, limitCents: 10_000 });
  });

  it("shows the intro to anyone who has not read it, whatever is already saved on the wallet", () => {
    // The old rule skipped step 1 whenever a method existed, so a vendor whose
    // wallet carried a card from the old flow was never shown the charge rules.
    const carriedOver = method({ fundingMethodId: 12, card: { brand: "Amex", last4: "6800", expMonth: 12, expYear: 2028 } });
    expect(derive(wallet({ fundingMethods: [carriedOver] }))).toMatchObject({ step: "intro", furthestStep: "intro", reachableSteps: ["intro"] });
    expect(derive(wallet({ fundingMethods: [carriedOver, BANK] }))).toMatchObject({ step: "intro", furthestStep: "intro" });
    // Reading it is the only thing that moves the flow on, and it stays read.
    expect(derive(wallet({ fundingMethods: [carriedOver] }), started())).toMatchObject({ step: "source", suggestedSourceMethodId: null });
  });

  it("ignores an expired, archived or pending card as backup", () => {
    const expired = method({ fundingMethodId: 11, card: { brand: "Visa", last4: "1111", expMonth: 1, expYear: 2026 } });
    expect(derive(wallet({ fundingMethods: [BANK, expired] }), started({ sourceMethodId: 30, floorCents: 25_000, backupMethodId: 11 }))).toMatchObject({ step: "backup", backup: null });
    expect(derive(wallet({ fundingMethods: [BANK, { ...CARD, status: "archived" }] }), started({ sourceMethodId: 30, floorCents: 25_000, backupMethodId: 10 })).step).toBe("backup");
    expect(derive(wallet({ fundingMethods: [BANK, { ...CARD, status: "setup_pending" }] }), started({ sourceMethodId: 30, floorCents: 25_000, backupMethodId: 10 })).step).toBe("backup");
  });

  it("ends the flow in manage, with the deposit step only for a bank source below the floor", () => {
    expect(derive(doneWallet())).toMatchObject({ mode: "manage", step: null, canTurnOffAutoReload: true, authorized: true });
    expect(derive(doneWallet(), draft({ deposit: "pending" }))).toMatchObject({ mode: "flow", step: "deposit" });
    expect(derive(doneWallet({ account: { availableBalanceCents: 0, pendingBalanceCents: 25_000, rewardsBalanceCents: 0, currency: "USD", status: "active" } }), draft({ deposit: "pending" }))).toMatchObject({ mode: "manage" });
    expect(derive(doneWallet(), draft({ deposit: "skipped" }))).toMatchObject({ mode: "manage" });
    const cardSource = doneWallet({ autoReload: { ...doneWallet().autoReload!, fundingMethodId: 10, backstopFundingMethodId: 10 } });
    expect(derive(cardSource, draft({ deposit: "pending" }))).toMatchObject({ mode: "manage" });
  });

  it("never walks an active, paused, lapsed or closed vendor through onboarding copy", () => {
    for (const status of ["active", "paused", "lapsed", "suspended", "closed"]) {
      expect(derive(wallet(), draft(), status)).toMatchObject({ mode: "manage", step: null });
    }
    expect(derive(doneWallet(), draft(), "active").canTurnOffAutoReload).toBe(false);
    expect(derive(doneWallet(), draft(), "paused").canTurnOffAutoReload).toBe(false);
    expect(derive(doneWallet(), draft(), "closed").canTurnOffAutoReload).toBe(true);
    expect([...AUTO_RELOAD_OFF_ALLOWED_STATUSES].sort()).toEqual(["closed", "lapsed", "onboarding", "suspended"]);
  });

  it("treats the seed row (enabled, no method) as not authorized", () => {
    const seed = wallet({ autoReload: { autoReloadSettingId: 1, enabled: true, minimumBalanceCents: 25_000, maxSingleReloadCents: null, topUpAmountCents: null, paymentHoldTimeoutMinutes: 2_880, fundingMethodId: null, updatedAt: STAMP, backstopFundingMethodId: null, acknowledgedCardFeeBps: null, acknowledgedAt: null, spendRewardsFirst: null } });
    expect(derive(seed)).toMatchObject({ authorized: false, feeRecordMissing: false, roleGaps: { backupCard: false, source: false }, canTurnOffAutoReload: false });
  });

  it("computes role gaps from roles and flows a negative balance through every branch", () => {
    const gone = doneWallet({ fundingMethods: [{ ...BANK, roles: { isAutoReloadSource: true, isBackupCard: false, chargeable: false } }] });
    expect(derive(gone, draft(), "active").roleGaps).toEqual({ backupCard: true, source: false });
    const sourceGone = doneWallet({ fundingMethods: [{ ...CARD, roles: { isAutoReloadSource: false, isBackupCard: true, chargeable: true } }] });
    expect(derive(sourceGone, draft(), "active").roleGaps).toEqual({ backupCard: false, source: true });
    const negative = { availableBalanceCents: -5_000, pendingBalanceCents: 0, rewardsBalanceCents: 0, currency: "USD", status: "active" };
    expect(() => derive(wallet({ account: negative }))).not.toThrow();
    expect(() => derive(doneWallet({ account: negative }), draft({ deposit: "pending" }))).not.toThrow();
  });

  it("derives the acknowledgement faces without overriding a server verdict", () => {
    const missing = doneWallet({ autoReload: { ...doneWallet().autoReload!, acknowledgedCardFeeBps: null, acknowledgedAt: null, spendRewardsFirst: true }, setupStatus: { ...doneWallet().setupStatus, acknowledged: false, launchReady: false } });
    expect(derive(missing)).toMatchObject({ needsAcknowledgement: true, feeRecordMissing: true, feeChange: null });
    const raised = doneWallet({ cardFundingFeeBps: 350, setupStatus: { ...doneWallet().setupStatus, acknowledged: false } });
    expect(derive(raised)).toMatchObject({ needsAcknowledgement: true, feeRecordMissing: false, feeChange: { recordedBps: 300, currentBps: 350 } });
    expect(derive(doneWallet())).toMatchObject({ needsAcknowledgement: false, feeChange: null });
    expect(derive(doneWallet({ cardFundingFeeBps: 350 })).needsAcknowledgement).toBe(false);
    expect(describeAcknowledgementBanner({ feeChange: null, onboarding: true })).toBe("Please review and confirm your autopay terms. Nothing changes until you confirm. You cannot activate until you do.");
    expect(describeAcknowledgementBanner({ feeChange: { recordedBps: 300, currentBps: 350 }, onboarding: false })).toContain("automatic top-ups and covers stay at 3%; money you add yourself shows the current fee on Stripe's page");
    // A cut needs nothing from the vendor: no fee change, no banner, whatever the record says.
    const cut = doneWallet({ cardFundingFeeBps: 0 });
    expect(derive(cut)).toMatchObject({ needsAcknowledgement: false, feeRecordMissing: false, feeChange: null });
    expect(derive(doneWallet({ cardFundingFeeBps: 250 }))).toMatchObject({ needsAcknowledgement: false, feeChange: null });
    // Handed a cut anyway, the banner reads as a plain confirmation and never restates the old rate.
    expect(describeAcknowledgementBanner({ feeChange: { recordedBps: 300, currentBps: 250 }, onboarding: false })).toBe("Please review and confirm your autopay terms. Nothing changes until you confirm.");
  });

  it("reports how far the flow reached and which steps that makes reachable", () => {
    expect(derive(wallet())).toMatchObject({ step: "intro", furthestStep: "intro", reachableSteps: ["intro"] });
    expect(derive(wallet(), started())).toMatchObject({ furthestStep: "source", reachableSteps: ["intro", "source"] });
    expect(derive(wallet({ fundingMethods: [BANK] }), started({ sourceMethodId: 30 }))).toMatchObject({ furthestStep: "floor", reachableSteps: ["intro", "source", "floor"] });
    expect(derive(wallet({ fundingMethods: [BANK, CARD] }), started({ sourceMethodId: 30, floorCents: 25_000, backupMethodId: 10 })))
      .toMatchObject({ furthestStep: "authorize", reachableSteps: ["intro", "source", "floor", "backup", "authorize"] });
    // Past authorization the choices belong to the server: only the rules and
    // the review stay open, so step 6 cannot reopen step 2 and edit a dead draft.
    expect(derive(doneWallet(), started({ deposit: "pending" }))).toMatchObject({ furthestStep: "deposit", reachableSteps: ["intro", "authorize", "deposit"] });
    expect(derive(doneWallet(), started({ deposit: "pending", stepOverride: "source" })).step).toBe("deposit");
    expect(derive(doneWallet(), started({ deposit: "pending", stepOverride: "authorize" })).step).toBe("authorize");
    // Manage has no steps at all, so nothing is reachable and nothing is current.
    expect(derive(doneWallet(), draft({ stepOverride: "source" }), "active")).toMatchObject({ mode: "manage", step: null, furthestStep: null, reachableSteps: [] });
  });

  it("marks a step done only when it is behind the flow, and the intro only once it has been read", () => {
    const seen = { current: "backup" as const, furthestStep: "backup" as const, seenIntro: true };
    expect(STEP_ORDER.map((step) => walletStepState(step, seen))).toEqual(["done", "done", "done", "current", "later", "later"]);
    // Revisiting step 2 keeps step 3's result on screen instead of greying it out.
    expect(STEP_ORDER.map((step) => walletStepState(step, { ...seen, current: "source" }))).toEqual(["done", "current", "done", "later", "later", "later"]);
    // A vendor carried past step 1 by an authorized plan never sees a tick for a page they were not shown.
    const unseen = { current: "deposit" as const, furthestStep: "deposit" as const, seenIntro: false };
    expect(walletStepState("intro", unseen)).toBe("later");
    expect(walletStepState("intro", { ...unseen, seenIntro: true })).toBe("done");
    expect(walletStepState("intro", { current: "intro", furthestStep: "intro", seenIntro: false })).toBe("current");
    expect(walletStepState("source", unseen)).toBe("done");
  });

  it("shows the step the vendor asked for when it is reachable, and ignores any other override", () => {
    const w = wallet({ fundingMethods: [BANK, CARD] });
    const reached = started({ sourceRail: "stripe_ach", sourceMethodId: 30, floorCents: 25_000 });
    expect(derive(w, reached).step).toBe("backup");
    for (const step of ["intro", "source", "floor", "backup"] as WalletFlowStep[]) {
      expect(derive(w, { ...reached, stepOverride: step })).toMatchObject({ step, furthestStep: "backup" });
    }
    // Ahead of the flow, or not a step at all: ignored, never an error — the vendor stays where the flow left them.
    expect(derive(w, { ...reached, stepOverride: "authorize" }).step).toBe("backup");
    expect(derive(w, { ...reached, stepOverride: "deposit" }).step).toBe("backup");
    expect(derive(w, { ...reached, stepOverride: "nowhere" as unknown as WalletFlowStep }).step).toBe("backup");
    // An override held over from earlier in the flow stops being reachable when its value is cleared.
    expect(derive(w, { ...reached, floorCents: null, stepOverride: "backup" })).toMatchObject({ step: "floor", furthestStep: "floor" });
    // The intro is reachable from everywhere in the flow, whether or not it was ever shown.
    const anywhere: Array<[DropshipWalletView, WalletDraft]> = [[wallet(), draft()], [w, reached], [wallet(), started()], [doneWallet(), started({ deposit: "pending" })], [doneWallet(), draft({ deposit: "pending" })]];
    for (const [anyWallet, anyDraft] of anywhere) expect(derive(anyWallet, anyDraft).reachableSteps[0]).toBe("intro");
    expect(derive(doneWallet(), draft({ deposit: "pending", stepOverride: "intro" }))).toMatchObject({ step: "intro", furthestStep: "deposit" });
  });

  it("numbers the steps and walks back through them", () => {
    expect([...STEP_ORDER]).toEqual(["intro", "source", "floor", "backup", "authorize", "deposit"]);
    expect(STEP_ORDER.map(walletStepNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(STEP_ORDER.map(previousWalletStep)).toEqual([null, "intro", "source", "floor", "backup", "authorize"]);
  });

  it("holds autopay to the server's bound until the amounts change, then to the one the server will derive", () => {
    const stored = doneWallet({ autoReload: { ...doneWallet().autoReload!, maxSingleReloadCents: 100_000 } });
    expect(derive(stored, draft(), "active")).toMatchObject({ floorCents: 25_000, topUpCents: null, limitCents: 100_000 });
    expect(derive(stored, draft({ floorCents: 50_000 }), "active")).toMatchObject({ floorCents: 50_000, topUpCents: null, limitCents: 50_000 });
    expect(derive(doneWallet(), draft({ topUpCents: 75_000 }), "active")).toMatchObject({ floorCents: 25_000, topUpCents: 75_000, limitCents: 75_000 });
    const withTopUp = doneWallet({ autoReload: { ...doneWallet().autoReload!, topUpAmountCents: 40_000, maxSingleReloadCents: 40_000 } });
    expect(derive(withTopUp, draft(), "active")).toMatchObject({ topUpCents: 40_000, limitCents: 40_000 });
    expect(derive(withTopUp, draft({ floorCents: 100_000 }), "active")).toMatchObject({ topUpCents: 40_000, limitCents: 100_000 });
  });
});

describe("acknowledgementForSave and builders", () => {
  it("carries the record for an ordinary save, the rate in force when none exists", () => {
    expect(acknowledgementForSave({ autoReload: doneWallet().autoReload, cardFundingFeeBps: 300 })).toEqual({ acknowledgedCardFeeBps: 300, saveLabel: "Save", feeChangeNote: null });
    const changed = acknowledgementForSave({ autoReload: doneWallet().autoReload, cardFundingFeeBps: 350 });
    expect(changed.acknowledgedCardFeeBps).toBe(300);
    expect(changed.feeChangeNote).toBe("Card charges now carry a 3.5% fee (you agreed to a 3% fee). Automatic top-ups and covers stay at 3% until you confirm the new terms above; this save does not change that.");
    expect(acknowledgementForSave({ autoReload: { ...doneWallet().autoReload!, acknowledgedCardFeeBps: null }, cardFundingFeeBps: 300 })).toEqual({ acknowledgedCardFeeBps: 300, saveLabel: "Save and accept the 3% card fee", feeChangeNote: null });
  });

  it("builds the seven-key bodies: the minimum and the top-up amount go up, the bound never does", () => {
    const plan = { fundingMethodId: 30, backupFundingMethodId: 10, floorCents: 25_000, topUpCents: null, limitCents: 50_000, holdTimeoutMinutes: 2_880 };
    expect(buildAuthorizeInput(plan, wallet())).toEqual({ enabled: true, fundingMethodId: 30, backstopFundingMethodId: 10, minimumBalanceCents: 25_000, topUpAmountCents: null, paymentHoldTimeoutMinutes: 2_880, acknowledgedCardFeeBps: 300 });
    expect(buildAuthorizeInput({ ...plan, topUpCents: 40_000 }, wallet())).toMatchObject({ topUpAmountCents: 40_000 });
    expect(buildAuthorizeInput(plan, wallet())).not.toHaveProperty("maxSingleReloadCents");
    expect(buildConfirmTermsInput(plan, wallet({ cardFundingFeeBps: 350 })).acknowledgedCardFeeBps).toBe(350);
    expect(buildPlanSaveInput(plan, doneWallet({ cardFundingFeeBps: 350 })).acknowledgedCardFeeBps).toBe(300);
    expect(buildAutoReloadDisableInput(doneWallet())).toEqual({ enabled: false, fundingMethodId: 30, backstopFundingMethodId: 10, minimumBalanceCents: 25_000, topUpAmountCents: null, paymentHoldTimeoutMinutes: 2_880, acknowledgedCardFeeBps: null });
    // The hold is CardShellz's policy for every wallet: a saved row still
    // carrying an older value is never echoed back, shown or derived from.
    const policyHold = doneWallet({ limits: { ...LIMITS, defaultPaymentHoldTimeoutMinutes: 1_440 } });
    expect(buildAutoReloadDisableInput(policyHold).paymentHoldTimeoutMinutes).toBe(1_440);
    expect(planFromWallet(policyHold)?.holdTimeoutMinutes).toBe(1_440);
    expect(derive(policyHold).holdTimeoutMinutes).toBe(1_440);
    expect(() => buildAuthorizeInput({ ...plan, floorCents: 4_000 }, wallet())).toThrow("at least $50");
    expect(() => buildAuthorizeInput({ ...plan, topUpCents: 5_000 }, wallet())).toThrow("The top-up amount must be at least $100.");
    expect(() => buildAuthorizeInput({ ...plan, backupFundingMethodId: 0 }, wallet())).toThrow("backup card");
    expect(buildRemoveFundingMethodPath(10)).toBe("/api/dropship/wallet/funding-methods/10");
    expect(() => buildRemoveFundingMethodPath(0)).toThrow();
    expect(planFromWallet(doneWallet())).toEqual(plan);
    expect(planFromWallet(wallet())).toBeNull();
  });

  it("makes a card source the backup and keeps the chosen backup for a bank source", () => {
    const plan = planFromWallet(doneWallet())!;
    const card99 = method({ fundingMethodId: 99, card: { brand: "Visa", last4: "9999", expMonth: 1, expYear: 2030 } });
    expect(planAfterSourceChange(plan, card99, null)).toMatchObject({ fundingMethodId: 99, backupFundingMethodId: 99 });
    expect(planAfterSourceChange({ ...plan, fundingMethodId: 99, backupFundingMethodId: 99 }, BANK, 10)).toMatchObject({ fundingMethodId: 30, backupFundingMethodId: 10 });
    expect(describeBackupFollow(CARD, card99)).toBe("Your backup card becomes Visa ending in 9999 (was Visa ending in 4242).");
    expect(describeBackupFollow(card99, card99)).toBeNull();
    expect(describeBackupFollow(card99, BANK)).toBe("Choose your backup card below.");
  });

  it("pre-disables removal from enabled-aware roles", () => {
    const backup = { ...CARD, roles: { isAutoReloadSource: false, isBackupCard: true, chargeable: true } };
    expect(disabledReasonForRemoval(backup, false)).toBe("This is your backup card — choose another backup card first, then remove this one.");
    expect(disabledReasonForRemoval(backup, true)).toBe("This is your backup card — choose another backup card first, then remove this one. — or turn off autopay.");
    expect(disabledReasonForRemoval({ ...BANK, roles: { isAutoReloadSource: true, isBackupCard: false, chargeable: false } }, false)).toBe("This is your autopay source — choose another source first, then remove this one.");
    expect(disabledReasonForRemoval(CARD, false)).toBeNull();
    expect(disabledReasonForRemoval(method({ fundingMethodId: 20, rail: "usdc_base", roles: { isAutoReloadSource: false, isBackupCard: false, chargeable: false } }), false)).toBeNull();
  });

  it("picks the deposit instrument: the configured source for its rail, else the newest active of the rail", () => {
    const newerCard = method({ fundingMethodId: 11, createdAt: LATER });
    const w = doneWallet({ fundingMethods: [CARD, BANK, newerCard, { ...method({ fundingMethodId: 12, createdAt: "2026-09-17T00:00:00.000Z" }), status: "setup_pending" }] });
    expect(depositFundingMethodFor(w, "stripe_ach")?.fundingMethodId).toBe(30);
    expect(depositFundingMethodFor(w, "stripe_card")?.fundingMethodId).toBe(11);
    expect(depositFundingMethodFor(wallet(), "stripe_card")).toBeNull();
  });
});

describe("draft and redirects", () => {
  it("parses only a well-formed draft, scoped by vendor", () => {
    expect(draftStorageKey(7)).toBe("dropship-wallet-setup-draft:v1:7");
    expect(parseWalletDraft(JSON.stringify(draft({ floorCents: 25_000 })))).toMatchObject({ floorCents: 25_000 });
    expect(parseWalletDraft("not json")).toBeNull();
    expect(parseWalletDraft(JSON.stringify({ ...draft(), v: 2 }))).toBeNull();
    expect(parseWalletDraft(JSON.stringify(draft({ floorCents: 1.5 })))).toBeNull();
    expect(parseWalletDraft(JSON.stringify(draft({ pendingStripe: { rail: "stripe_ach", purpose: "nope", knownMethods: [], ledgerMark: null, startedAt: STAMP, expiresAt: STAMP } as never })))).toBeNull();
    expect(parseWalletDraft(JSON.stringify(draft({ pendingStripe: { rail: "stripe_ach", purpose: "source", knownMethods: [{ id: 1 }], ledgerMark: null, startedAt: STAMP, expiresAt: STAMP } as never })))).toBeNull();
    expect(parseWalletDraft(JSON.stringify(draft({ pendingStripe: { rail: "stripe_ach", purpose: "source", knownMethods: [], ledgerMark: null, startedAt: STAMP, expiresAt: "soon" } })))).toBeNull();
  });

  it("reads a draft written before step navigation existed, and drops an unreadable override rather than the draft", () => {
    // Exactly what v1 wrote before `stepOverride`, daily cost included: it still parses, minus that
    // retired key, with no override and every choice intact.
    const kept = { v: 1, seenIntro: true, sourceRail: "stripe_ach", sourceMethodId: 30, floorCents: 25_000, backupMethodId: 10, pendingStripe: null, deposit: null };
    const legacy = { ...kept, dailyCostCents: 2_000 };
    // A draft from before the top-up amount existed reads as "the minimum".
    expect(parseWalletDraft(JSON.stringify(legacy))).toEqual({ ...kept, stepOverride: null, topUpCents: null });
    expect(parseWalletDraft(JSON.stringify(legacy))).not.toHaveProperty("dailyCostCents");
    expect(parseWalletDraft(JSON.stringify({ ...legacy, stepOverride: "floor" }))).toMatchObject({ stepOverride: "floor", floorCents: 25_000, topUpCents: null });
    expect(parseWalletDraft(JSON.stringify({ ...legacy, stepOverride: "nowhere" }))).toEqual({ ...kept, stepOverride: null, topUpCents: null });
    expect(parseWalletDraft(JSON.stringify({ ...legacy, stepOverride: 3 }))).toEqual({ ...kept, stepOverride: null, topUpCents: null });
    expect(parseWalletDraft(JSON.stringify({ ...legacy, topUpCents: 40_000 }))).toMatchObject({ topUpCents: 40_000 });
    // Any other unknown key is still a foreign draft, discarded rather than repaired.
    expect(parseWalletDraft(JSON.stringify({ ...kept, somethingElse: 1 }))).toBeNull();
  });

  it("falls back to an in-memory draft when storage throws", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
    expect(writeWalletDraft(storage, 1, draft({ floorCents: 25_000 }))).toBe(true);
    expect(readWalletDraft(storage, 1)).toEqual({ draft: draft({ floorCents: 25_000 }), storageFailed: false });
    expect(readWalletDraft(storage, 2).draft).toEqual(EMPTY_DRAFT);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
    expect(readWalletDraft(broken, 1)).toEqual({ draft: EMPTY_DRAFT, storageFailed: true });
    expect(writeWalletDraft(broken, 1, draft())).toBe(false);
    expect(readWalletDraft(null, 1).storageFailed).toBe(true);
  });

  it("reads and strips the Stripe markers", () => {
    expect(parseStripeReturn("?funding_setup=success")).toEqual({ kind: "funding_setup", status: "success" });
    expect(parseStripeReturn("?wallet_funding=cancelled&x=1")).toEqual({ kind: "wallet_funding", status: "cancelled" });
    expect(parseStripeReturn("?funding_setup=maybe")).toBeNull();
    expect(stripStripeReturn("?funding_setup=success&x=1")).toBe("?x=1");
    expect(stripStripeReturn("?wallet_funding=success")).toBe("");
  });

  it("resolves a redirect by a new or refreshed method, or a moved ledger mark", () => {
    const w = wallet({ fundingMethods: [BANK] });
    const pending = buildPendingStripe({ rail: "stripe_ach", purpose: "source", wallet: w, startedAt: NOW, expiresAt: null });
    expect(pending.knownMethods).toEqual([{ id: 30, updatedAt: STAMP }]);
    expect(pending.ledgerMark).toBeNull();
    expect(isPendingStripeLive(pending, NOW)).toBe(true);
    expect(isPendingStripeLive(pending, new Date(NOW.getTime() + 2 * 60 * 60 * 1000))).toBe(false);
    expect(resolveStripeReturn(pending, w)).toBeNull();
    const added = method({ fundingMethodId: 31, rail: "stripe_ach", createdAt: LATER });
    expect(resolveStripeReturn(pending, wallet({ fundingMethods: [BANK, added] }))).toEqual({ kind: "method", method: added });
    expect(resolveStripeReturn(pending, wallet({ fundingMethods: [{ ...BANK, updatedAt: LATER }] }))).toEqual({ kind: "method", method: { ...BANK, updatedAt: LATER } });
    expect(resolveStripeReturn(pending, wallet({ fundingMethods: [BANK, { ...added, status: "setup_pending" }] }))).toBeNull();
    expect(resolveStripeReturn(pending, wallet({ fundingMethods: [BANK, method({ fundingMethodId: 11 })] }))).toBeNull();

    const depositPending = buildPendingStripe({ rail: "stripe_ach", purpose: "deposit", wallet: w, startedAt: NOW, expiresAt: "2026-09-18T13:00:00.000Z" });
    expect(depositPending.ledgerMark).toEqual({ newestLedgerEntryId: null, availableBalanceCents: 0, pendingBalanceCents: 0 });
    expect(resolveStripeReturn(depositPending, w)).toBeNull();
    expect(resolveStripeReturn(depositPending, wallet({ account: { availableBalanceCents: 0, pendingBalanceCents: 25_000, rewardsBalanceCents: 0, currency: "USD", status: "active" } }))).toEqual({ kind: "deposit_seen" });
    const ledgered = wallet({ recentLedger: [{ ledgerEntryId: 4, type: "funding", status: "pending", amountCents: 25_000, currency: "USD", availableBalanceAfterCents: 0, pendingBalanceAfterCents: 25_000, rewardsBalanceAfterCents: null, createdAt: STAMP, settledAt: null, reason: "manual_top_up", fundingMethodId: 30, cardFee: null, failure: null }] });
    expect(resolveStripeReturn(depositPending, ledgered)).toEqual({ kind: "deposit_seen" });
    const marked = buildPendingStripe({ rail: "stripe_ach", purpose: "deposit", wallet: ledgered, startedAt: NOW, expiresAt: null });
    expect(resolveStripeReturn(marked, ledgered)).toBeNull();
  });
});

describe("moving through the flow", () => {
  const reached = draft({ seenIntro: true, sourceRail: "stripe_ach", sourceMethodId: 30, floorCents: 25_000, backupMethodId: 10, stepOverride: "source" });

  it("clicking a step changes only where the vendor is", () => {
    const before = { ...reached };
    expect(draftAtStep(reached, "floor")).toEqual({ ...reached, stepOverride: "floor" });
    expect(draftAtStep(reached, "intro")).toEqual({ ...reached, stepOverride: "intro" });
    expect(reached).toEqual(before);
  });

  it("records the intro once and sends the vendor back to where the flow was", () => {
    expect(draftAfterIntro(draft({ stepOverride: "intro" }))).toEqual(draft({ seenIntro: true }));
    // A revisit withdraws nothing: every choice, and `seenIntro` itself, survive.
    expect(draftAfterIntro({ ...reached, stepOverride: "intro" })).toEqual({ ...reached, stepOverride: null });
  });

  it("keeps every downstream value on a Continue that changes nothing, and clears the floor only when the rail changes", () => {
    const bank31 = method({ fundingMethodId: 31, rail: "stripe_ach" });
    // Same method: the floor and the backup card stand; only the override is released.
    expect(draftAfterSourceChoice(reached, BANK, BANK)).toEqual({ ...reached, stepOverride: null });
    // Another account on the same rail: the floor still means the same thing.
    expect(draftAfterSourceChoice(reached, bank31, BANK)).toEqual({ ...reached, stepOverride: null, sourceMethodId: 31 });
    // A different rail: the floor is rail-specific, so it is re-asked; the backup card is not.
    expect(draftAfterSourceChoice(reached, CARD, BANK)).toEqual({ ...reached, stepOverride: null, sourceMethodId: 10, sourceRail: "stripe_card", floorCents: null });
    // First pick: nothing saved to compare against, so nothing to clear.
    expect(draftAfterSourceChoice(draft({ seenIntro: true }), BANK, null)).toEqual(draft({ seenIntro: true, sourceMethodId: 30, sourceRail: "stripe_ach" }));
    const before = { ...reached };
    draftAfterSourceChoice(reached, CARD, BANK);
    expect(reached).toEqual(before);
  });

  it("saves the floor and the backup card without touching anything else", () => {
    expect(draftAfterFloorChoice(reached, 25_000, null)).toEqual({ ...reached, stepOverride: null });
    expect(draftAfterFloorChoice(reached, 50_000, null)).toEqual({ ...reached, stepOverride: null, floorCents: 50_000 });
    expect(draftAfterFloorChoice(reached, 50_000, 75_000)).toEqual({ ...reached, stepOverride: null, floorCents: 50_000, topUpCents: 75_000 });
    expect(() => draftAfterFloorChoice(reached, -1, null)).toThrow(RangeError);
    expect(() => draftAfterFloorChoice(reached, 25_000.5, null)).toThrow(RangeError);
    expect(() => draftAfterFloorChoice(reached, 25_000, -1)).toThrow(RangeError);
    expect(draftAfterBackupChoice(reached, CARD)).toEqual({ ...reached, stepOverride: null });
    expect(draftAfterBackupChoice(reached, method({ fundingMethodId: 11 }))).toEqual({ ...reached, stepOverride: null, backupMethodId: 11 });
  });

  it("lands a Continue back on the step the choices reach, not the one that was revisited", () => {
    const w = wallet({ fundingMethods: [BANK, CARD] });
    const revisiting = { ...reached, backupMethodId: null, stepOverride: "source" as const };
    expect(derive(w, revisiting).step).toBe("source");
    const afterContinue = draftAfterSourceChoice(revisiting, BANK, BANK);
    expect(derive(w, afterContinue)).toMatchObject({ step: "backup", furthestStep: "backup", floorCents: 25_000 });
  });
});

describe("copy", () => {
  const terms: WalletTerms = { sourceRail: "stripe_ach", sourceLabel: "Chase ending in 1234", backupLabel: "Visa ending in 4242", floorCents: 25_000, topUpCents: null, limitCents: 50_000, chargeCeilingCents: 500_000, holdTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120, cardFundingFeeBps: 300 };

  it("words the bank mandate from the numbers: the minimum, the top-up amount and the bound", () => {
    const lines = describeMandate(terms);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("Debit Chase ending in 1234 whenever an order takes your balance below your reserve of $250, and at the daily check: your top-up amount of $250 (your reserve), or more if that alone would not bring you back to $250. No fee. Money already on its way counts, so the same gap is not debited twice.");
    expect(lines[1]).toContain("While your account is active, charge Visa ending in 4242 only when an order needs more than your available balance: the shortfall plus the 3% card fee, whatever its size (up to $5,000)");
    expect(lines[1]).toContain("even while a bank top-up is still landing or your autopay source cannot be charged");
    expect(lines[1]).toContain("a $75 order with $20 available charges $55 + $1.65");
    expect(lines[1]).toContain("If a return fee has taken your balance below zero, the shortfall includes that amount.");
    expect(lines[2]).toBe("Routine top-ups never take more than $500 in one charge — the larger of your reserve and your top-up amount. A held order is different: your backup card is charged its whole shortfall, up to $5,000, the most any single payment may be. An order short by more than $5,000 is not charged: it waits for you to add money and is cancelled if still unpaid after 48 hours. We email you 2 hours before that.");
    expect(lines[3]).toContain("first daily check after you activate (about midnight UTC)");
    expect(lines[3]).toContain("Adding money by card now avoids that");
    expect(lines[3]).toContain("debits Chase ending in 1234 for your top-up amount ($250), or more if that alone would not reach $250");
    expect(lines[4]).toContain("before it lands");
    expect(lines[4]).toContain("We do not retry");
    expect(lines[5]).toContain("autopay stays on; the source, reserve, top-up amount and backup card can be changed at any time in Wallet");
    expect(lines[5]).toContain("for automatic top-ups and covers");
    expect(lines[5]).toContain("shows the current fee on Stripe's page");
    const joined = lines.join(" ");
    expect(joined).not.toMatch(/refill|has been notified|single top-up limit|floor|auto-reload/);
    expect(describeMandate({ ...terms, holdExpiryWarningMinutes: 90 })[2]).toContain("1 hour 30 minutes");
    // A top-up amount the vendor chose is named as theirs, not as the minimum.
    const chosen = describeMandate({ ...terms, topUpCents: 40_000, limitCents: 40_000 });
    expect(chosen[0]).toContain("your top-up amount of $400, or more if that alone would not bring you back to $250");
    expect(chosen[2]).toContain("Routine top-ups never take more than $400 in one charge");
  });

  it("words the card mandate with the routine top-up's fee and the bank-return clause", () => {
    const lines = describeMandate({ ...terms, sourceRail: "stripe_card", sourceLabel: "Visa ending in 4242", floorCents: 10_000, limitCents: 25_000 });
    expect(lines[0]).toBe("Charge Visa ending in 4242, plus the 3% fee, whenever an order takes your balance below your reserve of $100, and at the daily check: your top-up amount of $100 (your reserve), or more if that alone would not bring you back to $100 ($100 + $3 = $103 for a routine top-up).");
    expect(lines[1]).toContain("Visa ending in 4242 is also your backup card");
    expect(lines[1]).toContain("whatever its size (up to $5,000)");
    expect(lines[1]).toContain("If a return fee has taken your balance below zero, the shortfall includes that amount.");
    expect(lines[3]).toContain("charges Visa ending in 4242 your top-up amount ($100), or more if that alone would not reach $100");
    expect(lines[4]).toContain("or a bank transfer you started is returned before it lands");
    expect(describePlanSentence({ ...terms, sourceRail: "stripe_card", sourceLabel: "Visa ending in 4242", floorCents: 10_000 })).toBe("In one sentence: you keep a $100 reserve in your wallet, topped up by $100 from your Visa ending in 4242 at 3%; the same card covers any shortfall.");
    expect(describePlanSentence(terms)).toBe("In one sentence: you keep a $250 reserve in your wallet; when an order takes it lower, autopay pulls $250 from your bank for free, and your Visa ending in 4242 covers any shortfall plus 3%.");
    expect(describePlanSentence({ ...terms, topUpCents: 40_000 })).toContain("autopay pulls $400 from your bank for free");
  });

  it("pins the rules page: six topics, each a lead and its detail, quoting only the values the server enforces", () => {
    const limits: WalletLimits = { autoReloadMinTriggerCents: 5_000, autoReloadMinAmountCents: 10_000, manualFundingMinCents: 1_000, manualFundingMaxCents: 500_000, cardFundingMinCents: 10_000, rewardsRateBankBps: 100, rewardsRateUsdcBps: 100, rewardsRateCardBps: 0, rewardsExpiryDays: null, defaultPaymentHoldTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120, caseTierMinimumCents: 50_000, advanceFeeBps: 100, advanceCapCents: 50_000, tierChangeGraceDays: 14, bankBalanceReadOffered: false };
    const intro = describeIntro({ cardFundingFeeBps: 300, usdcOffered: true, holdTimeoutMinutes: 2_880, limits });
    expect(intro.lede).toBe("Your wallet is the deposit Card Shellz draws on for the orders you sell. Here is what it holds, what it lets you sell, how it stays funded, and what happens when a payment fails.");
    expect(intro.topics).toHaveLength(6);
    expect(intro.topics.map((topic) => topic.lead)).toEqual([
      "What your wallet is.",
      "What you can sell: your listing tier.",
      "Keeping it funded: your reserve and autopay.",
      "Ways to pay, and what each costs.",
      "Orders while a transfer lands, and your backup card.",
      "If a payment fails or is taken back.",
    ]);
    expect(intro.topics[0].detail).toBe("A prepaid deposit Card Shellz holds for your store. Every order you accept is paid from it: the product cost plus shipping, with nothing added on top. A return fee comes out of it too, and so does a payment your bank takes back after it landed; either can take the balance below zero.");
    expect(intro.topics[1].detail).toBe("The Pack tier (singles, packs and inner packs) is active while you keep a reserve of at least $50 in your wallet. The Case tier adds cases once your balance, counting money on its way, has reached $500. If Card Shellz raises a tier's reserve you keep selling for 14 days after the notice; after that the tier is not active until you are back above it.");
    expect(intro.topics[2].detail).toBe("You choose the reserve you keep — at least $50, or $500 for the Case tier. Whenever an order takes your balance below it, and at a daily check, autopay pulls a top-up from your bank account or card: your top-up amount, which is your reserve unless you set another, or more if that alone would not reach your reserve. Money already on its way counts, so the same gap is never pulled twice. Routine top-ups never take more than the larger of your reserve and your top-up amount in one charge. You can also add money yourself at any time.");
    expect(intro.topics[3].detail).toBe("A bank account costs nothing and takes up to 5 business days to land (our estimate). A card lands at once and costs 3% on top of the amount, whether autopay charged it, you added money yourself, or it covered an order. USDC costs nothing." + REWARDS_RULE);
    expect(intro.topics[4].detail).toBe("Money that has landed pays for orders first. A bank transfer still on its way can pay too, once the account it comes from qualifies — a business account, a balance we could read when it was linked, and one earlier transfer from it landed — for a 1% fee on the amount used, at most $500 outstanding at a time. If an order still needs more than your balance, we charge your backup card for the whole difference plus 3%, up to $5,000 in one payment, and send the order out. An order the card cannot cover waits 48 hours for you to add money, then is cancelled.");
    expect(intro.topics[5].detail).toBe("Selling pauses: your listings show no stock, and orders already waiting are cancelled after your hold time (48 hours). We email you, and we do not retry the charge ourselves. A payment your bank takes back after it landed is taken out of your wallet the same way. Selling starts again on its own once your balance is back at your reserve.");
    // USDC is named only where a deposit address exists, and never with a timing claim: nothing in the code watches the chain.
    const noUsdc = describeIntro({ cardFundingFeeBps: 300, usdcOffered: false, holdTimeoutMinutes: 2_880, limits });
    expect(noUsdc.topics[3].detail).not.toContain("USDC");
    expect(intro.topics[3].detail).not.toMatch(/instant|confirming the transfer|credits it/);
    // Every number is a served value; none is typed into the copy.
    const other = describeIntro({
      cardFundingFeeBps: 250,
      usdcOffered: false,
      holdTimeoutMinutes: 720,
      limits: { ...limits, autoReloadMinTriggerCents: 2_500, caseTierMinimumCents: 75_000, tierChangeGraceDays: 30, advanceFeeBps: 150, advanceCapCents: 100_000 },
    });
    expect(other.topics[1].detail).toContain("at least $25 in your wallet. The Case tier adds cases once your balance, counting money on its way, has reached $750. If Card Shellz raises a tier's reserve you keep selling for 30 days");
    expect(other.topics[2].detail).toContain("at least $25, or $750 for the Case tier");
    expect(other.topics[3].detail).toContain("costs 2.5% on top of the amount");
    expect(other.topics[4].detail).toContain("for a 1.5% fee on the amount used, at most $1,000 outstanding at a time");
    expect(other.topics[4].detail).toContain("waits 12 hours for you to add money");
    expect(other.topics[5].detail).toContain("after your hold time (12 hours)");
    // The old vocabulary is gone from the rules page.
    const whole = [intro.lede, ...intro.topics.flatMap((topic) => [topic.lead, topic.detail])].join(" ");
    expect(whole).not.toMatch(/single top-up limit|Never charge more than|step 5|floor|auto-reload|backstop/);
    // Exactly the enforced amounts are quoted: the two tier minimums (twice), the card fee (twice), the rewards rate, the advance fee and its cap, and the single-payment ceiling.
    expect(whole.match(/\$[\d,]*\d|\d+(?:\.\d+)?%/g)).toEqual(["$50", "$500", "$50", "$500", "3%", "1%", "$1", "1%", "$500", "3%", "$5,000"]);
    // With the program off, the rules page says nothing about rewards; without USDC on offer, the rule names the bank alone.
    const off = describeIntro({ cardFundingFeeBps: 300, usdcOffered: true, holdTimeoutMinutes: 2_880, limits: { ...limits, rewardsRateBankBps: 0, rewardsRateUsdcBps: 0, rewardsRateCardBps: 0 } });
    expect([off.lede, ...off.topics.flatMap((topic) => [topic.lead, topic.detail])].join(" ")).not.toMatch(/reward/i);
    expect(noUsdc.topics[3].detail).toContain(" A bank transfer earns 1% in rewards points when it lands; a card charge earns none.");
    expect(describeActivationTopUp({ cardFundingFeeBps: 300 })).toBe("Your first automatic top-up runs on the first daily check after you activate (about midnight UTC). Until it lands, orders are charged to your backup card at 3%. Adding money by card now avoids that.");
    expect(describeHoldTimeLine(120)).toContain("for orders held from now on");
    expect(describeHoldTimeLine(120)).toContain("We email you 2 hours before.");
    expect(describePendingBalance(25_000)).toBe("$250 on the way — a bank transfer takes up to 5 business days (our assumption) to land; this money cannot pay orders yet.");
    expect(describePendingBalance(25_000, advance({ headroomCents: 20_000 }))).toBe("$250 on the way — a bank transfer takes up to 5 business days (our assumption) to land; up to $200 of it can pay for orders now, for a 1% fee on the amount used.");
    expect(describePendingBalance(25_000, advance({ headroomCents: 40_000 }))).toContain("up to $250 of it can pay for orders now");
    expect(describePendingBalance(25_000, advance({ headroomCents: 0 }))).toContain("this money cannot pay orders yet.");
    expect(describeRoleGap("backupCard", { holdTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120 })).toContain("we email you 2 hours before");
    expect(describeRoleGap("backupCard", { holdTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120 })).not.toContain("ending in");
    expect(describeRoleGap("source", { holdTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120 })).toContain("Autopay source needed");
    expect(describeRoleGap("source", { holdTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120 })).toContain("Held orders are still covered by your backup card.");
  });

  it("says why a source is preselected, and claims a half-finished setup only when there is one", () => {
    const suggestion = { selected: CARD, draftSourceMethodId: null, suggestedSourceMethodId: 10, justAdded: false };
    // Nothing was chosen before: say what is true — it is already on the wallet — and name the other rail.
    expect(describeSourcePreselection(suggestion)).toBe("Visa ending in 4242 is already saved on your wallet, so we picked it — choose a bank account instead if you would rather.");
    expect(describeSourcePreselection({ ...suggestion, selected: BANK, suggestedSourceMethodId: 30 }))
      .toBe("Chase ending in 1234 is already saved on your wallet, so we picked it — choose a card instead if you would rather.");
    // A choice they really did make earlier.
    expect(describeSourcePreselection({ ...suggestion, draftSourceMethodId: 10 })).toBe("Pick up where you left off: Visa ending in 4242 is the source you chose earlier.");
    // Nothing to say: no selection, a method Stripe has just announced, or a selection that is neither.
    expect(describeSourcePreselection({ ...suggestion, selected: null })).toBeNull();
    expect(describeSourcePreselection({ ...suggestion, justAdded: true })).toBeNull();
    expect(describeSourcePreselection({ ...suggestion, suggestedSourceMethodId: 30 })).toBeNull();
    expect(describeSourcePreselection({ ...suggestion, draftSourceMethodId: 30 })).toBeNull();
  });

  it("never tells a seller to relink a bank account when no link reads a balance", () => {
    // The advance needs a balance read. When the platform asks for that
    // permission, "link it again" is a real fix for one account...
    expect(describeAdvanceReason("bank_balance_not_verified", true))
      .toBe("We could not read the account's balance when it was linked. Link it again through your bank to enable this.");

    // ...but when it asks for no balances at all, relinking can never work, so
    // sending a seller round that loop would be a lie.
    expect(describeAdvanceReason("bank_balance_not_verified", false))
      .toBe("Card Shellz is not reading bank balances right now, so this is unavailable for every seller. Nothing for you to do.");

    // Every other reason is about that one account and reads the same either way.
    for (const reason of ["no_bank_account", "no_pending_credit", "account_holder_not_company", "first_pull_not_settled", "advance_cap_zero"] as const) {
      expect(describeAdvanceReason(reason, true)).toBe(describeAdvanceReason(reason, false));
    }
  });

  it("opens on the recommended bank rail and names a saved card instead of picking it", () => {
    // The page recommends the bank rail, so the bank rail is what it defaults to.
    expect(RECOMMENDED_SOURCE_RAIL).toBe("stripe_ach");
    // A card already on the wallet is offered by name, not chosen for the vendor.
    expect(describeSavedCardAlternative({ rail: "stripe_ach", selected: null, cards: [CARD] }))
      .toBe("Visa ending in 4242 is already saved. Choose Card to use it, or add a bank account and pay no fees.");
    // Nothing to offer: no card saved, the vendor is already on the card rail,
    // or something is selected, so the card is on screen either way.
    expect(describeSavedCardAlternative({ rail: "stripe_ach", selected: null, cards: [] })).toBeNull();
    expect(describeSavedCardAlternative({ rail: "stripe_card", selected: null, cards: [CARD] })).toBeNull();
    expect(describeSavedCardAlternative({ rail: "stripe_ach", selected: BANK, cards: [CARD] })).toBeNull();
  });

  it("preselects a saved bank account but never a saved card", () => {
    // A bank is both recommended and free, so it is chosen for the vendor.
    expect(derive(wallet({ fundingMethods: [BANK] }), started())).toMatchObject({ suggestedSourceMethodId: 30 });
    expect(derive(wallet({ fundingMethods: [CARD, BANK] }), started())).toMatchObject({ suggestedSourceMethodId: 30 });
    // A card alone leaves the picker on the bank rail with nothing selected, so
    // the vendor chooses the fee deliberately rather than inheriting it.
    expect(derive(wallet({ fundingMethods: [CARD] }), started())).toMatchObject({ suggestedSourceMethodId: null });
    // An explicit choice still wins over the default.
    expect(derive(wallet({ fundingMethods: [CARD] }), started({ sourceMethodId: 10 })))
      .toMatchObject({ source: { rail: "stripe_card", method: CARD }, suggestedSourceMethodId: null });
  });

  it("labels methods and ledger reasons", () => {
    expect(describeFundingMethod(CARD)).toBe("Visa ending in 4242");
    expect(describeFundingMethodDetailed(CARD)).toBe("Visa ending in 4242 · expires 12/27");
    expect(describeFundingMethodDetailed(BANK)).toBe("Chase ending in 1234 · checking");
    expect(describeFundingMethodDetailed(method({ fundingMethodId: 12, card: { brand: "Visa", last4: "4242", expMonth: null, expYear: null } }))).toBe("Visa ending in 4242");
    expect(describeFundingMethod(method({ fundingMethodId: 20, rail: "usdc_base", usdcWalletAddress: "0x1234567890abcdef1234567890abcdef12345678" }))).toBe("USDC · 0x1234…5678");
    expect(describeFundingMethod(method({ fundingMethodId: 13, card: null, displayLabel: "My card" }))).toBe("My card");
    expect(Object.keys(LEDGER_REASON_LABELS)).toHaveLength(20);
    expect(LEDGER_REASON_LABELS.rewards_earned).toBe("Rewards earned");
    expect(LEDGER_REASON_LABELS.rewards_spent).toBe("Rewards used on an order");
    expect(LEDGER_REASON_LABELS.covered_held_order).toBe("Covered a held order");
    expect(LEDGER_REASON_LABELS.advance_fee).toBe("Fee for paying an order from money on its way");
    expect(LEDGER_REASON_LABELS.funding_reversed).toBe("Payment reversed by your bank");
    expect(LEDGER_REASON_LABELS.funding_reinstated).toBe("Reversed payment returned");
  });
});

function advance(overrides: Partial<import("../dropship-wallet-view-adapter").WalletAdvance> = {}): import("../dropship-wallet-view-adapter").WalletAdvance {
  return {
    policy: { feeBps: 100, capCents: 50_000, capSource: "policy" },
    sources: [{ fundingMethodId: 30, pendingCents: 25_000, accountHolderType: "company", balanceVerified: true, priorPullSettled: true, eligible: true, reasons: [] }],
    eligiblePendingCents: 25_000,
    allowanceCents: 25_000,
    exposureCents: 0,
    headroomCents: 25_000,
    reasons: [],
    ...overrides,
  };
}

describe("advance copy (funding design phase 3)", () => {
  it("names each missing fact in the vendor's words", () => {
    expect(describeAdvanceReason("no_bank_account")).toBe("Add a bank account: the advance applies to bank transfers only.");
    expect(describeAdvanceReason("no_pending_credit")).toBe("No bank transfer is on its way right now.");
    expect(describeAdvanceReason("account_holder_not_company")).toBe("The bank account has to be a business account.");
    expect(describeAdvanceReason("bank_balance_not_verified")).toBe("We could not read the account's balance when it was linked. Link it again through your bank to enable this.");
    expect(describeAdvanceReason("first_pull_not_settled")).toBe("One earlier transfer from this account has to land first.");
    expect(describeAdvanceReason("advance_cap_zero")).toBe("Card Shellz has set your advance limit to $0.");
  });

  it("states the headroom, the exhausted allowance, or the reasons, always with the terms", () => {
    expect(describeAdvanceStanding(advance({ headroomCents: 20_000 }))).toEqual({
      headline: "Up to $200 of money on its way can pay for orders now.",
      details: ["Fee 1% on the amount used; at most $500 outstanding at a time."],
    });
    expect(describeAdvanceStanding(advance({ headroomCents: 0, exposureCents: 25_000 }))).toEqual({
      headline: "Orders have already used $250 of money on its way; nothing more until it lands.",
      details: ["Fee 1% on the amount used; at most $500 outstanding at a time."],
    });
    expect(describeAdvanceStanding(advance({ headroomCents: 0, allowanceCents: 0, eligiblePendingCents: 0, sources: [], reasons: ["no_bank_account"] }))).toEqual({
      headline: "No money on its way can pay for orders yet.",
      details: ["Add a bank account: the advance applies to bank transfers only.", "Fee 1% on the amount used; at most $500 outstanding at a time."],
    });
  });

  it("explains a negative balance by what caused it", () => {
    const base = { limitCents: 50_000, cardFundingFeeBps: 300 };
    expect(describeNegativeBalance({ ...base, availableCents: -30_300, advance: advance({ eligiblePendingCents: 50_000 }) }))
      .toBe("$303 below zero — $303 of it was paid from a bank transfer still on its way and clears when that lands. If the transfer is returned instead, the amount is collected by your next top-up.");
    expect(describeNegativeBalance({ ...base, availableCents: -30_300, advance: advance({ eligiblePendingCents: 10_000 }) }))
      .toContain("$100 of it was paid from a bank transfer still on its way");
    expect(describeNegativeBalance({ ...base, availableCents: -1_250, advance: null }))
      .toBe("$12.50 below zero — a return fee or a returned transfer took the balance below zero. Your next top-up covers it, up to $500 in one charge; anything beyond that is collected over the following daily checks. Until then, a backup-card charge for an order includes this shortfall (order plus the amount below zero, plus 3%).");
  });
});

describe("USDC deposits in the wallet's words (funding design phase 6)", () => {
  const limits: WalletLimits = { autoReloadMinTriggerCents: 5_000, autoReloadMinAmountCents: 10_000, manualFundingMinCents: 1_000, manualFundingMaxCents: 500_000, cardFundingMinCents: 10_000, rewardsRateBankBps: 100, rewardsRateUsdcBps: 100, rewardsRateCardBps: 0, rewardsExpiryDays: null, defaultPaymentHoldTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120, caseTierMinimumCents: 50_000, advanceFeeBps: 100, advanceCapCents: 50_000, tierChangeGraceDays: 14, bankBalanceReadOffered: false };
  const watched: WalletUsdcDeposit = { offered: true, watched: true, chainId: 8453, tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", minConfirmations: 6, settleTag: "safe", address: null };
  const unwatched: WalletUsdcDeposit = { ...watched, watched: false };
  const notOffered: WalletUsdcDeposit = { ...watched, offered: false, watched: false };

  it("says only what the watcher enforces in the intro: confirmations to show, the safe head to settle", () => {
    const base = { cardFundingFeeBps: 300, usdcOffered: true, holdTimeoutMinutes: 2_880, limits };
    expect(describeIntro({ ...base, usdcDeposit: watched }).topics[3].detail).toContain(" USDC on Base costs nothing: a transfer to your own deposit address shows in your wallet after 6 confirmations and is available once the network settles it." + REWARDS_RULE);
    expect(describeIntro({ ...base, usdcDeposit: { ...watched, minConfirmations: 1 } }).topics[3].detail).toContain("after 1 confirmation and");
    expect(describeIntro({ ...base, usdcDeposit: unwatched }).topics[3].detail).toContain(" USDC on Base costs nothing; a member of our team credits a transfer to your own deposit address after confirming it." + REWARDS_RULE);
    // Only the shared address: the old sentence, and nothing about timing.
    expect(describeIntro({ ...base, usdcDeposit: null }).topics[3].detail).toContain(" USDC costs nothing." + REWARDS_RULE);
    expect(describeIntro({ ...base, usdcDeposit: notOffered }).topics[3].detail).toContain(" USDC costs nothing." + REWARDS_RULE);
    expect(describeIntro({ ...base, usdcOffered: false, usdcDeposit: notOffered }).topics[3].detail).not.toContain("USDC");
    expect(describeUsdcIntroSentence(null, false)).toBe("");
  });

  it("offers USDC when the vendor can be handed an address or a shared one exists", () => {
    expect(usdcOfferedFor({ usdcDeposit: watched, usdcBaseDepositAddress: null })).toBe(true);
    expect(usdcOfferedFor({ usdcDeposit: null, usdcBaseDepositAddress: "0x1111111111111111111111111111111111111111" })).toBe(true);
    expect(usdcOfferedFor({ usdcDeposit: notOffered, usdcBaseDepositAddress: null })).toBe(false);
    expect(usdcOfferedFor({ usdcDeposit: null, usdcBaseDepositAddress: null })).toBe(false);
  });

  it("words the deposit panel: the watcher's timing or the manual credit, and the one warning that matters", () => {
    expect(describeUsdcDeposit(watched)).toEqual({
      timing: "No fee. A transfer shows in your wallet after 6 confirmations and is available for orders once the network settles it — usually within a few minutes (our estimate).",
      warning: "Send only USDC on the Base network to this address. Anything else sent here cannot be recovered.",
    });
    expect(describeUsdcDeposit(unwatched).timing).toBe("No fee. A member of the Card Shellz team credits your wallet after confirming the transfer — this is not instant.");
  });

  it("explains on the source step why USDC can never be the autopay source, in each mode", () => {
    expect(describeUsdcSourceNote(watched)).toBe("Prefer USDC? It costs nothing: send USDC on Base to your own deposit address under Add money and it lands in your wallet on its own. It cannot be pulled, so it can never be your autopay source.");
    expect(describeUsdcSourceNote(unwatched)).toContain("a member of our team credits your wallet after confirming the transfer");
    expect(describeUsdcSourceNote(null)).toContain("Card Shellz's deposit address");
    expect(describeUsdcSourceNote(notOffered)).toContain("Card Shellz's deposit address");
  });
});

describe("the minimum: two tier options", () => {
  const onSale = { tier: "pack" as const, eligible: true, reason: null, minimumCents: 5_000, shortfallCents: 0, upcoming: null };
  const casesOnSale = { pack: onSale, case: { ...onSale, tier: "case" as const, minimumCents: 50_000 }, generatedAt: STAMP };
  const casesOffSale = { ...casesOnSale, case: { ...casesOnSale.case, eligible: false, reason: "case_tier_balance_below_minimum" as const, shortfallCents: 38_000 } };

  it("offers the pack and case minimums the policy serves, and only the pack one when the policy makes them equal", () => {
    expect(minimumOptions(LIMITS)).toEqual([{ tier: "pack", cents: 5_000 }, { tier: "case", cents: 50_000 }]);
    expect(minimumOptions({ autoReloadMinTriggerCents: 50_000, caseTierMinimumCents: 50_000 })).toEqual([{ tier: "pack", cents: 50_000 }]);
    expect(minimumOptions({ autoReloadMinTriggerCents: 60_000, caseTierMinimumCents: 50_000 })).toEqual([{ tier: "pack", cents: 60_000 }]);
    expect(describeMinimumOption("pack")).toBe("Pack tier: singles, packs and inner packs");
    expect(describeMinimumOption("case")).toBe("Case tier: adds cases");
  });

  it("reads any saved amount as the tier it falls in", () => {
    expect(minimumOptionFor(25_000, LIMITS)).toBe(5_000);
    expect(minimumOptionFor(5_000, LIMITS)).toBe(5_000);
    expect(minimumOptionFor(0, LIMITS)).toBe(5_000);
    expect(minimumOptionFor(50_000, LIMITS)).toBe(50_000);
    expect(minimumOptionFor(100_000, LIMITS)).toBe(50_000);
    expect(minimumOptionFor(100_000, { autoReloadMinTriggerCents: 50_000, caseTierMinimumCents: 50_000 })).toBe(50_000);
    expect(() => minimumOptionFor(-1, LIMITS)).toThrow(RangeError);
    expect(() => minimumOptionFor(1.5, LIMITS)).toThrow(RangeError);
  });

  it("opens on the case minimum only while the vendor's cases are on sale", () => {
    expect(defaultMinimumCents(wallet())).toBe(5_000);
    expect(defaultMinimumCents(wallet({ listingTiers: casesOffSale }))).toBe(5_000);
    expect(defaultMinimumCents(wallet({ listingTiers: casesOnSale }))).toBe(50_000);
    // A policy with one option has nothing higher to open on.
    expect(defaultMinimumCents({ limits: { ...LIMITS, autoReloadMinTriggerCents: 50_000 }, listingTiers: casesOnSale })).toBe(50_000);
  });
});

describe("the top-up amount's quick picks", () => {
  it("offers the minimum and its 2×, 3× and 5× multiples, dropping a multiple under the policy's smallest top-up", () => {
    expect(topUpOptions(10_000, LIMITS)).toEqual([
      { factor: 1, cents: 10_000 }, { factor: 2, cents: 20_000 }, { factor: 3, cents: 30_000 }, { factor: 5, cents: 50_000 },
    ]);
    // LIMITS' smallest top-up is $100: at a $50 minimum only 2× and above clear it.
    expect(topUpOptions(5_000, LIMITS)).toEqual([{ factor: 1, cents: 5_000 }, { factor: 2, cents: 10_000 }, { factor: 3, cents: 15_000 }, { factor: 5, cents: 25_000 }]);
    expect(topUpOptions(2_000, LIMITS)).toEqual([{ factor: 1, cents: 2_000 }, { factor: 5, cents: 10_000 }]);
    expect(describeTopUpOption({ factor: 1, cents: 10_000 })).toBe("Your reserve");
    expect(describeTopUpOption({ factor: 2, cents: 20_000 })).toBe("2× your reserve");
    expect(describeTopUpOption({ factor: 5, cents: 50_000 })).toBe("5× your reserve");
    expect(() => topUpOptions(-1, LIMITS)).toThrow(RangeError);
  });

  it("reads a saved amount as the minimum, a multiple that will follow the minimum, or the vendor's own number", () => {
    expect(topUpChoiceFor(null, 10_000)).toEqual({ kind: "minimum" });
    expect(topUpChoiceFor(10_000, 10_000)).toEqual({ kind: "minimum" });
    expect(topUpChoiceFor(20_000, 10_000)).toEqual({ kind: "multiple", factor: 2 });
    expect(topUpChoiceFor(50_000, 10_000)).toEqual({ kind: "multiple", factor: 5 });
    expect(topUpChoiceFor(40_000, 10_000)).toEqual({ kind: "custom", cents: 40_000 });
    expect(topUpChoiceFor(20_000, 50_000)).toEqual({ kind: "custom", cents: 20_000 });
    expect(() => topUpChoiceFor(-1, 10_000)).toThrow(RangeError);
    expect(() => topUpChoiceFor(null, 1.5)).toThrow(RangeError);
  });

  it("sends null for the minimum and the recomputed amount for a multiple, so the pick follows a changed minimum", () => {
    expect(topUpCentsFor({ kind: "minimum" }, 10_000)).toBeNull();
    expect(topUpCentsFor({ kind: "multiple", factor: 2 }, 10_000)).toBe(20_000);
    expect(topUpCentsFor({ kind: "multiple", factor: 2 }, 50_000)).toBe(100_000);
    expect(topUpCentsFor({ kind: "custom", cents: 80_000 }, 50_000)).toBe(80_000);
    expect(() => topUpCentsFor({ kind: "minimum" }, -1)).toThrow(RangeError);
  });
});

describe("adding money: the top-up step's picks again", () => {
  it("offers the minimum, its multiples and the vendor's own top-up amount, within the manual funding limits", () => {
    expect(depositOptions({ minimumCents: 10_000, topUpCents: null, limits: LIMITS, rail: "stripe_ach" })).toEqual([
      { factor: 1, cents: 10_000 }, { factor: 2, cents: 20_000 }, { factor: 3, cents: 30_000 }, { factor: 5, cents: 50_000 },
    ]);
    // A top-up amount that is already a pick is not offered twice; one of the vendor's own takes its place in the order.
    expect(depositOptions({ minimumCents: 10_000, topUpCents: 20_000, limits: LIMITS, rail: "stripe_ach" })).toEqual([
      { factor: 1, cents: 10_000 }, { factor: 2, cents: 20_000 }, { factor: 3, cents: 30_000 }, { factor: 5, cents: 50_000 },
    ]);
    expect(depositOptions({ minimumCents: 50_000, topUpCents: 80_000, limits: LIMITS, rail: "stripe_ach" })).toEqual([
      { factor: 1, cents: 50_000 }, { factor: null, cents: 80_000 }, { factor: 2, cents: 100_000 }, { factor: 3, cents: 150_000 }, { factor: 5, cents: 250_000 },
    ]);
    // LIMITS cap manual funding at $5,000: picks past it are left out, a minimum past it included.
    expect(depositOptions({ minimumCents: 200_000, topUpCents: null, limits: LIMITS, rail: "stripe_ach" })).toEqual([{ factor: 1, cents: 200_000 }, { factor: 2, cents: 400_000 }]);
    expect(depositOptions({ minimumCents: 600_000, topUpCents: null, limits: LIMITS, rail: "stripe_ach" })).toEqual([]);
    // A multiple the top-up step hides (under LIMITS' $100 smallest top-up) stays hidden here.
    expect(depositOptions({ minimumCents: 2_000, topUpCents: null, limits: LIMITS, rail: "stripe_ach" })).toEqual([{ factor: 1, cents: 2_000 }, { factor: 5, cents: 10_000 }]);
    expect(() => depositOptions({ minimumCents: 10_000, topUpCents: -1, limits: LIMITS, rail: "stripe_ach" })).toThrow(RangeError);
    expect(describeDepositOption({ factor: 1, cents: 10_000 })).toBe("Your reserve");
    expect(describeDepositOption({ factor: 3, cents: 30_000 })).toBe("3× your reserve");
    expect(describeDepositOption({ factor: null, cents: 80_000 })).toBe("Your top-up amount");
  });

  it("opens on what autopay would pull next, else the minimum, else the smallest pick, and on nothing when nothing is offered", () => {
    const options = depositOptions({ minimumCents: 50_000, topUpCents: 80_000, limits: LIMITS, rail: "stripe_ach" });
    expect(depositDefaultCents(options, 80_000)).toBe(80_000);
    expect(depositDefaultCents(options, 50_000)).toBe(50_000);
    // The next top-up is not a pick (a shortfall past the minimum): the minimum.
    expect(depositDefaultCents(options, 70_000)).toBe(50_000);
    expect(depositDefaultCents([{ factor: 2, cents: 20_000 }, { factor: 5, cents: 50_000 }], 70_000)).toBe(20_000);
    expect(depositDefaultCents([], 10_000)).toBeNull();
    expect(() => depositDefaultCents(options, 1.5)).toThrow(RangeError);
  });
});

/** The rewards rule as the rules page states it at the launch rates with USDC on offer. */
const REWARDS_RULE = " Bank and USDC transfers earn 1% in rewards points when they land; a card charge earns none. 100 points are worth $1 on your orders. Points are used only on your orders here: they pay before your cash unless you untick \"Use my points on my orders\" in Wallet, which saves them up. New points do not expire. They are not cash: they cannot be paid out, do not count toward your reserve, and a payment your bank takes back takes its points back too.";

describe("rewards in the wallet's words (funding design phase 7)", () => {
  const rates = { rewardsRateBankBps: 100, rewardsRateUsdcBps: 100, rewardsRateCardBps: 0, rewardsExpiryDays: null };

  it("names what each way to pay earns, and when, only while some rail earns", () => {
    expect(describeRewardsEarning("stripe_ach", rates)).toBe("Earns 1% in rewards points once it lands.");
    expect(describeRewardsEarning("usdc_base", rates)).toBe("Earns 1% in rewards points once the transfer settles.");
    expect(describeRewardsEarning("stripe_card", rates)).toBe("Earns no rewards points.");
    expect(describeRewardsEarning("stripe_card", { ...rates, rewardsRateCardBps: 25 })).toBe("Earns 0.25% in rewards points, at once.");
    expect(describeRewardsEarning("stripe_ach", { ...rates, rewardsRateBankBps: 150 })).toBe("Earns 1.5% in rewards points once it lands.");
    const off = { rewardsRateBankBps: 0, rewardsRateUsdcBps: 0, rewardsRateCardBps: 0 };
    expect(rewardsOffered(off)).toBe(false);
    expect(describeRewardsEarning("stripe_ach", off)).toBeNull();
    expect(describeRewardsEarning("stripe_card", off)).toBeNull();
    // A rate that is not a whole, non-negative number of basis points is refused, never rendered.
    expect(() => describeRewardsEarning("stripe_ach", { ...rates, rewardsRateBankBps: -1 })).toThrow(RangeError);
    expect(() => describeRewardsEarning("stripe_ach", { ...rates, rewardsRateUsdcBps: 1.5 })).toThrow(RangeError);
  });

  it("states the rule from the served rates: one sentence when bank and USDC match, each named when they differ, USDC only where offered", () => {
    expect(describeRewardsRule(rates, true)).toBe(REWARDS_RULE);
    expect(describeRewardsRule(rates, false)).toContain(" A bank transfer earns 1% in rewards points when it lands; a card charge earns none.");
    expect(describeRewardsRule(rates, false)).not.toContain("USDC");
    expect(describeRewardsRule({ rewardsRateBankBps: 100, rewardsRateUsdcBps: 200, rewardsRateCardBps: 50, rewardsExpiryDays: null }, true))
      .toContain(" A bank transfer earns 1% in rewards points when it lands, a USDC transfer 2%; a card charge earns 0.5% at once.");
    // The rule never promises auto-apply: it is the vendor's choice, and saving is what happens until they make it.
    expect(describeRewardsRule(rates, true)).toContain("unless you untick \"Use my points on my orders\" in Wallet, which saves them up.");
    expect(describeRewardsRule({ rewardsRateBankBps: 0, rewardsRateUsdcBps: 0, rewardsRateCardBps: 0, rewardsExpiryDays: 90 }, true)).toBe("");
  });

  it("states the expiry for points earned from now on: never at launch, or the days staff set", () => {
    expect(describeRewardsExpiryRule(null)).toBe("New points do not expire.");
    expect(describeRewardsExpiryRule(365)).toBe("New points expire 365 days after they are earned, and the points closest to expiring are used first.");
    expect(describeRewardsExpiryRule(1)).toBe("New points expire 1 day after they are earned, and the points closest to expiring are used first.");
    expect(describeRewardsExpiryRule(3_650)).toContain("expire 3,650 days after");
    expect(describeRewardsRule({ ...rates, rewardsExpiryDays: 90 }, true))
      .toContain("which saves them up. New points expire 90 days after they are earned, and the points closest to expiring are used first. They are not cash");
    // A setting outside the server's bound is refused, never rendered.
    for (const bad of [0, 3_651, 1.5, -1]) {
      expect(() => describeRewardsExpiryRule(bad)).toThrow(RangeError);
    }
  });

  it("names the soonest points to expire under the figure, in the viewer's calendar, or nothing when none are set to", () => {
    const now = new Date("2026-09-25T12:00:00.000Z");
    expect(describeRewardsNextExpiry(null, { now })).toBeNull();
    expect(describeRewardsNextExpiry({ expiresAt: "2026-12-01T15:00:00.000Z", cents: 1_250 }, { now, timeZone: "UTC" }))
      .toBe("1,250 points ($12.50) expire on December 1, 2026.");
    expect(describeRewardsNextExpiry({ expiresAt: "2026-12-01T15:00:00.000Z", cents: 1 }, { now, timeZone: "UTC" }))
      .toBe("1 point ($0.01) expires on December 1, 2026.");
    // The date is the viewer's own: early on December 1 in UTC is still November 30 in Los Angeles.
    expect(describeRewardsNextExpiry({ expiresAt: "2026-12-01T03:00:00.000Z", cents: 500 }, { now, timeZone: "America/Los_Angeles" }))
      .toBe("500 points ($5.00) expire on November 30, 2026.");
    // Past its instant but not yet removed by the wallet run: said as it is, never as a date still ahead.
    expect(describeRewardsNextExpiry({ expiresAt: "2026-09-25T11:00:00.000Z", cents: 500 }, { now, timeZone: "UTC" }))
      .toBe("500 points ($5.00) reached their expiry date on September 25, 2026 and are being removed.");
    expect(describeRewardsNextExpiry({ expiresAt: "2026-09-25T12:00:00.000Z", cents: 1 }, { now, timeZone: "UTC" }))
      .toBe("1 point ($0.01) reached its expiry date on September 25, 2026 and is being removed.");
    expect(() => describeRewardsNextExpiry({ expiresAt: "2026-12-01T15:00:00.000Z", cents: 0 }, { now })).toThrow(RangeError);
    expect(() => describeRewardsNextExpiry({ expiresAt: "not a date", cents: 5 }, { now })).toThrow(RangeError);
  });

  it("labels expired points in the activity list in points, against the rewards balance", () => {
    expect(LEDGER_REASON_LABELS.rewards_expired).toBe("Rewards expired");
    expect(describeLedgerAmount({ reason: "rewards_expired", amountCents: -500 })).toBe("−500 points");
    expect(ledgerBalanceAfter({ reason: "rewards_expired", availableBalanceAfterCents: 40_000, rewardsBalanceAfterCents: 250 })).toEqual({ balance: "rewards", cents: 250 });
  });

  it("reads the points box as on unless the vendor unticked it: no choice yet is the default, on", () => {
    expect(rewardsApplyToOrders(null)).toBe(true);
    expect(rewardsApplyToOrders(true)).toBe(true);
    expect(rewardsApplyToOrders(false)).toBe(false);
  });

  it("words the line under the box for each state, and for no choice yet, which applies", () => {
    expect(describeRewardsUse(null)).toBe("Your points pay for your next orders before your cash. 100 points are worth $1 on your orders.");
    expect(describeRewardsUse(true)).toBe("Your points pay for your next orders before your cash. 100 points are worth $1 on your orders.");
    expect(describeRewardsUse(false)).toBe("Saved up: your cash pays for orders. Tick the box to use your points on your orders. 100 points are worth $1 on your orders.");
    // The request is the box itself: true uses points on orders, false saves them; nothing is turned round.
    expect(buildRewardsPreferenceInput(true)).toEqual({ spendRewardsFirst: true });
    expect(buildRewardsPreferenceInput(false)).toEqual({ spendRewardsFirst: false });
    expect(describeRewardsPreferenceSaved(true)).toBe("Saved. Your points pay for your orders before your cash.");
    expect(describeRewardsPreferenceSaved(false)).toBe("Saved. Your points are kept; your cash pays for orders.");
  });

  it("shows points at 100 per dollar with the value beside, and activity amounts in the row's own unit", () => {
    expect(describeRewardsBalance(1_250)).toEqual({ points: "1,250 points", value: "$12.50" });
    expect(describeRewardsBalance(0)).toEqual({ points: "0 points", value: "$0.00" });
    expect(describeRewardsBalance(1)).toEqual({ points: "1 point", value: "$0.01" });
    expect(describeLedgerAmount({ reason: "rewards_earned", amountCents: 1_500 })).toBe("1,500 points");
    expect(describeLedgerAmount({ reason: "rewards_spent", amountCents: -250 })).toBe("−250 points");
    expect(describeLedgerAmount({ reason: "manual_top_up", amountCents: 25_000 })).toBe("$250.00");
    expect(describeLedgerAmount({ reason: "order", amountCents: -9_500 })).toBe("−$95.00");
    expect(() => describeRewardsBalance(1.5)).toThrow(RangeError);
  });

  it("points an activity row's balance-after figure at the balance the row moved", () => {
    expect(ledgerBalanceAfter({ reason: "rewards_earned", availableBalanceAfterCents: 40_000, rewardsBalanceAfterCents: 400 })).toEqual({ balance: "rewards", cents: 400 });
    expect(ledgerBalanceAfter({ reason: "rewards_spent", availableBalanceAfterCents: 40_000, rewardsBalanceAfterCents: 0 })).toEqual({ balance: "rewards", cents: 0 });
    expect(ledgerBalanceAfter({ reason: "manual_top_up", availableBalanceAfterCents: 40_000, rewardsBalanceAfterCents: 400 })).toEqual({ balance: "cash", cents: 40_000 });
    expect(ledgerBalanceAfter({ reason: "order", availableBalanceAfterCents: -500, rewardsBalanceAfterCents: null })).toEqual({ balance: "cash", cents: -500 });
    // A row that never recorded the balance it moved shows nothing rather than the other balance.
    expect(ledgerBalanceAfter({ reason: "rewards_reversed", availableBalanceAfterCents: 40_000, rewardsBalanceAfterCents: null })).toBeNull();
    expect(ledgerBalanceAfter({ reason: "return_fee", availableBalanceAfterCents: null, rewardsBalanceAfterCents: 400 })).toBeNull();
    expect([...REWARDS_LEDGER_REASONS].sort()).toEqual(["rewards_earned", "rewards_expired", "rewards_reinstated", "rewards_reversed", "rewards_spent"]);
  });
});

describe("the add-money step's terms per way to pay", () => {
  const rates = { rewardsRateBankBps: 100, rewardsRateUsdcBps: 100, rewardsRateCardBps: 0 };
  const bank = { rail: "stripe_ach" as const, cardFundingFeeBps: 300, backupLabel: "Visa ending in 4242", cardMinimumCents: 10_000, bankFundingMethodId: 30, advance: null, rewardsRates: rates };

  it("lists a card's fee and that the money is available at once; a zero fee reads as none", () => {
    expect(describeDepositRail({ ...bank, rail: "stripe_card" })).toEqual(["Card fee: 3% on top of the amount.", "Deposits of $100 or more.", "Available at once.", "Earns no rewards points."]);
    expect(describeDepositRail({ ...bank, rail: "stripe_card", cardFundingFeeBps: 0 })).toEqual(["No fee.", "Deposits of $100 or more.", "Available at once.", "Earns no rewards points."]);
    // A card rate says what a card earns; with the program off, no bullet mentions rewards at all.
    expect(describeDepositRail({ ...bank, rail: "stripe_card", rewardsRates: { ...rates, rewardsRateCardBps: 50 } })[3]).toBe("Earns 0.5% in rewards points, at once.");
    expect(describeDepositRail({ ...bank, rail: "stripe_card", rewardsRates: { rewardsRateBankBps: 0, rewardsRateUsdcBps: 0, rewardsRateCardBps: 0 } })).toHaveLength(3);
  });

  it("lists a bank transfer's fee, landing time, credit and backup-card terms without an advance position", () => {
    expect(describeDepositRail({ ...bank, advance: null })).toEqual([
      "No fee.",
      "Takes up to 5 business days (our assumption) to land, and counts toward your reserve as soon as it shows as on the way.",
      "Earns 1% in rewards points once it lands.",
      "A business bank account can qualify to pay for orders while a transfer is still on the way; a personal account pays only once the money lands.",
      "While it is on the way, an order it cannot pay for is charged to Visa ending in 4242 for the shortfall plus 3%.",
    ]);
    // A zero card fee drops the fee clause rather than promising "plus 0%".
    expect(describeDepositRail({ ...bank, advance: null, cardFundingFeeBps: 0 })[4]).toBe("While it is on the way, an order it cannot pay for is charged to Visa ending in 4242 for the shortfall.");
    // A bank rate of zero while the card earns: the bullet says so; the program off: no bullet.
    expect(describeDepositRail({ ...bank, advance: null, rewardsRates: { rewardsRateBankBps: 0, rewardsRateUsdcBps: 0, rewardsRateCardBps: 100 } })[2]).toBe("Earns no rewards points.");
    expect(describeDepositRail({ ...bank, advance: null, rewardsRates: { rewardsRateBankBps: 0, rewardsRateUsdcBps: 0, rewardsRateCardBps: 0 } })).toHaveLength(4);
  });

  it("words the credit sentence from the account's three facts, not from the eligibility flag", () => {
    const source = advance().sources[0];
    // Company, balance read, one transfer landed: qualifies (even when nothing is on the way right now).
    expect(describeDepositRail({ ...bank, advance: advance({ sources: [{ ...source, pendingCents: 0, eligible: false, reasons: ["no_pending_credit"] }] }) })[3])
      .toBe("This business account qualifies: money still on its way from it can pay for orders, for a 1% fee on the amount used, up to $500 at a time.");
    expect(describeDepositRail({ ...bank, advance: advance({ sources: [{ ...source, priorPullSettled: false, eligible: false, reasons: ["first_pull_not_settled"] }] }) })[3])
      .toBe("This is a business account: once one transfer from it has landed, later transfers can pay for orders while still on the way, for a 1% fee on the amount used, up to $500 at a time.");
    expect(describeDepositRail({ ...bank, advance: advance({ sources: [{ ...source, balanceVerified: false, eligible: false, reasons: ["bank_balance_not_verified"] }] }) })[3])
      .toBe("This is a business account, but we could not read its balance when it was linked, so money on its way from it pays for orders only once it lands.");
    expect(describeDepositRail({ ...bank, advance: advance({ sources: [{ ...source, accountHolderType: "individual", eligible: false, reasons: ["account_holder_not_company"] }] }) })[3])
      .toBe("This is a personal account: money on its way from it pays for orders only once it lands.");
    // The vendor's override terms are the ones quoted.
    expect(describeDepositRail({ ...bank, advance: advance({ policy: { feeBps: 150, capCents: 100_000, capSource: "vendor_override" } }) })[3])
      .toBe("This business account qualifies: money still on its way from it can pay for orders, for a 1.5% fee on the amount used, up to $1,000 at a time.");
  });

  it("falls back to the general rule when the account is unknown, and to none at all when the cap is zero", () => {
    const general = "A business account can qualify to pay for orders while a transfer is still on the way — a balance we could read when it was linked, and one earlier transfer from it landed — for a 1% fee on the amount used, up to $500 at a time. A personal account pays only once the money lands.";
    expect(describeDepositRail({ ...bank, bankFundingMethodId: null, advance: advance() })[3]).toBe(general);
    expect(describeDepositRail({ ...bank, bankFundingMethodId: 99, advance: advance() })[3]).toBe(general);
    expect(describeDepositRail({ ...bank, advance: advance({ sources: [{ ...advance().sources[0], accountHolderType: null }] }) })[3]).toBe(general);
    expect(describeDepositRail({ ...bank, advance: advance({ policy: { feeBps: 100, capCents: 0, capSource: "vendor_override" } }) })[3]).toBe("Money on its way cannot pay for orders until it lands.");
  });
});

describe("no card fee (funding design phase 7)", () => {
  const free: WalletTerms = { sourceRail: "stripe_ach", sourceLabel: "Chase ending in 1234", backupLabel: "Visa ending in 4242", floorCents: 25_000, topUpCents: null, limitCents: 50_000, chargeCeilingCents: 500_000, holdTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120, cardFundingFeeBps: 0 };

  it("words the fee helpers as 'no fee' at zero and never as '0%'", () => {
    expect([describeCardFee(300), describeCardFee(0)]).toEqual(["3% fee", "no fee"]);
    expect([cardFeeNoun(250), cardFeeNoun(0)]).toEqual(["a 2.5% fee", "no fee"]);
    expect([cardFeeOnTop(300), cardFeeOnTop(0)]).toEqual([" plus 3%", ""]);
    expect([cardFeeAt(300), cardFeeAt(0)]).toEqual([" at 3%", " with no fee"]);
  });

  it("words the bank and card mandates, the plan sentence and the activation lines without a fee", () => {
    const bank = describeMandate(free);
    expect(bank[1]).toContain("the shortfall with no card fee, whatever its size (up to $5,000)");
    expect(bank[1]).toContain("a $75 order with $20 available charges $55.");
    expect(bank[5]).toContain("Card charges carry no fee today, and that is the rate you agree to for automatic top-ups and covers; if Card Shellz ever adds a fee, we ask you to confirm before charging one.");
    const card = describeMandate({ ...free, sourceRail: "stripe_card", sourceLabel: "Visa ending in 4242", floorCents: 10_000, limitCents: 25_000 });
    expect(card[0]).toBe("Charge Visa ending in 4242, with no fee, whenever an order takes your balance below your reserve of $100, and at the daily check: your top-up amount of $100 (your reserve), or more if that alone would not bring you back to $100.");
    expect(card[1]).toContain("is charged the shortfall, whatever its size (up to $5,000), and goes out at once; the next routine top-up then brings the balance back to $100 (no fee)");
    expect([...bank, ...card].join(" ")).not.toMatch(/0%|plus 0|\$0\.00 fee/);
    expect(describePlanSentence(free)).toBe("In one sentence: you keep a $250 reserve in your wallet; when an order takes it lower, autopay pulls $250 from your bank for free, and your Visa ending in 4242 covers any shortfall.");
    expect(describePlanSentence({ ...free, sourceRail: "stripe_card", sourceLabel: "Visa ending in 4242", floorCents: 10_000 })).toBe("In one sentence: you keep a $100 reserve in your wallet, topped up by $100 from your Visa ending in 4242 with no fee; the same card covers any shortfall.");
    expect(describeActivationTopUp({ cardFundingFeeBps: 0 })).toContain("orders are charged to your backup card with no fee.");
    expect(describeActivationQuote({ terms: { ...free, sourceRail: "stripe_card", sourceLabel: "Visa ending in 4242", floorCents: 10_000 }, availableCents: 0, pendingCents: 0 }))
      .toBe("Balance now $0, so the first daily check after you activate charges $100 to Visa ending in 4242 (no fee), landing at once.");
    expect(describeActivationQuote({ terms: free, availableCents: 0, pendingCents: 0 })).toContain("any shortfall goes to Visa ending in 4242 with no fee.");
    expect(describeNegativeBalance({ availableCents: -1_250, advance: null, limitCents: 50_000, cardFundingFeeBps: 0 })).toContain("(order plus the amount below zero).");
  });

  it("tells the rules page a card costs nothing and names the card minimum", () => {
    const intro = describeIntro({ cardFundingFeeBps: 0, usdcOffered: false, holdTimeoutMinutes: 1_440, limits: LIMITS });
    expect(intro.topics[3].detail).toContain("A card lands at once and costs nothing either; a card deposit is $100 or more.");
    expect(intro.topics[3].detail).not.toContain("0%");
  });

  it("says nothing about a fee cut and explains a raise as waiting on the vendor's word", () => {
    // The save still carries the recorded rate: the server accepts a record at or above the live rate.
    expect(acknowledgementForSave({ autoReload: { ...doneWallet().autoReload!, acknowledgedCardFeeBps: 300 }, cardFundingFeeBps: 0 }))
      .toEqual({ acknowledgedCardFeeBps: 300, saveLabel: "Save", feeChangeNote: null });
    expect(acknowledgementForSave({ autoReload: { ...doneWallet().autoReload!, acknowledgedCardFeeBps: null }, cardFundingFeeBps: 0 }).saveLabel).toBe("Save and accept the card terms (no fee)");
    expect(describeAcknowledgementBanner({ feeChange: { recordedBps: 300, currentBps: 0 }, onboarding: false }))
      .toBe("Please review and confirm your autopay terms. Nothing changes until you confirm.");
    expect(describeAcknowledgementBanner({ feeChange: { recordedBps: 0, currentBps: 200 }, onboarding: false }))
      .toBe("Card Shellz changed the card fee: card charges now carry a 2% fee (you agreed to no fee). Until you confirm, automatic top-ups and covers stay free; money you add yourself shows the current fee on Stripe's page before you pay.");
  });

  it("words the Authorization row without restating a rate that no longer applies", () => {
    const at = "Sep 22, 2026, 1:05 PM";
    expect(describeAuthorizationRecord({ acknowledgedAtLabel: null, recordedBps: 300, currentBps: 0 })).toBe("Not on record — confirm your terms above.");
    expect(describeAuthorizationRecord({ acknowledgedAtLabel: at, recordedBps: null, currentBps: 0 })).toBe("Not on record — confirm your terms above.");
    expect(describeAuthorizationRecord({ acknowledgedAtLabel: at, recordedBps: 300, currentBps: 300 }))
      .toBe("Recorded Sep 22, 2026, 1:05 PM with 3% fee on card charges. The terms above are the current terms.");
    expect(describeAuthorizationRecord({ acknowledgedAtLabel: at, recordedBps: 0, currentBps: 200 }))
      .toBe("Recorded Sep 22, 2026, 1:05 PM with no fee on card charges; card charges now carry a 2% fee — confirm the new terms above.");
    const cut = describeAuthorizationRecord({ acknowledgedAtLabel: at, recordedBps: 300, currentBps: 0 });
    expect(cut).toBe("Recorded Sep 22, 2026, 1:05 PM. Card charges carry no fee; the terms above are the current terms.");
    expect(cut).not.toContain("3%");
  });

  it("offers a card deposit only the picks at or above the card minimum", () => {
    expect(depositOptions({ minimumCents: 5_000, topUpCents: null, limits: LIMITS, rail: "stripe_ach" }).map((pick) => pick.cents)).toEqual([5_000, 10_000, 15_000, 25_000]);
    expect(depositOptions({ minimumCents: 5_000, topUpCents: null, limits: LIMITS, rail: "stripe_card" }).map((pick) => pick.cents)).toEqual([10_000, 15_000, 25_000]);
  });
});
