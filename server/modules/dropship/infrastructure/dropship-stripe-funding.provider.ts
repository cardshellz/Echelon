import Stripe from "stripe";
import { DropshipError } from "../domain/errors";
import type {
  CreditDropshipWalletFundingInput,
  DropshipStripeFundingSetupRail,
  DropshipStripeWalletFundingSession,
  DropshipWalletFundingProvider,
  RegisterDropshipFundingMethodInput,
} from "../application/dropship-wallet-service";

const STRIPE_API_VERSION = "2024-12-18.acacia";
const STRIPE_FUNDING_SETUP_TYPE = "dropship_funding_setup";
const STRIPE_WALLET_FUNDING_TYPE = "dropship_wallet_funding";

export type DropshipStripeFundingWebhookEvent =
  | {
      kind: "funding_method_setup_completed";
      providerEventId: string;
      eventType: string;
      fundingMethod: RegisterDropshipFundingMethodInput;
    }
  | {
      kind: "wallet_funding_recorded";
      providerEventId: string;
      eventType: string;
      fundingMethod: RegisterDropshipFundingMethodInput;
      fundingCredit: Omit<CreditDropshipWalletFundingInput, "fundingMethodId">;
    }
  | {
      kind: "ignored";
      providerEventId: string;
      eventType: string;
      reason: string;
    };

export class StripeDropshipFundingProvider implements DropshipWalletFundingProvider {
  private stripeClient: Stripe | null = null;

  constructor(
    private readonly config: {
      secretKey?: string;
      webhookSecret?: string;
      stripeClient?: Stripe;
    } = {},
  ) {}

  async createStripeSetupSession(input: {
    vendorId: number;
    memberId: string;
    rail: DropshipStripeFundingSetupRail;
    customerEmail: string | null;
    customerName: string;
    existingProviderCustomerId: string | null;
    successUrl: string;
    cancelUrl: string;
    now: Date;
  }) {
    const stripe = this.getStripe();
    const customerId = input.existingProviderCustomerId
      ?? await this.createCustomer({
        email: input.customerEmail,
        name: input.customerName,
        vendorId: input.vendorId,
        memberId: input.memberId,
      });
    const metadata = {
      type: STRIPE_FUNDING_SETUP_TYPE,
      dropship_vendor_id: String(input.vendorId),
      member_id: input.memberId,
      requested_rail: input.rail,
      requested_at: input.now.toISOString(),
    };
    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      payment_method_types: paymentMethodTypesForRail(input.rail),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata,
      setup_intent_data: {
        metadata,
      },
    });

    if (!session.url) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_SETUP_SESSION_URL_MISSING",
        "Stripe did not return a checkout URL for funding setup.",
        { vendorId: input.vendorId, rail: input.rail, providerSessionId: session.id },
      );
    }

    return {
      checkoutUrl: session.url,
      providerSessionId: session.id,
      providerCustomerId: customerId,
      expiresAt: typeof session.expires_at === "number" ? new Date(session.expires_at * 1000) : null,
    };
  }

  async createStripeWalletFundingSession(input: {
    vendorId: number;
    memberId: string;
    fundingMethodId: number;
    rail: DropshipStripeFundingSetupRail;
    amountCents: number;
    currency: string;
    customerEmail: string | null;
    customerName: string;
    existingProviderCustomerId: string | null;
    providerPaymentMethodId: string | null;
    successUrl: string;
    cancelUrl: string;
    now: Date;
  }): Promise<DropshipStripeWalletFundingSession> {
    const stripe = this.getStripe();
    const customerId = input.existingProviderCustomerId
      ?? await this.createCustomer({
        email: input.customerEmail,
        name: input.customerName,
        vendorId: input.vendorId,
        memberId: input.memberId,
      });
    const metadata = {
      type: STRIPE_WALLET_FUNDING_TYPE,
      dropship_vendor_id: String(input.vendorId),
      member_id: input.memberId,
      funding_method_id: String(input.fundingMethodId),
      requested_rail: input.rail,
      requested_provider_payment_method_id: input.providerPaymentMethodId ?? "",
      requested_at: input.now.toISOString(),
    };
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      payment_method_types: paymentMethodTypesForRail(input.rail),
      line_items: [
        {
          price_data: {
            currency: input.currency.toLowerCase(),
            product_data: {
              name: "Card Shellz dropship wallet funding",
            },
            unit_amount: input.amountCents,
          },
          quantity: 1,
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata,
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata,
      },
    });

    if (!session.url) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_FUNDING_SESSION_URL_MISSING",
        "Stripe did not return a checkout URL for wallet funding.",
        { vendorId: input.vendorId, rail: input.rail, providerSessionId: session.id },
      );
    }

    return {
      checkoutUrl: session.url,
      providerSessionId: session.id,
      providerCustomerId: customerId,
      amountCents: input.amountCents,
      currency: input.currency,
      expiresAt: typeof session.expires_at === "number" ? new Date(session.expires_at * 1000) : null,
    };
  }

  async parseWebhookEvent(input: {
    rawBody: Buffer;
    signature: string;
  }): Promise<DropshipStripeFundingWebhookEvent> {
    const stripe = this.getStripe();
    const webhookSecret = this.getWebhookSecret();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(input.rawBody, input.signature, webhookSecret);
    } catch (error) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_WEBHOOK_SIGNATURE_INVALID",
        "Stripe webhook signature verification failed.",
        { provider: "stripe", detail: error instanceof Error ? error.message : "unknown" },
      );
    }

    if (event.type === "checkout.session.completed") {
      return this.parseCheckoutSessionCompleted(event);
    }
    if (event.type === "setup_intent.succeeded") {
      return this.parseSetupIntentSucceeded(event);
    }
    if (event.type === "payment_intent.processing" || event.type === "payment_intent.succeeded") {
      return this.parsePaymentIntentFundingEvent(event);
    }

    return {
      kind: "ignored",
      providerEventId: event.id,
      eventType: event.type,
      reason: "unsupported_event_type",
    };
  }

  private async parseCheckoutSessionCompleted(event: Stripe.Event): Promise<DropshipStripeFundingWebhookEvent> {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode !== "setup" || session.metadata?.type !== STRIPE_FUNDING_SETUP_TYPE) {
      return {
        kind: "ignored",
        providerEventId: event.id,
        eventType: event.type,
        reason: "not_dropship_funding_setup",
      };
    }

    const setupIntentId = idFromExpandable(session.setup_intent);
    if (!setupIntentId) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_SETUP_INTENT_MISSING",
        "Stripe setup checkout completed without a setup intent id.",
        { providerEventId: event.id, providerSessionId: session.id },
      );
    }

    const setupIntent = await this.getStripe().setupIntents.retrieve(setupIntentId);
    return this.buildFundingMethodEvent({
      event,
      setupIntent,
      setupSessionId: session.id,
      fallbackCustomerId: idFromExpandable(session.customer),
      fallbackMetadata: session.metadata ?? {},
    });
  }

  private async parseSetupIntentSucceeded(event: Stripe.Event): Promise<DropshipStripeFundingWebhookEvent> {
    const setupIntent = event.data.object as Stripe.SetupIntent;
    if (setupIntent.metadata?.type !== STRIPE_FUNDING_SETUP_TYPE) {
      return {
        kind: "ignored",
        providerEventId: event.id,
        eventType: event.type,
        reason: "not_dropship_funding_setup",
      };
    }

    return this.buildFundingMethodEvent({
      event,
      setupIntent,
      setupSessionId: null,
      fallbackCustomerId: null,
      fallbackMetadata: {},
    });
  }

  private async buildFundingMethodEvent(input: {
    event: Stripe.Event;
    setupIntent: Stripe.SetupIntent;
    setupSessionId: string | null;
    fallbackCustomerId: string | null;
    fallbackMetadata: Record<string, string>;
  }): Promise<DropshipStripeFundingWebhookEvent> {
    const metadata = {
      ...input.fallbackMetadata,
      ...(input.setupIntent.metadata ?? {}),
    };
    const vendorId = parsePositiveInteger(metadata.dropship_vendor_id ?? metadata.vendor_id, "dropship_vendor_id");
    const paymentMethodId = idFromExpandable(input.setupIntent.payment_method);
    if (!paymentMethodId) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_PAYMENT_METHOD_MISSING",
        "Stripe setup intent completed without a payment method id.",
        { providerEventId: input.event.id, setupIntentId: input.setupIntent.id, vendorId },
      );
    }

    const paymentMethod = await this.getStripe().paymentMethods.retrieve(paymentMethodId);
    const rail = railFromStripePaymentMethod(paymentMethod);
    if (!rail) {
      return {
        kind: "ignored",
        providerEventId: input.event.id,
        eventType: input.event.type,
        reason: `unsupported_payment_method:${paymentMethod.type}`,
      };
    }

    return {
      kind: "funding_method_setup_completed",
      providerEventId: input.event.id,
      eventType: input.event.type,
      fundingMethod: {
        vendorId,
        rail,
        status: "active",
        providerCustomerId: idFromExpandable(input.setupIntent.customer) ?? input.fallbackCustomerId,
        providerPaymentMethodId: paymentMethod.id,
        usdcWalletAddress: null,
        displayLabel: displayLabelForPaymentMethod(paymentMethod),
        isDefault: false,
        metadata: sanitizedPaymentMethodMetadata({
          paymentMethod,
          setupIntentId: input.setupIntent.id,
          setupSessionId: input.setupSessionId,
          providerEventId: input.event.id,
          requestedRail: metadata.requested_rail ?? null,
        }),
      },
    };
  }

  private async parsePaymentIntentFundingEvent(event: Stripe.Event): Promise<DropshipStripeFundingWebhookEvent> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    if (paymentIntent.metadata?.type !== STRIPE_WALLET_FUNDING_TYPE) {
      return {
        kind: "ignored",
        providerEventId: event.id,
        eventType: event.type,
        reason: "not_dropship_wallet_funding",
      };
    }

    const metadata = paymentIntent.metadata ?? {};
    const vendorId = parsePositiveInteger(metadata.dropship_vendor_id ?? metadata.vendor_id, "dropship_vendor_id");
    const fundingMethodId = parseOptionalPositiveInteger(metadata.funding_method_id, "funding_method_id");
    const paymentMethodId = idFromExpandable(paymentIntent.payment_method);
    if (!paymentMethodId) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_PAYMENT_METHOD_MISSING",
        "Stripe wallet funding event did not include a payment method id.",
        { providerEventId: event.id, paymentIntentId: paymentIntent.id, vendorId },
      );
    }

    const paymentMethod = await this.getStripe().paymentMethods.retrieve(paymentMethodId);
    const rail = railFromStripePaymentMethod(paymentMethod);
    if (!rail) {
      return {
        kind: "ignored",
        providerEventId: event.id,
        eventType: event.type,
        reason: `unsupported_payment_method:${paymentMethod.type}`,
      };
    }

    const status = event.type === "payment_intent.succeeded" ? "settled" : "pending";
    const amountCents = amountForPaymentIntent(paymentIntent, status);
    const currency = paymentIntent.currency.toUpperCase();
    const fundingMethod: RegisterDropshipFundingMethodInput = {
      vendorId,
      rail,
      status: "active",
      providerCustomerId: idFromExpandable(paymentIntent.customer),
      providerPaymentMethodId: paymentMethod.id,
      usdcWalletAddress: null,
      displayLabel: displayLabelForPaymentMethod(paymentMethod),
      isDefault: false,
      metadata: sanitizedPaymentMethodMetadata({
        paymentMethod,
        setupIntentId: "",
        setupSessionId: null,
        providerEventId: event.id,
        requestedRail: metadata.requested_rail ?? null,
      }),
    };
    return {
      kind: "wallet_funding_recorded",
      providerEventId: event.id,
      eventType: event.type,
      fundingMethod,
      fundingCredit: {
        vendorId,
        walletAccountId: undefined,
        rail,
        status,
        amountCents,
        currency,
        referenceType: "stripe_payment_intent",
        referenceId: paymentIntent.id,
        externalTransactionId: idFromExpandable(paymentIntent.latest_charge) ?? undefined,
        metadata: {
          provider: "stripe",
          providerEventId: event.id,
          eventType: event.type,
          paymentIntentStatus: paymentIntent.status,
          fundingMethodId,
          providerPaymentMethodId: paymentMethod.id,
        },
        idempotencyKey: `stripe-funding:${paymentIntent.id}`,
      },
    };
  }

  private async createCustomer(input: {
    email: string | null;
    name: string;
    vendorId: number;
    memberId: string;
  }): Promise<string> {
    const customer = await this.getStripe().customers.create({
      email: input.email ?? undefined,
      name: input.name,
      metadata: {
        dropship_vendor_id: String(input.vendorId),
        member_id: input.memberId,
      },
    });
    return customer.id;
  }

  private getStripe(): Stripe {
    if (this.stripeClient) return this.stripeClient;
    if (this.config.stripeClient) {
      this.stripeClient = this.config.stripeClient;
      return this.stripeClient;
    }
    const secretKey = this.config.secretKey ?? process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_SECRET_NOT_CONFIGURED",
        "Stripe funding is not configured.",
        { env: "STRIPE_SECRET_KEY" },
      );
    }
    this.stripeClient = new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
      typescript: true,
    });
    return this.stripeClient;
  }

  private getWebhookSecret(): string {
    const secret =
      this.config.webhookSecret
      ?? process.env.DROPSHIP_STRIPE_WEBHOOK_SECRET
      ?? process.env.STRIPE_DROPSHIP_WEBHOOK_SECRET
      ?? process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new DropshipError(
        "DROPSHIP_STRIPE_WEBHOOK_SECRET_NOT_CONFIGURED",
        "Stripe webhook secret is not configured.",
        { env: "DROPSHIP_STRIPE_WEBHOOK_SECRET" },
      );
    }
    return secret;
  }
}

export function createStripeDropshipFundingProviderFromEnv(): StripeDropshipFundingProvider {
  return new StripeDropshipFundingProvider();
}

function paymentMethodTypesForRail(rail: DropshipStripeFundingSetupRail): Array<"card" | "us_bank_account"> {
  return rail === "stripe_card" ? ["card"] : ["us_bank_account"];
}

function railFromStripePaymentMethod(paymentMethod: Stripe.PaymentMethod): RegisterDropshipFundingMethodInput["rail"] | null {
  if (paymentMethod.type === "card") return "stripe_card";
  if (paymentMethod.type === "us_bank_account") return "stripe_ach";
  return null;
}

function displayLabelForPaymentMethod(paymentMethod: Stripe.PaymentMethod): string {
  if (paymentMethod.type === "card" && paymentMethod.card) {
    const brand = titleCase(paymentMethod.card.brand || "card");
    return `${brand} ending in ${paymentMethod.card.last4}`;
  }
  if (paymentMethod.type === "us_bank_account" && paymentMethod.us_bank_account) {
    const bankName = paymentMethod.us_bank_account.bank_name || "Bank account";
    return `${bankName} ending in ${paymentMethod.us_bank_account.last4}`;
  }
  return "Stripe funding method";
}

function amountForPaymentIntent(
  paymentIntent: Stripe.PaymentIntent,
  status: CreditDropshipWalletFundingInput["status"],
): number {
  if (status === "settled" && Number.isSafeInteger(paymentIntent.amount_received) && paymentIntent.amount_received > 0) {
    return paymentIntent.amount_received;
  }
  return paymentIntent.amount;
}

function sanitizedPaymentMethodMetadata(input: {
  paymentMethod: Stripe.PaymentMethod;
  setupIntentId: string;
  setupSessionId: string | null;
  providerEventId: string;
  requestedRail: string | null;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    provider: "stripe",
    paymentMethodType: input.paymentMethod.type,
    setupIntentId: input.setupIntentId || null,
    setupSessionId: input.setupSessionId,
    providerEventId: input.providerEventId,
    requestedRail: input.requestedRail,
  };
  if (input.paymentMethod.type === "card" && input.paymentMethod.card) {
    return {
      ...base,
      brand: input.paymentMethod.card.brand,
      last4: input.paymentMethod.card.last4,
      expMonth: input.paymentMethod.card.exp_month,
      expYear: input.paymentMethod.card.exp_year,
    };
  }
  if (input.paymentMethod.type === "us_bank_account" && input.paymentMethod.us_bank_account) {
    return {
      ...base,
      bankName: input.paymentMethod.us_bank_account.bank_name,
      last4: input.paymentMethod.us_bank_account.last4,
      accountType: input.paymentMethod.us_bank_account.account_type,
    };
  }
  return base;
}

function idFromExpandable(value: string | { id?: string } | null | undefined): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && typeof value.id === "string" && value.id.trim()) {
    return value.id;
  }
  return null;
}

function parseOptionalPositiveInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  return parsePositiveInteger(value, field);
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new DropshipError(
      "DROPSHIP_STRIPE_WEBHOOK_METADATA_INVALID",
      "Stripe webhook metadata is missing required dropship identifiers.",
      { field },
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_STRIPE_WEBHOOK_METADATA_INVALID",
      "Stripe webhook metadata contains an invalid dropship identifier.",
      { field, value },
    );
  }
  return parsed;
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}
