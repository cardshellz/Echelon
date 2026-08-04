import http from "http";
import { AddressInfo } from "net";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarketplaceListingRegistrationError } from "../../domain/registration-errors";
import {
  registerMarketplaceListingRegistrationRoutes,
  type MarketplaceListingRegistrationServiceResolver,
} from "../../interfaces/http/listing-registration.routes";

vi.mock("../../../../routes/middleware", () => ({
  requirePermission:
    () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

describe("marketplace listing registration routes", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let resolver: FakeResolver;

  beforeEach(async () => {
    resolver = new FakeResolver();
    server = await startServer(buildApp(resolver));
  });

  afterEach(async () => {
    await server.close();
  });

  it("builds a server-owned Channel eBay preview command", async () => {
    const response = await jsonRequest(
      server.url + "/api/marketplace-listings/registrations/channel/ebay/preview",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "register-channel-44-product-88",
          "X-Correlation-Id": "registration-review-1",
        },
        body: JSON.stringify({
          channelId: 44,
          productId: 88,
          marketplaceId: "EBAY_US",
          externalListingId: "36412213011",
          providerPublicationKey: null,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.preview).toMatchObject({ observationHash: "a".repeat(64) });
    expect(resolver.lastOwner).toEqual({
      kind: "channel",
      channelId: 44,
      productId: 88,
      provider: "ebay",
      marketplaceId: "EBAY_US",
    });
    expect(resolver.service.previewInput).toEqual({
      owner: resolver.lastOwner,
      locator: {
        providerPublicationKey: null,
        externalListingId: "36412213011",
      },
      idempotencyKey: "register-channel-44-product-88",
      requestedBy: { type: "user", id: "admin-1" },
      correlationId: "registration-review-1",
    });
  });

  it("builds a server-owned Dropship eBay confirmation command", async () => {
    const response = await jsonRequest(
      server.url + "/api/marketplace-listings/registrations/dropship/ebay/confirm",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeConnectionId: 17,
          productId: 88,
          marketplaceId: "EBAY_US",
          externalListingId: "36412213011",
          providerPublicationKey: "ARM-ENV-SGL",
          expectedObservationHash: "a".repeat(64),
          idempotencyKey: "register-dropship-17-product-88",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({ kind: "created" });
    expect(resolver.lastOwner).toEqual({
      kind: "dropship",
      storeConnectionId: 17,
      productId: 88,
      provider: "ebay",
      marketplaceId: "EBAY_US",
    });
    expect(resolver.service.confirmInput).toMatchObject({
      owner: resolver.lastOwner,
      expectedObservationHash: "a".repeat(64),
      idempotencyKey: "register-dropship-17-product-88",
      requestedBy: { type: "user", id: "admin-1" },
    });
  });

  it("loads persisted Channel registrations for multiple products in one service call", async () => {
    const response = await jsonRequest(
      server.url
        + "/api/marketplace-listings/registrations/channel/ebay/status"
        + "?channelId=44&marketplaceId=EBAY_US&productIds=88,99",
      { method: "GET" },
    );

    expect(response.status).toBe(200);
    expect(resolver.lastOwner).toEqual({
      kind: "channel",
      channelId: 44,
      productId: 88,
      provider: "ebay",
      marketplaceId: "EBAY_US",
    });
    expect(resolver.service.statusOwners).toEqual([
      resolver.lastOwner,
      { ...resolver.lastOwner, productId: 99 },
    ]);
    expect(response.body.statuses).toEqual([]);
  });

  it("rejects an absent marketplace instead of silently assuming EBAY_US", async () => {
    const response = await jsonRequest(
      server.url + "/api/marketplace-listings/registrations/channel/ebay/preview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "no-market" },
        body: JSON.stringify({
          channelId: 44,
          productId: 88,
          externalListingId: "36412213011",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(resolver.lastOwner).toBeNull();
  });

  it("rejects missing locators before resolving a service", async () => {
    const response = await jsonRequest(
      server.url + "/api/marketplace-listings/registrations/channel/ebay/preview",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "missing-locator",
        },
        body: JSON.stringify({
          channelId: 44,
          productId: 88,
          marketplaceId: "EBAY_US",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(
      "MARKETPLACE_LISTING_REGISTRATION_REQUEST_INVALID",
    );
    expect(resolver.lastOwner).toBeNull();
  });

  it("rejects client-supplied actor fields", async () => {
    const response = await jsonRequest(
      server.url + "/api/marketplace-listings/registrations/channel/ebay/preview",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "forged-actor",
        },
        body: JSON.stringify({
          channelId: 44,
          productId: 88,
          marketplaceId: "EBAY_US",
          externalListingId: "36412213011",
          requestedBy: { type: "system", id: "forged" },
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(resolver.lastOwner).toBeNull();
  });

  it("rejects disagreeing idempotency values", async () => {
    const response = await jsonRequest(
      server.url + "/api/marketplace-listings/registrations/channel/ebay/confirm",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "header-value",
        },
        body: JSON.stringify({
          channelId: 44,
          productId: 88,
          marketplaceId: "EBAY_US",
          externalListingId: "36412213011",
          expectedObservationHash: "a".repeat(64),
          idempotencyKey: "body-value",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("disagree");
    expect(resolver.service.confirmInput).toBeNull();
  });

  it("returns an actionable conflict when provider state changed", async () => {
    resolver.service.confirmError = new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_OBSERVATION_CHANGED",
      "The marketplace listing changed after preview.",
      { expectedObservationHash: "a".repeat(64), actualObservationHash: "b".repeat(64) },
    );

    const response = await jsonRequest(
      server.url + "/api/marketplace-listings/registrations/channel/ebay/confirm",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "changed-observation",
        },
        body: JSON.stringify({
          channelId: 44,
          productId: 88,
          marketplaceId: "EBAY_US",
          externalListingId: "36412213011",
          expectedObservationHash: "a".repeat(64),
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_OBSERVATION_CHANGED",
      context: { actualObservationHash: "b".repeat(64) },
    });
  });

  it("returns service unavailable when owner adapter configuration cannot load", async () => {
    resolver.service.confirmError = new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_CONFIGURATION_UNAVAILABLE",
      "Marketplace listing registration is not configured for this owner.",
      { ownerKind: "channel", channelId: 44, productId: 88 },
    );

    const response = await jsonRequest(
      server.url + "/api/marketplace-listings/registrations/channel/ebay/confirm",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "missing-registration-config",
        },
        body: JSON.stringify({
          channelId: 44,
          productId: 88,
          marketplaceId: "EBAY_US",
          externalListingId: "36412213011",
          expectedObservationHash: "a".repeat(64),
        }),
      },
    );

    expect(response.status).toBe(503);
    expect(response.body.error).toEqual({
      code: "MARKETPLACE_LISTING_REGISTRATION_CONFIGURATION_UNAVAILABLE",
      message: "Marketplace listing registration is not configured for this owner.",
      context: { ownerKind: "channel", channelId: 44, productId: 88 },
    });
  });
});

class FakeRegistrationService {
  previewInput: unknown = null;
  confirmInput: unknown = null;
  statusOwners: unknown = null;
  confirmError: Error | null = null;

  async preview(input: unknown): Promise<any> {
    this.previewInput = input;
    return { observationHash: "a".repeat(64) };
  }

  async confirm(input: unknown): Promise<any> {
    this.confirmInput = input;
    if (this.confirmError) throw this.confirmError;
    return {
      kind: "created",
      receipt: {
        registrationId: 1,
        scopeId: 2,
        providerAccountId: 3,
        publicationId: 4,
      },
    };
  }

  async getCurrentRegistrationStatuses(owners: unknown): Promise<any[]> {
    this.statusOwners = owners;
    return [];
  }
}

class FakeResolver implements MarketplaceListingRegistrationServiceResolver {
  readonly service = new FakeRegistrationService();
  lastOwner: any = null;

  forOwner(owner: any): any {
    this.lastOwner = owner;
    return this.service;
  }
}

function buildApp(resolver: MarketplaceListingRegistrationServiceResolver): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    req.session = { user: { id: "admin-1" } } as any;
    next();
  });
  registerMarketplaceListingRegistrationRoutes(app, resolver);
  return app;
}

async function startServer(app: express.Express): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: "http://127.0.0.1:" + address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function jsonRequest(url: string, init: RequestInit): Promise<{
  status: number;
  body: any;
}> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}
