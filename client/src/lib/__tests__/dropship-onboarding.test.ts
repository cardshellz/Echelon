import { describe, expect, it } from "vitest";
import type { DropshipOnboardingState, DropshipOnboardingStep } from "../dropship-ops-surface";
import {
  describeAccountSummary,
  describeActivation,
  describeOnboardingProgress,
  describeOnboardingStep,
  isOnboardingVendor,
} from "../dropship-onboarding";

type Overrides = {
  vendor?: Partial<DropshipOnboardingState["vendor"]>;
  entitlement?: Partial<DropshipOnboardingState["entitlement"]>;
  storeConnections?: Partial<DropshipOnboardingState["storeConnections"]>;
  catalog?: Partial<DropshipOnboardingState["catalog"]>;
  wallet?: Partial<DropshipOnboardingState["wallet"]>;
  steps?: DropshipOnboardingStep[];
};

const STEP_LABELS: Record<DropshipOnboardingStep["key"], string> = {
  vendor_profile: "Vendor profile",
  store_connection: "Store connection",
  catalog_available: "Card Shellz catalog",
  catalog_selection: "Catalog selection",
  wallet_payment: "Wallet and auto-reload",
};

function step(key: DropshipOnboardingStep["key"], status: DropshipOnboardingStep["status"] = "incomplete"): DropshipOnboardingStep {
  return { key, label: STEP_LABELS[key], status, required: true };
}

function state(overrides: Overrides = {}): DropshipOnboardingState {
  return {
    vendor: {
      vendorId: 1, memberId: "m-1", businessName: "Vendor", contactName: null, email: "vendor@example.com", phone: null,
      status: "onboarding", entitlementStatus: "active", membershipGraceEndsAt: null, includedStoreConnections: 1,
      standingReason: null, pausedAt: null, ...overrides.vendor,
    },
    entitlement: {
      memberId: "m-1", cardShellzEmail: "vendor@example.com", status: "active", planId: "ops", planName: "Ops",
      subscriptionId: "sub-1", includesDropship: true, reasonCode: "active", ...overrides.entitlement,
    },
    storeConnections: {
      activeCount: 0, connectedCount: 0, launchReadyConnectedCount: 0, credentialAttentionCount: 0, needsAttentionCount: 0,
      totalCount: 0, includedLimit: 1, canConnectStore: true, ...overrides.storeConnections,
    },
    catalog: { adminExposureRuleCount: 0, vendorSelectionRuleCount: 0, adminCatalogAvailable: false, hasVendorSelection: false, ...overrides.catalog },
    wallet: {
      availableBalanceCents: 0, pendingBalanceCents: 0, activeFundingMethodCount: 0, activeStripeFundingMethodCount: 0,
      activeStripeCardFundingMethodCount: 0, activeUsdcBaseFundingMethodCount: 0, autoReloadEnabled: false,
      autoReloadFundingMethodId: null, autoReloadFundingMethodActive: false, autoReloadFundingMethodReady: false,
      autoReloadFundingMethodIsCard: false, hasActiveFundingMethod: false, hasStripeReadyFundingMethod: false,
      hasUsdcBaseFundingMethod: false, hasCardBackstop: false, autoReloadConfigured: false, hasSpendableBalance: false,
      walletReady: false, ...overrides.wallet,
    },
    steps: overrides.steps ?? [
      step("vendor_profile", "complete"),
      step("store_connection"),
      step("catalog_available"),
      step("catalog_selection"),
      step("wallet_payment"),
    ],
  };
}

describe("isOnboardingVendor", () => {
  it("is true only for the onboarding status", () => {
    expect(isOnboardingVendor("onboarding")).toBe(true);
    for (const status of ["active", "paused", "lapsed", "suspended", "closed", ""]) {
      expect(isOnboardingVendor(status)).toBe(false);
    }
  });
});

describe("describeOnboardingStep", () => {
  it("gives the store row a button that reveals the connect panel until a store is launch ready", () => {
    const fresh = describeOnboardingStep(step("store_connection"), state());
    expect(fresh).toMatchObject({ tone: "todo", badge: "To do", detail: "Connect your eBay or Shopify store below.", action: { kind: "store_panel", label: "Connect store" } });

    const needsAttention = describeOnboardingStep(step("store_connection"), state({ storeConnections: { connectedCount: 1, credentialAttentionCount: 1 } }));
    expect(needsAttention.detail).toContain("credentials need attention");
    expect(needsAttention.action).toEqual({ kind: "store_panel", label: "Fix store connection" });

    const notReady = describeOnboardingStep(step("store_connection"), state({ storeConnections: { connectedCount: 1 } }));
    expect(notReady.action).toEqual({ kind: "store_panel", label: "Check store connection" });

    const ready = describeOnboardingStep(step("store_connection", "complete"), state({ storeConnections: { connectedCount: 1, launchReadyConnectedCount: 1 } }));
    expect(ready).toMatchObject({ tone: "complete", badge: "Complete", detail: "Your store is connected and launch ready.", action: null });
  });

  it("shows catalog access as waiting on Card Shellz, never as a task with no button", () => {
    const waiting = describeOnboardingStep(step("catalog_available"), state());
    expect(waiting).toMatchObject({ tone: "waiting", badge: "Waiting on Card Shellz", action: null });
    expect(waiting.detail).toBe("Card Shellz sets up your catalog access. Nothing for you to do yet.");

    const open = describeOnboardingStep(step("catalog_available", "complete"), state({ catalog: { adminCatalogAvailable: true, adminExposureRuleCount: 1 } }));
    expect(open).toMatchObject({ tone: "complete", detail: "Card Shellz has opened the catalog to you.", action: null });
  });

  it("sends the catalog selection row to Catalog, worded for whether the catalog is open yet", () => {
    expect(describeOnboardingStep(step("catalog_selection"), state()).detail).toBe("Pick products once Card Shellz opens the catalog.");
    const openCatalog = describeOnboardingStep(step("catalog_selection"), state({ catalog: { adminCatalogAvailable: true } }));
    expect(openCatalog).toMatchObject({ tone: "todo", detail: "Pick the products you want to sell.", action: { kind: "navigate", label: "Choose products", path: "/catalog" } });

    const done = describeOnboardingStep(step("catalog_selection", "complete"), state({ catalog: { vendorSelectionRuleCount: 1, hasVendorSelection: true } }));
    expect(done.detail).toBe("1 product selection rule saved. Change them any time in Catalog.");
    expect(done.action).toEqual({ kind: "navigate", label: "Open catalog", path: "/catalog" });
    expect(describeOnboardingStep(step("catalog_selection", "complete"), state({ catalog: { vendorSelectionRuleCount: 3 } })).detail).toContain("3 product selection rules saved");
  });

  it("names the first missing wallet piece: backup card, then auto-reload", () => {
    const empty = describeOnboardingStep(step("wallet_payment"), state());
    expect(empty).toMatchObject({ tone: "todo", action: { kind: "navigate", label: "Set up wallet", path: "/wallet" } });
    expect(empty.detail).toBe("Add your backup card in Wallet, then choose how to keep the wallet topped up.");

    const bankOnly = describeOnboardingStep(step("wallet_payment"), state({ wallet: { hasActiveFundingMethod: true } }));
    expect(bankOnly.detail).toContain("the card covers an order your balance cannot");

    const cardOnly = describeOnboardingStep(step("wallet_payment"), state({ wallet: { hasActiveFundingMethod: true, hasCardBackstop: true } }));
    expect(cardOnly.detail).toBe("Turn on auto-reload in Wallet: pick a bank account or your card to keep the balance topped up.");

    const ready = describeOnboardingStep(step("wallet_payment", "complete"), state({ wallet: { hasCardBackstop: true, autoReloadConfigured: true, walletReady: true } }));
    expect(ready).toMatchObject({ tone: "complete", detail: "Backup card on file and auto-reload on. Nothing is charged until you accept an order.", action: { kind: "navigate", label: "Open wallet", path: "/wallet" } });

    const funded = describeOnboardingStep(step("wallet_payment", "complete"), state({ wallet: { hasCardBackstop: true, autoReloadConfigured: true, walletReady: true, hasSpendableBalance: true, availableBalanceCents: 12_345 } }));
    expect(funded.detail).toBe("$123.45 available. Backup card on file and auto-reload on.");
  });

  it("marks every blocked step as blocked with no button, and explains the membership on the profile row", () => {
    const profile = describeOnboardingStep(step("vendor_profile", "blocked"), state({ vendor: { status: "lapsed" } }));
    expect(profile).toMatchObject({ tone: "blocked", badge: "Blocked", action: null });
    expect(profile.detail).toContain("no longer active");
    const wallet = describeOnboardingStep(step("wallet_payment", "blocked"), state({ vendor: { status: "lapsed" } }));
    expect(wallet).toMatchObject({ tone: "blocked", detail: "Unavailable while your .ops membership is inactive.", action: null });
  });

  it("treats the vendor profile as automatic", () => {
    expect(describeOnboardingStep(step("vendor_profile", "complete"), state())).toMatchObject({ tone: "complete", action: null, detail: "Your Card Shellz .ops membership is active." });
  });
});

describe("describeOnboardingProgress", () => {
  it("counts complete steps and the required ones still open", () => {
    expect(describeOnboardingProgress(state().steps)).toEqual({ completedCount: 1, totalCount: 5, requiredRemainingCount: 4 });
    const optionalOpen = [step("vendor_profile", "complete"), { ...step("wallet_payment"), required: false }];
    expect(describeOnboardingProgress(optionalOpen)).toEqual({ completedCount: 1, totalCount: 2, requiredRemainingCount: 0 });
  });
});

describe("describeActivation", () => {
  const allDone = state().steps.map((entry) => ({ ...entry, status: "complete" as const }));

  it("follows the server's gates in order: status, membership, then the steps", () => {
    expect(describeActivation(state({ vendor: { status: "active" } }))).toMatchObject({ alreadyActive: true, ready: false });
    expect(describeActivation(state({ vendor: { status: "paused" } }))).toMatchObject({ alreadyActive: false, ready: false, detail: "Activation is not available for your account right now." });
    expect(describeActivation(state({ entitlement: { status: "lapsed" }, steps: allDone }))).toMatchObject({ ready: false, detail: "An active .ops membership is required before activation." });
    expect(describeActivation(state())).toMatchObject({ ready: false, detail: "Finish the 4 remaining steps above, then activate." });
    expect(describeActivation(state({ steps: [...allDone.slice(0, 4), step("wallet_payment")] })).detail).toBe("Finish the remaining step above, then activate.");
    expect(describeActivation(state({ steps: allDone }))).toEqual({ alreadyActive: false, ready: true, detail: "Everything is in place. Activate to start accepting orders." });
  });
});

describe("describeAccountSummary", () => {
  it("tells a vendor past onboarding where they stand and that the store panel still applies", () => {
    expect(describeAccountSummary("active").title).toBe("Your .ops account is active");
    expect(describeAccountSummary("paused").title).toBe("Selling is paused");
    expect(describeAccountSummary("lapsed").title).toBe("Your .ops membership is lapsed");
    expect(describeAccountSummary("suspended").detail).toContain("Renew it at Card Shellz");
    expect(describeAccountSummary("closed").title).toBe("This account is closed");
    expect(describeAccountSummary("something_new").title).toBe("Your account is something new");
  });
});
