import http from "http";
import { AddressInfo } from "net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ShopifyMappingReconciliationError,
} from "../../shopify-product-mapping-reconciliation.service";
import {
  ShopifyMappingVerificationError,
} from "../../shopify-product-mapping-verifier";
import {
  registerShopifyProductMappingReconciliationRoutes,
} from "../../shopify-product-mapping-reconciliation.routes";

const { requirePermissionMock, serviceMocks, createServiceMock } = vi.hoisted(
  () => {
    const serviceMocks = {
      scan: vi.fn(),
      retireStaleMapping: vi.fn(),
    };
    return {
      requirePermissionMock: vi.fn(
        (_resource: string, _action: string) => (
          _req: unknown,
          _res: unknown,
          next: () => void,
        ) => next(),
      ),
      serviceMocks,
      createServiceMock: vi.fn(() => serviceMocks),
    };
  },
);

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: requirePermissionMock,
}));

vi.mock(
  "../../shopify-product-mapping-reconciliation.service",
  async (importOriginal) => ({
    ...await importOriginal<
      typeof import("../../shopify-product-mapping-reconciliation.service")
    >(),
    createShopifyProductMappingReconciliationService: createServiceMock,
  }),
);

describe("Shopify product mapping reconciliation routes", () => {
  let server: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    createServiceMock.mockClear();
    serviceMocks.scan.mockReset();
    serviceMocks.retireStaleMapping.mockReset();
    server = await startServer(buildApp());
  });

  afterEach(async () => server.close());

  it("authorizes and forwards a live mapping-health scan", async () => {
    serviceMocks.scan.mockResolvedValue({
      generatedAt: "2026-07-24T12:00:00.000Z",
      summary: { issueProductCount: 0 },
      items: [],
    });

    const result = await jsonRequest(
      `${server.url}/api/channels/36/shopify-mapping-reconciliation`,
    );

    expect(result).toEqual({
      status: 200,
      body: {
        generatedAt: "2026-07-24T12:00:00.000Z",
        summary: { issueProductCount: 0 },
        items: [],
      },
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory", "view");
    expect(serviceMocks.scan).toHaveBeenCalledWith(36);
  });

  it("rejects an invalid channel identifier before calling the service", async () => {
    const result = await jsonRequest(
      `${server.url}/api/channels/not-an-id/shopify-mapping-reconciliation`,
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      code: "INVALID_SHOPIFY_MAPPING_RECONCILIATION_REQUEST",
    });
    expect(serviceMocks.scan).not.toHaveBeenCalled();
  });

  it("validates and forwards an audited stale-mapping retirement", async () => {
    serviceMocks.retireStaleMapping.mockResolvedValue({
      productId: 10,
      retiredShopifyProductId: "9001",
      afterStatus: "unmapped",
    });

    const result = await jsonRequest(
      `${server.url}/api/channels/36/shopify-mapping-reconciliation/products/10/retire`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedProductId: "gid://shopify/Product/9001",
          expectedFingerprint: "fingerprint-10",
          expectedShopDomain: "cardshellz.myshopify.com",
        }),
      },
    );

    expect(result).toEqual({
      status: 200,
      body: {
        productId: 10,
        retiredShopifyProductId: "9001",
        afterStatus: "unmapped",
      },
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory", "edit");
    expect(serviceMocks.retireStaleMapping).toHaveBeenCalledWith({
      channelId: 36,
      productId: 10,
      expectedProductId: "gid://shopify/Product/9001",
      expectedFingerprint: "fingerprint-10",
      expectedShopDomain: "cardshellz.myshopify.com",
      actor: "user:operator-1",
    });
  });

  it("rejects unrecognized retirement fields before calling the service", async () => {
    const result = await jsonRequest(
      `${server.url}/api/channels/36/shopify-mapping-reconciliation/products/10/retire`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedProductId: "9001",
          expectedFingerprint: "fingerprint-10",
          expectedShopDomain: "cardshellz.myshopify.com",
          force: true,
        }),
      },
    );

    expect(result.status).toBe(400);
    expect(serviceMocks.retireStaleMapping).not.toHaveBeenCalled();
  });

  it("requires a traceable authenticated actor for retirement", async () => {
    const result = await jsonRequest(
      `${server.url}/api/channels/36/shopify-mapping-reconciliation/products/10/retire`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Test-No-Actor": "true",
        },
        body: JSON.stringify({
          expectedProductId: "9001",
          expectedFingerprint: "fingerprint-10",
          expectedShopDomain: "cardshellz.myshopify.com",
        }),
      },
    );

    expect(result).toEqual({
      status: 401,
      body: {
        error: "Authenticated user identity is required",
        code: "AUTHENTICATED_ACTOR_REQUIRED",
        context: {},
      },
    });
    expect(serviceMocks.retireStaleMapping).not.toHaveBeenCalled();
  });

  it("preserves classified reconciliation and Shopify verification errors", async () => {
    serviceMocks.scan.mockRejectedValueOnce(
      new ShopifyMappingVerificationError(
        "SHOPIFY_MAPPING_LOOKUP_RATE_LIMITED",
        "Shopify mapping verification remained rate limited",
        503,
      ),
    );
    const scanResult = await jsonRequest(
      `${server.url}/api/channels/36/shopify-mapping-reconciliation`,
    );
    expect(scanResult).toEqual({
      status: 503,
      body: {
        error: "Shopify mapping verification remained rate limited",
        code: "SHOPIFY_MAPPING_LOOKUP_RATE_LIMITED",
        context: {},
      },
    });

    serviceMocks.retireStaleMapping.mockRejectedValueOnce(
      new ShopifyMappingReconciliationError(
        "SHOPIFY_MAPPING_CHANGED",
        "The Shopify mapping changed after the health scan. Refresh and try again.",
        409,
        { productId: 10 },
      ),
    );
    const retireResult = await jsonRequest(
      `${server.url}/api/channels/36/shopify-mapping-reconciliation/products/10/retire`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedProductId: "9001",
          expectedFingerprint: "fingerprint-10",
          expectedShopDomain: "cardshellz.myshopify.com",
        }),
      },
    );
    expect(retireResult).toEqual({
      status: 409,
      body: {
        error:
          "The Shopify mapping changed after the health scan. Refresh and try again.",
        code: "SHOPIFY_MAPPING_CHANGED",
        context: { productId: 10 },
      },
    });
  });
});

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header("X-Test-No-Actor") !== "true") {
      Object.defineProperty(req, "session", {
        configurable: true,
        value: { user: { id: "operator-1" } },
      });
    }
    next();
  });
  registerShopifyProductMappingReconciliationRoutes(app);
  return app;
}

async function startServer(
  app: express.Express,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve));
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
          body: rawBody === ""
            ? {}
            : JSON.parse(rawBody) as Record<string, unknown>,
        });
      });
    });
    request.on("error", reject);
    if (init?.body !== undefined) request.write(init.body);
    request.end();
  });
}
