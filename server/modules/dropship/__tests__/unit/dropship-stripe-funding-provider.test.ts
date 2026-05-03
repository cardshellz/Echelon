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

  it("creates wallet funding payment sessions with reusable Stripe funding methods", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({
      stripeClient: stripe,
      webhookSecret: "whsec_test",
    });

    const session = await provider.createStripeWalletFundingSession({
      vendorId: 10,
      memberId: "member-1",
      fundingMethodId: 99,
      rail: "stripe_card",
      amountCents: 25000,
      currency: "USD",
      customerEmail: "vendor@cardshellz.test",
      customerName: "Vendor",
      existingProviderCustomerId: "cus_existing",
      providerPaymentMethodId: "pm_4242",
      successUrl: "https://cardshellz.io/wallet?wallet_funding=success",
      cancelUrl: "https://cardshellz.io/wallet?wallet_funding=cancelled",
      now: new Date("2026-05-03T12:00:00.000Z"),
    });

    expect(session).toMatchObject({
      checkoutUrl: "https://checkout.stripe.test/cs_1",
      providerSessionId: "cs_1",
      providerCustomerId: "cus_existing",
      amountCents: 25000,
      currency: "USD",
    });
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: "payment",
      customer: "cus_existing",
      payment_method_types: ["card"],
      line_items: [
        expect.objectContaining({
          price_data: expect.objectContaining({
            currency: "usd",
            unit_amount: 25000,
          }),
          quantity: 1,
        }),
      ],
      payment_intent_data: expect.objectContaining({
        setup_future_usage: "off_session",
        metadata: expect.objectContaining({
          type: "dropship_wallet_funding",
          dropship_vendor_id: "10",
          member_id: "member-1",
          funding_method_id: "99",
          requested_rail: "stripe_card",
          requested_provider_payment_method_id: "pm_4242",
        }),
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

  it("parses wallet funding succeeded webhooks into settled wallet credits", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({
      stripeClient: stripe,
      webhookSecret: "whsec_test",
    });

    stripe.webhooks.constructEvent.mockReturnValueOnce({
      id: "evt_pi_1",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_1",
          amount: 25000,
          amount_received: 25000,
          currency: "usd",
          status: "succeeded",
          customer: "cus_1",
          payment_method: "pm_1",
          latest_charge: "ch_1",
          metadata: {
            type: "dropship_wallet_funding",
            dropship_vendor_id: "10",
            funding_method_id: "99",
            requested_rail: "stripe_card",
          },
        },
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
      kind: "wallet_funding_recorded",
      providerEventId: "evt_pi_1",
      fundingMethod: {
        vendorId: 10,
        rail: "stripe_card",
        status: "active",
        providerCustomerId: "cus_1",
        providerPaymentMethodId: "pm_1",
        displayLabel: "Visa ending in 4242",
      },
      fundingCredit: {
        vendorId: 10,
        rail: "stripe_card",
        status: "settled",
        amountCents: 25000,
        currency: "USD",
        referenceType: "stripe_payment_intent",
        referenceId: "pi_1",
        externalTransactionId: "ch_1",
        idempotencyKey: "stripe-funding:pi_1",
      },
    });
  });

  it("parses wallet funding processing webhooks into pending ACH wallet credits", async () => {
    const stripe = makeStripeDouble();
    const provider = new StripeDropshipFundingProvider({
      stripeClient: stripe,
      webhookSecret: "whsec_test",
    });

    stripe.webhooks.constructEvent.mockReturnValueOnce({
      id: "evt_pi_processing",
      type: "payment_intent.processing",
      data: {
        object: {
          id: "pi_ach",
          amount: 48000,
          currency: "usd",
          status: "processing",
          customer: "cus_1",
          payment_method: "pm_bank",
          latest_charge: null,
          metadata: {
            type: "dropship_wallet_funding",
            dropship_vendor_id: "10",
            funding_method_id: "100",
            requested_rail: "stripe_ach",
          },
        },
      },
    });
    stripe.paymentMethods.retrieve.mockResolvedValueOnce({
      id: "pm_bank",
      type: "us_bank_account",
      us_bank_account: {
        bank_name: "Test Bank",
        last4: "6789",
        account_type: "checking",
      },
    });

    const event = await provider.parseWebhookEvent({
      rawBody: Buffer.from("{}"),
      signature: "stripe-signature",
    });

    expect(event).toMatchObject({
      kind: "wallet_funding_recorded",
      providerEventId: "evt_pi_processing",
      fundingMethod: {
        vendorId: 10,
        rail: "stripe_ach",
        status: "active",
        providerCustomerId: "cus_1",
        providerPaymentMethodId: "pm_bank",
        displayLabel: "Test Bank ending in 6789",
      },
      fundingCredit: {
        vendorId: 10,
        rail: "stripe_ach",
        status: "pending",
        amountCents: 48000,
        currency: "USD",
        referenceType: "stripe_payment_intent",
        referenceId: "pi_ach",
        idempotencyKey: "stripe-funding:pi_ach",
      },
    });
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
