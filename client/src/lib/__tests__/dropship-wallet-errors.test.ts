import { describe, expect, it } from "vitest";
import { describeWalletError } from "../dropship-wallet-errors";

const LIMITS = { autoReloadMinTriggerCents: 5_000, autoReloadMinAmountCents: 10_000, manualFundingMinCents: 1_000, manualFundingMaxCents: 500_000, defaultPaymentHoldTimeoutMinutes: 2_880, holdExpiryWarningMinutes: 120 };
const face = (code: string | null, surface: "put" | "get" | "delete" | "checkout" | "setup" | "usdc" | "other" = "other", context: Record<string, unknown> | null = null) =>
  describeWalletError(code, "server message", context, { surface, limits: LIMITS });

describe("describeWalletError", () => {
  it("maps every refusal to its face and recovery", () => {
    expect(face("DROPSHIP_STEP_UP_REQUIRED")).toMatchObject({ recovery: "verify" });
    expect(face("DROPSHIP_AUTH_EMAIL_DELIVERY_FAILED")).toEqual({ text: "We could not send the code. Try again in a moment.", recovery: "none" });
    expect(face("DROPSHIP_WALLET_RATE_LIMITED")).toEqual({ text: "Too many changes in a short time. Wait a few minutes and try again.", recovery: "none" });
    expect(face("DROPSHIP_CARD_FUNDING_FEE_ACKNOWLEDGEMENT_STALE", "put", { cardFundingFeeBps: 250 })).toEqual({ text: "The card fee changed to 2.5% while you were reading. Please review the terms again and re-authorize.", recovery: "refetch" });
    expect(face("DROPSHIP_CARD_FUNDING_FEE_ACKNOWLEDGEMENT_REQUIRED", "put")).toEqual({ text: "Something in the request was not valid. Reload the page and try again.", recovery: "refetch" });
    expect(face("DROPSHIP_BACKUP_CARD_REQUIRED", "put")).toEqual({ text: "A backup card is required before auto-reload can be turned on.", recovery: { step: "backup" } });
    expect(face("DROPSHIP_BACKUP_CARD_NOT_CHARGEABLE", "put")).toEqual({ text: "That card can no longer be charged (it may have been removed at Stripe). Choose or add another backup card.", recovery: { step: "backup" } });
    expect(face("DROPSHIP_BACKUP_CARD_EXPIRED", "put")).toEqual({ text: "That card has expired. Add a current card.", recovery: { step: "backup" } });
    expect(face("DROPSHIP_FUNDING_METHOD_IS_BACKUP_CARD", "delete")).toEqual({ text: "This is your backup card. Choose another backup card first, then remove this one.", recovery: "refetch" });
    expect(face("DROPSHIP_FUNDING_METHOD_IS_AUTO_RELOAD_SOURCE", "delete")).toEqual({ text: "This is your top-up source. Choose another source first, then remove this one.", recovery: "refetch" });
    expect(face("DROPSHIP_AUTO_RELOAD_REQUIRED_WHILE_ACTIVE", "put")).toEqual({ text: "Auto-reload stays on while your account is active or paused.", recovery: "refetch" });
    expect(face("DROPSHIP_FUNDING_METHOD_NOT_FOUND", "put")).toEqual({ text: "Your top-up source is no longer available. Choose or add another.", recovery: { step: "source" } });
    expect(face("DROPSHIP_FUNDING_METHOD_NOT_FOUND", "delete")).toEqual({ text: "That method is no longer on your wallet.", recovery: "refetch" });
    expect(face("DROPSHIP_FUNDING_METHOD_NOT_ACTIVE", "put")).toEqual({ text: "Your top-up source is no longer available. Choose or add another.", recovery: { step: "source" } });
    expect(face("DROPSHIP_FUNDING_METHOD_NOT_ACTIVE", "checkout")).toEqual({ text: "That method was removed. Pick another.", recovery: "refetch" });
    expect(face("DROPSHIP_AUTO_RELOAD_FUNDING_METHOD_RAIL_UNSUPPORTED", "put")).toMatchObject({ recovery: { step: "source" } });
    expect(face("DROPSHIP_AUTO_RELOAD_TRIGGER_BELOW_MINIMUM", "put")).toEqual({ text: "Your floor or limit is outside the allowed range: floor at least $50, limit at least $100 and at least your floor.", recovery: { step: "floor" } });
    expect(face("DROPSHIP_AUTO_RELOAD_INVALID_LIMITS", "put")).toMatchObject({ recovery: { step: "floor" } });
    expect(face("DROPSHIP_WALLET_FUNDING_AMOUNT_OUT_OF_RANGE", "checkout")).toEqual({ text: "Amounts must be between $10 and $5,000.", recovery: "none" });
    expect(face("DROPSHIP_FUNDING_METHOD_PROVIDER_CUSTOMER_REQUIRED", "checkout")).toEqual({ text: "This account cannot be used for a payment right now. Add money later from Wallet.", recovery: "refetch" });
    expect(face("DROPSHIP_WALLET_INVALID_INPUT", "put")).toEqual({ text: "Something in the request was not valid. Reload the page and try again.", recovery: "none" });
    expect(face("DROPSHIP_WALLET_INVALID_INPUT", "usdc")).toEqual({ text: "Enter a Base address: 0x followed by 40 characters.", recovery: "none" });
    expect(face("DROPSHIP_FUNDING_RETURN_PATH_INVALID", "setup")).toEqual({ text: "Something went wrong. Reload the page.", recovery: "none" });
    expect(face("DROPSHIP_STRIPE_SECRET_NOT_CONFIGURED", "setup")).toEqual({ text: "Card and bank setup is unavailable right now. Contact Card Shellz support if this persists.", recovery: "none" });
    expect(face("DROPSHIP_CARD_FUNDING_FEE_MISCONFIGURED", "put")).toEqual({ text: "The card fee is not configured correctly, so nothing can be authorized right now. Contact Card Shellz support if this persists.", recovery: "none" });
    expect(face("DROPSHIP_CARD_FUNDING_FEE_MISCONFIGURED", "get").text).toBe(face("DROPSHIP_CARD_FUNDING_FEE_MISCONFIGURED", "put").text);
    expect(face("DROPSHIP_STRIPE_SETUP_SESSION_URL_MISSING", "setup")).toEqual({ text: "Stripe did not open. Try again.", recovery: "none" });
    expect(face("DROPSHIP_STRIPE_CREDENTIALS_REJECTED")).toEqual({ text: "Card and bank services are unavailable right now. Contact Card Shellz support if this persists.", recovery: "none" });
    expect(face("DROPSHIP_STRIPE_UNAVAILABLE")).toEqual({ text: "Stripe is busy. Try again in a moment.", recovery: "none" });
    expect(face("DROPSHIP_STRIPE_CARD_DECLINED", "checkout")).toEqual({ text: "server message", recovery: "none" });
    expect(face("DROPSHIP_WALLET_VIEW_INVALID", "get")).toMatchObject({ recovery: "refetch" });
  });

  it("falls back to the server message and a re-read for unknown codes", () => {
    expect(face("SOMETHING_NEW")).toEqual({ text: "server message", recovery: "refetch" });
    expect(face(null)).toEqual({ text: "server message", recovery: "refetch" });
    expect(describeWalletError(null, "   ", null, { surface: "other", limits: LIMITS }).text).toContain("Something went wrong on our side");
  });

  it("never claims anyone was notified", () => {
    const codes = ["DROPSHIP_STRIPE_CREDENTIALS_REJECTED", "DROPSHIP_CARD_FUNDING_FEE_MISCONFIGURED", "DROPSHIP_FUNDING_PROVIDER_NOT_CONFIGURED", "DROPSHIP_WALLET_VIEW_INVALID"];
    for (const code of codes) expect(face(code).text).not.toMatch(/has been notified/);
  });
});
