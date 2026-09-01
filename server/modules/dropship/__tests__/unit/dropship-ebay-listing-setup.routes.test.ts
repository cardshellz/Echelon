import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipEbayListingSetupService } from "../../application/dropship-ebay-listing-setup-service";
import { DropshipError } from "../../domain/errors";
import { registerDropshipEbayListingSetupRoutes } from "../../interfaces/http/dropship-ebay-listing-setup.routes";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../infrastructure/dropship-ebay-listing-setup.factory", () => ({
  createDropshipEbayListingSetupServiceFromEnv: vi.fn(),
}));

describe("dropship eBay listing setup routes", () => {
  let service: FakeService;
  let server: Awaited<ReturnType<typeof startServer>> | null;

  beforeEach(() => {
    service = new FakeService();
    server = null;
  });

  afterEach(async () => {
    await server?.close();
  });

  it("loads listing choices for the authenticated member-owned store", async () => {
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(`${server.url}/api/dropship/ebay/listing-setup/44`);

    expect(response.status).toBe(200);
    expect(service.getCall).toEqual({ memberId: "member-1", storeConnectionId: 44 });
    expect(response.body).toMatchObject({ storeConnectionId: 44, marketplaceId: "EBAY_US" });
  });

  it("saves validated setup without requiring listing-push MFA", async () => {
    server = await startServer(buildApp(service, true));
    const selection = {
      merchantLocationKey: "warehouse-main",
      fulfillmentPolicyId: "fulfillment-1",
      returnPolicyId: "return-1",
      paymentPolicyId: "payment-1",
    };

    const response = await jsonRequest(`${server.url}/api/dropship/ebay/listing-setup/44`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(selection),
    });

    expect(response.status).toBe(200);
    expect(service.replaceCall).toEqual({
      memberId: "member-1",
      storeConnectionId: 44,
      input: selection,
    });
  });

  it("rejects incomplete setup input before invoking the application service", async () => {
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(`${server.url}/api/dropship/ebay/listing-setup/44`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchantLocationKey: "warehouse-main" }),
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "DROPSHIP_EBAY_LISTING_SETUP_INVALID_INPUT" },
    });
    expect(service.replaceCall).toBeNull();
  });

  it("returns an actionable authorization error without leaking provider bodies", async () => {
    service.getError = new DropshipError(
      "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
      "eBay did not grant the required access.",
      {
        storeConnectionId: 44,
        resource: "paymentPolicies",
        status: 403,
        retryable: false,
        body: "provider-secret-diagnostic",
      },
    );
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(`${server.url}/api/dropship/ebay/listing-setup/44`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: {
        code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
        context: {
          storeConnectionId: 44,
          resource: "paymentPolicies",
          status: 403,
          retryable: false,
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("provider-secret-diagnostic");
  });

  it("returns an actionable conflict when the managed warehouse address is incomplete", async () => {
    service.getError = new DropshipError(
      "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_ADDRESS_REQUIRED",
      "The dropship origin warehouse is missing eBay location address data.",
      { originWarehouseId: 1, field: "postalCode", retryable: false },
    );
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(`${server.url}/api/dropship/ebay/listing-setup/44`);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: {
        code: "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_ADDRESS_REQUIRED",
        context: { originWarehouseId: 1, field: "postalCode", retryable: false },
      },
    });
  });

  it("requires a dropship session", async () => {
    server = await startServer(buildApp(service, false));

    const response = await jsonRequest(`${server.url}/api/dropship/ebay/listing-setup/44`);

    expect(response.status).toBe(401);
    expect(service.getCall).toBeNull();
  });
});

class FakeService {
  getCall: unknown = null;
  replaceCall: unknown = null;
  getError: Error | null = null;

  async getForMember(memberId: string, storeConnectionId: number) {
    this.getCall = { memberId, storeConnectionId };
    if (this.getError) throw this.getError;
    return result();
  }

  async replaceForMember(memberId: string, storeConnectionId: number, input: unknown) {
    this.replaceCall = { memberId, storeConnectionId, input };
    return result();
  }
}

function result() {
  return {
    storeConnectionId: 44,
    marketplaceId: "EBAY_US",
    complete: true,
    missingFields: [],
    selection: {
      merchantLocationKey: "warehouse-main",
      fulfillmentPolicyId: "fulfillment-1",
      returnPolicyId: "return-1",
      paymentPolicyId: "payment-1",
    },
    options: {
      merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
      fulfillmentPolicies: [{ id: "fulfillment-1", name: "Standard" }],
      returnPolicies: [{ id: "return-1", name: "Thirty days" }],
      paymentPolicies: [{ id: "payment-1", name: "Managed payments" }],
    },
  };
}

function buildApp(service: FakeService, authenticated: boolean): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { session: Record<string, unknown> }).session = authenticated
      ? {
          dropship: {
            authIdentityId: 1,
            memberId: "member-1",
            cardShellzEmail: "vendor@cardshellz.test",
            hasPasskey: false,
            authMethod: "password",
            entitlementStatus: "active",
            authenticatedAt: "2026-08-30T12:00:00.000Z",
          },
          dropshipSensitiveProofs: {},
        }
      : {};
    next();
  });
  registerDropshipEbayListingSetupRoutes(
    app,
    service as unknown as DropshipEbayListingSetupService,
  );
  return app;
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const listener = http.createServer(app);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      listener.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function jsonRequest(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}
