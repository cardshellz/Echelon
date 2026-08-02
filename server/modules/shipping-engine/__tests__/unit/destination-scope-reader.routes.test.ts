import http from "http";
import type { AddressInfo } from "net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerDestinationScopeReaderRoutes,
  type DestinationScopeReaderRouteDependencies,
} from "../../interfaces/http/destination-scope-reader.routes";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const originalInternalApiKey = process.env.INTERNAL_API_KEY;
const listActiveDestinationScopes = vi.fn<
  DestinationScopeReaderRouteDependencies["listActiveDestinationScopes"]
>();

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.INTERNAL_API_KEY = "destination-scope-test-key";
  const app = express();
  app.use(express.json());
  registerDestinationScopeReaderRoutes(app, { listActiveDestinationScopes });
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
  listActiveDestinationScopes.mockReset();
  listActiveDestinationScopes.mockResolvedValue([{
    id: 7,
    code: "lower_48",
    name: "Lower 48",
    status: "active",
    lockVersion: 3,
    members: [{ country: "US", region: "PA", postalPrefix: null }],
    updatedAt: "2026-08-01T12:00:00.000Z",
  }]);
});

describe("destination scope reader routes", () => {
  it("requires the configured internal API key", async () => {
    const response = await getScopes(null);
    expect(response.status).toBe(401);
    expect(listActiveDestinationScopes).not.toHaveBeenCalled();
  });

  it("returns the versioned active destination scope contract", async () => {
    const response = await getScopes();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      scopes: [{
        id: 7,
        code: "lower_48",
        name: "Lower 48",
        status: "active",
        lockVersion: 3,
        members: [{ country: "US", region: "PA", postalPrefix: null }],
        updatedAt: "2026-08-01T12:00:00.000Z",
      }],
    });
  });

  it("returns a structured error when the reader fails", async () => {
    listActiveDestinationScopes.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await getScopes();
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "DESTINATION_SCOPE_READ_FAILED",
        message: "Active shipping destination scopes could not be read.",
      },
    });
  });
});

async function getScopes(
  apiKey: string | null = "destination-scope-test-key",
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/api/shipping/internal/destination-scopes`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  return { status: response.status, body: await response.json() };
}
