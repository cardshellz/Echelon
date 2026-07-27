import http from "http";
import { AddressInfo } from "net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductRatePolicyAdminError } from "../../application/product-rate-policy-admin.service";
import { registerProductRatePolicyAdminRoutes } from "../../interfaces/http/product-rate-policy-admin.routes";

const { requirePermissionMock, serviceMocks } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (
      _req: unknown,
      _res: unknown,
      next: () => void,
    ) => next(),
  ),
  serviceMocks: {
    createRateTableProductRule: vi.fn(),
    deleteRateTableProductRule: vi.fn(),
    listProductPolicySelectors: vi.fn(),
    listRateTableProductRuleMembers: vi.fn(),
    listRateTableProductRules: vi.fn(),
    previewRateTableProductPolicy: vi.fn(),
    updateRateTableProductRule: vi.fn(),
  },
}));

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: requirePermissionMock,
}));

vi.mock("../../application/product-rate-policy-admin.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../application/product-rate-policy-admin.service")>(),
  ...serviceMocks,
}));

describe("product-rate policy admin routes", () => {
  let server: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    Object.values(serviceMocks).forEach((mock) => mock.mockReset());
    server = await startServer(buildApp());
  });

  afterEach(async () => server.close());

  it("normalizes and forwards a bounded product rule", async () => {
    serviceMocks.createRateTableProductRule.mockResolvedValue({ id: 91 });
    const response = await jsonRequest(`${server.url}/api/shipping/admin/rate-tables/12/product-rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validRule()),
    });

    expect(response).toEqual({ status: 201, body: { rule: { id: 91 } } });
    expect(requirePermissionMock).toHaveBeenCalledWith("settings", "edit");
    expect(serviceMocks.createRateTableProductRule).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        destinationScope: {
          country: "US",
          regions: ["CA"],
          postalPrefixes: [],
        },
        rateCents: 1_299,
      }),
      "operator-1",
    );
  });

  it("accepts base plus additional-unit pricing with matching quantities combined", async () => {
    serviceMocks.createRateTableProductRule.mockResolvedValue({ id: 93 });
    const response = await jsonRequest(`${server.url}/api/shipping/admin/rate-tables/12/product-rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validRule(),
        action: "base_plus_per_additional_unit",
        rateCents: 1_200,
        perAdditionalUnitCents: 600,
      }),
    });

    expect(response).toEqual({ status: 201, body: { rule: { id: 93 } } });
    expect(serviceMocks.createRateTableProductRule).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        action: "base_plus_per_additional_unit",
        measurementScope: "matched_items",
        rateCents: 1_200,
        perAdditionalUnitCents: 600,
      }),
      "operator-1",
    );
  });

  it("rejects an additional-unit amount on an unrelated action", async () => {
    const response = await jsonRequest(`${server.url}/api/shipping/admin/rate-tables/12/product-rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validRule(), perAdditionalUnitCents: 600 }),
    });

    expect(response.status).toBe(400);
    expect(serviceMocks.createRateTableProductRule).not.toHaveBeenCalled();
  });

  it("accepts a shipping restriction without a monetary amount", async () => {
    serviceMocks.createRateTableProductRule.mockResolvedValue({ id: 92 });
    const response = await jsonRequest(`${server.url}/api/shipping/admin/rate-tables/12/product-rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validRule(),
        name: "No cases to Alaska",
        kind: "restriction",
        action: "block",
        rateCents: null,
      }),
    });

    expect(response).toEqual({ status: 201, body: { rule: { id: 92 } } });
    expect(serviceMocks.createRateTableProductRule).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        kind: "restriction",
        action: "block",
        rateCents: null,
        perStartedPoundCents: null,
        thresholdCents: null,
        bands: [],
      }),
      "operator-1",
    );
  });

  it("rejects pricing fields on a shipping restriction", async () => {
    const response = await jsonRequest(`${server.url}/api/shipping/admin/rate-tables/12/product-rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validRule(),
        name: "Invalid restriction",
        kind: "restriction",
        action: "block",
      }),
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: "SHIPPING_PRODUCT_POLICY_INVALID_INPUT",
        details: [expect.objectContaining({
          message: "Shipping restrictions cannot include pricing.",
        })],
      },
    });
    expect(serviceMocks.createRateTableProductRule).not.toHaveBeenCalled();
  });

  it("rejects an empty destination scope before calling the application service", async () => {
    const response = await jsonRequest(`${server.url}/api/shipping/admin/rate-tables/12/product-rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validRule(),
        destinationScope: { country: "US", regions: [], postalPrefixes: [] },
      }),
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "SHIPPING_PRODUCT_POLICY_INVALID_INPUT" },
    });
    expect(serviceMocks.createRateTableProductRule).not.toHaveBeenCalled();
  });

  it("rejects an invalid rate-table identifier before querying rules", async () => {
    const response = await jsonRequest(`${server.url}/api/shipping/admin/rate-tables/not-an-id/product-rules`);

    expect(response).toEqual({
      status: 400,
      body: {
        error: {
          code: "SHIPPING_PRODUCT_POLICY_INVALID_ID",
          message: "Invalid identifier.",
        },
      },
    });
    expect(serviceMocks.listRateTableProductRules).not.toHaveBeenCalled();
  });

  it("loads persisted member details for an editable rule", async () => {
    serviceMocks.listRateTableProductRuleMembers.mockResolvedValue({
      members: [{
        id: 44,
        sku: "TUFF-BOX-GRD-C25",
        name: "Case of 25",
        productName: "Tough Box Box for Graded Slabs",
        isActive: true,
      }],
    });

    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/rate-tables/12/product-rules/91/members`,
    );

    expect(response).toEqual({
      status: 200,
      body: {
        members: [{
          id: 44,
          sku: "TUFF-BOX-GRD-C25",
          name: "Case of 25",
          productName: "Tough Box Box for Graded Slabs",
          isActive: true,
        }],
      },
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("settings", "view");
    expect(serviceMocks.listRateTableProductRuleMembers).toHaveBeenCalledWith(12, 91);
  });

  it("preserves classified application errors", async () => {
    serviceMocks.createRateTableProductRule.mockRejectedValue(new ProductRatePolicyAdminError(
      409,
      "SHIPPING_PRODUCT_POLICY_INVALID",
      "Resolve the product policy conflicts before saving.",
      ["Conflicting rule"],
    ));
    const response = await jsonRequest(`${server.url}/api/shipping/admin/rate-tables/12/product-rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validRule()),
    });

    expect(response).toEqual({
      status: 409,
      body: {
        error: {
          code: "SHIPPING_PRODUCT_POLICY_INVALID",
          message: "Resolve the product policy conflicts before saving.",
          details: ["Conflicting rule"],
        },
      },
    });
  });
});

function validRule() {
  return {
    name: "California case rate",
    kind: "base_charge",
    action: "fixed",
    measurementScope: "matched_items",
    destinationScope: { country: "us", regions: ["ca"], postalPrefixes: [] },
    selector: { kind: "manual", variantIds: [10] },
    rateCents: 1_299,
    perStartedPoundCents: null,
    perAdditionalUnitCents: null,
    thresholdCents: null,
    bands: [],
  };
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, "session", {
      configurable: true,
      value: { user: { id: "operator-1" } },
    });
    next();
  });
  registerProductRatePolicyAdminRoutes(app);
  return app;
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
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
  init?: { method?: string; headers?: Record<string, string>; body?: string },
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
          body: rawBody === "" ? {} : JSON.parse(rawBody) as Record<string, unknown>,
        });
      });
    });
    request.on("error", reject);
    if (init?.body !== undefined) request.write(init.body);
    request.end();
  });
}
