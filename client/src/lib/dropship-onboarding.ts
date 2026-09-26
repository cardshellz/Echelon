/**
 * Vendor onboarding model.
 *
 * Pure functions behind the vendor portal Onboarding page. They turn the
 * server's onboarding state into what each checklist row says and what its
 * button does, so the page renders one list instead of a checklist beside a
 * second set of cards repeating it. No fetch, no clock; the server's step
 * status is trusted for whether a step is done, and the state's flags only
 * decide the wording and the action.
 */

import { formatCents, formatStatus, type DropshipOnboardingState, type DropshipOnboardingStep } from "./dropship-ops-surface";

/** The one vendor status the checklist applies to. Every other status is past it, or blocked out of it. */
export const ONBOARDING_VENDOR_STATUS = "onboarding";

export function isOnboardingVendor(vendorStatus: string): boolean {
  return vendorStatus === ONBOARDING_VENDOR_STATUS;
}

export type OnboardingStepTone = "complete" | "todo" | "waiting" | "blocked";

/** What a row's button does: open another portal page, or bring the store panel on this page into view. */
export type OnboardingStepAction =
  | { kind: "navigate"; label: string; path: "/catalog" | "/wallet" }
  | { kind: "store_panel"; label: string };

export interface OnboardingStepView {
  key: DropshipOnboardingStep["key"];
  label: string;
  tone: OnboardingStepTone;
  badge: string;
  detail: string;
  action: OnboardingStepAction | null;
}

const BADGE_BY_TONE: Record<OnboardingStepTone, string> = {
  complete: "Complete",
  todo: "To do",
  waiting: "Waiting on Card Shellz",
  blocked: "Blocked",
};

const MEMBERSHIP_INACTIVE_DETAIL = "Unavailable while your .ops membership is inactive.";

export function describeOnboardingStep(
  step: DropshipOnboardingStep,
  onboarding: DropshipOnboardingState,
): OnboardingStepView {
  const base = { key: step.key, label: step.label };
  if (step.status === "blocked") {
    return {
      ...base,
      tone: "blocked",
      badge: BADGE_BY_TONE.blocked,
      detail: step.key === "vendor_profile"
        ? "Your Card Shellz .ops membership is no longer active. Renew it to continue."
        : MEMBERSHIP_INACTIVE_DETAIL,
      action: null,
    };
  }
  const complete = step.status === "complete";
  switch (step.key) {
    case "vendor_profile":
      return { ...base, tone: "complete", badge: BADGE_BY_TONE.complete, detail: "Your Card Shellz .ops membership is active.", action: null };
    case "store_connection":
      return { ...base, ...describeStoreConnection(complete, onboarding.storeConnections) };
    case "catalog_available":
      return complete
        ? { ...base, tone: "complete", badge: BADGE_BY_TONE.complete, detail: "Card Shellz has opened the catalog to you.", action: null }
        // Not the vendor's job: Card Shellz ops configures exposure. A "To do"
        // here would send them looking for a button that does not exist.
        : { ...base, tone: "waiting", badge: BADGE_BY_TONE.waiting, detail: "Card Shellz sets up your catalog access. Nothing for you to do yet.", action: null };
    case "catalog_selection":
      return { ...base, ...describeCatalogSelection(complete, onboarding.catalog) };
    case "wallet_payment":
      return { ...base, ...describeWallet(complete, onboarding.wallet) };
    default: {
      const unknownKey: never = step.key;
      throw new Error(`Unknown onboarding step: ${String(unknownKey)}`);
    }
  }
}

type StepBody = Pick<OnboardingStepView, "tone" | "badge" | "detail" | "action">;

function describeStoreConnection(
  complete: boolean,
  stores: DropshipOnboardingState["storeConnections"],
): StepBody {
  if (complete) {
    const count = stores.launchReadyConnectedCount;
    return {
      tone: "complete",
      badge: BADGE_BY_TONE.complete,
      detail: count === 1 ? "Your store is connected and launch ready." : `${count} stores are connected and launch ready.`,
      action: null,
    };
  }
  if (stores.connectedCount > 0 && stores.credentialAttentionCount > 0) {
    return {
      tone: "todo",
      badge: BADGE_BY_TONE.todo,
      detail: "Your store is connected but its credentials need attention. Reconnect it below.",
      action: { kind: "store_panel", label: "Fix store connection" },
    };
  }
  if (stores.connectedCount > 0) {
    return {
      tone: "todo",
      badge: BADGE_BY_TONE.todo,
      detail: "Your store is connected but not launch ready yet. Check it below.",
      action: { kind: "store_panel", label: "Check store connection" },
    };
  }
  return {
    tone: "todo",
    badge: BADGE_BY_TONE.todo,
    detail: "Connect your eBay or Shopify store below.",
    action: { kind: "store_panel", label: "Connect store" },
  };
}

function describeCatalogSelection(
  complete: boolean,
  catalog: DropshipOnboardingState["catalog"],
): StepBody {
  if (complete) {
    const count = catalog.vendorSelectionRuleCount;
    return {
      tone: "complete",
      badge: BADGE_BY_TONE.complete,
      detail: `${count} product selection ${count === 1 ? "rule" : "rules"} saved. Change them any time in Catalog.`,
      action: { kind: "navigate", label: "Open catalog", path: "/catalog" },
    };
  }
  return {
    tone: "todo",
    badge: BADGE_BY_TONE.todo,
    detail: catalog.adminCatalogAvailable
      ? "Pick the products you want to sell."
      : "Pick products once Card Shellz opens the catalog.",
    action: { kind: "navigate", label: "Choose products", path: "/catalog" },
  };
}

function describeWallet(
  complete: boolean,
  wallet: DropshipOnboardingState["wallet"],
): StepBody {
  if (complete) {
    return {
      tone: "complete",
      badge: BADGE_BY_TONE.complete,
      detail: describeWalletComplete(wallet),
      action: { kind: "navigate", label: "Open wallet", path: "/wallet" },
    };
  }
  return {
    tone: "todo",
    badge: BADGE_BY_TONE.todo,
    detail: walletTodoDetail(wallet),
    action: { kind: "navigate", label: "Set up wallet", path: "/wallet" },
  };
}

/**
 * One story on every surface: source → minimum → backup card → authorize. The
 * onboarding state does not carry the minimum, the labels or the fee rate yet,
 * so the sentence names the rail and states the timing of the first top-up in
 * the words of what the code does today (the first daily check after
 * activation).
 */
function describeWalletComplete(wallet: DropshipOnboardingState["wallet"]): string {
  const source = wallet.autoReloadFundingMethodIsCard ? "your card" : "your bank account";
  const balance = wallet.hasSpendableBalance ? `${formatCents(wallet.availableBalanceCents)} available. ` : "";
  return `${balance}Autopay from ${source} to your reserve; backup card on file. Your first automatic top-up runs on the first daily check after you activate${wallet.autoReloadFundingMethodIsCard ? "" : " (a bank transfer lands in up to 5 business days — our assumption)"}.`;
}

/**
 * Mirrors the server's launch gate (`buildOnboardingState`) in the new order
 * and names the first missing piece so the vendor knows what Wallet asks for.
 */
export function walletTodoDetail(wallet: DropshipOnboardingState["wallet"]): string {
  if (!wallet.hasActiveFundingMethod || (!wallet.autoReloadFundingMethodReady && !wallet.hasStripeReadyFundingMethod)) {
    return "Choose how your wallet tops up in Wallet: a bank account (free) or a card (with the card fee).";
  }
  if (!wallet.hasCardBackstop) {
    return "Add your backup card in Wallet — it covers an order your balance cannot.";
  }
  if (!wallet.autoReloadConfigured) {
    return "Review and turn on autopay in Wallet.";
  }
  return "Confirm your autopay terms in Wallet.";
}

export interface OnboardingProgress {
  completedCount: number;
  totalCount: number;
  /** Required steps still open; activation needs this to be zero. */
  requiredRemainingCount: number;
}

export function describeOnboardingProgress(steps: readonly DropshipOnboardingStep[]): OnboardingProgress {
  return {
    completedCount: steps.filter((step) => step.status === "complete").length,
    totalCount: steps.length,
    requiredRemainingCount: steps.filter((step) => step.required && step.status !== "complete").length,
  };
}

export interface ActivationView {
  /** The vendor is already active; the button leads to the dashboard instead. */
  alreadyActive: boolean;
  /** Activation would be accepted by the server right now. */
  ready: boolean;
  detail: string;
}

/**
 * Same gates, same order, as the server's `assertOnboardingStateCanActivate`,
 * so the page never offers an activation the server would refuse.
 */
export function describeActivation(onboarding: DropshipOnboardingState): ActivationView {
  if (onboarding.vendor.status === "active") {
    return { alreadyActive: true, ready: false, detail: "Your .ops account is active. Orders from your store are accepted automatically." };
  }
  if (!isOnboardingVendor(onboarding.vendor.status)) {
    return { alreadyActive: false, ready: false, detail: "Activation is not available for your account right now." };
  }
  if (onboarding.entitlement.status !== "active") {
    return { alreadyActive: false, ready: false, detail: "An active .ops membership is required before activation." };
  }
  const remaining = describeOnboardingProgress(onboarding.steps).requiredRemainingCount;
  if (remaining > 0) {
    return {
      alreadyActive: false,
      ready: false,
      detail: remaining === 1 ? "Finish the remaining step above, then activate." : `Finish the ${remaining} remaining steps above, then activate.`,
    };
  }
  return { alreadyActive: false, ready: true, detail: "Everything is in place. Activate to start accepting orders." };
}

export interface AccountSummary {
  title: string;
  detail: string;
}

/**
 * What the Onboarding route shows a vendor who is past onboarding. The
 * checklist no longer applies; the store panel below it still does, because
 * this page is the only place a store can be connected.
 */
export function describeAccountSummary(vendorStatus: string): AccountSummary {
  switch (vendorStatus) {
    case "active":
      return { title: "Your .ops account is active", detail: "Orders from your store are accepted automatically. Your store connection is managed below." };
    case "paused":
      return { title: "Selling is paused", detail: "Your account is paused. Your store connection is managed below." };
    case "lapsed":
    case "suspended":
      return { title: `Your .ops membership is ${formatStatus(vendorStatus).toLowerCase()}`, detail: "Renew it at Card Shellz to keep selling. Your store connection is managed below." };
    case "closed":
      return { title: "This account is closed", detail: "Contact Card Shellz support if you expected to be able to sell." };
    default:
      return { title: `Your account is ${formatStatus(vendorStatus).toLowerCase()}`, detail: "Your store connection is managed below." };
  }
}
