import { describe, expect, it } from "vitest";
import {
  AUTO_RELOAD_DEFAULTS,
  buildAutoReloadDisableInput,
  buildAutoReloadSetupInput,
  centsToDollarInput,
  deriveWalletSetupState,
  describeFundingMethod,
  parseStripeReturn,
  stripStripeReturn,
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
    expect(state.stripeMethods).toEqual([]);
    expect(state.autoReloadReady).toBe(false);
  });

  it("waits on confirm_card while the only Stripe method is still pending", () => {
    const state = deriveWalletSetupState(wallet({ fundingMethods: [method({ fundingMethodId: 10, status: "pending" })] }));
    expect(state.stage).toBe("confirm_card");
    expect(state.hasPendingStripeMethod).toBe(true);
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

  it("never treats USDC as a card: it cannot satisfy the gate", () => {
    const state = deriveWalletSetupState(wallet({
      fundingMethods: [method({ fundingMethodId: 20, rail: "usdc_base", displayLabel: null, usdcWalletAddress: "0x1234567890abcdef1234567890abcdef12345678" })],
      autoReload: autoReload({ fundingMethodId: 20 }),
    }));
    expect(state.stage).toBe("add_card");
    expect(state.stripeMethods).toEqual([]);
  });

  it("orders methods with the configured auto-reload card first, then the default", () => {
    const state = deriveWalletSetupState(wallet({
      fundingMethods: [
        method({ fundingMethodId: 1, isDefault: true, displayLabel: "Visa ending in 1111" }),
        method({ fundingMethodId: 2, rail: "stripe_ach", displayLabel: "Chase ending in 2222" }),
        method({ fundingMethodId: 3, displayLabel: "Amex ending in 3333" }),
      ],
      autoReload: autoReload({ fundingMethodId: 3 }),
    }));
    expect(state.stripeMethods.map((entry) => entry.fundingMethodId)).toEqual([3, 1, 2]);

    const noConfig = deriveWalletSetupState(wallet({
      fundingMethods: [method({ fundingMethodId: 1 }), method({ fundingMethodId: 2, isDefault: true })],
    }));
    expect(noConfig.primaryMethod?.fundingMethodId).toBe(2);
  });
});

describe("buildAutoReloadSetupInput", () => {
  it("enables auto-reload with the chosen presets and keeps the saved hold timeout", () => {
    expect(buildAutoReloadSetupInput({
      fundingMethodId: 10, minimumBalanceCents: 2500, maxSingleReloadCents: 10_000, existing: autoReload({ paymentHoldTimeoutMinutes: 720 }),
    })).toEqual({ enabled: true, fundingMethodId: 10, minimumBalanceCents: 2500, maxSingleReloadCents: 10_000, paymentHoldTimeoutMinutes: 720 });
  });

  it("falls back to the default hold timeout when nothing was saved before", () => {
    expect(buildAutoReloadSetupInput({ fundingMethodId: 10, minimumBalanceCents: 5000, maxSingleReloadCents: 25_000, existing: null }).paymentHoldTimeoutMinutes)
      .toBe(AUTO_RELOAD_DEFAULTS.paymentHoldTimeoutMinutes);
  });

  it("refuses a reload smaller than the minimum, a zero minimum, or fractional cents", () => {
    expect(() => buildAutoReloadSetupInput({ fundingMethodId: 10, minimumBalanceCents: 5000, maxSingleReloadCents: 2500, existing: null })).toThrow();
    expect(() => buildAutoReloadSetupInput({ fundingMethodId: 10, minimumBalanceCents: 0, maxSingleReloadCents: 2500, existing: null })).toThrow();
    expect(() => buildAutoReloadSetupInput({ fundingMethodId: 10, minimumBalanceCents: 12.5, maxSingleReloadCents: 2500, existing: null })).toThrow();
  });
});

describe("buildAutoReloadDisableInput", () => {
  it("turns auto-reload off while preserving the saved amounts and method", () => {
    expect(buildAutoReloadDisableInput(autoReload({ minimumBalanceCents: 7000, maxSingleReloadCents: 9000, paymentHoldTimeoutMinutes: 60 })))
      .toEqual({ enabled: false, fundingMethodId: 10, minimumBalanceCents: 7000, maxSingleReloadCents: 9000, paymentHoldTimeoutMinutes: 60 });
    expect(buildAutoReloadDisableInput(null)).toEqual({
      enabled: false, fundingMethodId: null, minimumBalanceCents: 5000, maxSingleReloadCents: 25_000, paymentHoldTimeoutMinutes: 2880,
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
