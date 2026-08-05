import http from "http";
import { AddressInfo } from "net";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerMarketplaceListingReplacementRoutes,
  type MarketplaceListingReplacementServiceResolver,
} from "../../interfaces/http/listing-replacement.routes";

vi.mock("../../../../routes/middleware", () => ({
  requirePermission:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

describe("marketplace listing replacement routes", () => {
  let running: Awaited<ReturnType<typeof startServer>>;
  let resolver: FakeResolver;

  beforeEach(async () => {
    resolver = new FakeResolver();
    running = await startServer(buildApp(resolver));
  });
  afterEach(async () => {
    await running.close();
  });

  it("builds a server-owned Channel planning command", async () => {
    const response = await request(
      running.url + "/api/marketplace-listings/replacements/channel/ebay/plan",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "replace-channel-7-product-33",
          "X-Correlation-Id": "operator-review-1",
        },
        body: JSON.stringify({
          channelId: 7,
          productId: 33,
          marketplaceId: "EBAY_US",
          targetMembers: members(),
        }),
      },
    );
    expect(response.status).toBe(201);
    expect(resolver.owner).toEqual({
      kind: "channel",
      channelId: 7,
      productId: 33,
      provider: "ebay",
      marketplaceId: "EBAY_US",
    });
    expect(resolver.input).toEqual({
      owner: resolver.owner,
      targetMembers: members(),
      idempotencyKey: "replace-channel-7-product-33",
      requestedBy: { type: "user", id: "admin-1" },
      correlationId: "operator-review-1",
    });
  });

  it("builds the same contract for a Dropship owner", async () => {
    const response = await request(
      running.url + "/api/marketplace-listings/replacements/dropship/ebay/plan",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeConnectionId: 91,
          productId: 33,
          marketplaceId: "EBAY_US",
          targetMembers: members(),
          idempotencyKey: "replace-dropship-91-product-33",
        }),
      },
    );
    expect(response.status).toBe(201);
    expect(resolver.owner).toMatchObject({
      kind: "dropship",
      storeConnectionId: 91,
      provider: "ebay",
    });
    expect(resolver.input).toMatchObject({
      owner: resolver.owner,
      requestedBy: { type: "user", id: "admin-1" },
    });
  });

  it("rejects forged actor fields before resolving a service", async () => {
    const response = await request(
      running.url + "/api/marketplace-listings/replacements/channel/ebay/plan",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "forged",
        },
        body: JSON.stringify({
          channelId: 7,
          productId: 33,
          marketplaceId: "EBAY_US",
          targetMembers: members(),
          requestedBy: { type: "system", id: "forged" },
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(resolver.owner).toBeNull();
  });

  it("rejects a target with no included variant", async () => {
    const response = await request(
      running.url + "/api/marketplace-listings/replacements/channel/ebay/plan",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "empty-target",
        },
        body: JSON.stringify({
          channelId: 7,
          productId: 33,
          marketplaceId: "EBAY_US",
          targetMembers: [
            {
              productVariantId: 12,
              disposition: "excluded",
              reasonCode: "operator_excluded",
            },
          ],
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(resolver.input).toBeNull();
  });

  it("rejects conflicting idempotency values", async () => {
    const response = await request(
      running.url + "/api/marketplace-listings/replacements/channel/ebay/plan",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "header",
        },
        body: JSON.stringify({
          channelId: 7,
          productId: 33,
          marketplaceId: "EBAY_US",
          targetMembers: members(),
          idempotencyKey: "body",
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("disagree");
    expect(resolver.input).toBeNull();
  });
});

function members() {
  return [
    { productVariantId: 12, disposition: "included", reasonCode: null },
    {
      productVariantId: 13,
      disposition: "excluded",
      reasonCode: "operator_excluded",
    },
  ];
}
class FakeResolver implements MarketplaceListingReplacementServiceResolver {
  owner: any = null;
  input: any = null;
  forOwner(owner: any) {
    this.owner = owner;
    return {
      plan: async (input: unknown) => {
        this.input = input;
        return { kind: "created", operation: { operationId: 1 } };
      },
    };
  }
}
function buildApp(resolver: MarketplaceListingReplacementServiceResolver) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    req.session = { user: { id: "admin-1" } } as any;
    next();
  });
  registerMarketplaceListingReplacementRoutes(app, resolver);
  return app;
}
async function startServer(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: "http://127.0.0.1:" + address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
async function request(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}
