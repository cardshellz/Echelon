import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

const mocks = vi.hoisted(() => ({
  inventory: {
    getAllReplenRules: vi.fn(),
    createReplenTask: vi.fn(),
    getReplenTaskById: vi.fn(),
    updateReplenTask: vi.fn(),
  },
  catalog: {
    getAllProducts: vi.fn(),
    getAllProductVariants: vi.fn(),
  },
  warehouse: {
    getWarehouseLocationById: vi.fn(),
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

vi.mock("../../../../modules/inventory", () => ({ inventoryStorage: mocks.inventory }));
vi.mock("../../../../modules/catalog", () => ({ catalogStorage: mocks.catalog }));
vi.mock("../../../../modules/warehouse", () => ({ warehouseStorage: mocks.warehouse }));

import { registerReplenishmentRoutes } from "../../replenishment.routes";

function buildApp(services: Record<string, any> = {}): Express {
  const app = express();
  app.use(express.json());
  app.locals.services = services;
  registerReplenishmentRoutes(app);
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
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("replenishment routes", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it("lists replenishment rules with product and variant enrichment", async () => {
    mocks.inventory.getAllReplenRules.mockResolvedValue([
      {
        id: 12,
        productId: 3,
        pickProductVariantId: 31,
        sourceProductVariantId: 32,
      },
    ]);
    mocks.catalog.getAllProducts.mockResolvedValue([{ id: 3, sku: "BASE" }]);
    mocks.catalog.getAllProductVariants.mockResolvedValue([
      { id: 31, sku: "BASE-P1", productId: 3 },
      { id: 32, sku: "BASE-C10", productId: 3 },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/replen/rules");

    expect(status).toBe(200);
    expect(body).toEqual([
      {
        id: 12,
        productId: 3,
        pickProductVariantId: 31,
        sourceProductVariantId: 32,
        product: { id: 3, sku: "BASE" },
        pickVariant: { id: 31, sku: "BASE-P1", productId: 3 },
        sourceVariant: { id: 32, sku: "BASE-C10", productId: 3 },
      },
    ]);
  });

  it("creates replenishment tasks using the unified auto-execute decision when omitted", async () => {
    mocks.warehouse.getWarehouseLocationById.mockResolvedValue({ id: 20, warehouseId: 1 });
    mocks.inventory.createReplenTask.mockResolvedValue({ id: 77, status: "pending" });
    const replenishment = {
      getSettingsForWarehouse: vi.fn().mockResolvedValue({ warehouseId: 1 }),
      resolveAutoExecute: vi.fn().mockReturnValue({ shouldAutoExecute: false, executionMode: "queue" }),
    };
    server = await startServer(buildApp({ replenishment }));

    const { status, body } = await requestJson(server.url, "POST", "/api/replen/tasks", {
      fromLocationId: 10,
      toLocationId: 20,
      qtyTargetUnits: 5,
      pickVariantId: 31,
      sourceVariantId: 32,
    });

    expect(status).toBe(201);
    expect(replenishment.getSettingsForWarehouse).toHaveBeenCalledWith(1);
    expect(replenishment.resolveAutoExecute).toHaveBeenCalledWith(null, null, { warehouseId: 1 }, 5);
    expect(mocks.inventory.createReplenTask).toHaveBeenCalledWith(
      expect.objectContaining({
        fromLocationId: 10,
        toLocationId: 20,
        pickProductVariantId: 31,
        sourceProductVariantId: 32,
        qtyTargetUnits: 5,
        executionMode: "queue",
        status: "pending",
      }),
    );
    expect(body).toEqual({ id: 77, status: "pending" });
  });

  it("blocks manual completed status updates so inventory must move through execute", async () => {
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "PATCH", "/api/replen/tasks/77", {
      status: "completed",
    });

    expect(status).toBe(400);
    expect(mocks.inventory.updateReplenTask).not.toHaveBeenCalled();
    expect(body).toEqual({ error: "Use the /execute endpoint to complete tasks (ensures inventory is moved)" });
  });
});
