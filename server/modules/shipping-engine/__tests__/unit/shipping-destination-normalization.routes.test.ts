import http from "http";
import type { AddressInfo } from "net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerShippingDestinationNormalizationRoutes,
  type ShippingDestinationNormalizationRouteDependencies,
} from "../../interfaces/http/shipping-destination-normalization.routes";

const originalInternalApiKey = process.env.INTERNAL_API_KEY;
const normalize = vi.fn<ShippingDestinationNormalizationRouteDependencies["normalize"]>();

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.INTERNAL_API_KEY = "destination-normalization-test-key";
  const app = express();
  app.use(express.json());
  registerShippingDestinationNormalizationRoutes(app, { normalize });
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
  normalize.mockReset();
  normalize.mockReturnValue({
    ok: true,
    destination: {
      country: "US",
      region: "PA",
      postalCode: "15044",
    },
  });
});

describe("shipping destination normalization routes", () => {
  it("requires the configured internal API key", async () => {
    const response = await postDestination({
      country: "US",
      region: "Pennsylvania",
    }, null);

    expect(response.status).toBe(401);
    expect(normalize).not.toHaveBeenCalled();
  });

  it("returns a canonical destination", async () => {
    const response = await postDestination({
      country: "United States",
      region: "Pennsylvania",
      postalCode: "15044",
    });

    expect(response.status).toBe(200);
    expect(normalize).toHaveBeenCalledWith({
      country: "United States",
      region: "Pennsylvania",
      postalCode: "15044",
    });
    expect(response.body).toEqual({
      destination: {
        country: "US",
        region: "PA",
        postalCode: "15044",
      },
    });
  });

  it("returns a structured rejection for an invalid region", async () => {
    normalize.mockReturnValueOnce({
      ok: false,
      code: "SHIPPING_DESTINATION_REGION_INVALID",
      message: "The United States destination region is not recognized.",
    });

    const response = await postDestination({
      country: "US",
      region: "Atlantis",
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: {
        code: "SHIPPING_DESTINATION_REGION_INVALID",
        message: "The United States destination region is not recognized.",
      },
    });
  });

  it("rejects malformed input before calling the service", async () => {
    const response = await postDestination({ region: "Pennsylvania" });

    expect(response.status).toBe(400);
    expect(normalize).not.toHaveBeenCalled();
  });
});

async function postDestination(
  body: unknown,
  apiKey: string | null = "destination-normalization-test-key",
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/api/shipping/internal/destinations/normalize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
