import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

const mocks = vi.hoisted(() => ({
  storage: {
    getAllReceivingOrders: vi.fn(),
    getReceivingOrdersByStatus: vi.fn(),
    getAllVendors: vi.fn(),
  },
  notifications: {
    notify: vi.fn(),
  },
}));

vi.mock("../../../../routes/middleware", () => {
  const pass = (req: Request, _res: Response, next: NextFunction) => {
    (req as any).session = { user: { id: "test-user" } };
    next();
  };
  return {
    requirePermission: () => pass,
    requireAuth: pass,
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
vi.mock("../../../notifications/notifications.service", () => mocks.notifications);

import { registerReceivingRoutes } from "../../receiving.routes";

function buildApp(services: Record<string, any> = {}): Express {
  const app = express();
  app.use(express.json());
  app.locals.services = services;
  registerReceivingRoutes(app);
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

describe("receiving routes", () => {
  let server: { url: string; close: () => Promise<void> };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notifications.notify.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  it("lists receiving orders and enriches vendors", async () => {
    mocks.storage.getReceivingOrdersByStatus.mockResolvedValue([
      { id: 10, receiptNumber: "RCV-10", vendorId: 3 },
    ]);
    mocks.storage.getAllVendors.mockResolvedValue([{ id: 3, name: "Acme Supplies" }]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/receiving?status=open");

    expect(status).toBe(200);
    expect(mocks.storage.getReceivingOrdersByStatus).toHaveBeenCalledWith("open");
    expect(body).toEqual([
      {
        id: 10,
        receiptNumber: "RCV-10",
        vendorId: 3,
        vendor: { id: 3, name: "Acme Supplies" },
      },
    ]);
  });

  it("closes through the receiving service and schedules replen checks", async () => {
    const receiving = {
      close: vi.fn().mockResolvedValue({
        success: true,
        unitsReceived: 12,
        putawayLocationIds: [44, 55],
        order: { orderNumber: "RCV-20" },
      }),
    };
    const replenishment = {
      checkReplenForLocation: vi.fn().mockResolvedValue(undefined),
    };
    server = await startServer(buildApp({ receiving, replenishment }));

    const { status, body } = await requestJson(server.url, "POST", "/api/receiving/20/close", {});

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(receiving.close).toHaveBeenCalledWith(20, "test-user", { allowOverReceipt: false });
    expect(mocks.notifications.notify).toHaveBeenCalledWith("po_received", {
      title: "Receiving Complete: RCV-20",
      message: "12 units received",
      data: { receivingOrderId: 20 },
    });
    expect(replenishment.checkReplenForLocation).toHaveBeenCalledWith(44);
    expect(replenishment.checkReplenForLocation).toHaveBeenCalledWith(55);
  });
});
