/**
 * Unit tests for extractMarketingConsent (pure — no mocks, no IO).
 *
 * The invariant under protection: this extractor NEVER invents a
 * subscription. Every path that is not an explicit, recognised opt-in must
 * come back as something other than "subscribed", because the CRM turns
 * "subscribed" into a consent-ledger grant and starts mailing the person.
 */
import { describe, it, expect } from "vitest";

import { extractMarketingConsent } from "../../marketing-consent";

describe("extractMarketingConsent", () => {
  it("reads Shopify's structured email consent object", () => {
    const result = extractMarketingConsent({
      customer: {
        email_marketing_consent: {
          state: "subscribed",
          opt_in_level: "single_opt_in",
          consent_updated_at: "2026-08-01T10:30:00-04:00",
        },
      },
    });

    expect(result.email).toEqual({
      state: "subscribed",
      optInLevel: "single_opt_in",
      updatedAt: "2026-08-01T14:30:00.000Z",
      evidence: "consent_object",
    });
  });

  it("reads the sms consent object independently of email", () => {
    const result = extractMarketingConsent({
      buyer_accepts_marketing: true,
      customer: {
        sms_marketing_consent: {
          state: "unsubscribed",
          opt_in_level: "confirmed_opt_in",
          consent_updated_at: "2026-07-04T00:00:00Z",
        },
      },
    });

    expect(result.email.state).toBe("subscribed");
    expect(result.email.evidence).toBe("legacy_flag");
    expect(result.sms).toEqual({
      state: "unsubscribed",
      optInLevel: "confirmed_opt_in",
      updatedAt: "2026-07-04T00:00:00.000Z",
      evidence: "consent_object",
    });
  });

  it("prefers the consent object over the legacy flag when both are present", () => {
    const result = extractMarketingConsent({
      buyer_accepts_marketing: true,
      customer: {
        email_marketing_consent: { state: "unsubscribed", opt_in_level: null, consent_updated_at: null },
      },
    });

    // The structured object is authoritative — the legacy boolean is a
    // denormalized echo that Shopify can leave stale.
    expect(result.email.state).toBe("unsubscribed");
    expect(result.email.evidence).toBe("consent_object");
  });

  it("prefers the order-level legacy flag over the customer-level one", () => {
    const result = extractMarketingConsent({
      buyer_accepts_marketing: false,
      customer: { accepts_marketing: true },
    });

    // buyer_accepts_marketing describes THIS checkout; customer.accepts_marketing
    // is the account rollup. What happened at this checkout wins.
    expect(result.email.state).toBe("not_subscribed");
    expect(result.email.evidence).toBe("legacy_flag");
  });

  it("maps legacy false to not_subscribed, never to unsubscribed", () => {
    const result = extractMarketingConsent({ buyer_accepts_marketing: false });

    // An unticked box is the absence of consent, not its withdrawal. If this
    // ever returned "unsubscribed" the CRM would revoke consent granted
    // earlier on the signup drawer.
    expect(result.email.state).toBe("not_subscribed");
  });

  it("returns unknown for an unrecognised state word", () => {
    const result = extractMarketingConsent({
      customer: { email_marketing_consent: { state: "opted_in_maybe" } },
    });

    expect(result.email.state).toBe("unknown");
    expect(result.email.evidence).toBe("absent");
  });

  it("returns unknown when a state field is missing entirely", () => {
    const result = extractMarketingConsent({
      customer: { email_marketing_consent: { opt_in_level: "single_opt_in" } },
    });

    expect(result.email.state).toBe("unknown");
  });

  it("drops an unparseable consent_updated_at instead of passing it through", () => {
    const result = extractMarketingConsent({
      customer: { email_marketing_consent: { state: "subscribed", consent_updated_at: "not a date" } },
    });

    expect(result.email.state).toBe("subscribed");
    expect(result.email.updatedAt).toBeNull();
  });

  it("returns unknown for payloads that carry no consent information (eBay, Amazon)", () => {
    const result = extractMarketingConsent({ orderId: "12-3456-7890", buyer: { username: "cardfan" } });

    expect(result.email).toEqual({ state: "unknown", optInLevel: null, updatedAt: null, evidence: "absent" });
    expect(result.sms.state).toBe("unknown");
  });

  it.each([null, undefined, "a string", 42, []])("returns unknown for non-object payload %p", (payload) => {
    const result = extractMarketingConsent(payload);
    expect(result.email.state).toBe("unknown");
    expect(result.sms.state).toBe("unknown");
  });

  it("does not mutate the input payload", () => {
    const payload = {
      buyer_accepts_marketing: true,
      customer: { email_marketing_consent: { state: "subscribed" } },
    };
    const snapshot = JSON.stringify(payload);

    extractMarketingConsent(payload);

    expect(JSON.stringify(payload)).toBe(snapshot);
  });
});
