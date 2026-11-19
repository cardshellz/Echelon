import { describe, expect, it } from "vitest";
import { LISTING_END_REQUEST_STATES, LISTING_END_STAFF_ACTIONS } from "../../../../../shared/dropship/listing-end-ops";
import {
  decideListingEndStaffAction,
  decideListingEndStaffRecovery,
  listingEndStaffRecoveryCheck,
} from "../../domain/listing-end-staff";

/** The resolved identity the claim writes (the retirement view's Dropship identity, §5.4). */
const IDENTITY = {
  destinationKind: "dropship_store_connection", connectionId: 801, channelId: null, vendorId: 70, provider: "ebay",
  accountId: "seller-801", environment: "production", market: "EBAY_US", productId: 7001, productVariantId: 70011,
  externalSku: "S-70011", externalProductId: "L-801-70011", externalVariantId: "O-801-70011", externalInventoryItemId: null,
  identityConflict: false,
};

describe("decideListingEndStaffAction (PLAN-C v4.1 §10; TST-5)", () => {
  it("applies an action to a failed request with a new key", () => {
    for (const action of LISTING_END_STAFF_ACTIONS) {
      expect(decideListingEndStaffAction({ state: "failed", staffAction: null, staffActionKey: null }, { action, idempotencyKey: "key-0001" }))
        .toEqual({ outcome: "apply" });
    }
  });

  it("answers the same key and action again whatever the state is now (a lost answer), and nothing else", () => {
    for (const state of LISTING_END_REQUEST_STATES) {
      expect(decideListingEndStaffAction({ state, staffAction: "retry", staffActionKey: "key-0001" },
        { action: "retry", idempotencyKey: "key-0001" })).toEqual({ outcome: "replay" });
    }
  });

  it("refuses the same key for another action: keys are scoped by action", () => {
    expect(decideListingEndStaffAction({ state: "ended", staffAction: "resolve_ended", staffActionKey: "key-0001" },
      { action: "resolve_left", idempotencyKey: "key-0001" })).toEqual({ outcome: "refused", reason: "key_reused" });
    expect(decideListingEndStaffAction({ state: "pending", staffAction: "retry", staffActionKey: "key-0001" },
      { action: "resolve_ended", idempotencyKey: "key-0001" })).toEqual({ outcome: "refused", reason: "key_reused" });
  });

  it("refuses every state but failed for a new key, including a failed-again request after an earlier Retry", () => {
    for (const state of LISTING_END_REQUEST_STATES.filter((value) => value !== "failed")) {
      expect(decideListingEndStaffAction({ state, staffAction: null, staffActionKey: null }, { action: "retry", idempotencyKey: "key-0002" }))
        .toEqual({ outcome: "refused", reason: "state_invalid" });
    }
    // A Retry, then the worker failed it again: a new key may act on it again.
    expect(decideListingEndStaffAction({ state: "failed", staffAction: "retry", staffActionKey: "key-0001" },
      { action: "retry", idempotencyKey: "key-0002" })).toEqual({ outcome: "apply" });
  });
});

describe("listingEndStaffRecoveryCheck (SAF-3 b)", () => {
  it("asks recovery about the admission's own SKU scope when the claim resolved an identity", () => {
    expect(listingEndStaffRecoveryCheck({ resolvedIdentity: IDENTITY, withdrawCallCount: 1, withdrawRequestedAt: new Date() })).toEqual({
      kind: "scope",
      scope: { destinationKind: "dropship_store_connection", connectionId: 801, providerKey: "ebay", providerScopeType: "account",
        externalScopeId: "seller-801", externalInventoryItemId: "S-70011", productId: null, productVariantId: null },
    });
    // Even a request that never sent: another writer's open request on the SKU would refuse the withdraw too.
    expect(listingEndStaffRecoveryCheck({ resolvedIdentity: IDENTITY, withdrawCallCount: 0, withdrawRequestedAt: null }).kind).toBe("scope");
  });

  it("needs no check when the claim never resolved an identity and nothing was sent", () => {
    expect(listingEndStaffRecoveryCheck({ resolvedIdentity: null, withdrawCallCount: 0, withdrawRequestedAt: null })).toEqual({ kind: "nothing_sent" });
  });

  it("fails closed on a request that recorded a withdraw but has no readable identity", () => {
    expect(listingEndStaffRecoveryCheck({ resolvedIdentity: null, withdrawCallCount: 1, withdrawRequestedAt: null }))
      .toEqual({ kind: "identity_unreadable" });
    expect(listingEndStaffRecoveryCheck({ resolvedIdentity: null, withdrawCallCount: 0, withdrawRequestedAt: new Date() }))
      .toEqual({ kind: "identity_unreadable" });
    expect(listingEndStaffRecoveryCheck({ resolvedIdentity: { ...IDENTITY, externalSku: null }, withdrawCallCount: 0, withdrawRequestedAt: null }))
      .toEqual({ kind: "identity_unreadable" });
  });
});

describe("decideListingEndStaffRecovery", () => {
  it("goes on only when recovery is clear; unresolved attempts are named; a busy answer never reads as clear", () => {
    expect(decideListingEndStaffRecovery({ resolved: ["7"], unresolved: [], busy: false })).toEqual({ outcome: "clear" });
    expect(decideListingEndStaffRecovery({ resolved: [], unresolved: ["9", "11"], busy: false }))
      .toEqual({ outcome: "unresolved", attemptIds: ["9", "11"] });
    expect(decideListingEndStaffRecovery({ resolved: [], unresolved: ["11"], busy: true })).toEqual({ outcome: "unresolved", attemptIds: ["11"] });
    expect(decideListingEndStaffRecovery({ resolved: [], unresolved: [], busy: true })).toEqual({ outcome: "busy" });
  });
});
