import { describe, expect, it } from "vitest";
import {
  AUTO_RELOAD_CAP_PRESETS_CENTS,
  AUTO_RELOAD_DEFAULTS,
  AUTO_RELOAD_MINIMUM_PRESETS_CENTS,
  PAUSE_ON_DECLINE_NOTE,
  buildAutoReloadDisableInput,
  buildAutoReloadSetupInput,
  centsToDollarInput,
  deriveWalletSetupState,
  describeAutoReloadMandate,
  describeAutoReloadPolicy,
  describeFundingMethod,
  describeFundingQuote,
  describeTopUpFee,
  describeTopUpRule,
  describeUsdcFunding,
  parseStripeReturn,
  presetsIncluding,
  quoteFundingForMethod,
  smallestCapFor,
  stripStripeReturn,
  type AutoReloadTerms,
  type DropshipWalletFundingMethod,
  type DropshipWalletOverview,
} from "../dropship-wallet-setup";

function method(overrides: Partial<DropshipWalletFundingMethod> & { fundingMethodId: number }): DropshipWalletFundingMethod {
  return {
    rail: "stripe_card",
    status: "active",
    displayLabel: "Visa ending in 4242",
    isDefault: false,
    usdcWalletAddress: null,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

function wallet(overrides: Partial<DropshipWalletOverview> = {}): DropshipWalletOverview {
  return {
    account: {
      walletAccountId: 1, vendorId: 1, availableBalanceCents: 0, pendingBalanceCents: 0, currency: "USD", status: "active",
      createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
    },
    autoReload: null,
    fundingMethods: [],
    recentLedger: [],
    cardFundingFeeBps: 300,
    usdcBaseDepositAddress: null,
    ...overrides,
  };
}

function autoReload(overrides: Partial<NonNullable<DropshipWalletOverview["autoReload"]>> = {}): NonNullable<DropshipWalletOverview["autoReload"]> {
  return {
    autoReloadSettingId: 7, enabled: true, minimumBalanceCents: 5000, maxSingleReloadCents: 25000,
    paymentHoldTimeoutMinutes: 2880, fundingMethodId: 10, updatedAt: "2026-09-15T00:00:00.000Z", ...overrides,
  };
}

describe("deriveWalletSetupState", () => {
  it("starts at add_card with nothing saved", () => {
    const state = deriveWalletSetupState(wallet());
    expect(state.stage).toBe("add_card");
    expect(state.primaryMethod).toBeNull();
    expect(state.cardMethods).toEqual([]);
    expect(state.autoReloadReady).toBe(false);
  });

  it("waits on confirm_card while the only Stripe method is still pending", () => {
    const state = deriveWalletSetupState(wallet({ fundingMethods: [method({ fundingMethodId: 10, status: "pending" })] }));
    expect(state.stage).toBe("confirm_card");
    expect(state.hasPendingCardMethod).toBe(true);
    expect(state.primaryMethod).toBeNull();
  });

  it("moves to auto_reload once a card is active, even with money in the wallet", () => {
    const state = deriveWalletSetupState(wallet({
      account: { ...wallet().account, availableBalanceCents: 12_000 },
      fundingMethods: [method({ fundingMethodId: 10 })],
    }));
    expect(state.stage).toBe("auto_reload");
    expect(state.primaryMethod?.fundingMethodId).toBe(10);
    expect(state.availableBalanceCents).toBe(12_000);
  });

  it("is ready only when auto-reload is on and bound to an active Stripe method", () => {
    const ready = deriveWalletSetupState(wallet({ fundingMethods: [method({ fundingMethodId: 10 })], autoReload: autoReload() }));
    expect(ready.stage).toBe("ready");
    expect(ready.autoReloadReady).toBe(true);

    const disabled = deriveWalletSetupState(wallet({ fundingMethods: [method({ fundingMethodId: 10 })], autoReload: autoReload({ enabled: false }) }));
    expect(disabled.stage).toBe("auto_reload");

    const boundToInactive = deriveWalletSetupState(wallet({
      fundingMethods: [method({ fundingMethodId: 10 }), method({ fundingMethodId: 11, status: "inactive" })],
      autoReload: autoReload({ fundingMethodId: 11 }),
    }));
    expect(boundToInactive.stage).toBe("auto_reload");
    expect(boundToInactive.autoReloadOn).toBe(true);
    expect(boundToInactive.autoReloadReady).toBe(false);
  });

  it("still needs a card when auto-reload runs on a bank account alone: ACH cannot cover a held order", () => {
    const state = deriveWalletSetupState(wallet({
      fundingMethods: [method({ fundingMethodId: 30, rail: "stripe_ach", displayLabel: "Chase ending in 2222" })],
      autoReload: autoReload({ fundingMethodId: 30 }),
    }));
    // Auto-reload itself is correctly bound; the missing piece is the backstop.
    expect(state.autoReloadReady).toBe(true);
    expect(state.cardMethods).toEqual([]);
    expect(state.stage).toBe("add_card");
    // An ACH method pending activation must not read as a card awaiting its webhook.
    expect(state.hasPendingCardMethod).toBe(false);
  });

  it("is ready with auto-reload on a bank account as long as a card is on file", () => {
    const state = deriveWalletSetupState(wallet({
      fundingMethods: [
        method({ fundingMethodId: 10, displayLabel: "Visa ending in 4242" }),
        method({ fundingMethodId: 30, rail: "stripe_ach", displayLabel: "Chase ending in 2222" }),
      ],
      autoReload: autoReload({ fundingMethodId: 30 }),
    }));
    expect(state.stage).toBe("ready");
    expect(state.primaryMethod?.fundingMethodId).toBe(30);
    expect(state.cardMethods.map((entry) => entry.fundingMethodId)).toEqual([10]);
  });

  it("never treats USDC as a card: it cannot satisfy the gate", () => {
    const state = deriveWalletSetupState(wallet({
      fundingMethods: [method({ fundingMethodId: 20, rail: "usdc_base", displayLabel: null, usdcWalletAddress: "0x1234567890abcdef1234567890abcdef12345678" })],
      autoReload: autoReload({ fundingMethodId: 20 }),
    }));
    expect(state.stage).toBe("add_card");
    expect(state.cardMethods).toEqual([]);
  });

  it("prefers a bank account for auto-reload when nothing is saved yet: the free rail is the default", () => {
    const state = deriveWalletSetupState(wallet({
      fundingMethods: [
        method({ fundingMethodId: 1, isDefault: true, displayLabel: "Visa ending in 1111" }),
        method({ fundingMethodId: 2, rail: "stripe_ach", displayLabel: "Chase ending in 2222" }),
      ],
    }));
    expect(state.primaryMethod?.fundingMethodId).toBe(2);
    expect(state.bankMethods.map((entry) => entry.fundingMethodId)).toEqual([2]);
    expect(state.reloadMethods.map((entry) => entry.fundingMethodId)).toEqual([2, 1]);
  });

  it("reports a bank account that is still being confirmed separately from a pending card", () => {
    const state = deriveWalletSetupState(wallet({
      fundingMethods: [method({ fundingMethodId: 10 }), method({ fundingMethodId: 30, rail: "stripe_ach", status: "pending", displayLabel: "Chase ending in 2222" })],
    }));
    expect(state.hasPendingBankMethod).toBe(true);
    expect(state.hasPendingCardMethod).toBe(false);
    expect(state.bankMethods).toEqual([]);
    expect(state.stage).toBe("auto_reload");
  });

  it("lists registered USDC addresses without ever offering them for auto-reload", () => {
    const state = deriveWalletSetupState(wallet({
      fundingMethods: [
        method({ fundingMethodId: 10 }),
        method({ fundingMethodId: 20, rail: "usdc_base", displayLabel: null, usdcWalletAddress: "0x1234567890abcdef1234567890abcdef12345678" }),
      ],
    }));
    expect(state.usdcMethods.map((entry) => entry.fundingMethodId)).toEqual([20]);
    expect(state.reloadMethods.map((entry) => entry.fundingMethodId)).toEqual([10]);
  });

  it("offers cards and bank accounts for auto-reload, configured first, and keeps the backstop list to cards", () => {
    const state = deriveWalletSetupState(wallet({
      fundingMethods: [
        method({ fundingMethodId: 1, isDefault: true, displayLabel: "Visa ending in 1111" }),
        method({ fundingMethodId: 2, rail: "stripe_ach", displayLabel: "Chase ending in 2222" }),
        method({ fundingMethodId: 3, displayLabel: "Amex ending in 3333" }),
      ],
      autoReload: autoReload({ fundingMethodId: 3 }),
    }));
    expect(state.reloadMethods.map((entry) => entry.fundingMethodId)).toEqual([3, 1, 2]);
    // The backstop is cards only: ACH cannot cover an order already waiting.
    expect(state.cardMethods.map((entry) => entry.fundingMethodId).sort()).toEqual([1, 3]);

    const noConfig = deriveWalletSetupState(wallet({
      fundingMethods: [method({ fundingMethodId: 1 }), method({ fundingMethodId: 2, isDefault: true })],
    }));
    expect(noConfig.primaryMethod?.fundingMethodId).toBe(2);
  });
});

describe("buildAutoReloadSetupInput", () => {
  it("enables auto-reload with the chosen presets, keeps the saved hold timeout, and carries the fee rate agreed to", () => {
    expect(buildAutoReloadSetupInput({
      fundingMethodId: 10, minimumBalanceCents: 2500, maxSingleReloadCents: 10_000, cardFundingFeeBps: 300, existing: autoReload({ paymentHoldTimeoutMinutes: 720 }),
    })).toEqual({
      enabled: true, fundingMethodId: 10, minimumBalanceCents: 2500, maxSingleReloadCents: 10_000, paymentHoldTimeoutMinutes: 720, acknowledgedCardFeeBps: 300,
    });
  });

  it("falls back to the default hold timeout when nothing was saved before", () => {
    expect(buildAutoReloadSetupInput({ fundingMethodId: 10, minimumBalanceCents: 5000, maxSingleReloadCents: 25_000, cardFundingFeeBps: 300, existing: null }).paymentHoldTimeoutMinutes)
      .toBe(AUTO_RELOAD_DEFAULTS.paymentHoldTimeoutMinutes);
  });

  it("refuses a reload smaller than the minimum, a zero minimum, or fractional cents", () => {
    expect(() => buildAutoReloadSetupInput({ fundingMethodId: 10, minimumBalanceCents: 5000, maxSingleReloadCents: 2500, cardFundingFeeBps: 300, existing: null })).toThrow();
    expect(() => buildAutoReloadSetupInput({ fundingMethodId: 10, minimumBalanceCents: 0, maxSingleReloadCents: 2500, cardFundingFeeBps: 300, existing: null })).toThrow();
    expect(() => buildAutoReloadSetupInput({ fundingMethodId: 10, minimumBalanceCents: 12.5, maxSingleReloadCents: 2500, cardFundingFeeBps: 300, existing: null })).toThrow();
  });

  it("refuses to enrol without a valid fee rate, so the mandate can never omit the fee", () => {
    for (const cardFundingFeeBps of [Number.NaN, -1, 2.5, 1_001]) {
      expect(() => buildAutoReloadSetupInput({ fundingMethodId: 10, minimumBalanceCents: 5000, maxSingleReloadCents: 25_000, cardFundingFeeBps, existing: null }))
        .toThrow("card fee rate");
    }
    expect(buildAutoReloadSetupInput({ fundingMethodId: 10, minimumBalanceCents: 5000, maxSingleReloadCents: 25_000, cardFundingFeeBps: 0, existing: null }).acknowledgedCardFeeBps).toBe(0);
  });
});

describe("quoteFundingForMethod", () => {
  it("adds the fee on top for a card and nothing for a bank account", () => {
    expect(quoteFundingForMethod(method({ fundingMethodId: 10 }), 10_000, 300)).toEqual({
      rail: "stripe_card", creditCents: 10_000, feeCents: 300, feeBps: 300, chargedCents: 10_300,
    });
    expect(quoteFundingForMethod(method({ fundingMethodId: 11, rail: "stripe_ach", displayLabel: "Chase ending in 6789" }), 10_000, 300)).toEqual({
      rail: "stripe_ach", creditCents: 10_000, feeCents: 0, feeBps: 0, chargedCents: 10_000,
    });
  });
});

describe("buildAutoReloadDisableInput", () => {
  it("turns auto-reload off while preserving the saved amounts and method", () => {
    expect(buildAutoReloadDisableInput(autoReload({ minimumBalanceCents: 7000, maxSingleReloadCents: 9000, paymentHoldTimeoutMinutes: 60 })))
      .toEqual({ enabled: false, fundingMethodId: 10, minimumBalanceCents: 7000, maxSingleReloadCents: 9000, paymentHoldTimeoutMinutes: 60 });
    expect(buildAutoReloadDisableInput(null)).toEqual({
      enabled: false, fundingMethodId: null, minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000, paymentHoldTimeoutMinutes: 2880,
    });
  });
});

describe("Stripe return markers", () => {
  it("reads the server's markers and ignores anything else", () => {
    expect(parseStripeReturn("?funding_setup=success")).toEqual({ kind: "funding_setup", status: "success" });
    expect(parseStripeReturn("?wallet_funding=cancelled&x=1")).toEqual({ kind: "wallet_funding", status: "cancelled" });
    expect(parseStripeReturn("?funding_setup=whatever")).toBeNull();
    expect(parseStripeReturn("")).toBeNull();
  });

  it("strips the markers and keeps other parameters", () => {
    expect(stripStripeReturn("?funding_setup=success&tab=wallet")).toBe("?tab=wallet");
    expect(stripStripeReturn("?wallet_funding=success")).toBe("");
  });
});

describe("formatting helpers", () => {
  it("renders cents in the form the dollar parser accepts", () => {
    expect(centsToDollarInput(0)).toBe("0.00");
    expect(centsToDollarInput(2505)).toBe("25.05");
    expect(() => centsToDollarInput(-1)).toThrow();
  });

  it("labels methods by their Stripe label, falling back per rail", () => {
    expect(describeFundingMethod(method({ fundingMethodId: 1 }))).toBe("Visa ending in 4242");
    expect(describeFundingMethod(method({ fundingMethodId: 1, displayLabel: "  " }))).toBe("Card");
    expect(describeFundingMethod(method({ fundingMethodId: 1, rail: "stripe_ach", displayLabel: null }))).toBe("Bank account");
    expect(describeFundingMethod(method({ fundingMethodId: 1, rail: "usdc_base", displayLabel: null, usdcWalletAddress: "0x1234567890abcdef1234567890abcdef12345678" })))
      .toBe("USDC 0x1234...5678");
  });
});

describe("presets", () => {
  it("adds a saved amount to the presets so an existing choice is never shown as none of these", () => {
    expect(presetsIncluding(AUTO_RELOAD_MINIMUM_PRESETS_CENTS, 5000)).toEqual([5000, 10_000, 25_000, 50_000, 100_000]);
    expect(presetsIncluding(AUTO_RELOAD_MINIMUM_PRESETS_CENTS, 25_000)).toEqual([10_000, 25_000, 50_000, 100_000]);
    expect(presetsIncluding(AUTO_RELOAD_MINIMUM_PRESETS_CENTS, null)).toEqual([10_000, 25_000, 50_000, 100_000]);
    expect(presetsIncluding(AUTO_RELOAD_MINIMUM_PRESETS_CENTS, 0)).toEqual([10_000, 25_000, 50_000, 100_000]);
  });

  it("lifts the cap to the smallest option that still clears the balance kept", () => {
    expect(smallestCapFor(25_000)).toBe(25_000);
    expect(smallestCapFor(30_000)).toBe(50_000);
    expect(smallestCapFor(300_000)).toBe(300_000);
    expect(smallestCapFor(7000, [5000, 9000])).toBe(9000);
    expect(AUTO_RELOAD_CAP_PRESETS_CENTS[0]).toBeGreaterThanOrEqual(AUTO_RELOAD_DEFAULTS.minimumBalanceCents);
  });
});

describe("policy copy", () => {
  const card = method({ fundingMethodId: 10, displayLabel: "Visa ending in 4242" });
  const bank = method({ fundingMethodId: 30, rail: "stripe_ach", displayLabel: "Chase ending in 2222" });
  const cardTerms: AutoReloadTerms = { method: card, backupCard: card, minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000, cardFundingFeeBps: 300 };
  const bankTerms: AutoReloadTerms = { ...cardTerms, method: bank };

  it("states the top-up rule the server implements: back up to the balance kept, capped per top-up", () => {
    expect(describeTopUpRule(bankTerms)).toBe(
      "We keep your balance at $250.00: once a day, and after any order that takes it lower, we top it back up from Chase ending in 2222. One top-up never charges more than $500.00.",
    );
  });

  it("prices the chosen rail and names the card fallback when a bank account pays", () => {
    expect(describeTopUpFee(cardTerms)).toBe("Card top-ups carry a 3% fee on top of the amount added: a $500.00 top-up charges $515.00.");
    expect(describeTopUpFee(bankTerms)).toBe("Bank top-ups carry no fee and take a few days to land. An order that cannot wait is charged to Visa ending in 4242 plus the 3% card fee.");
    expect(describeTopUpFee({ ...bankTerms, backupCard: null })).toContain("charged to your card on file plus the 3% card fee.");
  });

  it("writes a mandate that names every charge the vendor authorizes", () => {
    expect(describeAutoReloadMandate(cardTerms)).toBe(
      "By turning this on, you authorize Card Shellz to charge Visa ending in 4242, plus the 3% card fee, to keep your balance at $250.00 and to cover any order your balance cannot, up to $500.00 per charge.",
    );
    expect(describeAutoReloadMandate(bankTerms)).toBe(
      "By turning this on, you authorize Card Shellz to debit Chase ending in 2222 to keep your balance at $250.00, up to $500.00 per charge, and to charge Visa ending in 4242 plus the 3% card fee for any order your balance cannot cover.",
    );
    expect(PAUSE_ON_DECLINE_NOTE).toContain("selling pauses");
  });

  it("summarizes a saved policy on the wallet, with the card fallback spelled out for bank top-ups", () => {
    const saved = autoReload({ minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000 });
    expect(describeAutoReloadPolicy({ autoReload: saved, method: card, backupCard: card, cardFundingFeeBps: 300 }))
      .toBe("Keeps your balance at $250.00 from Visa ending in 4242, plus the 3% card fee, up to $500.00 per top-up.");
    expect(describeAutoReloadPolicy({ autoReload: saved, method: bank, backupCard: card, cardFundingFeeBps: 300 }))
      .toBe("Keeps your balance at $250.00 from Chase ending in 2222, no fee, up to $500.00 per top-up. Visa ending in 4242 covers any order that cannot wait, plus the 3% card fee.");
    expect(describeAutoReloadPolicy({ autoReload: { ...saved, maxSingleReloadCents: null }, method: bank, backupCard: null, cardFundingFeeBps: 300 }))
      .toContain("up to $250.00 per top-up. Your card on file covers");
  });

  it("describes an Add funds quote per rail", () => {
    expect(describeFundingQuote(card, quoteFundingForMethod(card, 10_000, 300)))
      .toBe("Card fee (3%): $3.00. Your card is charged $103.00 and $100.00 goes into your wallet.");
    expect(describeFundingQuote(card, quoteFundingForMethod(card, 10_000, 0))).toBe("No fee. $100.00 goes into your wallet.");
    expect(describeFundingQuote(bank, quoteFundingForMethod(bank, 10_000, 300)))
      .toBe("No fee. $100.00 goes into your wallet once the bank transfer settles, usually within a few days.");
  });
});

describe("describeUsdcFunding", () => {
  const usdc = method({ fundingMethodId: 20, rail: "usdc_base", displayLabel: null, usdcWalletAddress: "0x1234567890abcdef1234567890abcdef12345678" });

  it("is not offered until Card Shellz publishes a deposit address", () => {
    expect(describeUsdcFunding({ depositAddress: null, usdcMethods: [usdc] })).toBeNull();
  });

  it("asks for the sending address first, then shows where to send", () => {
    const before = describeUsdcFunding({ depositAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", usdcMethods: [] });
    expect(before?.registeredAddress).toBeNull();
    expect(before?.lines[0]).toContain("Register the wallet address you will send from");
    const after = describeUsdcFunding({ depositAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", usdcMethods: [usdc] });
    expect(after).toMatchObject({ depositAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", registeredAddress: "0x1234...5678" });
    expect(after?.lines[0]).toBe("Send USDC on Base from 0x1234...5678 to the deposit address below.");
  });
});
