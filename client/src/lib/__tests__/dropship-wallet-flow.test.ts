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
  deriveWalletFlow,
  draftAfterBackupChoice,
  draftAfterFloorChoice,
  draftAfterIntro,
  draftAfterSourceChoice,
  draftAtStep,
  describeAcknowledgementBanner,
  describeActivationTopUp,
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
const LIMITS = { autoReloadMinTriggerCents: 5_000, autoReloadMinAmountCents: 10_000, manualFundingMinCents: 1_000, manualFundingMaxCents: 500_000, defaultPaymentHoldTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120, caseTierMinimumCents: 50_000, advanceFeeBps: 100, advanceCapCents: 50_000, tierChangeGraceDays: 14, bankBalanceReadOffered: false };

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
    account: { availableBalanceCents: 0, pendingBalanceCents: 0, currency: "USD", status: "active" },
    autoReload: null, fundingMethods: [], recentLedger: [], cardFundingFeeBps: 300, usdcBaseDepositAddress: null, usdcDeposit: null,
    limits: LIMITS, setupStatus: { sourceReady: false, backupReady: false, acknowledged: false, done: false, launchReady: false }, listingTiers: null, advance: null,
    clientFallbacks: [],
  };
  return { ...base, ...overrides };
}

function doneWallet(overrides: Partial<DropshipWalletView> = {}): DropshipWalletView {
  return wallet({
    autoReload: { autoReloadSettingId: 5, enabled: true, minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000, topUpAmountCents: null, paymentHoldTimeoutMinutes: 2_880, fundingMethodId: 30, updatedAt: STAMP, backstopFundingMethodId: 10, acknowledgedCardFeeBps: 300, acknowledgedAt: STAMP },
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
    expect(derive(wallet({ fundingMethods: [BANK] }), started({ sourceMethodId: 30 }))).toMatchObject({ step: "floor", floorCents: 25_000 });
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
    expect(derive(doneWallet({ account: { availableBalanceCents: 0, pendingBalanceCents: 25_000, currency: "USD", status: "active" } }), draft({ deposit: "pending" }))).toMatchObject({ mode: "manage" });
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
    const seed = wallet({ autoReload: { autoReloadSettingId: 1, enabled: true, minimumBalanceCents: 25_000, maxSingleReloadCents: null, topUpAmountCents: null, paymentHoldTimeoutMinutes: 2_880, fundingMethodId: null, updatedAt: STAMP, backstopFundingMethodId: null, acknowledgedCardFeeBps: null, acknowledgedAt: null } });
    expect(derive(seed)).toMatchObject({ authorized: false, feeRecordMissing: false, roleGaps: { backupCard: false, source: false }, canTurnOffAutoReload: false });
  });

  it("computes role gaps from roles and flows a negative balance through every branch", () => {
    const gone = doneWallet({ fundingMethods: [{ ...BANK, roles: { isAutoReloadSource: true, isBackupCard: false, chargeable: false } }] });
    expect(derive(gone, draft(), "active").roleGaps).toEqual({ backupCard: true, source: false });
    const sourceGone = doneWallet({ fundingMethods: [{ ...CARD, roles: { isAutoReloadSource: false, isBackupCard: true, chargeable: true } }] });
    expect(derive(sourceGone, draft(), "active").roleGaps).toEqual({ backupCard: false, source: true });
    const negative = { availableBalanceCents: -5_000, pendingBalanceCents: 0, currency: "USD", status: "active" };
    expect(() => derive(wallet({ account: negative }))).not.toThrow();
    expect(() => derive(doneWallet({ account: negative }), draft({ deposit: "pending" }))).not.toThrow();
  });

  it("derives the acknowledgement faces without overriding a server verdict", () => {
    const missing = doneWallet({ autoReload: { ...doneWallet().autoReload!, acknowledgedCardFeeBps: null, acknowledgedAt: null }, setupStatus: { ...doneWallet().setupStatus, acknowledged: false, launchReady: false } });
    expect(derive(missing)).toMatchObject({ needsAcknowledgement: true, feeRecordMissing: true, feeChange: null });
    const raised = doneWallet({ cardFundingFeeBps: 350, setupStatus: { ...doneWallet().setupStatus, acknowledged: false } });
    expect(derive(raised)).toMatchObject({ needsAcknowledgement: true, feeRecordMissing: false, feeChange: { recordedBps: 300, currentBps: 350 } });
    expect(derive(doneWallet())).toMatchObject({ needsAcknowledgement: false, feeChange: null });
    expect(derive(doneWallet({ cardFundingFeeBps: 350 })).needsAcknowledgement).toBe(false);
    expect(describeAcknowledgementBanner({ feeChange: null, onboarding: true })).toBe("Please review and confirm your autopay terms. Nothing changes until you confirm. You cannot activate until you do.");
    expect(describeAcknowledgementBanner({ feeChange: { recordedBps: 300, currentBps: 350 }, onboarding: false })).toContain("automatic top-ups and covers stay at 3%; money you add yourself shows the current fee on Stripe's page");
    expect(describeAcknowledgementBanner({ feeChange: { recordedBps: 300, currentBps: 250 }, onboarding: false })).toContain("Automatic charges already use the lower rate");
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
    expect(changed.feeChangeNote).toBe("The card fee is now 3.5% (you agreed to 3%). Automatic top-ups and covers stay at 3% until you confirm the new terms above; this save does not change that.");
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
    // Exactly what v1 wrote before `stepOverride`: it still parses, with no override and every choice intact.
    const legacy = { v: 1, seenIntro: true, sourceRail: "stripe_ach", sourceMethodId: 30, floorCents: 25_000, dailyCostCents: 2_000, backupMethodId: 10, pendingStripe: null, deposit: null };
    // A draft from before the top-up amount existed reads as "the minimum".
    expect(parseWalletDraft(JSON.stringify(legacy))).toEqual({ ...legacy, stepOverride: null, topUpCents: null });
    expect(parseWalletDraft(JSON.stringify({ ...legacy, stepOverride: "floor" }))).toMatchObject({ stepOverride: "floor", floorCents: 25_000, topUpCents: null });
    expect(parseWalletDraft(JSON.stringify({ ...legacy, stepOverride: "nowhere" }))).toEqual({ ...legacy, stepOverride: null, topUpCents: null });
    expect(parseWalletDraft(JSON.stringify({ ...legacy, stepOverride: 3 }))).toEqual({ ...legacy, stepOverride: null, topUpCents: null });
    expect(parseWalletDraft(JSON.stringify({ ...legacy, topUpCents: 40_000 }))).toMatchObject({ topUpCents: 40_000 });
  });

  it("falls back to an in-memory draft when storage throws", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
    expect(writeWalletDraft(storage, 1, draft({ dailyCostCents: 2_000 }))).toBe(true);
    expect(readWalletDraft(storage, 1)).toEqual({ draft: draft({ dailyCostCents: 2_000 }), storageFailed: false });
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
    expect(resolveStripeReturn(depositPending, wallet({ account: { availableBalanceCents: 0, pendingBalanceCents: 25_000, currency: "USD", status: "active" } }))).toEqual({ kind: "deposit_seen" });
    const ledgered = wallet({ recentLedger: [{ ledgerEntryId: 4, type: "funding", status: "pending", amountCents: 25_000, currency: "USD", availableBalanceAfterCents: 0, pendingBalanceAfterCents: 25_000, createdAt: STAMP, settledAt: null, reason: "manual_top_up", fundingMethodId: 30, cardFee: null, failure: null }] });
    expect(resolveStripeReturn(depositPending, ledgered)).toEqual({ kind: "deposit_seen" });
    const marked = buildPendingStripe({ rail: "stripe_ach", purpose: "deposit", wallet: ledgered, startedAt: NOW, expiresAt: null });
    expect(resolveStripeReturn(marked, ledgered)).toBeNull();
  });
});

describe("moving through the flow", () => {
  const reached = draft({ seenIntro: true, sourceRail: "stripe_ach", sourceMethodId: 30, floorCents: 25_000, dailyCostCents: 2_000, backupMethodId: 10, stepOverride: "source" });

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
    // Same method: the floor, the backup card and the daily cost all stand; only the override is released.
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
    expect(draftAfterFloorChoice(reached, 25_000, null, 2_000)).toEqual({ ...reached, stepOverride: null });
    expect(draftAfterFloorChoice(reached, 50_000, null, null)).toEqual({ ...reached, stepOverride: null, floorCents: 50_000, dailyCostCents: null });
    expect(draftAfterFloorChoice(reached, 50_000, 75_000, null)).toEqual({ ...reached, stepOverride: null, floorCents: 50_000, topUpCents: 75_000, dailyCostCents: null });
    expect(() => draftAfterFloorChoice(reached, -1, null, null)).toThrow(RangeError);
    expect(() => draftAfterFloorChoice(reached, 25_000.5, null, null)).toThrow(RangeError);
    expect(() => draftAfterFloorChoice(reached, 25_000, -1, null)).toThrow(RangeError);
    expect(() => draftAfterFloorChoice(reached, 25_000, null, -1)).toThrow(RangeError);
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
  const terms: WalletTerms = { sourceRail: "stripe_ach", sourceLabel: "Chase ending in 1234", backupLabel: "Visa ending in 4242", floorCents: 25_000, topUpCents: null, limitCents: 50_000, holdTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120, cardFundingFeeBps: 300 };

  it("words the bank mandate from the numbers: the minimum, the top-up amount and the bound", () => {
    const lines = describeMandate(terms);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("Debit Chase ending in 1234 whenever an order takes your balance below your minimum of $250, and at the daily check: your top-up amount of $250 (your minimum), or more if that alone would not bring you back to $250. No fee. Money already on its way counts, so the same gap is not debited twice.");
    expect(lines[1]).toContain("While your account is active, charge Visa ending in 4242 only when an order needs more than your available balance: the shortfall plus the 3% card fee, up to $500");
    expect(lines[1]).toContain("even while a bank top-up is still landing or your autopay source cannot be charged");
    expect(lines[1]).toContain("a $75 order with $20 available charges $55 + $1.65");
    expect(lines[1]).toContain("If a return fee has taken your balance below zero, the shortfall includes that amount.");
    expect(lines[2]).toBe("Never take more than $500 in one charge — the larger of your minimum and your top-up amount. An order needing more than your available balance plus $500 is not charged: it waits for you to add money and is cancelled if still unpaid after 48 hours. We email you 2 hours before that.");
    expect(lines[3]).toContain("first daily check after you activate (about midnight UTC)");
    expect(lines[3]).toContain("Adding money by card now avoids that");
    expect(lines[3]).toContain("debits Chase ending in 1234 for your top-up amount ($250), or more if that alone would not reach $250");
    expect(lines[4]).toContain("before it lands");
    expect(lines[4]).toContain("We do not retry");
    expect(lines[5]).toContain("autopay stays on; the source, minimum, top-up amount and backup card can be changed at any time in Wallet");
    expect(lines[5]).toContain("for automatic top-ups and covers");
    expect(lines[5]).toContain("shows the current fee on Stripe's page");
    const joined = lines.join(" ");
    expect(joined).not.toMatch(/refill|has been notified|single top-up limit|floor|auto-reload/);
    expect(describeMandate({ ...terms, holdExpiryWarningMinutes: 90 })[2]).toContain("1 hour 30 minutes");
    // A top-up amount the vendor chose is named as theirs, not as the minimum.
    const chosen = describeMandate({ ...terms, topUpCents: 40_000, limitCents: 40_000 });
    expect(chosen[0]).toContain("your top-up amount of $400, or more if that alone would not bring you back to $250");
    expect(chosen[2]).toContain("Never take more than $400 in one charge");
  });

  it("words the card mandate with the routine top-up's fee and the bank-return clause", () => {
    const lines = describeMandate({ ...terms, sourceRail: "stripe_card", sourceLabel: "Visa ending in 4242", floorCents: 10_000, limitCents: 25_000 });
    expect(lines[0]).toBe("Charge Visa ending in 4242, plus the 3% fee, whenever an order takes your balance below your minimum of $100, and at the daily check: your top-up amount of $100 (your minimum), or more if that alone would not bring you back to $100 ($100 + $3 = $103 for a routine top-up).");
    expect(lines[1]).toContain("Visa ending in 4242 is also your backup card");
    expect(lines[1]).toContain("(up to $250)");
    expect(lines[1]).toContain("If a return fee has taken your balance below zero, the shortfall includes that amount.");
    expect(lines[3]).toContain("charges Visa ending in 4242 your top-up amount ($100), or more if that alone would not reach $100");
    expect(lines[4]).toContain("or a bank transfer you started is returned before it lands");
    expect(describePlanSentence({ ...terms, sourceRail: "stripe_card", sourceLabel: "Visa ending in 4242", floorCents: 10_000 })).toBe("In one sentence: you keep $100 in your wallet, topped up by $100 from your Visa ending in 4242 at 3%; the same card covers any shortfall.");
    expect(describePlanSentence(terms)).toBe("In one sentence: you keep $250 in your wallet; when an order takes it lower, autopay pulls $250 from your bank for free, and your Visa ending in 4242 covers any shortfall plus 3%.");
    expect(describePlanSentence({ ...terms, topUpCents: 40_000 })).toContain("autopay pulls $400 from your bank for free");
  });

  it("pins the rules page: six topics, each a lead and its detail, quoting only the values the server enforces", () => {
    const limits: WalletLimits = { autoReloadMinTriggerCents: 5_000, autoReloadMinAmountCents: 10_000, manualFundingMinCents: 1_000, manualFundingMaxCents: 500_000, defaultPaymentHoldTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120, caseTierMinimumCents: 50_000, advanceFeeBps: 100, advanceCapCents: 50_000, tierChangeGraceDays: 14, bankBalanceReadOffered: false };
    const intro = describeIntro({ cardFundingFeeBps: 300, usdcOffered: true, holdTimeoutMinutes: 2_880, limits });
    expect(intro.lede).toBe("Your wallet is the deposit Card Shellz draws on for the orders you sell. Here is what it holds, what it lets you sell, how it stays funded, and what happens when a payment fails.");
    expect(intro.topics).toHaveLength(6);
    expect(intro.topics.map((topic) => topic.lead)).toEqual([
      "What your wallet is.",
      "What you can sell, and the minimum it needs.",
      "Keeping it funded: your minimum and autopay.",
      "Ways to pay, and what each costs.",
      "Orders while a transfer lands, and your backup card.",
      "If a payment fails or is taken back.",
    ]);
    expect(intro.topics[0].detail).toBe("A prepaid deposit Card Shellz holds for your store. Every order you accept is paid from it: the product cost plus shipping, with nothing added on top. A return fee comes out of it too, and so does a payment your bank takes back after it landed; either can take the balance below zero.");
    expect(intro.topics[1].detail).toBe("Singles, packs and inner packs are on sale while you keep at least $50 in your wallet. Cases are on sale once your balance, counting money on its way, has reached $500. If Card Shellz raises a minimum you keep selling for 14 days after the notice, then that tier comes off sale until you are back above it.");
    expect(intro.topics[2].detail).toBe("You choose the minimum you keep — at least $50, or $500 to sell cases. Whenever an order takes your balance below it, and at a daily check, autopay pulls a top-up from your bank account or card: your top-up amount, which is your minimum unless you set another, or more if that alone would not reach your minimum. Money already on its way counts, so the same gap is never pulled twice. Autopay never takes more than the larger of your minimum and your top-up amount in one charge. You can also add money yourself at any time.");
    expect(intro.topics[3].detail).toBe("A bank account costs nothing and takes up to 5 business days to land (our estimate). A card lands at once and costs 3% on top of the amount, whether autopay charged it, you added money yourself, or it covered an order. USDC costs nothing.");
    expect(intro.topics[4].detail).toBe("Money that has landed pays for orders first. A bank transfer still on its way can pay too, once the account it comes from qualifies — a business account, a balance we could read when it was linked, and one earlier transfer from it landed — for a 1% fee on the amount used, at most $500 outstanding at a time. If an order still needs more than your balance, we charge your backup card for the difference plus 3% and send the order out. An order the card cannot cover waits 48 hours for you to add money, then is cancelled.");
    expect(intro.topics[5].detail).toBe("Selling pauses: your listings show nothing for sale, and orders already waiting are cancelled after your hold time (48 hours). We email you, and we do not retry the charge ourselves. A payment your bank takes back after it landed is taken out of your wallet the same way. Selling starts again on its own once your balance is back at your minimum.");
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
    expect(other.topics[1].detail).toContain("at least $25 in your wallet. Cases are on sale once your balance, counting money on its way, has reached $750. If Card Shellz raises a minimum you keep selling for 30 days");
    expect(other.topics[2].detail).toContain("at least $25, or $750 to sell cases");
    expect(other.topics[3].detail).toContain("costs 2.5% on top of the amount");
    expect(other.topics[4].detail).toContain("for a 1.5% fee on the amount used, at most $1,000 outstanding at a time");
    expect(other.topics[4].detail).toContain("waits 12 hours for you to add money");
    expect(other.topics[5].detail).toContain("after your hold time (12 hours)");
    // The old vocabulary is gone from the rules page.
    const whole = [intro.lede, ...intro.topics.flatMap((topic) => [topic.lead, topic.detail])].join(" ");
    expect(whole).not.toMatch(/single top-up limit|Never charge more than|step 5|floor|auto-reload|backstop/);
    // Exactly the enforced amounts are quoted: the two tier minimums (twice), the card fee (twice), the advance fee and its cap.
    expect(whole.match(/\$[\d,]*\d|\d+(?:\.\d+)?%/g)).toEqual(["$50", "$500", "$50", "$500", "3%", "1%", "$500", "3%"]);
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
    expect(Object.keys(LEDGER_REASON_LABELS)).toHaveLength(15);
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
  const limits: WalletLimits = { autoReloadMinTriggerCents: 5_000, autoReloadMinAmountCents: 10_000, manualFundingMinCents: 1_000, manualFundingMaxCents: 500_000, defaultPaymentHoldTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120, caseTierMinimumCents: 50_000, advanceFeeBps: 100, advanceCapCents: 50_000, tierChangeGraceDays: 14, bankBalanceReadOffered: false };
  const watched: WalletUsdcDeposit = { offered: true, watched: true, chainId: 8453, tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", minConfirmations: 6, settleTag: "safe", address: null };
  const unwatched: WalletUsdcDeposit = { ...watched, watched: false };
  const notOffered: WalletUsdcDeposit = { ...watched, offered: false, watched: false };

  it("says only what the watcher enforces in the intro: confirmations to show, the safe head to settle", () => {
    const base = { cardFundingFeeBps: 300, usdcOffered: true, holdTimeoutMinutes: 2_880, limits };
    expect(describeIntro({ ...base, usdcDeposit: watched }).topics[3].detail).toMatch(/ USDC on Base costs nothing: a transfer to your own deposit address shows in your wallet after 6 confirmations and is available once the network settles it\.$/);
    expect(describeIntro({ ...base, usdcDeposit: { ...watched, minConfirmations: 1 } }).topics[3].detail).toContain("after 1 confirmation and");
    expect(describeIntro({ ...base, usdcDeposit: unwatched }).topics[3].detail).toMatch(/ USDC on Base costs nothing; a member of our team credits a transfer to your own deposit address after confirming it\.$/);
    // Only the shared address: the old sentence, and nothing about timing.
    expect(describeIntro({ ...base, usdcDeposit: null }).topics[3].detail).toMatch(/ USDC costs nothing\.$/);
    expect(describeIntro({ ...base, usdcDeposit: notOffered }).topics[3].detail).toMatch(/ USDC costs nothing\.$/);
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
