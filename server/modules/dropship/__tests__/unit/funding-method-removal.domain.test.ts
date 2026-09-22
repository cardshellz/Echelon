import { describe, expect, it } from "vitest";
import {
  FUNDING_METHOD_REMOVAL_REFUSAL_CODES,
  decideFundingMethodRemoval,
  type FundingMethodRemovalFacts,
} from "../../domain/funding-method-removal";

function facts(overrides: Partial<FundingMethodRemovalFacts> = {}): FundingMethodRemovalFacts {
  return {
    method: {
      fundingMethodId: 30,
      rail: "stripe_ach",
      status: "active",
      providerCustomerId: "cus_1",
      providerPaymentMethodId: "pm_bank",
    },
    // Autopay points at a third method, so neither fixture holds the source role unless a test says so.
    autoReload: { enabled: true, fundingMethodId: 77 },
    pendingFundingCount: 0,
    otherChargeableCardCount: 1,
    vendorStatus: "active",
    ...overrides,
  };
}

const card = { fundingMethodId: 10, rail: "stripe_card", status: "active", providerCustomerId: "cus_1", providerPaymentMethodId: "pm_card" };

describe("decideFundingMethodRemoval", () => {
  it("archives a bank account that holds no role and has nothing in flight", () => {
    expect(decideFundingMethodRemoval(facts())).toEqual({ outcome: "archive" });
  });

  it("replays a method that is already archived, before any other rule", () => {
    // Even facts that would otherwise refuse do not matter: nothing changes on a replay.
    const decision = decideFundingMethodRemoval(facts({
      method: { ...card, status: "archived" },
      autoReload: { enabled: true, fundingMethodId: 10 },
      pendingFundingCount: 2,
      otherChargeableCardCount: 0,
    }));
    expect(decision).toEqual({ outcome: "replay" });
  });

  it("refuses the enabled autopay source", () => {
    const decision = decideFundingMethodRemoval(facts({ autoReload: { enabled: true, fundingMethodId: 30 } }));
    expect(decision).toMatchObject({
      outcome: "refuse",
      code: "DROPSHIP_FUNDING_METHOD_IS_AUTO_RELOAD_SOURCE",
      context: { fundingMethodId: 30, rail: "stripe_ach", classification: "permanent" },
    });
  });

  it("lets a disabled autopay setting's former source go", () => {
    expect(decideFundingMethodRemoval(facts({ autoReload: { enabled: false, fundingMethodId: 30 } }))).toEqual({ outcome: "archive" });
    expect(decideFundingMethodRemoval(facts({ autoReload: null }))).toEqual({ outcome: "archive" });
  });

  it("refuses while a top-up from the method is still pending", () => {
    const decision = decideFundingMethodRemoval(facts({ pendingFundingCount: 1 }));
    expect(decision).toMatchObject({
      outcome: "refuse",
      code: "DROPSHIP_FUNDING_METHOD_HAS_PENDING_FUNDING",
      context: { pendingFundingCount: 1, classification: "permanent" },
    });
  });

  it("refuses the only chargeable card of a live vendor", () => {
    const decision = decideFundingMethodRemoval(facts({ method: card, otherChargeableCardCount: 0, vendorStatus: "active" }));
    expect(decision).toMatchObject({
      outcome: "refuse",
      code: "DROPSHIP_FUNDING_METHOD_IS_BACKUP_CARD",
      context: { fundingMethodId: 10, rail: "stripe_card", vendorStatus: "active", classification: "permanent" },
    });
  });

  it("lets the only card go while the vendor is not live, and any card when another can be charged", () => {
    for (const vendorStatus of ["onboarding", "paused", "suspended", null]) {
      expect(decideFundingMethodRemoval(facts({ method: card, otherChargeableCardCount: 0, vendorStatus }))).toEqual({ outcome: "archive" });
    }
    expect(decideFundingMethodRemoval(facts({ method: card, otherChargeableCardCount: 1, vendorStatus: "active" }))).toEqual({ outcome: "archive" });
  });

  it("does not treat a card Stripe cannot charge as the backstop", () => {
    // No customer or payment method at the provider: the held-order charge could never pick it.
    const unchargeable = { ...card, providerCustomerId: null };
    expect(decideFundingMethodRemoval(facts({ method: unchargeable, otherChargeableCardCount: 0 }))).toEqual({ outcome: "archive" });
    const failed = { ...card, status: "failed" };
    expect(decideFundingMethodRemoval(facts({ method: failed, otherChargeableCardCount: 0 }))).toEqual({ outcome: "archive" });
  });

  it("checks the autopay role before the pending and backstop rules", () => {
    const decision = decideFundingMethodRemoval(facts({
      method: card,
      autoReload: { enabled: true, fundingMethodId: 10 },
      pendingFundingCount: 3,
      otherChargeableCardCount: 0,
    }));
    expect(decision).toMatchObject({ code: "DROPSHIP_FUNDING_METHOD_IS_AUTO_RELOAD_SOURCE" });
  });

  it("rejects counts that are not whole non-negative numbers", () => {
    expect(() => decideFundingMethodRemoval(facts({ pendingFundingCount: -1 }))).toThrow(TypeError);
    expect(() => decideFundingMethodRemoval(facts({ otherChargeableCardCount: 1.5 }))).toThrow(TypeError);
    expect(() => decideFundingMethodRemoval(facts({ otherChargeableCardCount: Number.NaN }))).toThrow(TypeError);
  });

  it("names every refusal code it can return", () => {
    expect([...FUNDING_METHOD_REMOVAL_REFUSAL_CODES]).toEqual([
      "DROPSHIP_FUNDING_METHOD_IS_AUTO_RELOAD_SOURCE",
      "DROPSHIP_FUNDING_METHOD_HAS_PENDING_FUNDING",
      "DROPSHIP_FUNDING_METHOD_IS_BACKUP_CARD",
    ]);
  });
});
