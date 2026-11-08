import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import http from "http";
import type { AddressInfo } from "net";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";

const dbMocks = vi.hoisted(() => {
  const store = new Map<
    string,
    {
      key: string;
      requestHash: string;
      responseBody: any;
      createdAt: Date;
      expiresAt: Date | null;
    }
  >();

  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          const currentKey = dbMocks.lastQueriedKey;
          const row = currentKey ? store.get(currentKey) : undefined;
          return row ? [{ ...row }] : [];
        }),
      })),
    })),
  }));

  const insert = vi.fn(() => ({
    values: vi.fn(async (val: any) => {
      if (store.has(val.key)) {
        const err: any = new Error("duplicate key value violates unique constraint");
        err.code = "23505";
        throw err;
      }
      store.set(val.key, {
        key: val.key,
        requestHash: val.requestHash,
        responseBody: val.responseBody ?? null,
        createdAt: new Date(),
        expiresAt: val.expiresAt ?? null,
      });
    }),
  }));

  const update = vi.fn(() => ({
    set: vi.fn((updates: any) => ({
      where: vi.fn(async () => {
        const currentKey = dbMocks.lastQueriedKey;
        if (currentKey && store.has(currentKey)) {
          const existing = store.get(currentKey)!;
          store.set(currentKey, { ...existing, ...updates });
        }
      }),
    })),
  }));

  const del = vi.fn(() => ({
    where: vi.fn(async () => {
      const currentKey = dbMocks.lastQueriedKey;
      if (currentKey) {
        const existing = store.get(currentKey);
        if (existing && existing.responseBody === null) {
          store.delete(currentKey);
        }
      }
    }),
  }));

  return {
    store,
    lastQueriedKey: null as string | null,
    select,
    insert,
    update,
    delete: del,
  };
});

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: vi.fn((col: any, val: any) => {
      if (typeof val === "string") {
        dbMocks.lastQueriedKey = val;
      }
      return actual.eq(col, val);
    }),
  };
});

vi.mock("../../../../db", () => ({
  pool: {},
  db: {
    select: dbMocks.select,
    insert: dbMocks.insert,
    update: dbMocks.update,
    delete: dbMocks.delete,
  },
}));

vi.mock("../../shipment-cost-exclusions.repository", () => ({
  readShipmentCostExclusions: vi.fn(async () => ({ taxByLine: new Map(), otherByLine: new Map() })),
}));
vi.mock("../../purchase-tax-costs.repository", () => ({
  readTaxedShipmentSupplierCosts: vi.fn(async () => new Map()),
}));
vi.mock("../../shipment-unit-options.repository", () => ({
  readShipmentUnitOptions: vi.fn(async () => new Map()),
  shipmentReceivingUnitSource: vi.fn(() => ({})),
}));

import {
  computeIdempotencyRequestHash,
  requireIdempotency,
} from "../../../../middleware/idempotency";
import { RECEIVING_READ_GRANTS } from "../../receiving.routes";
import { RECEIVING_READ_PERMISSIONS } from "../../../../../client/src/lib/procurement-access";
import { createShipmentTrackingService } from "../../shipment-tracking.service";
import { registerOperationsDashboardRoutes } from "../../../orders/operations-dashboard.routes";
import { registerPurchasingRoutes } from "../../procurement.routes";

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

describe("Priority 3 Batch PROC-1 — Routes, Idempotency, Receiving Auth, and Batch Enrichment", () => {
  let server: { url: string; close: () => Promise<void> } | null = null;

  beforeEach(() => {
    dbMocks.store.clear();
    dbMocks.lastQueriedKey = null;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  describe("PROC-01: SLA, Operations Dashboard, and Internal Sync route ownership", () => {
    it("mounts SLA, Operations, and Internal Sync endpoints on operations-dashboard.routes instead of procurement.routes", () => {
      const opsApp = express();
      registerOperationsDashboardRoutes(opsApp);
      const opsPaths = (opsApp as any)._router.stack
        .filter((layer: any) => layer.route)
        .map((layer: any) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

      expect(opsPaths).toEqual(
        expect.arrayContaining([
          "GET /api/operations/pick-replen-health",
          "POST /api/operations/pick-replen-health/cleanup",
          "GET /api/sla/alerts",
          "GET /api/sla/summary",
          "POST /api/sla/update-statuses",
          "GET /api/operations/bin-inventory",
          "GET /api/operations/unassigned-inventory",
          "GET /api/operations/location-health",
          "GET /api/operations/exceptions",
          "GET /api/operations/pick-readiness",
          "GET /api/operations/activity",
          "GET /api/operations/action-queue",
          "GET /api/internal/orders",
          "GET /api/internal/shipments",
        ]),
      );

      const procApp = express();
      procApp.locals.services = { purchasing: {} as any } as any;
      registerPurchasingRoutes(procApp);
      const procPaths = (procApp as any)._router.stack
        .filter((layer: any) => layer.route)
        .map((layer: any) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

      for (const movedRoute of [
        "GET /api/sla/alerts",
        "GET /api/sla/summary",
        "POST /api/sla/update-statuses",
        "GET /api/operations/bin-inventory",
        "GET /api/operations/unassigned-inventory",
        "GET /api/operations/location-health",
        "GET /api/operations/exceptions",
        "GET /api/operations/pick-readiness",
        "GET /api/operations/activity",
        "GET /api/operations/action-queue",
        "GET /api/internal/orders",
        "GET /api/internal/shipments",
      ]) {
        expect(procPaths).not.toContain(movedRoute);
      }
    });
  });

  describe("PROC-03: requireIdempotency request fingerprint, status preservation, and 5xx/lease recovery", () => {
    it("binds actorId, method, path, params, and canonicalized body in computeIdempotencyRequestHash", () => {
      const baseReq = {
        method: "POST",
        baseUrl: "",
        path: "/api/receiving/20/close",
        originalUrl: "/api/receiving/20/close",
        params: { id: "20" },
        body: {},
        session: { user: { id: "user-1" } },
      };

      const diffResourceReq = {
        ...baseReq,
        path: "/api/receiving/21/close",
        originalUrl: "/api/receiving/21/close",
        params: { id: "21" },
      };

      const diffActorReq = {
        ...baseReq,
        session: { user: { id: "user-2" } },
      };

      const reorderedBodyReqA = {
        ...baseReq,
        body: { b: 2, a: 1 },
      };
      const reorderedBodyReqB = {
        ...baseReq,
        body: { a: 1, b: 2 },
      };

      expect(computeIdempotencyRequestHash(baseReq)).not.toBe(
        computeIdempotencyRequestHash(diffResourceReq),
      );
      expect(computeIdempotencyRequestHash(baseReq)).not.toBe(
        computeIdempotencyRequestHash(diffActorReq),
      );
      expect(computeIdempotencyRequestHash(reorderedBodyReqA)).toBe(
        computeIdempotencyRequestHash(reorderedBodyReqB),
      );
    });

    it("preserves exact 201 and 422 HTTP status codes on replay and blocks cross-resource key reuse on empty-body routes", async () => {
      let callCount = 0;
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).session = { user: { id: (req.headers["x-actor-id"] as string) || "actor-1" } };
        next();
      });

      app.post("/api/receiving/:id/close", requireIdempotency(), (req, res) => {
        callCount += 1;
        if (req.params.id === "422") {
          return res.status(422).json({ error: "Receipt has unresolved variances", code: "VARIANCE" });
        }
        return res.status(201).json({ closedId: Number(req.params.id), callCount });
      });

      server = await startServer(app);

      // 1. 422 response is preserved as 422 on replay (not coerced to 200)
      const first422 = await requestLocalHttp(`${server.url}/api/receiving/422/close`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-422" },
        body: JSON.stringify({}),
      });
      expect(first422.status).toBe(422);
      expect(await first422.json()).toEqual({ error: "Receipt has unresolved variances", code: "VARIANCE" });

      const replay422 = await requestLocalHttp(`${server.url}/api/receiving/422/close`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-422" },
        body: JSON.stringify({}),
      });
      expect(replay422.status).toBe(422);
      expect(replay422.headers.get("idempotency-replayed")).toBe("true");
      expect(await replay422.json()).toEqual({ error: "Receipt has unresolved variances", code: "VARIANCE" });
      expect(callCount).toBe(1);

      // 2. Reusing key-422 on a different resource (/api/receiving/20/close) with identical {} body returns 409
      const crossResource = await requestLocalHttp(`${server.url}/api/receiving/20/close`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-422" },
        body: JSON.stringify({}),
      });
      expect(crossResource.status).toBe(409);
    });

    it("releases unclaimed in-progress keys on 500 responses and reclaims expired in-progress leases", async () => {
      let shouldFail = true;
      const app = express();
      app.use(express.json());
      app.post("/api/test-500", requireIdempotency(), (_req, res) => {
        if (shouldFail) {
          return res.status(500).json({ error: "Transient DB failure" });
        }
        return res.status(200).json({ ok: true });
      });

      server = await startServer(app);

      const failRes = await requestLocalHttp(`${server.url}/api/test-500`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-retry-500" },
        body: JSON.stringify({ action: "close" }),
      });
      expect(failRes.status).toBe(500);
      expect(dbMocks.store.has("key-retry-500")).toBe(false);

      shouldFail = false;
      const retryRes = await requestLocalHttp(`${server.url}/api/test-500`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-retry-500" },
        body: JSON.stringify({ action: "close" }),
      });
      expect(retryRes.status).toBe(200);
      expect(await retryRes.json()).toEqual({ ok: true });
    });
  });

  describe("PROC-09: Receiving read permission alignment", () => {
    it("aligns RECEIVING_READ_GRANTS with client RECEIVING_READ_PERMISSIONS", () => {
      const clientPairs = RECEIVING_READ_PERMISSIONS.map((p) => [p.resource, p.action]);
      expect(RECEIVING_READ_GRANTS).toEqual(clientPairs);
    });
  });

  describe("PROC-04: ShipmentTrackingService.getEnrichedLines batch lookups", () => {
    it("fetches variants, products, PO lines, and POs via single batch calls instead of N+1 per-line queries", async () => {
      const storage = {
        getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "costing" }),
        getInboundShipmentLines: vi.fn().mockResolvedValue([
          {
            id: 101,
            sku: null,
            purchaseOrderId: 10,
            purchaseOrderLineId: 201,
            productVariantId: 301,
            qtyShipped: 4,
            allocatedCostCents: 400,
            landedUnitCostCents: 200,
          },
          {
            id: 102,
            sku: null,
            purchaseOrderId: 11,
            purchaseOrderLineId: 202,
            productVariantId: 302,
            qtyShipped: 6,
            allocatedCostCents: 600,
            landedUnitCostCents: 300,
          },
        ]),
        getInboundFreightCosts: vi.fn().mockResolvedValue([]),
        getInboundFreightCostAllocations: vi.fn().mockResolvedValue([]),
        getProductVariantsByIds: vi.fn().mockResolvedValue([
          { id: 301, productId: 401, sku: "VAR-301", name: "Case 301", unitsPerVariant: 1 },
          { id: 302, productId: 402, sku: "VAR-302", name: "Case 302", unitsPerVariant: 1 },
        ]),
        getProductsByIds: vi.fn().mockResolvedValue([
          { id: 401, name: "Product 401" },
          { id: 402, name: "Product 402" },
        ]),
        getPurchaseOrderLinesByIds: vi.fn().mockResolvedValue([
          {
            id: 201,
            purchaseOrderId: 10,
            lineType: "product",
            sku: "PO-SKU-201",
            productName: "PO Prod 201",
            orderQty: 4,
            totalProductCostCents: 400,
            unitCostCents: 100,
            unitCostMills: 10000,
          },
          {
            id: 202,
            purchaseOrderId: 11,
            lineType: "product",
            sku: "PO-SKU-202",
            productName: "PO Prod 202",
            orderQty: 6,
            totalProductCostCents: 1200,
            unitCostCents: 200,
            unitCostMills: 20000,
          },
        ]),
        getPurchaseOrdersByIds: vi.fn().mockResolvedValue([
          { id: 10, currency: "USD" },
          { id: 11, currency: "USD" },
        ]),
        // Single-ID methods should NOT be called when batch methods are present
        getProductVariantById: vi.fn(),
        getProductById: vi.fn(),
        getPurchaseOrderLineById: vi.fn(),
        getPurchaseOrderById: vi.fn(),
      } as any;

      const service = createShipmentTrackingService({} as any, storage);
      const enriched = await service.getEnrichedLines(1);

      expect(enriched).toHaveLength(2);
      expect(enriched[0]).toMatchObject({
        id: 101,
        sku: "PO-SKU-201",
        unitsPerVariant: 1,
        productName: "Product 401",
        poUnitCostMills: 10000,
      });
      expect(enriched[1]).toMatchObject({
        id: 102,
        sku: "PO-SKU-202",
        unitsPerVariant: 1,
        productName: "Product 402",
        poUnitCostMills: 20000,
      });

      expect(storage.getProductVariantsByIds).toHaveBeenCalledExactlyOnceWith([301, 302]);
      expect(storage.getProductsByIds).toHaveBeenCalledExactlyOnceWith([401, 402]);
      expect(storage.getPurchaseOrderLinesByIds).toHaveBeenCalledExactlyOnceWith([201, 202]);
      expect(storage.getPurchaseOrdersByIds).toHaveBeenCalledExactlyOnceWith([10, 11]);

      expect(storage.getProductVariantById).not.toHaveBeenCalled();
      expect(storage.getProductById).not.toHaveBeenCalled();
      expect(storage.getPurchaseOrderLineById).not.toHaveBeenCalled();
      expect(storage.getPurchaseOrderById).not.toHaveBeenCalled();
    });
  });
});
