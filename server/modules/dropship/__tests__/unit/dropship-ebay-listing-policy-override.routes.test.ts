import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipEbayListingPolicyOverrideService } from "../../application/dropship-ebay-listing-policy-override-service";
import { DropshipError } from "../../domain/errors";
import { registerDropshipEbayListingPolicyOverrideRoutes } from "../../interfaces/http/dropship-ebay-listing-policy-override.routes";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../infrastructure/dropship-ebay-listing-policy-override.factory", () => ({
  createDropshipEbayListingPolicyOverrideServiceFromEnv: vi.fn(),
}));

describe("dropship eBay listing policy override routes", () => {
  let service: FakeService;
  let server: { url: string; close: () => Promise<void> } | null;

  beforeEach(() => {
    service = new FakeService();
    server = null;
  });

  afterEach(async () => {
    await server?.close();
  });

  it("lists overrides for the authenticated member-owned store", async () => {
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(
      `${server.url}/api/dropship/ebay/listing-policy-overrides/44`,
    );

    expect(response.status).toBe(200);
    expect(service.listCall).toEqual({
      memberId: "member-1",
      input: { storeConnectionId: 44 },
    });
  });

  it("passes all three explicit inheritance-or-override choices with one idempotency key", async () => {
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(
      `${server.url}/api/dropship/ebay/listing-policy-overrides/501`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "listing-policy-route-001",
        },
        body: JSON.stringify({
          storeConnectionId: 44,
          fulfillmentPolicyId: "fulfillment-compatible",
          returnPolicyId: null,
          paymentPolicyId: "payment-override",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(service.replaceCall).toEqual({
      memberId: "member-1",
      input: {
        storeConnectionId: 44,
        productVariantId: 501,
        expectedRevisionId: null,
        fulfillmentPolicyId: "fulfillment-compatible",
        returnPolicyId: null,
        paymentPolicyId: "payment-override",
        idempotencyKey: "listing-policy-route-001",
      },
    });
  });

  it("rejects conflicting body and header idempotency keys before the service call", async () => {
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(
      `${server.url}/api/dropship/ebay/listing-policy-overrides/501`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "listing-policy-route-002",
        },
        body: JSON.stringify({
          storeConnectionId: 44,
          fulfillmentPolicyId: null,
          returnPolicyId: null,
          paymentPolicyId: null,
          idempotencyKey: "listing-policy-route-003",
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: { code: "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_IDEMPOTENCY_CONFLICT" },
    });
    expect(service.replaceCall).toBeNull();
  });

  it("rejects override access without a dropship session", async () => {
    server = await startServer(buildApp(service, false));

    const response = await jsonRequest(
      `${server.url}/api/dropship/ebay/listing-policy-overrides/44`,
    );

    expect(response.status).toBe(401);
    expect(service.listCall).toBeNull();
  });

  it("preserves an eBay authorization failure as an actionable 403 response", async () => {
    service.listError = new DropshipError(
      "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
      "eBay authorization must be refreshed before listing setup can be loaded.",
      { storeConnectionId: 44, resource: "authorization", retryable: false },
    );
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(
      `${server.url}/api/dropship/ebay/listing-policy-overrides/44`,
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: {
        code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
        context: {
          storeConnectionId: 44,
          resource: "authorization",
          retryable: false,
        },
      },
    });
  });

  it("preserves missing fulfillment routing as an actionable 409 response", async () => {
    service.listError = new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED",
      "Standard Shipping needs at least one allowed domestic fulfillment method before eBay policies can be validated.",
      {
        serviceLevelId: 7,
        routingCode: "SHIPPING_FULFILLMENT_ROUTING_NO_ELIGIBLE_METHODS",
        routingRevision: 4,
        retryable: false,
      },
    );
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(
      `${server.url}/api/dropship/ebay/listing-policy-overrides/44`,
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: {
        code: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED",
        context: {
          serviceLevelId: 7,
          routingCode: "SHIPPING_FULFILLMENT_ROUTING_NO_ELIGIBLE_METHODS",
          routingRevision: 4,
          retryable: false,
        },
      },
    });
  });

  it("returns 409 with revision evidence for an optimistic concurrency conflict", async () => {
    service.replaceError = new DropshipError(
      "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_VERSION_CONFLICT",
      "The listing policy override changed after it was loaded. Refresh and try again.",
      {
        storeConnectionId: 44,
        productVariantId: 501,
        expectedRevisionId: 90,
        actualRevisionId: 92,
        retryable: false,
      },
    );
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(
      `${server.url}/api/dropship/ebay/listing-policy-overrides/501`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeConnectionId: 44,
          expectedRevisionId: 90,
          fulfillmentPolicyId: null,
          returnPolicyId: null,
          paymentPolicyId: null,
          idempotencyKey: "listing-policy-route-004",
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: {
        code: "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_VERSION_CONFLICT",
        context: { expectedRevisionId: 90, actualRevisionId: 92 },
      },
    });
  });
});

class FakeService {
  listCall: unknown = null;
  listError: Error | null = null;
  replaceCall: unknown = null;
  replaceError: Error | null = null;

  async listForMember(memberId: string, input: unknown) {
    this.listCall = { memberId, input };
    if (this.listError) throw this.listError;
    return {
      storeConnectionId: 44,
      defaults: {},
      options: {},
      assignments: [],
      fetchedAt: new Date(0),
    };
  }

  async replaceForMember(memberId: string, input: unknown) {
    this.replaceCall = { memberId, input };
    if (this.replaceError) throw this.replaceError;
    return { assignment: null, revisionId: 9, idempotentReplay: false };
  }
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
            authenticatedAt: "2026-09-01T15:00:00.000Z",
          },
          dropshipSensitiveProofs: {},
        }
      : {};
    next();
  });
  registerDropshipEbayListingPolicyOverrideRoutes(
    app,
    service as unknown as DropshipEbayListingPolicyOverrideService,
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
