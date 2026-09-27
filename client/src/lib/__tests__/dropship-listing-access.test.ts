import { describe, expect, it } from "vitest";
import { DROPSHIP_LISTING_ACCESS_RESOLUTIONS } from "@shared/dropship/listing-access";
import { DropshipApiError } from "../dropship-ops-surface";
import {
  DROPSHIP_SUPPORT_EMAIL,
  OPS_MEMBERSHIP_URL,
  describeListingAccess,
  listingAccessLink,
  listingAccessNoticeFromError,
} from "../dropship-listing-access";

const ACTIVE = { status: "active", entitlementStatus: "active" };

describe("describeListingAccess", () => {
  it("says nothing until the account has loaded, and nothing when listing is allowed", () => {
    expect(describeListingAccess(null, "push")).toBeNull();
    expect(describeListingAccess(undefined, "preview")).toBeNull();
    expect(describeListingAccess(ACTIVE, "preview")).toBeNull();
    expect(describeListingAccess(ACTIVE, "push")).toBeNull();
  });

  it("lets an onboarding vendor preview and sends them to Onboarding to activate before pushing", () => {
    const account = { status: "onboarding", entitlementStatus: "active" };
    expect(describeListingAccess(account, "preview")).toBeNull();
    expect(describeListingAccess(account, "push")).toEqual({
      message: "Your account isn't active yet, so listings can't be pushed to your store. "
        + "Finish the steps on the Onboarding page and choose Activate .ops.",
      resolution: "activate_account",
      link: { label: "Go to Onboarding", href: "/onboarding", external: false },
    });
  });

  it("points each blocked account at the page that fixes it", () => {
    expect(describeListingAccess({ status: "paused", entitlementStatus: "active" }, "preview")?.link)
      .toEqual({ label: "Go to Wallet", href: "/wallet", external: false });
    expect(describeListingAccess({ status: "lapsed", entitlementStatus: "lapsed" }, "push")?.link)
      .toEqual({ label: "Renew .ops", href: OPS_MEMBERSHIP_URL, external: true });
    expect(describeListingAccess({ status: "suspended", entitlementStatus: "suspended" }, "push")?.link)
      .toEqual({ label: "Email Card Shellz support", href: `mailto:${DROPSHIP_SUPPORT_EMAIL}`, external: true });
  });

  it("names the payment step without inventing a link when the membership is past due", () => {
    const notice = describeListingAccess({ status: "active", entitlementStatus: "grace" }, "push");
    expect(notice).toMatchObject({ resolution: "update_membership_payment", link: null });
    expect(notice?.message).toContain("Update your payment at Card Shellz");
  });
});

describe("listingAccessLink", () => {
  it("has a decision for every resolution the shared rule can return", () => {
    const links = Object.fromEntries(DROPSHIP_LISTING_ACCESS_RESOLUTIONS.map((resolution) => [resolution, listingAccessLink(resolution)]));
    expect(links).toEqual({
      activate_account: { label: "Go to Onboarding", href: "/onboarding", external: false },
      resolve_pause: { label: "Go to Wallet", href: "/wallet", external: false },
      renew_membership: { label: "Renew .ops", href: OPS_MEMBERSHIP_URL, external: true },
      update_membership_payment: null,
      contact_support: { label: "Email Card Shellz support", href: `mailto:${DROPSHIP_SUPPORT_EMAIL}`, external: true },
      reconnect_store: { label: "Go to store connection", href: "/onboarding", external: false },
      finish_store_setup: { label: "Go to store connection", href: "/onboarding", external: false },
    });
  });
});

describe("listingAccessNoticeFromError", () => {
  function refused(code: string, context: Record<string, unknown> | null, message = "Server message.") {
    return new DropshipApiError({ message, status: 403, code, context });
  }

  it("reads the server's block and message back out of a refused request", () => {
    const error = refused("DROPSHIP_LISTING_VENDOR_BLOCKED", { resolution: "resolve_pause", vendorStatus: "paused" },
      "Selling is paused on your account, so listings can't be previewed or pushed. The Wallet page shows why and what to do.");
    expect(listingAccessNoticeFromError(error)).toEqual({
      message: "Selling is paused on your account, so listings can't be previewed or pushed. The Wallet page shows why and what to do.",
      resolution: "resolve_pause",
      link: { label: "Go to Wallet", href: "/wallet", external: false },
    });
    expect(listingAccessNoticeFromError(refused("DROPSHIP_LISTING_STORE_BLOCKED", { resolution: "reconnect_store" }))?.link?.href)
      .toBe("/onboarding");
  });

  it("ignores other failures and blocks from a server that sends no known resolution", () => {
    expect(listingAccessNoticeFromError(refused("DROPSHIP_STEP_UP_REQUIRED", { resolution: "activate_account" }))).toBeNull();
    expect(listingAccessNoticeFromError(refused("DROPSHIP_LISTING_VENDOR_BLOCKED", null))).toBeNull();
    expect(listingAccessNoticeFromError(refused("DROPSHIP_LISTING_VENDOR_BLOCKED", { resolution: "delete_account" }))).toBeNull();
    expect(listingAccessNoticeFromError(new Error("DROPSHIP_LISTING_VENDOR_BLOCKED"))).toBeNull();
    expect(listingAccessNoticeFromError(null)).toBeNull();
  });
});
