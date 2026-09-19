import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import type { DropshipWalletService } from "../../application/dropship-wallet-service";
import { toDropshipStripeError } from "../../infrastructure/dropship-stripe-error";
import { registerDropshipWalletRoutes } from "../../interfaces/http/dropship-wallet.routes";
import type { StripeDropshipFundingProvider } from "../../infrastructure/dropship-stripe-funding.provider";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../../interfaces/http/dropship-auth.routes", () => ({
  requireDropshipAuth: (req: Request, _res: Response, next: NextFunction) => {
    // These routes read only `session.dropship.memberId`. The rest of the real
    // principal is irrelevant here, so the stub asserts the narrow shape rather
    // than fabricating auth fields the assertions never look at.
    req.session = { dropship: { memberId: "member-1" } } as unknown as Request["session"];
    next();
  },
  requireDropshipSensitiveActionProof: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const SETUP_SESSION_URL = "/api/dropship/wallet/funding-methods/stripe/setup-session";

describe("dropship wallet routes error responses", () => {
  let server: { url: string; close: () => Promise<void> };
  let setupSessionError: unknown;
  let logged: Array<{ level: string; payload: Record<string, unknown> }>;

  beforeEach(async () => {
    setupSessionError = new Error("not set");
    logged = [];
    for (const level of ["error", "warn", "info"] as const) {
      vi.spyOn(console, level).mockImplementation((line: unknown) => {
        logged.push({ level, payload: JSON.parse(String(line)) });
      });
    }
    const service = {
      createStripeFundingSetupSessionForMember: async () => {
        throw setupSessionError;
      },
    } as unknown as DropshipWalletService;
    server = await startServer(buildApp(service));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("returns a declined card as 402 with its structured code instead of an opaque 500", async () => {
    setupSessionError = toDropshipStripeError("customers.create", new Stripe.errors.StripeCardError({
      type: "card_error",
      message: "Your card was declined.",
      code: "card_declined",
      decline_code: "generic_decline",
      statusCode: 402,
      requestId: "req_declined",
    }));

    const response = await jsonRequest(`${server.url}${SETUP_SESSION_URL}`, { method: "POST" });

    expect(response.status).toBe(402);
    expect(response.body.error).toMatchObject({
      code: "DROPSHIP_STRIPE_CARD_DECLINED",
      message: "Your card was declined.",
      context: { classification: "permanent", stripeRequestId: "req_declined" },
    });
  });

  it("returns a transient Stripe failure as a retryable 5xx so webhook senders retry it", async () => {
    setupSessionError = toDropshipStripeError("createStripeSetupSession", new Stripe.errors.StripeConnectionError({
      type: "api_error",
      message: "socket hang up",
    }));

    const response = await jsonRequest(`${server.url}${SETUP_SESSION_URL}`, { method: "POST" });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("DROPSHIP_STRIPE_UNREACHABLE");
    expect(logged.some((entry) => entry.level === "error"
      && entry.payload.code === "DROPSHIP_STRIPE_UNREACHABLE")).toBe(true);
  });

  it("logs every 4xx wallet failure without escalating it to error level", async () => {
    setupSessionError = new DropshipError(
      "DROPSHIP_WALLET_INVALID_INPUT",
      "Dropship wallet input failed validation.",
      { issues: [] },
    );

    const response = await jsonRequest(`${server.url}${SETUP_SESSION_URL}`, { method: "POST" });

    expect(response.status).toBe(400);
    const entry = logged.find((candidate) => candidate.payload.code === "DROPSHIP_WALLET_INVALID_INPUT");
    expect(entry?.level).toBe("warn");
    expect(entry?.payload.context).toMatchObject({ httpStatus: 400 });
  });

  it("keeps the generic 500 for an unrecognized failure but records its identity in the log", async () => {
    setupSessionError = new TypeError("relation \"dropship.dropship_funding_methods\" does not exist");

    const response = await jsonRequest(`${server.url}${SETUP_SESSION_URL}`, { method: "POST" });

    expect(response.status).toBe(500);
    // The response stays deliberately generic: an unrecognized failure has no
    // vendor-safe explanation. The log is where the cause has to be findable.
    expect(response.body.error).toEqual({
      code: "DROPSHIP_WALLET_INTERNAL_ERROR",
      message: "Dropship wallet request failed.",
    });
    const entry = logged.find((candidate) => candidate.payload.code === "DROPSHIP_WALLET_INTERNAL_ERROR");
    expect(entry?.level).toBe("error");
    expect(entry?.payload.context).toMatchObject({
      httpStatus: 500,
      classification: "permanent",
      errorName: "TypeError",
      errorMessage: "relation \"dropship.dropship_funding_methods\" does not exist",
    });
  });
});

describe("dropship wallet routes card fee exposure", () => {
  const now = "2026-09-16T12:00:00.000Z";
  let server: { url: string; close: () => Promise<void> };
  let configureInputs: unknown[];
  let configureError: unknown;
  let walletError: unknown;

  beforeEach(async () => {
    configureInputs = [];
    configureError = null;
    walletError = null;
    for (const level of ["error", "warn", "info"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    const service = {
      getWalletForMember: async () => {
        if (walletError) throw walletError;
        return {
          account: { walletAccountId: 1, vendorId: 10, availableBalanceCents: 0, pendingBalanceCents: 0, currency: "USD", status: "active", createdAt: now, updatedAt: now },
          autoReload: null,
          fundingMethods: [],
          recentLedger: [],
          cardFundingFeeBps: 300,
          usdcBaseDepositAddress: "0x1111111111111111111111111111111111111111",
          limits: {
            autoReloadMinTriggerCents: 7_500,
            autoReloadMinAmountCents: 12_500,
            manualFundingMinCents: 2_000,
            manualFundingMaxCents: 400_000,
            defaultPaymentHoldTimeoutMinutes: 1_440,
            holdExpiryWarningMinutes: 90,
          },
        };
      },
      getWalletForVendor: async () => ({
        account: { walletAccountId: 1, vendorId: 10, availableBalanceCents: 0, pendingBalanceCents: 0, currency: "USD", status: "active", createdAt: now, updatedAt: now },
        autoReload: null,
        fundingMethods: [],
        recentLedger: [],
        cardFundingFeeBps: 300,
        usdcBaseDepositAddress: null,
        limits: {
          autoReloadMinTriggerCents: 7_500,
          autoReloadMinAmountCents: 12_500,
          manualFundingMinCents: 2_000,
          manualFundingMaxCents: 400_000,
          defaultPaymentHoldTimeoutMinutes: 1_440,
          holdExpiryWarningMinutes: 90,
        },
      }),
      configureAutoReload: async (input: unknown) => {
        configureInputs.push(input);
        if (configureError) throw configureError;
        return {
          autoReloadSettingId: 1, vendorId: 10, fundingMethodId: 10, enabled: true, minimumBalanceCents: 5000,
          maxSingleReloadCents: 25_000, paymentHoldTimeoutMinutes: 2880, createdAt: now, updatedAt: now,
        };
      },
      createStripeWalletFundingSessionForMember: async () => ({
        checkoutUrl: "https://checkout.stripe.test/cs_2", providerSessionId: "cs_2", providerCustomerId: "cus_1",
        amountCents: 10_000, cardFeeCents: 300, chargedCents: 10_300, currency: "USD", expiresAt: null,
      }),
    } as unknown as DropshipWalletService;
    server = await startServer(buildApp(service));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("exposes the card fee rate on the wallet so the page can quote before anything is charged", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/wallet`);

    expect(response.status).toBe(200);
    expect(response.body.wallet.cardFundingFeeBps).toBe(300);
  });

  it("exposes the USDC deposit address so the page can show where to send funds", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/wallet`);

    expect(response.status).toBe(200);
    expect(response.body.wallet.usdcBaseDepositAddress).toBe("0x1111111111111111111111111111111111111111");
  });

  it("serves the wallet policy limits so the page stops falling back to a hard-coded table", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/wallet`);

    expect(response.status).toBe(200);
    // Field names are the contract the portal's wallet view adapter parses
    // (client/src/lib/dropship-wallet-view-adapter.ts, rawLimitsSchema).
    expect(response.body.wallet.limits).toEqual({
      autoReloadMinTriggerCents: 7_500,
      autoReloadMinAmountCents: 12_500,
      manualFundingMinCents: 2_000,
      manualFundingMaxCents: 400_000,
      defaultPaymentHoldTimeoutMinutes: 1_440,
      holdExpiryWarningMinutes: 90,
    });
  });

  it("leaves the admin per-vendor wallet serializer unchanged", async () => {
    // Staff read the policy through GET /api/dropship/admin/wallet/policy, so
    // the ops screen's shape does not move when the vendor view gains limits.
    const response = await jsonRequest(`${server.url}/api/dropship/admin/wallet/vendors/10`);

    expect(response.status).toBe(200);
    expect(response.body.wallet.limits).toBeUndefined();
    expect(response.body.wallet.cardFundingFeeBps).toBe(300);
  });

  it("returns the fee and the total alongside the checkout session", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/wallet/funding/stripe/checkout-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fundingMethodId: 10, amountCents: 10_000 }),
    });

    expect(response.status).toBe(200);
    expect(response.body.fundingSession).toMatchObject({ amountCents: 10_000, cardFeeCents: 300, chargedCents: 10_300 });
  });

  it("passes the acknowledged fee rate through to the service", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/wallet/auto-reload`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, fundingMethodId: 10, minimumBalanceCents: 5000, maxSingleReloadCents: 25_000, paymentHoldTimeoutMinutes: 2880, acknowledgedCardFeeBps: 300 }),
    });

    expect(response.status).toBe(200);
    expect(configureInputs).toEqual([expect.objectContaining({ vendorId: 10, acknowledgedCardFeeBps: 300 })]);
  });

  it("reports a stale fee acknowledgement as a conflict the vendor resolves by re-reading, not as bad input", async () => {
    configureError = new DropshipError(
      "DROPSHIP_CARD_FUNDING_FEE_ACKNOWLEDGEMENT_STALE",
      "The card fee shown has changed.",
      { acknowledgedCardFeeBps: 250, cardFundingFeeBps: 300 },
    );

    const response = await jsonRequest(`${server.url}/api/dropship/wallet/auto-reload`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, fundingMethodId: 10, minimumBalanceCents: 5000, maxSingleReloadCents: 25_000, paymentHoldTimeoutMinutes: 2880, acknowledgedCardFeeBps: 250 }),
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("DROPSHIP_CARD_FUNDING_FEE_ACKNOWLEDGEMENT_STALE");
  });

  it("reports a misconfigured fee rate as unavailable so nothing is charged at a rate nobody set", async () => {
    walletError = new DropshipError(
      "DROPSHIP_CARD_FUNDING_FEE_MISCONFIGURED",
      "Dropship card funding fee is misconfigured.",
      { env: "DROPSHIP_CARD_FUNDING_FEE_BPS", value: "abc" },
    );

    const response = await jsonRequest(`${server.url}/api/dropship/wallet`);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("DROPSHIP_CARD_FUNDING_FEE_MISCONFIGURED");
  });
});

function buildApp(service: DropshipWalletService): express.Express {
  const app = express();
  app.use(express.json());
  registerDropshipWalletRoutes(app, service, {} as StripeDropshipFundingProvider);
  return app;
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function jsonRequest(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}
