import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
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
  entry: { create: vi.fn(), execute: vi.fn() },
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

vi.mock("../../receiving-entry.commands", async original => ({
  ...await original<typeof import("../../receiving-entry.commands")>(),
  createReceivingEntryCommands: mocks.entry.create,
}));

import { registerReceivingRoutes } from "../../receiving.routes";
import { hashReceivingEntryCommandIdentity, receivingEntryCommandScope, RECEIVING_ENTRY_COMMAND_PRINCIPAL } from "../../receiving-entry.commands";

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

async function requestJson(baseUrl: string, method: string, path: string, body?: any, key = "test-key") {
  const res = await requestLocalHttp(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": key },
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
    mocks.entry.create.mockImplementation(() => ({ execute: mocks.entry.execute }));
    mocks.entry.execute.mockResolvedValue({ replayed: false, terminalState: "succeeded", httpStatus: 201, body: { id: 20 } });
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

  it("forwards the reviewed catalog factor when creating or confirming a receive unit", async () => {
    const receiving = {
      addLine: vi.fn().mockResolvedValue({ id: 20 }),
      updateLine: vi.fn().mockResolvedValue({ id: 7 }),
    };
    server = await startServer(buildApp({ receiving }));
    const create = await requestJson(server.url, "POST", "/api/receiving/20/lines", {
      productVariantId: 100, productId: 5, expectedUnitsPerVariant: 250,
      expectedQty: 4, receivedQty: 0,
    });
    const confirmation = { productVariantId: 100, expectedUnitsPerVariant: 250,
      confirmLegacyUnit: true, expectedUnitVersion: "a".repeat(64) };
    const confirm = await requestJson(server.url, "PATCH", "/api/receiving/lines/7", confirmation);
    expect(create.status).toBe(201);
    expect(confirm.status).toBe(200);
    const command = { action: "add-line", targetId: 20, payload: {
      productVariantId: 100, productId: 5, expectedUnitsPerVariant: 250, expectedQty: 4, receivedQty: 0,
    } };
    expect(mocks.entry.create).toHaveBeenCalledExactlyOnceWith(receiving);
    expect(mocks.entry.execute).toHaveBeenCalledExactlyOnceWith(command, "test-user", {
      ...receivingEntryCommandScope(), actorType: "service", actorId: RECEIVING_ENTRY_COMMAND_PRINCIPAL,
      idempotencyKey: "test-key", contractVersion: 1,
      requestHash: hashReceivingEntryCommandIdentity(command, "test-user"),
    });
    expect(receiving.addLine).not.toHaveBeenCalled();
    expect(receiving.updateLine).toHaveBeenCalledWith(7, confirmation, "test-user");
  });

  it("forwards the full bulk acceptance version set and preserves actionable conflict details", async () => {
    const receiving = { completeAllLines: vi.fn().mockRejectedValue({
      statusCode: 409, message: "Refresh the receipt.",
      details: { code: "RECEIVING_UNIT_VERSION_CONFLICT", receivingLineId: 7 },
    }) };
    server = await startServer(buildApp({ receiving }));
    const input = { expectedUnitVersions: [{ lineId: 7, unitVersion: "b".repeat(64) }] };
    const response = await requestJson(server.url, "POST", "/api/receiving/20/complete-all", input);
    expect(receiving.completeAllLines).toHaveBeenCalledWith(20, input, "test-user");
    expect(response).toEqual({ status: 409, body: {
      error: "Refresh the receipt.", code: "RECEIVING_UNIT_VERSION_CONFLICT", receivingLineId: 7,
    } });
  });

  it("delegates order and line writes to the receiving command service", async () => {
    const receiving = {
      createOrder: vi.fn().mockResolvedValue({ id: 19, receiptNumber: "RCV-19" }),
      updateOrderDetails: vi.fn().mockResolvedValue({ id: 20, notes: "dock 2" }),
      addLine: vi.fn().mockResolvedValue({ id: 20, lines: [{ id: 7 }] }),
      updateLine: vi.fn().mockResolvedValue({ id: 7, receivedQty: 3 }),
      deleteLine: vi.fn().mockResolvedValue(true),
      deleteOrder: vi.fn().mockResolvedValue(true),
    };
    server = await startServer(buildApp({ receiving }));

    const orderCreate = await requestJson(server.url, "POST", "/api/receiving", {
      sourceType: "blind",
      vendorId: 3,
      warehouseId: 1,
      notes: "dock 1",
    }, "receiving-route-create-order");
    const orderPatch = await requestJson(server.url, "PATCH", "/api/receiving/20", {
      notes: "dock 2",
    });
    const lineCreate = await requestJson(server.url, "POST", "/api/receiving/20/lines", {
      sku: "SKU-1",
      expectedQty: 5,
      unit_cost_mills: 125,
    }, "receiving-route-add-line");
    const linePatch = await requestJson(server.url, "PATCH", "/api/receiving/lines/7", {
      receivedQty: 3,
    });
    const lineDelete = await requestJson(server.url, "DELETE", "/api/receiving/lines/7");
    const orderDelete = await requestJson(server.url, "DELETE", "/api/receiving/20");

    expect(orderCreate.status).toBe(201);
    expect(orderPatch.status).toBe(200);
    expect(lineCreate.status).toBe(201);
    expect(linePatch.status).toBe(200);
    expect(lineDelete.status).toBe(200);
    expect(orderDelete.status).toBe(200);
    const orderCommand = { action: "create", targetId: null, payload: {
      sourceType: "blind", vendorId: 3, warehouseId: 1, notes: "dock 1",
    } };
    const lineCommand = { action: "add-line", targetId: 20, payload: {
      sku: "SKU-1", expectedQty: 5, unit_cost_mills: 125,
    } };
    expect(mocks.entry.create).toHaveBeenCalledTimes(2);
    expect(mocks.entry.create).toHaveBeenNthCalledWith(1, receiving);
    expect(mocks.entry.create).toHaveBeenNthCalledWith(2, receiving);
    for (const [index, command, idempotencyKey] of [
      [1, orderCommand, "receiving-route-create-order"], [2, lineCommand, "receiving-route-add-line"],
    ] as const) {
      expect(mocks.entry.execute).toHaveBeenNthCalledWith(index, command, "test-user", {
        ...receivingEntryCommandScope(), actorType: "service", actorId: RECEIVING_ENTRY_COMMAND_PRINCIPAL,
        idempotencyKey, contractVersion: 1,
        requestHash: hashReceivingEntryCommandIdentity(command, "test-user"),
      });
    }
    expect(receiving.createOrder).not.toHaveBeenCalled();
    expect(receiving.addLine).not.toHaveBeenCalled();
    expect(receiving.updateOrderDetails).toHaveBeenCalledWith(20, { notes: "dock 2" }, "test-user");
    expect(receiving.updateLine).toHaveBeenCalledWith(7, { receivedQty: 3 }, "test-user");
    expect(receiving.deleteLine).toHaveBeenCalledWith(7);
    expect(receiving.deleteOrder).toHaveBeenCalledWith(20, "test-user");
  });
});
