import { createHmac } from "crypto";
import http from "http";
import { AddressInfo } from "net";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDropshipMarketplaceOrderIntakeRoutes } from "../../interfaces/http/dropship-marketplace-order-intake.routes";
import type {
  DropshipOrderIntakeSourceRepository,
  DropshipShopifyStoreUninstallResult,
} from "../../infrastructure/dropship-order-intake-source.repository";

vi.mock("../../../../db", () => ({
  pool: {},
  db: {},
}));

const now = new Date("2026-05-03T22:00:00.000Z");
const secret = "shopify-webhook-secret";

describe("Shopify dropship app uninstall webhook route", () => {
  let server: { url: string; close: () => Promise<void> };
  let sourceRepository: FakeDropshipOrderIntakeSourceRepository;

  beforeEach(async () => {
    sourceRepository = new FakeDropshipOrderIntakeSourceRepository();
    server = await startServer(buildApp(sourceRepository));
  });

  afterEach(async () => {
    await server.close();
  });

  it("verifies Shopify HMAC and disconnects the matching store connection", async () => {
    const payload = {
      id: 548380009,
      myshopify_domain: "vendor-shop.myshopify.com",
    };
    const response = await signedShopifyWebhookRequest(
      server.url,
      "/api/dropship/webhooks/shopify/app/uninstalled",
      payload,
      {
        "x-shopify-shop-domain": "vendor-shop.myshopify.com",
        "x-shopify-webhook-id": "webhook-1",
      },
    );

    expect(response).toEqual({
      status: 200,
      body: {
        status: "disconnected",
        changed: true,
        storeConnectionId: 22,
        previousStatus: "connected",
      },
    });
    expect(sourceRepository.lastUninstallInput).toEqual({
      shopDomain: "vendor-shop.myshopify.com",
      occurredAt: now,
      webhookId: "webhook-1",
    });
  });

  it("rejects app uninstall webhooks with an invalid HMAC", async () => {
    const response = await fetch(`${server.url}/api/dropship/webhooks/shopify/app/uninstalled`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-shop-domain": "vendor-shop.myshopify.com",
        "x-shopify-hmac-sha256": "invalid",
      },
      body: JSON.stringify({ id: 548380009 }),
    });

    expect(response.status).toBe(401);
    expect(sourceRepository.lastUninstallInput).toBeNull();
  });

  it("acknowledges app uninstall webhooks for stores that are not connected", async () => {
    sourceRepository.uninstallResult = {
      matched: false,
      changed: false,
      vendorId: null,
      storeConnectionId: null,
      previousStatus: null,
    };

    const response = await signedShopifyWebhookRequest(
      server.url,
      "/api/dropship/webhooks/shopify/app/uninstalled",
      { id: 548380009 },
      {
        "x-shopify-shop-domain": "missing-shop.myshopify.com",
      },
    );

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      status: "ignored",
      reason: "store_connection_not_found",
    });
  });
});

class FakeDropshipOrderIntakeSourceRepository implements DropshipOrderIntakeSourceRepository {
  lastUninstallInput: Parameters<DropshipOrderIntakeSourceRepository["markShopifyStoreUninstalled"]>[0] | null = null;
  uninstallResult: DropshipShopifyStoreUninstallResult = {
    matched: true,
    changed: true,
    vendorId: 10,
    storeConnectionId: 22,
    previousStatus: "connected",
  };

  async findShopifyStoreConnectionByShopDomain() {
    throw new Error("findShopifyStoreConnectionByShopDomain should not be called by uninstall route");
  }

  async markShopifyStoreUninstalled(
    input: Parameters<DropshipOrderIntakeSourceRepository["markShopifyStoreUninstalled"]>[0],
  ): Promise<DropshipShopifyStoreUninstallResult> {
    this.lastUninstallInput = input;
    return this.uninstallResult;
  }
}

function buildApp(sourceRepository: DropshipOrderIntakeSourceRepository): Express {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = buf;
    },
  }));
  registerDropshipMarketplaceOrderIntakeRoutes(app, {
    orderIntakeService: { recordMarketplaceOrder: vi.fn() } as any,
    sourceRepository,
    shopifyWebhookSecrets: [secret],
    clock: { now: () => now },
  });
  return app;
}

function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
  });
}

async function signedShopifyWebhookRequest(
  baseUrl: string,
  path: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const rawBody = JSON.stringify(payload);
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": createHmac("sha256", secret).update(rawBody).digest("base64"),
      ...headers,
    },
    body: rawBody,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) as unknown : null,
  };
}
