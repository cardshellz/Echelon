import http from "http";
import { AddressInfo } from "net";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import type {
  DropshipShippingQuoteService,
} from "../../application/dropship-shipping-quote-service";
import {
  registerDropshipShippingRoutes,
} from "../../interfaces/http/dropship-shipping.routes";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../interfaces/http/dropship-auth.routes", () => ({
  requireDropshipAuth: (
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    req.session = {
      dropship: {
        memberId: "member-1",
      },
    } as Request["session"];
    next();
  },
}));

describe("dropship shipping routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FailingShippingQuoteService;

  beforeEach(async () => {
    service = new FailingShippingQuoteService();
    server = await startServer(
      buildApp(service as unknown as DropshipShippingQuoteService),
    );
  });

  afterEach(async () => server.close());

  it.each([
    ["DROPSHIP_SHARED_SHIPPING_QUOTE_FAILED", 503],
    ["DROPSHIP_SHARED_SHIPPING_QUOTE_INVALID", 503],
    ["DROPSHIP_SHARED_SHIPPING_QUOTE_UNAVAILABLE", 409],
  ])("maps %s to HTTP %i", async (code, expectedStatus) => {
    service.error = new DropshipError(code, "Controlled test failure.");

    const response = await jsonRequest(
      `${server.url}/api/dropship/shipping/quote`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "shipping-route-test-001",
        },
        body: JSON.stringify({
          storeConnectionId: 10,
          warehouseId: 20,
          destination: {
            country: "US",
            region: "PA",
            postalCode: "17046",
          },
          items: [{ productVariantId: 30, quantity: 1 }],
        }),
      },
    );

    expect(response.status).toBe(expectedStatus);
    expect(response.body).toEqual({
      error: {
        code,
        message: "Controlled test failure.",
      },
    });
  });
});

class FailingShippingQuoteService {
  error: Error = new Error("Test error was not configured.");

  async quoteForMember(): Promise<never> {
    throw this.error;
  }
}

function buildApp(service: DropshipShippingQuoteService): express.Express {
  const app = express();
  app.use(express.json());
  registerDropshipShippingRoutes(app, service);
  return app;
}

async function startServer(
  app: express.Express,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())),
  };
}

async function jsonRequest(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}
