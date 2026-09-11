import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OrderCOGSCurrencyError } from "../../domain/order-cogs-read";

// Exercise the real Express handlers and domain error identity. Authentication
// and service persistence belong to their own suites; no application DB opens.
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../index", () => ({ inventoryStorage: {} }));
vi.mock("../../../warehouse", () => ({ warehouseStorage: {} }));
vi.mock("../../../catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../orders", () => ({ ordersStorage: {} }));
vi.mock("../../../channels", () => ({ channelsStorage: {} }));
vi.mock("../../../../routes/middleware", () => {
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return { requirePermission: () => pass, requireAuth: pass, upload: { single: () => pass } };
});

import { registerInventoryRoutes } from "../../inventory.routes";

describe("order COGS HTTP read contract", () => {
  const cogs = { getOrderCOGS: vi.fn(), getOrderCOGSByNumber: vi.fn() };
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = express();
    app.locals.services = { cogs };
    registerInventoryRoutes(app);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    vi.restoreAllMocks();
  });

  const lookups = [
    { name: "by number", path: "/api/cogs/order?orderNumber=PROC-UAT-001", method: "getOrderCOGSByNumber", argument: "PROC-UAT-001" },
    { name: "by ID", path: "/api/cogs/order/123", method: "getOrderCOGS", argument: 123 },
  ] as const;

  describe.each(lookups)("$name", ({ path, method, argument }) => {
    it("returns the service report without losing exact mills fields", async () => {
      const report = {
        orderId: 123, orderNumber: "PROC-UAT-001", totalRevenueCents: 1000,
        totalCogsCents: 240, totalCogsMills: "24000", grossMarginCents: 760,
        marginPercent: 76, lineItems: [],
      };
      cogs[method].mockResolvedValue(report);
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(report);
      expect(cogs[method]).toHaveBeenCalledExactlyOnceWith(argument);
    });

    it("returns unsupported currency as a distinct 422 with top-level code and currency", async () => {
      const error = new OrderCOGSCurrencyError("CAD");
      cogs[method].mockRejectedValue(error);
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: error.message, code: "ORDER_COGS_CURRENCY_UNSUPPORTED", currency: "CAD",
      });
      expect(cogs[method]).toHaveBeenCalledExactlyOnceWith(argument);
    });

    it("returns 404 only for an absent order", async () => {
      cogs[method].mockResolvedValue(null);
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Order not found" });
      expect(cogs[method]).toHaveBeenCalledExactlyOnceWith(argument);
    });

    it("returns a generic 500 for an unexpected service failure", async () => {
      cogs[method].mockRejectedValue(new Error("private database failure detail"));
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Failed to get order COGS" });
      expect(cogs[method]).toHaveBeenCalledExactlyOnceWith(argument);
    });

    it("does not treat an unrelated error carrying the same code as the domain currency error", async () => {
      cogs[method].mockRejectedValue(Object.assign(new Error("unrelated"), {
        code: "ORDER_COGS_CURRENCY_UNSUPPORTED", currency: "CAD",
      }));
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Failed to get order COGS" });
    });
  });

  it.each(["0", "-1", "1.5", "1x", "1e3", "01", "NaN", "9007199254740992"])(
    "rejects malformed ID %s before calling a service", async (orderId) => {
      const response = await fetch(`${baseUrl}/api/cogs/order/${encodeURIComponent(orderId)}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "orderId must be a positive safe integer" });
      expect(cogs.getOrderCOGS).not.toHaveBeenCalled();
      expect(cogs.getOrderCOGSByNumber).not.toHaveBeenCalled();
    },
  );

  it.each(["", "?orderNumber=", "?orderNumber=%20%20", `?orderNumber=${"A".repeat(51)}`])(
    "rejects missing, blank, or overlength order numbers (%s) before calling a service", async (query) => {
      const response = await fetch(`${baseUrl}/api/cogs/order${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "orderNumber must contain 1 to 50 characters" });
      expect(cogs.getOrderCOGSByNumber).not.toHaveBeenCalled();
      expect(cogs.getOrderCOGS).not.toHaveBeenCalled();
    },
  );

  it("accepts and trims a 50-character order number", async () => {
    const orderNumber = "A".repeat(50);
    cogs.getOrderCOGSByNumber.mockResolvedValue(null);
    const response = await fetch(`${baseUrl}/api/cogs/order?orderNumber=%20${orderNumber}%20`);
    expect(response.status).toBe(404);
    expect(cogs.getOrderCOGSByNumber).toHaveBeenCalledExactlyOnceWith(orderNumber);
  });
});
