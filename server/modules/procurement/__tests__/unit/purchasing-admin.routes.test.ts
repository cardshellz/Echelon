import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

const mocks = vi.hoisted(() => ({
  storage: {
    getVendorById: vi.fn(),
    getAllProducts: vi.fn(),
    getAllProductVariants: vi.fn(),
    getVendorProductsByProductIds: vi.fn(),
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
    details?: Record<string, unknown>;

    constructor(message: string, statusCode = 400, details?: Record<string, unknown>) {
      super(message);
      this.statusCode = statusCode;
      this.details = details;
    }
  },
}));

import { registerPurchasingAdminRoutes } from "../../purchasing-admin.routes";

function buildPurchasingMock(overrides: Record<string, any> = {}) {
  return {
    getVendorProducts: vi.fn(),
    getVendorProductById: vi.fn(),
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
    mocks.storage.getVendorById.mockResolvedValue({
      id: 4,
      code: "VEND-4",
      name: "Vendor Four",
      active: 1,
    });
    mocks.storage.getAllProducts.mockResolvedValue([
      { id: 10, sku: "BASE-10", name: "Product Ten", isActive: true },
    ]);
    mocks.storage.getAllProductVariants.mockResolvedValue([
      { id: 20, productId: 10, sku: "VAR-20", name: "Variant Twenty", isActive: true },
    ]);
    mocks.storage.getVendorProductsByProductIds.mockResolvedValue([]);
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

  it("normalizes an explicit purchase-UOM quote on generic vendor-product create", async () => {
    const purchasing = buildPurchasingMock({
      createVendorProduct: vi.fn().mockResolvedValue({ id: 17 }),
    });
    server = await startServer(buildApp(purchasing));

    const { status, body } = await requestJson(server.url, "POST", "/api/vendor-products", {
      vendorId: 3,
      productId: 9,
      productVariantId: 11,
      vendorSku: " CASE-9 ",
      pricing: {
        basis: "per_purchase_uom",
        purchaseUom: "case",
        uomQuantity: 2,
        piecesPerUom: 24,
        quotedCostMillsPerUom: 12_345,
      },
      quotedAt: "2026-07-01",
      packSize: 24,
      isPreferred: 1,
    });

    expect(status).toBe(201);
    expect(body).toEqual({ id: 17 });
    expect(purchasing.createVendorProduct).toHaveBeenCalledWith(expect.objectContaining({
      vendorId: 3,
      productId: 9,
      productVariantId: 11,
      vendorSku: "CASE-9",
      packSize: 24,
      isPreferred: 1,
      unitCostMills: 514,
      unitCostCents: 5,
      pricingBasis: "per_purchase_uom",
      purchaseUom: "case",
      quotedUnitCostMills: 12_345,
      piecesPerPurchaseUom: 24,
      quoteReference: null,
      quotedAt: new Date("2026-07-01T00:00:00.000Z"),
      quoteValidUntil: null,
    }), "test-user");
  });

  it("does not fabricate a verification date for reusable catalog pricing", async () => {
    const purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));

    const { status, body } = await requestJson(server.url, "POST", "/api/vendor-products", {
      vendorId: 3,
      productId: 9,
      pricing: {
        basis: "per_piece",
        quantityPieces: 12,
        unitCostMills: 12_345,
      },
    });

    expect(status).toBe(400);
    expect(body.details.code).toBe("VENDOR_CATALOG_QUOTED_AT_REQUIRED");
    expect(purchasing.createVendorProduct).not.toHaveBeenCalled();
  });

  it("normalizes legacy cents on create and labels the unprovable quote basis", async () => {
    const purchasing = buildPurchasingMock({
      createVendorProduct: vi.fn().mockResolvedValue({ id: 18 }),
    });
    server = await startServer(buildApp(purchasing));

    const { status } = await requestJson(server.url, "POST", "/api/vendor-products", {
      vendorId: 3,
      productId: 9,
      unitCostCents: 123,
      isActive: 1,
    });

    expect(status).toBe(201);
    expect(purchasing.createVendorProduct).toHaveBeenCalledWith({
      vendorId: 3,
      productId: 9,
      isActive: 1,
      unitCostMills: 12_300,
      unitCostCents: 123,
      pricingBasis: "legacy_unknown",
      purchaseUom: null,
      quotedUnitCostMills: null,
      piecesPerPurchaseUom: null,
      quoteReference: null,
      quotedAt: null,
      quoteValidUntil: null,
    }, "test-user");
  });

  it("requires a price on generic vendor-product create", async () => {
    const purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));

    const { status, body } = await requestJson(server.url, "POST", "/api/vendor-products", {
      vendorId: 3,
      productId: 9,
      vendorSku: "V-9",
    });

    expect(status).toBe(400);
    expect(body.details.code).toBe("VENDOR_CATALOG_PRICE_REQUIRED");
    expect(purchasing.createVendorProduct).not.toHaveBeenCalled();
  });

  it("rejects derived quote provenance and other mass-assigned create fields", async () => {
    const purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));

    const { status, body } = await requestJson(server.url, "POST", "/api/vendor-products", {
      vendorId: 3,
      productId: 9,
      unitCostCents: 123,
      pricingBasis: "per_piece",
      quotedUnitCostMills: 12_300,
      updatedAt: "2026-07-13T00:00:00.000Z",
    });

    expect(status).toBe(400);
    expect(body.details.code).toBe("VENDOR_PRODUCT_REQUEST_INVALID");
    expect(body.details.issues[0].message).toContain("Unrecognized key");
    expect(purchasing.createVendorProduct).not.toHaveBeenCalled();
  });

  it("rejects quantity-specific extended-total pricing in the reusable catalog", async () => {
    const purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));

    const { status, body } = await requestJson(server.url, "POST", "/api/vendor-products", {
      vendorId: 3,
      productId: 9,
      pricing: {
        basis: "extended_total",
        quantityPieces: 10,
        quotedTotalCents: 999,
      },
    });

    expect(status).toBe(400);
    expect(body.details.code).toBe("VENDOR_CATALOG_EXTENDED_TOTAL_NOT_REUSABLE");
    expect(purchasing.createVendorProduct).not.toHaveBeenCalled();
  });

  it("preserves stored quote fields on a metadata-only patch", async () => {
    const purchasing = buildPurchasingMock({
      updateVendorProduct: vi.fn().mockResolvedValue({ id: 17 }),
    });
    server = await startServer(buildApp(purchasing));

    const { status } = await requestJson(server.url, "PATCH", "/api/vendor-products/17", {
      vendorSku: " NEW-SKU ",
      isActive: 0,
    });

    expect(status).toBe(200);
    expect(purchasing.updateVendorProduct).toHaveBeenCalledWith(17, {
      vendorSku: "NEW-SKU",
      isActive: 0,
    }, "test-user");
  });

  it("corrects quote metadata without refreshing the stored quote timestamp", async () => {
    const purchasing = buildPurchasingMock({
      updateVendorProduct: vi.fn().mockResolvedValue({ id: 17 }),
    });
    server = await startServer(buildApp(purchasing));

    const { status } = await requestJson(server.url, "PATCH", "/api/vendor-products/17", {
      quoteReference: " Q-2026-44 ",
      quoteValidUntil: "2026-12-31",
    });

    expect(status).toBe(200);
    expect(purchasing.updateVendorProduct).toHaveBeenCalledWith(17, {
      quoteReference: "Q-2026-44",
      quoteValidUntil: "2026-12-31",
    }, "test-user");
  });

  it("resets quote provenance when a patch supplies legacy money", async () => {
    const purchasing = buildPurchasingMock({
      updateVendorProduct: vi.fn().mockResolvedValue({ id: 17 }),
    });
    server = await startServer(buildApp(purchasing));

    const { status } = await requestJson(server.url, "PATCH", "/api/vendor-products/17", {
      unitCostMills: 12_345,
      unitCostCents: 123,
    });

    expect(status).toBe(200);
    expect(purchasing.updateVendorProduct).toHaveBeenCalledWith(17, {
      unitCostMills: 12_345,
      unitCostCents: 123,
      pricingBasis: "legacy_unknown",
      purchaseUom: null,
      quotedUnitCostMills: null,
      piecesPerPurchaseUom: null,
      quoteReference: null,
      quotedAt: null,
      quoteValidUntil: null,
    }, "test-user");
  });

  it("rejects invalid 0|1 flags and invalid patch ids before calling storage", async () => {
    const purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));

    const invalidFlag = await requestJson(server.url, "PATCH", "/api/vendor-products/17", {
      isPreferred: 2,
    });
    const invalidId = await requestJson(server.url, "PATCH", "/api/vendor-products/not-a-number", {
      isActive: 1,
    });

    expect(invalidFlag.status).toBe(400);
    expect(invalidFlag.body.details.code).toBe("VENDOR_PRODUCT_REQUEST_INVALID");
    expect(invalidId.status).toBe(400);
    expect(invalidId.body.details.code).toBe("VENDOR_PRODUCT_ID_INVALID");
    expect(purchasing.updateVendorProduct).not.toHaveBeenCalled();
  });

  it("strictly normalizes explicit pricing on the PO-line catalog upsert", async () => {
    const purchasing = buildPurchasingMock({
      bulkUpsertVendorCatalog: vi.fn().mockResolvedValue({
        created: [{ vendorProductId: 71, productId: 10, productVariantId: 20 }],
        updated: [],
        skipped: [],
      }),
      getVendorProductById: vi.fn().mockResolvedValue({ id: 71 }),
    });
    server = await startServer(buildApp(purchasing));

    const { status, body } = await requestJson(server.url, "POST", "/api/vendor-products/upsert", {
      vendorId: 4,
      productId: 10,
      productVariantId: 20,
      vendorSku: " V-10 ",
      pricing: {
        basis: "per_piece",
        quantityPieces: 12,
        unitCostMills: 12_345,
      },
      quotedAt: "2026-07-01",
      packSize: 6,
      isPreferred: true,
    });

    expect(status).toBe(200);
    expect(body).toEqual({ vp: { id: 71 }, created: true });
    expect(purchasing.bulkUpsertVendorCatalog).toHaveBeenCalledWith(4, [{
      productId: 10,
      productVariantId: 20,
      vendorSku: "V-10",
      pricing: {
        basis: "per_piece",
        quantityPieces: 12,
        unitCostMills: 12_345,
      },
      quotedAt: new Date("2026-07-01T00:00:00.000Z"),
      packSize: 6,
      isPreferred: true,
    }], "test-user");
  });

  it("normalizes legacy money and resets provenance on an existing upsert row", async () => {
    const purchasing = buildPurchasingMock({
      bulkUpsertVendorCatalog: vi.fn().mockResolvedValue({
        created: [],
        updated: [{ vendorProductId: 71, productId: 10, productVariantId: 20 }],
        skipped: [],
      }),
      getVendorProductById: vi.fn().mockResolvedValue({ id: 71 }),
    });
    server = await startServer(buildApp(purchasing));

    const { status } = await requestJson(server.url, "POST", "/api/vendor-products/upsert", {
      vendorId: 4,
      productId: 10,
      productVariantId: 20,
      unitCostCents: 123,
      isPreferred: false,
    });

    expect(status).toBe(200);
    expect(purchasing.bulkUpsertVendorCatalog).toHaveBeenCalledWith(4, [{
      productId: 10,
      productVariantId: 20,
      unitCostCents: 123,
      isPreferred: false,
    }], "test-user");
  });

  it("rejects explicit pricing combined with legacy mirrors on simple upsert", async () => {
    const purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));

    const { status, body } = await requestJson(server.url, "POST", "/api/vendor-products/upsert", {
      vendorId: 4,
      productId: 10,
      productVariantId: 20,
      pricing: {
        basis: "per_piece",
        quantityPieces: 12,
        unitCostMills: 12_345,
      },
      unitCostMills: 12_345,
      unitCostCents: 123,
    });

    expect(status).toBe(400);
    expect(body.details.code).toBe("VENDOR_CATALOG_PRICING_AMBIGUOUS");
    expect(purchasing.bulkUpsertVendorCatalog).not.toHaveBeenCalled();
  });

  it("rejects missing price, variant, invalid flags, and mass-assigned fields on simple upsert", async () => {
    const purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));

    const noPrice = await requestJson(server.url, "POST", "/api/vendor-products/upsert", {
      vendorId: 4,
      productId: 10,
      productVariantId: 20,
    });
    const noVariant = await requestJson(server.url, "POST", "/api/vendor-products/upsert", {
      vendorId: 4,
      productId: 10,
      unitCostCents: 123,
    });
    const invalidFlag = await requestJson(server.url, "POST", "/api/vendor-products/upsert", {
      vendorId: 4,
      productId: 10,
      productVariantId: 20,
      unitCostCents: 123,
      isPreferred: 2,
    });
    const massAssigned = await requestJson(server.url, "POST", "/api/vendor-products/upsert", {
      vendorId: 4,
      productId: 10,
      productVariantId: 20,
      unitCostCents: 123,
      pricingBasis: "per_piece",
    });

    expect(noPrice.status).toBe(400);
    expect(noPrice.body.details.code).toBe("VENDOR_CATALOG_PRICE_REQUIRED");
    expect(noVariant.status).toBe(400);
    expect(noVariant.body.details.code).toBe("VENDOR_PRODUCT_REQUEST_INVALID");
    expect(invalidFlag.status).toBe(400);
    expect(invalidFlag.body.details.code).toBe("VENDOR_PRODUCT_REQUEST_INVALID");
    expect(massAssigned.status).toBe(400);
    expect(massAssigned.body.details.code).toBe("VENDOR_PRODUCT_REQUEST_INVALID");
    expect(purchasing.bulkUpsertVendorCatalog).not.toHaveBeenCalled();
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
    const normalizedEntry = purchasing.bulkUpsertVendorCatalog.mock.calls[0][1][0];
    expect(Object.prototype.hasOwnProperty.call(normalizedEntry, "quoteReference")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(normalizedEntry, "quotedAt")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(normalizedEntry, "quoteValidUntil")).toBe(false);
  });

  it("preserves explicit null quote metadata while normalizing bulk entries", async () => {
    const purchasing = buildPurchasingMock({
      bulkUpsertVendorCatalog: vi.fn().mockResolvedValue({ created: 1, updated: 0 }),
    });
    server = await startServer(buildApp(purchasing));

    const { status } = await requestJson(
      server.url,
      "POST",
      "/api/vendors/4/catalog/bulk-upsert",
      {
        entries: [{
          product_id: 10,
          product_variant_id: 20,
          pricing: {
            basis: "per_piece",
            quantityPieces: 1,
            unitCostMills: 0,
          },
          quote_reference: null,
          quoted_at: "2026-07-12",
          quote_valid_until: null,
        }],
      },
    );

    expect(status).toBe(200);
    const normalizedEntry = purchasing.bulkUpsertVendorCatalog.mock.calls[0][1][0];
    expect(normalizedEntry).toMatchObject({
      quoteReference: null,
      quotedAt: new Date("2026-07-12T00:00:00.000Z"),
      quoteValidUntil: null,
    });
    expect(Object.prototype.hasOwnProperty.call(normalizedEntry, "quoteReference")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(normalizedEntry, "quoteValidUntil")).toBe(true);
  });

  it("previews verified supplier evidence with exact SKU resolution and no writes", async () => {
    const purchasing = buildPurchasingMock({
      getVendorProducts: vi.fn().mockResolvedValue([]),
    });
    server = await startServer(buildApp(purchasing));

    const { status, body } = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/supplier-evidence-import/preview",
      {
        vendorId: 4,
        rows: [{
          sku: "VAR-20",
          vendorSku: "V-20",
          pricingBasis: "per_piece",
          quotedUnitCost: "0.0075",
          purchaseUom: null,
          piecesPerPurchaseUom: null,
          quoteReference: "QUOTE-20",
          quotedAt: "2026-07-15",
          quoteValidUntil: "2026-08-15",
          moqPieces: 12,
          leadTimeDays: 4,
          isPreferred: true,
        }],
      },
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      contractVersion: 1,
      vendor: { id: 4, code: "VEND-4", name: "Vendor Four" },
      summary: { total: 1, creates: 1, updates: 0, reactivations: 0 },
      items: [{
        sku: "VAR-20",
        productId: 10,
        productVariantId: 20,
        normalizedUnitCostMills: 75,
        action: "create",
      }],
    });
    expect(body.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.catalogEntries).toBeUndefined();
    expect(purchasing.bulkUpsertVendorCatalog).not.toHaveBeenCalled();
  });

  it("rejects malformed supplier evidence before SKU resolution", async () => {
    const purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));

    const { status, body } = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/supplier-evidence-import/preview",
      {
        vendorId: 4,
        rows: [{
          sku: "VAR-20",
          pricingBasis: "per_piece",
          quotedUnitCost: "1.23456",
          quotedAt: "2026-07-15",
          leadTimeDays: 4,
          isPreferred: true,
        }],
      },
    );

    expect(status).toBe(400);
    expect(body.details.code).toBe("SUPPLIER_EVIDENCE_REQUEST_INVALID");
    expect(mocks.storage.getVendorById).not.toHaveBeenCalled();
    expect(purchasing.bulkUpsertVendorCatalog).not.toHaveBeenCalled();
  });

  it("requires the exact preview hash before atomically applying supplier evidence", async () => {
    const purchasing = buildPurchasingMock({
      getVendorProducts: vi.fn().mockResolvedValue([]),
      bulkUpsertVendorCatalog: vi.fn().mockResolvedValue({
        created: [{ vendorProductId: 91, productId: 10, productVariantId: 20 }],
        updated: [],
        skipped: [],
      }),
    });
    server = await startServer(buildApp(purchasing));
    const input = {
      vendorId: 4,
      rows: [{
        sku: "VAR-20",
        vendorSku: "V-20",
        pricingBasis: "per_purchase_uom",
        quotedUnitCost: "12.3456",
        purchaseUom: "case",
        piecesPerPurchaseUom: 24,
        quoteReference: "QUOTE-20",
        quotedAt: "2026-07-15",
        quoteValidUntil: "2026-08-15",
        moqPieces: 48,
        leadTimeDays: 7,
        isPreferred: true,
      }],
    };
    const preview = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/supplier-evidence-import/preview",
      input,
    );

    const stale = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/supplier-evidence-import/apply",
      { ...input, previewHash: "0".repeat(64) },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.details.code).toBe("SUPPLIER_EVIDENCE_PREVIEW_STALE");
    expect(purchasing.bulkUpsertVendorCatalog).not.toHaveBeenCalled();

    const applied = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/supplier-evidence-import/apply",
      { ...input, previewHash: preview.body.previewHash },
    );
    expect(applied.status).toBe(200);
    expect(applied.body.result.created[0].vendorProductId).toBe(91);
    expect(purchasing.bulkUpsertVendorCatalog).toHaveBeenCalledWith(
      4,
      [expect.objectContaining({
        productId: 10,
        productVariantId: 20,
        packSize: 24,
        moq: 48,
        leadTimeDays: 7,
        pricing: {
          basis: "per_purchase_uom",
          purchaseUom: "case",
          uomQuantity: 1,
          piecesPerUom: 24,
          quotedCostMillsPerUom: 123456,
        },
      })],
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
