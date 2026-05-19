import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

const mocks = vi.hoisted(() => ({
  storage: {
    getVendorById: vi.fn(),
    searchVendorCatalog: vi.fn(),
  },
}));

vi.mock("../../../../routes/middleware", () => {
  const pass = (req: Request, _res: Response, next: NextFunction) => {
    (req as any).session = { user: { id: "test-user" } };
    next();
  };
  return {
    requirePermission: () => pass,
  };
});

vi.mock("../../../../middleware/idempotency", () => ({
  requireIdempotency: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../..", () => ({ procurementStorage: mocks.storage }));
vi.mock("../../../../modules/catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../../modules/warehouse", () => ({ warehouseStorage: {} }));
vi.mock("../../../../modules/inventory", () => ({ inventoryStorage: {} }));
vi.mock("../../../../modules/orders", () => ({ ordersStorage: {} }));
vi.mock("../../purchasing.service", () => ({
  PurchasingError: class PurchasingError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

import { registerPurchasingAdminRoutes } from "../../purchasing-admin.routes";

function buildPurchasingMock(overrides: Record<string, any> = {}) {
  return {
    getVendorProducts: vi.fn(),
    createVendorProduct: vi.fn(),
    updateVendorProduct: vi.fn(),
    deleteVendorProduct: vi.fn(),
    bulkUpsertVendorCatalog: vi.fn(),
    getApprovalTiers: vi.fn(),
    createApprovalTier: vi.fn(),
    updateApprovalTier: vi.fn(),
    deleteApprovalTier: vi.fn(),
    createPOFromReorder: vi.fn(),
    ...overrides,
  } as any;
}

function buildApp(purchasing: any): Express {
  const app = express();
  app.use(express.json());
  app.locals.services = { purchasing };
  registerPurchasingAdminRoutes(app);
  return app;
}

function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function requestJson(baseUrl: string, method: string, path: string, body?: any) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": "test-key" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("purchasing admin routes", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it("lists vendor products with parsed filters", async () => {
    const purchasing = buildPurchasingMock({
      getVendorProducts: vi.fn().mockResolvedValue([{ id: 7, vendorId: 3 }]),
    });
    server = await startServer(buildApp(purchasing));

    const { status, body } = await requestJson(
      server.url,
      "GET",
      "/api/vendor-products?vendorId=3&productId=9&productVariantId=11&isActive=1",
    );

    expect(status).toBe(200);
    expect(purchasing.getVendorProducts).toHaveBeenCalledWith({
      vendorId: 3,
      productId: 9,
      productVariantId: 11,
      isActive: 1,
    });
    expect(body).toEqual({ vendorProducts: [{ id: 7, vendorId: 3 }] });
  });

  it("normalizes bulk vendor catalog entries", async () => {
    const purchasing = buildPurchasingMock({
      bulkUpsertVendorCatalog: vi.fn().mockResolvedValue({ created: 1, updated: 0 }),
    });
    server = await startServer(buildApp(purchasing));

    const { status, body } = await requestJson(
      server.url,
      "POST",
      "/api/vendors/4/catalog/bulk-upsert",
      {
        entries: [
          {
            product_id: 10,
            product_variant_id: 20,
            pack_size: 5,
            lead_time_days: 14,
            vendor_sku: "V-10",
            vendor_product_name: "Vendor Item",
            is_preferred: true,
            unit_cost_cents: 123,
            unit_cost_mills: 12300,
          },
        ],
      },
    );

    expect(status).toBe(200);
    expect(body).toEqual({ created: 1, updated: 0 });
    expect(purchasing.bulkUpsertVendorCatalog).toHaveBeenCalledWith(
      4,
      [
        {
          productId: 10,
          productVariantId: 20,
          packSize: 5,
          moq: undefined,
          leadTimeDays: 14,
          vendorSku: "V-10",
          vendorProductName: "Vendor Item",
          isPreferred: true,
          unitCostCents: 123,
          unitCostMills: 12300,
        },
      ],
      "test-user",
    );
  });

  it("serves approval tiers from the purchasing service", async () => {
    const purchasing = buildPurchasingMock({
      getApprovalTiers: vi.fn().mockResolvedValue([{ id: 1, name: "Manager" }]),
    });
    server = await startServer(buildApp(purchasing));

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/approval-tiers");

    expect(status).toBe(200);
    expect(purchasing.getApprovalTiers).toHaveBeenCalledOnce();
    expect(body).toEqual({ tiers: [{ id: 1, name: "Manager" }] });
  });

  it("rejects direct reorder PO creation outside the recommendation engine", async () => {
    const purchasing = buildPurchasingMock({
      createPOFromReorder: vi.fn().mockResolvedValue([{ id: 99 }]),
    });
    server = await startServer(buildApp(purchasing));

    const { status, body } = await requestJson(server.url, "POST", "/api/purchasing/create-po-from-reorder", {
      items: [{ productId: 1, productVariantId: 11, suggestedQty: 1, vendorId: 7 }],
    });

    expect(status).toBe(410);
    expect(body).toEqual({
      error: "Direct reorder PO creation has been removed",
      message:
        "Use the purchasing recommendation engine auto-draft endpoints so PO creation is governed by exclusion rules, confidence, and the active approval policy.",
    });
    expect(purchasing.createPOFromReorder).not.toHaveBeenCalled();
  });
});
