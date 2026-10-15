vi.mock("../../purchase-planning-policy.routes", () => ({
  registerPurchasePlanningPolicyRoutes: vi.fn(),
}));
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { PermissionGrant } from "../../../../routes/middleware";
import type { ServiceRegistry } from "../../../../services";
import type { PoShipmentCosts } from "@shared/procurement/po-shipment-costs";

vi.mock("../../../../routes/middleware", () => {
  const anyPermission = (...grants: PermissionGrant[]) => {
    if (grants.length === 0)
      throw new Error("requireAnyPermission requires at least one grant");
    return (req: Request, res: Response, next: NextFunction) => {
      const allowed = grants.some(
        ([resource, action]) =>
          req.headers["x-test-permission"] === `${resource}:${action}`,
      );
      if (!allowed)
        return res.status(403).json({ error: "Permission denied" });
      next();
    };
  };
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return {
    requirePermission: (resource: string, action: string) =>
      anyPermission([resource, action]),
    requireAnyPermission: anyPermission,
    requireAuth: pass,
    requireInternalApiKey: pass,
    upload: { single: () => pass },
  };
});
vi.mock("../../../../middleware/idempotency", () => ({
  requireIdempotency:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../modules/catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../../modules/warehouse", () => ({ warehouseStorage: {} }));
vi.mock("../../../../modules/inventory", () => ({ inventoryStorage: {} }));
vi.mock("../../../../modules/orders", () => ({ ordersStorage: {} }));
vi.mock("../../procurement", () => ({
  procurementStorage: { getVendorById: vi.fn() },
}));
vi.mock("../../ap-ledger.service", () => ({}));
vi.mock("../../po-document", () => ({ renderPoHtml: vi.fn() }));
vi.mock("../../../notifications/email.service", () => ({}));
vi.mock("../../../notifications/notifications.service", () => ({}));

import { registerPurchasingRoutes } from "../../procurement.routes";

function guardedService<T extends object>(
  name: string,
  methods: Partial<T>,
): T {
  return new Proxy(methods, {
    get(target, method) {
      if (!(method in target))
        throw new Error(
          `Shipment cost route unexpectedly accessed ${name}.${String(method)}`,
        );
      return Reflect.get(target, method);
    },
  }) as T;
}

const emptyCosts = (): PoShipmentCosts => ({
  summary: {
    currency: "USD",
    shipmentCount: 0,
    chargeCount: 0,
    freightCents: 0,
    dutyCents: 0,
    otherCents: 0,
    totalCents: 0,
    poAmountCents: 10000,
    combinedCostCents: 10000,
    estimatedCents: 0,
    unallocatedChargeCount: 0,
    unsupportedCurrencyCount: 0,
    appliedLines: 0,
    reviewLines: 0,
    pendingLines: 0,
    inventoryCosting: "no_costs",
  },
  supplier: { freightCents: 0, dutyCents: 0 },
  totals: { freightCents: 0, dutyCents: 0, combinedCostCents: 10000 },
  lines: [],
});

describe("PO shipment costs read endpoint", () => {
  const getCosts = vi.fn<ServiceRegistry["purchasing"]["getPoShipmentCosts"]>();
  const getSummary =
    vi.fn<ServiceRegistry["purchasing"]["getPoShipmentCostSummary"]>();
  let server: http.Server;
  let url: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    const app = express();
    app.locals.services = guardedService<ServiceRegistry>("services", {
      purchasing: guardedService<ServiceRegistry["purchasing"]>("purchasing", {
        getPoShipmentCosts: getCosts,
        getPoShipmentCostSummary: getSummary,
      }),
      shipmentTracking: guardedService<ServiceRegistry["shipmentTracking"]>(
        "shipmentTracking",
        {},
      ),
      receiving: guardedService<ServiceRegistry["receiving"]>("receiving", {}),
    });
    registerPurchasingRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    if (server?.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });
  const read = (
    path = "/api/purchase-orders/17/shipment-costs",
    permission = "purchasing:view",
  ) => fetch(url + path, { headers: { "x-test-permission": permission } });

  it.each(["inventory:view", "settings:edit", "purchasing:approve"])(
    "requires purchasing view permission before reading data with %s",
    async (permission) => {
      expect((await read(undefined, permission)).status).toBe(403);
      expect(getCosts).not.toHaveBeenCalled();
    },
  );
  it("passes a validated PO identifier to the application service", async () => {
    const payload = emptyCosts();
    getCosts.mockResolvedValue(payload);
    const response = await read();
    expect(response.status).toBe(200);
    expect(getCosts).toHaveBeenCalledExactlyOnceWith(17);
    expect(await response.json()).toEqual(payload);
  });
  it("keeps older tabs compatible and exposes exception decisions to opted-in clients", async () => {
    const line: PoShipmentCosts["lines"][number] = {
      lineId: 141, shipmentId: 92, shipmentNumber: "S260622005194", shipmentStatus: "closed",
      sku: "EG-SLV-STD-5PCK", allocatedCents: 282799, status: "review_required",
      applicationId: 17, recordedAt: "2026-10-15T12:00:00.000Z", issues: [], exceptionReview: null,
    };
    const payload = { ...emptyCosts(), lines: [line] };
    getCosts.mockResolvedValue(payload);
    const { exceptionReview: _review, ...legacyLine } = line;
    const legacy = await read();
    expect(legacy.headers.get("vary")).toContain("X-Shipment-Cost-Review-Version");
    expect(await legacy.json()).toEqual({ ...payload, lines: [legacyLine] });
    const current = await fetch(`${url}/api/purchase-orders/17/shipment-costs`, { headers: {
      "x-test-permission": "purchasing:view", "X-Shipment-Cost-Review-Version": "2",
    } });
    expect(current.headers.get("vary")).toContain("X-Shipment-Cost-Review-Version");
    expect(await current.json()).toEqual(payload);
  });
  it.each(["0", "-1", "17.5", "17x", "2147483648", "00017"])(
    "rejects invalid identifier %s",
    async (id) => {
      expect(
        (await read(`/api/purchase-orders/${id}/shipment-costs`)).status,
      ).toBe(400);
      expect(getCosts).not.toHaveBeenCalled();
    },
  );
  it("returns a missing PO separately from an unavailable read", async () => {
    getCosts.mockResolvedValue(null);
    expect((await read()).status).toBe(404);
  });
  it("logs and returns a classified read failure without exposing database details", async () => {
    const logger = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      getCosts.mockRejectedValue(new Error("private database detail"));
      const response = await read();
      expect(response.status).toBe(500);
      const payload = await response.json();
      expect(payload.code).toBe("SHIPMENT_COSTS_UNAVAILABLE");
      expect(JSON.stringify(payload)).not.toContain("private database");
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining("procurement.po_shipment_costs_failed"),
      );
    } finally {
      logger.mockRestore();
    }
  });
  it("preserves the existing summary endpoint", async () => {
    const payload = emptyCosts().summary;
    getSummary.mockResolvedValue(payload);
    const response = await read(
      "/api/purchase-orders/17/shipment-cost-summary",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(getCosts).not.toHaveBeenCalled();
  });
});
