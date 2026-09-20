/**
 * Every server refusal the Wallet page can receive and its face (spec §2.10).
 *
 * Pure mapper: `describeWalletError(code, message, context)` returns the
 * sentence to show and how the page recovers. No face claims that anyone was
 * notified, because nothing notifies anyone. Unknown codes fall back to the
 * server message and a wallet re-read.
 */

import { formatFeeRate } from "@shared/dropship/wallet-funding-fee";
import { formatWholeDollars } from "./dropship-wallet-guidance";
import type { WalletLimits } from "./dropship-wallet-view-adapter";

export type WalletFlowStep = "intro" | "source" | "floor" | "backup" | "authorize" | "deposit";

export type WalletErrorRecovery = "none" | "refetch" | "verify" | { step: "source" | "floor" | "backup" };

export interface WalletErrorFace {
  text: string;
  recovery: WalletErrorRecovery;
}

/** Which request failed, when the same code has different faces. */
export type WalletErrorSurface = "put" | "get" | "delete" | "checkout" | "setup" | "usdc" | "other";

const SUPPORT = "Contact Card Shellz support if this persists.";
const INVALID_INPUT = "Something in the request was not valid. Reload the page and try again.";
const SOURCE_GONE = "Your autopay source is no longer available. Choose or add another.";
const STRIPE_UNAVAILABLE = `Card and bank services are unavailable right now. ${SUPPORT}`;

export function describeWalletError(
  code: string | null,
  message: string,
  context: Record<string, unknown> | null,
  input: { surface: WalletErrorSurface; limits: WalletLimits },
): WalletErrorFace {
  const { surface, limits } = input;
  switch (code) {
    case "DROPSHIP_STEP_UP_REQUIRED":
    case "DROPSHIP_STEP_UP_METHOD_REQUIRED":
      return { text: "Please confirm it is you to continue.", recovery: "verify" };
    case "DROPSHIP_AUTH_EMAIL_DELIVERY_FAILED":
      return { text: "We could not send the code. Try again in a moment.", recovery: "none" };
    case "DROPSHIP_WALLET_RATE_LIMITED":
      return { text: "Too many changes in a short time. Wait a few minutes and try again.", recovery: "none" };
    case "DROPSHIP_CARD_FUNDING_FEE_ACKNOWLEDGEMENT_STALE": {
      const bps = context && typeof context.cardFundingFeeBps === "number" ? context.cardFundingFeeBps : null;
      const rate = bps === null ? "" : ` to ${formatFeeRate(bps)}`;
      return { text: `The card fee changed${rate} while you were reading. Please review the terms again and re-authorize.`, recovery: "refetch" };
    }
    case "DROPSHIP_CARD_FUNDING_FEE_ACKNOWLEDGEMENT_REQUIRED":
      return { text: INVALID_INPUT, recovery: "refetch" };
    case "DROPSHIP_BACKUP_CARD_REQUIRED":
      return { text: "A backup card is required before auto-reload can be turned on.", recovery: { step: "backup" } };
    case "DROPSHIP_BACKUP_CARD_NOT_CHARGEABLE":
      return { text: "That card can no longer be charged (it may have been removed at Stripe). Choose or add another backup card.", recovery: { step: "backup" } };
    case "DROPSHIP_BACKUP_CARD_EXPIRED":
      return { text: "That card has expired. Add a current card.", recovery: { step: "backup" } };
    case "DROPSHIP_FUNDING_METHOD_IS_BACKUP_CARD":
      return { text: "This is your backup card. Choose another backup card first, then remove this one.", recovery: "refetch" };
    case "DROPSHIP_FUNDING_METHOD_IS_AUTO_RELOAD_SOURCE":
      return { text: "This is your autopay source. Choose another source first, then remove this one.", recovery: "refetch" };
    case "DROPSHIP_AUTO_RELOAD_REQUIRED_WHILE_ACTIVE":
      return { text: "Auto-reload stays on while your account is active or paused.", recovery: "refetch" };
    case "DROPSHIP_FUNDING_METHOD_NOT_FOUND":
      return surface === "put"
        ? { text: SOURCE_GONE, recovery: { step: "source" } }
        : { text: "That method is no longer on your wallet.", recovery: "refetch" };
    case "DROPSHIP_FUNDING_METHOD_NOT_ACTIVE":
      return surface === "put"
        ? { text: SOURCE_GONE, recovery: { step: "source" } }
        : { text: "That method was removed. Pick another.", recovery: "refetch" };
    case "DROPSHIP_AUTO_RELOAD_FUNDING_METHOD_REQUIRED":
    case "DROPSHIP_AUTO_RELOAD_FUNDING_METHOD_RAIL_UNSUPPORTED":
      return { text: SOURCE_GONE, recovery: { step: "source" } };
    case "DROPSHIP_AUTO_RELOAD_TRIGGER_BELOW_MINIMUM":
    case "DROPSHIP_AUTO_RELOAD_AMOUNT_REQUIRED":
    case "DROPSHIP_AUTO_RELOAD_AMOUNT_BELOW_MINIMUM":
    case "DROPSHIP_AUTO_RELOAD_INVALID_LIMITS":
      return {
        text: `Your floor or limit is outside the allowed range: floor at least ${formatWholeDollars(limits.autoReloadMinTriggerCents)}, limit at least ${formatWholeDollars(limits.autoReloadMinAmountCents)} and at least your floor.`,
        recovery: { step: "floor" },
      };
    case "DROPSHIP_WALLET_FUNDING_AMOUNT_OUT_OF_RANGE":
      return { text: `Amounts must be between ${formatWholeDollars(limits.manualFundingMinCents)} and ${formatWholeDollars(limits.manualFundingMaxCents)}.`, recovery: "none" };
    case "DROPSHIP_FUNDING_METHOD_RAIL_UNSUPPORTED":
    case "DROPSHIP_FUNDING_METHOD_PROVIDER_CUSTOMER_REQUIRED":
      return { text: "This account cannot be used for a payment right now. Add money later from Wallet.", recovery: "refetch" };
    case "DROPSHIP_WALLET_INVALID_INPUT":
      return surface === "usdc"
        ? { text: "Enter a Base address: 0x followed by 40 characters.", recovery: "none" }
        : { text: INVALID_INPUT, recovery: "none" };
    case "DROPSHIP_FUNDING_RETURN_PATH_INVALID":
      return { text: "Something went wrong. Reload the page.", recovery: "none" };
    case "DROPSHIP_FUNDING_PROVIDER_NOT_CONFIGURED":
    case "DROPSHIP_STRIPE_SECRET_NOT_CONFIGURED":
      return { text: `Card and bank setup is unavailable right now. ${SUPPORT}`, recovery: "none" };
    case "DROPSHIP_CARD_FUNDING_FEE_MISCONFIGURED":
      return { text: `The card fee is not configured correctly, so nothing can be authorized right now. ${SUPPORT}`, recovery: "none" };
    case "DROPSHIP_STRIPE_SETUP_SESSION_URL_MISSING":
    case "DROPSHIP_STRIPE_FUNDING_SESSION_URL_MISSING":
      return { text: "Stripe did not open. Try again.", recovery: "none" };
    case "DROPSHIP_STRIPE_CREDENTIALS_REJECTED":
    case "DROPSHIP_STRIPE_PERMISSION_DENIED":
      return { text: STRIPE_UNAVAILABLE, recovery: "none" };
    case "DROPSHIP_STRIPE_UNAVAILABLE":
    case "DROPSHIP_STRIPE_RATE_LIMITED":
      return { text: "Stripe is busy. Try again in a moment.", recovery: "none" };
    case "DROPSHIP_WALLET_VIEW_INVALID":
      return { text: "Something went wrong on our side. Nothing was changed unless it shows below after a reload.", recovery: "refetch" };
    default:
      break;
  }
  if (code && code.endsWith("_CARD_DECLINED")) return { text: message, recovery: "none" };
  if (code && code.startsWith("DROPSHIP_STRIPE_") && /TRANSIENT|TIMEOUT|CONNECTION/.test(code)) {
    return { text: "Stripe is busy. Try again in a moment.", recovery: "none" };
  }
  return { text: message.trim() || "Something went wrong on our side. Nothing was changed unless it shows below after a reload.", recovery: "refetch" };
}
