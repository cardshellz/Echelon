import { describe, expect, it } from "vitest";
import {
  DROPSHIP_LISTING_ACCESS_RESOLUTIONS,
  decideDropshipListingAccess,
  isDropshipListingAccessResolution,
  type DropshipListingAccessDecision,
  type DropshipListingAccessInput,
  type DropshipListingAction,
} from "../listing-access";
import {
  dropshipStoreConnectionStatusEnum,
  dropshipVendorStatusEnum,
} from "../../schema/dropship.schema";

const READY_STORE = { status: "connected", launchReady: true } as const;

function decide(overrides: Partial<DropshipListingAccessInput> = {}): DropshipListingAccessDecision {
  return decideDropshipListingAccess({
    action: "push",
    vendorStatus: "active",
    entitlementStatus: "active",
    store: READY_STORE,
    ...overrides,
  });
}

function blocked(decision: DropshipListingAccessDecision) {
  if (decision.allowed) throw new Error("Expected a blocked decision.");
  return decision;
}

/**
 * The server rule before this module existed, copied from
 * DropshipListingPreviewService.loadStoreContextForAction. The shared rule must
 * make exactly the same allow/block decision and pick the same code.
 */
function previousServerRule(input: DropshipListingAccessInput & { store: { status: string; launchReady: boolean } }):
  string | null {
  const vendorAllowed = input.vendorStatus === "active" || (input.action === "preview" && input.vendorStatus === "onboarding");
  if (!vendorAllowed) return "DROPSHIP_LISTING_VENDOR_BLOCKED";
  if (input.entitlementStatus !== "active") return "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED";
  if (input.store.status !== "connected") return "DROPSHIP_LISTING_STORE_BLOCKED";
  if (!input.store.launchReady) return "DROPSHIP_LISTING_STORE_BLOCKED";
  return null;
}

describe("decideDropshipListingAccess", () => {
  it("allows an active vendor with an active membership and a launch-ready store", () => {
    expect(decide({ action: "preview" })).toEqual({ allowed: true });
    expect(decide({ action: "push" })).toEqual({ allowed: true });
  });

  it("lets an onboarding vendor preview but tells them to activate before pushing", () => {
    expect(decide({ action: "preview", vendorStatus: "onboarding" })).toEqual({ allowed: true });
    const push = blocked(decide({ action: "push", vendorStatus: "onboarding" }));
    expect(push).toMatchObject({ code: "DROPSHIP_LISTING_VENDOR_BLOCKED", resolution: "activate_account" });
    expect(push.message).toBe("Your account isn't active yet, so listings can't be pushed to your store. "
      + "Finish the steps on the Onboarding page and choose Activate .ops.");
  });

  it("sends a paused vendor to the Wallet page for both actions", () => {
    for (const action of ["preview", "push"] as const) {
      const decision = blocked(decide({ action, vendorStatus: "paused" }));
      expect(decision).toMatchObject({ code: "DROPSHIP_LISTING_VENDOR_BLOCKED", resolution: "resolve_pause" });
      expect(decision.message).toContain("The Wallet page shows why and what to do.");
    }
  });

  it("names the membership step for lapsed, suspended and closed accounts", () => {
    expect(blocked(decide({ vendorStatus: "lapsed" }))).toMatchObject({ resolution: "renew_membership" });
    expect(blocked(decide({ vendorStatus: "suspended" }))).toMatchObject({ resolution: "contact_support" });
    expect(blocked(decide({ vendorStatus: "closed" }))).toMatchObject({ resolution: "contact_support" });
    expect(blocked(decide({ vendorStatus: "lapsed" })).message).toContain("Renew it at Card Shellz");
  });

  it("sends an unknown account status to support instead of guessing", () => {
    const decision = blocked(decide({ vendorStatus: "frozen_by_future_code" }));
    expect(decision).toMatchObject({ code: "DROPSHIP_LISTING_VENDOR_BLOCKED", resolution: "contact_support" });
    expect(decision.message).not.toContain("frozen_by_future_code");
  });

  it("tells an active vendor what their membership needs", () => {
    expect(blocked(decide({ entitlementStatus: "grace" }))).toMatchObject({
      code: "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", resolution: "update_membership_payment" });
    expect(blocked(decide({ entitlementStatus: "lapsed" }))).toMatchObject({ resolution: "renew_membership" });
    expect(blocked(decide({ entitlementStatus: "not_entitled" }))).toMatchObject({ resolution: "renew_membership" });
    expect(blocked(decide({ entitlementStatus: "suspended" }))).toMatchObject({ resolution: "contact_support" });
    expect(blocked(decide({ entitlementStatus: "unknown" }))).toMatchObject({ resolution: "contact_support" });
  });

  it("asks for a reconnect for every broken connection state except a Card Shellz pause", () => {
    for (const status of ["needs_reauth", "refresh_failed", "grace_period", "disconnected"]) {
      expect(blocked(decide({ store: { status, launchReady: true } }))).toMatchObject({
        code: "DROPSHIP_LISTING_STORE_BLOCKED", resolution: "reconnect_store" });
    }
    expect(blocked(decide({ store: { status: "paused", launchReady: true } }))).toMatchObject({
      code: "DROPSHIP_LISTING_STORE_BLOCKED", resolution: "contact_support" });
    expect(blocked(decide({ store: { status: "connected", launchReady: false } }))).toMatchObject({
      code: "DROPSHIP_LISTING_STORE_BLOCKED", resolution: "finish_store_setup" });
  });

  it("decides the account alone when no store is chosen yet", () => {
    expect(decide({ store: null })).toEqual({ allowed: true });
    expect(blocked(decide({ store: null, vendorStatus: "onboarding" }))).toMatchObject({ resolution: "activate_account" });
    expect(blocked(decide({ store: null, entitlementStatus: "grace" }))).toMatchObject({ resolution: "update_membership_payment" });
  });

  it("reports the account before the membership, and the membership before the store", () => {
    const everythingWrong = { vendorStatus: "paused", entitlementStatus: "grace", store: { status: "disconnected", launchReady: false } };
    expect(blocked(decide(everythingWrong))).toMatchObject({ resolution: "resolve_pause" });
    expect(blocked(decide({ ...everythingWrong, vendorStatus: "active" }))).toMatchObject({ resolution: "update_membership_payment" });
  });

  it("makes the same allow and block decision, with the same code, as the previous server rule", () => {
    const actions: DropshipListingAction[] = ["preview", "push"];
    const entitlementStatuses = ["active", "grace", "lapsed", "suspended", "not_entitled"];
    let combinations = 0;
    for (const action of actions) {
      for (const vendorStatus of dropshipVendorStatusEnum) {
        for (const entitlementStatus of entitlementStatuses) {
          for (const status of dropshipStoreConnectionStatusEnum) {
            for (const launchReady of [true, false]) {
              const input = { action, vendorStatus, entitlementStatus, store: { status, launchReady } };
              const decision = decideDropshipListingAccess(input);
              expect(decision.allowed ? null : decision.code).toBe(previousServerRule(input));
              combinations += 1;
            }
          }
        }
      }
    }
    expect(combinations).toBe(2 * 6 * 5 * 6 * 2);
  });

  it("gives every block a complete vendor-facing sentence and a known resolution", () => {
    for (const vendorStatus of [...dropshipVendorStatusEnum, "unknown"]) {
      for (const entitlementStatus of ["active", "grace", "lapsed", "suspended", "not_entitled", "unknown"]) {
        for (const store of [READY_STORE, { status: "disconnected", launchReady: true }, { status: "paused", launchReady: true },
          { status: "connected", launchReady: false }]) {
          const decision = decide({ vendorStatus, entitlementStatus, store });
          if (decision.allowed) continue;
          expect(DROPSHIP_LISTING_ACCESS_RESOLUTIONS).toContain(decision.resolution);
          expect(decision.message).toMatch(/^[A-Z].*\.$/);
          expect(decision.message).not.toMatch(/Dropship vendor status|entitlement|launch-ready/);
        }
      }
    }
  });
});

describe("isDropshipListingAccessResolution", () => {
  it("accepts only the published resolutions", () => {
    for (const resolution of DROPSHIP_LISTING_ACCESS_RESOLUTIONS) {
      expect(isDropshipListingAccessResolution(resolution)).toBe(true);
    }
    expect(isDropshipListingAccessResolution("delete_account")).toBe(false);
    expect(isDropshipListingAccessResolution(undefined)).toBe(false);
    expect(isDropshipListingAccessResolution(7)).toBe(false);
  });
});
