import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";

const ports = vi.hoisted(() => ({
  select: vi.fn(),
  ingest: vi.fn(),
  create: vi.fn(),
  repair: vi.fn(),
  remaining: vi.fn(),
  channels: vi.fn(),
  unfulfilled: vi.fn(),
}));
vi.mock("../../index", () => ({
  channelsStorage: { getAllChannels: ports.channels },
}));
vi.mock("../../../orders", () => ({
  ordersStorage: {
    createOrderWithItems: ports.create,
    updateOmsRawOrderCustomer: ports.repair,
    countOmsRawOrdersMissingCustomerName: ports.remaining,
    getUnfulfilledOmsOrders: ports.unfulfilled,
  },
  orderPageQuerySchema: {},
}));
vi.mock("../../../catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../warehouse", () => ({ warehouseStorage: {} }));
vi.mock("../../../inventory", () => ({ inventoryStorage: {} }));
vi.mock("../../../../storage/base", async () => ({
  ...(await import("@shared/schema")),
  ...(await import("drizzle-orm")),
  db: { select: ports.select },
}));
vi.mock("../../../../db", () => ({ db: { select: ports.select }, pool: {} }));
vi.mock("../../../oms/oms.service", () => ({
  createOmsService: () => ({ ingestOrder: ports.ingest }),
}));
vi.mock("../../../../routes/middleware", () => ({
  requireAuth: vi.fn(),
  requirePermission: () => vi.fn(),
}));
vi.mock(
  "../../../inventory-planning/infrastructure/inventory-legacy-admin-control.repository",
  () => ({ createInventoryLegacyAdminControlService: () => ({}) }),
);
vi.mock("../../../../websocket", () => ({ broadcastOrdersUpdated: vi.fn() }));

import { registerChannelRoutes } from "../../channels.routes";
import { registerShopifyRoutes } from "../../../../routes/shopify.routes";

function routes(register: (app: Express) => void) {
  const handlers = new Map<string, Function>();
  // Registration only needs route collectors and locals; unused services are
  // deliberately absent rather than pretending to implement the full registry.
  const app = {
    ...Object.fromEntries(
      ["get", "post", "put", "patch", "delete"].map((method) => [
        method,
        (path: string, ...middleware: Function[]) =>
          handlers.set(`${method} ${path}`, middleware[middleware.length - 1]),
      ]),
    ),
    locals: { services: {} },
  } as unknown as Express;
  register(app);
  return handlers;
}
function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}
const input = {
  orderNumber: "MANUAL-1",
  customerName: "Test",
  channelId: 36,
  items: [{ sku: "TEST", name: "Test item", quantity: 1 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  ports.select.mockReturnValue({ from: () => ({ where: async () => [] }) });
  ports.ingest.mockResolvedValue({ id: 42 });
  ports.create.mockResolvedValue({ id: 4 });
  ports.repair.mockResolvedValue(1);
  ports.remaining.mockResolvedValue(0);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("manual order country validation", () => {
  it.each(["Atlantis", "ZZ", 123, {}, ["US"]])(
    "returns400 before any OMS/WMS operation for %j",
    async (shippingCountry) => {
      const handler = routes(registerChannelRoutes).get(
        "post /api/wms/orders",
      )!;
      const res = response();
      await handler({ body: { ...input, shippingCountry } }, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "ORDER_COUNTRY_INVALID",
          field: "shippingCountry",
        }),
      );
      expect(ports.select).not.toHaveBeenCalled();
      expect(ports.ingest).not.toHaveBeenCalled();
      expect(ports.create).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["United States", "US"],
    [" ca ", "CA"],
    [null, null],
    [undefined, null],
    [" ", null],
  ])(
    "writes consistent country representations for manual input %s",
    async (shippingCountry, expected) => {
      const handler = routes(registerChannelRoutes).get(
        "post /api/wms/orders",
      )!;
      const res = response();
      await handler({ body: { ...input, shippingCountry } }, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(ports.ingest).toHaveBeenCalledWith(
        36,
        expect.any(String),
        expect.objectContaining({ shipToCountry: expected ?? undefined }),
      );
      expect(ports.create).toHaveBeenCalledWith(
        expect.objectContaining({ shippingCountry: expected }),
        expect.any(Array),
      );
    },
  );
});

describe("legacy Shopify repair preflight", () => {
  it("rejects an invalid provider page before any of its customer-address writes", async () => {
    vi.stubEnv("SHOPIFY_SHOP_DOMAIN", "fixture.myshopify.com");
    vi.stubEnv("SHOPIFY_ACCESS_TOKEN", "fixture-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          orders: [
            {
              id: 1,
              shipping_address: {
                country_code: "US",
                country: "United States",
              },
            },
            {
              id: 2,
              shipping_address: {
                country_code: "ZZ",
                country: "United States",
              },
            },
          ],
        }),
      })),
    );
    const handler = routes(registerShopifyRoutes).get(
      "post /api/shopify/backfill-customer-names",
    )!;
    const res = response();
    await handler({ query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(ports.repair).not.toHaveBeenCalled();
  });
  it("normalizes a complete provider page before handing it to repair storage", async () => {
    vi.stubEnv("SHOPIFY_SHOP_DOMAIN", "fixture.myshopify.com");
    vi.stubEnv("SHOPIFY_ACCESS_TOKEN", "fixture-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          orders: [
            {
              id: 1,
              shipping_address: {
                country_code: " us ",
                country: "United States",
              },
            },
            { id: 2, shipping_address: { country: "Canada" } },
          ],
        }),
      })),
    );
    const handler = routes(registerShopifyRoutes).get(
      "post /api/shopify/backfill-customer-names",
    )!;
    await handler({ query: {} }, response());
    expect(ports.repair).toHaveBeenNthCalledWith(
      1,
      {
        shopDomain: "fixture.myshopify.com",
        externalOrderId: "gid://shopify/Order/1",
      },
      expect.objectContaining({ shippingCountry: "US" }),
    );
    expect(ports.repair).toHaveBeenNthCalledWith(
      2,
      {
        shopDomain: "fixture.myshopify.com",
        externalOrderId: "gid://shopify/Order/2",
      },
      expect.objectContaining({ shippingCountry: "CA" }),
    );
  });
  it.each([
    Number.MAX_SAFE_INTEGER + 1,
    0,
    "#1",
    "gid://shopify/Customer/1",
    null,
  ])(
    "rejects a page containing an inexact provider order identity before any repair: %s",
    async (id) => {
      vi.stubEnv("SHOPIFY_SHOP_DOMAIN", "fixture.myshopify.com");
      vi.stubEnv("SHOPIFY_ACCESS_TOKEN", "fixture-token");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          headers: { get: () => null },
          json: async () => ({
            orders: [
              { id: 1, shipping_address: { country_code: "US" } },
              { id, shipping_address: { country_code: "US" } },
            ],
          }),
        })),
      );
      const handler = routes(registerShopifyRoutes).get(
        "post /api/shopify/backfill-customer-names",
      )!;
      const res = response();
      await handler({ query: {} }, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(ports.repair).not.toHaveBeenCalled();
    },
  );
  it("rejects a non-Shopify configured domain before sending credentials or doing repairs", async () => {
    vi.stubEnv("SHOPIFY_SHOP_DOMAIN", "fixture.example.com");
    vi.stubEnv("SHOPIFY_ACCESS_TOKEN", "fixture-token");
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const handler = routes(registerShopifyRoutes).get(
      "post /api/shopify/backfill-customer-names",
    )!;
    const res = response();
    await handler({ query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(request).not.toHaveBeenCalled();
    expect(ports.repair).not.toHaveBeenCalled();
  });
  it("preserves encoded Shopify pagination cursors without double encoding", async () => {
    vi.stubEnv("SHOPIFY_SHOP_DOMAIN", "fixture.myshopify.com");
    vi.stubEnv("SHOPIFY_ACCESS_TOKEN", "fixture-token");
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: {
          get: () =>
            '<https://fixture.myshopify.com/admin/api/2024-01/orders.json?page_info=abc%3D%26x>; rel="next"',
        },
        json: async () => ({
          orders: [{ id: 1, shipping_address: { country_code: "US" } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({ orders: [] }),
      });
    vi.stubGlobal("fetch", request);
    const handler = routes(registerShopifyRoutes).get(
      "post /api/shopify/backfill-customer-names",
    )!;
    await handler({ query: {} }, response());
    expect(
      new URL(request.mock.calls[1][0]).searchParams.get("page_info"),
    ).toBe("abc=&x");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("rejects malformed OMS source countries before creating any WMS orders in the batch", async () => {
    ports.channels.mockResolvedValue([]);
    ports.unfulfilled.mockResolvedValue([
      { id: "1", ship_to_country: "US" },
      { id: "2", ship_to_country: "Atlantis" },
    ]);
    const handler = routes(registerShopifyRoutes).get(
      "post /api/orders/sync-from-oms",
    )!;
    const res = response();
    await handler({}, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(ports.create).not.toHaveBeenCalled();
  });
});
