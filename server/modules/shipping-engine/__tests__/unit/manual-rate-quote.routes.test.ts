import http from "http";
import { AddressInfo } from "net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ManualRateQuoteError,
  type ManualRateQuoteInput,
  type ManualRateQuoteResult,
} from "../../application/manual-rate-quote.service";
import {
  registerManualRateQuoteRoutes,
  type ManualRateQuoteRouteDependencies,
} from "../../interfaces/http/manual-rate-quote.routes";

const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (
      _req: unknown,
      _res: unknown,
      next: () => void,
    ) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: requirePermissionMock,
}));

describe("manual shipping-rate quote routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FakeManualRateQuoteService;

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    service = new FakeManualRateQuoteService();
    server = await startServer(buildApp({
      runManualRateQuote: service.runManualRateQuote,
    }));
  });

  afterEach(async () => server.close());

  it("accepts the bounded UI request and returns the audited quote contract", async () => {
    const response = await jsonRequest(`${server.url}/api/shipping/admin/rate-quotes/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validRequest()),
    });

    expect(response.status).toBe(200);
    expect(requirePermissionMock).toHaveBeenCalledWith("settings", "edit");
    expect(service.input).toEqual({
      expectedRateBookId: 12,
      pricingChannel: "shopify",
      ratePurpose: "customer_checkout",
      originWarehouseId: 1,
      destinationCountry: "US",
      destinationRegion: "PA",
      destinationPostalCode: "16066",
      billableWeightGrams: 454,
    });
    expect(response.body).toMatchObject({
      outcome: "quoted",
      rateOwner: "echelon",
      rateBook: { id: 12, code: "shopify-retail-default" },
      quotes: [{ totalCents: 799, currency: "USD" }],
    });
  });

  it("rejects unchecked request fields before calling the application service", async () => {
    const response = await jsonRequest(`${server.url}/api/shipping/admin/rate-quotes/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validRequest(), unchecked: true }),
    });

    expect(response.status).toBe(400);
    expect(service.input).toBeNull();
    expect(response.body).toMatchObject({
      error: { code: "SHIPPING_RATE_TEST_INPUT_INVALID" },
    });
  });

  it("preserves classified application errors at the HTTP boundary", async () => {
    service.error = new ManualRateQuoteError(
      "SHIPPING_RATE_TEST_US_ONLY",
      "Echelon currently owns United States rates only.",
      { destinationCountry: "DK" },
    );

    const response = await jsonRequest(`${server.url}/api/shipping/admin/rate-quotes/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validRequest()),
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "SHIPPING_RATE_TEST_US_ONLY",
        message: "Echelon currently owns United States rates only.",
        context: { destinationCountry: "DK" },
      },
    });
  });
});

class FakeManualRateQuoteService {
  input: ManualRateQuoteInput | null = null;
  error: Error | null = null;

  runManualRateQuote = async (input: ManualRateQuoteInput): Promise<ManualRateQuoteResult> => {
    this.input = input;
    if (this.error !== null) throw this.error;
    return successfulQuote();
  };
}

function validRequest(): Record<string, unknown> {
  return {
    expectedRateBookId: 12,
    pricingChannel: "shopify",
    ratePurpose: "customer_checkout",
    originWarehouseId: 1,
    destination: { country: "US", region: "PA", postalCode: "16066" },
    billableWeightGrams: 454,
  };
}

function successfulQuote(): ManualRateQuoteResult {
  return {
    outcome: "quoted",
    testedAt: "2026-07-20T15:30:00.000Z",
    rateOwner: "echelon",
    destination: { country: "US", region: "PA", postalCode: "16066" },
    rateBook: { id: 12, code: "shopify-retail-default" },
    zone: "PA",
    quotes: [{
      serviceLevelId: 1,
      serviceLevelCode: "standard",
      displayName: "Standard shipping",
      description: null,
      fulfillmentMode: "parcel",
      pricingBasis: "shipment_weight",
      totalCents: 799,
      currency: "USD",
      promiseMinBusinessDays: 3,
      promiseMaxBusinessDays: 7,
      ratedMeasure: 454,
      maxShipmentWeightGrams: null,
      chargeModel: "fixed_band",
      perStartedPoundCents: null,
      billablePounds: null,
      rateTableId: 7,
      productPolicyApplied: false,
      calculationTrace: [],
    }],
    warnings: [],
  };
}

function buildApp(dependencies: ManualRateQuoteRouteDependencies): express.Express {
  const app = express();
  app.use(express.json());
  registerManualRateQuoteRoutes(app, dependencies);
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

async function jsonRequest(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: init?.method ?? "GET",
      headers: init?.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(rawBody) as Record<string, unknown>,
        });
      });
    });
    request.on("error", reject);
    if (init?.body !== undefined) request.write(init.body);
    request.end();
  });
}
