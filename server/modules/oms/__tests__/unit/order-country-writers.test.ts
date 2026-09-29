import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";
import type { OrderData } from "../../oms.service";

const harness = vi.hoisted(() => ({
  database: {
    select: vi.fn(),
    execute: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
  createOrderWithItems: vi.fn(),
  markWebhookFailed: vi.fn(),
}));
vi.mock("../../../../db", () => ({ db: harness.database }));
vi.mock("../../../orders", () => ({
  ordersStorage: { createOrderWithItems: harness.createOrderWithItems },
}));
vi.mock("../../../warehouse/settings.resolver", () => ({
  getSlaCutoffConfig: async () => ({ timezone: "UTC", cutoffLocal: "12:00" }),
}));
vi.mock("../../../orders/sort-rank", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../orders/sort-rank")>()),
  resolveSlaDueAt: async () => null,
}));
vi.mock("../../webhook-inbox.service", () => ({
  buildShopifyWebhookInboxInput: () => ({}),
  recordWebhookReceived: async () => ({
    id: 15,
    inserted: true,
    status: "received",
  }),
  markWebhookProcessing: async () => undefined,
  markWebhookSucceeded: vi.fn(),
  markWebhookFailed: harness.markWebhookFailed,
  enqueueWebhookInboxRetry: vi.fn(),
}));

import { createOmsService } from "../../oms.service";
import { __test__ as webhook, registerOmsWebhooks } from "../../oms-webhooks";
import { WmsSyncService } from "../../wms-sync.service";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const purchasedAt = new Date("2026-09-01T12:00:00.000Z");

describe("OMS country write boundaries", () => {
  it.each(["XX", "United States / Canada", 1, {}, []])(
    "rejects invalid country %j before ingestion writes",
    async (input) => {
      const transaction = vi.fn();
      const service = createOmsService({ transaction });
      await expect(
        service.ingestOrder(36, "1001", {
          orderedAt: purchasedAt,
          lineItems: [],
          shipToCountry: input,
        } as unknown as OrderData),
      ).rejects.toMatchObject({ code: "ORDER_COUNTRY_INVALID" });
      expect(transaction).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        JSON.stringify({
          event: "oms_country_validation_failed",
          operation: "ingest_order",
          channelId: 36,
          code: "ORDER_COUNTRY_INVALID",
        }),
      );
    },
  );

  it.each([
    ["United States", "US"],
    ["Canada", "CA"],
    ["UK", "GB"],
    [null, null],
    [undefined, null],
    ["  ", null],
  ])(
    "persists canonical or missing country %j without mutating source evidence",
    async (input, expected) => {
      const writes: Record<string, unknown>[] = [];
      const tx = {
        insert: () => ({
          values: (row: Record<string, unknown>) => {
            writes.push(row);
            return {
              onConflictDoNothing: () => ({
                returning: async () => [{ id: 10, ...row }],
              }),
            };
          },
        }),
      };
      const service = createOmsService({
        transaction: async (work: (executor: typeof tx) => Promise<unknown>) =>
          work(tx),
      });
      const data = {
        orderedAt: purchasedAt,
        lineItems: [],
        shipToCountry: input,
        rawPayload: { country: input },
      };
      await service.ingestOrder(36, "1001", data);
      expect(writes[0].shipToCountry).toBe(expected);
      expect(writes[0].rawPayload).toEqual({ country: input });
      expect(data.shipToCountry).toBe(input);
      expect(writes).toHaveLength(2);
    },
  );
});

describe("Shopify country mapping and partial address updates", () => {
  it.each(["orders/paid", "orders/updated"])(
    "rejects malformed preferred country in the %s handler before business writes",
    async (topic) => {
      vi.stubEnv("SESSION_SECRET", "country-unit-retry-secret");
      const routes = new Map<
        string,
        (request: Request, response: Response) => Promise<void>
      >();
      const app = {
        post: (path: string, ...handlers: unknown[]) =>
          routes.set(
            path,
            handlers.at(-1) as (
              request: Request,
              response: Response,
            ) => Promise<void>,
          ),
      };
      const ingestOrder = vi.fn();
      registerOmsWebhooks(
        app as unknown as Express,
        { ingestOrder } as never,
        null,
        null,
      );
      scriptedSelect([[{ channelId: 36 }]]);
      const request = {
        headers: {
          "x-internal-retry": "country-unit-retry-secret",
          "x-shopify-shop-domain": "test.myshopify.com",
        },
        body: {
          id: 1001,
          shipping_address: {
            country_code: "private-invalid-country",
            country: "United States",
          },
          line_items: [],
        },
      };
      const response = { headersSent: false, status: vi.fn(), send: vi.fn() };
      response.status.mockReturnValue(response);
      await routes.get(`/api/oms/webhooks/${topic}`)!(
        request as unknown as Request,
        response as unknown as Response,
      );
      expect(ingestOrder).not.toHaveBeenCalled();
      expect(harness.database.insert).not.toHaveBeenCalled();
      expect(harness.database.update).not.toHaveBeenCalled();
      expect(harness.database.transaction).not.toHaveBeenCalled();
      expect(harness.markWebhookFailed).toHaveBeenCalledWith(
        harness.database,
        15,
        expect.objectContaining({ code: "ORDER_COUNTRY_INVALID" }),
      );
      expect(response.status).toHaveBeenCalledWith(500);
      expect(JSON.stringify(response.send.mock.calls)).not.toContain(
        "private-invalid-country",
      );
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
        "private-invalid-country",
      );
    },
  );

  it.each([
    [{ country_code: "ca", country: "United States" }, "CA"],
    [{ country_code: " ", country: "United States" }, "US"],
    [{ country: "United Kingdom" }, "GB"],
    [{ country: null }, null],
    [{ country_code: "", country: "" }, null],
  ])("normalizes the authoritative country fields %j", (shipping, expected) => {
    const payload = { shipping_address: shipping, line_items: [] };
    const before = structuredClone(payload);
    expect(webhook.mapShopifyOrderToOrderData(payload).shipToCountry).toBe(
      expected,
    );
    expect(
      webhook.canonicalShipToFromShopifyUpdate(payload, {
        shipToCountry: "Canada",
      }).country,
    ).toBe(expected);
    expect(payload).toEqual(before);
  });

  it.each([
    { country_code: "XX", country: "United States" },
    { country_code: 1, country: "United States" },
    { country: "unknown" },
    { country: [] },
  ])(
    "rejects malformed country without a name/default fallback: %j",
    (shipping) => {
      expect(() =>
        webhook.mapShopifyOrderToOrderData({ shipping_address: shipping }),
      ).toThrow(expect.objectContaining({ code: "ORDER_COUNTRY_INVALID" }));
      expect(() =>
        webhook.canonicalShipToFromShopifyUpdate(
          { shipping_address: shipping },
          { shipToCountry: "US" },
        ),
      ).toThrow(expect.objectContaining({ code: "ORDER_COUNTRY_INVALID" }));
    },
  );

  it("preserves and validates existing country only when a partial update omits both country fields", () => {
    expect(
      webhook.canonicalShipToFromShopifyUpdate(
        { shipping_address: { city: "New city" } },
        { shipToCountry: "Canada" },
      ).country,
    ).toBe("CA");
    expect(
      webhook.canonicalShipToFromShopifyUpdate({}, { shipToCountry: null })
        .country,
    ).toBeNull();
    expect(() =>
      webhook.canonicalShipToFromShopifyUpdate({}, { shipToCountry: "XX" }),
    ).toThrow(expect.objectContaining({ code: "ORDER_COUNTRY_INVALID" }));
  });
});

function scriptedSelect(rows: unknown[][]) {
  harness.database.select.mockImplementation(() => {
    const result = rows.shift() ?? [];
    const query = {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      then: (resolve: (value: unknown[]) => unknown) =>
        Promise.resolve(result).then(resolve),
    };
    return query;
  });
}

describe("OMS to WMS country boundary", () => {
  it.each(["XX", "not-a-country", {}, 10])(
    "rejects %j before cancellation, reservation, reconciliation or writes",
    async (shipToCountry) => {
      scriptedSelect([
        [{ id: 10, channelId: 36, status: "cancelled", shipToCountry }],
      ]);
      const reserveOrder = vi.fn();
      const service = new WmsSyncService({
        reservation: { reserveOrder },
      } as never);
      await expect(service.syncOmsOrderToWms(10)).rejects.toMatchObject({
        code: "ORDER_COUNTRY_INVALID",
      });
      expect(harness.database.select).toHaveBeenCalledTimes(1);
      expect(harness.database.execute).not.toHaveBeenCalled();
      expect(harness.database.update).not.toHaveBeenCalled();
      expect(harness.database.transaction).not.toHaveBeenCalled();
      expect(reserveOrder).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["United States", "US"],
    ["Canada", "CA"],
    [null, null],
    ["  ", null],
  ])(
    "passes country %j to WMS storage without a domestic default",
    async (shipToCountry, expected) => {
      const order = {
        id: 10,
        channelId: 36,
        status: "confirmed",
        financialStatus: "paid",
        externalOrderId: "1001",
        shipToCountry,
        subtotalCents: 100,
        totalCents: 100,
        currency: "USD",
        orderedAt: purchasedAt,
      };
      const line = {
        id: 20,
        quantity: 1,
        authorityFulfillableQuantity: 1,
        wmsMaterializedQuantity: 0,
        requiresShipping: false,
        paidPriceCents: 100,
        totalPriceCents: 100,
        productVariantId: null,
      };
      scriptedSelect([[order], [], [line], []]);
      harness.database.execute
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 20,
              quantity: 1,
              authority_fulfillable_quantity: 1,
              wms_materialized_quantity: 0,
              requires_shipping: false,
              paid_price_cents: 100,
              total_price_cents: 100,
            },
          ],
        });
      harness.database.transaction.mockImplementation(async (work) =>
        work(harness.database),
      );
      const reachedStorage = new Error("captured WMS write boundary");
      harness.createOrderWithItems.mockRejectedValue(reachedStorage);
      const service = new WmsSyncService({
        fulfillmentRouter: { routeOrder: async () => null },
        dropshipOmsChannel: { resolveChannelId: async () => 99 },
      } as never);
      vi.spyOn(
        service as unknown as { determinePriority: () => Promise<unknown> },
        "determinePriority",
      ).mockResolvedValue({
        priority: "normal",
        memberPlanName: null,
        memberPlanColor: null,
      });
      await expect(service.syncOmsOrderToWms(10)).rejects.toBe(reachedStorage);
      expect(harness.createOrderWithItems).toHaveBeenCalledOnce();
      expect(
        harness.createOrderWithItems.mock.calls[0][0].shippingCountry,
      ).toBe(expected);
      expect(order.shipToCountry).toBe(shipToCountry);
    },
  );
});
