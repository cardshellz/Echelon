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
    (req as Request & { session: { dropship: { memberId: string } } }).session = {
      dropship: { memberId: "member-1" },
    };
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
