import { describe, expect, it } from "vitest";
import {
  CLIENT_FALLBACK_LIMITS,
  adaptWalletView,
  deriveAcknowledgement,
  deriveBackstopFundingMethodId,
  deriveBankAccountDetails,
  deriveCardDetails,
  deriveLedgerReason,
  deriveMethodStatus,
  deriveRoles,
  deriveSetupStatus,
} from "../dropship-wallet-view-adapter";

const STAMP = "2026-09-15T00:00:00.000Z";
const LATER = "2026-09-16T00:00:00.000Z";

function rawMethod(overrides: Record<string, unknown> = {}) {
  return { fundingMethodId: 10, rail: "stripe_card", status: "active", displayLabel: "Visa ending in 4242", isDefault: true, usdcWalletAddress: null, createdAt: STAMP, updatedAt: STAMP, ...overrides };
}

function rawAutoReload(overrides: Record<string, unknown> = {}) {
  return { autoReloadSettingId: 5, enabled: true, minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000, paymentHoldTimeoutMinutes: 2880, fundingMethodId: 30, updatedAt: STAMP, ...overrides };
}

function rawWallet(overrides: Record<string, unknown> = {}) {
  return { wallet: {
    account: { walletAccountId: 1, vendorId: 1, availableBalanceCents: 0, pendingBalanceCents: 0, currency: "USD", status: "active", createdAt: STAMP, updatedAt: STAMP },
    autoReload: null, fundingMethods: [], recentLedger: [], cardFundingFeeBps: 300, usdcBaseDepositAddress: null, ...overrides } };
}

describe("adaptWalletView", () => {
  it("adapts today's response and lists every fallback it applied", () => {
    const view = adaptWalletView(rawWallet({
      autoReload: rawAutoReload(),
      fundingMethods: [rawMethod(), rawMethod({ fundingMethodId: 30, rail: "stripe_ach", displayLabel: "Chase ending in 1234", isDefault: false })],
      recentLedger: [{ ledgerEntryId: 1, type: "order_debit", status: "settled", amountCents: -7500, currency: "USD", availableBalanceAfterCents: -5000, pendingBalanceAfterCents: 0, referenceType: "order", referenceId: "1", createdAt: STAMP, settledAt: STAMP }],
    }));
    expect(view.autoReload).toMatchObject({ backstopFundingMethodId: 10, acknowledgedCardFeeBps: 300, acknowledgedAt: STAMP });
    expect(view.fundingMethods[0]).toMatchObject({ card: { brand: "Visa", last4: "4242", expMonth: null, expYear: null }, roles: { isBackupCard: true, isAutoReloadSource: false, chargeable: true } });
    expect(view.fundingMethods[1]).toMatchObject({ bankAccount: { bankName: "Chase", last4: "1234", accountType: null }, roles: { isAutoReloadSource: true, isBackupCard: false, chargeable: false } });
    expect(view.recentLedger[0]).toMatchObject({ reason: "order", availableBalanceAfterCents: -5000, cardFee: null, failure: null });
    expect(view.limits).toEqual(CLIENT_FALLBACK_LIMITS);
    expect(view.setupStatus).toEqual({ sourceReady: true, backupReady: true, acknowledged: true, done: true, launchReady: true });
    expect(view.listingTiers).toBeNull();
    expect(view.advance).toBeNull();
    expect(view.clientFallbacks.sort()).toEqual([
      "acknowledgement_assumed_from_settings_row", "advance_not_served", "backstop_from_first_active_card", "bank_details_from_label", "card_details_from_label",
      "ledger_reason_derived", "limits_from_documented_defaults", "listing_tiers_not_served", "roles_derived", "setup_status_derived",
    ]);
    // The page never sees provider internals.
    expect(view.account).not.toHaveProperty("walletAccountId");
    expect(view.fundingMethods[0]).not.toHaveProperty("isDefault");
  });

  it("uses every served §4.1 field as-is and applies no fallback", () => {
    const limits = { autoReloadMinTriggerCents: 5000, caseTierMinimumCents: 40000, autoReloadMinAmountCents: 10000, manualFundingMinCents: 1000, manualFundingMaxCents: 500000, defaultPaymentHoldTimeoutMinutes: 2880, holdExpiryWarningMinutes: 90, advanceFeeBps: 125, advanceCapCents: 30000, tierChangeGraceDays: 7, cardFundingMinCents: 15000, rewardsRateBankBps: 100, rewardsRateUsdcBps: 100, rewardsRateCardBps: 0, bankBalanceReadOffered: false };
    const setupStatus = { sourceReady: true, backupReady: true, acknowledged: false, done: true, launchReady: false };
    const view = adaptWalletView(rawWallet({
      autoReload: rawAutoReload({ backstopFundingMethodId: 11, acknowledgedCardFeeBps: 250, acknowledgedAt: LATER }),
      fundingMethods: [rawMethod({ status: "active", card: { brand: "Visa", last4: "4242", expMonth: 12, expYear: 2027 }, roles: { isAutoReloadSource: false, isBackupCard: true, chargeable: true } })],
      recentLedger: [{ ledgerEntryId: 2, type: "funding", status: "settled", amountCents: 5500, currency: "USD", availableBalanceAfterCents: 0, pendingBalanceAfterCents: 0, createdAt: STAMP, settledAt: STAMP,
        reason: "covered_held_order", fundingMethodId: 10, cardFee: { feeCents: 165, feeBps: 300, chargedCents: 5665 }, failure: null }],
      limits, setupStatus, listingTiers: servedListingTiers(), advance: servedAdvance(),
    }));
    expect(view.autoReload).toMatchObject({ backstopFundingMethodId: 11, acknowledgedCardFeeBps: 250, acknowledgedAt: LATER });
    expect(view.fundingMethods[0].card).toEqual({ brand: "Visa", last4: "4242", expMonth: 12, expYear: 2027 });
    expect(view.recentLedger[0]).toMatchObject({ reason: "covered_held_order", cardFee: { feeCents: 165, feeBps: 300, chargedCents: 5665 } });
    expect(view.limits).toEqual(limits);
    expect(view.setupStatus).toEqual(setupStatus);
    expect(view.listingTiers).toEqual(servedListingTiers());
    expect(view.advance).toEqual(servedAdvance());
    expect(view.clientFallbacks).toEqual([]);
  });

  it("carries the rewards balance, the spend preference and the rates as served, reads rewards ledger lines, and reads an older server as no rewards (funding design phase 7)", () => {
    const served = adaptWalletView(rawWallet({
      account: { walletAccountId: 1, vendorId: 1, availableBalanceCents: 5000, pendingBalanceCents: 0, rewardsBalanceCents: 1234, currency: "USD", status: "active", createdAt: STAMP, updatedAt: STAMP },
      autoReload: rawAutoReload({ spendRewardsFirst: false, backstopFundingMethodId: 11, acknowledgedCardFeeBps: 250, acknowledgedAt: LATER }),
      recentLedger: [
        { ledgerEntryId: 3, type: "rewards_earned", status: "settled", amountCents: 40, currency: "USD", availableBalanceAfterCents: 5000, pendingBalanceAfterCents: 0, rewardsBalanceAfterCents: 1234, createdAt: STAMP, settledAt: STAMP, reason: "rewards_earned", referenceType: "wallet_funding_rewards" },
        { ledgerEntryId: 4, type: "rewards_spent", status: "settled", amountCents: -300, currency: "USD", availableBalanceAfterCents: 5000, pendingBalanceAfterCents: 0, rewardsBalanceAfterCents: 934, createdAt: STAMP, settledAt: STAMP, reason: "rewards_spent", referenceType: "order_intake_rewards" },
      ],
      limits: { ...servedLimits(), rewardsRateBankBps: 125, rewardsRateUsdcBps: 100, rewardsRateCardBps: 50 },
      listingTiers: servedListingTiers(), setupStatus: servedSetupStatus(), advance: servedAdvance(),
    }));
    expect(served.account.rewardsBalanceCents).toBe(1234);
    expect(served.autoReload?.spendRewardsFirst).toBe(false);
    expect(served.limits).toMatchObject({ rewardsRateBankBps: 125, rewardsRateUsdcBps: 100, rewardsRateCardBps: 50 });
    expect(served.recentLedger.map((entry) => [entry.reason, entry.rewardsBalanceAfterCents])).toEqual([["rewards_earned", 1234], ["rewards_spent", 934]]);
    expect(served.clientFallbacks).toEqual([]);

    const older = adaptWalletView(rawWallet({ autoReload: rawAutoReload(), recentLedger: [{ ledgerEntryId: 2, type: "funding", status: "settled", amountCents: 5500, currency: "USD", availableBalanceAfterCents: 0, pendingBalanceAfterCents: 0, createdAt: STAMP, settledAt: STAMP }] }));
    expect(older.account.rewardsBalanceCents).toBe(0);
    expect(older.autoReload?.spendRewardsFirst).toBe(true);
    expect(older.limits).toMatchObject({ rewardsRateBankBps: 100, rewardsRateUsdcBps: 100, rewardsRateCardBps: 0 });
    expect(older.recentLedger[0].rewardsBalanceAfterCents).toBeNull();
    // A rewards balance is never negative: a body that says otherwise breaks the contract.
    expect(() => adaptWalletView(rawWallet({ account: { walletAccountId: 1, vendorId: 1, availableBalanceCents: 0, pendingBalanceCents: 0, rewardsBalanceCents: -1, currency: "USD", status: "active", createdAt: STAMP, updatedAt: STAMP } }))).toThrow();
  });

  it("takes the advance position as served, treats a served null as an answer, and refuses a malformed one", () => {
    const advance = servedAdvance();
    expect(adaptWalletView(rawWallet({ advance, listingTiers: servedListingTiers(), limits: servedLimits(), setupStatus: servedSetupStatus() })).clientFallbacks).toEqual([]);
    const served = adaptWalletView(rawWallet({ advance: null, listingTiers: servedListingTiers(), limits: servedLimits(), setupStatus: servedSetupStatus() }));
    expect(served.advance).toBeNull();
    expect(served.clientFallbacks).toEqual([]);
    expect(adaptWalletView(rawWallet({ advance })).advance).toEqual(advance);
    expect(() => adaptWalletView(rawWallet({ advance: { ...advance, headroomCents: 12.5 } }))).toThrow();
    expect(() => adaptWalletView(rawWallet({ advance: { ...advance, reasons: ["vibes"] } }))).toThrow();
    expect(() => adaptWalletView(rawWallet({ advance: { ...advance, policy: { ...advance.policy, capSource: "guess" } } }))).toThrow();
  });

  it("takes the listing tiers exactly as served and never derives them", () => {
    const tiers = servedListingTiers();
    expect(adaptWalletView(rawWallet({ listingTiers: tiers })).listingTiers).toEqual(tiers);
    // A malformed tier (money that is not integer cents) is a contract break, not something to paper over.
    expect(() => adaptWalletView(rawWallet({ listingTiers: { ...tiers, case: { ...tiers.case, shortfallCents: 12.5 } } }))).toThrow();
    expect(() => adaptWalletView(rawWallet({ listingTiers: { ...tiers, pack: { ...tiers.pack, reason: "vibes" } } }))).toThrow();
  });

  it("fills a limit an older server did not serve from the documented default, and names the fallback", () => {
    const served = { autoReloadMinTriggerCents: 7500, autoReloadMinAmountCents: 12500, manualFundingMinCents: 1000, manualFundingMaxCents: 500000, defaultPaymentHoldTimeoutMinutes: 2880, holdExpiryWarningMinutes: 90 };
    const view = adaptWalletView(rawWallet({ limits: served }));
    expect(view.limits).toEqual({ ...CLIENT_FALLBACK_LIMITS, ...served });
    expect(view.limits.caseTierMinimumCents).toBe(CLIENT_FALLBACK_LIMITS.caseTierMinimumCents);
    expect(view.clientFallbacks).toContain("limits_from_documented_defaults");
    // The documented defaults are the launch values of migration 0683, version 2.
    expect(CLIENT_FALLBACK_LIMITS).toEqual({
      autoReloadMinTriggerCents: 10_000, caseTierMinimumCents: 50_000, autoReloadMinAmountCents: 10_000,
      manualFundingMinCents: 1_000, manualFundingMaxCents: 500_000, defaultPaymentHoldTimeoutMinutes: 1_440,
      holdExpiryWarningMinutes: 120, advanceFeeBps: 100, advanceCapCents: 50_000, tierChangeGraceDays: 14, cardFundingMinCents: 10_000, rewardsRateBankBps: 100, rewardsRateUsdcBps: 100, rewardsRateCardBps: 0, bankBalanceReadOffered: false,
    });
  });

  it("accepts a negative available balance and rejects a body that breaks today's contract", () => {
    expect(adaptWalletView(rawWallet({ account: { availableBalanceCents: -5000, pendingBalanceCents: 0, currency: "USD", status: "active" } })).account.availableBalanceCents).toBe(-5000);
    expect(() => adaptWalletView({ wallet: { account: {} } })).toThrow();
    expect(() => adaptWalletView(rawWallet({ cardFundingFeeBps: "300" }))).toThrow();
  });
});

describe("derivations", () => {
  it("maps free-text statuses onto the typed set, never offering an unknown row", () => {
    expect(deriveMethodStatus("active")).toBe("active");
    expect(deriveMethodStatus("pending")).toBe("setup_pending");
    expect(deriveMethodStatus("setup_pending")).toBe("setup_pending");
    expect(deriveMethodStatus("failed")).toBe("failed");
    expect(deriveMethodStatus("inactive")).toBe("archived");
    expect(deriveMethodStatus("anything")).toBe("archived");
  });

  it("parses card and bank details from the label only when the server serves none", () => {
    expect(deriveCardDetails({ rail: "stripe_card", displayLabel: "Mastercard ending in 9999", card: undefined })).toEqual({ brand: "Mastercard", last4: "9999", expMonth: null, expYear: null });
    expect(deriveCardDetails({ rail: "stripe_card", displayLabel: "My card", card: undefined })).toBeNull();
    expect(deriveCardDetails({ rail: "stripe_ach", displayLabel: "Chase ending in 1234", card: undefined })).toBeNull();
    expect(deriveCardDetails({ rail: "stripe_card", displayLabel: null, card: { brand: "Visa", last4: "4242", expMonth: 1, expYear: 2030 } })).toEqual({ brand: "Visa", last4: "4242", expMonth: 1, expYear: 2030 });
    expect(deriveBankAccountDetails({ rail: "stripe_ach", displayLabel: "Chase ending in 1234", bankAccount: undefined })).toEqual({ bankName: "Chase", last4: "1234", accountType: null });
    expect(deriveBankAccountDetails({ rail: "stripe_ach", displayLabel: null, bankAccount: { bankName: null, last4: "0001", accountType: "checking" } })).toEqual({ bankName: null, last4: "0001", accountType: "checking" });
    expect(deriveBankAccountDetails({ rail: "stripe_card", displayLabel: "Visa ending in 4242", bankAccount: undefined })).toBeNull();
  });

  it("derives the backup card: served value, else the card source, else the default card, else the newest card", () => {
    const card10 = rawMethod({ fundingMethodId: 10, isDefault: false, createdAt: STAMP });
    const card11 = rawMethod({ fundingMethodId: 11, isDefault: false, createdAt: LATER });
    const bank = rawMethod({ fundingMethodId: 30, rail: "stripe_ach" });
    expect(deriveBackstopFundingMethodId(rawAutoReload({ backstopFundingMethodId: null }) as never, [card10] as never)).toEqual({ backstopFundingMethodId: null, derived: false });
    expect(deriveBackstopFundingMethodId(rawAutoReload({ fundingMethodId: 10 }) as never, [card10, card11] as never)).toEqual({ backstopFundingMethodId: 10, derived: true });
    expect(deriveBackstopFundingMethodId(rawAutoReload({ fundingMethodId: 30 }) as never, [card10, { ...card11, isDefault: true }, bank] as never)).toEqual({ backstopFundingMethodId: 11, derived: true });
    expect(deriveBackstopFundingMethodId(rawAutoReload({ fundingMethodId: 30 }) as never, [card10, card11, bank] as never)).toEqual({ backstopFundingMethodId: 11, derived: true });
    expect(deriveBackstopFundingMethodId(null, [bank] as never)).toEqual({ backstopFundingMethodId: null, derived: true });
    expect(deriveBackstopFundingMethodId(rawAutoReload() as never, [{ ...card10, status: "inactive" }] as never)).toEqual({ backstopFundingMethodId: null, derived: true });
  });

  it("assumes the acknowledgement from an enabled row only until the server records one", () => {
    expect(deriveAcknowledgement(null, 300)).toEqual({ acknowledgedCardFeeBps: null, acknowledgedAt: null, derived: false });
    expect(deriveAcknowledgement(rawAutoReload() as never, 300)).toEqual({ acknowledgedCardFeeBps: 300, acknowledgedAt: STAMP, derived: true });
    expect(deriveAcknowledgement(rawAutoReload({ enabled: false }) as never, 300)).toEqual({ acknowledgedCardFeeBps: null, acknowledgedAt: null, derived: true });
    expect(deriveAcknowledgement(rawAutoReload({ fundingMethodId: null }) as never, 300)).toEqual({ acknowledgedCardFeeBps: null, acknowledgedAt: null, derived: true });
    expect(deriveAcknowledgement(rawAutoReload({ acknowledgedCardFeeBps: null, acknowledgedAt: null }) as never, 300)).toEqual({ acknowledgedCardFeeBps: null, acknowledgedAt: null, derived: false });
  });

  it("gives a disabled row no roles", () => {
    const method = { fundingMethodId: 10, rail: "stripe_card", status: "active", roles: undefined } as const;
    expect(deriveRoles(method as never, { enabled: true, fundingMethodId: 10, backstopFundingMethodId: 10 })).toEqual({ isAutoReloadSource: true, isBackupCard: true, chargeable: true });
    expect(deriveRoles(method as never, { enabled: false, fundingMethodId: 10, backstopFundingMethodId: 10 })).toEqual({ isAutoReloadSource: false, isBackupCard: false, chargeable: true });
    expect(deriveRoles({ ...method, status: "inactive" } as never, null)).toEqual({ isAutoReloadSource: false, isBackupCard: false, chargeable: false });
  });

  it("derives the setup status from the same predicates as the launch gate", () => {
    const view = adaptWalletView(rawWallet({ autoReload: rawAutoReload({ fundingMethodId: 30 }), fundingMethods: [rawMethod(), rawMethod({ fundingMethodId: 30, rail: "stripe_ach", displayLabel: "Chase ending in 1234" })] }));
    expect(deriveSetupStatus({ autoReload: view.autoReload, fundingMethods: view.fundingMethods, cardFundingFeeBps: 300 })).toEqual({ sourceReady: true, backupReady: true, acknowledged: true, done: true, launchReady: true });
    expect(deriveSetupStatus({ autoReload: { ...view.autoReload!, acknowledgedCardFeeBps: 250 }, fundingMethods: view.fundingMethods, cardFundingFeeBps: 300 })).toMatchObject({ acknowledged: false, done: true, launchReady: false });
    const noBackup = adaptWalletView(rawWallet({ autoReload: rawAutoReload({ fundingMethodId: 30 }), fundingMethods: [rawMethod({ fundingMethodId: 30, rail: "stripe_ach", displayLabel: "Chase ending in 1234" })] }));
    expect(noBackup.setupStatus).toMatchObject({ sourceReady: true, backupReady: false, done: false });
    const seed = adaptWalletView(rawWallet({ autoReload: rawAutoReload({ fundingMethodId: null }), fundingMethods: [rawMethod()] }));
    expect(seed.setupStatus).toMatchObject({ sourceReady: false, done: false });
  });

  it("derives the ledger reason from type, reference and metadata, and says 'other' when it cannot tell", () => {
    const funding = (extra: Record<string, unknown>) => deriveLedgerReason({ type: "funding", reason: undefined, referenceType: null, metadata: null, ...extra });
    expect(deriveLedgerReason({ type: "order_debit", reason: undefined, referenceType: null, metadata: null })).toBe("order");
    expect(deriveLedgerReason({ type: "return_fee", reason: undefined, referenceType: null, metadata: null })).toBe("return_fee");
    expect(deriveLedgerReason({ type: "advance_fee", reason: undefined, referenceType: null, metadata: null })).toBe("advance_fee");
    expect(deriveLedgerReason({ type: "funding_reversal", reason: undefined, referenceType: null, metadata: null })).toBe("funding_reversed");
    expect(deriveLedgerReason({ type: "funding_reinstated", reason: undefined, referenceType: null, metadata: null })).toBe("funding_reinstated");
    expect(deriveLedgerReason({ type: "weird", reason: undefined, referenceType: null, metadata: null })).toBe("other");
    expect(funding({ metadata: { autoReload: true, autoReloadReason: "payment_hold" } })).toBe("covered_held_order");
    expect(funding({ metadata: { autoReload: true, autoReloadReason: "minimum_balance", trigger: "daily" } })).toBe("daily_top_up");
    expect(funding({ metadata: { autoReload: true, trigger: "activation" } })).toBe("activation_top_up");
    expect(funding({ metadata: { autoReload: true, intakeId: 7 } })).toBe("after_order_top_up");
    expect(funding({ metadata: { autoReload: true } })).toBe("daily_top_up");
    expect(funding({ referenceType: "admin_manual_wallet_credit" })).toBe("admin_credit");
    expect(funding({ referenceType: "usdc_base_transaction" })).toBe("usdc_deposit");
    expect(funding({ metadata: { provider: "stripe" } })).toBe("manual_top_up");
    expect(funding({})).toBe("other");
    expect(deriveLedgerReason({ type: "funding", reason: "manual_top_up", referenceType: null, metadata: null })).toBe("manual_top_up");
  });
});

function servedListingTiers() {
  return {
    pack: { tier: "pack" as const, eligible: true, reason: null, minimumCents: 10_000, shortfallCents: 0, upcoming: null },
    case: {
      tier: "case" as const, eligible: false, reason: "case_tier_balance_below_minimum" as const, minimumCents: 50_000, shortfallCents: 38_000,
      upcoming: { minimumCents: 75_000, policyVersion: 3, enforcesAt: "2026-10-01T00:00:00.000Z", affectsVendor: true },
    },
    generatedAt: STAMP,
  };
}

function servedLimits() {
  return { autoReloadMinTriggerCents: 5000, caseTierMinimumCents: 40000, autoReloadMinAmountCents: 10000, manualFundingMinCents: 1000, manualFundingMaxCents: 500000, defaultPaymentHoldTimeoutMinutes: 2880, holdExpiryWarningMinutes: 90, advanceFeeBps: 125, advanceCapCents: 30000, tierChangeGraceDays: 7, cardFundingMinCents: 15000, rewardsRateBankBps: 100, rewardsRateUsdcBps: 100, rewardsRateCardBps: 0, bankBalanceReadOffered: false };
}

function servedSetupStatus() {
  return { sourceReady: true, backupReady: true, acknowledged: false, done: true, launchReady: false };
}

/** A company bank account with $400 on the way that qualifies; the cap is the policy's $500. */
function servedAdvance() {
  return {
    policy: { feeBps: 100, capCents: 50_000, capSource: "policy" as const },
    sources: [{ fundingMethodId: 30, pendingCents: 40_000, accountHolderType: "company" as const, balanceVerified: true, priorPullSettled: true, eligible: true, reasons: [] }],
    eligiblePendingCents: 40_000,
    allowanceCents: 40_000,
    exposureCents: 0,
    headroomCents: 40_000,
    reasons: [],
  };
}

describe("USDC deposit position (funding design phase 6)", () => {
  const usdcDeposit = {
    offered: true, watched: true, chainId: 8453, tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", minConfirmations: 6, settleTag: "safe",
    address: { address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", checksumAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", assignedAt: "2026-09-21T10:00:00.000Z" },
  };

  it("carries the served position through unchanged, address and all", () => {
    expect(adaptWalletView(rawWallet({ usdcDeposit })).usdcDeposit).toEqual(usdcDeposit);
    expect(adaptWalletView(rawWallet({ usdcDeposit: { ...usdcDeposit, address: null } })).usdcDeposit).toEqual({ ...usdcDeposit, address: null });
  });

  it("is null when an older server does not serve it, and refuses a malformed one", () => {
    expect(adaptWalletView(rawWallet()).usdcDeposit).toBeNull();
    expect(() => adaptWalletView(rawWallet({ usdcDeposit: { ...usdcDeposit, settleTag: "latest" } }))).toThrow();
    expect(() => adaptWalletView(rawWallet({ usdcDeposit: { ...usdcDeposit, minConfirmations: 0 } }))).toThrow();
  });
});

describe("acknowledgement after a fee cut (funding design phase 7)", () => {
  it("counts an agreement at or above the live rate as acknowledged, and one below it as stale", () => {
    const view = adaptWalletView(rawWallet({
      cardFundingFeeBps: 0,
      autoReload: rawAutoReload({ acknowledgedCardFeeBps: 300, acknowledgedAt: STAMP }),
      fundingMethods: [rawMethod(), rawMethod({ fundingMethodId: 30, rail: "stripe_ach", displayLabel: "Chase ending in 1234", isDefault: false })],
    }));
    expect(view.setupStatus).toMatchObject({ acknowledged: true, launchReady: true });
    expect(deriveSetupStatus({ autoReload: { ...view.autoReload!, acknowledgedCardFeeBps: 300 }, fundingMethods: view.fundingMethods, cardFundingFeeBps: 0 })).toMatchObject({ acknowledged: true });
    expect(deriveSetupStatus({ autoReload: { ...view.autoReload!, acknowledgedCardFeeBps: 0 }, fundingMethods: view.fundingMethods, cardFundingFeeBps: 200 })).toMatchObject({ acknowledged: false, launchReady: false });
    expect(deriveSetupStatus({ autoReload: { ...view.autoReload!, acknowledgedCardFeeBps: null, acknowledgedAt: null }, fundingMethods: view.fundingMethods, cardFundingFeeBps: 0 })).toMatchObject({ acknowledged: false });
  });
});
