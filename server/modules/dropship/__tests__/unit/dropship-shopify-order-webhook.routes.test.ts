import { createHmac } from "crypto";
import http from "http";
import { AddressInfo } from "net";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DropshipOrderIntakeService,
  RecordDropshipOrderIntakeInput,
} from "../../application/dropship-order-intake-service";
import { registerDropshipMarketplaceOrderIntakeRoutes } from "../../interfaces/http/dropship-marketplace-order-intake.routes";
import type {
  DropshipOrderIntakeSourceRepository,
  DropshipOrderIntakeSourceStoreConnection,
  DropshipShopifyStoreUninstallResult,
} from "../../infrastructure/dropship-order-intake-source.repository";

vi.mock("../../../../db", () => ({
  pool: {},
  db: {},
}));

const secret = "shopify-webhook-secret";

describe("Shopify dropship order webhook routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let orderIntakeService: FakeDropshipOrderIntakeService;
  let sourceRepository: FakeDropshipOrderIntakeSourceRepository;

  beforeEach(async () => {
    orderIntakeService = new FakeDropshipOrderIntakeService();
    sourceRepository = new FakeDropshipOrderIntakeSourceRepository();
    server = await startServer(buildApp(orderIntakeService, sourceRepository));
  });

  afterEach(async () => {
    await server.close();
  });

  it("ignores unpaid orders/paid webhooks before store lookup or intake recording", async () => {
    const response = await signedShopifyWebhookRequest(
      server.url,
      "/api/dropship/webhooks/shopify/orders/paid",
      makeShopifyOrder({ financial_status: "pending" }),
      {
        "x-shopify-shop-domain": "vendor-shop.myshopify.com",
      },
    );

    expect(response).toEqual({
      status: 202,
      body: {
        status: "ignored",
        reason: "order_not_paid",
      },
    });
    expect(sourceRepository.lastFindShopDomain).toBeNull();
    expect(orderIntakeService.recordedInputs).toHaveLength(0);
  });

  it("records paid orders/paid webhooks for the matching Shopify store connection", async () => {
    const response = await signedShopifyWebhookRequest(
      server.url,
      "/api/dropship/webhooks/shopify/orders/paid",
      makeShopifyOrder({ financial_status: "paid" }),
      {
        "x-shopify-shop-domain": "vendor-shop.myshopify.com",
      },
    );

    expect(response).toEqual({
      status: 200,
      body: {
        status: "recorded",
        action: "created",
        intakeId: 44,
        intakeStatus: "received",
      },
    });
    expect(sourceRepository.lastFindShopDomain).toBe("vendor-shop.myshopify.com");
    expect(orderIntakeService.recordedInputs[0]).toMatchObject({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "shopify",
      externalOrderId: "gid://shopify/Order/1234567890",
      normalizedPayload: {
        marketplaceStatus: "paid",
      },
    });
  });
});

class FakeDropshipOrderIntakeService {
  recordedInputs: RecordDropshipOrderIntakeInput[] = [];

  async recordMarketplaceOrder(input: unknown) {
    this.recordedInputs.push(input as RecordDropshipOrderIntakeInput);
    return {
      action: "created",
      intake: {
        intakeId: 44,
        status: "received",
      },
    };
  }
}

class FakeDropshipOrderIntakeSourceRepository implements DropshipOrderIntakeSourceRepository {
  lastFindShopDomain: string | null = null;
  storeConnection: DropshipOrderIntakeSourceStoreConnection | null = {
    vendorId: 10,
    storeConnectionId: 22,
    platform: "shopify",
    shopDomain: "vendor-shop.myshopify.com",
    status: "connected",
  };

  async findShopifyStoreConnectionByShopDomain(
    shopDomain: string,
  ): Promise<DropshipOrderIntakeSourceStoreConnection | null> {
    this.lastFindShopDomain = shopDomain;
    return this.storeConnection;
  }

  async markShopifyStoreUninstalled(): Promise<DropshipShopifyStoreUninstallResult> {
    throw new Error("markShopifyStoreUninstalled should not be called by order webhook route");
  }
}

function buildApp(
  orderIntakeService: FakeDropshipOrderIntakeService,
  sourceRepository: DropshipOrderIntakeSourceRepository,
): Express {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = buf;
    },
  }));
  registerDropshipMarketplaceOrderIntakeRoutes(app, {
    orderIntakeService: orderIntakeService as unknown as DropshipOrderIntakeService,
    sourceRepository,
    shopifyWebhookSecrets: [secret],
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

function makeShopifyOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1234567890,
    admin_graphql_api_id: "gid://shopify/Order/1234567890",
    name: "#1001",
    financial_status: "paid",
    processed_at: "2026-05-03T14:30:00.000Z",
    currency: "USD",
    email: "buyer@example.com",
    subtotal_price: "12.99",
    total_tax: "0.00",
    total_discounts: "0.00",
    total_price: "17.99",
    shipping_address: {
      name: "Card Buyer",
      address1: "1 Main St",
      city: "New York",
      province_code: "NY",
      zip: "10001",
      country_code: "US",
    },
    shipping_lines: [
      { price: "5.00" },
    ],
    line_items: [
      {
        id: 555,
        product_id: 777,
        variant_id: 888,
        sku: "SKU-101",
        title: "Toploader",
        quantity: 1,
        price: "12.99",
      },
    ],
    ...overrides,
  };
}
