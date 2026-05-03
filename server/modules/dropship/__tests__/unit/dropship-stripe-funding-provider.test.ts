import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { StripeDropshipFundingProvider } from "../../infrastructure/dropship-stripe-funding.provider";

describe("StripeDropshipFundingProvider", () => {
  it("creates setup sessions without creating duplicate customers when one is reusable", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({
      stripeClient: stripe,
      webhookSecret: "whsec_test",
    });

    const session = await provider.createStripeSetupSession({
      vendorId: 10,
      memberId: "member-1",
      rail: "stripe_ach",
      customerEmail: "vendor@cardshellz.test",
      customerName: "Vendor",
      existingProviderCustomerId: "cus_existing",
      successUrl: "https://cardshellz.io/wallet?funding_setup=success",
      cancelUrl: "https://cardshellz.io/wallet?funding_setup=cancelled",
      now: new Date("2026-05-03T12:00:00.000Z"),
    });

    expect(session).toMatchObject({
      checkoutUrl: "https://checkout.stripe.test/cs_1",
      providerSessionId: "cs_1",
      providerCustomerId: "cus_existing",
    });
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: "setup",
      customer: "cus_existing",
      payment_method_types: ["us_bank_account"],
      metadata: expect.objectContaining({
        type: "dropship_funding_setup",
        dropship_vendor_id: "10",
        member_id: "member-1",
        requested_rail: "stripe_ach",
      }),
    }));
  });

  it("parses verified setup webhooks into sanitized V2 funding methods", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({
      stripeClient: stripe,
      webhookSecret: "whsec_test",
    });

    stripe.webhooks.constructEvent.mockReturnValueOnce({
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          mode: "setup",
          setup_intent: "seti_1",
          customer: "cus_1",
          metadata: {
            type: "dropship_funding_setup",
            dropship_vendor_id: "10",
            requested_rail: "stripe_card",
          },
        },
      },
    });
    stripe.setupIntents.retrieve.mockResolvedValueOnce({
      id: "seti_1",
      customer: "cus_1",
      payment_method: "pm_1",
      metadata: {
        type: "dropship_funding_setup",
        dropship_vendor_id: "10",
        requested_rail: "stripe_card",
      },
    });
    stripe.paymentMethods.retrieve.mockResolvedValueOnce({
      id: "pm_1",
      type: "card",
      card: {
        brand: "visa",
        last4: "4242",
        exp_month: 12,
        exp_year: 2030,
      },
    });

    const event = await provider.parseWebhookEvent({
      rawBody: Buffer.from("{}"),
      signature: "stripe-signature",
    });

    expect(event).toMatchObject({
      kind: "funding_method_setup_completed",
      providerEventId: "evt_1",
      fundingMethod: {
        vendorId: 10,
        rail: "stripe_card",
        status: "active",
        providerCustomerId: "cus_1",
        providerPaymentMethodId: "pm_1",
        displayLabel: "Visa ending in 4242",
      },
    });
    expect(event.kind === "funding_method_setup_completed" ? event.fundingMethod.metadata : {}).toEqual(expect.objectContaining({
      provider: "stripe",
      paymentMethodType: "card",
      setupIntentId: "seti_1",
      setupSessionId: "cs_1",
      providerEventId: "evt_1",
      brand: "visa",
      last4: "4242",
    }));
    expect(JSON.stringify(event)).not.toContain("routing");
    expect(JSON.stringify(event)).not.toContain("account_number");
  });
});

function makeStripeDouble() {
  return {
    customers: {
      create: vi.fn(async () => ({ id: "cus_created" })),
    },
    checkout: {
      sessions: {
        create: vi.fn(async () => ({
          id: "cs_1",
          url: "https://checkout.stripe.test/cs_1",
          expires_at: 1_777_777_777,
        })),
      },
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
    setupIntents: {
      retrieve: vi.fn(),
    },
    paymentMethods: {
      retrieve: vi.fn(),
    },
  } as unknown as Stripe & {
    customers: { create: ReturnType<typeof vi.fn> };
    checkout: { sessions: { create: ReturnType<typeof vi.fn> } };
    webhooks: { constructEvent: ReturnType<typeof vi.fn> };
    setupIntents: { retrieve: ReturnType<typeof vi.fn> };
    paymentMethods: { retrieve: ReturnType<typeof vi.fn> };
  };
}
