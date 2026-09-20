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
  describePendingBalance,
  describePlanSentence,
  describeRoleGap,
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
  resolveStripeReturn,
  STEP_ORDER,
  stripStripeReturn,
  walletStepNumber,
  walletStepState,
  writeWalletDraft,
  type WalletDraft,
  type WalletFlowStep,
  type WalletTerms,
} from "../dropship-wallet-flow";
import type { DropshipWalletView, WalletFundingMethod, WalletLimits } from "../dropship-wallet-view-adapter";

const STAMP = "2026-09-15T00:00:00.000Z";
const LATER = "2026-09-16T00:00:00.000Z";
const NOW = new Date("2026-09-18T12:00:00.000Z");
const LIMITS = { autoReloadMinTriggerCents: 5_000, autoReloadMinAmountCents: 10_000, manualFundingMinCents: 1_000, manualFundingMaxCents: 500_000, defaultPaymentHoldTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120, caseTierMinimumCents: 50_000, advanceFeeBps: 100, advanceCapCents: 50_000, tierChangeGraceDays: 14 };

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
    autoReload: null, fundingMethods: [], recentLedger: [], cardFundingFeeBps: 300, usdcBaseDepositAddress: null,
    limits: LIMITS, setupStatus: { sourceReady: false, backupReady: false, acknowledged: false, done: false, launchReady: false }, clientFallbacks: [],
  };
  return { ...base, ...overrides };
}

function doneWallet(overrides: Partial<DropshipWalletView> = {}): DropshipWalletView {
  return wallet({
    autoReload: { autoReloadSettingId: 5, enabled: true, minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000, paymentHoldTimeoutMinutes: 2_880, fundingMethodId: 30, updatedAt: STAMP, backstopFundingMethodId: 10, acknowledgedCardFeeBps: 300, acknowledgedAt: STAMP },
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
    expect(derive(wallet({ fundingMethods: [CARD] }), started())).toMatchObject({ step: "source", suggestedSourceMethodId: 10 });
    expect(derive(wallet({ fundingMethods: [BANK] }), started({ sourceMethodId: 30 }))).toMatchObject({ step: "floor", floorCents: 25_000 });
    expect(derive(wallet({ fundingMethods: [BANK] }), started({ sourceMethodId: 30, floorCents: 4_000 }))).toMatchObject({ step: "floor" });
    expect(derive(wallet({ fundingMethods: [BANK] }), started({ sourceMethodId: 30, floorCents: 25_000 }))).toMatchObject({ step: "backup", backup: null, limitCents: 50_000 });
    expect(derive(wallet({ fundingMethods: [BANK, CARD] }), started({ sourceMethodId: 30, floorCents: 25_000 }))).toMatchObject({ step: "backup" });
    expect(derive(wallet({ fundingMethods: [BANK, CARD] }), started({ sourceMethodId: 30, floorCents: 25_000, backupMethodId: 10 }))).toMatchObject({ step: "authorize", backup: { satisfiedBySource: false } });
    expect(derive(wallet({ fundingMethods: [CARD] }), started({ sourceMethodId: 10, floorCents: 10_000 }))).toMatchObject({ step: "authorize", backup: { method: CARD, satisfiedBySource: true }, limitCents: 25_000 });
  });

  it("shows the intro to anyone who has not read it, whatever is already saved on the wallet", () => {
    // The old rule skipped step 1 whenever a method existed, so a vendor whose
    // wallet carried a card from the old flow was never shown the charge rules.
    const carriedOver = method({ fundingMethodId: 12, card: { brand: "Amex", last4: "6800", expMonth: 12, expYear: 2028 } });
    expect(derive(wallet({ fundingMethods: [carriedOver] }))).toMatchObject({ step: "intro", furthestStep: "intro", reachableSteps: ["intro"] });
    expect(derive(wallet({ fundingMethods: [carriedOver, BANK] }))).toMatchObject({ step: "intro", furthestStep: "intro" });
    // Reading it is the only thing that moves the flow on, and it stays read.
    expect(derive(wallet({ fundingMethods: [carriedOver] }), started())).toMatchObject({ step: "source", suggestedSourceMethodId: 12 });
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
    const seed = wallet({ autoReload: { autoReloadSettingId: 1, enabled: true, minimumBalanceCents: 25_000, maxSingleReloadCents: null, paymentHoldTimeoutMinutes: 2_880, fundingMethodId: null, updatedAt: STAMP, backstopFundingMethodId: null, acknowledgedCardFeeBps: null, acknowledgedAt: null } });
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
    expect(describeAcknowledgementBanner({ feeChange: null, onboarding: true })).toBe("Please review and confirm your auto-reload terms. Nothing changes until you confirm. You cannot activate until you do.");
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

  it("follows a hand-set cap when the floor changes in manage", () => {
    const handSet = doneWallet({ autoReload: { ...doneWallet().autoReload!, maxSingleReloadCents: 100_000 } });
    expect(derive(handSet, draft({ floorCents: 50_000 }), "active").limitCents).toBe(100_000);
    expect(derive(doneWallet(), draft({ floorCents: 100_000 }), "active").limitCents).toBe(250_000);
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

  it("builds the seven-key bodies", () => {
    const plan = { fundingMethodId: 30, backupFundingMethodId: 10, floorCents: 25_000, limitCents: 50_000, holdTimeoutMinutes: 2_880 };
    expect(buildAuthorizeInput(plan, wallet())).toEqual({ enabled: true, fundingMethodId: 30, backstopFundingMethodId: 10, minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000, paymentHoldTimeoutMinutes: 2_880, acknowledgedCardFeeBps: 300 });
    expect(buildConfirmTermsInput(plan, wallet({ cardFundingFeeBps: 350 })).acknowledgedCardFeeBps).toBe(350);
    expect(buildPlanSaveInput(plan, doneWallet({ cardFundingFeeBps: 350 })).acknowledgedCardFeeBps).toBe(300);
    expect(buildAutoReloadDisableInput(doneWallet())).toEqual({ enabled: false, fundingMethodId: 30, backstopFundingMethodId: 10, minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000, paymentHoldTimeoutMinutes: 2_880, acknowledgedCardFeeBps: null });
    // The hold is CardShellz's policy for every wallet: a saved row still
    // carrying an older value is never echoed back, shown or derived from.
    const policyHold = doneWallet({ limits: { ...LIMITS, defaultPaymentHoldTimeoutMinutes: 1_440 } });
    expect(buildAutoReloadDisableInput(policyHold).paymentHoldTimeoutMinutes).toBe(1_440);
    expect(planFromWallet(policyHold)?.holdTimeoutMinutes).toBe(1_440);
    expect(derive(policyHold).holdTimeoutMinutes).toBe(1_440);
    expect(() => buildAuthorizeInput({ ...plan, floorCents: 4_000 }, wallet())).toThrow("at least $50");
    expect(() => buildAuthorizeInput({ ...plan, limitCents: 20_000 }, wallet())).toThrow("at least your floor");
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
    expect(disabledReasonForRemoval(backup, true)).toBe("This is your backup card — choose another backup card first, then remove this one. — or turn off auto-reload.");
    expect(disabledReasonForRemoval({ ...BANK, roles: { isAutoReloadSource: true, isBackupCard: false, chargeable: false } }, false)).toBe("This is your top-up source — choose another source first, then remove this one.");
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
    expect(parseWalletDraft(JSON.stringify(legacy))).toEqual({ ...legacy, stepOverride: null });
    expect(parseWalletDraft(JSON.stringify({ ...legacy, stepOverride: "floor" }))).toMatchObject({ stepOverride: "floor", floorCents: 25_000 });
    expect(parseWalletDraft(JSON.stringify({ ...legacy, stepOverride: "nowhere" }))).toEqual({ ...legacy, stepOverride: null });
    expect(parseWalletDraft(JSON.stringify({ ...legacy, stepOverride: 3 }))).toEqual({ ...legacy, stepOverride: null });
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
    expect(draftAfterFloorChoice(reached, 25_000, 2_000)).toEqual({ ...reached, stepOverride: null });
    expect(draftAfterFloorChoice(reached, 50_000, null)).toEqual({ ...reached, stepOverride: null, floorCents: 50_000, dailyCostCents: null });
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
  const terms: WalletTerms = { sourceRail: "stripe_ach", sourceLabel: "Chase ending in 1234", backupLabel: "Visa ending in 4242", floorCents: 25_000, limitCents: 50_000, holdTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120, cardFundingFeeBps: 300 };

  it("words the bank mandate from the numbers", () => {
    const lines = describeMandate(terms);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("Debit Chase ending in 1234 to bring your balance up to $250 — once a day, and after any order that takes it lower. No fee. Money already on its way counts, so the same gap is not debited twice.");
    expect(lines[1]).toContain("While your account is active, charge Visa ending in 4242 only when an order needs more than your available balance: the shortfall plus the 3% card fee, up to the single top-up limit");
    expect(lines[1]).toContain("even while a bank top-up is still landing or your top-up source cannot be charged");
    expect(lines[1]).toContain("a $75 order with $20 available charges $55 + $1.65");
    expect(lines[1]).toContain("If a return fee has taken your balance below zero, the shortfall includes that amount.");
    expect(lines[2]).toBe("Never charge more than $500 in one top-up. An order needing more than your available balance plus $500 is not charged: it waits for you to add money and is cancelled if still unpaid after 48 hours. We email you 2 hours before that.");
    expect(lines[3]).toContain("first daily check after you activate (about midnight UTC)");
    expect(lines[3]).toContain("Adding money by card now avoids that");
    expect(lines[4]).toContain("before it lands");
    expect(lines[4]).toContain("We do not retry");
    expect(lines[5]).toContain("for automatic top-ups and covers");
    expect(lines[5]).toContain("shows the current fee on Stripe's page");
    const joined = lines.join(" ");
    expect(joined).not.toMatch(/refill|has been notified|never more than|\(2 × your floor\)/);
    expect(describeMandate({ ...terms, holdExpiryWarningMinutes: 90 })[2]).toContain("1 hour 30 minutes");
  });

  it("words the card mandate with the first fill and the bank-return clause", () => {
    const lines = describeMandate({ ...terms, sourceRail: "stripe_card", sourceLabel: "Visa ending in 4242", floorCents: 10_000, limitCents: 25_000 });
    expect(lines[0]).toBe("Charge Visa ending in 4242, plus the 3% fee, to bring your balance up to $100 — once a day and after any order that takes it lower ($100 + $3 = $103 when the wallet is empty).");
    expect(lines[1]).toContain("Visa ending in 4242 is also your backup card");
    expect(lines[1]).toContain("If a return fee has taken your balance below zero, the shortfall includes that amount.");
    expect(lines[4]).toContain("or a bank transfer you started is returned before it lands");
    expect(describePlanSentence({ ...terms, sourceRail: "stripe_card", sourceLabel: "Visa ending in 4242", floorCents: 10_000 })).toBe("In one sentence: you keep $100 in your wallet, refilled from your Visa ending in 4242 at 3%; the same card covers any shortfall.");
    expect(describePlanSentence(terms)).toBe("In one sentence: you keep $250 in your wallet, refilled from your bank for free; if an order ever needs more than what is there, your Visa ending in 4242 covers the shortfall plus 3%.");
  });

  it("pins the intro: five topics, each a lead and its detail, quoting only the values the server enforces", () => {
    const limits: WalletLimits = { autoReloadMinTriggerCents: 5_000, autoReloadMinAmountCents: 10_000, manualFundingMinCents: 1_000, manualFundingMaxCents: 500_000, defaultPaymentHoldTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120, caseTierMinimumCents: 50_000, advanceFeeBps: 100, advanceCapCents: 50_000, tierChangeGraceDays: 14 };
    const intro = describeIntro({ cardFundingFeeBps: 300, usdcOffered: true, holdTimeoutMinutes: 2_880, limits });
    expect(intro.lede).toBe("Your wallet is how Card Shellz gets paid for the orders you sell. Here is what it does, what it costs, and what happens if a payment fails.");
    expect(intro.topics).toHaveLength(5);
    expect(intro.topics.map((topic) => topic.lead)).toEqual([
      "What your wallet is.",
      "Payment methods and fees.",
      "Keeping it funded.",
      "Your backup card.",
      "If a payment fails.",
    ]);
    expect(intro.topics[0].detail).toBe("It is a prepaid balance Card Shellz holds for your store. Every order you accept is paid from it: the product cost plus shipping, with nothing added on top. When a return is processed its return fee comes out of the wallet too, and that can take your balance below zero.");
    expect(intro.topics[1].detail).toBe("A bank account costs nothing and takes up to 5 business days to land (our estimate). A card lands at once and costs 3% on top of the amount, whether it is a routine top-up, money you add yourself, or a backup charge. USDC costs nothing.");
    expect(intro.topics[2].detail).toBe("You choose a floor: the balance you want to hold. We top you back up to it once a day, and after any order that drops you below it. Your floor has to be at least $50, so there is always enough to cover a normal order. Money already on its way counts toward your floor, so the same gap is never charged twice. You can also add money yourself at any time.");
    expect(intro.topics[3].detail).toBe("Every seller keeps a card on file. Only money that has landed can pay for an order, so if an order needs more than your balance we charge that card for the difference and send the order straight out. That is what covers you while a bank transfer is still on its way.");
    expect(intro.topics[4].detail).toBe("Selling pauses: your listings show nothing for sale, and orders already waiting are cancelled after your hold time (48 hours). We email you, and we do not retry the charge ourselves. Selling starts again on its own once your balance is back at your floor.");
    // USDC is named only where a deposit address exists, and never with a timing claim: nothing in the code watches the chain.
    const noUsdc = describeIntro({ cardFundingFeeBps: 300, usdcOffered: false, holdTimeoutMinutes: 2_880, limits });
    expect(noUsdc.topics[1].detail).not.toContain("USDC");
    expect(intro.topics[1].detail).not.toMatch(/instant|confirming the transfer|credits it/);
    // The rate, the floor minimum and the hold time are served values; none is typed into the copy.
    const other = describeIntro({
      cardFundingFeeBps: 250,
      usdcOffered: false,
      holdTimeoutMinutes: 720,
      limits: { ...limits, autoReloadMinTriggerCents: 2_500 },
    });
    expect(other.topics[1].detail).toContain("costs 2.5% on top of the amount");
    expect(other.topics[2].detail).toContain("at least $25, so there is always enough to cover a normal order");
    expect(other.topics[4].detail).toContain("after your hold time (12 hours)");
    // Amounts the product does not actually enforce as rules are absent: the manual funding band and the single top-up limit's own minimum.
    const whole = [intro.lede, ...intro.topics.flatMap((topic) => [topic.lead, topic.detail])].join(" ");
    expect(whole).not.toMatch(/at a time|single top-up limit|Never charge more than|step 5/);
    // Exactly two amounts are quoted: the fee and the floor minimum.
    expect(whole.match(/\$[\d,]*\d|\d+(?:\.\d+)?%/g)).toEqual(["3%", "$50"]);
    expect(describeActivationTopUp({ cardFundingFeeBps: 300 })).toBe("Your first automatic top-up runs on the first daily check after you activate (about midnight UTC). Until it lands, orders are charged to your backup card at 3%. Adding money by card now avoids that.");
    expect(describeHoldTimeLine(120)).toContain("for orders held from now on");
    expect(describeHoldTimeLine(120)).toContain("We email you 2 hours before.");
    expect(describePendingBalance(25_000)).toBe("$250 on the way — a bank transfer takes up to 5 business days (our assumption) to land; this money cannot pay orders yet.");
    expect(describeRoleGap("backupCard", { holdTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120 })).toContain("we email you 2 hours before");
    expect(describeRoleGap("backupCard", { holdTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120 })).not.toContain("ending in");
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

  it("labels methods and ledger reasons", () => {
    expect(describeFundingMethod(CARD)).toBe("Visa ending in 4242");
    expect(describeFundingMethodDetailed(CARD)).toBe("Visa ending in 4242 · expires 12/27");
    expect(describeFundingMethodDetailed(BANK)).toBe("Chase ending in 1234 · checking");
    expect(describeFundingMethodDetailed(method({ fundingMethodId: 12, card: { brand: "Visa", last4: "4242", expMonth: null, expYear: null } }))).toBe("Visa ending in 4242");
    expect(describeFundingMethod(method({ fundingMethodId: 20, rail: "usdc_base", usdcWalletAddress: "0x1234567890abcdef1234567890abcdef12345678" }))).toBe("USDC · 0x1234…5678");
    expect(describeFundingMethod(method({ fundingMethodId: 13, card: null, displayLabel: "My card" }))).toBe("My card");
    expect(Object.keys(LEDGER_REASON_LABELS)).toHaveLength(12);
    expect(LEDGER_REASON_LABELS.covered_held_order).toBe("Covered a held order");
  });
});
