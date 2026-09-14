import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerShopifyProductConsolidationRoutes } from "../../shopify-product-consolidation.routes";

const { applyMock, createServiceMock, previewMock, requirePermissionMock } = vi.hoisted(() => ({
  applyMock: vi.fn(),
  createServiceMock: vi.fn(),
  previewMock: vi.fn(),
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (
      _req: unknown,
      _res: unknown,
      next: () => void,
    ) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: requirePermissionMock,
}));

vi.mock("../../shopify-product-consolidation.service", () => ({
  createShopifyProductConsolidationService: createServiceMock,
}));

describe("Shopify product consolidation routes", () => {
  let server: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    previewMock.mockReset();
    applyMock.mockReset();
    createServiceMock.mockReset().mockReturnValue({
      preview: previewMock,
      apply: applyMock,
    });
    requirePermissionMock.mockClear();
    server = await startServer();
  });

  afterEach(async () => server.close());

  it("permission-gates and forwards a strict read-only preview", async () => {
    previewMock.mockResolvedValue({
      contractVersion: 1,
      generatedAt: "2026-09-12T16:00:00.000Z",
      readOnly: true,
      plan: { canApply: false },
    });
    const body = { shopifyProductId: "9001", canonicalProductId: 10 };

    const result = await jsonRequest(
      `${server.url}/api/channels/36/shopify-mapping-reconciliation/ownership-review/consolidation/preview`,
      body,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ readOnly: true });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory", "view");
    expect(previewMock).toHaveBeenCalledWith({ channelId: 36, request: body });
  });

  it("rejects unrecognized fields before calling the service", async () => {
    const result = await jsonRequest(
      `${server.url}/api/channels/36/shopify-mapping-reconciliation/ownership-review/consolidation/preview`,
      { shopifyProductId: "9001", canonicalProductId: 10, force: true },
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      code: "INVALID_SHOPIFY_PRODUCT_CONSOLIDATION_REQUEST",
    });
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("permission-gates and forwards an authenticated, evidence-bound apply", async () => {
    applyMock.mockResolvedValue({ commandId: 88, idempotentReplay: false });
    const body = {
      shopifyProductId: "9001",
      canonicalProductId: 10,
      expectedShopDomain: "cardshellz.myshopify.com",
      expectedPreviewHash: "a".repeat(64),
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
      reason: "Consolidate the reviewed product family",
    };

    const result = await jsonRequest(
      `${server.url}/api/channels/36/shopify-mapping-reconciliation/ownership-review/consolidation/apply`,
      body,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ commandId: 88 });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory", "edit");
    expect(applyMock).toHaveBeenCalledWith({
      channelId: 36,
      request: body,
      actor: "user:test-operator",
    });
  });
});

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { session: { user: { id: string } } }).session = {
      user: { id: "test-operator" },
    };
    next();
  });
  registerShopifyProductConsolidationRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      }));
    });
    request.on("error", reject);
    request.write(JSON.stringify(body));
    request.end();
  });
}
