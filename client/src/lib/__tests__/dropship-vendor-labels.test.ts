import { describe, expect, it } from "vitest";
import { DROPSHIP_NOTIFICATION_EVENT_TYPES } from "../../../../server/modules/dropship/application/dropship-notification-events";
import {
  DROPSHIP_SITE_UPDATING_CODE,
  DROPSHIP_SITE_UPDATING_MESSAGE,
  DropshipApiError,
  allDropshipOpsOrderIntakeStatuses,
  allDropshipRmaStatuses,
  formatStatus,
} from "../dropship-ops-surface";
import {
  VENDOR_ERROR_FALLBACK,
  VENDOR_NOTIFICATION_EVENT_LABELS,
  VENDOR_PASSKEY_CANCELLED,
  VENDOR_WAITING_FOR_STOCK_LABEL,
  VENDOR_WAITING_FOR_STOCK_LINE,
  WAITING_FOR_STOCK_BLOCKER,
  humanizeCode,
  isVendorWaitingForStock,
  vendorAccountStatusLabel,
  vendorErrorMessage,
  vendorLedgerEntryLabel,
  vendorLedgerStatusLabel,
  vendorListingPreviewStatusLabel,
  vendorMarketplaceOrderLabel,
  vendorNotificationChannelLabel,
  vendorNotificationEventLabel,
  vendorOrderStatusLabel,
  vendorPaymentFailureLine,
  vendorPlatformName,
  vendorReturnFaultLabel,
  vendorReturnLabelSourceLabel,
  vendorReturnReasonLabel,
  vendorReturnStatusLabel,
  vendorSettingsBlockerLabel,
  vendorSetupCheckDetail,
  vendorStoreConnectionLine,
  vendorStoreReadinessDetail,
  vendorStoreStatusLabel,
} from "../dropship-vendor-labels";

/** Words that read as a code or as engineering, never as a vendor's words. */
const CODE_LIKE = /_|\bEbay\b|\bintake\b|\btoken\b|\bpayload\b|\bOMS\b/;

const connection = {
  platform: "ebay",
  status: "connected",
  setupStatus: "ready",
  hasAccessToken: true,
  hasRefreshToken: true,
  launchReady: true,
};

describe("vendor labels: platforms", () => {
  it("names the marketplaces as their owners do, never as the stored code", () => {
    expect(vendorPlatformName("ebay")).toBe("eBay");
    expect(vendorPlatformName("shopify")).toBe("Shopify");
    expect(vendorPlatformName(null)).toBe("Marketplace");
    // Staff keep formatStatus, unchanged.
    expect(formatStatus("ebay")).toBe("Ebay");
  });

  it("names an order by its marketplace order number, else just the marketplace", () => {
    expect(vendorMarketplaceOrderLabel({ platform: "ebay", externalOrderNumber: "12-34567-89012", externalOrderId: "x" }))
      .toBe("eBay order #12-34567-89012");
    expect(vendorMarketplaceOrderLabel({ platform: "ebay", externalOrderNumber: null, externalOrderId: "EXT-9" })).toBe("eBay order #EXT-9");
    expect(vendorMarketplaceOrderLabel({ platform: "ebay", externalOrderNumber: "  ", externalOrderId: "" })).toBe("eBay order");
  });
});

describe("vendor labels: statuses", () => {
  it("gives every order status the filter offers a plain label", () => {
    for (const status of allDropshipOpsOrderIntakeStatuses) {
      expect(vendorOrderStatusLabel(status)).not.toMatch(CODE_LIKE);
    }
    expect(vendorOrderStatusLabel("payment_hold")).toBe("Waiting on payment");
    expect(vendorOrderStatusLabel("received")).toBe("New");
  });

  it("gives every return status a plain label", () => {
    for (const status of allDropshipRmaStatuses) {
      expect(vendorReturnStatusLabel(status)).not.toMatch(CODE_LIKE);
    }
    expect(vendorReturnStatusLabel("in_transit")).toBe("On its way back");
  });

  it("reads an unknown code as sentence-case words, never as the code", () => {
    expect(humanizeCode("label_printed")).toBe("Label printed");
    expect(humanizeCode("")).toBe("Unknown");
    expect(humanizeCode(null)).toBe("Unknown");
    expect(vendorOrderStatusLabel("something_new")).toBe("Something new");
  });

  it("says grace period and lapsed membership in plain words", () => {
    expect(vendorStoreStatusLabel("grace_period")).toBe("Disconnecting soon");
    expect(vendorStoreStatusLabel("needs_reauth")).toBe("Needs reconnecting");
    expect(vendorAccountStatusLabel("lapsed")).toBe("Membership lapsed");
    expect(vendorAccountStatusLabel("onboarding")).toBe("Getting started");
  });

  it("shows the vendor a ledger row's reason in the Wallet's words, with no ids", () => {
    expect(vendorLedgerEntryLabel({ type: "order_debit", referenceType: "dropship_order_intake" })).toBe("Order");
    expect(vendorLedgerEntryLabel({ type: "return_credit" })).toBe("Return credit");
    expect(vendorLedgerEntryLabel({ type: "funding", reason: "manual_top_up" })).toBe("Money you added");
    // A served reason the page does not know is ignored, not shown.
    expect(vendorLedgerEntryLabel({ type: "funding", reason: "something_else", metadata: null })).toBe("Other");
    expect(vendorLedgerStatusLabel("voided")).toBe("Cancelled");
  });

  it("says why a wallet payment failed without the decline code", () => {
    expect(vendorPaymentFailureLine({ code: "card_declined", message: "Your card was declined." }))
      .toBe("Payment failed. Your card was declined.");
    expect(vendorPaymentFailureLine({ code: "INSUFFICIENT_FUNDS", message: null }))
      .toBe("Payment failed. There wasn't enough money in the account.");
    const unknown = vendorPaymentFailureLine({ code: "R29", message: "ACH return R29" });
    expect(unknown).toBe("Payment failed. Contact your bank, or try another payment method.");
    expect(unknown).not.toContain("R29");
  });
});

describe("vendor labels: returns", () => {
  it("labels the fault, and shows a typed reason or label source as typed", () => {
    expect(vendorReturnFaultLabel("card_shellz")).toBe("Card Shellz");
    expect(vendorReturnReasonLabel("wrong_item")).toBe("Wrong item");
    expect(vendorReturnReasonLabel("Box arrived crushed (DOA)")).toBe("Box arrived crushed (DOA)");
    expect(vendorReturnReasonLabel(null)).toBe("Not given");
    expect(vendorReturnLabelSourceLabel("ops")).toBe("Card Shellz");
    expect(vendorReturnLabelSourceLabel("USPS via eBay")).toBe("USPS via eBay");
  });
});

describe("vendor labels: store connection", () => {
  it("says connected, or what to do, never which token is missing", () => {
    expect(vendorStoreConnectionLine(connection)).toBe("eBay connection: Connected");
    const noRefresh = { ...connection, hasRefreshToken: false, launchReady: false };
    expect(vendorStoreConnectionLine(noRefresh)).toBe("eBay connection: Needs reconnecting");
    expect(vendorStoreReadinessDetail(noRefresh)).toBe("Reconnect your eBay store.");
    expect(vendorStoreReadinessDetail({ ...connection, hasAccessToken: false })).toBe("Reconnect your eBay store.");
    expect(vendorStoreReadinessDetail({ ...connection, setupStatus: "pending" })).toBe("eBay setup: setting up");
    expect(vendorStoreReadinessDetail({ ...connection, status: "grace_period" })).toBe("Disconnecting soon");
    // Shopify has no refresh token, and needs none.
    expect(vendorStoreConnectionLine({ ...connection, platform: "shopify", hasRefreshToken: false, launchReady: false }))
      .toBe("Shopify connection: Still setting up");
  });

  it("turns every settings blocker the server builds into a plain sentence", () => {
    for (const blocker of [
      "store_connection_required", "store_access_token_required", "store_refresh_token_required",
      "store_needs_reauth", "store_refresh_failed", "store_grace_period", "store_paused", "store_disconnected",
      "setup_pending", "setup_attention_required", "store_platform_amazon",
      "auto_reload_required", "auto_reload_funding_method_required", "stripe_funding_method_required",
      "vendor_paused", "entitlement_grace", "entitlement_lapsed", "entitlement_suspended", "entitlement_not_entitled",
      "entitlement_something_new", "contact_email_required",
    ]) {
      const words = vendorSettingsBlockerLabel(blocker);
      expect(words, blocker).toMatch(/\.$/);
      expect(words, blocker).not.toMatch(/_|Token|Stripe|Entitlement|Setup Pending/);
    }
    expect(vendorSettingsBlockerLabel("store_refresh_token_required")).toBe("Reconnect your eBay store.");
  });

  it("shows no raw message for a setup check it does not know", () => {
    expect(vendorSetupCheckDetail("store_auth_health")).toMatch(/^Reconnect your store/);
    expect(vendorSetupCheckDetail("unknown_check")).toBeNull();
  });
});

describe("vendor labels: alerts", () => {
  it("has a vendor label for every notification event the server sends", () => {
    for (const eventType of DROPSHIP_NOTIFICATION_EVENT_TYPES) {
      expect(Object.hasOwn(VENDOR_NOTIFICATION_EVENT_LABELS, eventType), eventType).toBe(true);
      expect(vendorNotificationEventLabel(eventType)).not.toMatch(/Dropship|_/);
    }
    expect(vendorNotificationEventLabel("dropship_order_payment_hold")).toBe("Order needs payment");
    expect(vendorNotificationEventLabel("dropship_brand_new_event")).toBe("Brand new event");
  });

  it("names the delivery channels", () => {
    expect(vendorNotificationChannelLabel("in_app")).toBe("In the portal");
    expect(vendorNotificationChannelLabel("email")).toBe("Email");
  });
});

describe("vendorErrorMessage", () => {
  it("never shows a server message or an HTTP status", () => {
    const raw = new DropshipApiError({ message: "Dropship ops surface input failed validation.", status: 400, code: "DROPSHIP_UNMAPPED_CODE" });
    expect(vendorErrorMessage(raw)).toBe(VENDOR_ERROR_FALLBACK);
    expect(vendorErrorMessage(new DropshipApiError({ message: "Request failed with 500", status: 500 }))).toBe(VENDOR_ERROR_FALLBACK);
    expect(vendorErrorMessage(new Error("intakeId must be a positive integer."))).toBe(VENDOR_ERROR_FALLBACK);
    expect(vendorErrorMessage("nope")).toBe(VENDOR_ERROR_FALLBACK);
    expect(VENDOR_ERROR_FALLBACK).toBe("Something went wrong. Try again, or contact Card Shellz support.");
  });

  it("uses the page's own fallback when it gives one", () => {
    expect(vendorErrorMessage(new Error("boom"), "We couldn't load your orders. Reload the page to try again."))
      .toBe("We couldn't load your orders. Reload the page to try again.");
  });

  it("shows vendor words for the codes a vendor can act on", () => {
    const login = new DropshipApiError({ message: "Invalid dropship login credentials.", status: 401, code: "DROPSHIP_INVALID_LOGIN" });
    expect(vendorErrorMessage(login, "page fallback")).toBe("That email or password isn't right.");
    const limited = new DropshipApiError({ message: "Too many dropship auth requests.", status: 429, code: "DROPSHIP_AUTH_RATE_LIMITED" });
    expect(vendorErrorMessage(limited)).toBe("Too many tries. Wait a few minutes and try again.");
    const invalid = new DropshipApiError({ message: "Dropship auth request failed validation.", status: 400, code: "DROPSHIP_INVALID_AUTH_REQUEST" });
    expect(vendorErrorMessage(invalid)).toBe("Check what you entered and try again.");
    const updating = new DropshipApiError({ message: "x", status: 503, code: DROPSHIP_SITE_UPDATING_CODE });
    expect(vendorErrorMessage(updating)).toBe(DROPSHIP_SITE_UPDATING_MESSAGE);
  });

  it("prefers the page's own words for a code over the shared ones", () => {
    const error = new DropshipApiError({ message: "x", status: 401, code: "DROPSHIP_INVALID_LOGIN" });
    expect(vendorErrorMessage(error, VENDOR_ERROR_FALLBACK, { DROPSHIP_INVALID_LOGIN: "Page words." })).toBe("Page words.");
  });

  it("says a closed passkey prompt was cancelled", () => {
    const cancelled = Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
    expect(vendorErrorMessage(cancelled)).toBe(VENDOR_PASSKEY_CANCELLED);
  });
});

describe("waiting for stock (owner report)", () => {
  it("names a blocked eBay size whose only blocker is stock, and nothing else", () => {
    expect(WAITING_FOR_STOCK_BLOCKER).toBe("marketplace_quantity_unavailable");
    expect(VENDOR_WAITING_FOR_STOCK_LABEL).toBe("Waiting for stock");
    expect(VENDOR_WAITING_FOR_STOCK_LINE).toBe("Waiting for stock. It lists by itself when stock comes back.");
    const facts = { platform: "ebay", blockers: [WAITING_FOR_STOCK_BLOCKER] };
    expect(isVendorWaitingForStock({ ...facts, status: "blocked" })).toBe(true);
    expect(isVendorWaitingForStock({ platform: "ebay", status: "blocked", blockers: [` ${WAITING_FOR_STOCK_BLOCKER}`, WAITING_FOR_STOCK_BLOCKER, ""] })).toBe(true);
    // Another blocker as well: stock alone would not list it, so its own words stay.
    expect(isVendorWaitingForStock({ platform: "ebay", status: "blocked", blockers: [WAITING_FOR_STOCK_BLOCKER, "vendor_retail_price_required"] })).toBe(false);
    expect(isVendorWaitingForStock({ ...facts, status: "failed" })).toBe(false);
    expect(isVendorWaitingForStock({ ...facts, status: "ready" })).toBe(false);
    // Only eBay stores are relisted by themselves.
    expect(isVendorWaitingForStock({ platform: "shopify", status: "blocked", blockers: [WAITING_FOR_STOCK_BLOCKER] })).toBe(false);
    expect(isVendorWaitingForStock({ platform: "ebay", status: "blocked", blockers: [] })).toBe(false);
  });

  it("reads a preview row's status in those words, and every other status as before", () => {
    expect(vendorListingPreviewStatusLabel("blocked", { platform: "ebay", blockers: [WAITING_FOR_STOCK_BLOCKER] })).toBe("Waiting for stock");
    expect(vendorListingPreviewStatusLabel("blocked", { platform: "ebay", blockers: ["listing_config_inactive"] })).toBe("Can't list yet");
    expect(vendorListingPreviewStatusLabel("blocked")).toBe("Can't list yet");
    expect(vendorListingPreviewStatusLabel("ready", { platform: "ebay", blockers: [] })).toBe("Ready");
    expect(vendorListingPreviewStatusLabel("warning", { platform: "ebay", blockers: [] })).toBe("Check this");
  });
});
