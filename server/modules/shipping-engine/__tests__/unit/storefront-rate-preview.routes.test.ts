import http from "http";
import type { AddressInfo } from "net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerStorefrontRatePreviewRoutes,
  type StorefrontRatePreviewRouteDependencies,
} from "../../interfaces/http/storefront-rate-preview.routes";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const originalInternalApiKey = process.env.INTERNAL_API_KEY;
const computeCheckoutRatePreview = vi.fn<
  StorefrontRatePreviewRouteDependencies["computeCheckoutRatePreview"]
>();

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.INTERNAL_API_KEY = "storefront-preview-test-key";
  const app = express();
  app.use(express.json());
  registerStorefrontRatePreviewRoutes(app, { computeCheckoutRatePreview });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (originalInternalApiKey === undefined) {
    delete process.env.INTERNAL_API_KEY;
  } else {
    process.env.INTERNAL_API_KEY = originalInternalApiKey;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

beforeEach(() => {
  computeCheckoutRatePreview.mockReset();
  computeCheckoutRatePreview.mockResolvedValue({
    rates: [{
      service_name: "Standard Shipping",
      service_code: "standard",
      total_price: "899",
      currency: "USD",
      description: "Ground delivery",
    }],
    disposition: "echelon_quoted",
    warnings: [],
  });
});

describe("storefront rate preview routes", () => {
  it("requires the configured internal API key", async () => {
    const response = await postPreview(validRequest(), null);

    expect(response.status).toBe(401);
    expect(computeCheckoutRatePreview).not.toHaveBeenCalled();
  });

  it("rejects a SKU-less line without a fallback weight", async () => {
    const request = validRequest();
    request.groups[0].lines[0] = {
      sku: null,
      quantity: 1,
      grams: null,
      priceCents: 499,
    };

    const response = await postPreview(request);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "STOREFRONT_RATE_PREVIEW_INPUT_INVALID" },
    });
    expect(computeCheckoutRatePreview).not.toHaveBeenCalled();
  });

  it("quotes each shipping group through the checkout adapter", async () => {
    const request = validRequest();
    request.groups.push({
      code: "storage_boxes",
      lines: [{
        sku: "TUFF-BOX-GRD-P5",
        quantity: 2,
        grams: 3175,
        priceCents: 4599,
      }],
    });

    const response = await postPreview(request);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      groups: [
        {
          code: "protection",
          disposition: "echelon_quoted",
          rates: [{
            serviceCode: "standard",
            displayName: "Standard Shipping",
            totalCents: 899,
            currency: "USD",
            description: "Ground delivery",
          }],
        },
        {
          code: "storage_boxes",
          disposition: "echelon_quoted",
          rates: [{
            serviceCode: "standard",
            displayName: "Standard Shipping",
            totalCents: 899,
            currency: "USD",
            description: "Ground delivery",
          }],
        },
      ],
    });
    expect(computeCheckoutRatePreview).toHaveBeenCalledTimes(2);
    expect(computeCheckoutRatePreview).toHaveBeenNthCalledWith(1, {
      rate: {
        destination: {
          postal_code: "15044",
          country: "US",
          province_code: "PA",
        },
        items: [{
          sku: "SHLZ-TOP-100PT-P20",
          quantity: 1,
          grams: 227,
          price: 499,
        }],
      },
    });
  });
});

function validRequest() {
  return {
    destination: {
      country: "US",
      region: "PA",
      postalCode: "15044",
    },
    groups: [{
      code: "protection",
      lines: [{
        sku: "SHLZ-TOP-100PT-P20",
        quantity: 1,
        grams: 227,
        priceCents: 499,
      }],
    }],
  };
}

async function postPreview(
  body: unknown,
  apiKey: string | null = "storefront-preview-test-key",
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/shipping/internal/storefront-rate-preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}
